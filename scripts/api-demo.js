#!/usr/bin/env node
// scripts/api-demo.js — runnable tour of every Bitunix USDT-M REST endpoint the
// client exposes, ported from the official Java SDK demo/tests
// (github.com/qezawat-a/open-api, Demo/Java/src).
//
//   node scripts/api-demo.js --list       print the endpoint catalogue, no creds, no network
//   node scripts/api-demo.js --dry-run    print the exact request each call would send, no network
//   node scripts/api-demo.js              run the read-only calls that credentials allow
//   BITUNIX_DEMO_TRADE=1 node scripts/api-demo.js   also run the mutating calls
//
// Safety: nothing that places / modifies / cancels is ever called without an
// explicit opt-in, and the "close everything" calls need a second opt-in on top.
import { BitunixClient } from '../src/bitunix/client.js';
import { CONFIG } from '../src/config.js';

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------
const YES = ['1', 'true', 'yes', 'on'];
const argv = new Set(process.argv.slice(2));
const wantList = argv.has('--list') || argv.has('-l');
const wantDryRun = argv.has('--dry-run');
const wantHelp = argv.has('--help') || argv.has('-h');

const tradeEnabled = YES.includes(String(process.env.BITUNIX_DEMO_TRADE ?? '').toLowerCase());
const closeEnabled = YES.includes(String(process.env.BITUNIX_DEMO_CLOSE ?? '').toLowerCase());
const publicOnlyOk = YES.includes(String(process.env.BITUNIX_DEMO_PUBLIC ?? '').toLowerCase());
const marginAmount = process.env.BITUNIX_DEMO_MARGIN_AMOUNT ?? '';

const hasCreds = Boolean(CONFIG.BITUNIX_API_KEY) && Boolean(CONFIG.BITUNIX_API_SECRET);
const SYMBOL = String(process.env.BITUNIX_DEMO_SYMBOL || CONFIG.symbol || 'BTCUSDT').toUpperCase();
const MARGIN_COIN = 'USDT';
// A deliberately unreachable price: the live trade demo rests a POST_ONLY order
// here and cancels it again, so it can never be filled at a sane price.
const DEMO_PRICE = '1';

