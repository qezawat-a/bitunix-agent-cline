// tests/api-contract.test.js — the client pinned to the official Bitunix Java
// SDK (github.com/qezawat-a/open-api, Demo/Java/src).
//
// Nothing here talks to the exchange: every test stubs globalThis.fetch, exactly
// like tests/smoke.test.js does, and restores it in afterEach. Java is not
// installed on this box, so the SDK is used as a *specification* — the constant
// tables below are transcribed from the .java sources and the expected
// signatures are re-implemented from SignUtils.java / SHAUtils.java.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BitunixClient, canonicalQuery } from '../src/bitunix/client.js';
import { convert, normalizeUnit, positionSizeFromUnit, roundPrice, roundQty } from '../src/bitunix/order-units.js';
import { assertOrderMatchesPair as traderReject } from '../src/trader/trader.js';
import {
  TPSL_METHODS,
  accountPnlSummary,
  buildPartialLadder,
  evaluateTrailingCallback,
  formatPrice,
  formatQty,
  normalizeMethod,
  validateLadder,
} from '../src/trader/tpsl.js';
import { PositionManager } from '../src/trader/position-manager.js';

// computeTPSL is an instance method but is pure, so it is exercised through a
// client-less PositionManager rather than a network double.
const computeTpsl = (entryPrice, direction, atr, confidence) =>
  new PositionManager({}, null, { symbol: 'BTCUSDT' }).computeTPSL(entryPrice, direction, atr, confidence);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------
function client() {
  const c = new BitunixClient();
  c.apiKey = 'test-api-key';
  c.secretKey = 'test-api-secret';
  return c;
}

// Records every outbound request and answers with a `{ code: 0, data }` envelope
// shaped so each unwrapping path in client.js resolves.
function stubFetch(options = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      url: String(url),
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      search: parsed.search,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      rawBody: init.body ?? null,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const data = options.dataFor ? options.dataFor(parsed.pathname) : defaultData(parsed.pathname);
    return { ok: options.ok ?? true, status: options.status ?? 200, json: async () => options.payload ?? { code: 0, data } };
  };
  return calls;
}

function defaultData(pathname) {
  // getAccount is the one unwrapping path that inspects the payload shape.
  if (pathname === '/api/v1/futures/account') return { marginCoin: 'USDT', available: '100' };
  return [];
}

// ---------------------------------------------------------------------------
// constants transcribed from the SDK sources
// ---------------------------------------------------------------------------

// constants/FuturesPath.java
const SDK_PATHS = {
  GET_TRADING_PAIRS: '/api/v1/futures/market/trading_pairs',
  GET_TICKERS: '/api/v1/futures/market/tickers',
  GET_KLINE: '/api/v1/futures/market/kline',
  GET_FUNDING_RATE: '/api/v1/futures/market/funding_rate',
  GET_DEPTH: '/api/v1/futures/market/depth',
  GET_BATCH_FUNDING_RATE: '/api/v1/futures/market/funding_rate/batch',
  GET_ACCOUNT: '/api/v1/futures/account',
  GET_LEVERAGE_AND_MARGIN_MODE: '/api/v1/futures/account/get_leverage_margin_mode',
  CHANGE_POSITION_MODE: '/api/v1/futures/account/change_position_mode',
  CHANGE_LEVERAGE: '/api/v1/futures/account/change_leverage',
  CHANGE_MARGIN_MODE: '/api/v1/futures/account/change_margin_mode',
  ADJUST_POSITION_MARGIN: '/api/v1/futures/account/adjust_position_margin',
  PLACE_ORDER: '/api/v1/futures/trade/place_order',
  BATCH_PLACE_ORDER: '/api/v1/futures/trade/batch_order',
  CANCEL_ALL_ORDERS: '/api/v1/futures/trade/cancel_all_orders',
  CANCEL_ORDERS: '/api/v1/futures/trade/cancel_orders',
  CLOSE_ALL_POSITION: '/api/v1/futures/trade/close_all_position',
  FLASH_CLOSE_POSITION: '/api/v1/futures/trade/flash_close_position',
  GET_HISTORY_ORDERS: '/api/v1/futures/trade/get_history_orders',
  GET_HISTORY_TRADES: '/api/v1/futures/trade/get_history_trades',
  GET_ORDER_DETAIL: '/api/v1/futures/trade/get_order_detail',
  GET_PENDING_ORDERS: '/api/v1/futures/trade/get_pending_orders',
  MODIFY_ORDER: '/api/v1/futures/trade/modify_order',
  GET_HISTORY_POSITIONS: '/api/v1/futures/position/get_history_positions',
  GET_PENDING_POSITIONS: '/api/v1/futures/position/get_pending_positions',
  GET_POSITION_TIERS: '/api/v1/futures/position/get_position_tiers',
  CANCEL_TPSL_ORDERS: '/api/v1/futures/tpsl/cancel_order',
  GET_HISTORY_TPSL_ORDERS: '/api/v1/futures/tpsl/get_history_orders',
  GET_PENDING_TPSL_ORDERS: '/api/v1/futures/tpsl/get_pending_orders',
  MODIFY_POSITION_TPSL_ORDER: '/api/v1/futures/tpsl/position/modify_order',
  MODIFY_TPSL_ORDER: '/api/v1/futures/tpsl/modify_order',
  PLACE_POSITION_TPSL_ORDER: '/api/v1/futures/tpsl/position/place_order',
  PLACE_TPSL_ORDER: '/api/v1/futures/tpsl/place_order',
};

// Endpoints Bitunix documents but the SDK does not wrap, plus the two the SDK
// reaches only indirectly. `sdk: null` means "no FuturesPath constant exists".
const EXTRA_PATHS = {
  POSITION_MODE: '/api/v1/futures/account/position_mode',
  GET_FUNDING_RATE_HISTORY: '/api/v1/futures/market/get_funding_rate_history',
};

// enums/*.java
const SDK_ENUMS = {
  TradeSide: ['OPEN', 'CLOSE'],
  OrderSide: ['Buy', 'Sell'],
  OrderType: ['LIMIT', 'MARKET'],
  StopTriggerType: ['LAST_PRICE', 'MARK_PRICE'],
  TpslOrderType: ['LIMIT', 'MARKET'],
  MarginMode: ['ISOLATION', 'CROSS'],
  PositionMode: ['ONE_WAY', 'HEDGE'],
  PositionSide: ['LONG', 'SHORT'],
  OrderStatus: ['INIT', 'NEW', 'PART_FILLED', 'CANCELED', 'FILLED', 'PART_FILLED_CANCELED'],
  Effect: ['GTC', 'FOK', 'IOC', 'POST_ONLY'],
  // KlineInterval.getValue()
  KlineInterval: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'],
  // DepthLevel.getCount() — the SDK enum has no 50 / no "max".
  DepthLevel: ['1', '5', '15'],
};

