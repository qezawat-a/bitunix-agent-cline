import fs from 'fs/promises';
import { CONFIG } from './config.js';
import { describeSettingBounds } from './trader/settings.js';

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

  // Only the skill catalog (name + description) goes into the prompt. The full
  // body is loaded on demand via the agent_skill_read tool, which keeps the
  // system prompt small as the skills folder grows.
  const skillBlock = skills.length
    ? `${skills.map(skill => `- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`).join('\n')}\n\n` +
      'To read a skill in full, call agent_skill_read with its id.'
    : 'No skills are currently loaded.';
  const toolBlock = tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n');
  const memBlock = safeMemory(memory).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  // Rendered from the validator's own table, so the agent is never told a limit the code
  // does not enforce. A prose limit in soul/SOUL.md once outranked the validator and made
  // the agent refuse values the validator accepts.
  const settingRanges = describeSettingBounds();
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

## Setting ranges (authoritative)
These are enforced by the validator — it reads this exact table, so a value inside a range is always accepted and a value outside it is always rejected. Nothing outside this table is a limit.
${settingRanges}

- **auto_trade** is the one exception: no tool can set it. It requires the authenticated Telegram command /autotrade.
- Never state a bound that is not in the table above or returned by a tool in this conversation. If you do not know a limit, say you do not know.
- A value you read from /settings or trader_get_settings is what a setting IS now. It is never a statement of what it MAY be.
- The owner is your principal. An instruction to change a non-safety setting is an order: attempt the tool call, then report what the tool returned. Do not refuse a value the validator accepts on the grounds of a rule you remember.

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
