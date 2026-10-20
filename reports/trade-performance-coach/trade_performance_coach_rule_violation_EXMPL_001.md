# Trade Performance Coach Report: rule_violation_EXMPL_001

**Verdict:** `COOL_DOWN`
**Review type:** `single_trade`
**Primary root cause:** `rule_violation`

## Scores

- `process_score`: 0
- `risk_score`: 40
- `execution_score`: 40
- `review_quality_score`: 100

## Process Adherence

- **WARNING** `pre_entry_thesis_record` — missed: planned.thesis_recorded_before_entry is false
- **CRITICAL** `setup_confirmation` — missed: Entry appears to have occurred before planned setup confirmation
- **CRITICAL** `market_regime_gate` — missed: Trade was taken while market_regime='restrictive' or actual.traded_against_regime=true
- **CRITICAL** `stop_change_rule` — missed: Stop was moved after entry without evidence of a pre-defined stop-change rule

## Risk Manager Notes

- **CRITICAL** `position_size` — Actual risk materially exceeded the planned or maximum risk. Evidence: actual.risk_r=1.8, reference_r=1
- **CRITICAL** `portfolio_heat` — Portfolio heat exceeded the provided maximum. Evidence: portfolio_heat_r=4.2, max_portfolio_heat_r=4

## Execution Quality

- **CRITICAL** `entry` — Entry appears to have occurred before planned confirmation. Evidence: actual.entry_before_confirmation is true
- **CRITICAL** `stop` — Stop was moved without a documented pre-defined rule. Evidence: actual.stop_moved is true

## Possible Behavioral Patterns

- `fomo_entry` (high): Entry/journal evidence suggests fear of missing a move or entry before confirmation.
  - Reflection: What evidence did you have before entry that would not have been available after waiting for confirmation?
- `stop_moved` (high): actual.stop_moved is true and no pre-planned stop-change rule was provided.
  - Reflection: Was the new stop part of the plan before entry?
- `size_creep` (high): Actual risk exceeded the planned or maximum risk (actual.risk_r=1.8 > reference_r=1).
  - Reflection: What would this trade have looked like at the planned risk size?
- `rule_drift` (medium): Multiple process findings suggest possible rule drift.
  - Reflection: Which single rule should be simplified and enforced next session?

## Next-Session Operating Rules

- **next_two_trades**: Cap risk at 0.5R for the next two trades unless the trader explicitly modifies the risk plan in the journal.
  - Trigger: size_creep tag
  - Reason: Actual risk exceeded the stated risk plan.
- **next_week**: No new entry without a pre-entry thesis record, invalidation point, and setup-confirmation note.
  - Trigger: possible FOMO entry pattern
  - Reason: The review found evidence of entry before confirmation or fear of missing a move.
- **next_session**: Switch to review-only mode for the next session; do not add new risk until the rule review is journaled.
  - Trigger: possible revenge/cool-down condition
  - Reason: Repeated losses or revenge-trade evidence can escalate risk-taking.
- **next_month**: Any stop adjustment must be written before entry; unplanned stop changes require immediate post-trade review.
  - Trigger: unplanned stop move
  - Reason: Stop discipline protects the loss limit and keeps outcomes reviewable.

## Coach Questions

- What evidence did you have before entry that would not have been available after waiting for confirmation?
- Was the new stop part of the plan before entry?
- What would this trade have looked like at the planned risk size?
- Which single rule should be simplified and enforced next session?

## Human Decision Gate

Do you accept these temporary operating rules, modify them, defer the decision, or journal this review only?

Allowed actions: accept_rules, modify_rules, defer, journal_only
Default action: `journal_only`

## Disclaimer

This review is for trading-process improvement only. It is not financial advice, investment advice, therapy, mental-health diagnosis, or a trading signal. The human trader remains responsible for all decisions and risk.