// Every client method that maps onto an SDK endpoint, with the exact path the
// SDK's FuturesPath constant declares. `sdk` is the constant name (null = the
// SDK has no equivalent), `run` performs the call on a fresh client.
const ENDPOINTS = [
  { name: 'getTradingPairs', sdk: 'GET_TRADING_PAIRS', run: c => c.getTradingPairs('BTCUSDT') },
  { name: 'getTickers', sdk: 'GET_TICKERS', run: c => c.getTickers('BTCUSDT') },
  { name: 'getKlines', sdk: 'GET_KLINE', run: c => c.getKlines('BTCUSDT', '15m', 2) },
  { name: 'getDepth', sdk: 'GET_DEPTH', run: c => c.getDepth('BTCUSDT', '5') },
  { name: 'getFundingRate', sdk: 'GET_FUNDING_RATE', run: c => c.getFundingRate('BTCUSDT') },
  { name: 'getFundingRateBatch', sdk: 'GET_BATCH_FUNDING_RATE', run: c => c.getFundingRateBatch() },
  { name: 'getFundingRateHistory', sdk: null, extra: 'GET_FUNDING_RATE_HISTORY', run: c => c.getFundingRateHistory('BTCUSDT') },
  { name: 'getPositionTiers', sdk: 'GET_POSITION_TIERS', run: c => c.getPositionTiers('BTCUSDT') },
  { name: 'getAccount', sdk: 'GET_ACCOUNT', run: c => c.getAccount('USDT') },
  { name: 'getLeverageAndMarginMode', sdk: 'GET_LEVERAGE_AND_MARGIN_MODE', run: c => c.getLeverageAndMarginMode('BTCUSDT', 'USDT') },
  { name: 'getPositionMode', sdk: null, extra: 'POSITION_MODE', run: c => c.getPositionMode() },
  { name: 'getPendingPositions', sdk: 'GET_PENDING_POSITIONS', run: c => c.getPendingPositions('BTCUSDT') },
  { name: 'getHistoryPositions', sdk: 'GET_HISTORY_POSITIONS', run: c => c.getHistoryPositions('BTCUSDT') },
  { name: 'getPendingOrders', sdk: 'GET_PENDING_ORDERS', run: c => c.getPendingOrders('BTCUSDT') },
  { name: 'getOrderDetail', sdk: 'GET_ORDER_DETAIL', run: c => c.getOrderDetail('o-1') },
  { name: 'getHistoryOrders', sdk: 'GET_HISTORY_ORDERS', run: c => c.getHistoryOrders('BTCUSDT') },
  { name: 'getHistoryTrades', sdk: 'GET_HISTORY_TRADES', run: c => c.getHistoryTrades('BTCUSDT') },
  { name: 'getPendingTPSL', sdk: 'GET_PENDING_TPSL_ORDERS', run: c => c.getPendingTPSL('BTCUSDT') },
  { name: 'getHistoryTPSL', sdk: 'GET_HISTORY_TPSL_ORDERS', run: c => c.getHistoryTPSL('BTCUSDT') },
  {
    name: 'changePositionMode', method: 'POST', sdk: 'CHANGE_POSITION_MODE',
    run: c => c.changePositionMode('hedge'),
  },
  {
    name: 'changeLeverage', method: 'POST', sdk: 'CHANGE_LEVERAGE',
    run: c => c.changeLeverage('BTCUSDT', 5),
  },
  {
    name: 'changeMarginMode', method: 'POST', sdk: 'CHANGE_MARGIN_MODE',
    run: c => c.changeMarginMode('BTCUSDT', 'crossed'),
  },
  {
    name: 'adjustPositionMargin', method: 'POST', sdk: 'ADJUST_POSITION_MARGIN',
    run: c => c.adjustPositionMargin('BTCUSDT', 1, { side: 'LONG' }),
  },
  {
    name: 'placeOrder', method: 'POST', sdk: 'PLACE_ORDER',
    run: c => c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 'LIMIT', price: '100' }),
  },
  {
    name: 'modifyOrder', method: 'POST', sdk: 'MODIFY_ORDER',
    run: c => c.modifyOrder({ orderId: 'o-1', price: '2' }),
  },
  {
    name: 'batchOrder', method: 'POST', sdk: 'BATCH_PLACE_ORDER',
    run: c => c.batchOrder('BTCUSDT', [{ side: 'BUY', qty: '1', price: '1', orderType: 'LIMIT' }]),
  },
  {
    name: 'cancelOrder', method: 'POST', sdk: 'CANCEL_ORDERS',
    run: c => c.cancelOrder('BTCUSDT', 'o-1'),
  },
  {
    name: 'cancelAllOrders', method: 'POST', sdk: 'CANCEL_ALL_ORDERS',
    run: c => c.cancelAllOrders('BTCUSDT'),
  },
  {
    name: 'closeAllPosition', method: 'POST', sdk: 'CLOSE_ALL_POSITION',
    run: c => c.closeAllPosition('BTCUSDT'),
  },
  {
    name: 'flashClosePosition', method: 'POST', sdk: 'FLASH_CLOSE_POSITION',
    run: c => c.flashClosePosition('p-1'),
  },
  {
    name: 'placeTPSL', method: 'POST', sdk: 'PLACE_POSITION_TPSL_ORDER',
    run: c => c.placeTPSL({ symbol: 'BTCUSDT', positionId: 'p-1', tpPrice: '110', slPrice: '90' }),
  },
  {
    name: 'modifyTPSL', method: 'POST', sdk: 'MODIFY_POSITION_TPSL_ORDER',
    run: c => c.modifyTPSL({ symbol: 'BTCUSDT', positionId: 'p-1', tpPrice: '120' }),
  },
  {
    name: 'cancelTPSL', method: 'POST', sdk: 'CANCEL_TPSL_ORDERS',
    run: c => c.cancelTPSL('BTCUSDT', 't-1'),
  },
];

// The two order-level TP/SL endpoints. They are checked separately and
// defensively: if a teammate's api-client has not landed them yet these skip
// instead of failing the suite.
const TPSL_ORDER_ENDPOINTS = [
  {
    name: 'placeTPSLOrder', sdk: 'PLACE_TPSL_ORDER',
    run: c => c.placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110' }),
  },
  {
    name: 'modifyTPSLOrder', sdk: 'MODIFY_TPSL_ORDER',
    run: c => c.modifyTPSLOrder({ orderId: 't-1', tpPrice: '120' }),
  },
];

function expectedPath(entry) {
  if (entry.sdk) return SDK_PATHS[entry.sdk];
  return EXTRA_PATHS[entry.extra];
}

describe('bitunix REST contract: endpoint paths (FuturesPath.java)', () => {
  for (const entry of ENDPOINTS) {
    it(`${entry.name} sends ${entry.method ?? 'GET'} ${expectedPath(entry)}`, async () => {
      const calls = stubFetch();
      await entry.run(client());
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, expectedPath(entry), 'path must match the SDK FuturesPath constant byte for byte');
      assert.equal(calls[0].method, entry.method ?? 'GET', 'SDK sends every private read as a GET and every write as a POST');
    });
  }

  it('reaches every REST constant the SDK declares', () => {
    // Guards against silent drift: if a FuturesPath constant is renamed or
    // dropped in the SDK, this is the test that notices.
    const covered = new Set(ENDPOINTS.map(e => e.sdk).filter(Boolean));
    for (const key of TPSL_ORDER_ENDPOINTS.map(e => e.sdk)) covered.add(key);
    const missing = Object.keys(SDK_PATHS).filter(key => !covered.has(key));
    assert.deepEqual(missing, [], 'every SDK FuturesPath REST constant must be exercised');
  });

  it('signs the private endpoints and leaves the public market ones unsigned', async () => {
    const calls = stubFetch();
    const c = client();
    await c.getAccount('USDT');
    await c.getTickers('BTCUSDT');
    assert.ok(calls[0].headers.sign, 'account is a signed SDK call');
    assert.equal(calls[0].headers['api-key'], 'test-api-key');
    assert.equal(calls[1].headers.sign, undefined, 'tickers is FuturesPublicApiClient#getTickers — no signature');
    assert.equal(calls[1].headers['api-key'], undefined);
  });

  it('drops the symbol from get_order_detail, which the SDK accepts only orderId for', async () => {
    const calls = stubFetch();
    await client().getOrderDetail('o-1');
    assert.deepEqual(calls[0].query, { orderId: 'o-1' });
    assert.equal(calls[0].search.includes('symbol'), false);
  });

  it('sends symbol and marginCoin on get_leverage_margin_mode', async () => {
    const calls = stubFetch();
    await client().getLeverageAndMarginMode('BTCUSDT', 'USDT');
    assert.deepEqual(calls[0].query, { symbol: 'BTCUSDT', marginCoin: 'USDT' });
  });
});

