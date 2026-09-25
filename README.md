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
  confirm scans, cooldown
- Dynamic ATR-based TP/SL, breakeven, trailing, liquidation-distance guard
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
│   └── futures-tools.js
├── trader/
│   ├── trader.js
│   ├── position-manager.js
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

## Safety

Never commit `.env`. Use `DRY_RUN=1` for demo trading. Real orders require
`DRY_RUN=0` and valid Bitunix API keys.
