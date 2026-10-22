# AI-First Review Checklist (bitunix-agent-cline)

Use before merging any AI-generated change. Focus on system behavior, not style
(style is enforced by `npm run check` + `npm test`).

## Hard gates (must pass)
- [ ] `npm run check` is green (syntax + settings + skills load).
- [ ] `npm test` is green (all suites).
- [ ] No `.env` secrets or API keys in the diff.
- [ ] No change to `auto_trade` persistence semantics (stays OFF after restart unless `AUTO_TRADE_PERSIST=1`).

## Safety invariants (non-negotiable)
- [ ] Every entry path still places a TP and an SL (see `every entry carries a take-profit and a stop-loss` tests).
- [ ] Fail closed: missing/invalid exchange data (liq price, klines, tiers) still refuses to act.
- [ ] `liqPrice: "0"` still treated as UNREPORTED, with `effectiveLiqPrice` used by guard/rearm/clamp.
- [ ] Margin-mode arithmetic reads the account (`getLeverageAndMarginMode`), not `position_type`.
- [ ] Postgres URL keeps its `sslmode` query param; client does not hardcode SSL options.
- [ ] `bitunix_place_order` still cannot open positions (tradeSide CLOSE only).

## Behavior review (human focus)
- [ ] Behavior regressions: new code does not silently change scanner consensus, signal gating, or cooldown.
- [ ] Security assumptions: no new tool exposes secrets; redaction intact.
- [ ] Data integrity: persistence round-trips; unknown/secret fields dropped.
- [ ] Failure handling: exchange errors surface to Telegram, not just console.
- [ ] Rollout safety: reversible; no live order without `/autotrade on`.

## Agent/LLM path
- [ ] `sanitizeHistory` still produces provider-safe tool sequences (no orphan tool results).
- [ ] Failed turns roll back history (checkpoint restore).
- [ ] Tool argument validation rejects malformed args.
- [ ] `stringifyToolResult` truncates safely.

## Eval coverage
- [ ] New safety behavior has a regression test reproducing the failure path.
- [ ] Harness (`npm run harness`) still answers slash commands locally.
