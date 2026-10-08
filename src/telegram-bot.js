import { CONFIG } from './config.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openTags(fragment) {
  const stack = [];
  const tags = fragment.matchAll(/<\/?([A-Za-z][\w-]*)\b[^>]*>/g);
  for (const match of tags) {
    const raw = match[0];
    const name = match[1];
    if (raw.startsWith('</')) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.splice(index, 1);
    } else if (!raw.endsWith('/>')) {
      stack.push(name);
    }
  }
  return stack;
}

function safeCut(text, limit) {
  let cut = Math.min(limit, text.length);
  while (cut > 0) {
    const candidate = text.slice(0, cut);
    const lastOpen = candidate.lastIndexOf('<');
    const lastClose = candidate.lastIndexOf('>');
    const lastAmp = candidate.lastIndexOf('&');
    if (lastOpen <= lastClose && lastAmp <= candidate.lastIndexOf(';')) return cut;
    cut -= 1;
  }
  return 0;
}

export function splitHtml(html, limit = 3500) {
  const text = String(html ?? '');
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = safeCut(remaining, limit) || 1;
    let candidate = remaining.slice(0, cut);
    let stack = openTags(candidate);
    if (stack.length) {
      let closing = stack.slice().reverse().map(name => `</${name}>`).join('');
      if (candidate.length + closing.length > limit) {
        cut = safeCut(remaining, limit - closing.length) || 1;
        candidate = remaining.slice(0, cut);
        stack = openTags(candidate);
        closing = stack.slice().reverse().map(name => `</${name}>`).join('');
      }
      chunks.push(`${candidate}${closing}`);
      const opening = stack.slice().reverse().map(name => `<${name}>`).join('');
      remaining = opening + remaining.slice(cut);
    } else {
      chunks.push(candidate);
      remaining = remaining.slice(cut);
    }
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function postTelegram(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function sendMessage(chatId, html) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram bot token is not configured');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (const part of splitHtml(html)) {
    await postTelegram(url, { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

export function isOwner(msg) {
  const id = msg?.from?.id ?? msg?.chat?.id;
  // Both sides are trimmed: ALLOWED_USER_ID is often pasted into a host's env
  // dashboard, where a trailing space survives into process.env and turns every
  // message from the real owner into a silent non-match.
  return String(id).trim() === String(CONFIG.ALLOWED_USER_ID ?? '').trim();
}

export async function setCommands() {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const commands = [
    { command: 'start', description: 'Start bot' },
    { command: 'stop', description: 'Stop loops' },
    { command: 'status', description: 'Status' },
    { command: 'help', description: 'Help' },
    { command: 'settings', description: 'Public settings' },
    { command: 'set', description: 'Set validated setting' },
    { command: 'get', description: 'Get public setting' },
    { command: 'signal', description: 'Live signal' },
    { command: 'balance', description: 'Balance' },
    { command: 'positions', description: 'Open positions' },
    { command: 'trades', description: 'Recent trades' },
    { command: 'pnl', description: 'PnL report' },
    { command: 'close', description: 'Close one position' },
    { command: 'close_all', description: 'Close all with confirmation' },
    { command: 'autotrade', description: 'Enable/disable agent auto trade' },
    { command: 'scan', description: 'scan on|off' },
    { command: 'report', description: 'report on|off' },
    { command: 'leverage', description: 'Set leverage' },
    { command: 'symbol', description: 'Set symbol' },
    { command: 'models', description: 'LLM models' },
    { command: 'thinking', description: 'thinking off|low|mid|high|max' },
    { command: 'memory', description: 'Memory show' },
    { command: 'resume', description: 'Resume session' },
    { command: 'reset', description: 'Clear agent conversation' },
    { command: 'ask', description: 'Ask the agent' },
    { command: 'skills', description: 'List agent skills' },
    { command: 'skill', description: 'Read a skill: /skill id' },
    { command: 'mcp', description: 'MCP servers and tools' },
    { command: 'harness', description: 'Headless agent usage' },
    { command: 'tools', description: 'List agent tools' },
    { command: 'check_ai', description: 'Test AI connection' },
    { command: 'diag', description: 'Diagnostics' },
  ];
  await postTelegram(`https://api.telegram.org/bot${token}/setMyCommands`, { commands });
  return true;
}

export function formatSignalReport(res) {
  // strategyDirections is a name -> direction map, not an array, so it has to be
  // read through Object.values/Object.keys: spreading it threw
  // "(s.strategyDirections || {}) is not iterable" and took the whole /signal
  // report down. The denominator is the number of strategies that actually ran
  // on this timeframe rather than a hardcoded 10, which was wrong whenever a
  // strategy had no usable series.
  const tfRows = Object.entries(res.tfSignals || {})
    .map(([tf, s]) => {
      const names = Object.keys(s.strategyDirections || {});
      const agreeing = Object.values(s.strategyDirections || {}).filter(d => d === s.direction).length;
      // Two numbers, because they answer different questions and printing only
      // one made this screen contradict itself.
      //
      //   agreement — the share of the speaking book backing THIS row's
      //               direction. "bearish 100%" means every strategy that fired
      //               was bearish.
      //   conf      — the gate number, measured on the bullish frame. It is 0%
      //               on any one-sided bearish reading, because no bullish
      //               weight fired, so no gate can be cleared on that row.
      //
      // Showing only the first produced "3m: bearish 100% 0/102w (7/10)" above
      // "only 0 of 4 timeframes cleared tf_min_confidence": the 100% is real and
      // the 0 of 4 is real, they are just different measurements.
      const shown = s.sideAgreement ?? s.confidence;
      return `${esc(tf)}: ${esc(s.direction)} <code>${esc(String(shown))}</code>% `
        + `(<code>${esc(String(s.confidence))}</code>% conf) `
        + `<code>${esc(String(s.alignedWeight))}</code>/<code>${esc(String(s.activeWeight))}</code>w `
        + `(${esc(String(agreeing))}/${esc(String(names.length))})`;
    })
    .join('\n');
  // The gates that rejected the signal are printed on purpose: "hold" with no
  // reason is indistinguishable from a broken scanner.
  const reasons = [];
  if (res.rawDirection === 'neutral') reasons.push('weighted vote is neutral');
  if (!res.timeframesAgree) {
    // "0/0" on its own is unreadable: it looks like a counter that failed to
    // run. It means no timeframe cleared tf_min_confidence at all, so the vote
    // had nothing to weigh — say that instead.
    reasons.push(
      (res.eligibleTimeframes || 0) === 0
        ? `no timeframe cleared tf_min_confidence ${esc(String(CONFIG.tf_min_confidence))}, so no timeframe was eligible to vote`
        : `timeframes split ${esc(String(res.alignedTimeframes))}/${esc(String(res.eligibleTimeframes))}`,
    );
  }
  // res.confidence is 0 for a rejected signal, so the raw reading is what has
  // to be compared against the gate — reporting the 0 is what made a healthy
  // scanner look dead.
  // "<" and ">" are HTML, not punctuation. Emitting them raw inside the <i>
  // block made Telegram parse "< min_confidence 80</i>" as an unknown start
  // tag and reject the whole message ("can't parse entities"), so /signal
  // never arrived at all — the report that was supposed to explain a hold was
  // the thing that broke. Spell the comparison with words instead of angle
  // brackets so the gate text cannot collide with the markup around it.
  if ((res.rawConfidence || 0) < CONFIG.min_confidence) {
    reasons.push(`confidence ${esc(String(res.rawConfidence))} below min_confidence ${esc(String(CONFIG.min_confidence))}`);
  }
  if ((res.agreeingStrategies || 0) < CONFIG.min_agreeing_strategies) {
    reasons.push(`${esc(String(res.agreeingStrategies))} strategies, min_agreeing_strategies is ${esc(String(CONFIG.min_agreeing_strategies))}`);
  }
  // The timeframe-count gate is the one that decides a hold most of the time
  // and it was missing here, so the report printed "All gates passed" next to
  // "Direction: hold" — the only gate that had actually failed was the one
  // nobody was shown. It is derived from the same fields the header prints, so
  // no new field is needed to explain the hold.
  const minTimeframes = Math.max(1, Number(CONFIG.min_eligible_timeframes) || 1);
  if ((res.eligibleTimeframes || 0) < minTimeframes) {
    reasons.push(`only ${esc(String(res.eligibleTimeframes))} of ${esc(String(Object.keys(res.tfSignals || {}).length))} timeframes cleared tf_min_confidence, min_eligible_timeframes is ${esc(String(minTimeframes))}`);
  }
  // The gate text is what the operator reads when nothing trades, so it has to
  // agree with the direction printed above it. Deriving the verdict the same way
  // the scanner derives it means the two cannot drift apart again.
  const passed = res.signal === 'bullish' || res.signal === 'bearish';
  const gate = passed
    ? '\n<i>Tradeable.</i>'
    : reasons.length
      ? `\n<i>HOLD because: ${reasons.join('; ')}</i>`
      : '\n<i>HOLD.</i>';
  return `<b>SIGNAL ${esc(res.symbol)}</b>\nDirection: <b>${esc(res.signal)}</b>`
    + ` | raw <b>${esc(String(res.rawDirection))}</b> <b>${esc(String(res.rawConfidence))}</b>%`
    + ` | tf ${esc(String(res.eligibleTimeframes))}/${esc(String(Object.keys(res.tfSignals || {}).length))}`
    + ` | strategies <b>${esc(String(res.agreeingStrategies))}</b>\nPrice: <code>${esc(String(res.lastPrice ?? '-'))}</code>\n${tfRows}${gate}`;
}

export { esc };
