# Bitunix Agent — Live Fund Recovery

**Status: 0 USDT. Last trade was a liquidation. Do NOT deploy. Do NOT send more
money here until every step below is done.**

This project has been losing funds on Bitunix USDT-M futures. The account is
now at ~0.07 USDT available. These notes are the recovery protocol: read them
all before changing anything, then follow the checklist top to bottom.

## How the money was lost

1. **50x cross leverage on low-liquidity alts** (SAND, OGN, ERA, …). At 50x,
   a 2% adverse move is a -100% loss on margin. Cross mode means the *whole*
   account backs the position, so one bad fill can wipe everything.
2. **Stop-loss placed inside the liquidation distance.** The entry stop sat
   0.2–0.6% from entry while liquidation was even closer (0.19% in the last
   SAND loss). The exchange force-liquidated before our stop ever got a
   chance to fill. The `sl_liquidation_safety` clamp existed in code but was
   not being applied to entry stops (it used the 0.2% `LIQ_STOP_PADDING`
   floor instead of the configured distance).
3. **Frequent re-entries with no cooldown discipline.** Every stop-out
   immediately re-entered the next signal, so losses compounded instead of
   triggering a circuit breaker.
4. **No max-daily-loss / max-total-loss limit.** The bot kept trading right
   down to zero. There is no "stop when you've lost X%" logic anywhere.

## What the recent code changes already fixed

- Entry stops now clamp to the configured `sl_liquidation_safety` distance
  (default raised 0.6 → 1) from the *estimated* liqPrice, not just the 0.2%
  padding floor.
- Pre-entry gate: `openPosition` refuses to open if the estimated liqPrice is
  within `sl_liquidation_safety` % of the entry mark.
- **Two loss circuit breakers** (`checkLossBreakers` in trader.js, checked in
  both `openPosition` and `openManualPosition`): a daily-loss limit
  (`max_daily_loss_pct`, default 20% of the UTC-day starting balance, sums
  realized PnL from closed positions) and a minimum-balance floor
  (`min_balance`, default 10 USDT). Both are agent-tunable settings; 0
  disables each.
- Settings values coming from the Telegram agent tool are coerced from
  strings to numbers, so `sl_liquidation_safety 0.9` now applies.
- Natural-language "SL liquid safety 0.9" is routed to the validator instead
  of being refused by the LLM.
- The `-5000%` fake ROI line is omitted when the close payload has no exit
  price.
- Stop ladder rungs ride the existing `trailing_trigger_roi_pct` (no new
  setting).

## What is still missing (do these before adding a single dollar)

### 1. Hard leverage ceiling
Set `leverage` in config to **5 or less** for recovery. 50x on a $0.07
account is how the account dies in a single candle. Confirm it in
`/settings` before trading again.

### 2. Max daily loss circuit breaker
**Done.** `trader.js` records the available balance at UTC midnight (`refreshLossBreakers`) and `openPosition`/`openManualPosition` throw before any sizing when today's realized loss reaches `max_daily_loss_pct` (default 20%) of the day-start balance. Reset only at the UTC day rollover. Both settings live in `CONFIG`, `settings.js` (agent-tunable), and the `describeSettingBounds` table. Tests: `tests/circuit-breaker.test.js`.

### 3. Max consecutive loss cap
After 3 losing trades in a row, halt auto-trade for the day and send a
message. This is not in the code yet.

### 4. Minimum balance floor
**Done.** `openPosition`/`openManualPosition` refuse to open when available USDT < `min_balance` (default 10 USDT). A 0.07 USDT dust account can no longer open a position whose fees eat its margin. Both breakers sit in the same `checkLossBreakers()` path and are tested in `tests/circuit-breaker.test.js`.

### 5. Deploy the current fixes before adding funds
The fixes above are committed to `main` but the live service is still
running the old build. Run `npm run deploy` and verify with `/diag` that the
new code is live.

### 6. Do NOT use cross margin
Switch `position_type` to `isolated` so a single position's loss is capped
at that position's margin and cannot drag the whole account down with it.

### 7. Reduce trade frequency
`scan_interval_sec` is currently 15s. On a recovery account use at least
300s (5 minutes) and `max_positions: 1`.

## Checklist — run this in order, not before:

```
[ ] 1. npm test passes (357 tests)
[ ] 2. npm run deploy + /diag shows new code live
[ ] 3. /settings confirms: leverage ≤ 5, position_type = isolated,
      sl_liquidation_safety ≥ 1, max_positions = 1, scan_interval_sec ≥ 300
[ ] 4. max_daily_loss_pct circuit breaker code exists and is tested
[ ] 5. min_balance gate exists and is tested
[ ] 6. Account has ≥ 10 USDT before enabling auto_trade
[ ] 7. Start with 1 USDT margin, verify one full entry→exit cycle by hand
      before scaling up
```

**Bottom line: the code no longer has the two specific bugs that caused the
last three liquidations (stop-inside-liq and settings-not-applying). But the
account is at zero and the leverage, margin mode, and trading frequency
settings that got it there are still the live defaults. Do not send money
in until items 1–7 above are all checked.**
