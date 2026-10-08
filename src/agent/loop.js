import { CONFIG } from '../config.js';
import { parseThinkingLevel } from './thinking.js';
import { chat } from './brain.js';
import { detectProviders } from './config.js';
import { withTimeout, validateToolArguments, stringifyToolResult } from './tools.js';

function resolveSystem(agent) {
  return typeof agent.system === 'function' ? agent.system() : Promise.resolve(agent.system);
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

// Outgoing history must satisfy two provider rules that the raw agent.history
// does not: every assistant tool_call needs its matching tool result, and a tool
// result may never appear without the assistant message that announced it. The
// sliding window cut can split a tool group in half, and strict OpenAI-compatible
// gateways answer that with a hard 400 invalid_request_error — which then sticks,
// because the same history is replayed on every later turn.
export function sanitizeHistory(history, limit = 20) {
  const window = (Array.isArray(history) ? history : [])
    .filter(message => message && typeof message === 'object' && ['user', 'assistant', 'tool'].includes(message.role))
    .slice(-Math.max(1, Number(limit) || 20));

  // Only tool calls that actually have a result inside the window may be sent.
  const responded = new Set(window
    .filter(message => message.role === 'tool' && message.tool_call_id)
    .map(message => message.tool_call_id));

  const out = [];
  for (const message of window) {
    if (message.role === 'tool') {
      // Rebuilt without `name`: the OpenAI tool-message schema is exactly
      // {role, tool_call_id, content}, and strict validators reject extra fields.
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: textContent(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const content = textContent(message.content);
      const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
        .filter(call => call?.id && call?.function?.name && responded.has(call.id))
        .map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            // arguments must travel as a JSON string, never as an object.
            arguments: typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
          },
        }));
      if (!content && !calls.length) continue;
      const entry = { role: 'assistant', content };
      if (calls.length) entry.tool_calls = calls;
      out.push(entry);
      continue;
    }
    out.push({ role: 'user', content: textContent(message.content) });
  }

  // Second pass: now that tool_calls have been trimmed, drop any tool result
  // whose partner call did not survive.
  const announced = new Set(out
    .filter(message => message.role === 'assistant' && message.tool_calls)
    .flatMap(message => message.tool_calls.map(call => call.id)));
  return out.filter(message => message.role !== 'tool' || announced.has(message.tool_call_id));
}

function buildMessages(agent, _provider, system) {
  return [{ role: 'system', content: system }, ...sanitizeHistory(agent.history, 20)];
}

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be an object');
  return parsed;
}

export function createAgent({ system, tools, memory, maxRounds = 8, history = [], autoCompact = CONFIG.AGENT_AUTO_COMPACT, thinkingLevel = CONFIG.AGENT_THINKING_LEVEL }) {
  const agent = {
    system,
    tools: tools || [],
    memory,
    maxRounds,
    history: Array.isArray(history) ? [...history] : [],
    autoCompact,
    thinkingLevel: parseThinkingLevel(thinkingLevel),
    thinkingBudget: CONFIG.AGENT_THINKING_BUDGET || 5000,
    autonomous: Boolean(CONFIG.AGENT_AUTONOMOUS),
    autonomousIntervalSec: Math.max(5, Number(CONFIG.AGENT_AUTONOMOUS_INTERVAL_SEC) || 15),
  };
  agent.say = (text) => say(agent, text);
  agent.replaceHistory = (next) => {
    if (!Array.isArray(next)) throw new Error('history must be an array');
    agent.history = [...next];
    return agent.history;
  };
  agent.compactHistory = async (input) => compactHistory(input || agent.history);
  agent.maybeCompact = () => agent.autoCompact && agent.history.length > 40;
  agent.isAutoCompact = () => agent.autoCompact;
  return agent;
}