// ---------------------------------------------------------------------------
// catalogue
//
// Every entry mirrors one endpoint. `sdk` is the Java class#method it was
// ported from ("—" where the SDK has no equivalent: position_mode and
// get_funding_rate_history are Bitunix-doc endpoints the SDK does not wrap,
// and getErrorCode is a local helper that makes no request at all).
// ---------------------------------------------------------------------------
const CATALOG = [
  // --- public market data (no credentials, no signature) -------------------
  {
    name: 'getTradingPairs(symbols)',
    method: 'GET',
    path: '/api/v1/futures/market/trading_pairs',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPublicApiClient#getTradingPairs',
    invoke: client => client.getTradingPairs(SYMBOL),
  },
  {
    name: 'getTickers(symbol)',
    method: 'GET',
    path: '/api/v1/futures/market/tickers',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPublicApiClient#getTickers',
    invoke: client => client.getTickers(SYMBOL),
  },
  {
    name: 'getKlines(symbol, interval, limit, startTime, endTime, type)',
    method: 'GET',
    path: '/api/v1/futures/market/kline',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPublicApiClient#getKline',
    invoke: client => client.getKlines(SYMBOL, '15m', 2),
  },
  {
    name: 'getDepth(symbol, limit)',
    method: 'GET',
    path: '/api/v1/futures/market/depth',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPublicApiClient#getDepth',
    invoke: client => client.getDepth(SYMBOL, '5'),
  },
  {
    name: 'getFundingRate(symbol)',
    method: 'GET',
    path: '/api/v1/futures/market/funding_rate',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPublicApiClient#getFundingRate',
    invoke: client => client.getFundingRate(SYMBOL),
  },
  {
    name: 'getFundingRateBatch()',
    method: 'GET',
    path: '/api/v1/futures/market/funding_rate/batch',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPublicApiClient#getBatchFundingRate',
    invoke: client => client.getFundingRateBatch(),
  },
  {
    name: 'getFundingRateHistory(symbol, options)',
    method: 'GET',
    path: '/api/v1/futures/market/get_funding_rate_history',
    kind: 'read',
    auth: 'public',
    sdk: '— (Bitunix docs endpoint, not wrapped by the SDK)',
    invoke: client => client.getFundingRateHistory(SYMBOL, { limit: 2 }),
  },
  {
    name: 'getPositionTiers(symbol)',
    method: 'GET',
    path: '/api/v1/futures/position/get_position_tiers',
    kind: 'read',
    auth: 'public',
    sdk: 'FuturesPrivateApiClient#getPositionTiers',
    invoke: client => client.getPositionTiers(SYMBOL),
  },

  // --- private account ----------------------------------------------------
  {
    name: 'getAccount(marginCoin)',
    method: 'GET',
    path: '/api/v1/futures/account',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getAccount',
    invoke: client => client.getAccount(MARGIN_COIN),
  },
  {
    name: 'getLeverageAndMarginMode(symbol, marginCoin)',
    method: 'GET',
    path: '/api/v1/futures/account/get_leverage_margin_mode',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getLeverageAndMarginMode',
    invoke: client => client.getLeverageAndMarginMode(SYMBOL, MARGIN_COIN),
  },
  {
    name: 'getPositionMode()',
    method: 'GET',
    path: '/api/v1/futures/account/position_mode',
    kind: 'read',
    auth: 'private',
    sdk: '— (Bitunix docs endpoint, not wrapped by the SDK)',
    invoke: client => client.getPositionMode(),
  },
  {
    name: 'getTradingSettings(symbols)',
    method: 'GET',
    path: '/api/v1/futures/account/trading_settings',
    kind: 'read',
    auth: 'private',
    sdk: '— (Bitunix docs endpoint, not wrapped by the SDK)',
    invoke: client => client.getTradingSettings(SYMBOL),
  },
  {
    name: 'assetQuery()',
    method: 'GET',
    path: '/api/v1/cp/asset/query',
    kind: 'read',
    auth: 'private',
    sdk: '— (Bitunix copy-trading docs endpoint, not wrapped by the SDK)',
    invoke: client => client.assetQuery(),
  },
  // --- private positions / orders (read) ----------------------------------
  {
    name: 'getPendingPositions(symbol)',
    method: 'GET',
    path: '/api/v1/futures/position/get_pending_positions',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getPendingPositions',
    invoke: client => client.getPendingPositions(SYMBOL),
    capture: (result, ctx) => {
      ctx.positions = result;
      // Keep the dry-run placeholder when the canned payload has no positionId.
      const first = Array.isArray(result) ? result[0] : null;
      if (first?.positionId) ctx.position = first;
      ctx.positionId = ctx.position?.positionId ?? ctx.positionId;
      ctx.positionSide = ctx.position?.side ?? ctx.positionSide;
    },
  },
  {
    name: 'getHistoryPositions(symbol, options)',
    method: 'GET',
    path: '/api/v1/futures/position/get_history_positions',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getHistoryPositions',
    invoke: client => client.getHistoryPositions(SYMBOL, { limit: 2 }),
  },
  {
    name: 'getPendingOrders(symbol, options)',
    method: 'GET',
    path: '/api/v1/futures/trade/get_pending_orders',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getPendingOrders',
    invoke: client => client.getPendingOrders(SYMBOL, { limit: 2 }),
  },
  {
    name: 'getOrderDetail(orderId)',
    method: 'GET',
    path: '/api/v1/futures/trade/get_order_detail',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getOrderDetail',
    invoke: (client, ctx) => client.getOrderDetail(ctx.orderId ?? '0'),
    needs: 'an orderId (falls back to 0 when the place step was skipped)',
  },
  {
    name: 'getHistoryOrders(symbol, options)',
    method: 'GET',
    path: '/api/v1/futures/trade/get_history_orders',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getHistoryOrders',
    invoke: client => client.getHistoryOrders(SYMBOL, { limit: 2 }),
  },
  {
    name: 'getHistoryTrades(symbol, options)',
    method: 'GET',
    path: '/api/v1/futures/trade/get_history_trades',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getHistoryTrades',
    invoke: client => client.getHistoryTrades(SYMBOL, { limit: 2 }),
  },
  {
    name: 'getPendingTPSL(symbol)',
    method: 'GET',
    path: '/api/v1/futures/tpsl/get_pending_orders',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getPendingTpslOrders',
    invoke: client => client.getPendingTPSL(SYMBOL),
    capture: (result, ctx) => {
      ctx.tpslOrders = result;
      // TpslPendingOrderResp identifies itself with `id`, not `orderId`.
      const first = Array.isArray(result) ? result[0] : null;
      ctx.tpslId = first?.id ?? ctx.tpslId;
    },
  },
  {
    name: 'getHistoryTPSL(symbol)',
    method: 'GET',
    path: '/api/v1/futures/tpsl/get_history_orders',
    kind: 'read',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#getHistoryTpslOrders',
    invoke: client => client.getHistoryTPSL(SYMBOL),
  },

  // --- account settings (mutating) ----------------------------------------
  {
    name: 'changePositionMode(positionMode)',
    method: 'POST',
    path: '/api/v1/futures/account/change_position_mode',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#changePositionMode',
    invoke: client => client.changePositionMode(CONFIG.position_mode),
  },
  {
    name: 'changeLeverage(symbol, leverage)',
    method: 'POST',
    path: '/api/v1/futures/account/change_leverage',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#changeLeverage',
    invoke: client => client.changeLeverage(SYMBOL, CONFIG.leverage),
  },
  {
    name: 'changeMarginMode(symbol, marginMode)',
    method: 'POST',
    path: '/api/v1/futures/account/change_margin_mode',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#changeMarginMode',
    invoke: client => client.changeMarginMode(SYMBOL, CONFIG.position_type),
  },
  {
    name: 'adjustPositionMargin(symbol, amount, options)',
    method: 'POST',
    path: '/api/v1/futures/account/adjust_position_margin',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#adjustPositionMargin',
    liveGuard: () => (marginAmount ? null : 'set BITUNIX_DEMO_MARGIN_AMOUNT=<usdt> to run'),
    // The '1' fallback only ever reaches the wire in --dry-run, where fetch is a
    // recorder; liveGuard keeps the real call out of reach without it.
    invoke: (client, ctx) => client.adjustPositionMargin(SYMBOL, marginAmount || '1', { side: ctx.positionSide ?? 'LONG' }),
  },

  // --- order lifecycle (mutating) -----------------------------------------
  {
    name: 'placeOrder(params)',
    method: 'POST',
    path: '/api/v1/futures/trade/place_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#placeOrder',
    invoke: async (client, ctx) => {
      const res = await client.placeOrder({
        symbol: SYMBOL,
        side: 'BUY',
        qty: '0.001',
        price: DEMO_PRICE,
        orderType: 'LIMIT',
        effect: 'POST_ONLY',
        clientId: `jrock-demo-${Date.now()}`,
      });
      ctx.orderId = res?.orderId ?? ctx.orderId;
      return res;
    },
  },
  {
    name: 'modifyOrder(params)',
    method: 'POST',
    path: '/api/v1/futures/trade/modify_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#modifyOrder',
    invoke: (client, ctx) => client.modifyOrder({ orderId: ctx.orderId ?? '0', price: '2' }),
  },
  {
    name: 'batchOrder(symbol, orderList)',
    method: 'POST',
    path: '/api/v1/futures/trade/batch_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#batchPlaceOrder',
    invoke: (client, ctx) => client.batchOrder(SYMBOL, [
      { side: 'BUY', qty: '0.001', price: DEMO_PRICE, orderType: 'LIMIT', effect: 'POST_ONLY' },
      { side: 'SELL', qty: '0.001', price: '999999', orderType: 'LIMIT', effect: 'POST_ONLY' },
    ]),
  },
  {
    name: 'cancelOrder(symbol, orderId, clientId)',
    method: 'POST',
    path: '/api/v1/futures/trade/cancel_orders',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#cancelOrders',
    invoke: (client, ctx) => client.cancelOrder(SYMBOL, ctx.orderId ?? '0'),
  },
  {
    name: 'cancelAllOrders(symbol)',
    method: 'POST',
    path: '/api/v1/futures/trade/cancel_all_orders',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#cancelAllOrders',
    invoke: client => client.cancelAllOrders(SYMBOL),
  },

  // --- position exits (mutating + irreversible) ---------------------------
  {
    name: 'closePosition(symbol, positionId, position)',
    method: 'POST',
    path: '/api/v1/futures/trade/place_order',
    kind: 'trade',
    auth: 'private',
    sdk: '— (composite: reads get_pending_positions, then places a reduceOnly MARKET)',
    close: true,
    liveGuard: ctx => (ctx.positionId ? null : 'no open position on this account to close'),
    invoke: (client, ctx) => client.closePosition(SYMBOL, ctx.positionId, ctx.position),
  },
  {
    name: 'closeAllPosition(symbol)',
    method: 'POST',
    path: '/api/v1/futures/trade/close_all_position',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#closeAllPosition',
    close: true,
    invoke: client => client.closeAllPosition(SYMBOL),
  },
  {
    name: 'flashClosePosition(positionId)',
    method: 'POST',
    path: '/api/v1/futures/trade/flash_close_position',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#flashClosePosition',
    close: true,
    liveGuard: ctx => (ctx.positionId ? null : 'no open position on this account to flash-close'),
    invoke: (client, ctx) => client.flashClosePosition(ctx.positionId),
  },

  // --- TP/SL (mutating) ---------------------------------------------------
  {
    name: 'placeTPSL(params)',
    method: 'POST',
    path: '/api/v1/futures/tpsl/position/place_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#placePositionTpslOrder',
    liveGuard: ctx => (ctx.positionId ? null : 'no open position to attach a position TP/SL to'),
    invoke: (client, ctx) => {
      const res = client.placeTPSL({ symbol: SYMBOL, positionId: ctx.positionId, tpPrice: '999999', slPrice: '1' });
      return res;
    },
  },
  {
    name: 'modifyTPSL(params)',
    method: 'POST',
    path: '/api/v1/futures/tpsl/position/modify_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#modifyPositionTpslOrder',
    liveGuard: ctx => (ctx.positionId ? null : 'no open position to modify a position TP/SL on'),
    invoke: (client, ctx) => client.modifyTPSL({ symbol: SYMBOL, positionId: ctx.positionId, tpPrice: '888888' }),
  },
  {
    name: 'placeTPSLOrder(params)',
    method: 'POST',
    path: '/api/v1/futures/tpsl/place_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#placeTpslOrders',
    // The docs mark positionId as required for place_tp_sl_order, so the same
    // "is there an open position" guard the position-level entries use applies.
    liveGuard: ctx => (ctx.positionId ? null : 'no open position to attach an order-level TP/SL to'),
    invoke: (client, ctx) => {
      const res = client.placeTPSLOrder({ symbol: SYMBOL, positionId: ctx.positionId, tpPrice: '999999', slPrice: '1', tpOrderType: 'LIMIT', slOrderType: 'MARKET' });
      return res;
    },
  },
  {
    name: 'modifyTPSLOrder(params)',
    method: 'POST',
    path: '/api/v1/futures/tpsl/modify_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#modifyTpslOrder',
    liveGuard: ctx => (ctx.tpslId ? null : 'no pending order-level TP/SL id to modify'),
    invoke: (client, ctx) => client.modifyTPSLOrder({ orderId: ctx.tpslId ?? '0', tpPrice: '777777' }),
  },
  {
    name: 'cancelTPSL(symbol, orderId)',
    method: 'POST',
    path: '/api/v1/futures/tpsl/cancel_order',
    kind: 'trade',
    auth: 'private',
    sdk: 'FuturesPrivateApiClient#cancelTpslOrders',
    liveGuard: ctx => (ctx.tpslId ? null : 'no pending order-level TP/SL id to cancel'),
    invoke: (client, ctx) => client.cancelTPSL(SYMBOL, ctx.tpslId ?? '0'),
  },

  // --- local helper, no HTTP at all ---------------------------------------
  {
    name: 'getErrorCode(code)',
    method: 'LOCAL',
    path: '(no request — returns the error-code doc link)',
    kind: 'read',
    auth: 'local',
    sdk: '— (no SDK equivalent)',
    invoke: client => client.getErrorCode(10001),
  },
];

