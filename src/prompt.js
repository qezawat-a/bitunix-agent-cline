import fs from 'fs/promises';
import { CONFIG } from './config.js';

function safeMemory(memory) {
  const entries = Object.entries(memory && typeof memory === 'object' ? memory : {})
    .filter(([key]) => !/(api[_-]?key|secret|token|password|database_url|credential)/i.test(key));
  return entries.map(([key, value]) => {
    const serialized = JSON.stringify(value);
    if (/(api[_-]?key|secret|token|password|private[_-]?key|Bearer\s+)/i.test(serialized)) return [key, '[redacted]'];
    return [key, value];
  });
}

export async function buildSystemPrompt({ skills = [], tools = [], memory = {} } = {}) {
  let soul = '';
  let style = '';
  try { soul = await fs.readFile('soul/SOUL.md', 'utf8'); } catch {}
  try { style = await fs.readFile('soul/STYLE.md', 'utf8'); } catch {}

  const skillBlock = skills.map(skill => `## Skill: ${skill.name}\n${skill.content}`).join('\n\n');
  const toolBlock = tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n');
  const memBlock = safeMemory(memory).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  const thinking = CONFIG.AGENT_THINKING_ENABLED
    ? `Think carefully before tool calls. Thinking budget: ${CONFIG.AGENT_THINKING_BUDGET || 5000} tokens.`
    : 'Thinking is disabled; answer directly and safely.';

  return `# ${CONFIG.AGENT_NAME} — AI Agent Futures Trader (Bitunix USDT-M)

You are an agentic Bitunix futures trader. Use tools to inspect live data and act; do not pretend an action happened.

## Soul
${soul}

## Style
${style}

## Skills
${skillBlock}

## Tools
${toolBlock}

## Memory (long-term)
${memBlock}

## Trading rules
- Exchange: Bitunix USDT-M futures. All calls via approved trading tools.
- This is a live-only integration: there is no dry-run mode.
- The scanner never opens an order by itself. The agent may call the signal-gated execution tool after inspecting data.
- Signal gate: min_confidence=${CONFIG.min_confidence}, tf_min=${CONFIG.tf_min_confidence}, min_agree=${CONFIG.min_agreeing_strategies}, confirm_scans=${CONFIG.signal_confirm_scans}, cooldown=${CONFIG.cooldown_minutes}min.
- TP/SL is dynamic (ATR x strength). No static min/max.
- Position mode=${CONFIG.position_mode}, margin=${CONFIG.position_type}, leverage=${CONFIG.leverage}.
- Always check balance, liquidation distance (>= ${CONFIG.sl_liquidation_safety}%), and max positions (${CONFIG.max_positions}) before opening.
- Report every ${CONFIG.report_interval_sec}s with signal, price, and open-position PnL.
- ${thinking}
`;
}
