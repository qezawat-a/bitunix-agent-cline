# Onboarding Guide: J-ROCK

## Overview

J-ROCK is a live AI-agent futures trader on Bitunix USDT-M, written in plain ESM JavaScript (Node 20+, no TypeScript, no framework). It combines a real-time signal scanner, an autonomous LLM agent, a Telegram bot, Neon Postgres persistence, skills, soul/style prompts, MCP tools, and a Bitunix futures trading engine with four TP/SL methods, three order units, and layered risk guards.

No dry-run mode: orders are real. `auto_trade` is OFF after every start; real orders only after `/autotrade on` in Telegram.

## Tech Stack

- **Language / runtime:** Node 20+, ESM (`"type": "module"`), no build step, no bundler, no TypeScript.
- **Core deps (only 3):** `dotenv`, `pg`, `ws`.
- **Database:** Neon Postgres (TLS) with local-file fallback. Store URL must keep `sslmode` query param.
- **Frameworks / libs:** none beyond the above. Trading exchanges are reached via raw `fetch` (REST) + `ws` (WebSocket).
- **CI/CD:** GitHub Actions (`ci.yml` runs `npm run check` + `npm test`; `neon_workflow.yml` creates/deletes Neon PR branches — no test execution).

## Architecture Pattern

- **Single-process monolith.** `main.js` is the composition root: it wires the Telegram polling, scan loop, agent loop, health HTTP server, persistence, and marker entry. No IPC, no microservices, no event bus.
- **Layered by domain:**
  - `src/bitunix/` — exchange layer (REST client, WS, indicators, scanner, risk guard, order-units, tiers).
  - `src/trader/` — trading engine (scan → size → order → TP/SL), guards, notifier, settings.
  - `src/agent/` — LLM agent loop, model auto-discovery, memory, skills, MCP, runtime.
  - `src/telegram-*/` — bot transport and commands.
  - `src/store/` + `session-store.js` — persistence with local-file fallback.
- **State is propagated by explicit singleton setters**, not imports: `setTraderInstances`, `setPositionManager`, `setBitunixClient`, `setBasicMemory`. Tests stub these instead of hitting the network.
- **CONFIG is a single mutable object** in `src/config.js`, built from env → `settings.json` → persisted DB settings, in that precedence (env wins). Only allowlisted keys flow through settings files.

## Key Entry Points

- **Live service:** `npm start` → `src/main.js` (health endpoint on :3000 reports `auto_trade` state).
- **Interactive agent TUI:** `npm run agent` → `src/agent/tui.js`.
- **JSONL eval harness:** `npm run harness` → drives agent over stdin/stdout.
- **API demo:** `node scripts/api-demo.js [--dry-run|--list]`. Mutating calls require `BITUNIX_DEMO_TRADE=1`.
- **DB check:** `node scripts/db-check.js`.
- **Telegram commands:** `/start`, `/stop`, `/status`, `/settings`, `/autotrade on|off`, `/memory`, `/resume`, `/models`, `/ask`.

## Directory Map

| Directory | Purpose |
|-----------|---------|
| `src/main.js` | Composition root: wires Telegram polling + scan loop + agent + health server + persistence |
| `src/config.js` | Env/settings parsing; `parseBoolean`, `validate()`, `CONFIG` singleton |
| `src/bitunix/` | Exchange layer: `client.js` (REST), `ws.js`, `indicators.js`, `scanner.js`, `risk.js` (liq guard), `order-units.js`, `tiers.js` (position-tier guard), `futures-tools.js` (agent tools) |
| `src/trader/` | Trading engine: `trader.js` (scan→size→order→TP/SL), `position-manager.js` (guards, breakeven, trailing), `tpsl.js`, `notifier.js`, `settings.js`, `agent-tools.js` |
| `src/agent/` | LLM agent: `loop.js` (agent loop), `brain.js` (providers/model auto-discovery), `memory.js`, `skills.js`, `mcp.js`, `runtime.js`, `thinking.js`, `auto-model.js`, `tools.js`, `basic-tools.js`, `config.js`, `tui.js` |
| `src/telegram-bot.js` | Bot transport: polling, message routing, `sendMessage`, `isOwner`, `esc` |
| `src/telegram-trader.js` | `/ commands` for trading configuration |
| `src/store/` | `persist.js` — Neon Postgres persistence with local-file fallback |
| `src/session-store.js` | Chat session history |
| `src/prompt.js` | Builds the agent system prompt |
| `skills/` | Prompt-time content (markdown) loaded into the agent system prompt: `bitunix-futures.md`, `risk.md`, `scalping.md`, `swing.md` |
| `soul/` | Style prompts: `SOUL.md`, `STYLE.md` |
| `tests/` | `node:test` suites; one per safety behavior |
| `scripts/` | `api-demo.js`, `check.js`, `db-check.js`, `backtest-pivot-c/` |
| `docs/` | `api-demo.md`, `api-parity.md`, `ai-first.md` |
| `data/` | Local-file fallback for settings/sessions (ephemeral without `DATABASE_URL`) |

