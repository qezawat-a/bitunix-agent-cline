# J-ROCK — AI Agent Futures Trader (Bitunix USDT-M)

This project is a JavaScript (Node 20+, ESM) AI Agent futures trader on Bitunix.
It combines a real-time signal scanner, an autonomous LLM agent, Telegram chat,
Neon long-memory, skills, soul/style prompts, MCP tools, and a Bitunix futures
trading engine.

## Quick start

```bash
npm install
cp env.example .env
# fill your keys in .env
npm start
```

Default safety: `DRY_RUN=1`. Real Bitunix orders are sent only after you
explicitly switch with `/dryrun 0` and enable `/autotrade on` in Telegram.

## Main features

- Bitunix USDT-M futures REST + WebSocket client
- 10 strategies: EMA trend, RSI momentum, MACD cross, volume confirmation,
  price momentum, ADX strength, Bollinger, funding-rate, Super Trend, ATR breakout
- Multi-timeframe signal gate (`1m`, `3m`, `5m`, `15m`, `1h`): min confidence, tf confidence, agreement,
  minimum qualifying timeframes (`min_eligible_timeframes`), majority agreement across timeframes,
  confirm scans, cooldown. Confidence is scored against the **whole** strategy set, so abstaining
  strategies lower it instead of being excluded from the denominator.
- Marketable entries: the autonomous path sends `MARKET` priced off the live mark, not a `LIMIT`
  resting at the scanner's last price, so a position (and therefore its TP/SL) exists immediately
- Dynamic ATR-based TP/SL, breakeven, trailing, liquidation-distance guard
- All four Bitunix TP/SL methods via `tpsl_method`: `position` (all-in/all-out),
  `partial` (staged closes at `partial_tp_fractions` / `partial_tp_roi_steps`),
  `trailing` (activation + `trailing_callback_pct` retrace), `account`
  (`account_tp_roi_pct` / `account_sl_roi_pct` on aggregate PnL)
- All three Bitunix order units via `order_unit`: `nominal` (notional USDT),
  `cost` (margin paid), `qty` (base coin), converted with the pair's
  `basePrecision` and checked against `minTradeVolume` / max order volume
- Autonomous agent loop with thinking levels, model auto-refresh, sessions
- Telegram bot: `/status`, `/start`, `/stop`, `/settings`, `/dryrun`,
  `/autotrade`, `/memory`, `/resume`, `/models`, `/ask`
- Neon Postgres persistence for validated settings and long-term memory

## Structure

```
src/
├── main.js
├── config.js
├── telegram-bot.js
├── telegram-trader.js
├── prompt.js
├── agent/
│   ├── loop.js
│   ├── brain.js
│   ├── auto-model.js
│   ├── thinking.js
│   ├── config.js
│   ├── memory.js
│   ├── skills.js
│   ├── mcp.js
│   ├── tools.js
│   ├── basic-tools.js
│   └── tui.js
├── bitunix/
│   ├── client.js
│   ├── ws.js
│   ├── indicators.js
│   ├── scanner.js
│   ├── risk.js
│   ├── order-units.js
│   └── futures-tools.js
├── trader/
│   ├── trader.js
│   ├── position-manager.js
│   ├── tpsl.js
│   └── agent-tools.js
├── store/
│   ├── memory.js
│   └── persist.js
└── ui/
    └── tui.js

skills/
soul/
tests/
```

## API demo

`scripts/api-demo.js` exercises every REST endpoint, ported from the official
Bitunix Java SDK (`github.com/qezawat-a/open-api`, `Demo/Java/src`).

```bash
npm run demo -- --list      # every endpoint, method, and whether it mutates
npm run demo -- --dry-run   # the exact request each one would send, no network
npm run demo                # live read-only calls (needs BITUNIX_API_KEY/SECRET)
```

It is safe by default: with no credentials it sends nothing, and the mutating
calls additionally require `BITUNIX_DEMO_TRADE=1`. See `docs/api-demo.md` and
`docs/api-parity.md` for the endpoint tables and the Java-to-Node mapping.

## Safety

Never commit `.env`. Use `DRY_RUN=1` for demo trading. Real orders require
`DRY_RUN=0` and valid Bitunix API keys.