export async function say(agent, text) {
  const input = String(text ?? '');
  // Take the checkpoint before the user message lands, so a failed turn can be
  // wound back completely. Without this the failing user turn plus its error text
  // stay in history forever and every later request replays the same bad payload.
  const checkpoint = agent.history.length;
  agent.history.push({ role: 'user', content: input });
  if (agent.autoCompact && agent.history.length > 40) agent.history = await agent.compactHistory(agent.history);

  const provider = detectProviders();
  const hasKey = provider === 'openai'
    ? Boolean(CONFIG.AI_API_KEY)
    : provider === 'anthropic'
      ? Boolean(CONFIG.ANTHROPIC_API_KEY)
      : Boolean(CONFIG.GEMINI_API_KEY);
  if (!hasKey) {
    const reply = 'AI key set nist — man hanuz be LLM vasl nistam, pas nemitunam javab vaghei bedam.\n\nDar .env yekio por kon:\n- AI_API_KEY (+ AI_BASE_URL, AI_MODEL)\n- ya ANTHROPIC_API_KEY\n- ya GEMINI_API_KEY\n\nBad restart kon (npm start) va dobare bepors.';
    agent.history.push({ role: 'assistant', content: reply });
    return { role: 'assistant', content: reply };
  }

  const useTools = agent.tools.length > 0;
  let finalText = '';
  let failed = false;
  const system = await resolveSystem(agent);

  try {
    for (let round = 0; round < (agent.maxRounds || 8); round++) {
      const messages = buildMessages(agent, provider, system);
      const res = await withTimeout(signal => chat(messages, provider, useTools ? agent.tools : [], { signal, thinkingLevel: agent.thinkingLevel, thinkingBudget: agent.thinkingBudget }), 60000);
      if (res.text) finalText = res.text;
      const toolCalls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
      if (!toolCalls.length) break;

      agent.history.push({
        role: 'assistant',
        content: res.text || null,
        tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: call.function })),
      });
      for (const call of toolCalls) {
        const name = call.function?.name || call.name;
        let result;
        try {
          const args = parseToolArguments(call.function?.arguments);
          const tool = agent.tools.find(candidate => candidate.name === name);
          if (!tool) throw new Error(`unknown tool: ${name}`);
          validateToolArguments(tool.parameters || {}, args);
          // Accept both contracts: this repo's tools use handler(args, ctx) so they
          // receive an AbortSignal, while ported CRAG-style tools use run(args).
          const invoke = tool.handler || tool.run;
          if (typeof invoke !== 'function') throw new Error(`tool ${name} has no handler/run`);
          result = await withTimeout(signal => invoke(args, { signal }), 20000);
        } catch (error) {
          result = { error: error.message || String(error) };
        }
        const content = stringifyToolResult(result);
        agent.history.push({ role: 'tool', tool_call_id: call.id, name, content });
      }
    }
  } catch (error) {
    failed = true;
    finalText = `LLM error: ${error.message}. (AI key/model o check kon — /models ro bebin)`;
  }

  if (failed) {
    // Wind the session back to exactly where it was before this turn. The caller
    // still sees the error, but the next message starts from clean state instead
    // of re-sending a payload the provider already rejected.
    agent.history.length = checkpoint;
    return { role: 'assistant', content: finalText, error: true };
  }

  if (!finalText) {
    const failures = agent.history.filter(
      entry => entry.role === 'tool' && /"error"\s*:/.test(String(entry.content)),
    );
    finalText = failures.length
      ? `Tool error: ${String(failures[failures.length - 1].content).slice(0, 300)}`
      : 'Model returned no text (Hichi bar nagasht). Try /models or /thinking off, ya dobare bepors.';
  }
  agent.history.push({ role: 'assistant', content: finalText });
  return { role: 'assistant', content: finalText };
}

export function resetAgent(agent) {
  if (!agent || !Array.isArray(agent.history)) throw new Error('agent history is not an array');
  const cleared = agent.history.length;
  agent.history.length = 0;
  return cleared;
}

export function replaceHistory(history, newHistory) {
  if (!Array.isArray(newHistory)) throw new Error('history must be an array');
  return [...newHistory];
}

export async function compactHistory(history) {
  const messages = Array.isArray(history) ? history : [];
  const recent = messages.slice(-10);
  const older = messages.slice(0, -10);
  const summary = older
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .map(message => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(0, 200) : ''}`)
    .join('\n')
    .slice(0, 1000);
  return summary ? [{ role: 'user', content: `Conversation summary:\n${summary}` }, ...recent] : recent;
}

export function maybeCompact(memory, budget) {
  return budget > (CONFIG.AGENT_THINKING_BUDGET || 5000);
}

export function isAutoCompact() {
  return true;
}
