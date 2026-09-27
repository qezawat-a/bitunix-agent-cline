import { atr as calculateAtr } from '../bitunix/indicators.js';
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

  constructor(client, _symbol, settings) {
    this.client = client;
    this.settings = settings;
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

  // The pair's quotePrecision, needed to emit TP/SL prices the exchange will
  // accept. Cached because it never changes for a symbol, and an absent or
  // unreachable metadata source must not stop a position being protected — the
  // 8-decimal default is only used as a fallback.
  quotePrecisionCache = new Map();

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

  async getAtrForPosition(position) {
    if (finitePositive(position.atr)) return Number(position.atr);
    const klines = await this.client.getKlines(position.symbol || this.symbol, '15m', 60);
    const highs = klines.map(k => Number(k.high));
    const lows = klines.map(k => Number(k.low));
    const closes = klines.map(k => Number(k.close));
    const value = calculateAtr(highs, lows, closes, 14);
    if (!finitePositive(value)) throw new Error(`ATR unavailable for ${position.positionId}`);
    return value;
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

  favorableRoiPct(position) {
    const entry = Number(position.avgPrice);
    const mark = Number(position.markPrice);
    if (!finitePositive(entry) || !finitePositive(mark)) throw new Error('position entry and mark prices must be positive');
    const direction = position.side === 'BUY' ? 1 : position.side === 'SELL' ? -1 : 0;
    if (!direction) throw new Error('position side must be BUY or SELL');
    const leverage = finitePositive(this.settings.leverage) ? Number(this.settings.leverage) : 1;
    return ((mark - entry) / entry) * 100 * direction * leverage;
  }

  currentStop(position) {
    const value = position.slPrice ?? position.stopPrice ?? position.stopLossPrice;
    const stop = Number(value);
    return finitePositive(stop) ? stop : null;
  }

  shouldTighten(position, candidate) {
    const current = this.currentStop(position);
    if (!current) return true;
    return position.side === 'BUY' ? candidate > current : candidate < current;
  }

  async checkBreakeven(position) {
    const entry = Number(position.avgPrice);
    if (!finitePositive(entry)) throw new Error('position entry price must be positive');
    if (this.favorableRoiPct(position) >= Number(this.settings.breakeven_threshold_pct)) {
      const current = this.currentStop(position);
      if (current && position.side === 'BUY' && entry <= current) return { skipped: 'stop already favorable' };
      if (current && position.side === 'SELL' && entry >= current) return { skipped: 'stop already favorable' };
      const result = await this.moveSLToEntry(position.positionId, entry);
      return { ...result, slPrice: formatPrice(entry) };
    }
    return { skipped: 'threshold not reached' };
  }

  async moveSLToEntry(positionId, entryPrice) {
    const quotePrecision = await this.getQuotePrecision();
    // /tpsl/position/modify_order takes only symbol, positionId, the tp*/sl*
    // trigger prices and their stop types — the trigger's order type is not a
    // parameter here, so it is not sent.
    // https://www.bitunix.com/api-docs/futures/tp_sl/modify_position_tp_sl_order.html
    return this.client.modifyTPSL({
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(entryPrice, quotePrecision),
      slStopType: 'MARK_PRICE',
    });
  }

  async checkTrailing(position) {
    const mark = Number(position.markPrice);
    if (!finitePositive(mark)) throw new Error('position mark price must be positive');
    if (this.favorableRoiPct(position) >= Number(this.settings.trailing_trigger_roi_pct)) {
      const atr = await this.getAtrForPosition(position);
      const strength = Math.max(0, Math.min(100, Number(position.signalConfidence ?? this.settings.min_confidence))) / 100;
      const trailDistance = atr * (1.25 - strength * 0.25);
      const newSL = position.side === 'BUY' ? mark - trailDistance : mark + trailDistance;
      if (!finitePositive(newSL) || !this.shouldTighten(position, newSL)) return { skipped: 'trailing would loosen stop' };
      const result = await this.updateTrailingSL(position.positionId, newSL);
      return { ...result, slPrice: formatPrice(newSL, await this.getQuotePrecision()) };
    }
    return { skipped: 'threshold not reached' };
  }

  async updateTrailingSL(positionId, newSL) {
    // See moveSLToEntry: no slOrderType — it is not a documented parameter of
    // /tpsl/position/modify_order.
    return this.client.modifyTPSL({
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(newSL, await this.getQuotePrecision()),
      slStopType: 'MARK_PRICE',
    });
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
    await this.client.closeAllPosition(this.symbol);
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
    this.state.cooldownUntil = Date.now() + Number(this.settings.cooldown_minutes) * 60000;
    // `closed: true` lets midManage stop working this position. Without it the
    // trailing callback below would close the same positionId again in the same
    // tick, and Bitunix answers the repeat with 30042 Client ID duplicate.
    const result = await this.client.closePosition(this.symbol, position.positionId, position);
    this.closedThisCycle.add(String(position.positionId));
    return { closed: true, trigger: 'liquidation_guard', result };
  }

  async ensureProtection(position) {
    if (this.currentStop(position)) return { skipped: 'protection already present' };
    const key = String(position.positionId);
    const lastAttempt = this.protectionAttempts.get(key) || 0;
    if (Date.now() - lastAttempt < 60000) return { skipped: 'protection retry pending' };
    this.protectionAttempts.set(key, Date.now());
    const direction = position.side === 'BUY' ? 'bullish' : position.side === 'SELL' ? 'bearish' : null;
    if (!direction) throw new Error(`position ${key} has an invalid side for TP/SL`);
    try {
      const pending = await this.client.getPendingTPSL(this.symbol);
      if (!Array.isArray(pending)) throw new Error('pending TP/SL response must be an array');
      const existing = pending.find(item => String(item.positionId) === key && finitePositive(item.slPrice ?? item.stopPrice));
      if (existing) return { verified: true, result: existing };
      const atr = await this.getAtrForPosition(position);
      const confidence = position.signalConfidence ?? this.settings.min_confidence;
      const entryPrice = Number(position.avgPrice);
      // Method dispatch: 'partial' replaces the single all-in TP with an
      // order-level ladder; 'trailing' and 'account' keep the position-level
      // pair because that is the only pair that exits the whole position at
      // once, but they take the stop alone and leave the exit to the callback
      // or the account guard. 'position' keeps today's fixed TP + SL.
      const method = this.activeMethod();
      if (method === 'partial') {
        const ladder = await this.placePartialTPSL(position, entryPrice, direction, atr, confidence);
        if (ladder.error) throw new Error(ladder.error);
        return { placed: true, result: ladder };
      }
      if (method === 'trailing' || method === 'account') {
        const result = await this.placeTPSLStop(position.positionId, entryPrice, direction, atr, confidence);
        return { placed: true, result, method };
      }
      const result = await this.placeTPSL(position.positionId, entryPrice, direction, atr, confidence);
      return { placed: true, result };
    } catch (error) {
      if (this.settings.on_tpsl_failure === 'close') {
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
        const breakeven = await this.checkBreakeven(position);
        if (breakeven?.slPrice) position.slPrice = breakeven.slPrice;
        const trailing = await this.checkTrailing(position);
        if (trailing?.slPrice) position.slPrice = trailing.slPrice;
        await this.checkLiquidationGuard(position);
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
