import { CONFIG } from '../config.js';
import { loadModelCache, saveModelCache, shouldAdvanceModel } from './auto-model.js';

export async function chat(messages, provider = 'openai', tools = [], options = {}) {
  const key = provider === 'openai'
    ? CONFIG.AI_API_KEY
    : provider === 'anthropic' ? CONFIG.ANTHROPIC_API_KEY : CONFIG.GEMINI_API_KEY;
  if (!key) throw new Error(`No API key for ${provider}`);
  if (provider === 'openai') return chatOpenAI(messages, key, tools, options);
  if (provider === 'anthropic') return chatAnthropic(messages, key, tools, options);
  return chatGemini(messages, key, tools, options);
}

export function resolveOpenAiUrl(base = CONFIG.AI_BASE_URL) {
  const configured = String(base || '').trim().replace(/\/+$/, '');
  if (!configured) return 'https://api.openai.com/v1/chat/completions';
  if (/\/chat\/completions$/i.test(configured)) return configured;
  if (/\/v\d+$/i.test(configured)) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

export function resolveOpenAiModelsUrl(base = CONFIG.AI_BASE_URL) {
  let endpoint = resolveOpenAiUrl(base).replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(endpoint)) endpoint = endpoint.replace(/\/chat\/completions$/i, '');
  return `${endpoint}/models`;
}

export async function listOpenAiModels(signal) {
  if (!CONFIG.AI_API_KEY) throw new Error('OpenAI API key is not configured');
  const url = resolveOpenAiModelsUrl();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CONFIG.AI_API_KEY}` },
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`openai models ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const payload = await res.json();
  const models = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(models)) throw new Error('OpenAI models response is invalid');
  return models.map(model => typeof model === 'string' ? model : model?.id).filter(Boolean);
}

// The model that last worked, kept in memory and mirrored to
// data/model-cache.json. Restarting the process must not throw away a model
// that is known to answer with this key — rediscovering it by probing can take
// dozens of requests and is exactly what used to fail.
let autoModelState = { key: null, model: null, checkedAt: 0 };

function rankDiscoveredModels(models) {
  const blocked = /embed|whisper|tts|audio|dall|image|moderation|rerank|realtime|omni|fine-tune|guard/i;
  const preferred = /flash|mini|lite|nano|small|distil/i;
  const usable = models.filter(model => !blocked.test(model));
  // Free tiers were previously tried first and they are the most rate-limited
  // group, so AUTO gave up on the whole list when the cheapest tier hiccuped.
  // General-purpose models come first now; free tier is still reachable.
  return [
    ...usable.filter(model => preferred.test(model) && !/:free$/i.test(model)),
    ...usable.filter(model => !preferred.test(model) && !/:free$/i.test(model)),
    ...usable.filter(model => /:free$/i.test(model)),
  ];
}

// The disk cache is keyed by endpoint, but older files were keyed by the raw
// "url|key-present" string, so both are accepted when reading.
function cacheKey(key) {
  return key.split('|')[0].replace(/\/chat\/completions$/i, '');
}