// ---------------------------------------------------------------------------
// signing — SignUtils.generateSign + SHAUtils.encrypt, transcribed
// ---------------------------------------------------------------------------
function sdkSha256(...args) {
  // SHAUtils.encrypt: feed every non-empty argument into ONE digest, hex encoded.
  const hash = crypto.createHash('sha256');
  for (const arg of args) {
    if (arg !== null && arg !== undefined && arg !== '') hash.update(arg);
  }
  return hash.digest('hex');
}

function sdkGenerateSign({ nonce, timestamp, apiKey, params, httpBody, secretKey }) {
  // SignUtils.generateSign walks a TreeMap, i.e. keys already in ascending
  // order, skips the "sign" key, skips null/empty values, and concatenates
  // key+value with no separator.
  let queryString = '';
  for (const [key, value] of params) {
    if (key === 'sign') continue;
    if (value !== null && value !== undefined && value !== '') queryString += `${key}${value}`;
  }
  const baseSignStr = `${nonce}${timestamp}${apiKey}${queryString}`;
  return sdkSha256(sdkSha256(baseSignStr, httpBody) + secretKey);
}

function sortedEntries(params) {
  // TreeMap<String,String> ordering: natural String order, which is what
  // Object.keys().sort() gives for ASCII query keys.
  return Object.keys(params).sort().map(key => [key, params[key]]);
}

describe('bitunix REST contract: request signing (SignUtils.java)', () => {
  it('canonicalQuery concatenates sorted key+value pairs with no separator', () => {
    assert.equal(canonicalQuery({ symbol: 'BTCUSDT', marginCoin: 'USDT' }), 'marginCoinUSDTsymbolBTCUSDT');
    assert.equal(canonicalQuery({ b: '2', a: '1', c: '3' }), 'a1b2c3');
    assert.equal(canonicalQuery({}), '');
  });

  it('canonicalQuery skips null and empty values like SignUtils does', () => {
    assert.equal(canonicalQuery({ a: '', b: null, c: undefined, d: 'x' }), 'dx');
  });

  it('makeSign reproduces SignUtils.generateSign for a GET query', () => {
    const c = client();
    const params = { symbol: 'BTCUSDT', marginCoin: 'USDT', orderId: 'o-1' };
    const headers = c.makeSign('/api/v1/futures/trade/get_order_detail', '', params);
    assert.equal(headers.sign, sdkGenerateSign({
      nonce: headers.nonce,
      timestamp: headers.timestamp,
      apiKey: 'test-api-key',
      params: sortedEntries(params),
      httpBody: '',
      secretKey: 'test-api-secret',
    }));
  });

  it('makeSign reproduces SignUtils.generateSign for a POST body', () => {
    const c = client();
    const body = JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', qty: '1' });
    const headers = c.makeSign('/api/v1/futures/trade/place_order', body, {});
    assert.equal(headers.sign, sdkGenerateSign({
      nonce: headers.nonce,
      timestamp: headers.timestamp,
      apiKey: 'test-api-key',
      params: [],
      httpBody: body,
      secretKey: 'test-api-secret',
    }));
  });

  it('never puts the signature in the query string', async () => {
    const calls = stubFetch();
    await client().getPendingOrders('BTCUSDT', { limit: 5 });
    assert.equal(calls[0].search.includes('sign'), false, 'SignUtils skips the "sign" key, and so must the query we send');
    assert.equal(Object.hasOwn(calls[0].query, 'sign'), false);
    assert.ok(calls[0].headers.sign, 'it travels in the sign header instead');
  });

  it('sends the four signed headers the SDK sends', async () => {
    const calls = stubFetch();
    await client().getAccount('USDT');
    const headers = calls[0].headers;
    // SDK: Headers.of("sign", .., "timestamp", .., "nonce", .., "api-key", .., "Accept-Language", ..)
    assert.equal(headers['api-key'], 'test-api-key');
    assert.equal(typeof headers.nonce, 'string');
    assert.equal(typeof headers.timestamp, 'string');
    assert.equal(headers.sign.length, 64, 'sha256 hex');
  });

  it('agrees with a fixed-vector SignUtils computation', () => {
    const sign = sdkGenerateSign({
      nonce: 'abc',
      timestamp: '1700000000000',
      apiKey: 'key',
      params: [['marginCoin', 'USDT'], ['symbol', 'BTCUSDT']],
      httpBody: '',
      secretKey: 'secret',
    });
    assert.equal(sign.length, 64);
    // A different secret must change it — proves the secret is part of the digest.
    assert.notEqual(sign, sdkGenerateSign({
      nonce: 'abc',
      timestamp: '1700000000000',
      apiKey: 'key',
      params: [['marginCoin', 'USDT'], ['symbol', 'BTCUSDT']],
      httpBody: '',
      secretKey: 'other',
    }));
    // …and the body participates too.
    assert.notEqual(sign, sdkGenerateSign({
      nonce: 'abc',
      timestamp: '1700000000000',
      apiKey: 'key',
      params: [['marginCoin', 'USDT'], ['symbol', 'BTCUSDT']],
      httpBody: '{"a":1}',
      secretKey: 'secret',
    }));
  });
});

