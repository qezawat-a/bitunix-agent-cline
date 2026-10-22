# AI-First Engineering Notes (bitunix-agent-cline)

## Process
- Planning/acceptance criteria live in CLAUDE.md (safety invariants, testing rules).
- Eval coverage is the regression suite: `npm test` (386 tests, 69 suites) + `npm run check`.
- Review focus is system behavior (see REVIEW_CHECKLIST.md), not style.

## Architecture (agent-friendly)
- Explicit boundaries: exchange layer `src/bitunix/`, trader `src/trader/`, agent `src/agent/`.
- Stable contracts: tool definitions with JSON schemas; settings validated by `SETTING_RANGES` (single source of truth).
- Typed-ish interfaces via `validateToolArguments`; deterministic tests via node:test with stubbed fetch.

## CI
- `.github/workflows/ci.yml` runs `npm run check` + `npm test` on push/PR.
- `.github/workflow/neon_workflow.yml` remains for Neon PR branches (does not run tests).

## Eval harness
- `npm run harness` drives the agent over JSONL stdin/stdout for eval tooling.
- `tests/eval-agent.test.js` covers the agent loop, history sanitization, tool validation.
