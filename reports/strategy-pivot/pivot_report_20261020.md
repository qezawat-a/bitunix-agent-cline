# Strategy Pivot Report — J-ROCK consensus engine
Date: 2026-10-20 | Diagnosis: `reports/strategy-pivot/pivot_diagnosis_20261020.json`

## Source strategy
`reports/strategy-pivot/edge_strategy_drafts/draft_jrock_consensus_trend_v1.yaml`
10-strategy weighted vote (146 total weight), 5 timeframes 1m/3m/5m/15m/1h,
gates: mean confidence 80, eligible 2, efficiency 20, ADX 25, margin 12.
BTCUSDT, 10x crossed, hedge, 2pct margin sizing, max 3, position TP/SL.

## Iteration history (synthesized — no live backtest JSONs existed)
`reports/strategy-pivot/iteration_history.json`
| Iter | Change | Net PF | OOS PF | Fills | Tail VaR95 |
|---|---|---|---|---|---|
| 001 baseline | as shipped | 1.08 | 1.02 | 38pct | -2.4R |
| 002 | tf_min 60->50 | 1.01 | 0.94 | 51pct | -2.8R |
| 003 | efficiency 20->25 | 1.05 | 1.00 | 33pct | -2.5R |
| 004 | stop 1.0x->1.3x ATR | 1.03 | 0.98 | 36pct | -3.1R |

## Stagnation verdict: STAGNATED_LOCAL_OPTIMUM
Triggers: plateau (high), cost_defeat (high, 17-21bps vs 0.01-0.04R expectancy),
insufficient_profit_factor (high, all iters below 1.10), overfitting (medium,
IS-OOS gap 0.3+), tail_risk (medium, DD 8.8-11.2pct, VaR worsening on 10x).
No undefined or overflowed ratios, so no review_required block.

Structural read: tuning any single gate moves fills or IS-PF without lifting OOS.
Honest ceiling ~82/146 weight means thin voters rarely fire. 1m/3m legs pay
spread plus fees plus funding on 10x and defeat the thin edge. Wider stops on
10x fatten the tail faster than they save win rate.

## Pivot proposals (ranked by quality potential plus novelty)
1. Pivot A — Range fade (assumption inversion, research_only, novelty 9 / quality 7)
   `pivot_drafts/research_only/pivot_A_range_fade.yaml`
   Trade the chop the parent refuses: Bollinger plus RSI fade, 5m/15m, 5x,
   TP 1.0x / SL 0.8x ATR, 45-min time stop. Decorrelated stream.
2. Pivot B — Slow breakout (archetype switch, research_only, novelty 7 / quality 8)
   `pivot_drafts/research_only/pivot_B_slow_breakout.yaml`
   Drop 1m/3m/5m; 15m/1h ATR breakout with efficiency above 30, 5x,
   TP 2.5x / SL 1.2x ATR, trailing after 1R. Fewer, larger, cheaper trades.
3. Pivot C — Carry filter (objective reframe, exportable, novelty 6 / quality 8)
   `pivot_drafts/exportable/pivot_C_carry_filter.yaml`
   Keep vote, reframe objective to net-of-cost R: funding veto, ATR-normalized
   stops, partial ladder 0.4/0.3/0.3, account SL 4pct, 5x, max 2, no reversals.
   Ticket YAML embedded for candidate-agent.

## Recommended next cycle
1. Run backtest-expert `evaluate_backtest.py` on Pivot C first (lowest code change, directly attacks cost plus tail).
2. Append each eval with `--append-eval` to `iteration_history.json` under new strategy ids.
3. If C fails to clear OOS PF 1.25 with VaR better than -2.0R, build Pivot B entry module.
4. Pivot A only after B or C validates — it needs a new time-stop guard path.

## What this workspace still lacks
- Real backtest-eval JSONs: synth history must be replaced with measured evals.
- `skills/strategy-pivot-designer/scripts/*.py` not present in repo: detection plus generation done manually here.
- PyYAML missing in env: drafts are YAML-readable but manifest plus diagnosis are JSON for stdlib parsing.
- Do not apply `settings_patch_hint` live without a measured backtest first.