// ---------------------------------------------------------------------------
// enums — enums/*.java
// ---------------------------------------------------------------------------
describe('bitunix REST contract: wire enums (enums/*.java)', () => {
  it('TradeSide: OPEN and CLOSE reach the wire, and CLOSE needs a positionId', async () => {
    const calls = stubFetch();
    const c = client();
    await c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 'MARKET' });
    await c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 'MARKET', tradeSide: 'OPEN' });
    await c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 'MARKET', tradeSide: 'CLOSE', positionId: 'p-1' });
    assert.equal(calls[0].body.tradeSide, 'OPEN', 'the client sends an explicit tradeSide even when omitted');
    assert.equal(calls[1].body.tradeSide, 'OPEN');
    assert.equal(calls[2].body.tradeSide, 'CLOSE');
    assert.equal(calls[2].body.positionId, 'p-1');
    await assert.rejects(
      () => c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 'MARKET', tradeSide: 'CLOSE' }),
      /positionId/,
    );
    assert.equal(SDK_ENUMS.TradeSide.includes('HEDGE'), false, 'TradeSide is OPEN/CLOSE only');
  });

  it('OrderSide: accepts the SDK enum names and the upper-case wire value', async () => {
    const calls = stubFetch();
    const c = client();
    for (const side of [...SDK_ENUMS.OrderSide, 'BUY', 'SELL', 'buy', 'sell']) {
      await c.placeOrder({ symbol: 'BTCUSDT', side, qty: '1', orderType: 'MARKET' });
    }
    // DELIBERATE DIVERGENCE: the SDK enum is Buy/Sell, but PlaceOrderRequest#side
    // is a plain String and the SDK's own PlaceOrderTest sends "BUY", so the REST
    // wire value is upper case. We widen the input to both casings and always
    // send upper case — rejecting "Buy" would fail a caller that copied the enum
    // verbatim, and emitting "Buy" would be a guess on live trading.
    assert.deepEqual(calls.map(call => call.body.side), ['BUY', 'SELL', 'BUY', 'SELL', 'BUY', 'SELL']);
    await assert.rejects(
      () => c.placeOrder({ symbol: 'BTCUSDT', side: 'LONG', qty: '1', orderType: 'MARKET' }),
      /BUY or SELL/,
    );
  });

  it('OrderType: LIMIT and MARKET by name, never by the enum int', async () => {
    const calls = stubFetch();
    const c = client();
    for (const orderType of SDK_ENUMS.OrderType) {
      await c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType, price: '100' });
    }
    assert.deepEqual(calls.map(call => call.body.orderType), ['LIMIT', 'MARKET']);
    // DELIBERATE DIVERGENCE: OrderType has getType() 1/2, but Jackson serialises
    // the enum by name, so the REST body carries "LIMIT"/"MARKET", not 1/2.
    await assert.rejects(
      () => c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 1, price: '100' }),
      /orderType must be LIMIT or MARKET/,
    );
  });

  it('StopTriggerType: LAST_PRICE and MARK_PRICE are the only accepted trigger types', {
    skip: typeof client().placeTPSLOrder !== 'function' && 'placeTPSLOrder not implemented yet',
  }, async () => {
    const c = client();
    stubFetch();
    for (const stopType of SDK_ENUMS.StopTriggerType) {
      await c.placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', tpStopType: stopType, slStopType: stopType });
    }
    await assert.rejects(
      () => c.placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', tpStopType: 'INDEX_PRICE' }),
      /tpStopType must be LAST_PRICE or MARK_PRICE/,
    );
  });

  it('TpslOrderType: LIMIT and MARKET by name, never by the enum int', {
    skip: typeof client().placeTPSLOrder !== 'function' && 'placeTPSLOrder not implemented yet',
  }, async () => {
    const c = client();
    stubFetch();
    for (const orderType of SDK_ENUMS.TpslOrderType) {
      await c.placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', tpOrderType: orderType });
    }
    await assert.rejects(
      () => c.placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', tpOrderType: 2 }),
      /tpOrderType must be LIMIT or MARKET/,
    );
  });

  it('MarginMode: crossed/isolated normalise onto the SDK enum names', async () => {
    const calls = stubFetch();
    const c = client();
    await c.changeMarginMode('BTCUSDT', 'crossed');
    await c.changeMarginMode('BTCUSDT', 'isolated');
    await c.changeMarginMode('BTCUSDT', 'CROSS');
    await c.changeMarginMode('BTCUSDT', 'ISOLATION');
    assert.deepEqual([...new Set(calls.map(call => call.body.marginMode))].sort(), [...SDK_ENUMS.MarginMode].sort());
    assert.equal(calls.length, 4, 'all four accepted spellings were exercised');
    await assert.rejects(() => c.changeMarginMode('BTCUSDT', 'both'), /marginMode must be crossed or isolated/);
  });

  it('PositionMode: one-way/hedge normalise onto the SDK enum names', async () => {
    const calls = stubFetch();
    const c = client();
    await c.changePositionMode('one-way');
    await c.changePositionMode('hedge');
    await c.changePositionMode('ONE_WAY');
    await c.changePositionMode('HEDGE');
    assert.deepEqual([...new Set(calls.map(call => call.body.positionMode))].sort(), [...SDK_ENUMS.PositionMode].sort());
    assert.equal(calls.length, 4, 'all four accepted spellings were exercised');
    await assert.rejects(() => c.changePositionMode('net'), /positionMode must be one-way or hedge/);
  });

  it('PositionSide: LONG and SHORT are upper-cased on the wire', async () => {
    const calls = stubFetch();
    const c = client();
    for (const side of SDK_ENUMS.PositionSide) {
      await c.adjustPositionMargin('BTCUSDT', 1, { side: side.toLowerCase() });
    }
    assert.deepEqual(calls.map(call => call.body.side), SDK_ENUMS.PositionSide);
  });

  it('OrderStatus: every SDK status passes through a history filter unchanged', async () => {
    const calls = stubFetch();
    const c = client();
    for (const status of SDK_ENUMS.OrderStatus) {
      await c.getHistoryOrders('BTCUSDT', { status });
    }
    assert.deepEqual(calls.map(call => call.query.status), SDK_ENUMS.OrderStatus);
  });

  it('Effect: every SDK effect passes through place_order unchanged', async () => {
    const calls = stubFetch();
    const c = client();
    for (const effect of SDK_ENUMS.Effect) {
      await c.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: '1', orderType: 'LIMIT', price: '1', effect });
    }
    assert.deepEqual(calls.map(call => call.body.effect), SDK_ENUMS.Effect);
  });

  it('KlineInterval: accepts every value from KlineInterval.getValue()', async () => {
    const calls = stubFetch();
    const c = client();
    for (const interval of SDK_ENUMS.KlineInterval) {
      await c.getKlines('BTCUSDT', interval, 1);
    }
    assert.deepEqual(calls.map(call => call.query.interval), SDK_ENUMS.KlineInterval);
    // FuturesPublicApiClient#getKline sends klineType.name(), i.e. "LAST_PRICE",
    // not KlineType.getValue() which would be "last". We match the client.
    assert.equal(calls[0].query.type, 'LAST_PRICE');
  });

  it('DepthLevel: accepts the SDK counts, plus 50 and max from the REST docs', async () => {
    const calls = stubFetch();
    const c = client();
    for (const limit of SDK_ENUMS.DepthLevel) {
      await c.getDepth('BTCUSDT', limit);
    }
    await c.getDepth('BTCUSDT', '50');
    await c.getDepth('BTCUSDT', 'max');
    await c.getDepth('BTCUSDT');
    assert.deepEqual(calls.map(call => call.query.limit ?? '(omitted)'), ['1', '5', '15', '50', 'max', '(omitted)']);
    // DELIBERATE DIVERGENCE: DepthLevel only declares ONE/FIVE/FIFTEEN. The
    // REST docs add 50 and "max", so the client is a strict superset of the
    // enum rather than a copy of it.
    await assert.rejects(() => c.getDepth('BTCUSDT', '3'), /depth limit must be one of 1, 5, 15, 50, max/);
  });
});