// ---------------------------------------------------------------------------
// printing helpers
// ---------------------------------------------------------------------------
function pad(value, width) {
  return String(value).padEnd(width);
}

function printList() {
  const nameW = Math.max(...CATALOG.map(e => e.name.length));
  const pathW = Math.max(...CATALOG.map(e => e.path.length));
  const sdkW = Math.max(...CATALOG.map(e => e.sdk.length));
  console.log('Bitunix USDT-M REST endpoints exposed by src/bitunix/client.js');
  console.log(`${CATALOG.filter(e => e.method !== 'LOCAL').length} REST endpoints + 1 local helper, ported from the official Java SDK (Demo/Java/src).`);
  console.log('');
  console.log(`${pad('NODE METHOD', nameW)}  ${pad('METHOD', 6)}  ${pad('PATH', pathW)}  ${pad('KIND', 5)}  ${pad('CREDS', 7)}  SDK`);
  console.log(`${'-'.repeat(nameW)}  ${'-'.repeat(6)}  ${'-'.repeat(pathW)}  ${'-'.repeat(5)}  ${'-'.repeat(7)}  ${'-'.repeat(sdkW)}`);
  for (const e of CATALOG) {
    const creds = e.auth === 'public' ? 'no*' : e.auth === 'private' ? 'yes' : 'no';
    console.log(`${pad(e.name, nameW)}  ${pad(e.method, 6)}  ${pad(e.path, pathW)}  ${pad(e.kind, 5)}  ${pad(creds, 7)}  ${e.sdk}`);
  }
  console.log('');
  console.log('KIND  read  = safe, changes nothing');
  console.log('      trade = places / modifies / cancels something (needs BITUNIX_DEMO_TRADE=1)');
  console.log('CREDS yes   = signed, needs BITUNIX_API_KEY + BITUNIX_API_SECRET');
  console.log('      no*   = public market data, runs with no credentials');
  console.log('      no    = local helper, makes no request');
  console.log('');
  console.log('* the public market calls only run for real when BITUNIX_DEMO_PUBLIC=1 is set,');
  console.log('  so a bare `node scripts/api-demo.js` on a credential-less box never touches');
  console.log('  the network.');
}

