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
  return String(id) === String(CONFIG.ALLOWED_USER_ID);
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
  const tfRows = Object.entries(res.tfSignals || {})
    .map(([tf, s]) => `${esc(tf)}: ${esc(s.direction)} <code>${esc(String(s.confidence))}</code>`)
    .join('\n');
  return `<b>SIGNAL ${esc(res.symbol)}</b>\nDirection: <b>${esc(res.signal)}</b> | Confidence: <b>${esc(String(res.confidence))}</b>\nPrice: <code>${esc(String(res.lastPrice ?? '-'))}</code>\n${tfRows}`;
}

export { esc };
