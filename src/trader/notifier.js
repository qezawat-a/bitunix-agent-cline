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
  // Number(null) and Number('') are both 0, so a missing price would otherwise
  // be read as a real zero — the same null-vs-undefined trap that made every
  // position-level TP/SL row look like a partial leg. Reject the non-numbers
  // before coercing.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A price of 0 is never a real protection level, so it reads as "missing"
// rather than as a stop at the origin.
function positive(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
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

// Same logic closeMessage uses, split out so any code path (report, /positions,
// /pnl) can render protections without re-reading a position's own row, which
// PositionPendingResp never carries.
function firstPrice(rows, key, fallback) {
  for (const row of rows || []) {
    const value = positive(row?.[key]);
    if (value !== null) return value;
  }
  return positive(fallback);
}

// A short label for one open position.
//
// This used to describe only the protection, never the money, so every open
// position reported `running` — a position sitting at -788% on margin read
// exactly the same as one at +2%. The operator was told a bleeding trade was
// healthy. The label now states the three things that decide whether a position
// needs attention, worst first:
//
//   NO TP/SL     naked — no exit exists on the exchange
//   liquidation  the mark is within `safetyPct` of liqPrice, i.e. the exchange
//                is close to force-reducing it. This is the liquidation
//                mechanism's own trigger, read from the position payload's
//                `liqPrice`; a value <= 0 means "no liquidation price right now".
//   break-even   the stop is at or through the entry, so the trade cannot lose
//                beyond slippage from here
//   profit/loss  the current unrealised PnL, which is the state the operator
//                actually has to act on
//
// Protection outranks PnL because a winning position with no stop is still a
// risk, and liquidation outranks both because it is unrecoverable.
export function positionStatus({
  entryPrice,
  side,
  slPrice,
  tpPrice,
  unrealizedPnl,
  liqPrice,
  markPrice,
  safetyPct = null,
}) {
  const entry = num(entryPrice);
  const sl = positive(slPrice);
  const tp = positive(tpPrice);
  const pnl = num(unrealizedPnl);
  if (tp === null && sl === null) return '⚠️ NO TP/SL';

  const direction = normalizeSide(side) === 'SELL' ? -1 : 1;

  // Distance from the mark to the liquidation price. The liquidation guard in
  // PositionManager closes on the same measurement, so the label and the action
  // agree instead of the report calling a closing position "running".
  const mark = num(markPrice);
  const liq = positive(liqPrice);
  if (mark !== null && liq !== null && safetyPct !== null && Number(safetyPct) > 0) {
    const distance = Math.abs(mark - liq) / mark;
    if (Number.isFinite(distance) && distance < Number(safetyPct) / 100) return '🚨 liquidation';
  }

  if (sl !== null && entry !== null && entry > 0 && (sl - entry) * direction >= 0) {
    return '🧷 break-even';
  }
  if (pnl !== null && pnl !== 0) {
    const sign = pnl > 0 ? '📈' : '📉';
    return `${sign} ${pnl > 0 ? 'profit' : 'loss'}`;
  }
  return 'running';
}

// Merges the pending TP/SL order rows (getPendingTPSL, one or more per position
// depending on tpsl_method) into the position list and renders every open
// position as a Telegram block: side, entry/qty/leverage, TP/SL/liquidation,
// the unrealized PnL and the protection status.
//
// The position row itself carries unrealizedPNL and margin, so the PnL block
// needs no second round trip: those numbers are the position's own.
//
// The one thing a position row does not carry is the mark price —
// get_pending_positions returns positionId, qty, entryValue, leverage,
// unrealizedPNL, liqPrice, marginRate and avgOpenPrice, but no mark price. The
// liquidation label needs the live mark to measure the distance to liqPrice,
// exactly as PositionManager.checkLiquidationGuard does, so the caller passes
// the tickers payload (`markPrice` per symbol) as `marks`.
export function formatPositions(positions, tpslRows = [], marks = null) {
  const rowsById = new Map();
  for (const row of Array.isArray(tpslRows) ? tpslRows : []) {
    const id = String(row?.positionId);
    if (!rowsById.has(id)) rowsById.set(id, []);
    rowsById.get(id).push(row);
  }
  // Accept either the raw tickers array or an already-keyed { SYMBOL: price }
  // map, so the caller can hand over whatever it has without reshaping it.
  const markFor = symbol => {
    if (!marks) return null;
    const key = String(symbol || CONFIG.symbol).toUpperCase();
    if (Array.isArray(marks)) {
      const row = marks.find(t => String(t?.symbol || '').toUpperCase() === key);
      return num(row?.markPrice ?? row?.lastPrice);
    }
    return num(marks[key] ?? marks[key.toLowerCase()]);
  };
  const lines = [];
  for (const position of Array.isArray(positions) ? positions : []) {
    const rows = rowsById.get(String(position.positionId)) || [];
    const tp = firstPrice(rows, 'tpPrice', position.tpPrice);
    const sl = firstPrice(rows, 'slPrice', position.slPrice);
    const side = normalizeSide(position.side);
    const leverage = num(position.leverage) ?? 1;
    const entry = num(position.avgPrice ?? position.avgOpenPrice ?? position.entryPrice);
    const unrealized = num(position.unrealizedPNL ?? position.unrealizedPnl);
    const margin = num(position.margin);
    const pnlPct = unrealized !== null && margin !== null && margin > 0 ? (unrealized / margin) * 100 : null;
    // `margin` is the position's locked initial margin (entryValue / leverage),
    // so unrealizedPNL / margin IS the return on margin and already carries the
    // leverage. Bitunix's own `marginRate` is the exchange-side view of the same
    // quantity and is what the tiered risk limit compares against the
    // maintenance margin rate, so both are reported: the percentage the
    // operator reads, and the exchange's own number.
    const marginRate = num(position.marginRate);
    const status = positionStatus({
      entryPrice: entry,
      side,
      slPrice: sl,
      tpPrice: tp,
      unrealizedPnl: unrealized,
      liqPrice: position.liqPrice,
      markPrice: num(position.markPrice ?? position.lastPrice) ?? markFor(position.symbol),
      // Same threshold PositionManager.checkLiquidationGuard closes on, so the
      // label and the action can never disagree about how close this is.
      safetyPct: CONFIG.sl_liquidation_safety,
    });
    lines.push(
      `${directionEmoji(side)} <b>${sideLabel(side)}</b> <code>${escHtml(position.symbol || CONFIG.symbol)}</code> <code>${escHtml(String(position.positionId))}</code> — <i>${status}</i>`,
      `Entry: <code>${fmt(entry)}</code>   Qty: <code>${fmt(position.qty ?? position.size)}</code>   Lev: <code>${leverage}x</code>`,
      `TP: <code>${fmt(tp)}</code>   SL: <code>${fmt(sl)}</code>   Liq: <code>${fmt(position.liqPrice)}</code>`,
    );
    if (unrealized !== null) {
      const sign = unrealized >= 0 ? '✅' : '❌';
      const pct = pnlPct !== null ? `  (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% on margin)` : '';
      const rate = marginRate !== null ? `  · margin rate <code>${(marginRate * 100).toFixed(2)}%</code>` : '';
      lines.push(`PnL: ${sign} <b>${usd(unrealized)}</b>${pct}${rate}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No open positions.';
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
  async findClosed(positionId, { attempts = 3, delayMs = 400 } = {}) {
    if (typeof this.client?.getHistoryPositions !== 'function') return null;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      try {
        const history = await this.client.getHistoryPositions(CONFIG.symbol);
        if (Array.isArray(history)) {
          const row = history.find(item => String(item.positionId) === String(positionId));
          if (row) return row;
        }
      } catch {
        // A failed lookup is not a reason to abandon the rest of the attempts.
      }
      // The position has already vanished from the pending list, but
      // get_history_positions is updated by the exchange asynchronously. One
      // lookup fired the instant the close was noticed therefore raced it, and
      // the close was reported as "Exit: -" with no realized PnL and no ROI —
      // permanently, because the notification is sent once and never revised.
      // Retrying briefly lets the exchange's own record catch up.
      if (attempt < Math.max(1, attempts) - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
    return null;
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
