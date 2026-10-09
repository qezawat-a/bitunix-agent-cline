import { atr as calculateAtr } from '../bitunix/indicators.js';
import { maintenanceMarginCheck } from '../bitunix/tiers.js';
import {
  accountPnlSummary,
  atrMultiples,
  buildPartialLadder,
  evaluateTrailingCallback,
  finitePositive,
  formatPrice,
  formatQty,
  normalizeMethod,
} from './tpsl.js';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Are two prices the same level, allowing for them having been written at
// different quotePrecisions? One tick of tolerance at `precision` decimals is
// enough: the stop is re-derived from the entry price every time, and the entry
// price is identical for the life of a position, so anything wider would start
// treating a genuinely different level as "the same one".
function samePrice(a, b, precision) {
  const left = finiteNumber(a);
  const right = finiteNumber(b);
  if (left === null || right === null) return false;
  const digits = Number.isInteger(Number(precision)) && Number(precision) >= 0 ? Number(precision) : 8;
  return Math.abs(left - right) <= 10 ** -digits;
}
// The size a pending TP/SL row will close: the take-profit side if it has one,
// otherwise the stop side. Returns null when the row carries no quantity at all,
// which is what a position-level pair looks like.
function legQuantity(row) {
  for (const value of [row?.tpQty, row?.slQty]) {
    const number = finiteNumber(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}

const positionQtyOf = (position) => position?.qty ?? position?.size ?? null;

// A position's size is a magnitude. get_pending_positions documents `qty` only
// as "position amount", and the exchange reports a short with a negative or
// side-signed quantity depending on the endpoint, while a TP/SL row's
// tpQty/slQty is always a positive base-coin amount. Comparing the two as raw
// signed numbers made every short position look like a partial ladder leg, so
// its position-level TP/SL row was thrown away and currentStop() reported "no
// stop at all" — which is what made break-even keep re-firing on shorts.
function positionMagnitude(position) {
  const raw = finiteNumber(positionQtyOf(position));
  return raw === null ? null : Math.abs(raw);
}

export class PositionManager {
  client;
  settings;
  state = { positions: [], lastManage: 0, lastGuard: 0, cooldownUntil: 0 };
  fetchInFlight = null;
  protectionAttempts = new Map();
  // Method 3 (trailing): { peak, armed, activatedAt } per positionId. The peak
  // only means something while the position is open, so entries are dropped as
  // soon as the position disappears from getPendingPositions.
  trailingState = new Map();
  // Method 4 (account): a fired guard must not re-send close-all on the next
  // mid-manage tick while the exchange is still settling the closes.
  accountGuardFiredAt = 0;
  // Position ids closed during the current midManage tick. A position closed by
  // the liquidation guard must not also be closed by the trailing callback in
  // the same tick: Bitunix rejects the repeat with 30042 Client ID duplicate.
  closedThisCycle = new Set();
  // Every position id closed by ANY guard path, with the time it happened.
  //
  // `closedThisCycle` is reset at the top of every midManage tick, which is what
  // lets a legitimately reopened id close again. But Trader.guard() runs the same
  // two liquidation guards on the tick immediately before midManage() (see
  // scanCycle), so a position the guard had already closed was still open in the
  // exchange's eyes when midManage wiped the record and then closed it a second
  // time with the same clientId -> 30042 Client ID duplicate.
  //
  // This second record survives the per-tick reset for as long as a repeat close
  // is actually unsafe. closePosition always reuses clientId
  // "jrock-close-<positionId>", so ANY second close of the same positionId is
  // guaranteed to be rejected with 30042 Client ID duplicate. The record is held
  // until the id stops being listed as open — a genuinely reopened position
  // carries a new positionId, so it is free to close on its very first tick —
  // with the timeout as a backstop for a close that never registered.
  closedRecently = new Map();
  static CLOSE_DEDUPE_MS = 60000;
  // When break-even was last applied to a position, and at which stop price.
  //
  // checkBreakeven could re-fire forever on a position it had already fixed. It
  // decides by asking the exchange where the stop is (currentStop), and every
  // answer it could get back failed to confirm the move it had just made:
  // the pending-row lookup missed the row, or the tick cache had been reset, so
  // `current` came back null or still below the entry. It then re-sent the same
  // "Break-even stop SL -> <entry>" modify and re-announced it — which is what
  // produced a chat full of identical "SL -> 0.075" lines every manage tick.
  //
  // Remembering the applied move makes the step idempotent: once this position's
  // stop has been put at its entry it is at break-even, and re-sending the same
  // modify cannot improve on that. If the stop is later genuinely lost, the
  // ensureProtection/repair path re-arms it, which clears the marker.
  breakEvenApplied = new Map();
  // Stops the exchange refused to move: positionId -> { side, slPrice }. The bot
  // enforces them itself (checkSoftStop) until a move is finally confirmed.
  softStops = new Map();
  // Pause before each read-back when confirming a stop move (ms). Static so a
  // test can shorten it.
  static STOP_VERIFY_DELAY_MS = 1000;
  // Pending TP/SL rows for the current tick, keyed by positionId. Fetched at
  // most once per tick and reset by resetTpslCache(), so the whole manage pass
  // sees one consistent view of what the exchange actually has armed.
  tpslCache = null;
  // Live TP/SL state pushed on the private `tpsl` WebSocket channel, keyed by
  // positionId.
  //
  // The REST pending list is a snapshot, and after we move a stop ourselves it
  // does not necessarily reflect the move on the very next tick. That gap is
  // exactly what made break-even look like it had never worked: currentStop()
  // read the pre-move level, concluded the stop was not at the entry, and
  // re-sent the same modify — every tick, forever.
  //
  // The private channel is the exchange's own confirmation and it is pushed
  // automatically after login, so it is used as the authority for "what stop
  // is armed right now" and the REST list is the fallback for anything the
  // channel has not covered yet (notably the first tick after a restart).
  // https://www.bitunix.com/api-docs/futures/websocket/private/Tp%20Sl%20Channel.html
  wsTpsl = new Map();
  // Positions the channel has explicitly reported as no longer armed. Kept
  // apart from wsTpsl so the REST snapshot's stale row for them is dropped:
  // if the stop was cancelled on the exchange, the pending list we fetched a
  // moment earlier still lists it, and treating that as protection is what left
  // positions reporting a stop the exchange no longer had.
  wsTpslDisarmed = new Set();
  tpslCacheInFlight = null;

  constructor(client, _symbol, settings) {
    this.client = client;
    this.settings = settings;
  }

  // Optional observer for the position lifecycle. Main.js sets this to the
  // Telegram notifier; tests leave it unset. Every close below records its
  // reason first, so the notification can say *why* a position went away
  // instead of only that it did.
  notifier = null;

  noteClose(positionId, reason) {
    try {
      this.notifier?.noteClose?.(positionId, reason);
    } catch {
      // A notification hook must never be able to break a live close.
    }
  }

  // Stop-move notifications are advisory, so a failure here must never abort
  // the manage tick that just moved a stop on the exchange.
  reportStopMove(position, action, price) {
    try {
      this.notifier?.reportStopMove?.(position, action, price);
    } catch (error) {
      console.error('[notify] stop-move report failed:', error.message);
    }
  }

  get symbol() {
    return this.settings.symbol;
  }

  // Which of the four Bitunix TP/SL methods protects a position right now.
  activeMethod() {
    return normalizeMethod(this.settings.tpsl_method);
  }

  async fetchMarkPrice(symbol) {
    if (typeof this.client.getTickers !== 'function') return null;
    try {
      const data = await this.client.getTickers(symbol);
      const ticker = Array.isArray(data) ? data[0] : data;
      const value = Number(ticker?.markPrice ?? ticker?.lastPrice ?? ticker?.price);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  async fetchPositions() {
    if (this.fetchInFlight) return this.fetchInFlight;
    const symbol = this.symbol;
    this.fetchInFlight = (async () => {
      const data = await this.client.getPendingPositions(symbol);
      if (!Array.isArray(data)) throw new Error('Bitunix positions response must be an array');
      if (symbol !== this.symbol) throw new Error('symbol changed while positions were being fetched');
      const normalized = data
        .filter(position => String(position.symbol || '').toUpperCase() === String(symbol).toUpperCase())
        .map(position => ({
          ...position,
          avgPrice: position.avgPrice ?? position.avgOpenPrice,
          openTime: position.openTime ?? position.ctime,
          side: position.side === 'LONG' ? 'BUY' : position.side === 'SHORT' ? 'SELL' : position.side,
          markPrice: position.markPrice ?? position.lastPrice,
        }));
      if (normalized.some(position => !finitePositive(position.markPrice))) {
        const markPrice = await this.fetchMarkPrice(symbol);
        if (markPrice) for (const position of normalized) {
          if (!finitePositive(position.markPrice)) position.markPrice = markPrice;
        }
      }
      this.state.positions = normalized;
      // A trailing peak only means something while its position is open;
      // keeping a stale peak would arm a future position against old history.
      const live = new Set(normalized.map(position => String(position.positionId)));
      for (const key of this.trailingState.keys()) {
        if (!live.has(key)) this.trailingState.delete(key);
      }
      // Same reasoning for the break-even marker: a positionId that later
      // reappears is a different position and must earn its own break-even.
      for (const key of this.breakEvenApplied.keys()) {
        if (!live.has(key)) this.breakEvenApplied.delete(key);
      }
      // The pushed TP/SL rows belong to positions that are still open. A
      // positionId that later reappears is a different position with a different
      // pair, so carrying the old row over would report a stop that was never
      // armed for it.
      for (const key of this.wsTpsl.keys()) {
        if (!live.has(key)) this.wsTpsl.delete(key);
      }
      for (const key of this.wsTpslDisarmed) {
        if (!live.has(key)) this.wsTpslDisarmed.delete(key);
      }
      for (const [key, at] of this.closedRecently) {
        // Dropped as soon as the id stops being listed (a genuinely reopened
        // position carries a new id, so it is free to close immediately), with
        // the timeout as a backstop for a close that never registered.
        if (!live.has(key) || Date.now() - at >= PositionManager.CLOSE_DEDUPE_MS) this.closedRecently.delete(key);
      }
      return this.state.positions;
    })();
    try {
      return await this.fetchInFlight;
    } finally {
      this.fetchInFlight = null;
    }
  }

  getAtr(entryPrice, atr) {
    if (!finitePositive(entryPrice)) throw new Error('entryPrice must be positive');
    if (!finitePositive(atr)) throw new Error('ATR is required for dynamic TP/SL; refusing a static fallback');
    return Number(atr);
  }

  resetTpslCache() {
    this.tpslCache = null;
    this.tpslCacheInFlight = null;
  }

  // Apply one private `tpsl` push to the live stop state.
  //
  // The channel pushes `data` as an object with `event` CREATE/UPDATE/CLOSE and
  // `status` NEW/CANCELED/SYSTEM_CANCELED/FILLED/FAILED, and the docs are
  // explicit that "CLOSE alone is not a final state — always read event
  // together with status": a CLOSE carrying CANCELED/SYSTEM_CANCELED/FILLED/
  // FAILED all mean the protection is GONE, and only a CREATE or UPDATE with
  // status NEW means it is armed. Reading `event` alone therefore treated a
  // cancelled break-even stop as still armed, and the position was reported as
  // protected while it was naked.
  //
  // On CREATE/UPDATE + NEW the row is merged, which is what makes the stop we
  // just moved visible to the very next check and ends the re-fire loop.
  applyTpslPrivateEvent(data) {
    if (!data || typeof data !== 'object') return null;
    const key = String(data.positionId ?? '');
    if (!key) return null;
    const status = String(data.status ?? '').toUpperCase();
    const event = String(data.event ?? '').toUpperCase();
    const armed = status === 'NEW';
    const gone = !armed;
    if (!armed) {
      // A FAILED trigger is worth surfacing: the position is now unprotected.
      if (status === 'FAILED') console.error('TP/SL private event failed:', key, data.orderId ?? '');
      this.wsTpsl.delete(key);
      this.wsTpslDisarmed.add(key);
      // The position was disarmed, so any "we already moved this stop" marker
      // is stale and must not suppress re-arming.
      if (this.breakEvenApplied.has(key)) this.breakEvenApplied.delete(key);
      return { positionId: key, armed: false, status, event };
    }
    const row = {
      id: data.orderId,
      positionId: key,
      symbol: data.symbol,
      tpPrice: data.tpPrice,
      slPrice: data.slPrice,
      tpQty: data.tpQty,
      slQty: data.slQty,
      tpStopType: data.tpStopType,
      slStopType: data.slStopType,
    };
    this.wsTpsl.set(key, row);
    this.wsTpslDisarmed.delete(key);
    return { positionId: key, armed: true, status, event, row };
  }

  // Where a live take-profit and stop are visible: PositionPendingResp carries no
  // slPrice/tpPrice (see docs/api-parity.md discrepancy 7), so a stop read off
  // the position object is always null. Every "is this position already
  // protected / how far is the stop" question has to be answered from here,
  // once per tick.
  //
  // The private `tpsl` channel is layered over the REST snapshot: for any
  // position the exchange has pushed about, the pushed row is newer than the
  // list we fetched, and it is what reflects the stop move we just sent. Only
  // positions the channel has never mentioned keep their REST row, so a restart
  // (no pushes yet) still behaves exactly as before.
  async loadPendingTPSL() {
    if (this.tpslCache) return this.tpslCache;
    if (this.tpslCacheInFlight) return this.tpslCacheInFlight;
    if (typeof this.client.getPendingTPSL !== 'function') return [];
    this.tpslCacheInFlight = (async () => {
      const pending = await this.client.getPendingTPSL(this.symbol);
      if (!Array.isArray(pending)) throw new Error('pending TP/SL response must be an array');
      return pending;
    })();
    try {
      this.tpslCache = await this.tpslCacheInFlight;
      // Nothing pushed yet at all (e.g. the first tick after a restart): the
      // snapshot is all there is.
      if (!this.wsTpsl.size && !this.wsTpslDisarmed.size) return this.tpslCache;
      // Overlay: the channel wins for the positions it knows about, the REST
      // rows for everything else. A position the channel reported as gone is
      // absent from wsTpsl but was seen, so its REST row is dropped too.
      const seen = new Set([...this.wsTpsl.keys(), ...this.wsTpslDisarmed]);
      const merged = this.tpslCache
        .filter(row => !seen.has(String(row?.positionId)))
        // Spread, not concat: concat() only flattens arrays, so passing the Map
        // iterator directly appended the iterator itself as a single bogus row.
        .concat([...this.wsTpsl.values()]);
      this.tpslCache = merged;
      return this.tpslCache;
    } finally {
      this.tpslCacheInFlight = null;
    }
  }

  // True for an order-level row that only closes part of the position, i.e. one
  // of the legs placeTPSLOrder created (method 2).
  //
  // Both kinds of row come back from the SAME pending endpoint, so a carried
  // quantity cannot be read as "this is a leg" on its own: a position-level
  // pair carries tpQty/slQty too, set to the whole position it will close. A
  // live long (qty 5.86, take-profit and stop at the entry) was therefore
  // classified as a ladder leg, positionTPSL() matched nothing and returned
  // null, and currentStop() saw no stop at all. The "already at break-even"
  // check could never match, so break-even re-fired on every manage tick and
  // re-sent the same "Break-even stop SL -> entry" the position had reached
  // minutes earlier.
  //
  // Size is what separates them: a leg closes less than the position, a
  // position-level row covers all of it. A row carrying no quantity at all is
  // position-level, since placePositionTPSL has no quantity parameter.
  isPartialLeg(row, positionQty = null) {
    const leg = legQuantity(row);
    if (leg === null) return false;
    // Compare magnitudes: a row's tpQty/slQty is a positive base-coin amount and
    // a position's qty may be side-signed, so the raw numbers are not on the
    // same scale. See positionMagnitude().
    const raw = finiteNumber(positionQty);
    const total = raw === null ? null : Math.abs(raw);
    // With no position size to compare against there is nothing to go on, so
    // keep the conservative reading and treat a quantity as a ladder leg.
    if (total === null || total <= 0) return true;
    // The tolerance covers the exchange rounding the quantity to its own
    // precision: the position-level row and the position are the same number
    // written at different precisions, not two different closes.
    return leg < total * 0.999;
  }

  // The position-level TP/SL row for a position, i.e. the all-in/all-out pair
  // placeTPSL/modifyTPSL own. Partial (method 2) legs are order-level rows
  // carrying tpQty/slQty and are deliberately not matched here: they are moved
  // through modifyTPSLOrder keyed by their own id, never by positionId.
  async positionTPSL(positionId, positionQty = null) {
    const key = String(positionId);
    const pending = await this.loadPendingTPSL();
    return pending.find(item => (
      String(item.positionId) === key
      && !this.isPartialLeg(item, positionQty)
    )) || null;
  }

  // What the exchange has actually armed for a position, reported as two
  // independent facts.
  //
  // They have to stay separate. ensureProtection() used to ask "is there a
  // stop?" and treat that as "this position is protected", so a position that
  // carried a stop-loss but no take-profit was skipped on every manage tick and
  // never got a target — it simply had no exit that earned money, only one that
  // capped the loss. `row` is the position-level pair (what modifyTPSL owns);
  // `rows` also includes the order-level rows a partial ladder is made of.
  async protectionLevels(position) {
    const key = String(position.positionId);
    const pending = await this.loadPendingTPSL();
    const rows = pending.filter(item => String(item?.positionId) === key);
    const positionTp = Number(position.tpPrice ?? position.takeProfitPrice);
    const positionSl = Number(position.slPrice ?? position.stopPrice ?? position.stopLossPrice);
    return {
      tp: finitePositive(positionTp) || rows.some(item => finitePositive(item.tpPrice)),
      sl: finitePositive(positionSl) || rows.some(item => finitePositive(item.slPrice ?? item.stopPrice)),
      row: rows.find(item => !this.isPartialLeg(item, positionMagnitude(position))) || null,
      rows,
    };
  }

  // Write a just-moved stop back into the tick cache. Without this, a second
  // check in the same tick (break-even, then trailing) would still read the
  // pre-move stop and send a modify that moves the stop backwards.
  recordStopMove(positionId, params, positionQty = null) {
    if (!this.tpslCache || !finitePositive(Number(params?.slPrice))) return;
    const key = String(positionId);
    const match = item => (
      String(item.positionId) === key
      && !this.isPartialLeg(item, positionQty)
    );
    let index = this.tpslCache.findIndex(match);
    // No position-level row: fall back to the order-level rows carrying a stop.
    // Without this the stop we just wrote was invisible to the rest of the tick
    // (and to break-even on the next one), so currentStop() kept reporting the
    // pre-move level and the same break-even was re-sent every tick.
    if (index < 0) index = this.tpslCache.findIndex(item => String(item.positionId) === key && finitePositive(Number(item.slPrice ?? item.stopPrice)));
    if (index < 0) return;
    this.tpslCache[index] = { ...this.tpslCache[index], slPrice: params.slPrice, slStopType: params.slStopType };
  }

  // The pair's quotePrecision, needed to emit TP/SL prices the exchange will
  // accept. Cached because it never changes for a symbol, and an absent or
  // unreachable metadata source must not stop a position being protected — the
  // 8-decimal default is only used as a fallback.
  quotePrecisionCache = new Map();
  // `/position/get_position_tiers` is public and changes rarely, so the tiered
  // risk limit for a symbol is fetched at most once and reused.
  tiersCache = new Map();

  async getQuotePrecision(symbol = this.symbol) {
    const key = String(symbol || '').toUpperCase();
    if (this.quotePrecisionCache.has(key)) return this.quotePrecisionCache.get(key);
    let digits = 8;
    try {
      if (typeof this.client.getTradingPairs === 'function') {
        const pairs = await this.client.getTradingPairs(symbol);
        const pair = (Array.isArray(pairs) ? pairs : []).find(item => String(item?.symbol).toUpperCase() === key);
        const value = Number(pair?.quotePrecision);
        if (Number.isInteger(value) && value >= 0 && value <= 20) digits = value;
      }
    } catch {
      // Fall through to the default: an unprotected position is worse than a
      // price with more decimals than ideal.
    }
    this.quotePrecisionCache.set(key, digits);
    return digits;
  }

  // Tiered risk limit for the symbol, i.e. the negotiated value range / max
  // leverage / maintenance margin rate table behind Bitunix's liquidation
  // mechanism. Best-effort: an unreachable tiers endpoint must not stop a
  // position being protected, so a failure caches an empty list.
  // https://www.bitunix.com/api-docs/futures/position/get_position_tiers.html
  async getPositionTiers(symbol = this.symbol) {
    const key = String(symbol || '').toUpperCase();
    if (this.tiersCache.has(key)) return this.tiersCache.get(key);
    let tiers = [];
    try {
      if (typeof this.client.getPositionTiers === 'function') {
        const data = await this.client.getPositionTiers(key);
        if (Array.isArray(data)) tiers = data;
      }
    } catch {
      // Fall through to the empty list below; every consumer treats no tiers as
      // "cannot check", never as "safe".
    }
    this.tiersCache.set(key, tiers);
    return tiers;
  }

  computeTPSL(entryPrice, direction, atr, confidence, quotePrecision = 8) {
    if (!finitePositive(entryPrice)) throw new Error('entryPrice must be positive');
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('direction must be bullish or bearish');
    const normalizedConfidence = Math.max(0, Math.min(100, Number(confidence) || 0));
    // More confidence -> tighter stop and a slightly more ambitious target; ATR remains the only source of distance.
    // The multiples live in tpsl.js so the partial ladder's first step lands on
    // exactly this target.
    const { stopMultiple, targetMultiple } = atrMultiples(normalizedConfidence);
    const atrDist = this.getAtr(entryPrice, atr);
    const tpDist = atrDist * targetMultiple;
    const slDist = atrDist * stopMultiple;

    if (direction === 'bullish') {
      return {
        tpPrice: formatPrice(entryPrice + tpDist, quotePrecision),
        slPrice: formatPrice(entryPrice - slDist, quotePrecision),
        tpStopType: 'MARK_PRICE',
        slStopType: 'MARK_PRICE',
      };
    }
    return {
      tpPrice: formatPrice(entryPrice - tpDist, quotePrecision),
      slPrice: formatPrice(entryPrice + slDist, quotePrecision),
      tpStopType: 'MARK_PRICE',
      slStopType: 'MARK_PRICE',
    };
  }

  // Returns the position's ATR or throws with a message that includes the
  // fallbacks tried, so a silent failure can never hide trailing. The Position
  // Channel's `atr` is preferred (fresh, free of a round-trip), then 15m, then
  // 1h as a last resort for coins whose short tick is too thin.
  async getAtrForPosition(position) {
    if (finitePositive(position.atr)) return Number(position.atr);
    for (const timeframe of ['15m', '1h']) {
      const klines = await this.client.getKlines(position.symbol || this.symbol, timeframe, 60);
      if (klines.length < 15) continue;
      const highs = klines.map(k => Number(k.high));
      const lows = klines.map(k => Number(k.low));
      const closes = klines.map(k => Number(k.close));
      const value = calculateAtr(highs, lows, closes, 14);
      if (finitePositive(value)) return value;
    }
    throw new Error(`ATR unavailable for ${position.positionId} (position.atr missing, 15m and 1h series too short or invalid)`);
  }

  async placeTPSL(positionId, entryPrice, direction, atr, confidence) {
    const levels = this.computeTPSL(entryPrice, direction, atr, confidence, await this.getQuotePrecision());
    return this.client.placeTPSL({
      symbol: this.symbol,
      positionId,
      ...levels,
    });
  }

  // Method 2 (partial): the pure ladder. Each leg closes `fraction` of the
  // position at `roiSteps[i] x` the base ATR take-profit distance; `remainder`
  // keeps riding the stop.
  buildPartialTPSL(position, entryPrice, direction, atr, confidence, quotePrecision = 8) {
    return buildPartialLadder({
      position,
      entryPrice,
      direction,
      atr,
      confidence,
      quotePrecision,
      fractions: this.settings.partial_tp_fractions,
      steps: this.settings.partial_tp_roi_steps,
    });
  }

  // Method 2 (partial): place the ladder with the order-level endpoint, the
  // only TP/SL pair that carries tpQty/slQty and therefore the only one that
  // can close part of a position.
  async placePartialTPSL(position, entryPrice, direction, atr, confidence) {
    if (typeof this.client.placeTPSLOrder !== 'function') {
      throw new Error('partial TP/SL requires the order-level placeTPSLOrder endpoint');
    }
    const quotePrecision = await this.getQuotePrecision();
    const { legs, remainder } = this.buildPartialTPSL(position, entryPrice, direction, atr, confidence, quotePrecision);
    const levels = this.computeTPSL(entryPrice, direction, atr, confidence, quotePrecision);
    // SAFETY: place the furthest target first. A rejection part-way through then
    // leaves the far targets armed and every placed slice already carrying its
    // stop, so the un-placed remainder is never left naked. Near-first would risk
    // spending the position's best exit first and stranding the rest.
    const ordered = [...legs].sort((a, b) => Math.abs(b.tpPrice - entryPrice) - Math.abs(a.tpPrice - entryPrice));
    const placed = [];
    for (const leg of ordered) {
      const qty = formatQty(leg.qty);
      try {
        const result = await this.client.placeTPSLOrder({
          symbol: this.symbol,
          positionId: position.positionId,
          tpPrice: leg.tpPrice,
          tpOrderType: leg.tpOrderType,
          tpStopType: leg.tpStopType,
          tpQty: qty,
          // Every leg carries the same stop for its own slice, so a ladder that
          // never reaches a target still exits the whole position.
          slPrice: levels.slPrice,
          slOrderType: 'MARKET',
          slStopType: levels.slStopType,
          slQty: qty,
        });
        placed.push({ ...leg, slPrice: levels.slPrice, result });
      } catch (error) {
        return { placed, remainder, error: `partial TP/SL leg ${leg.index} rejected: ${error.message}` };
      }
    }
    // The remainder gets no take-profit leg of its own, so it needs a stop of
    // its own: placed last, after every target is already armed, and only when
    // the fractions did not consume the whole position.
    if (remainder > 0) {
      try {
        const result = await this.client.placeTPSLOrder({
          symbol: this.symbol,
          positionId: position.positionId,
          slPrice: levels.slPrice,
          slOrderType: 'MARKET',
          slStopType: levels.slStopType,
          slQty: formatQty(remainder),
        });
        placed.push({ index: 'remainder', fraction: null, qty: remainder, slPrice: levels.slPrice, result });
      } catch (error) {
        return { placed, remainder, error: `partial TP/SL remainder stop rejected: ${error.message}` };
      }
    }
    return { placed, remainder };
  }

  // Methods 3 (trailing) and 4 (account) do not exit on a fixed per-position
  // target: the trailing callback and the account PnL threshold own the exit.
  // They still get the ATR stop as the hard backstop, because "at least one of
  // tpPrice or slPrice is required" and a position with no stop at all is never
  // acceptable.
  // https://www.bitunix.com/api-docs/futures/tp_sl/place_position_tp_sl_order.html
  async placeTPSLStop(positionId, entryPrice, direction, atr, confidence) {
    const { slPrice, slStopType } = this.computeTPSL(entryPrice, direction, atr, confidence, await this.getQuotePrecision());
    return this.client.placeTPSL({
      symbol: this.symbol,
      positionId,
      slPrice,
      slStopType,
    });
  }

  // One half of the TP/SL pair is live and the other is missing. modifyTPSL
  // replaces the whole pair, so the live half is read back and resent with it —
  // otherwise adding the take-profit would delete the stop, which is the same
  // class of bug that made break-even wipe the TP on every tick.
  async repairProtection(position, entryPrice, direction, atr, confidence, armed) {
    const quotePrecision = await this.getQuotePrecision();
    const levels = this.computeTPSL(entryPrice, direction, atr, confidence, quotePrecision);
    const existing = armed.row;
    // Both halves are always sent: the live one verbatim, the missing one
    // computed. modifyTPSL takes no delta — it replaces the pair — so sending
    // only the missing half is the same bug as sending none.
    const params = {
      symbol: this.symbol,
      positionId: position.positionId,
      tpPrice: armed.tp && existing && finitePositive(existing.tpPrice) ? String(existing.tpPrice) : levels.tpPrice,
      tpStopType: (existing && existing.tpStopType) || levels.tpStopType,
      slPrice: armed.sl && existing && finitePositive(existing.slPrice) ? String(existing.slPrice) : levels.slPrice,
      slStopType: (existing && existing.slStopType) || levels.slStopType,
    };
    if (existing?.tpOrderType) params.tpOrderType = existing.tpOrderType;
    const result = await this.client.modifyTPSL(params);
    // The tick cache still describes the half-armed pair we just replaced.
    this.resetTpslCache();
    return result;
  }

  favorableRoiPct(position) {
    const entry = Number(position.avgPrice);
    const mark = Number(position.markPrice);
    if (!finitePositive(entry) || !finitePositive(mark)) throw new Error('position entry and mark prices must be positive');
    const direction = position.side === 'BUY' ? 1 : position.side === 'SELL' ? -1 : 0;
    if (!direction) throw new Error('position side must be BUY or SELL');
    // PositionPendingResp carries its OWN `leverage` (int32), and that is the
    // number the exchange applies to this position's margin and PnL. Measuring
    // the position's ROI against the globally configured leverage instead meant
    // every break-even / trailing / account threshold fired at the wrong price
    // whenever the two ever disagreed — e.g. after a manual change_leverage, or
    // a tier that forces a lower leverage than the setting.
    // https://www.bitunix.com/api-docs/futures/position/get_pending_positions.html
    const leverage = finitePositive(position.leverage)
      ? Number(position.leverage)
      : finitePositive(this.settings.leverage) ? Number(this.settings.leverage) : 1;
    return ((mark - entry) / entry) * 100 * direction * leverage;
  }

  // Resolves the position's live stop price, falling back to the pending TP/SL
  // list because the position payload itself never carries slPrice. Returns
  // null when the exchange has no stop armed for the position.
  async currentStop(position) {
    const value = position.slPrice ?? position.stopPrice ?? position.stopLossPrice;
    const stop = Number(value);
    if (finitePositive(stop)) return stop;
    // The most protective stop among ALL of the position's rows (an order-level
    // stop and a position-level one can coexist), not whichever came first.
    const key = String(position.positionId);
    const stops = (await this.loadPendingTPSL())
      .filter(item => String(item?.positionId) === key)
      .map(item => Number(item?.slPrice ?? item?.stopPrice))
      .filter(finitePositive);
    if (stops.length) return position.side === 'SELL' ? Math.min(...stops) : Math.max(...stops);
    const tpsl = await this.positionTPSL(position.positionId, positionMagnitude(position));
    const pendingStop = Number(tpsl?.slPrice ?? tpsl?.stopPrice);
    return finitePositive(pendingStop) ? pendingStop : null;
  }

  // The take-profit half to carry along with a stop-only modify, as params to
  // merge into the request.
  //
  // /tpsl/position/modify_order replaces the WHOLE pair (PlacePositionTpslOrderRequest
  // is its own request shape), so an omitted tpPrice deletes the live
  // take-profit. The old code read the pair back from positionTPSL(), which
  // deliberately ignores order-level rows — so on a position whose protection
  // was an order-level row (a partial ladder, or a pair the bot placed while the
  // position payload disagreed about its size) the lookup missed, no tpPrice
  // was sent, and every break-even / trailing step silently deleted the
  // take-profit. ensureProtection then re-armed it on the next tick, and the
  // cycle repeated for the whole life of the trade.
  //
  // Every row for the position is searched instead, so a take-profit is never
  // dropped just because the row carrying it is an order-level one.
  async preserveTakeProfit(positionId, positionQty = null) {
    const key = String(positionId);
    const pending = await this.loadPendingTPSL();
    const rows = pending.filter(item => String(item?.positionId) === key && finitePositive(Number(item?.tpPrice)));
    if (!rows.length) return {};
    // Prefer the position-level row (the one this endpoint owns), then fall back
    // to whichever armed target is furthest along.
    const positionLevel = rows.find(item => !this.isPartialLeg(item, positionQty));
    const row = positionLevel || rows[0];
    const preserved = { tpPrice: String(row.tpPrice) };
    if (row.tpStopType) preserved.tpStopType = row.tpStopType;
    if (row.tpOrderType) preserved.tpOrderType = row.tpOrderType;
    return preserved;
  }

  // `current` is passed in rather than defaulted to currentStop(position),
  // because currentStop is async — a default parameter would compare against a
  // Promise (always truthy) instead of the real stop price.
  shouldTighten(position, candidate, current = null) {
    if (!current) return true;
    return position.side === 'BUY' ? candidate > current : candidate < current;
  }

  // ---- confirmed stop moves ------------------------------------------------
  //
  // The entry order carries its stop attached (placeOrder slPrice). That is an
  // ORDER-level TP/SL row with its own id. /tpsl/position/modify_order answers
  // code 0 for it and changes nothing, so the old code "moved" the stop, wrote
  // the wanted price into its own cache, remembered break-even as applied, and
  // the real stop sat untouched while the position round-tripped into a loss.
  //
  // A move now counts only when a FRESH read of the exchange shows the stop at
  // the wanted level. Order of attack: the position-level modify, then
  // modify_order by the stop row's own id, then ADD a full-size stop. The old
  // stop is never cancelled first, so a failed swap cannot leave a position
  // naked. If nothing sticks it throws (so break-even is retried, not recorded)
  // and arms a software stop that checkSoftStop enforces.
  async readPositionStops(positionId) {
    const rows = await this.client.getPendingTPSL(this.symbol, { positionId: String(positionId) });
    const key = String(positionId);
    return (Array.isArray(rows) ? rows : []).filter(item => String(item?.positionId) === key);
  }

  stopReached(rows, wanted, side) {
    const stops = rows
      .map(item => Number(item?.slPrice ?? item?.stopPrice))
      .filter(finitePositive);
    if (!stops.length) return false;
    const tolerance = Math.abs(wanted) * 1e-4;
    if (side === 'BUY') return Math.max(...stops) >= wanted - tolerance;
    if (side === 'SELL') return Math.min(...stops) <= wanted + tolerance;
    return stops.some(stop => Math.abs(stop - wanted) <= tolerance);
  }

  async confirmStop(positionId, wanted, side, attempts = 3) {
    let last = [];
    for (let i = 0; i < attempts; i += 1) {
      if (PositionManager.STOP_VERIFY_DELAY_MS > 0) await new Promise(r => setTimeout(r, PositionManager.STOP_VERIFY_DELAY_MS));
      try {
        last = await this.readPositionStops(positionId);
      } catch {
        continue;
      }
      if (this.stopReached(last, wanted, side)) return { ok: true, rows: last };
    }
    return { ok: false, rows: last };
  }

  async confirmedStopMove(params, positionId, positionQty = null, side = null) {
    const key = String(positionId);
    const wanted = Number(params.slPrice);
    const quotePrecision = await this.getQuotePrecision();
    const done = (via, rows, result) => {
      // The cache now mirrors what the exchange reported, not what we hoped for.
      if (Array.isArray(this.tpslCache)) {
        this.tpslCache = this.tpslCache.filter(item => String(item?.positionId) !== key).concat(rows);
      }
      this.softStops.delete(key);
      return { ...(result && typeof result === 'object' ? result : {}), via };
    };
    let lastRows = [];
    let error = null;

    // 1) position-level modify
    try {
      const result = await this.client.modifyTPSL(params);
      const check = await this.confirmStop(positionId, wanted, side);
      if (check.ok) return done('position-modify', check.rows, result);
      lastRows = check.rows;
    } catch (e) { error = e; }

    // 2) modify the stop row by its own orderId
    if (typeof this.client.modifyTPSLOrder === 'function') {
      try {
        const rows = lastRows.length ? lastRows : await this.readPositionStops(positionId).catch(() => []);
        const row = rows.find(item => finitePositive(Number(item?.slPrice ?? item?.stopPrice))) || rows[0];
        const id = row?.id ?? row?.orderId;
        const qty = legQuantity(row) ?? positionQty;
        if (id !== undefined && id !== null && finitePositive(Number(qty))) {
          const body = {
            orderId: String(id),
            slPrice: params.slPrice,
            slStopType: 'MARK_PRICE',
            slOrderType: 'MARKET',
            slQty: String(row?.slQty ?? qty),
          };
          const tp = Number(row?.tpPrice ?? params.tpPrice);
          if (finitePositive(tp)) {
            Object.assign(body, { tpPrice: String(tp), tpStopType: 'MARK_PRICE', tpOrderType: 'MARKET', tpQty: String(row?.tpQty ?? qty) });
          }
          const result = await this.client.modifyTPSLOrder(body);
          const check = await this.confirmStop(positionId, wanted, side);
          if (check.ok) return done('order-modify', check.rows, result);
          lastRows = check.rows;
        }
      } catch (e) { error = e; }
    }

    // 3) add a full-size stop next to the old one; never cancel first
    if (typeof this.client.placeTPSLOrder === 'function' && finitePositive(Number(positionQty))) {
      try {
        const result = await this.client.placeTPSLOrder({
          symbol: this.symbol,
          positionId: key,
          slPrice: params.slPrice,
          slStopType: 'MARK_PRICE',
          slOrderType: 'MARKET',
          slQty: String(positionQty),
        });
        const check = await this.confirmStop(positionId, wanted, side);
        if (check.ok) return done('added-stop', check.rows, result);
      } catch (e) { error = e; }
    }

    // Nothing stuck: hold the line in software and make the caller retry.
    if (side === 'BUY' || side === 'SELL') this.softStops.set(key, { side, slPrice: wanted });
    throw new Error(`stop move to ${params.slPrice} not confirmed by the exchange${error ? ` (${error.message})` : ''}; software stop armed`);
  }

  // Enforces a stop the exchange would not take. Cleared the moment a move is
  // confirmed (see confirmedStopMove) or the position is gone.
  async checkSoftStop(position) {
    const key = String(position.positionId);
    const soft = this.softStops.get(key);
    if (!soft) return null;
    const mark = Number(position.markPrice);
    if (!finitePositive(mark)) return null;
    const crossed = soft.side === 'BUY' ? mark <= soft.slPrice : mark >= soft.slPrice;
    if (!crossed) return null;
    const result = await this.emergencyClose(position, 'software_stop');
    if (result?.closed) this.softStops.delete(key);
    return result;
  }

  async checkBreakeven(position) {
    const entry = Number(position.avgPrice);
    if (!finitePositive(entry)) throw new Error('position entry price must be positive');
    const key = String(position.positionId);
    // Idempotency. Once this position's stop has been moved to its entry price it
    // IS at break-even, so re-sending the identical modify is pure noise and the
    // re-announcement is worse: the operator saw the same "SL -> <entry>" line
    // once per manage tick for as long as the trade stayed open, because the
    // "where is the stop now?" lookup kept failing to see the move we had just
    // made. A tolerance is used so the same entry price re-sent at a different
    // quotePrecision is still recognised as the same level.
    const applied = this.breakEvenApplied.get(key);
    if (applied && samePrice(applied.slPrice, entry, applied.precision)) {
      return { skipped: 'break-even already applied', slPrice: String(applied.slPrice) };
    }
    if (this.favorableRoiPct(position) >= Number(this.settings.breakeven_threshold_pct)) {
      const current = await this.currentStop(position);
      if (current && position.side === 'BUY' && entry <= current) return { skipped: 'stop already favorable' };
      if (current && position.side === 'SELL' && entry >= current) return { skipped: 'stop already favorable' };
      const result = await this.moveSLToEntry(position.positionId, entry, positionMagnitude(position), position.side);
      // Recorded only once the move actually reached the exchange, so a failed
      // modify is retried on the next tick rather than being remembered as done.
      this.breakEvenApplied.set(key, { slPrice: entry, precision: await this.getQuotePrecision() });
      this.reportStopMove?.(position, 'breakeven', entry);
      return { ...result, slPrice: formatPrice(entry) };
    }
    return { skipped: 'threshold not reached' };
  }

  async moveSLToEntry(positionId, entryPrice, positionQty = null, side = null) {
    const quotePrecision = await this.getQuotePrecision();
    // /tpsl/position/modify_order takes only symbol, positionId, the tp*/sl*
    // trigger prices and their stop types — the trigger's order type is not a
    // parameter here, so it is not sent.
    // https://www.bitunix.com/api-docs/futures/tp_sl/modify_position_tp_sl_order.html
    //
    // IMPORTANT: this endpoint takes the SAME request shape as place_order
    // (PlacePositionTpslOrderRequest, per docs/api-parity.md). It replaces the
    // whole pair, so an omitted tpPrice DELETES the live take-profit — which is
    // what made break-even silently wipe the TP, and kept wiping it on every
    // tick because the stop read came from a field the position payload does
    // not have. The existing take-profit is therefore read back and resent
    // alongside the new stop, so only the stop moves.
    const existing = await this.preserveTakeProfit(positionId, positionQty);
    const params = {
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(entryPrice, quotePrecision),
      slStopType: 'MARK_PRICE',
    };
    Object.assign(params, existing);
    return this.confirmedStopMove(params, positionId, positionQty, side);
  }

  async checkTrailing(position) {
    const mark = Number(position.markPrice);
    if (!finitePositive(mark)) throw new Error('position mark price must be positive');
    if (this.favorableRoiPct(position) >= Number(this.settings.trailing_trigger_roi_pct)) {
      const atr = await this.getAtrForPosition(position);
      const strength = Math.max(0, Math.min(100, Number(position.signalConfidence ?? this.settings.min_confidence))) / 100;
      const multiple = Number(this.settings.trailing_atr_multiple) || 1.25;
      const reduction = Number(this.settings.trailing_atr_strength_reduction) || 0.25;
      const trailDistance = atr * (multiple - strength * reduction);
      const newSL = position.side === 'BUY' ? mark - trailDistance : mark + trailDistance;
      const current = await this.currentStop(position);
      if (!finitePositive(newSL) || !this.shouldTighten(position, newSL, current)) return { skipped: 'trailing would loosen stop' };
      const result = await this.updateTrailingSL(position.positionId, newSL, positionMagnitude(position), position.side);
      this.reportStopMove?.(position, 'trailing', newSL);
      return { ...result, slPrice: formatPrice(newSL, await this.getQuotePrecision()) };
    }
    return { skipped: 'threshold not reached' };
  }

  async updateTrailingSL(positionId, newSL, positionQty = null, side = null) {
    // See moveSLToEntry: no slOrderType — it is not a documented parameter of
    // /tpsl/position/modify_order.
    // The existing take-profit is carried forward for the same reason as in
    // moveSLToEntry: this endpoint replaces the pair, so omitting tpPrice would
    // delete the live take-profit on every trailing step.
    const existing = await this.preserveTakeProfit(positionId, positionQty);
    const params = {
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(newSL, await this.getQuotePrecision()),
      slStopType: 'MARK_PRICE',
    };
    Object.assign(params, existing);
    return this.confirmedStopMove(params, positionId, positionQty, side);
  }

  // Method 3 (trailing). The exchange has no server-side "peak minus a
  // callback" trigger, so the peak is tracked here: arm at
  // trailing_trigger_roi_pct (the article's activation price), follow the
  // favourable extreme, and close the position once the mark retraces
  // trailing_callback_pct from that peak. Shorts mirror it.
  async checkTrailingCallback(position) {
    if (this.activeMethod() !== 'trailing') return { skipped: 'trailing callback not the active method' };
    const key = String(position.positionId);
    const outcome = evaluateTrailingCallback({
      side: position.side,
      mark: Number(position.markPrice),
      favorableRoi: this.favorableRoiPct(position),
      triggerRoiPct: this.settings.trailing_trigger_roi_pct,
      callbackPct: this.settings.trailing_callback_pct,
      previous: this.trailingState.get(key) || null,
    });
    if (outcome.skipped) return outcome;
    this.trailingState.set(key, {
      peak: outcome.peak,
      armed: outcome.armed,
      activatedAt: outcome.armedNow ? Date.now() : outcome.activatedAt,
    });
    if (!outcome.triggered) return outcome;
    // The position is gone; keeping its peak would mis-arm a later position that
    // reuses the id.
    this.trailingState.delete(key);
    this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
    this.closedThisCycle.add(key);
    this.closedRecently.set(key, Date.now());
    this.noteClose(key, 'trailing_callback');
    const result = await this.client.closePosition(this.symbol, position.positionId, position);
    return { ...outcome, closed: true, result };
  }

  // Method 4 (account). One control unit for the whole account instead of
  // per-position triggers: when the aggregate unrealised PnL reaches either
  // threshold, every futures position on the symbol is closed.
  async checkAccountGuard() {
    const tpThreshold = Number(this.settings.account_tp_roi_pct) || 0;
    const slThreshold = Number(this.settings.account_sl_roi_pct) || 0;
    if (this.activeMethod() !== 'account') return { skipped: 'account guard not the active method' };
    if (tpThreshold <= 0 && slThreshold <= 0) return { skipped: 'account guard disabled' };
    if (typeof this.client.closeAllPosition !== 'function') return { skipped: 'close-all endpoint unavailable' };
    if (Date.now() - this.accountGuardFiredAt < 60000) return { skipped: 'account guard already fired' };
    const { totalPnl, totalMargin, roi } = accountPnlSummary(this.state.positions, this.settings.leverage);
    const triggered = (tpThreshold > 0 && roi >= tpThreshold) ? 'tp' : (slThreshold > 0 && roi <= -slThreshold) ? 'sl' : null;
    if (!triggered) return { skipped: 'account thresholds not reached', roi, totalPnl, totalMargin };
    this.accountGuardFiredAt = Date.now();
    this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
    // Label every position the account guard is about to close, so the exit
    // notifications distinguish an account-level exit from a per-position one.
    for (const position of this.state.positions) {
      this.noteClose(position.positionId, triggered === 'tp' ? 'account_tp' : 'account_sl');
    }
    // Method 4 is an ACCOUNT-level control unit, and the article is explicit
    // that it spans symbols: "A user holds BTC, ETH, and SOL futures positions
    // simultaneously ... the system automatically closes all futures positions
    // once the account's overall profit or loss reaches the predefined
    // threshold."
    // https://www.bitunix.com/hub/helpcenter/article/bitunix-futures-position-a-guide-to-four-take-profit-and-stop-loss-methods-web?id=290
    //
    // close_all_position takes `symbol` as an OPTIONAL filter (docs
    // https://www.bitunix.com/api-docs/futures/trade/close_all_position.html),
    // so omitting it is what closes every futures position on the account.
    // Passing this.symbol left the account guard reporting a full close while
    // only ever closing one pair.
    await this.client.closeAllPosition();
    // The peaks belonged to positions that no longer exist.
    this.trailingState.clear();
    return { triggered, roi, totalPnl, totalMargin };
  }

  async checkLiquidationGuard(position) {
    const mark = Number(position.markPrice);
    const liq = Number(position.liqPrice);
    if (!finitePositive(mark)) throw new Error('liquidation guard requires a mark price');
    if (position.liqPrice === undefined || position.liqPrice === null || position.liqPrice === '') throw new Error('liquidation guard requires a liquidation price');
    if (!Number.isFinite(liq) || liq <= 0) return { skipped: 'no active liquidation price' };
    const distance = Math.abs(mark - liq) / mark;
    if (distance >= Number(this.settings.sl_liquidation_safety) / 100) return { skipped: 'liquidation distance safe' };
    return this.emergencyClose(position, 'liquidation_guard');
  }

  // The tiered risk limit's own trigger, stated by the tiers endpoint verbatim:
  // "When the margin rate of a position is less than the maintenance margin
  // rate, it will trigger a forced partial liquidation or full liquidation."
  // The exchange is free to start reducing the position the moment this is
  // true, so the bot exits first rather than watching a cascading reduction.
  // Skipped (never assumed safe) when the tiers, the position value or the
  // margin rate are unavailable.
  async checkMaintenanceMargin(position) {
    const check = maintenanceMarginCheck(position, await this.getPositionTiers(position.symbol || this.symbol));
    if (!check.checked) return { skipped: check.reason };
    if (!check.breached) {
      return { skipped: 'margin rate above the maintenance requirement', marginRate: check.marginRate, maintenanceMarginRate: check.maintenanceMarginRate };
    }
    return {
      ...(await this.emergencyClose(position, 'maintenance_margin')),
      marginRate: check.marginRate,
      maintenanceMarginRate: check.maintenanceMarginRate,
      tier: check.tier,
    };
  }

  // A single exit path shared by the liquidation guards so a position can never
  // be closed twice in one tick (Bitunix answers the repeat with 30042).
  async emergencyClose(position, reason) {
    const key = String(position.positionId);
    if (this.closedThisCycle.has(key)) return { skipped: 'already closed this cycle' };
    // Also refuse a close the guard path already sent moments ago, even if a
    // midManage tick reset the per-tick record in between.
    const recent = this.closedRecently.get(key);
    if (recent !== undefined && Date.now() - recent < PositionManager.CLOSE_DEDUPE_MS) {
      return { skipped: 'already closed by an earlier guard this cycle', closedAt: recent };
    }
    this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
    // `closed: true` lets midManage stop working this position. Without it the
    // trailing callback below would close the same positionId again in the same
    // tick, and Bitunix answers the repeat with 30042 Client ID duplicate.
    this.noteClose(position.positionId, reason);
    const result = await this.client.closePosition(this.symbol, position.positionId, position);
    this.closedThisCycle.add(key);
    this.closedRecently.set(key, Date.now());
    return { closed: true, trigger: reason, result };
  }

  async ensureProtection(position) {
    const method = this.activeMethod();
    // Method dispatch comes first because it decides what "protected" means:
    // 'position' needs a take-profit AND a stop, 'partial' needs at least one
    // armed target plus a stop, and 'trailing'/'account' deliberately run on the
    // stop alone since the callback / account guard owns the exit.
    const armed = await this.protectionLevels(position);
    const needsTakeProfit = method === 'position' || method === 'partial';
    if (armed.sl && (!needsTakeProfit || armed.tp)) {
      return { skipped: 'protection already present', verified: true, armed };
    }
    const key = String(position.positionId);
    // A lookup miss must never be allowed to overwrite protection that is
    // already armed and already improved.
    //
    // "No stop found in the pending list" has two very different causes: the
    // position genuinely has no stop, or the list did not contain its rows.
    // Both look identical from here, and treating the second as the first
    // re-places the pair at the ATR levels — discarding a break-even or trailing
    // stop that had just been moved, which the next checkBreakeven then
    // re-applies and re-announces. The stop then oscillates between entry and
    // the ATR level on every tick and the position is never actually protected.
    //
    // So when we have already moved this position's stop ourselves, a "missing"
    // row is treated as stale bookkeeping rather than as absence, and nothing is
    // written. Re-arming a stop we did not move is still allowed, which is what
    // covers a genuinely naked position.
    if (!armed.sl && this.breakEvenApplied.has(key)) {
      return { skipped: 'break-even stop already applied; pending list stale', verified: true, armed };
    }
    const lastAttempt = this.protectionAttempts.get(key) || 0;
    if (Date.now() - lastAttempt < 60000) return { skipped: 'protection retry pending' };
    this.protectionAttempts.set(key, Date.now());
    const direction = position.side === 'BUY' ? 'bullish' : position.side === 'SELL' ? 'bearish' : null;
    if (!direction) throw new Error(`position ${key} has an invalid side for TP/SL`);
    try {
      const atr = await this.getAtrForPosition(position);
      const confidence = position.signalConfidence ?? this.settings.min_confidence;
      const entryPrice = Number(position.avgPrice);
      // Method dispatch: 'partial' replaces the single all-in TP with an
      // order-level ladder; 'trailing' and 'account' keep the position-level
      // pair because that is the only pair that exits the whole position at
      // once, but they take the stop alone and leave the exit to the callback
      // or the account guard. 'position' keeps today's fixed TP + SL.
      if (method === 'partial') {
        const ladder = await this.placePartialTPSL(position, entryPrice, direction, atr, confidence);
        if (ladder.error) throw new Error(ladder.error);
        this.resetTpslCache();
        this.breakEvenApplied.delete(String(position.positionId));
        return { placed: true, result: ladder };
      }
      if (method === 'trailing' || method === 'account') {
        const result = await this.placeTPSLStop(position.positionId, entryPrice, direction, atr, confidence);
        this.resetTpslCache();
        this.breakEvenApplied.delete(String(position.positionId));
        return { placed: true, result, method };
      }
      // A half-armed pair is repaired rather than duplicated: place_order on an
      // already-protected position is at best a no-op and at worst a second
      // competing target, while modifyTPSL is the endpoint that owns the pair.
      if (armed.tp !== armed.sl) {
        const result = await this.repairProtection(position, entryPrice, direction, atr, confidence, armed);
        // The pair we just rebuilt carries fresh ATR levels, so any earlier
        // break-even is no longer describing what is armed on the exchange.
        this.breakEvenApplied.delete(String(position.positionId));
        return { placed: true, result, repaired: true };
      }
      const result = await this.placeTPSL(position.positionId, entryPrice, direction, atr, confidence);
      this.resetTpslCache();
      this.breakEvenApplied.delete(String(position.positionId));
      return { placed: true, result };
    } catch (error) {
      if (this.settings.on_tpsl_failure === 'close') {
        this.noteClose(position.positionId, 'tpsl_failure');
        const closeResult = await this.client.closePosition(this.symbol, position.positionId, position);
        return { closed: true, result: closeResult, error: error.message };
      }
      throw new Error(`TP/SL protection failed: ${error.message}`);
    }
  }

  async midManage() {
    await this.fetchPositions();
    const errors = [];
    // The set is per-tick: a position closed now is gone on the next fetch, and
    // the same positionId must be allowed to close again if it is ever reopened.
    this.closedThisCycle.clear();
    // One TP/SL view per tick. Every stop move this tick reads the same rows it
    // will write against, so a take-profit set by hand mid-tick is not clobbered
    // by a stale cache and the list is not re-fetched per position.
    this.resetTpslCache();
    // Method 4 runs once per cycle, before the per-position work: when it
    // closes everything there is nothing left to protect this tick.
    try {
      const accountGuard = await this.checkAccountGuard();
      if (accountGuard?.triggered) return errors;
    } catch (error) {
      errors.push({ positionId: 'account', message: error.message });
    }
    for (const position of this.state.positions) {
      let protectionFailed = false;
      try {
        const protection = await this.ensureProtection(position);
        if (protection?.closed) {
          this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
          continue;
        }
      } catch (error) {
        errors.push({ positionId: position.positionId, message: error.message });
        protectionFailed = true;
      }
      if (protectionFailed) continue;
      try {
        // ORDER IS A RISK DECISION, not a style choice. The liquidation guard
        // and the tiered-risk-limit maintenance-margin guard are the only two
        // steps on this tick whose failure is unrecoverable — the exchange
        // force-liquidates the position — so they run FIRST and the position is
        // not touched again once either has fired. They used to run last, after
        // break-even and trailing had each re-derived an ATR stop and awaited
        // an exchange round-trip, so a position sitting on its liquidation
        // price spent that window being re-protected instead of being closed.
        const liqGuard = await this.checkLiquidationGuard(position);
        if (liqGuard?.closed) continue;
        // Tiered risk limit: the exchange's own maintenance-margin trigger.
        const marginGuard = await this.checkMaintenanceMargin(position);
        if (marginGuard?.closed) continue;

        // A stop the exchange refused to move is enforced here, before any
        // further profit-side management.
        const softStop = await this.checkSoftStop(position);
        if (softStop?.closed) continue;

        // Profit-side management only once the position is known to be safe.
        const breakeven = await this.checkBreakeven(position);
        if (breakeven?.slPrice) position.slPrice = breakeven.slPrice;
        const trailing = await this.checkTrailing(position);
        if (trailing?.slPrice) position.slPrice = trailing.slPrice;
        // Method 3: the peak/callback exit only runs under the trailing method;
        // the ATR stop tightening above stays on as the hard backstop. Skipped
        // when the liquidation guard already closed this position, otherwise the
        // same positionId is closed twice in one tick (Bitunix: 30042).
        if (this.activeMethod() === 'trailing' && !this.closedThisCycle.has(String(position.positionId))) {
          const callback = await this.checkTrailingCallback(position);
          if (callback?.closed) {
            this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
            continue;
          }
        }
      } catch (error) {
        errors.push({ positionId: position.positionId, message: error.message });
      }
    }
    return errors;
  }
}
