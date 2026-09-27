# Bitunix futures API parity

Contract source of truth: the official Java SDK cloned read-only at
`/tmp/open-api/Demo/Java/src` (`BitunixOfficial/open-api` fork). Every endpoint
row below comes from `constants/FuturesPath.java`, every SDK method name from
`client/FuturesPublicApiClient.java` / `client/FuturesPrivateApiClient.java`, and
every response shape from `response/*.java`.

Our side of the mapping lives entirely in `src/bitunix/client.js`
(`BitunixClient`). All `CommonResult` envelopes are unwrapped once in
`request()`: a non-zero `code` throws, a null/undefined `data` throws, and the
caller receives `data`.

## Endpoints

| Endpoint | SDK method | Our method | Status | Notes |
|---|---|---|---|---|
| `GET /api/v1/futures/market/trading_pairs` | `getTradingPairs()` / `getTradingPairs(Set<String>)` | `getTradingPairs(symbols)` | implemented | SDK returns a bare `ArrayList<TradingPair>`; we return the raw array (full precision metadata reaches `trader.js` sizing). Now tolerates a `{tradingPairs:[…]}` / `{list:[…]}` wrapper. |
| `POST /api/v1/futures/account/change_margin_mode` | `changeMarginMode(ChangeMarginMode)` | `changeMarginMode(symbol, marginMode)` | implemented | `MarginMode.ISOLATION` / `CROSS`; `crossed`/`isolated` are accepted as input aliases. |
| `POST /api/v1/futures/account/adjust_position_margin` | `adjustPositionMargin(AdjustPositionMarginRequest)` | `adjustPositionMargin(symbol, amount, options)` | implemented | Field is `amount` (not `margin`), positive adds / negative removes; requires `marginCoin` plus one of `side` (LONG/SHORT) or `positionId`. `side` here is a *position* side, upper-cased. |
| `POST /api/v1/futures/trade/place_order` | `placeOrder(PlaceOrderRequest)` | `placeOrder(params)` | implemented | `orderType` + `tradeSide` are always sent explicitly. Side handling: see *Discrepancies* below. |
| `POST /api/v1/futures/trade/batch_order` | `batchPlaceOrder(BatchPlaceOrderRequest)` | `batchOrder(symbol, orderList)` | implemented | `BatchPlaceOrderRequest{symbol, orderList}` where each entry is a full `PlaceOrderRequest`; 1–5 entries. Per-entry side casing is now normalised like `placeOrder`. |
| `POST /api/v1/futures/trade/cancel_all_orders` | `cancelAllOrders(CancelAllOrdersRequest)` | `cancelAllOrders(symbol)` | implemented | `CancelAllOrdersRequest{marginCoin, symbol}`; we send `symbol` only, `marginCoin` is optional per the docs. |
| `POST /api/v1/futures/trade/cancel_orders` | `cancelOrders(CancelOrdersRequest)` | `cancelOrder(symbol, orderId, clientId)` | implemented | Identifiers are nested: `{symbol, orderList:[{orderId}]}`. |
| `POST /api/v1/futures/trade/close_all_position` | `closeAllPosition(CloseAllPositionRequest)` | `closeAllPosition(symbol)` | implemented | — |
| `POST /api/v1/futures/trade/flash_close_position` | `flashClosePosition(FlashClosePositionRequest)` | `flashClosePosition(positionId)` | implemented | `FlashClosePositionRequest{marginCoin, positionId}`. |
| `GET /api/v1/futures/trade/get_history_orders` | `getHistoryOrders(GetHistoryOrdersRequest)` | `getHistoryOrders(symbol, options)` | implemented | `OrderPageResp extends PageResp` → list field **`orderList`** (verified). Unwrapped `orderList`; bare array still accepted. |
| `GET /api/v1/futures/trade/get_history_trades` | `getHistoryTrades(GetHistoryTradesRequest)` | `getHistoryTrades(symbol, options)` | implemented | `TradePageResp extends PageResp` → list field **`tradeList`** (verified). |
| `GET /api/v1/futures/trade/get_order_detail` | `getOrderDetail(GetOrderDetailRequest)` | `getOrderDetail(symbolOrOrderId, maybeOrderId)` | implemented | `GetOrderDetailRequest` carries `orderId` (or `clientId`) only — no `symbol`; a leading symbol argument is tolerated but dropped (the exchange rejects it as a Parameter Error). |
| `GET /api/v1/futures/trade/get_pending_orders` | `getPendingOrders(GetPendingOrdersRequest)` | `getPendingOrders(symbol, options)` | implemented | `OrderPageResp` → **`orderList`** (verified). |
| `GET /api/v1/futures/position/get_history_positions` | `getHistoryPositions(GetHistoryPositionRequest)` | `getHistoryPositions(symbol, options)` | implemented | `PositionHistoryPageResp extends PageResp` → list field **`positionList`** (verified). |
| `GET /api/v1/futures/position/get_pending_positions` | `getPendingPositions(GetPendingPositionRequest)` | `getPendingPositions(symbol)` | implemented | Bare `ArrayList<PositionPendingResp>`; tolerant of a `positionList` envelope, raw payload otherwise (so the array contract stays enforced by `position-manager`). **No `markPrice` in the model** — see *Discrepancies*. |
| `GET /api/v1/futures/position/get_position_tiers` | `getPositionTiers(GetPositionTiersRequest)` | `getPositionTiers(symbol)` | implemented | Bare `ArrayList<PositionTiersResp>`, unsigned per the SDK. |
| `POST /api/v1/futures/tpsl/cancel_order` | `cancelTpslOrders(CancelTpslOrderRequest)` | `cancelTPSL(symbol, orderId)` | implemented | `CancelTpslOrderRequest{symbol, orderId}`. The id to pass is the `id` field returned by `getPendingTPSL` (see below), not a positionId. |
| `GET /api/v1/futures/tpsl/get_history_orders` | `getHistoryTpslOrders(GetHistoryTpslOrderRequest)` | `getHistoryTPSL(symbol)` | implemented | `TpslHistoryOrdersPageResp extends PageResp` → list field **`orderList`** (verified; our older `tpslList` fallback is retained after it). |
| `GET /api/v1/futures/tpsl/get_pending_orders` | `getPendingTpslOrders(GetPendingTpslOrderRequest)` | `getPendingTPSL(symbol)` | implemented | Bare `ArrayList<TpslPendingOrderResp>`. Fields are `id`, `positionId`, `tpPrice`, `slPrice`, `tpQty`, `slQty`, `tpStopType`, `slStopType`, … — the identifier is `id`, **not** `orderId`. |
| `POST /api/v1/futures/tpsl/position/modify_order` | `modifyPositionTpslOrder(PlacePositionTpslOrderRequest)` | `modifyTPSL(params)` | implemented | Position-level (all-in/all-out) TP/SL. |
| `POST /api/v1/futures/tpsl/position/place_order` | `placePositionTpslOrder(PlacePositionTpslOrderRequest)` | `placeTPSL(params)` | implemented | Position-level TP/SL. Must stay free of `tpOrderType` — adding it makes the exchange reject the request (covered by a test). |
| `POST /api/v1/futures/tpsl/modify_order` | `modifyTpslOrder(ModifyTpslOrderRequest)` | `modifyTPSLOrder(params)` | implemented (new) | `ModifyTpslOrderRequest{orderId, tp*/sl*}`. Keyed by **orderId**, not positionId; `orderId` is the only required field and is validated. |
| `POST /api/v1/futures/tpsl/place_order` | `placeTpslOrders(PlaceTpslOrderRequest)` | `placeTPSLOrder(params)` | implemented (new) | `PlaceTpslOrderRequest{symbol, positionId, tpPrice, tpStopType, slPrice, slStopType, tpOrderType, tpOrderPrice, slOrderType, slOrderPrice, tpQty, slQty}`. `symbol` is required and at least one of `tpPrice` / `slPrice` must be a positive finite number. `tpQty` / `slQty` are what make a **partial** TP/SL possible. |
| WS `"/public/"` | `FuturesWsPublicClient` | `src/bitunix/ws.js` (`BitunixWs`) | n-a | Websocket transport, not a REST endpoint; out of scope for this client. |
| WS `"/private/"` | `FuturesWsPrivateClient` | `src/bitunix/ws.js` (`BitunixWs`) | n-a | As above. |

