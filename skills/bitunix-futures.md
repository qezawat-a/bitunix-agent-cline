# bitunix-futures — Bitunix USDT-M playbook

- Base: https://fapi.bitunix.com ; WS public/private per env.
- Sign: digest=SHA256(nonce+timestamp+apiKey+queryParams+body-no-spaces), sign=SHA256(digest+secret).
- Symbols: BTCUSDT style (no dash). Margin coin: USDT.
- place_order: symbol, side BUY/SELL, tradeSide OPEN/CLOSE, qty (base coin, string), price (string, required for LIMIT), orderType LIMIT/MARKET, effect GTC/IOC/FOK/POST_ONLY.
- Hedge mode: tradeSide required; CLOSE needs positionId.
- TPSL: prefer place_position_tp_sl_order (tpPrice/slPrice + MARK_PRICE trigger + MARKET order type); modify via modify_position_tp_sl_order; cancel via cancel_tp_sl_order.
- TPSL order-level: place_tp_sl_order / modify_tp_sl_order (modify is keyed by orderId, not positionId). These accept tpQty/slQty, which is what makes PARTIAL take-profit/stop-loss possible — a position-level TP/SL always closes the whole position.
- Four TP/SL methods (help centre id=290): position (all-in/all-out at a fixed price), partial (close in % stages at several levels), trailing (arm at an activation price, exit on a % retrace from the peak), account (close ALL positions when total account PnL crosses a threshold). See the `tpsl_method` setting.
- Account: GET /api/v1/futures/account?marginCoin=USDT → available, frozen, margin, positionMode ONE_WAY/HEDGE.
- Leverage/margin/position mode: change_* endpoints per symbol.
- WS private needs apiKey+timestamp+nonce+sign in every subscribe params.
- Rate limits ~10 req/sec/uid — keep scan_interval_sec >= 10, batch where possible.

## Order units (help centre id=170)

Bitunix sizes an order in one of three units; `order_unit` picks which one you mean.

| unit | meaning | cost | qty | nominal |
|---|---|---|---|---|
| nominal | contract/notional size in USDT | nominal / leverage | nominal / price | — |
| cost | margin actually paid (initial margin) | — | cost * leverage / price | cost * leverage |
| qty | base-asset quantity | qty * price / leverage | — | qty * price |

Article example (BTCUSDT, 1000 USDT, 10x, price 10000): nominal 1000 -> cost 100, qty 0.1; cost 1000 -> qty 1; qty 1 -> nominal 10000, cost 1000.

The exchange only accepts a base-asset `qty`, so a nominal/cost figure must always be converted and then floored to the pair's basePrecision, and checked against minTradeVolume / maxMarketOrderVolume from `trading_pairs`. Floor, never round up — rounding up would exceed the balance.
