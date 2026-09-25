import { atr as calculateAtr } from '../bitunix/indicators.js';

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function formatPrice(value) {
  if (!finitePositive(value)) throw new Error('price must be a positive finite number');
  return String(Number(Number(value).toFixed(8)));
}

export class PositionManager {
  client;
  settings;
  state = { positions: [], lastManage: 0, lastGuard: 0, cooldownUntil: 0 };
  fetchInFlight = null;
  protectionAttempts = new Map();

  constructor(client, _symbol, settings) {
    this.client = client;
    this.settings = settings;
  }

  get symbol() {
    return this.settings.symbol;
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

  computeTPSL(entryPrice, direction, atr, confidence) {
    if (!finitePositive(entryPrice)) throw new Error('entryPrice must be positive');
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('direction must be bullish or bearish');
    const normalizedConfidence = Math.max(0, Math.min(100, Number(confidence) || 0));
    // More confidence -> tighter stop and a slightly more ambitious target; ATR remains the only source of distance.
    const strength = normalizedConfidence / 100;
    const stopMultiple = 1.55 - strength * 0.45;
    const targetMultiple = 1.8 + strength * 1.2;
    const atrDist = this.getAtr(entryPrice, atr);
    const tpDist = atrDist * targetMultiple;
    const slDist = atrDist * stopMultiple;

    if (direction === 'bullish') {
      return {
        tpPrice: formatPrice(entryPrice + tpDist),
        slPrice: formatPrice(entryPrice - slDist),
        tpStopType: 'MARK_PRICE',
        slStopType: 'MARK_PRICE',
      };
    }
    return {
      tpPrice: formatPrice(entryPrice - tpDist),
      slPrice: formatPrice(entryPrice + slDist),
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
    const levels = this.computeTPSL(entryPrice, direction, atr, confidence);
    return this.client.placeTPSL({
      symbol: this.symbol,
      positionId,
      ...levels,
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
    return this.client.modifyTPSL({
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(entryPrice),
      slStopType: 'MARK_PRICE',
      slOrderType: 'MARKET',
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
      return { ...result, slPrice: formatPrice(newSL) };
    }
    return { skipped: 'threshold not reached' };
  }

  async updateTrailingSL(positionId, newSL) {
    return this.client.modifyTPSL({
      symbol: this.symbol,
      positionId,
      slPrice: formatPrice(newSL),
      slStopType: 'MARK_PRICE',
      slOrderType: 'MARKET',
    });
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
    return this.client.closePosition(this.symbol, position.positionId, position);
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
      const result = await this.placeTPSL(position.positionId, Number(position.avgPrice), direction, atr, position.signalConfidence ?? this.settings.min_confidence);
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
      } catch (error) {
        errors.push({ positionId: position.positionId, message: error.message });
      }
    }
    return errors;
  }
}
