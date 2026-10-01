// Position-lifecycle Telegram notifications.
//
// Why this exists: the bot only ever reported *signals*. Nothing observed the
// position list, so an entry filled, a stop hit, a trailing exit fired or the
// liquidation guard closed a position, and all of it happened in silence.
//
// The notifier is a pure observer. It diffs the exchange's pending positions
// against the previous tick, so it catches every exit regardless of which code
// path closed it (break-even, trailing callback, account guard, liquidation
// guard, a manual /close, or the operator closing it in the Bitunix app) and
// does not need to be plumbed into any of them. Close reasons recorded by
// PositionManager are attached when they are known.
import { CONFIG } from '../config.js';

const EMOJI = {
  long: '🟢',
  short: '🔴',
  open: '📈',
  close: '📉',
};

export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(value, digits = 4) {
  const n = num(value);
  if (n === null) return '-';
  const abs = Math.abs(n);
  // Keep small altcoin prices readable without printing 18 decimals.
  const text = abs > 0 && abs < 1 ? n.toFixed(6) : n.toFixed(digits);
  return text.replace(/\.?0+$/, '') || '0';
}

function usd(value) {
  const n = num(value);
  if (n === null) return '-';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

export function normalizeSide(side) {
  const value = String(side || '').toUpperCase();
  if (value === 'BUY' || value === 'LONG') return 'BUY';
  if (value === 'SELL' || value === 'SHORT') return 'SELL';
  return value;
}

export function sideLabel(side) {
  const normalized = normalizeSide(side);
  if (normalized === 'BUY') return 'LONG';
  if (normalized === 'SELL') return 'SHORT';
  return normalized || '-';
}

export function directionEmoji(side) {
  const normalized = normalizeSide(side);
  return normalized === 'SELL' ? EMOJI.short : normalized === 'BUY' ? EMOJI.long : '•';
}

// ROI of the position itself, not of the account: price move x direction x
// leverage, so a "+12.50%" line means what the operator sees on the position.
export function positionRoiPct({ entryPrice, closePrice, side, leverage }) {
  const entry = num(entryPrice);
  const exit = num(closePrice);
  if (entry === null || exit === null || entry <= 0) return null;
  const direction = normalizeSide(side) === 'SELL' ? -1 : 1;
  const lev = num(leverage) > 0 ? num(leverage) : 1;
  return ((exit - entry) / entry) * 100 * direction * lev;
}

export const CLOSE_REASONS = Object.freeze({
  take_profit: 'Take-profit',
  stop_loss: 'Stop-loss',
  breakeven_stop: 'Break-even stop',
  trailing_callback: 'Trailing callback',
  liquidation_guard: 'Liquidation guard',
  account_tp: 'Account take-profit',
  account_sl: 'Account stop-loss',
  tpsl_failure: 'TP/SL failure (closed by safety)',
  manual: 'Closed manually',
  reversal: 'Reversal signal',
  unknown: 'Closed on the exchange',
});

export function openMessage(position, tpsl = null) {
  const side = normalizeSide(position.side);
  const leverage = num(position.leverage) ?? num(CONFIG.leverage) ?? 1;
  const lines = [
    `${EMOJI.open} <b>POSITION OPENED</b>`,
    `${directionEmoji(side)} <b>${sideLabel(side)}</b> <code>${escHtml(position.symbol || CONFIG.symbol)}</code>  <code>${escHtml(position.positionId)}</code>`,
    // Bitunix pending positions carry the entry as avgOpenPrice, not avgPrice
    // — reading only the latter printed "Entry: -" on a position that was
    // perfectly known, while the close notification minutes later showed it.
    `Entry: <code>${fmt(position.avgPrice ?? position.avgOpenPrice ?? position.entryPrice)}</code>   Qty: <code>${fmt(position.qty ?? position.size)}</code>   Leverage: <code>${leverage}x</code>`,
  ];
  const tp = tpsl?.tpPrice ?? position.tpPrice;
  const sl = tpsl?.slPrice ?? position.slPrice;
  lines.push(`TP: <code>${fmt(tp)}</code>   SL: <code>${fmt(sl)}</code>`);
  return lines.join('\n');
}

export function closeMessage({ position, pnl, reason }) {
  const side = normalizeSide(position?.side);
  const entry = position?.entryPrice ?? position?.avgPrice ?? position?.avgOpenPrice;
  const exit = position?.closePrice ?? position?.avgClosePrice;
  const leverage = num(position?.leverage) ?? num(CONFIG.leverage) ?? 1;
  const realized = num(position?.realizedPNL ?? position?.realizedPnl ?? pnl);
  const roi = positionRoiPct({ entryPrice: entry, closePrice: exit, side, leverage });
  const pnlSign = realized === null ? '' : realized >= 0 ? '✅' : '❌';
  const lines = [
    `${EMOJI.close} <b>POSITION CLOSED</b> — ${escHtml(CLOSE_REASONS[reason] || CLOSE_REASONS.unknown)}`,
    `${directionEmoji(side)} <b>${sideLabel(side)}</b> <code>${escHtml(position?.symbol || CONFIG.symbol)}</code>  <code>${escHtml(position?.positionId || '-')}</code>`,
    `Entry: <code>${fmt(entry)}</code>   Exit: <code>${fmt(exit)}</code>   Qty: <code>${fmt(position?.qty ?? position?.size)}</code>`,
  ];
  if (realized !== null) lines.push(`Realized PnL: ${pnlSign} <b>${usd(realized)}</b>`);
  if (roi !== null) lines.push(`ROI: <b>${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%</b> (${leverage}x)`);
  return lines.join('\n');
}

export function tpslMessage(position, action, price) {
  const labels = { breakeven: 'Break-even stop', trailing: 'Trailing stop' };
  return [
    `🛡 <b>${escHtml(labels[action] || 'Stop moved')}</b>`,
    `${escHtml(sideLabel(position?.side))} <code>${escHtml(position?.symbol || CONFIG.symbol)}</code>  SL → <code>${fmt(price)}</code>`,
  ].join('\n');
}

// A minimal view of an open position, kept across ticks so a position can be
// reported when it first appears and recognised when it disappears.
function snapshot(position) {
  return {
    positionId: String(position.positionId),
    symbol: String(position.symbol || CONFIG.symbol).toUpperCase(),
    side: normalizeSide(position.side),
    entryPrice: num(position.avgPrice ?? position.avgOpenPrice ?? position.entryPrice),
    qty: num(position.qty ?? position.size),
    leverage: num(position.leverage),
    markPrice: num(position.markPrice),
    unrealizedPnl: num(position.unrealizedPNL ?? position.unrealizedPnl),
  };
}

export class PositionNotifier {
  constructor({ client, settings = CONFIG, send, chatId = CONFIG.ALLOWED_USER_ID }) {
    this.client = client;
    this.settings = settings;
    this.send = send;
    this.chatId = chatId;
    this.known = new Map();
    this.started = false;
    this.syncing = null;
    // Close reasons keyed by positionId, recorded by whoever initiated the
    // close. Entries are consumed once, so a close is never labelled twice.
    this.reasons = new Map();
  }

  // Called by PositionManager / the Telegram commands before a close is sent.
  // Unknown reasons fall back to "closed on the exchange", which is still
  // accurate — this only improves the label.
  noteClose(positionId, reason) {
    if (positionId === undefined || positionId === null) return;
    this.reasons.set(String(positionId), reason);
  }

  async notify(text) {
    const chatId = this.chatId;
    if (!chatId || !this.send) return false;
    try {
      await this.send(chatId, text);
      return true;
    } catch (error) {
      console.error('[notify] send failed:', error.message);
      return false;
    }
  }

  async fetchPending() {
    if (typeof this.client?.getPendingPositions !== 'function') return [];
    const data = await this.client.getPendingPositions(CONFIG.symbol);
    return Array.isArray(data) ? data : [];
  }

  // The exchange's own record of a closed position. Used only to fill in the
  // exit price and realized PnL, so a failed lookup degrades the message rather
  // than losing it.
  async findClosed(positionId) {
    if (typeof this.client?.getHistoryPositions !== 'function') return null;
    try {
      const history = await this.client.getHistoryPositions(CONFIG.symbol);
      if (!Array.isArray(history)) return null;
      return history.find(row => String(row.positionId) === String(positionId)) || null;
    } catch {
      return null;
    }
  }

  async tpslFor(positionId) {
    if (typeof this.client?.getPendingTPSL !== 'function') return null;
    try {
      const pending = await this.client.getPendingTPSL(CONFIG.symbol);
      if (!Array.isArray(pending)) return null;
      return pending.find(row => String(row.positionId) === String(positionId)) || null;
    } catch {
      return null;
    }
  }

  // One pass. Returns the events it reported so callers (and tests) can assert
  // on them without scraping the chat.
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.run();
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  async run() {
    const events = [];
    let positions;
    try {
      positions = await this.fetchPending();
    } catch (error) {
      console.error('[notify] position fetch failed:', error.message);
      return events;
    }

    // First pass only establishes the baseline. Announcing "opened" for every
    // position that already existed at boot would be noise, and there is no
    // baseline to diff a close against before the first pass anyway.
    if (!this.started) {
      this.started = true;
      for (const position of positions) this.known.set(String(position.positionId), snapshot(position));
      return events;
    }

    const live = new Map(positions.map(position => [String(position.positionId), position]));

    for (const [positionId, previous] of this.known) {
      if (live.has(positionId)) continue;
      if (!this.settings.notify_close) {
        this.known.delete(positionId);
        this.reasons.delete(positionId);
        continue;
      }
      const history = await this.findClosed(positionId);
      const reason = this.reasons.get(positionId) || 'unknown';
      this.reasons.delete(positionId);
      const message = closeMessage({
        position: {
          ...previous,
          ...(history || {}),
          // The remembered snapshot is the authority for entry/side/qty; the
          // history row only supplies the exit side of the message.
          entryPrice: previous.entryPrice ?? history?.entryPrice,
          side: previous.side,
          qty: previous.qty,
          symbol: previous.symbol,
        },
        reason,
      });
      await this.notify(message);
      this.known.delete(positionId);
      events.push({ type: 'closed', positionId, reason, message });
    }

    for (const [positionId, position] of live) {
      if (this.known.has(positionId)) {
        this.known.set(positionId, { ...this.known.get(positionId), ...snapshot(position) });
        continue;
      }
      this.known.set(positionId, snapshot(position));
      if (!this.settings.notify_open) continue;
      await this.notify(openMessage(position, await this.tpslFor(positionId)));
      events.push({ type: 'opened', positionId, message: null });
    }

    return events;
  }

  async reportStopMove(position, action, price) {
    if (!this.settings.notify_tpsl) return false;
    return this.notify(tpslMessage(position, action, price));
  }

  reset() {
    this.known.clear();
    this.reasons.clear();
    this.started = false;
  }
}
