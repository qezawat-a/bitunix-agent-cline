import { CONFIG } from '../config.js';
import { parseThinkingLevel } from './thinking.js';
import { chat } from './brain.js';
import { detectProviders } from './config.js';
import { withTimeout, validateToolArguments, stringifyToolResult } from './tools.js';

function resolveSystem(agent) {
  return typeof agent.system === 'function' ? agent.system() : Promise.resolve(agent.system);
}

function cleanHistory(history) {
  return history
    .filter(message => message && typeof message === 'object' && ['user', 'assistant', 'tool'].includes(message.role))
    .map(message => ({ ...message }));
}

function buildMessages(agent, _provider, system) {
  const hist = cleanHistory(agent.history.slice(-20));
  return [{ role: 'system', content: system }, ...hist];
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
          result = await withTimeout(signal => tool.handler(args, { signal }), 20000);
        } catch (error) {
          result = { error: error.message || String(error) };
        }
        const content = stringifyToolResult(result);
        agent.history.push({ role: 'tool', tool_call_id: call.id, name, content });
      }
    }
  } catch (error) {
    finalText = `LLM error: ${error.message}. (AI key/model o check kon — /models ro bebin)`;
  }

  if (!finalText) finalText = 'Hichi bar nagasht — dobare bepors.';
  agent.history.push({ role: 'assistant', content: finalText });
  return { role: 'assistant', content: finalText };
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
