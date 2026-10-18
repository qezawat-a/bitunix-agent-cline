# Bitunix REST API demo (`scripts/api-demo.js`)

A runnable tour of **every** Bitunix USDT-M REST endpoint that
`src/bitunix/client.js` exposes, ported from the official Java SDK demo and
tests at [github.com/qezawat-a/open-api](https://github.com/qezawat-a/open-api)
(`Demo/Java/src`). Java is not installed in this environment, so the Java
sources are used as the *specification* and the demo/test flow is re-implemented
in Node against the same `FuturesPath` constants, the same `SignUtils` signing
algorithm and the same `response/*.java` field names.

It is safe by default: nothing that places, modifies or cancels is ever called
without an explicit opt-in, and with no credentials it makes **zero** network
calls.

```
npm run demo -- --list       # the endpoint catalogue, no credentials, no network
npm run demo -- --dry-run    # the exact request each call would send, no network
npm run demo                 # run the read-only calls the credentials allow
npm run demo -- --help
```

---

## 1. Running it

### `--list` — the catalogue

```bash
node scripts/api-demo.js --list
```

Prints every endpoint with its HTTP method, path, whether it is **read-only** or
**mutating**, whether it needs credentials, and the Java SDK class#method it was
ported from. Requires no credentials and makes no request.

### `--dry-run` — the exact requests

```bash
node scripts/api-demo.js --dry-run
```

Prints, for every endpoint, the full URL, method, path, query string and JSON
body that the request *would* send. It drives the real `BitunixClient` but
replaces `globalThis.fetch` with a recorder for the whole run, so the printed
request is byte-for-byte what would go on the wire and **0 requests reach the
network**. (Verified with `net.connect`/`dns.lookup` poisoned — the run still
exits 0 with no socket opened.)

```
[36/39] placeTPSLOrder(params)
    kind : trade   auth: private   sdk: FuturesPrivateApiClient#placeTpslOrders
    url   : https://fapi.bitunix.com/api/v1/futures/tpsl/place_order
    method: POST
    path  : /api/v1/futures/tpsl/place_order
    query : (none)
    body  : {"symbol":"BTCUSDT","positionId":"DRYRUN-POSITION","tpPrice":"999999","slPrice":"1","tpOrderType":"LIMIT","slOrderType":"MARKET"}
```

### Live run

```bash
node scripts/api-demo.js
```

Runs the read-only endpoints the credentials allow and prints a PASS / SKIP /
FAIL table at the end. `process.exitCode` is set to 1 if any call that was
actually attempted failed. Steps that chain off an earlier response (cancel an
order, modify a TP/SL) reuse the id the previous step returned, and are skipped
with a reason when that step did not run.

### Safety switches

| Variable | Default | Effect |
| --- | --- | --- |
| `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` | unset | required for the signed (private) endpoints |

## 2. Endpoint table

38 REST endpoints + 1 local helper. `CREDS: no*` = public market data,
`yes` = signed.

| Node method | HTTP | Path | Kind | Creds |
| --- | --- | --- | --- | --- |
| `getTradingPairs(symbols)` | GET | `/api/v1/futures/market/trading_pairs` | read | no* |
| `getTickers(symbol)` | GET | `/api/v1/futures/market/tickers` | read | no* |
| `getKlines(symbol, interval, limit, startTime, endTime, type)` | GET | `/api/v1/futures/market/kline` | read | no* |
| `getDepth(symbol, limit)` | GET | `/api/v1/futures/market/depth` | read | no* |
| `getFundingRate(symbol)` | GET | `/api/v1/futures/market/funding_rate` | read | no* |
| `getFundingRateBatch()` | GET | `/api/v1/futures/market/funding_rate/batch` | read | no* |
| `getFundingRateHistory(symbol, options)` | GET | `/api/v1/futures/market/get_funding_rate_history` | read | no* |
| `getPositionTiers(symbol)` | GET | `/api/v1/futures/position/get_position_tiers` | read | no* |
| `getAccount(marginCoin)` | GET | `/api/v1/futures/account` | read | yes |
| `getLeverageAndMarginMode(symbol, marginCoin)` | GET | `/api/v1/futures/account/get_leverage_margin_mode` | read | yes |
| `getPositionMode()` | GET | `/api/v1/futures/account/position_mode` | read | yes |
| `getTradingSettings(symbols)` | GET | `/api/v1/futures/account/trading_settings` | read | yes |
| `assetQuery()` | GET | `/api/v1/cp/asset/query` | read | yes |
| `getPendingPositions(symbol)` | GET | `/api/v1/futures/position/get_pending_positions` | read | yes |
| `getHistoryPositions(symbol, options)` | GET | `/api/v1/futures/position/get_history_positions` | read | yes |
| `getPendingOrders(symbol, options)` | GET | `/api/v1/futures/trade/get_pending_orders` | read | yes |
| `getOrderDetail(orderId)` | GET | `/api/v1/futures/trade/get_order_detail` | read | yes |
| `getHistoryOrders(symbol, options)` | GET | `/api/v1/futures/trade/get_history_orders` | read | yes |
| `getHistoryTrades(symbol, options)` | GET | `/api/v1/futures/trade/get_history_trades` | read | yes |
| `getPendingTPSL(symbol)` | GET | `/api/v1/futures/tpsl/get_pending_orders` | read | yes |
| `getHistoryTPSL(symbol)` | GET | `/api/v1/futures/tpsl/get_history_orders` | read | yes |
| `changePositionMode(positionMode)` | POST | `/api/v1/futures/account/change_position_mode` | trade | yes |
| `changeLeverage(symbol, leverage)` | POST | `/api/v1/futures/account/change_leverage` | trade | yes |
| `changeMarginMode(symbol, marginMode)` | POST | `/api/v1/futures/account/change_margin_mode` | trade | yes |
| `adjustPositionMargin(symbol, amount, options)` | POST | `/api/v1/futures/account/adjust_position_margin` | trade | yes |
| `placeOrder(params)` | POST | `/api/v1/futures/trade/place_order` | trade | yes |
| `modifyOrder(params)` | POST | `/api/v1/futures/trade/modify_order` | trade | yes |
| `batchOrder(symbol, orderList)` | POST | `/api/v1/futures/trade/batch_order` | trade | yes |
| `cancelOrder(symbol, orderId, clientId)` | POST | `/api/v1/futures/trade/cancel_orders` | trade | yes |
| `cancelAllOrders(symbol)` | POST | `/api/v1/futures/trade/cancel_all_orders` | trade | yes |
| `closePosition(symbol, positionId, position)` | POST | `/api/v1/futures/trade/place_order` | trade | yes |
| `closeAllPosition(symbol)` | POST | `/api/v1/futures/trade/close_all_position` | trade | yes |
| `flashClosePosition(positionId)` | POST | `/api/v1/futures/trade/flash_close_position` | trade | yes |
| `placeTPSL(params)` | POST | `/api/v1/futures/tpsl/position/place_order` | trade | yes |
| `modifyTPSL(params)` | POST | `/api/v1/futures/tpsl/position/modify_order` | trade | yes |
| `placeTPSLOrder(params)` | POST | `/api/v1/futures/tpsl/place_order` | trade | yes |
| `modifyTPSLOrder(params)` | POST | `/api/v1/futures/tpsl/modify_order` | trade | yes |
| `cancelTPSL(symbol, orderId)` | POST | `/api/v1/futures/tpsl/cancel_order` | trade | yes |
| `getErrorCode(code)` | — | no request, returns the error-code doc link | read | no |

`position_mode`, `get_funding_rate_history` and `trading_settings` are
documented by Bitunix but are **not** wrapped by the Java SDK, so they have no
`FuturesPath` constant. `cp/asset/query` is the copy-trading endpoint and is also
outside the SDK's futures surface.

---

## 3. Java SDK → Node mapping

### `FuturesPublicApiClient` (unsigned market data)

| Java | Node |
| --- | --- |
| `getTradingPairs()` / `getTradingPairs(Set<String>)` | `getTradingPairs(symbols)` |
| `getTickers(Set<String>)` | `getTickers(symbol)` |
| `getKline(KlineRequest)` | `getKlines(symbol, interval, limit, startTime, endTime, type)` |
| `getFundingRate(String)` | `getFundingRate(symbol)` |
| `getDepth(String, String)` | `getDepth(symbol, limit)` |
| `getBatchFundingRate()` | `getFundingRateBatch()` |

### `FuturesPrivateApiClient` (signed)

| Java | Node |
| --- | --- |
| `getAccount(String marginCoin)` | `getAccount(marginCoin)` |
| `getLeverageAndMarginMode(String, String)` | `getLeverageAndMarginMode(symbol, marginCoin)` |
| `changePositionMode(ChangePositionMode)` | `changePositionMode(positionMode)` |
| `changeLeverage(ChangeLeverage)` | `changeLeverage(symbol, leverage)` |
| `changeMarginMode(ChangeMarginMode)` | `changeMarginMode(symbol, marginMode)` |
| `adjustPositionMargin(AdjustPositionMarginRequest)` | `adjustPositionMargin(symbol, amount, options)` |
| `placeOrder(PlaceOrderRequest)` | `placeOrder(params)` |
| `batchPlaceOrder(BatchPlaceOrderRequest)` | `batchOrder(symbol, orderList)` |
| `cancelOrders(CancelOrdersRequest)` | `cancelOrder(symbol, orderId, clientId)` |
| `cancelAllOrders(CancelAllOrdersRequest)` | `cancelAllOrders(symbol)` |
| `closeAllPosition(CloseAllPositionRequest)` | `closeAllPosition(symbol)` |
| `flashClosePosition(FlashClosePositionRequest)` | `flashClosePosition(positionId)` |
| `getHistoryOrders(GetHistoryOrdersRequest)` | `getHistoryOrders(symbol, options)` |
| `getHistoryTrades(GetHistoryTradesRequest)` | `getHistoryTrades(symbol, options)` |
| `getOrderDetail(GetOrderDetailRequest)` | `getOrderDetail(orderId)` |
| `getPendingOrders(GetPendingOrdersRequest)` | `getPendingOrders(symbol, options)` |
| `modifyOrder(ModifyOrderRequest)` | `modifyOrder(params)` |
| `getHistoryPositions(GetHistoryPositionRequest)` | `getHistoryPositions(symbol, options)` |
| `getPendingPositions(GetPendingPositionRequest)` | `getPendingPositions(symbol)` |
| `getPositionTiers(GetPositionTiersRequest)` | `getPositionTiers(symbol)` |
| `cancelTpslOrders(CancelTpslOrderRequest)` | `cancelTPSL(symbol, orderId)` |
| `placeTpslOrders(PlaceTpslOrderRequest)` | `placeTPSLOrder(params)` |
| `getHistoryTpslOrders(GetHistoryTpslOrderRequest)` | `getHistoryTPSL(symbol)` |
| `getPendingTpslOrders(GetPendingTpslOrderRequest)` | `getPendingTPSL(symbol)` |
| `modifyTpslOrder(ModifyTpslOrderRequest)` | `modifyTPSLOrder(params)` |
| `placePositionTpslOrder(PlacePositionTpslOrderRequest)` | `placeTPSL(params)` |
| `modifyPositionTpslOrder(PlacePositionTpslOrderRequest)` | `modifyTPSL(params)` |
| — (no SDK method) | `closePosition(symbol, positionId, position)` |
| — (no SDK method) | `getPositionMode()` |
| — (no SDK method) | `getFundingRateHistory(symbol, options)` |
| — (no SDK method) | `getTradingSettings(symbols)` |
| — (no SDK method) | `assetQuery()` |
| — (no SDK method) | `getErrorCode(code)` |

### `FuturesWsPublicClient` / `FuturesWsPrivateClient` (the SDK's websocket demos)

Not part of this demo — the websocket surface lives in `src/bitunix/ws.js`
(`BitunixWs`, `KLINE_INTERVALS`, `PRIVATE_CHANNELS`). The SDK's `PublicWsTest`,
`PrivateWsTest` and `StageTest` are the reference for that side.

### `constants`, `enums`, `utils`, `response`

| Java | Node |
| --- | --- |
| `constants/FuturesPath` | the path strings in `client.js`, pinned by `tests/api-contract.test.js` |
| `constants/CommonResult` (`code` / `msg` / `data`, `isOk()`) | the envelope handling in `BitunixClient#request` |
| `constants/ServerConfig` | `CONFIG.BITUNIX_BASE_URL` |
| `constants/WsOpCh` | `src/bitunix/ws.js` channel names |
| `enums/*` | plain validated strings; see the table below |
| `utils/SignUtils.generateSign` | `BitunixClient#makeSign` + `canonicalQuery` |
| `utils/SHAUtils.encrypt` | `BitunixClient.sha256` |
| `utils/HttpUtils` | `BitunixClient#request` (global `fetch`) |
| `utils/JsonUtils` | `JSON.stringify` / `res.json()` |
| `response/*Resp.java` | returned verbatim — no field renaming, so the SDK field names still hold |
| `request/*Request.java` | plain objects; validated in the client method |
| `test/GetAccountTest` | the `getAccount` step of the live run |
| `test/GetTradingPairTest` | the `getTradingPairs` step of the live run |
| `test/PlaceOrderTest` | the `placeOrder` step of the live run (opt-in) |
| `test/StageTest` | the place → read order detail → cancel sequence of the opt-in live run |

---

## 4. Signing, as the SDK computes it

`SignUtils.generateSign(nonce, timestamp, apiKey, queryParamsMap, httpBody, secretKey)`:

1. walk the query params in ascending key order (a `TreeMap`), **skipping the
   `sign` key** and **skipping null/empty values**, concatenating `key + value`
   with no separator;
2. `digest = sha256(nonce + timestamp + apiKey + queryConcat + httpBody)`;
3. `sign  = sha256(digest + secretKey)`.

`BitunixClient#makeSign` and `canonicalQuery` do exactly that; the four headers
travel as `api-key`, `nonce`, `timestamp`, `sign`. The signature is never placed
in the query string. `tests/api-contract.test.js` re-implements
`SignUtils`/`SHAUtils` in the test and asserts both produce the same digest.

---

## 5. Enum wire values

| SDK enum | SDK values | Wire value we send |
| --- | --- | --- |
| `TradeSide` | `OPEN`, `CLOSE` | same; always sent explicitly, and `CLOSE` requires `positionId` |
| `OrderSide` | `Buy`, `Sell` | **`BUY` / `SELL`** (deliberate divergence — the SDK enum is title case, but `PlaceOrderRequest#side` is a plain `String` and the SDK's own `PlaceOrderTest` sends `"BUY"`). Both spellings are accepted on input. |
| `OrderType` | `LIMIT(1)`, `MARKET(2)` | **`LIMIT` / `MARKET`** — the int is the serialised form, not the REST value |
| `TpslOrderType` | `LIMIT(1)`, `MARKET(2)` | same as `OrderType` |
| `StopTriggerType` | `LAST_PRICE`, `MARK_PRICE` | same |
| `MarginMode` | `ISOLATION`, `CROSS` | same; `crossed`/`isolated` are accepted and normalised |
| `PositionMode` | `ONE_WAY`, `HEDGE` | same; `one-way`/`hedge` are accepted and normalised |
| `PositionSide` | `LONG`, `SHORT` | same, upper-cased |
| `OrderStatus` | `INIT` … `PART_FILLED_CANCELED` | passed through unchanged on history/pending filters |
| `Effect` | `GTC`, `FOK`, `IOC`, `POST_ONLY` | passed through unchanged |
| `KlineInterval` | `1m` … `1M` | `getValue()` verbatim; `type` uses `LAST_PRICE` because the SDK sends `KlineType.name()`, not `getValue()` (`"last"`) |
| `DepthLevel` | `ONE(1)`, `FIVE(5)`, `FIFTEEN(15)` | `1` / `5` / `15`, plus `50` and `max` from the REST docs (a strict superset of the enum) |

---

## 6. Tests

`tests/api-contract.test.js` pins the client to the SDK. It stubs
`globalThis.fetch` and restores it in `afterEach`, exactly like
`tests/smoke.test.js`, and covers:

- **endpoint paths** — one test per method, asserting the path string matches the
  `FuturesPath` constant byte for byte, plus a coverage test that every REST
  constant the SDK declares is exercised;
- **signing** — `canonicalQuery` ordering / null / empty handling, `makeSign`
  against a transcription of `SignUtils.generateSign` + `SHAUtils.encrypt`, and
  that `sign` never leaks into the query string;
- **enums** — the table in section 5, both the accepted input spellings and the
  rejected ones;
- **response unwrapping** — SDK-shaped `OrderPageResp.orderList`,
  `TradePageResp.tradeList`, `PositionHistoryPageResp.positionList`,
  `TpslHistoryOrdersPageResp.orderList`, the bare `ArrayList` forms of
  `getPendingPositions` / `getPendingTPSL`, and the list form of `getAccount`;
- **error handling** — non-2xx HTTP, a non-zero `code`, `data: null` and a
  missing `data` all throw;
- **the two order-level TP/SL endpoints** — `placeTPSLOrder` →
  `/api/v1/futures/tpsl/place_order` and `modifyTPSLOrder` →
  `/api/v1/futures/tpsl/modify_order`. These are written defensively: while the
  method is absent from `BitunixClient` the test **skips** with
  `'<method> not implemented yet'` instead of failing, and starts asserting the
  real path the moment the method lands;
- **the demo script** — `--list` and `--dry-run` are run as child processes with
  the credentials forced empty, and must exit 0, print every endpoint, and make
  no request.



| `BITUNIX_DEMO_SYMBOL` | `CONFIG.symbol` (`BTCUSDT`) | symbol the demo uses |
| `BITUNIX_DEMO_PUBLIC` | off | run the **public** market endpoints with no credentials. Without it, a credential-less run makes **zero** network calls and just prints what to set. |
| `BITUNIX_DEMO_TRADE` | off | opt in to the mutating calls |
| `BITUNIX_DEMO_CLOSE` | off | **extra** opt in, required *in addition to* `BITUNIX_DEMO_TRADE`, for the irreversible exits (`closePosition`, `closeAllPosition`, `flashClosePosition`) |
| `BITUNIX_DEMO_MARGIN_AMOUNT` | unset | USDT amount for `adjust_position_margin`; the call is skipped while unset |

The live trade demo is deliberately gentle: it rests a `POST_ONLY` LIMIT order at
an unreachable price (`qty 0.001`, `price 1`) and then cancels it, so it cannot
be filled at a sane price even if the run is interrupted between the two steps.
Account-wide changes (`change_position_mode`, `change_leverage`,
`change_margin_mode`) use `CONFIG` values rather than hard-coded ones, so the
demo does not silently reconfigure a production account.

```bash
# read-only against a real account
node scripts/api-demo.js

# public market data only, no credentials
BITUNIX_DEMO_PUBLIC=1 node scripts/api-demo.js

# everything, including the position exits (read this twice)
BITUNIX_DEMO_TRADE=1 BITUNIX_DEMO_CLOSE=1 node scripts/api-demo.js
```

---