function printHelp() {
  console.log(`Usage: node scripts/api-demo.js [mode]

  --list, -l      print every endpoint (method, path, read-only vs mutating,
                  credentials needed). Needs no credentials and makes no request.
  --dry-run       print the exact request each endpoint WOULD send (method, URL,
                  query, body). Makes no request at all.
  --help, -h      this text

Live run (no flags): executes the read-only calls the credentials allow.

Environment:
  BITUNIX_API_KEY / BITUNIX_API_SECRET   required for the signed (private) calls
  BITUNIX_DEMO_SYMBOL                    symbol to use (default: CONFIG.symbol)
  BITUNIX_DEMO_PUBLIC=1                  allow the public market calls to run with
                                        no credentials; without it a credential-less
                                        run makes zero network calls
  BITUNIX_DEMO_TRADE=1                   opt in to the mutating calls
  BITUNIX_DEMO_CLOSE=1                   extra opt in, on top of TRADE, for the
                                        irreversible position exits
  BITUNIX_DEMO_MARGIN_AMOUNT=<usdt>      amount for adjust_position_margin
                                        (skipped when unset)

Examples:
  node scripts/api-demo.js --list
  node scripts/api-demo.js --dry-run
  node scripts/api-demo.js
  BITUNIX_DEMO_PUBLIC=1 node scripts/api-demo.js
  BITUNIX_DEMO_TRADE=1 BITUNIX_DEMO_CLOSE=1 node scripts/api-demo.js`);
}