## Request Lifecycle (a live scan→trade loop)

1. **Entry** — `src/main.js` starts the Telegram polling and the scan loop; the health server serves `auto_trade` state on :3000.
2. **Scan** — `Scanner` (in `src/bitunix/scanner.js`) fetches klines per timeframe via `BitunixClient`, computes indicators, runs 10 strategies, and applies the multi-timeframe gate (confidence, `tf_min_confidence`, `min_agreeing_strategies`, `min_eligible_timeframes`, confirm scans, cooldown).
3. **Size calculation** — if the gate passes, `Trader` (in `src/trader/trader.js`) checks `getPositionTiers` for MMR, computes size via `order-units.js` against `minTradeVolume`/`max order volume`, and places a **MARKET** order at the live mark (not a resting LIMIT).
4. **Risk guard** — `PositionManager` checks liquidation distance, breakeven, trailing, and tiered-risk maintenance margin before/after the order.
5. **Persistence** — `trader/settings.js` / `store/persist.js` read/write validated settings to Neon Postgres (with local `data/` fallback). `getPersistentSettings` deliberately drops `auto_trade` so a redeploy cannot silently resume; `AUTO_TRADE_PERSIST=1` is the opt-in.
6. **Notifications** — `notifier.js` announces position lifecycle events (open, close with reason/PnL, TP/SL moves) to Telegram via `telegram-bot.js`.

## Conventions

- **ESM only.** `import`/`export`; no build, no bundler, no TypeScript.
- **File naming:** kebab-case modules (`position-manager.js`); `*.test.js` for tests.
- **Comments explain *why*, often recounting the incident/regression that motivated the code.** Keep that style; don't paraphrase rationale comments away.
- **Errors:** throw `Error` with human-readable messages; catch and `console.error` at loop boundaries; surface operator-visible failures into Telegram.
- **Fail closed:** with missing/invalid exchange data (liq price, klines, position tiers) refuse to act rather than guess.
- **Singleton wiring by setter injection** (`setTraderInstances`, `setBitunixClient`, `setPositionManager`, `setBasicMemory`) so tests can stub without network.
- **Kafka/Async:** none — the loop is synchronous/sequential per tick.
- **Git:** short/freeform commit messages (e.g. `apply-fixes`); no conventional-commit format. CI only creates/deletes Neon PR branches; run `npm test` locally before pushing.

## Common Tasks

- **Install:** `npm install`
- **Run dev service:** `npm start` (health endpoint on :3000)
- **Run agent TUI:** `npm run agent`
- **Run eval harness:** `npm run harness`
- **Run tests:** `npm test`  (or `node --test --test-concurrency=1 tests/*.test.js`)
- **Run lint/check:** `npm run check`
- **API demo (live read-only):** `npm run demo -- --list` / `--dry-run` / `node scripts/api-demo.js` (mutating needs `BITUNIX_DEMO_TRADE=1`)
- **DB check:** `node scripts/db-check.js`
- **No linter configured.**

## Where to Look

| I want to... | Look at... |
|--------------|------------|
| Add an API endpoint / exercise an exchange method | `scripts/api-demo.js` (port from the Java SDK at `github.com/qezawat-a/open-api`) |
| Add a strategy | `src/bitunix/indicators.js` + scanner gate in `src/bitunix/scanner.js` |
| Change scan logic (gate, timeframes, confidence) | `src/bitunix/scanner.js` |
| Change order sizing / order units | `src/bitunix/order-units.js` |
| Change risk guards / liquidation handling | `src/bitunix/tiers.js`, `src/bitunix/risk.js`, `src/trader/position-manager.js` |
| Change TP/SL behavior (4 methods) | `src/trader/tpsl.js` |
| Change order lifecycle / entry/exit | `src/trader/trader.js` |
| Change agent loop / thinking / auto-model | `src/agent/loop.js`, `src/agent/auto-model.js`, `src/agent/thinking.js`, `src/agent/brain.js` |
| Change skills / soul prompts | `skills/`, `soul/`, and `src/prompt.js` |
| Change Telegram commands | `src/telegram-trader.js`, `src/telegram-bot.js` |
| Change persistence | `src/store/persist.js`, `src/trader/settings.js`, `src/session-store.js` |
| Add a regression test | `tests/<behavior>.test.js` mirroring the source path structure |
| Change build/CI config | `package.json` scripts, `.github/workflows/ci.yml`, `.github/workflow/neon_workflow.yml` |

## Pre-Existing Onboarding Notes

- The repo ships a rich, authoritative `CLAUDE.md` at the project root with the same safety, code-style, testing, build/run, project-structure, and conventions sections. When you need project-specific instructions, prefer that file over duplicating it in conversation; `ONBOARDING.md` exists to give a newcomer a high-level map quickly.
- The exchange is the source of truth for leverage/orders: validate against the pair's advertised bands (`getTradingPairs`), never a local constant.
- `main.js`, `trader.js`, and `scanner.js` are the three files most likely to explain *why* a guard exists — read their rationale comments first.