// ---------------------------------------------------------------------------
// response unwrapping — response/*.java field names
// ---------------------------------------------------------------------------
// Field names transcribed from the SDK models.
const SDK_MODELS = {
  order: { orderId: 'o-1', marginCoin: 'USDT', symbol: 'BTCUSDT', qty: '1', tradeQty: '0', positionMode: 'HEDGE', marginMode: 'CROSS', leverage: 10, price: '100', avgPrice: '0', side: 'BUY', orderType: 'LIMIT', effect: 'GTC', clientId: 'c-1', reduceOnly: false, status: 'NEW', fee: '0', realizedPNL: '0', ctime: 1, mtime: 1 },
  trade: { tradeId: 't-1', orderId: 'o-1', marginCoin: 'USDT', symbol: 'BTCUSDT', qty: '1', positionMode: 'HEDGE', marginMode: 'CROSS', leverage: 10, price: '100', side: 'Buy', orderType: 'LIMIT', effect: 'GTC', clientId: 'c-1', reduceOnly: false, status: 'FILLED', fee: '0', realizedPNL: '0', ctime: 1, roleType: 'MAKER' },
  position: { positionId: 'p-1', symbol: 'BTCUSDT', marginCoin: 'USDT', maxQty: '10', qty: '1', entryPrice: '100', closePrice: '101', liqQty: '0', side: 'LONG', marginMode: 'CROSS', positionMode: 'HEDGE', leverage: 10, fee: '0', funding: '0', realizedPNL: '1', margin: '10', liqPrice: '50', ctime: 1, mtime: 1 },
  pendingPosition: { positionId: 'p-1', symbol: 'BTCUSDT', marginCoin: 'USDT', qty: '1', entryValue: '100', side: 'LONG', marginMode: 'CROSS', positionMode: 'HEDGE', leverage: 10, fee: '0', funding: '0', realizedPNL: '0', margin: '10', unrealizedPNL: '2', liqPrice: '50', avgOpenPrice: '100', marginRate: '0.1', ctime: 1, mtime: 1 },
  tpslPending: { id: 'tp-1', positionId: 'p-1', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', tpPrice: '110', tpStopType: 'LAST_PRICE', slPrice: '90', slStopType: 'MARK_PRICE', tpOrderType: 'LIMIT', tpOrderPrice: '111', slOrderType: 'MARKET', slOrderPrice: '0', tpQty: '0.5', slQty: '0.5' },
  tpslHistory: { id: 'tp-1', positionId: 'p-1', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', tpPrice: '110', tpStopType: 'LAST_PRICE', slPrice: '90', slStopType: 'MARK_PRICE', tpOrderType: 'LIMIT', tpOrderPrice: '111', slOrderType: 'MARKET', slOrderPrice: '0', tpQty: '0.5', slQty: '0.5', status: 'FILLED', ctime: 1, triggerTime: 2 },
  tradingPair: { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', basePrecision: '0.001', quotePrecision: '0.01', minTradeVolume: '0.001', maxMarketOrderVolume: '100', maxLimitOrderVolume: '100', maxLeverage: 125 },
  positionTier: { symbol: 'BTCUSDT', minQty: '0', maxQty: '1', marginCoin: 'USDT', minLeverage: 1, maxLeverage: 10, maintenanceMarginRate: '0.005' },
};

// ---------------------------------------------------------------------------
// response unwrapping — the SDK wraps lists in a CommonResult<T> page object
// ---------------------------------------------------------------------------
describe('bitunix REST contract: response unwrapping (response/*.java)', () => {
  it('getHistoryOrders unwraps OrderPageResp.orderList', async () => {
    stubFetch({ dataFor: () => ({ total: 2, orderList: [SDK_MODELS.order, { ...SDK_MODELS.order, orderId: 'o-2' }] }) });
    const rows = await client().getHistoryOrders('BTCUSDT');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].orderId, 'o-1');
    assert.equal(rows[0].realizedPNL, '0', 'OrderResp keeps the SDK field names');
    assert.equal(rows[0].positionMode, 'HEDGE');
  });

  it('getHistoryTrades unwraps TradePageResp.tradeList', async () => {
    stubFetch({ dataFor: () => ({ total: 1, tradeList: [SDK_MODELS.trade] }) });
    const rows = await client().getHistoryTrades('BTCUSDT');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tradeId, 't-1');
    assert.equal(rows[0].roleType, 'MAKER', 'TradeResp is the only model with roleType');
  });

  it('getHistoryPositions unwraps PositionHistoryPageResp.positionList', async () => {
    stubFetch({ dataFor: () => ({ total: 1, positionList: [SDK_MODELS.position] }) });
    const rows = await client().getHistoryPositions('BTCUSDT');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].positionId, 'p-1');
    assert.equal(rows[0].realizedPNL, '1');
    assert.equal(rows[0].liqQty, '0');
  });

  it('getHistoryTPSL unwraps TpslHistoryOrdersPageResp.orderList', async () => {
    stubFetch({ dataFor: () => ({ total: 1, orderList: [SDK_MODELS.tpslHistory] }) });
    const rows = await client().getHistoryTPSL('BTCUSDT');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'tp-1', 'TpslHistoryOrderResp identifies itself with id, not orderId');
    assert.equal(rows[0].status, 'FILLED');
    assert.equal(rows[0].triggerTime, 2);
  });

  it('getPendingPositions returns the bare ArrayList<PositionPendingResp>', async () => {
    stubFetch({ dataFor: () => [SDK_MODELS.pendingPosition] });
    const rows = await client().getPendingPositions('BTCUSDT');
    assert.ok(Array.isArray(rows), 'the SDK returns a bare list here, not a page object');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unrealizedPNL, '2');
    assert.equal(rows[0].avgOpenPrice, '100');
    assert.equal(rows[0].marginRate, '0.1');
  });

  it('getPendingTPSL returns the bare ArrayList<TpslPendingOrderResp>', async () => {
    stubFetch({ dataFor: () => [SDK_MODELS.tpslPending] });
    const rows = await client().getPendingTPSL('BTCUSDT');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'tp-1', 'the id feeds cancelTPSL as the orderId');
    assert.equal(rows[0].tpQty, '0.5');
  });

  it('getPendingOrders unwraps OrderPageResp.orderList', async () => {
    stubFetch({ dataFor: () => ({ total: 1, orderList: [SDK_MODELS.order] }) });
    const rows = await client().getPendingOrders('BTCUSDT');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clientId, 'c-1');
  });

  it('getTradingPairs and getPositionTiers return the bare ArrayList the SDK returns', async () => {
    stubFetch({ dataFor: path => (path.endsWith('trading_pairs') ? [SDK_MODELS.tradingPair] : [SDK_MODELS.positionTier]) });
    const pairs = await client().getTradingPairs('BTCUSDT');
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].maxLeverage, 125, 'trading_pairs carries the precision metadata callers need');
    const tiers = await client().getPositionTiers('BTCUSDT');
    assert.equal(tiers.length, 1);
    assert.equal(tiers[0].maintenanceMarginRate, '0.005');
  });

  it('getAccount picks the requested marginCoin out of the list form', async () => {
    stubFetch({ dataFor: () => [{ marginCoin: 'USDC', available: '1' }, { marginCoin: 'USDT', available: '2' }] });
    const account = await client().getAccount('USDT');
    assert.equal(account.available, '2');
  });
});

