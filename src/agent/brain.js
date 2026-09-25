import { CONFIG } from '../config.js';

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

let autoModelState = { key: null, model: null };

function rankDiscoveredModels(models) {
  const blocked = /embed|whisper|tts|audio|dall|image|moderation|rerank|realtime|omni|fine-tune|guard/i;
  const preferred = /free|flash|mini|lite|nano|small|distil/i;
  const usable = models.filter(model => !blocked.test(model));
  return [
    ...usable.filter(model => /:free$/i.test(model)),
    ...usable.filter(model => preferred.test(model)),
    ...usable.filter(model => !/:free$/i.test(model) && !preferred.test(model)),
  ];
}

async function probeOpenAiModel(model, signal) {
  const res = await fetch(resolveOpenAiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.AI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    signal,
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return Boolean(data?.choices?.[0]?.message);
}

async function resolveOpenAiModel(signal) {
  const configured = String(CONFIG.AI_MODEL || '').trim();
  if (configured && configured.toUpperCase() !== 'AUTO') return configured;
  const key = `${resolveOpenAiUrl()}|${CONFIG.AI_API_KEY ? 'configured' : 'missing'}`;
  if (autoModelState.key === key && autoModelState.model) return autoModelState.model;
  const models = rankDiscoveredModels(await listOpenAiModels(signal));
  for (const candidate of models.slice(0, 10)) {
    try {
      if (await probeOpenAiModel(candidate, signal)) {
        autoModelState = { key, model: candidate };
        return candidate;
      }
    } catch {}
  }
  throw new Error('No discovered model passed the availability probe; set AI_MODEL explicitly');
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
  const body = { model, messages, max_tokens: 2048, temperature: 0.7 };
  const definitions = toOpenAIToolDefs(tools);
  if (definitions.length) {
    body.tools = definitions;
    body.tool_choice = 'auto';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    let endpoint = url;
    try {
      const parsed = new URL(url);
      endpoint = `${parsed.origin}${parsed.pathname}`;
    } catch {}
    throw new Error(`openai ${res.status} at ${endpoint} (model=${model}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
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
  const body = { model, messages: anthropicMessages(history), max_tokens: Math.max(1024, Number(options.thinkingBudget) || 2048), temperature: 0.7 };
  if (system) body.system = system;
  if (tools?.length) body.tools = toAnthropicToolDefs(tools);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
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