## Not in the SDK

| Endpoint / helper | Our method | Status | Notes |
|---|---|---|---|

## Discrepancies found and how they were resolved

1. **`OrderSide` casing (`Buy` / `Sell` vs `BUY` / `SELL`).**
   The SDK enum is `Buy`/`Sell`, but `PlaceOrderRequest#setSide` is a `String`
   and the SDK's own reference test (`PlaceOrderTest`) passes the literal
   `"BUY"`; the REST docs also specify `BUY`/`SELL`.
   *Resolution:* `normalizeOrderSide()` accepts `BUY`, `SELL`, `Buy`, `Sell`
   (any casing, trimmed) and `validateOrder()` uses it, so a caller that copied
   the SDK enum verbatim is accepted. The wire value stays upper case — the
   existing, test-asserted behaviour — because switching the emitted value to
   `Buy`/`Sell` would change live trading on an unverified assumption.
   Documented in a comment next to the helper.
   `PositionSide` (`LONG` / `SHORT`) is a different enum and is untouched:
   `closePosition`, `trader.js` and `position-manager.js` keep mapping
   `LONG → BUY` for order sides and keep comparing normalised position sides
   against `BUY` / `SELL`.
2. **`OrderType` / `TpslOrderType` are `LIMIT(1)` / `MARKET(2)` in the SDK.**
   Verified the integers are *not* the REST wire format: `JsonUtils` configures
   no `WRITE_ENUMS_USING_TO_STRING` / `@JsonValue`, so Jackson serialises the
   enum by name, and `PlaceTpslOrderRequest` / `PlacePositionTpslOrderRequest`
   type `tpOrderType` / `slOrderType` as plain `String`. The ints are the
   WS/serialised form.
   *Resolution:* no change to the strings we send; `validateTPSLOrderEnums()` now
   rejects the int form (e.g. `tpOrderType: 2`) instead of letting it reach the
   exchange.
