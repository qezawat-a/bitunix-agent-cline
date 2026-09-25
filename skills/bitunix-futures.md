# bitunix-futures — Bitunix USDT-M playbook

- Base: https://fapi.bitunix.com ; WS public/private per env.
- Sign: digest=SHA256(nonce+timestamp+apiKey+queryParams+body-no-spaces), sign=SHA256(digest+secret).
- Symbols: BTCUSDT style (no dash). Margin coin: USDT.
- place_order: symbol, side BUY/SELL, tradeSide OPEN/CLOSE, qty (base coin, string), price (string, required for LIMIT), orderType LIMIT/MARKET, effect GTC/IOC/FOK/POST_ONLY.
- Hedge mode: tradeSide required; CLOSE needs positionId.
- TPSL: prefer place_position_tp_sl_order (tpPrice/slPrice + MARK_PRICE trigger + MARKET order type); modify via modify_position_tp_sl_order; cancel via cancel_tp_sl_order.
- Account: GET /api/v1/futures/account?marginCoin=USDT → available, frozen, margin, positionMode ONE_WAY/HEDGE.
- Leverage/margin/position mode: change_* endpoints per symbol.
- WS private needs apiKey+timestamp+nonce+sign in every subscribe params.
- Rate limits ~10 req/sec/uid — keep scan_interval_sec >= 10, batch where possible.