// An explicit AI_MODEL_FALLBACKS list is the operator's own answer to "which
// model does this key speak to", so it is tried after the discovered models.
function configuredFallbackModels() {
  const raw = String(CONFIG.AI_MODEL_FALLBACKS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

// Drop the auto-selected model (in memory and on disk) once the provider says
// it cannot serve it, so the next request rediscovers instead of repeating the
// same dead model on every message.
function forgetAutoModel(model) {
  if (autoModelState.model !== model) return;
  autoModelState = { key: null, model: null, checkedAt: 0 };
  loadModelCache().then(async (cached) => {
    if (!cached || typeof cached !== 'object') return;
    const next = { ...cached };
    for (const key of Object.keys(next)) {
      if (next[key] === model) delete next[key];
    }
    await saveModelCache(next);
  }).catch(() => {});
}

// A probe body that works on the widest set of OpenAI-compatible gateways.
// `max_tokens` is the widely accepted name, but reasoning endpoints reject it
// in favour of `max_completion_tokens`, so a 400 carrying that complaint is
// retried once with the modern spelling rather than being counted as "model
// unavailable". The same goes for a 400 that only objects to `temperature`.
function probeBodies(model) {
  const base = { model, messages: [{ role: 'user', content: 'ping' }] };
  return [
    { ...base, max_tokens: 16 },
    { ...base, max_completion_tokens: 16 },
    { ...base, max_tokens: 16, temperature: 1 },
  ];
}

function isRetryableProbeBody(status, body) {
  if (status !== 400) return false;
  const text = String(body || '').toLowerCase();
  return /max_tokens|max_completion_tokens|temperature|unsupported_value|unsupported parameter/.test(text);
}

async function probeOpenAiModel(model, signal) {
  for (const body of probeBodies(model)) {
    let res;
    try {
      res = await fetch(resolveOpenAiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.AI_API_KEY}` },
        // A tiny budget only has to look available: reasoning models spend it
        // entirely on thinking and answer with no visible content at all.
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      return false;
    }
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      // A 2xx is the availability signal. Requiring visible text here rejected
      // every thinking model, which produced "No discovered model passed the
      // probe" for providers that were working fine.
      if (data?.choices?.length) return true;
      continue;
    }
    const detail = await res.text().catch(() => '');
    // 429 means "asked too often", not "this model is unavailable": counting it
    // as a failure is what made a burst of concurrent probes reject every model
    // and AUTO give up.
    if (res.status === 429 || res.status >= 500) return null;
    if (isRetryableProbeBody(res.status, detail)) continue;
    return false;
  }
  return false;
}

async function resolveOpenAiModel(signal) {
  const configured = String(CONFIG.AI_MODEL || '').trim();
  if (configured && configured.toUpperCase() !== 'AUTO') return configured;
  const key = `${resolveOpenAiUrl()}|${CONFIG.AI_API_KEY ? 'configured' : 'missing'}`;
  if (autoModelState.key === key && autoModelState.model) {
    if (!CONFIG.AI_AUTO_REFRESH) return autoModelState.model;
    if (Date.now() - autoModelState.checkedAt < (Number(CONFIG.AI_MODEL_TTL) || 600000)) {
      return autoModelState.model;
    }
  }

  let discovered = [];
  try {
    discovered = rankDiscoveredModels(await listOpenAiModels(signal));
  } catch (error) {
    // A gateway that hides /models is common. Fall back to the operator's own
    // list, then to the built-in candidates, instead of failing outright.
    console.error('[ai] model discovery failed:', error.message);
  }

  const candidates = [
    // Only carry the in-memory pick over when it belongs to THIS endpoint;
    // otherwise a model that worked for a previous base URL is probed against
    // an unrelated gateway and can even rate-limit the real candidates.
    ...(autoModelState.key === key && autoModelState.model ? [autoModelState.model] : []),
    ...discovered,
    ...configuredFallbackModels(),
  ].filter((model, index, list) => model && list.indexOf(model) === index);

  // Try the models this key is known to work with first: a restart should not
  // spend dozens of probes rediscovering a model that already answered.
  const persisted = await loadModelCache();
  const remembered = persisted?.[cacheKey(key)] ?? persisted?.[key];
  const ordered = remembered && candidates.includes(remembered)
    ? [remembered, ...candidates.filter(model => model !== remembered)]
    : candidates;

  const rejected = [];
  for (const model of ordered) {
    const verdict = await probeOpenAiModel(model, signal);
    // null is "rate limited", which is not a verdict on the model: skip it and
    // keep looking. Probing is sequential, so this is one request at a time and
    // will not burst the gateway the way the old 6-way fan-out did.
    if (verdict === null) {
      rejected.push(`${model} (rate limited)`);
      continue;
    }
    if (verdict) {
      autoModelState = { key, model, checkedAt: Date.now() };
      // Drop any entry stored under the older, suffixed spelling of this
      // endpoint so a stale model can never be preferred later.
      const next = { ...persisted };
      delete next[key];
      next[cacheKey(key)] = model;
      await saveModelCache(next);
      console.error(`[ai] auto-selected model: ${model}`);
      return model;
    }
    rejected.push(model);
  }
  const detail = rejected.length ? `tried: ${rejected.slice(0, 12).join(', ')}` : 'no models were discovered';
  throw new Error(`AUTO could not find a working model for this key (${detail}). Set AI_MODEL explicitly, or check /models.`);
}

// Reasoning and thinking endpoints commonly reject a non-default temperature with
// a bare invalid_request_error, so it is only sent when explicitly configured.
export function shouldSendTemperature(model, configured = CONFIG.AI_TEMPERATURE) {
  const raw = String(configured ?? '').trim();
  if (raw !== '') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  if (/thinking|reasoner|reason|-high$|-medium$|(^|[\/-])o[1-9]([-.]|$)/i.test(String(model || ''))) return undefined;
  return 0.7;
}

function debugLog(label, payload) {
  if (!CONFIG.AI_DEBUG_LOG) return;
  let text;
  try { text = typeof payload === 'string' ? payload : JSON.stringify(payload); } catch { text = String(payload); }
  console.error(`[ai-debug] ${label}: ${text.slice(0, 6000)}`);
}

function toolDefinitions(tools) {
  return (tools || []).filter(tool => tool && tool.name);
}

function toOpenAIToolDefs(tools) {
  return toolDefinitions(tools).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: (tool.description || '').slice(0, 500),
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

function toAnthropicToolDefs(tools) {
  return toolDefinitions(tools).map(tool => ({
    name: tool.name,
    description: (tool.description || '').slice(0, 500),
    input_schema: tool.parameters || { type: 'object', properties: {} },
  }));
}

function toGeminiToolDefs(tools) {
  return [{
    functionDeclarations: toolDefinitions(tools).map(tool => ({
      name: tool.name,
      description: (tool.description || '').slice(0, 500),
      parameters: tool.parameters || { type: 'object', properties: {} },
    })),
  }];
}

function splitSystem(messages) {
  return {
    system: messages.filter(message => message.role === 'system').map(message => String(message.content || '')).join('\n'),
    history: messages.filter(message => message.role !== 'system'),
  };
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function anthropicMessages(messages) {
  const output = [];
  let toolResults = [];
  const flush = () => {
    if (!toolResults.length) return;
    output.push({ role: 'user', content: toolResults });
    toolResults = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      toolResults.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content || '') });
      continue;
    }
    flush();
    if (message.role === 'user') {
      output.push({ role: 'user', content: String(message.content || '') });
    } else if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      for (const call of message.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
      }
      if (blocks.length) output.push({ role: 'assistant', content: blocks });
    }
  }
  flush();
  return output;
}

function geminiMessages(messages) {
  const output = [];
  const toolNames = new Map();
  let functionResponses = [];
  const flush = () => {
    if (!functionResponses.length) return;
    output.push({ role: 'user', parts: functionResponses });
    functionResponses = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      const name = message.name || toolNames.get(message.tool_call_id) || 'tool';
      functionResponses.push({ functionResponse: { name, response: { result: String(message.content || '') } } });
      continue;
    }
    flush();
    if (message.role === 'user') {
      output.push({ role: 'user', parts: [{ text: String(message.content || '') }] });
    } else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ text: String(message.content) });
      for (const call of message.tool_calls || []) {
        const name = call.function?.name;
        if (name) toolNames.set(call.id, name);
        parts.push({ functionCall: { name, args: parseArguments(call.function?.arguments) } });
      }
      if (parts.length) output.push({ role: 'model', parts });
    }
  }
  flush();
  return output;
}

async function chatOpenAI(messages, key, tools, options) {
  const url = resolveOpenAiUrl();
  const model = await resolveOpenAiModel(options.signal);
  const body = { model, messages, max_tokens: 2048 };
  const temperature = shouldSendTemperature(model);
  if (temperature !== undefined) body.temperature = temperature;
  const definitions = toOpenAIToolDefs(tools);
  if (definitions.length) {
    body.tools = definitions;
    body.tool_choice = 'auto';
  }
  const send = payload => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  debugLog('openai request', body);
  let res = await send(body);
  // Reasoning models (o1/o3/gpt-5) reject `max_tokens` outright. The probe
  // already learned this and still picked the model, so the real request has to
  // make the same accommodation or the agent stays silent on a model that is
  // otherwise perfectly usable.
  if (!res.ok && res.status === 400) {
    const detail = await res.text().catch(() => '');
    if (/max_tokens|use max_completion_tokens|unsupported_value/i.test(detail) && 'max_tokens' in body) {
      const retryBody = { ...body };
      delete retryBody.max_tokens;
      retryBody.max_completion_tokens = body.max_tokens;
      debugLog('openai retry with max_completion_tokens', retryBody);
      res = await send(retryBody);
    }
  }
  if (!res.ok) {
    let endpoint = url;
    try {
      const parsed = new URL(url);
      endpoint = `${parsed.origin}${parsed.pathname}`;
    } catch {}
    const detail = await res.text().catch(() => '');
    debugLog('openai rejected', detail);
    // The model is unusable (gone, revoked, or not served by this key). Forget
    // it so the next request re-discovers, otherwise AUTO would keep retrying
    // this one model forever and the agent would stay silent.
    if (String(CONFIG.AI_MODEL || '').trim().toUpperCase() === 'AUTO' && shouldAdvanceModel(detail)) {
      forgetAutoModel(model);
    }
    throw new Error(`openai ${res.status} at ${endpoint} (model=${model}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  debugLog('openai response', data);
  const message = data.choices?.[0]?.message || {};
  return {
    text: message.content || '',
    toolCalls: (message.tool_calls || []).map(call => ({ id: call.id, function: call.function })),
  };
}

async function chatAnthropic(messages, key, tools, options) {
  const url = CONFIG.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
  const model = CONFIG.ANTHROPIC_MODEL && CONFIG.ANTHROPIC_MODEL !== 'AUTO' ? CONFIG.ANTHROPIC_MODEL : 'claude-3-haiku-20240307';
  const { system, history } = splitSystem(messages);
  const body = { model, messages: anthropicMessages(history), max_tokens: Math.max(1024, Number(options.thinkingBudget) || 2048) };
  // Anthropic rejects `temperature` outright when thinking is enabled, so only
  // send it when the user pinned a value.
  if (String(CONFIG.AI_TEMPERATURE || '').trim() !== '') {
    const value = Number(CONFIG.AI_TEMPERATURE);
    if (Number.isFinite(value)) body.temperature = value;
  }
  if (system) body.system = system;
  if (tools?.length) body.tools = toAnthropicToolDefs(tools);
  debugLog('anthropic request', body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    const detail = await res.text();
    debugLog('anthropic rejected', detail);
    throw new Error(`anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  debugLog('anthropic response', data);
  const content = Array.isArray(data.content) ? data.content : [];
  return {
    text: content.filter(item => item.type === 'text').map(item => item.text || '').join(''),
    toolCalls: content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, function: { name: item.name, arguments: JSON.stringify(item.input || {}) } })),
  };
}

async function chatGemini(messages, key, tools, options) {
  const base = (CONFIG.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = CONFIG.GEMINI_MODEL && CONFIG.GEMINI_MODEL !== 'AUTO' ? CONFIG.GEMINI_MODEL : 'gemini-1.5-flash';
  const { system, history } = splitSystem(messages);
  const body = { contents: geminiMessages(history) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = toGeminiToolDefs(tools);
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.filter(part => typeof part.text === 'string').map(part => part.text).join(''),
    toolCalls: parts.filter(part => part.functionCall).map((part, index) => ({ id: part.functionCall.id || `gemini-${index}`, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } })),
  };
}

export function buildOpenAIReq(messages) {
  return { model: CONFIG.AI_MODEL, messages, max_tokens: 4096, temperature: 0.7 };
}

export function buildAnthropicReq(messages) {
  const { system, history } = splitSystem(messages);
  return { model: CONFIG.ANTHROPIC_MODEL, system, messages: anthropicMessages(history), max_tokens: 4096, temperature: 0.7 };
}

export function buildGeminiReq(messages) {
  const { system, history } = splitSystem(messages);
  return { model: CONFIG.GEMINI_MODEL, systemInstruction: { parts: [{ text: system }] }, contents: geminiMessages(history) };
}
