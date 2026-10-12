# risk — hard risk rules (always on)

- Max margin per trade: position_sizing_margin_pct of available balance.
- Max open positions: max_positions (default 3).
- Liq-distance guard: abort/close if distance < sl_liquidation_safety.
- Cooldown after every close: cooldown_minutes.
- Live-only: there is no dry-run mode; every execution tool call submits a real order.
- Never average down a loser without a fresh confirmed signal.
- Every open position must carry protection, and the stop may only ever TIGHTEN — never loosen (that would silently widen risk).
- Partial TP/SL ladders are placed furthest-target-first, so a failure can never leave a remainder with no stop.
- Sizing floors qty to the pair's basePrecision and rejects anything outside minTradeVolume / maxMarketOrderVolume before the order is sent.
