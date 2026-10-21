# Project Instructions

**J-ROCK** — live AI-agent futures trader on Bitunix USDT-M. Node 20+, plain ESM JavaScript, no TypeScript, no framework. Deps: `dotenv`, `pg`, `ws` only.

## Safety (non-negotiable)

- **There is no dry-run mode.** Every order is a real Bitunix order.
- `auto_trade` must be OFF after every start. Real orders only after `/autotrade on` in Telegram. Keep this guarantee in any change that touches persistence (`getPersistentSettings` deliberately drops `auto_trade`; `AUTO_TRADE_PERSIST` is the opt-in to change that).
- Never commit `.env` or log secrets — settings tools must redact `BITUNIX_API_SECRET`.
- Every entry path must place a TP and an SL (see the "every entry carries a take-profit and a stop-loss" tests — they lock this down).
- Fail closed: with missing/invalid exchange data (liq price, klines, position tiers) refuse to act rather than guess.
- A row reporting `liqPrice: "0"` on a live leveraged position means UNREPORTED, not safe: `PositionManager.effectiveLiqPrice` estimates the boundary (isolated formula, tier MMR) and the guard / rearm / protection clamp use it. Margin-mode arithmetic reads the account (`getLeverageAndMarginMode`), not `position_type`.
- Postgres URL must keep its `sslmode` query param; the client must not hardcode its own SSL options.

## Code Style

- ESM only (`import`/`export`, `"type": "module"`). No build step, no bundler.
- Single mutable `CONFIG` object in `src/config.js`, built from env → `settings.json` → persisted DB settings, in that precedence (env wins). Only keys in `FILE_TRADER_KEYS`/persisted allowlists go through settings files.
- Comments explain *why*, often recounting the incident/regression that motivated the code. Keep that style; don't paraphrase existing rationale comments away.
- File naming: kebab-case for modules, `*.test.js` for tests. Singletons wired via setter injection (`setTraderInstances`, `setBitunixClient`) so tests can stub without network.
- Errors: throw `Error` with human-readable messages; catch and `console.error` at loop boundaries; surface operator-visible failures into Telegram, not just the console.

## Testing

- Runner: `node --test` (built-in). No Jest, no Babel, no extra deps.
- Run: `npm test` (runs `tests/*.test.js` with `--test-concurrency=1`).
- Kline fixtures must be built in **wire order (newest-first)** and routed through `toChronological` (`asClientReturns`), matching what `BitunixClient.getKlines` returns. Bare indicator arrays stay ascending — see the comments in `tests/smoke.test.js`.
- Stub `globalThis.fetch` / client objects instead of hitting the network.
- 68 suites / 381 tests currently green (commit `3a5738d`). New safety behavior needs a regression test that reproduces the failure path.

## Build & Run

- Install: `npm install`
- Live service: `npm start` (health endpoint on :3000 reports `auto_trade` state)
- Interactive agent TUI: `npm run agent`
- JSONL eval harness (drive agent over stdin/stdout): `npm run harness`
- API demo: `node scripts/api-demo.js [--dry-run|--list]` (mutating calls also need `BITUNIX_DEMO_TRADE=1`)
- DB check: `node scripts/db-check.js`
- No linter configured; there is no `npm run demo` script despite the README referencing it — call `scripts/api-demo.js` directly.

## Project Structure

- `src/main.js` — composition root: wires Telegram polling + scan loop + agent + health server
- `src/config.js` — env/settings parsing, `parseBoolean`, `validate()`
- `src/bitunix/` — exchange layer: REST client (`client.js`), WS (`ws.js`), indicators, multi-timeframe signal `scanner.js`, `risk.js` (liq guard), `order-units.js`, `tiers.js` (position-tier guard), `futures-tools.js` (agent tools)
- `src/trader/` — trading engine: `trader.js` (scan→size→order→TP/SL), `position-manager.js` (largest module: guards, breakeven, trailing), `tpsl.js`, `notifier.js`, `settings.js`, `agent-tools.js`
- `src/agent/` — LLM agent: `loop.js` (agent loop), `brain.js` (providers/model auto-discovery), `memory.js`, `skills.js`, `mcp.js`, `runtime.js`
- `src/telegram-bot.js`, `src/telegram-trader.js` — bot transport and `/ commands`
- `src/store/` — Neon Postgres persistence with local-file fallback; `src/session-store.js` — chat session history
- `skills/`, `soul/` — prompt-time content (markdown) loaded into the agent system prompt
- `tests/` — node:test suites; `scripts/` — demos and checks; `docs/` — API parity tables

## Conventions

- Git: commit messages are short/freeform (e.g. "apply-fixes"); no conventional-commit format in history.
- CI (`.github/workflow/neon_workflow.yml`) only creates/deletes Neon PR branches; it does **not** run tests — run `npm test` locally before pushing.
- The exchange is the source of truth: validate leverage/orders against the pair's advertised bands (`getTradingPairs`), never a local constant.