// ---------------------------------------------------------------------------
// error handling — CommonResult.isOk() is false for any non-zero code
// ---------------------------------------------------------------------------
describe('bitunix REST contract: error handling (CommonResult.java)', () => {
  it('throws on a non-2xx HTTP response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
    await assert.rejects(() => client().getAccount('USDT'), /502.*bad gateway/);
  });

  it('throws on a non-2xx HTTP response with no body', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
    await assert.rejects(() => client().getAccount('USDT'), /401/);
  });

  it('throws when the envelope carries a non-zero code', async () => {
    stubFetch({ payload: { code: 10001, msg: 'api key invalid', data: null } });
    await assert.rejects(() => client().getAccount('USDT'), /rejected: 10001 api key invalid/);
  });

  it('throws when data is null', async () => {
    stubFetch({ payload: { code: 0, msg: 'success', data: null } });
    await assert.rejects(() => client().getAccount('USDT'), /returned no data/);
  });

  it('throws when data is absent entirely', async () => {
    stubFetch({ payload: { code: 0, msg: 'success' } });
    await assert.rejects(() => client().getAccount('USDT'), /returned no data/);
  });

  it('accepts code "0" as success, matching CommonResult.isOk()', async () => {
    stubFetch({ payload: { code: '0', msg: 'success', data: { marginCoin: 'USDT' } } });
    assert.deepEqual(await client().getAccount('USDT'), { marginCoin: 'USDT' });
  });
});

// ---------------------------------------------------------------------------
// order-level TP/SL — the two endpoints a teammate is adding.
//
// They are written defensively: `missing()` yields a skip reason while the
// method is absent, so the suite stays green before the api-client change
// lands and starts asserting the real thing the moment it does.
// ---------------------------------------------------------------------------
function missing(method) {
  return typeof client()[method] !== 'function' ? `${method} not implemented yet` : false;
}

describe('bitunix REST contract: order-level TP/SL endpoints', () => {
  for (const entry of TPSL_ORDER_ENDPOINTS) {
    it(`${entry.name} sends POST ${expectedPath(entry)}`, { skip: missing(entry.name) }, async () => {
      const calls = stubFetch();
      await entry.run(client());
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'POST');
      assert.equal(calls[0].path, expectedPath(entry), 'path must match the SDK FuturesPath constant byte for byte');
      assert.ok(calls[0].headers.sign, 'the order-level TP/SL endpoints are signed');
    });
  }

  it('placeTPSLOrder is the order-level pair, not the position-level one', { skip: missing('placeTPSLOrder') }, async () => {
    const calls = stubFetch();
    await client().placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', slPrice: '90', tpOrderType: 'LIMIT', slOrderType: 'MARKET' });
    // FuturesPath has both /tpsl/place_order and /tpsl/position/place_order; the
    // first is the one that carries tpQty/slQty (a partial exit), the second is
    // the whole-position pair. Mixing them up silently trades the wrong size.
    assert.equal(calls[0].path, '/api/v1/futures/tpsl/place_order');
    assert.notEqual(calls[0].path, '/api/v1/futures/tpsl/position/place_order');
    assert.equal(calls[0].body.tpOrderType, 'LIMIT');
  });

  it('placeTPSLOrder requires a symbol and at least one stop price', { skip: missing('placeTPSLOrder') }, async () => {
    stubFetch();
    const c = client();
    await assert.rejects(() => c.placeTPSLOrder({ tpPrice: '110' }), /requires a symbol/);
    await assert.rejects(() => c.placeTPSLOrder({ symbol: 'BTCUSDT' }), /at least one of tpPrice or slPrice/);
  });

  it('placeTPSLOrder keeps the partial-exit quantities the SDK models', { skip: missing('placeTPSLOrder') }, async () => {
    const calls = stubFetch();
    await client().placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', tpQty: '0.4' });
    assert.equal(calls[0].body.tpQty, '0.4');
    await assert.rejects(
      () => client().placeTPSLOrder({ symbol: 'BTCUSDT', tpPrice: '110', tpQty: '-1' }),
      /tpQty must be a positive partial quantity/,
    );
  });

  it('modifyTPSLOrder is keyed by orderId, never by positionId', { skip: missing('modifyTPSLOrder') }, async () => {
    const calls = stubFetch();
    const c = client();
    await assert.rejects(() => c.modifyTPSLOrder({ positionId: 'p-1', tpPrice: '120' }), /requires orderId/);
    await c.modifyTPSLOrder({ orderId: 'tp-1', tpPrice: '120' });
    assert.equal(calls[0].path, '/api/v1/futures/tpsl/modify_order');
    assert.equal(calls[0].body.orderId, 'tp-1');
  });

  it('cancelTPSL takes the id from getPendingTPSL unchanged', async () => {
    const calls = stubFetch({ dataFor: path => (path.endsWith('/tpsl/get_pending_orders') ? [SDK_MODELS.tpslPending] : []) });
    const c = client();
    const pending = await c.getPendingTPSL('BTCUSDT');
    await c.cancelTPSL('BTCUSDT', pending[0].id);
    assert.equal(calls[1].path, '/api/v1/futures/tpsl/cancel_order');
    assert.equal(calls[1].body.orderId, 'tp-1');
  });
});

// ---------------------------------------------------------------------------
// the demo script itself — it must stay safe by default
// ---------------------------------------------------------------------------
const DEMO = fileURLToPath(new URL('../scripts/api-demo.js', import.meta.url));

function runDemo(args, env = {}) {
  return spawnSync(process.execPath, [DEMO, ...args], {
    encoding: 'utf8',
    // Credentials are forced empty so the child can never reach a real account.
    env: { ...process.env, BITUNIX_API_KEY: '', BITUNIX_API_SECRET: '', BITUNIX_DEMO_TRADE: '', BITUNIX_DEMO_CLOSE: '', BITUNIX_DEMO_PUBLIC: '', ...env },
  });
}