// ---------------------------------------------------------------------------
// dry run: real client code path, fetch replaced by a recorder
// ---------------------------------------------------------------------------
// A canned `{ code: 0, data: [...] }` envelope is enough for every unwrapping
// path in client.js (bare array, listFrom(...), getAccount's marginCoin match),
// so each entry runs end to end without a single packet leaving the box.
const CANNED_DATA = [{ marginCoin: MARGIN_COIN }];

function describeRequest(record) {
  const url = new URL(record.url);
  const lines = [`    url   : ${record.url}`];
  lines.push(`    method: ${record.method}`);
  lines.push(`    path  : ${url.pathname}`);
  lines.push(`    query : ${url.search ? url.search.slice(1) : '(none)'}`);
  lines.push(`    body  : ${record.body ?? '(none)'}`);
  return lines.join('\n');
}

async function runDryRun() {
  const realFetch = globalThis.fetch;
  // Placeholder ids so the endpoints that chain off a previous response still
  // print their request. Nothing here is ever sent.
  const ctx = {
    orderId: 'DRYRUN-ORDER',
    tpslId: 'DRYRUN-TPSL',
    positionId: 'DRYRUN-POSITION',
    positionSide: 'LONG',
    position: { symbol: SYMBOL, positionId: 'DRYRUN-POSITION', side: 'LONG', qty: '0.001', positionMode: 'HEDGE' },
  };
  const results = [];
  let intercepted = 0;

  globalThis.fetch = async (url, options = {}) => {
    intercepted += 1;
    const record = { url: String(url), method: options.method ?? 'GET', body: options.body ?? null };
    results.push(record);
    return { ok: true, json: async () => ({ code: 0, data: CANNED_DATA }) };
  };

  console.log('DRY RUN — showing the exact request each endpoint would send.');
  console.log('fetch is replaced by a recorder for the whole run: 0 requests reach the network.');
  console.log('');

  try {
    const client = new BitunixClient();
    let index = 0;
    for (const entry of CATALOG) {
      index += 1;
      const before = results.length;
      console.log(`[${index}/${CATALOG.length}] ${entry.name}`);
      console.log(`    kind : ${entry.kind}   auth: ${entry.auth}   sdk: ${entry.sdk}`);
      try {
        const result = await entry.invoke(client, ctx);
        if (entry.capture) entry.capture(result, ctx);
        if (results.length === before) {
          console.log('    (no request — local helper)');
        } else {
          console.log(describeRequest(results[results.length - 1]));
        }
        results.length = before;
      } catch (error) {
        console.log(`    SKIPPED: ${error.message}`);
        results.length = before;
      }
      console.log('');
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('DRY RUN SUMMARY');
  console.log(`  endpoints described : ${CATALOG.length}`);
  console.log(`  requests recorded   : ${intercepted} (all served by the stub fetch)`);
  console.log('  requests to network : 0');
  return true;
}

// ---------------------------------------------------------------------------
// live run
// ---------------------------------------------------------------------------
function skipReason(entry, ctx) {
  if (entry.auth === 'private' && !hasCreds) return 'no credentials (set BITUNIX_API_KEY / BITUNIX_API_SECRET)';
  if (entry.auth === 'public' && !hasCreds && !publicOnlyOk) return 'no credentials (set BITUNIX_DEMO_PUBLIC=1 to run public market data)';
  if (entry.kind === 'trade' && !tradeEnabled) return 'mutating call (set BITUNIX_DEMO_TRADE=1 to run)';
  if (entry.close && !closeEnabled) return 'irreversible exit (set BITUNIX_DEMO_CLOSE=1 as well)';
  if (entry.liveGuard) return entry.liveGuard(ctx);
  return null;
}

function summarise(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === 'object') return Object.keys(value).slice(0, 5).join(',') || 'object';
  return String(value).slice(0, 60);
}

async function runLive() {
  const ctx = {};
  const results = [];

  console.log('LIVE RUN');
  console.log(`  symbol      : ${SYMBOL}`);
  console.log(`  base url    : ${CONFIG.BITUNIX_BASE_URL}`);
  console.log(`  credentials : ${hasCreds ? `present (api-key ${String(CONFIG.BITUNIX_API_KEY).slice(0, 6)}…)` : 'NONE'}`);
  console.log(`  trade opt-in: ${tradeEnabled ? 'BITUNIX_DEMO_TRADE=1' : 'off'}`);
  console.log(`  close opt-in: ${closeEnabled ? 'BITUNIX_DEMO_CLOSE=1' : 'off'}`);
  console.log('');

  const client = new BitunixClient();
  for (const entry of CATALOG) {
    const reason = skipReason(entry, ctx);
    if (reason) {
      results.push({ entry, status: 'SKIP', detail: reason });
      continue;
    }
    try {
      const value = await entry.invoke(client, ctx);
      if (entry.capture) entry.capture(value, ctx);
      results.push({ entry, status: 'PASS', detail: summarise(value) });
    } catch (error) {
      results.push({ entry, status: 'FAIL', detail: error.message });
    }
  }

  console.log('SUMMARY');
  const nameW = Math.max(...results.map(r => r.entry.name.length));
  for (const r of results) {
    console.log(`  ${pad(r.status, 4)}  ${pad(r.entry.name, nameW)}  ${r.entry.method} ${r.entry.path}`);
    console.log(`        ${r.detail}`);
  }
  const passed = results.filter(r => r.status === 'PASS').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log('');
  console.log(`  ${passed} passed, ${skipped} skipped, ${failed} failed (of ${results.length})`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// entrypoint — never let a throw escape as an unhandled rejection
// ---------------------------------------------------------------------------
process.on('uncaughtException', error => {
  console.error(`api-demo: uncaught ${error?.stack || error}`);
  process.exitCode = 1;
});
process.on('unhandledRejection', error => {
  console.error(`api-demo: unhandled rejection ${error?.stack || error}`);
  process.exitCode = 1;
});

async function main() {
  if (wantHelp) {
    printHelp();
    return;
  }
  if (wantList) {
    printList();
    return;
  }
  if (wantDryRun) {
    await runDryRun();
    return;
  }
  if (!hasCreds && !publicOnlyOk) {
    console.log('api-demo: no Bitunix credentials found, so nothing will be sent.');
    console.log('');
    console.log('  set BITUNIX_API_KEY and BITUNIX_API_SECRET to exercise the signed endpoints,');
    console.log('  or set BITUNIX_DEMO_PUBLIC=1 to exercise the public market endpoints only.');
    console.log('  BITUNIX_DEMO_TRADE=1 additionally permits the mutating calls.');
    console.log('');
    console.log('  nothing to do here — for the endpoint list run: node scripts/api-demo.js --list');
    console.log('  for the exact requests run:          node scripts/api-demo.js --dry-run');
    return;
  }
  const ok = await runLive();
  if (!ok) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`api-demo: ${error?.stack || error}`);
  process.exitCode = 1;
}