3. **`StopTriggerType` = `LAST_PRICE` / `MARK_PRICE`.** Verified — the
   `MARK_PRICE` triggers in `position-manager.js` are correct, no change.
4. **Kline `type` parameter.** `KlineType` carries both a name (`LAST_PRICE`)
   and a `getValue()` (`"last"`); the SDK sends `getKlineType().name()`, so our
   `LAST_PRICE` is right even though the enum suggests `last`. No change.
5. **Two missing endpoints.** `POST /tpsl/place_order` and
   `POST /tpsl/modify_order` (the only TP/SL pair accepting `tpQty` / `slQty`,
   i.e. partial exits) did not exist. Added as `placeTPSLOrder()` and
   `modifyTPSLOrder()`.
6. **Response-shape audit.** `OrderPageResp.orderList`, `TradePageResp.tradeList`,
   `PositionHistoryPageResp.positionList` and `TpslHistoryOrdersPageResp.orderList`
   were already correct. Hardened with a shared `listFrom()` helper that tries the
   SDK field name first, then the legacy fallbacks, and returns the raw payload
   (not `[]`) when nothing matches, so a malformed payload still fails loudly in
   the caller instead of looking like "no positions". `getPendingTPSL` previously
   collapsed any non-array payload to `[]`; it now also accepts `tpslList` /
   `orderList` envelopes.
