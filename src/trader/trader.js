import Scanner from '../bitunix/scanner.js';
import { atr as calculateAtr } from '../bitunix/indicators.js';
import { positionSizeFromUnit, roundPrice } from '../bitunix/order-units.js';
import { PositionManager } from './position-manager.js';
import { CONFIG } from '../config.js';

function validPositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

// Bitunix rejects a request with "10002 Parameter error" rather than naming the
// offending field, so catch the pair-metadata violations locally where the
// message can actually say what is wrong.
function decimalsOf(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

// Exported so the order-precision rules can be tested directly: this is the
// guard that stops a malformed order reaching the exchange as an opaque
// "10002 Parameter error".
export function assertOrderMatchesPair(body, pair) {
  if (!pair || typeof pair !== 'object') return;
  const errors = [];
  // The venue publishes the tradable state of the pair on the same record as its
  // precisions, and the bot was checking every numeric field except these:
  //   symbolStatus     OPEN: trade normal / CANCEL_ONLY: cancel only /
  //                    STOP: can't open or close position
  //   isApiSupported   false: API Trading Disabled
  // https://www.bitunix.com/api-docs/futures/market/get_trading_pairs.html
  //
  // Neither is enforced by precision or volume validation, so an entry could be
  // sent to a delisted pair, or the closing leg of an emergency exit could be
  // rejected outright because the symbol is CANCEL_ONLY — which is precisely
  // when getting out matters most.
  const status = String(pair.symbolStatus ?? '').trim().toUpperCase();
  if (status && !['OPEN'].includes(status)) {
    errors.push(`${pair.symbol ?? 'pair'} is ${status}, so it cannot be traded`);
  }
  if (pair.isApiSupported === false) {
    errors.push(`${pair.symbol ?? 'pair'} has API trading disabled (isApiSupported=false)`);
  }
  const quotePrecision = Number(pair.quotePrecision);
  const basePrecision = Number(pair.basePrecision);
  if (Number.isInteger(quotePrecision) && quotePrecision >= 0) {
    for (const field of ['price', 'tpPrice', 'slPrice']) {
      const value = body[field];
      if (value === undefined || value === null || value === '') continue;
      if (decimalsOf(value) > quotePrecision) {
        errors.push(`${field} ${value} has ${decimalsOf(value)} decimals but ${pair.symbol} allows quotePrecision ${quotePrecision}`);
      }
    }
  }
  if (Number.isInteger(basePrecision) && basePrecision >= 0) {
    const qtyDecimals = decimalsOf(body.qty);
    if (qtyDecimals > basePrecision) {
      errors.push(`qty ${body.qty} has ${qtyDecimals} decimals but ${pair.symbol} allows basePrecision ${basePrecision}`);
    }
  }
  const minVolume = Number(pair.minTradeVolume);
  if (Number.isFinite(minVolume) && minVolume > 0 && Number(body.qty) < minVolume) {
    errors.push(`qty ${body.qty} is below minTradeVolume ${pair.minTradeVolume}`);
  }
  // MARKET orders are capped by maxMarketOrderVolume, LIMIT ones by
  // maxLimitOrderVolume, so the cap depends on the order type actually sent.
  const capField = body.orderType === 'LIMIT' ? 'maxLimitOrderVolume' : 'maxMarketOrderVolume';
  const cap = Number(pair[capField]);
  if (Number.isFinite(cap) && cap > 0 && Number(body.qty) > cap) {
    errors.push(`qty ${body.qty} exceeds ${capField} ${pair[capField]} for a ${body.orderType} order`);
  }
  if (body.orderType === 'LIMIT' && !validPositive(body.price)) {
    errors.push('a LIMIT order requires a positive price');
  }
  if (body.orderType === 'LIMIT' && !body.effect) {
    errors.push('a LIMIT order requires an effect (GTC, IOC, FOK or POST_ONLY)');
  }
  // Price protection. The venue caps how far from the current mark an order may
  // sit: "current mark price is: 10000, priceProtectScope=0.02, the minimum sell
  // order price = 10000*(1-0.02)=9800; the maximum buy order price = 10000*(1+
  // 0.02) = 10200". A price outside that band is rejected, which matters here
  // because TP/SL levels are derived from ATR and can sit far from the mark on a
  // volatile symbol.
  if (body.effect === 'GTC' || body.orderType === 'LIMIT') {
    const scope = Number(pair.priceProtectScope);
    const mark = Number(body.markPrice ?? body.referencePrice);
    if (Number.isFinite(scope) && scope > 0 && Number.isFinite(mark) && mark > 0 && Number(body.price) > 0) {
      const price = Number(body.price);
      const minBuy = mark * (1 - scope);
      const maxBuy = mark * (1 + scope);
      const minSell = mark * (1 - scope);
      const maxSell = mark * (1 + scope);
      if (body.side === 'BUY' && (price < minBuy || price > maxBuy)) {
        errors.push(`BUY price ${price} is outside priceProtectScope +/-${scope} of the ${mark} mark price (${minBuy}-${maxBuy})`);
      }
      if (body.side === 'SELL' && (price < minSell || price > maxSell)) {
        errors.push(`SELL price ${price} is outside priceProtectScope +/-${scope} of the ${mark} mark price (${minSell}-${maxSell})`);
      }
    }
  }
  if (errors.length) throw new Error(`order rejected before sending: ${errors.join('; ')}`);
}

export class Trader {
  client;
  scanner;
  positionManager;
  state = {
    lastScan: 0,
    lastGuard: 0,
    lastReport: 0,
    lastManage: 0,
    cooldownUntil: 0,
    orderUnknownUntil: 0,
    positions: [],
    lastPrivateEvent: null,
    lastSignal: null,
    lastReportData: null,
    lastMarketDirection: null,
    confirmations: new Map(),
  };
  entryInFlight = new Set();
  guardInFlight = null;
  manageInFlight = null;
  privateRefreshInFlight = null;

  constructor(client) {
    this.client = client;
    this.scanner = new Scanner(client);
    this.positionManager = new PositionManager(client, CONFIG.symbol, CONFIG);
  }

  async reconcilePositions() {
    const positions = await this.positionManager.fetchPositions();
    this.state.positions = positions.map(position => ({
      positionId: position.positionId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: Number(position.avgPrice),
      markPrice: Number(position.markPrice),
      openedAt: Number(position.ctime ?? position.openTime ?? Date.now()),
    }));
    return this.state.positions;
  }

  updateConfirmation(symbol, signal) {
    if (!['bullish', 'bearish'].includes(signal)) {
      this.state.confirmations.delete(symbol);
      return 0;
    }
    const current = this.state.confirmations.get(symbol);
    const count = current?.signal === signal ? current.count + 1 : 1;
    this.state.confirmations.set(symbol, { signal, count });
    return count;
  }

  async verifyAccountSettings() {
    const [account, leverageData, positionModeData] = await Promise.all([
      this.client.getAccount('USDT'),
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
      this.client.getPositionMode(),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const leverageValue = Number(leverageRecord?.leverage ?? leverageRecord?.marginLeverage);
    if (Number.isFinite(leverageValue) && leverageValue !== CONFIG.leverage) {
      throw new Error(`exchange leverage ${leverageValue} does not match configured leverage ${CONFIG.leverage}`);
    }
    const exchangeMode = String(positionModeData?.positionMode ?? account?.positionMode ?? account?.position_mode ?? '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) {
      throw new Error(`exchange position mode ${exchangeMode} does not match configured mode ${configuredMode}`);
    }
    const exchangeMarginMode = String(leverageRecord?.marginMode ?? '').toUpperCase();
    const configuredMarginMode = CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS';
    if (exchangeMarginMode && exchangeMarginMode !== configuredMarginMode) {
      throw new Error(`exchange margin mode ${exchangeMarginMode} does not match configured mode ${configuredMarginMode}`);
    }
    return { checked: true, leverage: Number.isFinite(leverageValue) ? leverageValue : null, positionMode: exchangeMode || null, marginMode: exchangeMarginMode || null };
  }

  async syncAccountSettings({ apply = false } = {}) {
    const [positions, orders] = await Promise.all([
      this.client.getPendingPositions(CONFIG.symbol),
      this.client.getPendingOrders(CONFIG.symbol),
    ]);
    if (!Array.isArray(positions) || !Array.isArray(orders)) throw new Error('exchange exposure state is invalid');
    const current = await this.verifyAccountSettings();
    if (!apply) return { ...current, applied: false };
    if (positions.length || orders.length) return { ...current, applied: false, skipped: 'open_exposure' };

    const [leverageData, positionModeData] = await Promise.all([
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
      this.client.getPositionMode(),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const leverage = Number(leverageRecord?.leverage);
    if (Number.isFinite(leverage) && leverage !== CONFIG.leverage) await this.client.changeLeverage(CONFIG.symbol, CONFIG.leverage);
    const marginMode = String(leverageRecord?.marginMode || '').toUpperCase();
    const configuredMarginMode = CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS';
    if (marginMode && marginMode !== configuredMarginMode) await this.client.changeMarginMode(CONFIG.symbol, CONFIG.position_type);
    const exchangeMode = String(positionModeData?.positionMode || '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) await this.client.changePositionMode(CONFIG.position_mode);
    return { ...(await this.verifyAccountSettings()), applied: true };
  }

  async scanOnly() {
    const symbol = CONFIG.symbol;
    const result = await this.scanner.scan(symbol);
    if (CONFIG.symbol !== symbol) return null;
    const previousDirection = this.state.lastMarketDirection;
    const reversal = CONFIG.reversal_enabled
      && previousDirection
      && result.rawDirection !== 'neutral'
      && previousDirection !== result.rawDirection
      && result.rawConfidence >= CONFIG.reversal_confidence;
    if (result.rawDirection && result.rawDirection !== 'neutral') this.state.lastMarketDirection = result.rawDirection;
    result.reversal = reversal;
    if (!['bullish', 'bearish'].includes(result.signal)) {
      this.updateConfirmation(symbol, 'neutral');
      return { ...result, confirmations: 0, executed: false };
    }
    const confirmations = this.updateConfirmation(symbol, result.signal);
    return { ...result, confirmations, executed: false };
  }

  async executeSignal(signal) {
    if (!signal || !['bullish', 'bearish'].includes(signal.signal)) return { executed: false, reason: 'no directional signal' };
    if (!CONFIG.auto_trade) return { executed: false, reason: 'auto_trade_disabled' };
    if ((signal.confirmations || 0) < CONFIG.signal_confirm_scans) return { executed: false, reason: 'confirmation_pending' };
    const symbol = CONFIG.symbol;
    const now = Date.now();
    if (now < this.state.cooldownUntil || now < this.state.orderUnknownUntil) return { executed: false, reason: 'cooldown' };
    if (this.entryInFlight.has(symbol)) return { executed: false, reason: 'entry_in_flight' };
    this.entryInFlight.add(symbol);
    try {
      await this.reconcilePositions();
      if (this.state.positions.length >= CONFIG.max_positions) return { executed: false, reason: 'max_positions' };
      if (!validPositive(Number(signal.lastPrice))) throw new Error('scanner returned an invalid entry price');
      let entryPrice = Number(signal.lastPrice);
      // A market entry is protected against the live mark rather than the
      // scanner's last trade, so the ATR levels sit where the fill will land.
      try {
        entryPrice = await this.fetchMarkPrice(symbol);
      } catch {
        // Keep the scanner price. The entry is still marketable and the manage
        // pass re-derives protection from the real fill price.
      }
      const atr = signal.tfSignals?.[CONFIG.timeframes[0]]?.atr ?? null;
      const order = await this.openPosition(symbol, entryPrice, signal.signal, atr, signal.confidence);
      return { ...signal, executed: true, order, price: entryPrice };
    } finally {
      this.entryInFlight.delete(symbol);
    }
  }

  async scanAndOpen() {
    return this.executeSignal(await this.scanOnly());
  }

  async reconcileOrder(symbol, clientId) {
    if (typeof this.client.getPendingOrders !== 'function' || typeof this.client.getHistoryOrders !== 'function') return null;
    const results = await Promise.allSettled([
      this.client.getPendingOrders(symbol),
      this.client.getHistoryOrders(symbol),
    ]);
    for (const result of results) {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
      const match = result.value.find(order => String(order.clientId || order.client_id || '') === clientId);
      if (match) return match;
    }
    return null;
  }

  async openPosition(symbol, entryPrice, direction, atr = null, signalConfidence = null) {
    if (!CONFIG.auto_trade) throw new Error('auto_trade is disabled');
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('invalid trade direction');
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    this.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
    this.state.confirmations.delete(symbol);

    const { qty, pair } = await this.computePositionSize(entryPrice, 'MARKET');
    const clientId = `jrock-open-${symbol}-${Date.now()}`;
    // The reference price is snapped to the pair's quotePrecision BEFORE the
    // TP/SL is derived, so the levels all sit on ticks the exchange will
    // actually accept. Bitunix answers a price carrying more decimals than
    // quotePrecision with "10002 Parameter error", and the raw scanner price
    // (e.g. 116543.2187 at 1dp) is exactly that shape.
    //
    // MARKET, not LIMIT at the scanner's last price: a limit resting at the
    // current price is not an entry. It sits in the book unfilled, so no
    // position exists and therefore no take-profit and no stop exist either —
    // the bot looked like it had gone quiet — and the fill that eventually
    // arrived minutes later relied entirely on the manage pass to re-derive
    // protection for a position nothing was watching.
    const { body } = this.buildProtectedOrderBody({
      symbol,
      side: direction === 'bullish' ? 'BUY' : 'SELL',
      qty,
      price: entryPrice,
      orderType: 'MARKET',
      pair,
      atr: atr ?? await this.computeAtr(symbol),
      confidence: signalConfidence,
      clientId,
    });

    if (!CONFIG.auto_trade) throw new Error('auto_trade was disabled before order submission');
    if (CONFIG.symbol !== symbol) throw new Error('symbol changed before order submission');
    let order;
    try {
      order = await this.client.placeOrder(body);
    } catch (error) {
      const reconciled = await this.reconcileOrder(symbol, clientId);
      if (!reconciled) {
        this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
        throw error;
      }
      order = reconciled;
    }
    const positions = await this.reconcilePositions();
    try {
      for (const position of positions) await this.positionManager.ensureProtection(position);
    } catch (error) {
      this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
      throw error;
    }
    return order;
  }

  // The only place an OPEN order is assembled. Both entry paths — autonomous
  // openPosition() and the agent's manual tool — go through it, so a position
  // can never reach the exchange without a take-profit and a stop-loss riding
  // along on the very same order. That matters because protection is otherwise
  // attached a moment later, and a position filled in that gap has no defined
  // exit: it only closes when a human notices.
  buildProtectedOrderBody({ symbol, side, qty, price, orderType, pair, atr, confidence, clientId = null }) {
    // Snap to quotePrecision first, then derive the levels from the snapped
    // price, so limit price and stops all land on ticks Bitunix accepts.
    const entryPrice = roundPrice(price, pair);
    if (!(entryPrice > 0)) throw new Error(`order price ${price} rounds to zero at quotePrecision ${pair.quotePrecision}`);
    const quotePrecision = Number.isInteger(Number(pair.quotePrecision)) ? Number(pair.quotePrecision) : 8;
    const direction = side === 'BUY' ? 'bullish' : side === 'SELL' ? 'bearish' : null;
    if (!direction) throw new Error('order side must be BUY or SELL');
    // computeTPSL throws when ATR is missing rather than falling back to a
    // fixed percentage: an entry without a real stop distance is not tradable.
    const levels = this.positionManager.computeTPSL(entryPrice, direction, atr, confidence ?? CONFIG.min_confidence, quotePrecision);
    const body = {
      symbol,
      side,
      qty: String(qty),
      orderType,
      // A LIMIT order without an effect is a parameter error on Bitunix, and
      // GTC is the documented default the docs also spell out explicitly.
      effect: 'GTC',
      ...levels,
      tpOrderType: 'MARKET',
      slOrderType: 'MARKET',
      reduceOnly: false,
      tradeSide: 'OPEN',
      ...(clientId ? { clientId } : {}),
    };
    if (orderType === 'LIMIT') body.price = String(entryPrice);
    assertOrderMatchesPair(body, pair);
    return { body, entryPrice, tpPrice: levels.tpPrice, slPrice: levels.slPrice };
  }

  // The tickers endpoint answers with every symbol it was asked about, so the
  // row has to be matched by symbol. Reading data[0] instead prices one coin's
  // order off a completely different coin.
  async fetchMarkPrice(symbol) {
    const data = await this.client.getTickers(symbol);
    const list = Array.isArray(data) ? data : [data];
    const ticker = list.find(item => String(item?.symbol || '').toUpperCase() === String(symbol).toUpperCase());
    if (!ticker) throw new Error(`no ticker returned for ${symbol}`);
    const value = Number(ticker.markPrice ?? ticker.lastPrice ?? ticker.price);
    if (!validPositive(value)) throw new Error(`ticker for ${symbol} carries no usable price`);
    return value;
  }

  async getPairMetadata(symbol) {
    const pairs = await this.client.getTradingPairs(symbol);
    const pair = (Array.isArray(pairs) ? pairs : [])
      .find(item => String(item?.symbol || '').toUpperCase() === String(symbol).toUpperCase());
    if (!pair) throw new Error(`trading pair metadata missing for ${symbol}`);
    return pair;
  }

  async computeAtr(symbol) {
    const klines = await this.client.getKlines(symbol, '15m', 60);
    if (!Array.isArray(klines) || klines.length < 2) throw new Error(`no 15m klines available for ${symbol} to size a stop`);
    const value = calculateAtr(
      klines.map(k => Number(k.high)),
      klines.map(k => Number(k.low)),
      klines.map(k => Number(k.close)),
      14,
    );
    if (!validPositive(value)) throw new Error(`ATR is unavailable for ${symbol}; refusing to open an unprotected position`);
    return value;
  }

  // Manual entry, called by the trader_open_position agent tool. Unlike the
  // autonomous path this does not need auto_trade — the user explicitly asked
  // for the trade — but every other guarantee still applies: real market price,
  // pair-checked size, ATR-derived take-profit and stop on the order itself,
  // and a reconcile-and-protect pass immediately after it fills.
  async openManualPosition({ symbol, side, qty, price = null, confidence = null }) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    if (!normalizedSymbol) throw new Error('symbol is required');
    // The whole risk engine — TP/SL manager, liquidation guard, max_positions,
    // break-even/trailing and the notifier — tracks CONFIG.symbol only. A
    // position on any other pair would be invisible to all of it.
    if (normalizedSymbol !== String(CONFIG.symbol).toUpperCase()) {
      throw new Error(`manual entries are limited to the configured symbol ${CONFIG.symbol}; change the symbol setting first`);
    }
    const orderSide = String(side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(orderSide)) throw new Error('side must be BUY or SELL');
    if (!validPositive(qty)) throw new Error('qty must be positive');
    if (price !== null && price !== undefined && price !== '' && !validPositive(price)) {
      throw new Error('price must be positive when supplied');
    }

    const pair = await this.getPairMetadata(normalizedSymbol);
    const open = await this.reconcilePositions();
    if (open.length >= Number(CONFIG.max_positions)) {
      throw new Error(`already holding ${open.length} position(s); max_positions is ${CONFIG.max_positions}`);
    }
    this.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
    this.state.confirmations.delete(normalizedSymbol);

    // A MARKET entry has no price of its own, so the levels are derived from
    // the live mark for this exact symbol. A LIMIT entry is protected against
    // its own limit price, which is the price it will actually fill at.
    const limitPrice = price === null || price === undefined || price === '' ? null : Number(price);
    const orderType = limitPrice ? 'LIMIT' : 'MARKET';
    const referencePrice = limitPrice || await this.fetchMarkPrice(normalizedSymbol);
    const atr = await this.computeAtr(normalizedSymbol);
    const { body, entryPrice, tpPrice, slPrice } = this.buildProtectedOrderBody({
      symbol: normalizedSymbol,
      side: orderSide,
      qty,
      price: referencePrice,
      orderType,
      pair,
      atr,
      confidence,
    });

    let order;
    try {
      order = await this.client.placeOrder(body);
    } catch (error) {
      // A write failure is ambiguous: the order may already be live on the
      // exchange. Block further entries until that has settled, exactly as the
      // autonomous path does.
      this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
      throw error;
    }

    const positions = await this.reconcilePositions();
    // Belt and braces: the TP/SL is already armed on the order above, so this
    // only verifies the exchange really has it. ensureProtection() applies the
    // configured on_tpsl_failure behaviour (close) if the check fails.
    const protection = [];
    for (const position of positions) {
      protection.push(await this.positionManager.ensureProtection(position));
    }
    return {
      order,
      symbol: normalizedSymbol,
      side: orderSide,
      qty: String(qty),
      orderType,
      entryPrice,
      tpPrice,
      slPrice,
      protection,
      positions: positions.length,
    };
  }

  // `orderType` must match the order actually placed, because the exchange caps
  // LIMIT and MARKET volume differently. Defaulting to MARKET here while the
  // caller places a LIMIT would validate against the wrong (much smaller) cap.
  async computePositionSize(entryPrice, orderType = 'MARKET') {
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    const account = await this.client.getAccount('USDT');
    const available = Number(account?.available);
    if (!validPositive(available)) throw new Error('available USDT balance must be positive');
    const pairs = await this.client.getTradingPairs(CONFIG.symbol);
    const pair = (Array.isArray(pairs) ? pairs : []).find(item => String(item.symbol).toUpperCase() === CONFIG.symbol.toUpperCase());
    if (!pair) throw new Error(`trading pair metadata missing for ${CONFIG.symbol}`);
    // Validate against the band the venue publishes for THIS symbol on
    // /market/trading_pairs (minLeverage/maxLeverage) rather than a local
    // constant: the ceiling is per symbol, and a hard-coded guess is either too
    // tight (rejecting a leverage the exchange accepts) or too loose (letting
    // through one it refuses). The 125 fallback is the documented example value.
    const pairMin = Number(pair.minLeverage);
    const pairMax = Number(pair.maxLeverage);
    const minLeverage = Number.isFinite(pairMin) && pairMin >= 1 ? Math.trunc(pairMin) : 1;
    const maxLeverage = Number.isFinite(pairMax) && pairMax >= minLeverage ? Math.trunc(pairMax) : 125;
    if (!Number.isInteger(CONFIG.leverage) || CONFIG.leverage < minLeverage || CONFIG.leverage > maxLeverage) {
      throw new Error(`leverage must be an integer ${minLeverage}-${maxLeverage} for ${CONFIG.symbol}`);
    }
    // Size against the price the exchange will actually see, so the qty and the
    // margin it commits are consistent with the limit price we submit.
    const price = roundPrice(entryPrice, pair);
    // Delegate to the shared converter so the order_unit setting (nominal /
    // cost / qty) actually drives sizing, and so the exchange's own volume
    // limits are enforced here rather than being rejected by the API.
    const sized = positionSizeFromUnit({
      available,
      unit: CONFIG.order_unit,
      price,
      leverage: CONFIG.leverage,
      marginPct: CONFIG.position_sizing_margin_pct,
      pair,
      orderType,
    });
    if (!sized.ok) {
      const detail = sized.reason === 'below_min_trade_volume'
        ? `below the Bitunix minimum ${pair.minTradeVolume}`
        : sized.reason === 'above_max_order_volume'
          ? `exceeds the Bitunix maximum volume for a ${orderType} order`
          : 'is not a tradable size';
      throw new Error(`position size ${sized.qty} ${detail}`);
    }
    return { qty: sized.qty, pair };
  }

  async guard() {
    if (this.guardInFlight) return this.guardInFlight;
    const now = Date.now();
    if (now < this.state.lastGuard + CONFIG.guard_interval_sec * 1000) return null;
    this.state.lastGuard = now;
    this.guardInFlight = (async () => {
      const positions = await this.positionManager.fetchPositions();
      const errors = [];
      for (const position of positions) {
        try {
          const result = await this.positionManager.checkLiquidationGuard(position);
          if (result?.dryRun && result.positionId) this.state.cooldownUntil = this.positionManager.state.cooldownUntil;
          // The tiered risk limit's maintenance-margin trigger runs on the same
          // guard tick as the price-distance check.
          const maintenance = await this.positionManager.checkMaintenanceMargin(position);
          if (maintenance?.closed) this.state.cooldownUntil = this.positionManager.state.cooldownUntil;
        } catch (error) {
          errors.push({ positionId: position.positionId, message: error.message });
        }
      }
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.positionManager.state.cooldownUntil);
      this.state.positions = positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));
      return errors;
    })();
    try {
      return await this.guardInFlight;
    } finally {
      this.guardInFlight = null;
    }
  }

  async midManage() {
    if (this.manageInFlight) return this.manageInFlight;
    const now = Date.now();
    if (now < this.state.lastManage + CONFIG.mid_manage_interval_sec * 1000) return null;
    this.state.lastManage = now;
    this.manageInFlight = this.positionManager.midManage();
    try {
      const errors = await this.manageInFlight;
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.positionManager.state.cooldownUntil);
      this.state.positions = this.positionManager.state.positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));
      return errors;
    } finally {
      this.manageInFlight = null;
    }
  }

  async handlePrivateEvent(event) {
    const channel = event?.ch;
    const data = event?.data;
    this.state.lastPrivateEvent = { channel: channel || null, event: data?.event || null, at: Date.now() };
    if (channel === 'position' && data) {
      const positionId = String(data.positionId || '');
      if (positionId) {
        this.state.positions = this.state.positions.filter(position => String(position.positionId) !== positionId);
        if (data.event !== 'CLOSE') {
          this.state.positions.push({
            positionId,
            symbol: data.symbol,
            side: data.side === 'LONG' ? 'BUY' : data.side === 'SHORT' ? 'SELL' : data.side,
            qty: data.qty,
            openedAt: data.ctime ? Date.parse(data.ctime) || Date.now() : Date.now(),
          });
        }
      }
    }
    if (channel === 'tpsl' && data?.status === 'FAILED') console.error('TP/SL private event failed:', data.positionId || data.orderId || 'unknown');
    if (!['order', 'position', 'tpsl'].includes(channel)) return null;
    if (this.privateRefreshInFlight) return this.privateRefreshInFlight;
    this.privateRefreshInFlight = this.reconcilePositions();
    try {
      return await this.privateRefreshInFlight;
    } finally {
      this.privateRefreshInFlight = null;
    }
  }

  async report() {
    const now = Date.now();
    if (now < this.state.lastReport + CONFIG.report_interval_sec * 1000) return;
    console.log(`[Report ${new Date().toISOString()}] symbol=${CONFIG.symbol} positions=${this.state.positions.length}`);
    this.state.lastReport = now;
  }

  async scanCycle() {
    let signal = null;
    try { signal = await this.scanOnly(); } catch (error) { console.error('scan error:', error.message); }
    try { await this.guard(); } catch (error) { console.error('guard error:', error.message); }
    try { await this.midManage(); } catch (error) { console.error('manage error:', error.message); }
    try { await this.report(); } catch (error) { console.error('report error:', error.message); }
    return signal;
  }
}
