import crypto from 'crypto';
import { CONFIG } from '../config.js';

function positiveNumber(value) {
  if (value === '' || value === null || value === undefined) return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

// The SDK exposes the order side as an enum (OrderSide.Buy / OrderSide.Sell),
// but PlaceOrderRequest#setSide takes a plain String and the SDK's own
// reference test sends the literal "BUY", so the REST wire value is upper case.
// We therefore widen the accepted *input* to both casings and keep sending
// upper case: rejecting "Buy"/"Sell" would fail a caller that copied the SDK
// enum verbatim, while emitting "Buy"/"Sell" would change live trading on a
// guess. Position sides are a different enum (PositionSide LONG/SHORT) and are
// untouched here.
function normalizeOrderSide(value) {
  const side = String(value ?? '').trim().toLowerCase();
  if (side === 'buy') return 'BUY';
  if (side === 'sell') return 'SELL';
  return null;
}

// The SDK returns either a bare list or a CommonResult.data envelope that
// extends PageResp (`total` + one named list field: orderList / tradeList /
// positionList). Prefer the SDK field name, keep the bare-array path, and hand
// back the raw payload when nothing matches so callers keep ownership of the
// "this is not the documented shape" error instead of silently seeing [].
function listFrom(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
}

// TpslOrderType / OrderType are LIMIT(1) / MARKET(2) in the SDK, but the ints
// are the WS/serialised form: Jackson writes an enum by name, and
// PlaceTpslOrderRequest types tpOrderType/slOrderType as plain Strings, so the
// REST body must carry "LIMIT"/"MARKET". Rejecting the int form here catches the
// most likely copy-paste from the SDK enum into a REST body.
function validateTPSLOrderEnums(params) {
  for (const field of ['tpOrderType', 'slOrderType']) {
    if (params[field] !== undefined && !['LIMIT', 'MARKET'].includes(String(params[field]).toUpperCase())) {
      throw new Error(`${field} must be LIMIT or MARKET`);
    }
  }
  for (const field of ['tpStopType', 'slStopType']) {
    if (params[field] !== undefined && !['LAST_PRICE', 'MARK_PRICE'].includes(String(params[field]).toUpperCase())) {
      throw new Error(`${field} must be LAST_PRICE or MARK_PRICE`);
    }
  }
  for (const field of ['tpQty', 'slQty']) {
    if (params[field] !== undefined && !positiveNumber(params[field])) throw new Error(`${field} must be a positive partial quantity`);
  }
}

function validateOrder(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('order parameters must be an object');
  if (typeof params.symbol !== 'string' || !/^[A-Z0-9]{5,32}$/.test(params.symbol)) throw new Error('invalid order symbol');
  if (!normalizeOrderSide(params.side)) throw new Error('order side must be BUY or SELL');
  if (!positiveNumber(params.qty)) throw new Error('order qty must be positive');
  const orderType = params.orderType || 'MARKET';
  if (!['LIMIT', 'MARKET'].includes(orderType)) throw new Error('orderType must be LIMIT or MARKET');
  if (orderType === 'LIMIT' && !positiveNumber(params.price)) throw new Error('LIMIT order price must be positive');
  if (!['OPEN', 'CLOSE', undefined].includes(params.tradeSide)) throw new Error('tradeSide must be OPEN or CLOSE');
  if (params.tradeSide === 'CLOSE' && (typeof params.positionId !== 'string' || !params.positionId.trim())) {
    throw new Error('hedge CLOSE order requires positionId');
  }
}

export function canonicalQuery(queryParams = {}) {
  const clean = Object.fromEntries(Object.entries(queryParams).filter(([, value]) => value !== '' && value !== undefined && value !== null));
  return Object.keys(clean).sort().map(key => `${key}${clean[key]}`).join('');
}

export class BitunixClient {
  baseURL = CONFIG.BITUNIX_BASE_URL;
  apiKey = CONFIG.BITUNIX_API_KEY;
  secretKey = CONFIG.BITUNIX_API_SECRET;

  static sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

  makeSign(_path, body, queryParams = {}) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString();
    const qs = canonicalQuery(queryParams);
    const bodyStr = typeof body === 'string' ? body.replace(/\s/g, '') : body ? JSON.stringify(body).replace(/\s/g, '') : '';
    const digestInput = `${nonce}${timestamp}${this.apiKey}${qs}${bodyStr}`;
    const digest = BitunixClient.sha256(digestInput);
    const sign = BitunixClient.sha256(digest + this.secretKey);
    return { 'api-key': this.apiKey, nonce, timestamp, sign };
  }

  async request(method, path, body = null, queryParams = {}, options = {}) {
    const cleanParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    );
    const bodyText = body === null || body === undefined ? '' : JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'language': 'en-US',
      ...(options.signed === false ? {} : this.makeSign(path, bodyText, cleanParams)),
    };
    const query = new URLSearchParams(cleanParams).toString();
    const url = `${this.baseURL}${path}${query ? `?${query}` : ''}`;
    const timeoutMs = options.timeoutMs ?? 15000;
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyText || undefined,
        signal,
      });
    } catch (error) {
      if (method !== 'GET') error.executionUnknown = true;
      throw error;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Bitunix ${method} ${path} ${res.status}: ${txt}`);
    }
    const payload = await res.json();
    if (payload && Object.hasOwn(payload, 'code') && Number(payload.code) !== 0) {
      throw new Error(`Bitunix ${method} ${path} rejected: ${payload.code} ${payload.msg || ''}`.trim());
    }
    if (payload?.data === null || payload?.data === undefined) {
      throw new Error(`Bitunix ${method} ${path} returned no data`);
    }
    return payload.data;
  }

  async getAccount(marginCoin = 'USDT') {
    const data = await this.request('GET', '/api/v1/futures/account', null, { marginCoin });
    if (Array.isArray(data)) {
      const account = data.find(item => item.marginCoin === marginCoin);
      if (!account) throw new Error(`Bitunix account ${marginCoin} not found`);
      return account;
    }
    if (!data || data.marginCoin !== marginCoin) throw new Error(`Bitunix account ${marginCoin} not found`);
    return data;
  }

  async getKlines(symbol, interval = '15m', limit = 200, startTime = 0, endTime = 0, type = 'LAST_PRICE') {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 200));
    const query = { symbol, interval, limit: String(safeLimit), startTime: startTime || '', endTime: endTime || '', type };
    return this.request('GET', '/api/v1/futures/market/kline', null, query, { signed: false });
  }

  async getTickers(symbol = '') {
    return this.request('GET', '/api/v1/futures/market/tickers', null, { symbols: symbol || '' }, { signed: false });
  }

  async getDepth(symbol, limit = '') {
    if (!symbol) throw new Error('symbol is required to read the order book');
    // Docs accept a fixed gear (1/5/15/50/max); empty returns the default gear.
    const gear = limit === '' || limit === null || limit === undefined ? '' : String(limit);
    if (gear && !/^(1|5|15|50|max)$/i.test(gear)) throw new Error('depth limit must be one of 1, 5, 15, 50, max');
    return this.request('GET', '/api/v1/futures/market/depth', null, { symbol, limit: gear }, { signed: false });
  }

  async placeOrder(params) {
    validateOrder(params);
    const orderType = params.orderType || 'MARKET';
    // Bitunix requires orderType and tradeSide on every place_order request,
    // even though the docs mark only some fields required. Send explicit values
    // so a caller that omits them still produces a valid request.
    const payload = { orderType, tradeSide: params.tradeSide || 'OPEN', ...params, orderType, side: normalizeOrderSide(params.side) };
    if (!payload.price && orderType === 'LIMIT') throw new Error('LIMIT order price must be positive');
    return this.request('POST', '/api/v1/futures/trade/place_order', payload, {});
  }

  async modifyOrder(params) {
    return this.request('POST', '/api/v1/futures/trade/modify_order', params, {});
  }

  async cancelOrder(symbol, orderId, clientId) {
    if (!symbol) throw new Error('symbol is required to cancel orders');
    if (!orderId && !clientId) throw new Error('orderId or clientId is required to cancel orders');
    // Bitunix cancel_orders nests the identifiers under orderList.
    const entry = orderId ? { orderId: String(orderId) } : { clientId: String(clientId) };
    return this.request('POST', '/api/v1/futures/trade/cancel_orders', { symbol, orderList: [entry] }, {});
  }

  async closePosition(symbol, positionId, position = null) {
    let target = position;
    if (!target) {
      const positions = await this.getPendingPositions(symbol);
      target = Array.isArray(positions) ? positions.find(item => String(item.positionId) === String(positionId)) : null;
    }
    if (!target || String(target.symbol || '').toUpperCase() !== String(symbol).toUpperCase() || String(target.positionId) !== String(positionId)) {
      throw new Error(`position ${positionId} not found for ${symbol}`);
    }
    const quantity = target.size ?? target.qty ?? target.positionQty ?? target.positionSize;
    if (!positiveNumber(quantity)) throw new Error(`position ${positionId} has no valid size`);
    const positionSide = String(target.side || '').toUpperCase();
    const side = positionSide === 'LONG' || positionSide === 'BUY'
      ? 'BUY'
      : positionSide === 'SHORT' || positionSide === 'SELL' ? 'SELL' : null;
    if (!side) throw new Error(`position ${positionId} has an invalid side`);
    // Bitunix hedge mode: closing LONG uses BUY, closing SHORT uses SELL.
    const positionMode = String(target.positionMode || 'HEDGE').toUpperCase();
    if (positionMode === 'ONE_WAY') {
      return this.placeOrder({
        symbol,
        side: positionSide === 'LONG' || positionSide === 'BUY' ? 'SELL' : 'BUY',
        qty: String(quantity),
        orderType: 'MARKET',
        reduceOnly: true,
        clientId: `jrock-close-${positionId}`,
      });
    }
    return this.placeOrder({
      symbol,
      side,
      qty: String(quantity),
      orderType: 'MARKET',
      tradeSide: 'CLOSE',
      reduceOnly: true,
      positionId,
      clientId: `jrock-close-${positionId}`,
    });
  }

  async closeAllPosition(symbol) {
    return this.request('POST', '/api/v1/futures/trade/close_all_position', { symbol }, {});
  }

  async placeTPSL(params) {
    return this.request('POST', '/api/v1/futures/tpsl/position/place_order', params, {});
  }

  async modifyTPSL(params) {
    return this.request('POST', '/api/v1/futures/tpsl/position/modify_order', params, {});
  }

  async cancelTPSL(symbol, orderId) {
    if (!symbol || !orderId) throw new Error('symbol and orderId are required to cancel TP/SL');
    return this.request('POST', '/api/v1/futures/tpsl/cancel_order', { symbol, orderId }, {});
  }

  // Order-level TP/SL, i.e. NOT the position-level placeTPSL above. This is the
  // only TP/SL pair that carries tpQty/slQty, so it is what makes a PARTIAL
  // take-profit / stop-loss possible: a position-level TP/SL exits the whole
  // position and takes no quantity.
  // https://www.bitunix.com/api-docs/futures/tpsl/place_tp_sl_order.html
  async placeTPSLOrder(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('TP/SL order parameters must be an object');
    if (typeof params.symbol !== 'string' || !params.symbol.trim()) throw new Error('TP/SL order requires a symbol');
    if (!positiveNumber(params.tpPrice) && !positiveNumber(params.slPrice)) {
      throw new Error('TP/SL order requires at least one of tpPrice or slPrice');
    }
    validateTPSLOrderEnums(params);
    return this.request('POST', '/api/v1/futures/tpsl/place_order', params, {});
  }

  // Keyed by orderId, NOT by positionId — this addresses the order created by
  // placeTPSLOrder, so a positionId here silently matches nothing. The SDK
  // marks orderId as the sole required field of ModifyTpslOrderRequest.
  // https://www.bitunix.com/api-docs/futures/tpsl/modify_tp_sl_order.html
  async modifyTPSLOrder(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('TP/SL order parameters must be an object');
    if (params.orderId === undefined || params.orderId === null || String(params.orderId).trim() === '') {
      throw new Error('modifyTPSLOrder requires orderId (the order-level TP/SL id, not a positionId)');
    }
    validateTPSLOrderEnums(params);
    return this.request('POST', '/api/v1/futures/tpsl/modify_order', params, {});
  }

  async getPendingPositions(symbol) {
    const data = await this.request('GET', '/api/v1/futures/position/get_pending_positions', null, { symbol });
    // SDK: bare ArrayList<PositionPendingResp>. There is no markPrice in the
    // model (avgOpenPrice/qty/liqPrice/unrealizedPNL/margin/leverage only), so
    // the mark price must come from /market/tickers — position-manager owns
    // that fallback. Anything else is returned raw so it can still fail loudly.
    return listFrom(data, ['positionList', 'positions']) ?? data;
  }

  async getHistoryPositions(symbol, options = {}) {
    const data = await this.request('GET', '/api/v1/futures/position/get_history_positions', null, { symbol, ...options });
    // SDK: PositionHistoryPageResp extends PageResp, list field is `positionList`.
    return listFrom(data, ['positionList', 'positionHistories']) ?? [];
  }

  async getPendingTPSL(symbol) {
    const data = await this.request('GET', '/api/v1/futures/tpsl/get_pending_orders', null, { symbol });
    // SDK: bare ArrayList<TpslPendingOrderResp>, whose id field is `id` (not
    // `orderId`) and whose stop price is `slPrice` alongside `positionId` — feed
    // that `id` to cancelTPSL as the orderId.
    return listFrom(data, ['tpslList', 'orderList', 'pendingTpslOrders']) ?? [];
  }

  async getHistoryTPSL(symbol) {
    const data = await this.request('GET', '/api/v1/futures/tpsl/get_history_orders', null, { symbol });
    // SDK: TpslHistoryOrdersPageResp extends PageResp, list field is `orderList`.
    return listFrom(data, ['orderList', 'tpslList']) ?? [];
  }

  async changeLeverage(symbol, leverage) {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error('leverage must be an integer 1-125');
    return this.request('POST', '/api/v1/futures/account/change_leverage', { symbol, leverage, marginCoin: 'USDT' }, {});
  }

  async changeMarginMode(symbol, marginMode) {
    const normalized = { crossed: 'CROSS', isolated: 'ISOLATION', cross: 'CROSS', isolation: 'ISOLATION' }[String(marginMode).toLowerCase()];
    if (!normalized) throw new Error('marginMode must be crossed or isolated');
    return this.request('POST', '/api/v1/futures/account/change_margin_mode', { symbol, marginMode: normalized, marginCoin: 'USDT' }, {});
  }

  async changePositionMode(positionMode) {
    const normalized = { 'one-way': 'ONE_WAY', one_way: 'ONE_WAY', hedge: 'HEDGE' }[String(positionMode).toLowerCase()];
    if (!normalized) throw new Error('positionMode must be one-way or hedge');
    return this.request('POST', '/api/v1/futures/account/change_position_mode', { positionMode: normalized }, {});
  }

  async adjustPositionMargin(symbol, amount, options = {}) {
    if (!symbol) throw new Error('symbol is required to adjust position margin');
    if (!Number.isFinite(Number(amount))) throw new Error('amount must be numeric');
    if (Number(amount) === 0) throw new Error('amount must be non-zero');
    // Bitunix requires marginCoin plus one of side / positionId. The field is
    // named `amount` (not `margin`); positive adds margin, negative removes it.
    const marginCoin = options.marginCoin || 'USDT';
    if (!options.side && !options.positionId) {
      throw new Error('adjustPositionMargin requires either side (LONG/SHORT) or positionId');
    }
    const payload = { symbol, amount: String(amount), marginCoin };
    if (options.side) payload.side = String(options.side).toUpperCase();
    if (options.positionId) payload.positionId = String(options.positionId);
    return this.request('POST', '/api/v1/futures/account/adjust_position_margin', payload, {});
  }

  async getFundingRate(symbol) {
    return this.request('GET', '/api/v1/futures/market/funding_rate', null, { symbol }, { signed: false });
  }

  async getFundingRateBatch() {
    // The official batch endpoint is slash-separated and takes no parameters.
    return this.request('GET', '/api/v1/futures/market/funding_rate/batch', null, {}, { signed: false });
  }

  async getTradingPairs(symbols = '') {
    const data = await this.request('GET', '/api/v1/futures/market/trading_pairs', null, { symbols }, { signed: false });
    // SDK: bare ArrayList<TradingPair> (basePrecision / quotePrecision /
    // minTradeVolume / maxMarketOrderVolume / maxLimitOrderVolume / maxLeverage),
    // returned raw so callers keep the full precision metadata.
    return listFrom(data, ['tradingPairs', 'list']) ?? data;
  }

  async getLeverageAndMarginMode(symbol, marginCoin = 'USDT') {
    return this.request('GET', '/api/v1/futures/account/get_leverage_margin_mode', null, { symbol, marginCoin });
  }

  async getPositionMode() {
    return this.request('GET', '/api/v1/futures/account/position_mode', null, {});
  }

  async getFundingRateHistory(symbol, options = {}) {
    return this.request('GET', '/api/v1/futures/market/get_funding_rate_history', null, { symbol, ...options }, { signed: false });
  }

  async getPositionTiers(symbol) {
    const data = await this.request('GET', '/api/v1/futures/position/get_position_tiers', null, { symbol }, { signed: false });
    // SDK: bare ArrayList<PositionTiersResp>.
    return listFrom(data, ['positionTiers', 'list']) ?? data;
  }

  async batchOrder(symbol, orderList) {
    if (!Array.isArray(orderList) || orderList.length < 1 || orderList.length > 5) throw new Error('orderList must contain 1-5 orders');
    // Accept the SDK Buy/Sell casing per entry, same as placeOrder. Entries
    // without a recognisable side are forwarded untouched so the exchange, not
    // this client, reports what is wrong with them.
    const orders = orderList.map(order => {
      const side = order && typeof order === 'object' ? normalizeOrderSide(order.side) : null;
      return side ? { ...order, side } : order;
    });
    return this.request('POST', '/api/v1/futures/trade/batch_order', { symbol, orderList: orders }, {});
  }

  async cancelAllOrders(symbol) {
    return this.request('POST', '/api/v1/futures/trade/cancel_all_orders', { symbol }, {});
  }

  async getPendingOrders(symbol, options = {}) {
    const data = await this.request('GET', '/api/v1/futures/trade/get_pending_orders', null, { symbol, ...options });
    // SDK: OrderPageResp extends PageResp, list field is `orderList`.
    return listFrom(data, ['orderList']) ?? [];
  }

  // get_order_detail accepts only orderId (or clientId) — there is no `symbol`
  // parameter, and sending one is rejected as a Parameter Error. A two-argument
  // call is still tolerated for call-site convenience, but the leading symbol is
  // deliberately dropped from the query.
  // https://www.bitunix.com/api-docs/futures/trade/get_order_detail.html
  async getOrderDetail(symbolOrOrderId, maybeOrderId) {
    const orderId = maybeOrderId === undefined ? String(symbolOrOrderId) : String(maybeOrderId);
    if (!orderId) throw new Error('orderId is required');
    return this.request('GET', '/api/v1/futures/trade/get_order_detail', null, { orderId });
  }

  async getHistoryOrders(symbol, options = {}) {
    const data = await this.request('GET', '/api/v1/futures/trade/get_history_orders', null, { symbol, ...options });
    // SDK: OrderPageResp extends PageResp, list field is `orderList`.
    return listFrom(data, ['orderList']) ?? [];
  }

  async getHistoryTrades(symbol, options = {}) {
    const data = await this.request('GET', '/api/v1/futures/trade/get_history_trades', null, { symbol, ...options });
    // SDK: TradePageResp extends PageResp, list field is `tradeList`.
    return listFrom(data, ['tradeList']) ?? [];
  }

  async flashClosePosition(positionId) {
    if (positionId === undefined || positionId === null || String(positionId).trim() === '') {
      throw new Error('positionId is required');
    }
    return this.request('POST', '/api/v1/futures/trade/flash_close_position', { positionId: String(positionId) }, {});
  }

  async getErrorCode(code) {
    return { code, hint: 'See https://www.bitunix.com/api-docs/futures/ErrorCode/error_code.html' };
  }
}