7. **`PositionPendingResp` has no `markPrice`.** Fields are `positionId`,
   `symbol`, `marginCoin`, `qty`, `entryValue`, `side`, `marginMode`,
   `positionMode`, `leverage`, `fee`, `funding`, `realizedPNL`, `margin`,
   `unrealizedPNL`, `liqPrice`, `avgOpenPrice`, `marginRate`, `ctime`, `mtime`
   (Long epoch seconds). The mark price must come from `/market/tickers`; the
   existing `position-manager.js` fallback is untouched and still drives
   `markPrice`.
8. **TP/SL pending id vs orderId.** `TpslPendingOrderResp.id` (not `orderId`)
   is what `POST /tpsl/cancel_order` expects in its `orderId` field. No behaviour
   change (the field is passed through by the caller); documented in the
   `getPendingTPSL` comment and in the parity table.

| `GET /api/v1/futures/market/get_funding_rate_history` | `getFundingRateHistory(symbol, options)` | extra | Real Bitunix public endpoint, absent from `FuturesPath.java`. Kept — the scanner reads funding history. |
| — | `closePosition(symbol, positionId, position)` | extra | Composite helper: resolves the position, then issues `place_order` with `tradeSide=CLOSE` (hedge) or `reduceOnly` (one-way). Not an SDK endpoint. |
| — | `getErrorCode(code)` | extra | Returns a doc link for a numeric Bitunix error code; no request is made. |

| `POST /api/v1/futures/trade/modify_order` | `modifyOrder(ModifyOrderRequest)` | `modifyOrder(params)` | implemented | `ModifyOrderRequest{orderId, clientId, marginCoin, qty, price, tp*/sl*}` — passthrough. |

| `GET /api/v1/futures/market/tickers` | `getTickers(Set<String>)` | `getTickers(symbol)` | implemented | Raw `ArrayList<Ticker>` (`markPrice`, `lastPrice`, `open`, `last`, `high`, `low`, `quoteVol`, `baseVol`). Unsigned, as in the SDK. This is the only source of a position mark price. |
| `GET /api/v1/futures/market/kline` | `getKline(KlineRequest)` | `getKlines(symbol, interval, limit, startTime, endTime, type)` | implemented | SDK sends `type=<KlineType.name()>` i.e. `LAST_PRICE` / `MARK_PRICE` — **not** `KlineType.getValue()` (`"last"` / `"mark"`). Our `type='LAST_PRICE'` default matches the name form. `interval` uses `KlineInterval.getValue()` (`"1m"`, `"15m"`, …), also what we send. |
| `GET /api/v1/futures/market/funding_rate` | `getFundingRate(String)` | `getFundingRate(symbol)` | implemented | `FundingRate{symbol, markPrice, lastPrice, fundingRate}` returned raw. |
| `GET /api/v1/futures/market/depth` | `getDepth(String, String)` | `getDepth(symbol, limit)` | implemented | `Depth{asks, bids}` as `List<List<BigDecimal>>`. Gear guard (1/5/15/50/max) is ours; the SDK passes the string through. |
| `GET /api/v1/futures/market/funding_rate/batch` | `getBatchFundingRate()` | `getFundingRateBatch()` | implemented | Slash-separated path, no parameters, exactly as in the SDK. |
| `GET /api/v1/futures/account` | `getAccount(String)` | `getAccount(marginCoin)` | implemented | SDK returns a single `Account` for the requested `marginCoin`; we accept both the object and a list containing it, and throw if that margin coin is absent. |
| `GET /api/v1/futures/account/get_leverage_margin_mode` | `getLeverageAndMarginMode(String, String)` | `getLeverageAndMarginMode(symbol, marginCoin)` | implemented | `MarketSetting{symbol, marginCoin, leverage, marginMode}`. |
| `POST /api/v1/futures/account/change_position_mode` | `changePositionMode(ChangePositionMode)` | `changePositionMode(positionMode)` | implemented | `PositionMode.ONE_WAY` / `HEDGE`; we also accept `one-way` / `hedge` input. |
| `POST /api/v1/futures/account/change_leverage` | `changeLeverage(ChangeLeverage)` | `changeLeverage(symbol, leverage)` | implemented | Integer 1–125 guard; `marginCoin` always `USDT`. |