describe('bitunix api demo script (scripts/api-demo.js)', () => {
  it('--list exits 0 without credentials and names every SDK endpoint', () => {
    const run = runDemo(['--list']);
    assert.equal(run.status, 0, run.stderr);
    for (const path of Object.values(SDK_PATHS)) {
      assert.ok(run.stdout.includes(path), `--list must print ${path}`);
    }
    assert.ok(run.stdout.includes('read'), 'and mark which calls are read-only');
    assert.ok(run.stdout.includes('trade'), 'and which ones mutate');
  });

  it('--dry-run exits 0 and shows the method, query and body of every request', () => {
    const run = runDemo(['--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('requests to network : 0'));
    assert.match(run.stdout, /url\s+: https:\/\/[^ ]+\/api\/v1\/futures\/market\/kline\?symbol=BTCUSDT&interval=15m/);
    assert.ok(run.stdout.includes('"symbol":"BTCUSDT"'), 'and the POST body');
    // Every catalogue entry must be described, not skipped. The two order-level
    // TP/SL entries are the exception while those methods are still landing.
    const allImplemented = !missing('placeTPSLOrder') && !missing('modifyTPSLOrder');
    assert.equal(run.stdout.includes('SKIPPED'), !allImplemented, 'a dry run must describe every endpoint, not skip any');
  });

  it('exits 0 with no credentials and sends nothing', () => {
    const run = runDemo([]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /no Bitunix credentials found/);
    assert.equal(/SUMMARY/.test(run.stdout), false, 'it must not start a live run it cannot perform');
  });
});



// ---------------------------------------------------------------------------
// Order units and the four take-profit / stop-loss methods.
//
// Sources:
//  - order units: help centre id=170, "Explanation of the Order Units in
//    Futures Trading" (nominal / cost / qty).
//  - four methods: help centre id=290, "Bitunix Futures Position: A Guide to
//    Four Take-Profit and Stop-Loss Methods (Web)". The article id is 290, not
//    29 — the id=29 link 404s.
// ---------------------------------------------------------------------------

describe('order units (help centre id=170)', () => {
  // The article's worked example: BTCUSDT, price 10000, leverage 10.
  const PRICE = 10000;
  const LEVERAGE = 10;
  const nominalTo = (v) => convert({ value: v, from: 'nominal', to: 'cost', price: PRICE, leverage: LEVERAGE });
  const costTo = (v) => convert({ value: v, from: 'cost', to: 'qty', price: PRICE, leverage: LEVERAGE });
  const qtyTo = (v) => convert({ value: v, from: 'qty', to: 'nominal', price: PRICE, leverage: LEVERAGE });

  it('reproduces the article example in every direction', () => {
    assert.equal(nominalTo(1000), 100, 'cost = nominal / leverage');
    assert.equal(convert({ value: 1000, from: 'nominal', to: 'qty', price: PRICE, leverage: LEVERAGE }), 0.1, 'qty = nominal / price');
    assert.equal(costTo(1000), 1, 'qty = cost * leverage / price');
    assert.equal(qtyTo(1), 10000, 'nominal = qty * price');
    assert.equal(convert({ value: 1, from: 'qty', to: 'cost', price: PRICE, leverage: LEVERAGE }), 1000, 'cost = qty * price / leverage');
    assert.equal(convert({ value: 1000, from: 'cost', to: 'nominal', price: PRICE, leverage: LEVERAGE }), 10000, 'nominal = cost * leverage');
  });

  it('normalises the spellings the docs and users actually use', () => {
    for (const alias of ['nominal', 'notional', 'amount', 'contracts', 'NOMINAL_VALUE']) {
      assert.equal(normalizeUnit(alias), 'nominal', alias);
    }
    for (const alias of ['cost', 'margin', 'cost_value']) {
      assert.equal(normalizeUnit(alias), 'cost', alias);
    }
    for (const alias of ['qty', 'quantity', 'coins', 'size', 'QUANTITY_UNIT']) {
      assert.equal(normalizeUnit(alias), 'qty', alias);
    }
    assert.throws(() => normalizeUnit('leverage'), /unknown order unit/);
  });

  it('rejects values that would silently produce a wrong order', () => {
    assert.throws(() => convert({ value: 0, from: 'nominal', to: 'cost', price: PRICE, leverage: LEVERAGE }), /positive/);
    assert.throws(() => convert({ value: 1, from: 'nope', to: 'cost', price: PRICE, leverage: LEVERAGE }), /unknown order unit/);
    assert.throws(() => convert({ value: 1, from: 'nominal', to: 'cost', price: 0, leverage: LEVERAGE }), /price/);
    assert.throws(() => convert({ value: 1, from: 'nominal', to: 'cost', price: PRICE, leverage: 200 }), /1-125/);
    assert.throws(() => convert({ value: 1, from: 'nominal', to: 'cost', price: PRICE, leverage: 2.5 }), /integer/);
  });

  it('floors qty to basePrecision and never rounds up past the balance', () => {
    const pair = { basePrecision: 3, quotePrecision: 1 };
    // 1000 USDT * 2% * 10x / 10000 = 0.02 exactly; 0.0005 floors away.
    assert.equal(roundQty(0.0005, pair), 0);
    assert.equal(roundQty(0.0009, pair), 0);
    assert.equal(roundQty(0.0019999, pair), 0.001, 'must floor, not round to 0.002');
    assert.equal(roundQty(1.23456, pair), 1.234);
  });

  it('enforces the exchange min and max order volumes', () => {
    const pair = { basePrecision: 3, minTradeVolume: 0.001, maxMarketOrderVolume: 10 };
    const base = { unit: 'cost', price: PRICE, leverage: LEVERAGE, pair };
    assert.equal(positionSizeFromUnit({ available: 0.001, marginPct: 2, ...base }).ok, false);
    assert.equal(positionSizeFromUnit({ available: 0.001, marginPct: 2, ...base }).reason, 'qty_rounded_to_zero');
    const tooBig = positionSizeFromUnit({ available: 1e9, marginPct: 100, ...base });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, 'above_max_order_volume');
    const ok = positionSizeFromUnit({ available: 1000, marginPct: 2, ...base });
    assert.equal(ok.ok, true);
    assert.equal(ok.qty, 0.02, '1000 * 2% * 10 / 10000');
  });
});

describe('four take-profit / stop-loss methods (help centre id=290)', () => {
  const LONG = { side: 'BUY' };

  it('offers exactly the four documented methods and fails safe to position', () => {
    assert.deepEqual([...TPSL_METHODS], ['position', 'partial', 'trailing', 'account']);
    assert.equal(normalizeMethod('Trailing'), 'trailing');
    assert.equal(normalizeMethod('account'), 'account');
    // An unknown or missing setting must never leave a position unprotected.
    assert.equal(normalizeMethod('bogus'), 'position');
    assert.equal(normalizeMethod(undefined), 'position');
  });

  it('method 1 position: a single TP/SL pair for the whole position', () => {
    const levels = computeTpsl(100, 'bullish', 5, 80);
    assert.ok(levels.tpPrice > 100, 'TP is above entry on a long');
    assert.ok(levels.slPrice < 100, 'SL is below entry on a long');
    assert.equal(levels.tpStopType, 'MARK_PRICE');
    assert.equal(levels.slStopType, 'MARK_PRICE');
  });

  it('method 2 partial: the ladder closes the position in stages and never over-closes', () => {
    // Article example shape: 30% then 40%, remainder rides on.
    const ladder = buildPartialLadder({
      position: { qty: '1.234', basePrecision: 3 },
      entryPrice: 100, direction: 'bullish', atr: 5, confidence: 80,
      fractions: [0.3, 0.4, 0.3], steps: [1, 2, 3],
    });
    assert.equal(ladder.legs.length, 3);
    // Quantities are in integer base-precision ticks, so the parts plus the
    // remainder must reconstruct the position exactly — no dust left naked.
    const total = ladder.legs.reduce((sum, leg) => sum + leg.qty, 0) + ladder.remainder;
    assert.ok(Math.abs(total - 1.234) < 1e-9, `parts+remainder ${total} != 1.234`);
    // Each further step sits further from entry, so the ladder climbs.
    const distances = ladder.legs.map(leg => Number(leg.tpPrice) - 100);
    for (let i = 1; i < distances.length; i += 1) {
      assert.ok(distances[i] > distances[i - 1], 'later steps must target further out');
    }
    assert.throws(() => validateLadder([0.8, 0.8], [1, 2]), /must not sum above 1/);
    assert.throws(() => validateLadder([0.5], [1, 2]), /matching ladder arrays/);
  });

  it('method 3 trailing: arms at activation, then fires on a retrace from the peak', () => {
    // Article example: long, activation reached, price runs to 70000 then drops
    // to 63000 = a 10% callback -> exit.
    const trail = (state, mark, favorableRoi) => evaluateTrailingCallback({
      side: LONG.side, mark, favorableRoi, triggerRoiPct: 25, callbackPct: 10, previous: state,
    });
    let state = { peak: 52000, armed: false, activatedAt: 0 };
    state = trail(state, 60000, 20);
    assert.equal(state.armed, false, '20% ROI is below the 25% activation');
    assert.equal(state.skipped, 'activation not reached');

    // The arming tick must adopt the current mark as the peak. Regression: an
    // earlier version kept the pre-activation peak, so the retrace was measured
    // from a stale high and the exit fired early, locking in less profit.
    state = trail(state, 70000, 40);
    assert.equal(state.armed, true);
    assert.equal(state.peak, 70000, 'peak must include the mark that armed it');

    state = trail(state, 66500, 33);
    assert.equal(state.triggered, undefined, 'a 5% retrace is not a 10% callback');
    assert.equal(state.peak, 70000, 'the peak must not fall while tracking');

    state = trail(state, 63000, 26);
    assert.equal(state.triggered, true, 'a 10% retrace from 70000 is 63000');
    assert.equal(state.callbackPrice, 63000);
  });

  it('method 3 trailing: shorts mirror it on a rebound from the trough', () => {
    const trail = (state, mark, favorableRoi) => evaluateTrailingCallback({
      side: 'SELL', mark, favorableRoi, triggerRoiPct: 25, callbackPct: 10, previous: state,
    });
    let state = { peak: 9000, armed: false, activatedAt: 0 };
    state = trail(state, 8000, 40);
    assert.equal(state.armed, true);
    assert.equal(state.peak, 8000, 'a short tracks the trough it armed at');
    state = trail(state, 8400, 33);
    assert.equal(state.triggered, undefined, 'a 5% rebound is not a 10% callback');
    state = trail(state, 8800, 26);
    assert.equal(state.triggered, true, 'a 10% rebound from 8000 is 8800');
  });

  it('method 4 account: aggregates PnL across every open position', () => {
    const byExchange = accountPnlSummary([
      { side: 'BUY', qty: '1', unrealizedPNL: '50', margin: '100' },
      { side: 'SELL', qty: '1', unrealizedPNL: '-20', margin: '100' },
    ]);
    assert.equal(byExchange.totalPnl, 30, '50 - 20 across both positions');
    assert.equal(byExchange.totalMargin, 200);
    assert.equal(byExchange.roi, 15, '30 / 200');

    // Falls back to deriving PnL when the exchange does not send it.
    const derived = accountPnlSummary([
      { side: 'BUY', qty: '1', avgPrice: '100', markPrice: '110', leverage: 10, margin: '100' },
    ]);
    assert.equal(derived.totalPnl, 10, '(110 - 100) * 1');
    assert.equal(derived.roi, 10);
    assert.equal(accountPnlSummary([]).roi, 0);
  });
});

// ---------------------------------------------------------------------------
// Regression: live orders were rejected with
//   "10002 Parameter error" on POST /futures/trade/place_order.
//
// Cause: the scanner returns a raw market price (e.g. 116543.2187) and the
// order body echoed it as a 4-decimal string, but the live BTCUSDT pair has
// quotePrecision 1. Bitunix rejects any price carrying more decimals than
// quotePrecision, and reports it only as an opaque 10002. The same flaw sat in
// the TP/SL levels, which were formatted with a hard-coded toFixed(8).
// ---------------------------------------------------------------------------

describe('order precision matches the live pair metadata', () => {
  // Exactly what trading_pairs returns for BTCUSDT.
  const BTCUSDT = {
    symbol: 'BTCUSDT',
    minTradeVolume: 0.0001,
    basePrecision: 4,
    quotePrecision: 1,
    maxLimitOrderVolume: 1200,
    maxMarketOrderVolume: 120,
  };
  const SCANNER_PRICE = 116543.2187;
  const decimals = (value) => {
    const parts = String(value).split('.');
    return parts[1] ? parts[1].length : 0;
  };

  it('rounds a raw scanner price onto the pair tick', () => {
    assert.equal(String(roundPrice(SCANNER_PRICE, BTCUSDT)), '116543.2');
    assert.ok(decimals(roundPrice(SCANNER_PRICE, BTCUSDT)) <= BTCUSDT.quotePrecision);
  });

  it('formats TP/SL levels at quotePrecision, not a hard-coded 8dp', () => {
    // Regression: the old formatPrice always used toFixed(8), so a 1dp pair
    // produced 4dp stop levels and the same 10002 rejection.
    assert.equal(formatPrice(SCANNER_PRICE, 1), '116543.2');
    assert.equal(formatPrice(SCANNER_PRICE + 1380.0004, 1), '117923.2');
    // The default is still permissive for callers without pair metadata, and
    // must never emit exponent notation the exchange cannot parse.
    assert.equal(formatPrice(0.00000001), '0.00000001');
    assert.equal(formatPrice(1e-8, 8), '0.00000001');
    assert.equal(formatQty(0.00000001), '0.00000001');
  });

  it('keeps every price on an order inside quotePrecision', () => {
    const pm = new PositionManager({}, null, { symbol: 'BTCUSDT' });
    const levels = pm.computeTPSL(116543.2, 'bullish', 500, 80, BTCUSDT.quotePrecision);
    for (const field of ['tpPrice', 'slPrice']) {
      assert.ok(decimals(levels[field]) <= BTCUSDT.quotePrecision,
        `${field} ${levels[field]} exceeds quotePrecision ${BTCUSDT.quotePrecision}`);
    }
  });

  it('rejects a malformed order locally, naming the offending field', () => {
    // The pre-fix body: raw price, no effect check.
    assert.throws(() => traderReject({
      symbol: 'BTCUSDT', side: 'BUY', price: '116543.2187', qty: '0.02',
      orderType: 'LIMIT', effect: 'GTC',
      tpPrice: '117923.2187', slPrice: '115948.2187',
    }, BTCUSDT), /quotePrecision/);
  });

  it('caps volume by the order type actually sent', () => {
    // 500 is legal for a LIMIT (cap 1200) but illegal for a MARKET (cap 120),
    // so the guard must use the cap that matches the order type being sent.
    const base = { symbol: 'BTCUSDT', side: 'BUY', price: '116543.2', qty: '500', effect: 'GTC' };
    assert.throws(() => traderReject({ ...base, orderType: 'MARKET' }, BTCUSDT), /maxMarketOrderVolume/);
    assert.doesNotThrow(() => traderReject({ ...base, orderType: 'LIMIT' }, BTCUSDT));
  });

  it('requires an effect on a LIMIT order', () => {
    assert.throws(() => traderReject({
      symbol: 'BTCUSDT', side: 'BUY', price: '116543.2', qty: '0.02', orderType: 'LIMIT',
    }, BTCUSDT), /effect/);
  });

  it('keeps qty inside basePrecision and above minTradeVolume', () => {
    assert.throws(() => traderReject({
      symbol: 'BTCUSDT', side: 'BUY', price: '116543.2', qty: '0.00001', orderType: 'LIMIT', effect: 'GTC',
    }, BTCUSDT), /minTradeVolume/);
    assert.throws(() => traderReject({
      symbol: 'BTCUSDT', side: 'BUY', price: '116543.2', qty: '0.000012345', orderType: 'LIMIT', effect: 'GTC',
    }, BTCUSDT), /basePrecision/);
  });
});
