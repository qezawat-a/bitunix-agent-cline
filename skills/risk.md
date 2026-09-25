# risk — hard risk rules (always on)

- Max risk per trade: margin_amount_pct of equity.
- Max open positions: max_positions (default 3).
- Liq-distance guard: abort/close if distance < sl_liquidation_safety.
- Cooldown after every close: cooldown_minutes.
- DRY_RUN=1 means no real orders — simulate and report.
- Never average down a loser without a fresh confirmed signal.
