import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Trader } from '../src/trader/trader.js';

// Reproduces: auto_trade on, exchange leverage 50, configured 30. The order
// must not be sent. Current code sends it.
it('does not place an order when the exchange leverage differs from config', async () => {
  const prior = { auto: CONFIG.auto_trade, lev: CONFIG.leverage, sym: CONFIG.symbol };
  CONFIG.auto_trade = true; CONFIG.leverage = 30; CONFIG.symbol = 'STRKUSDT';
  const placed = [];
  const client = {
    placeOrder: async (body) => { placed.push(body); return { orderId: '1' }; },
    getTradingPairs: async () => [{ symbol: 'STRKUSDT', minTradeVolume: '8', basePrecision: 1, quotePrecision: 5, minLeverage: 1, maxLeverage: 50 }],
    getAccount: async () => ({ available: '100' }),
    getLeverageAndMarginMode: async () => ({ leverage: 50, marginMode: 'CROSS' }),
    getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    getPendingPositions: async () => [], getPendingOrders: async () => [],
  };
  try {
    const trader = new Trader(client);
    await trader.openPosition('STRKUSDT', 0.12, 'bullish', 0.001, 90).catch(() => {});
    assert.equal(placed.length, 0, `order sent at mismatched leverage: ${JSON.stringify(placed)}`);
  } finally {
    CONFIG.auto_trade = prior.auto; CONFIG.leverage = prior.lev; CONFIG.symbol = prior.sym;
  }
});

// Reproduces the stop-distance bug: the entry ATR is read from the FIRST
// configured timeframe (1m here), so the stop sits ~1.5x the 1m ATR away.
import { atr as atrFn } from '../src/bitunix/indicators.js';
it('sizes the entry stop from the 15m ATR, not the first configured timeframe', async () => {
  const prior = { tf: CONFIG.timeframes, auto: CONFIG.auto_trade, sym: CONFIG.symbol };
  CONFIG.auto_trade = true;
  CONFIG.timeframes = ['1m', '3m', '5m', '15m'];
  const bar = (i, range) => ({ high: 100 + i * 0 + range, low: 100 - range, close: 100 });
  const series = (range) => Array.from({ length: 60 }, (_, i) => bar(i, range));
  const k1 = series(0.1), k15 = series(0.6);
  const sig = {
    signal: 'bullish', confidence: 90, lastPrice: 100, confirmations: 1,
    tfSignals: { '1m': { atr: atrFn(k1.map(b=>b.high), k1.map(b=>b.low), k1.map(b=>b.close), 14) },
                 '15m': { atr: atrFn(k15.map(b=>b.high), k15.map(b=>b.low), k15.map(b=>b.close), 14) } },
  };
  try {
    const { Trader: T } = await import('../src/trader/trader.js');
    const t = new T({});
    let used = null;
    t.openPosition = async (s, p, d, atrArg) => { used = atrArg; return {}; };
    t.fetchMarkPrice = async () => 100;
    t.state = { positions: [], cooldownUntil: 0, orderUnknownUntil: 0 };
    t.reconcilePositions = async () => {};
    t.entryInFlight = new Set();
    CONFIG.symbol = 'STRKUSDT';
    await t.executeSignal(sig).catch(() => {});
    assert.ok(used && Math.abs(used - sig.tfSignals['15m'].atr) < 1e-9, `entry used ATR ${used}, expected the 15m ATR ${sig.tfSignals['15m'].atr}`);
  } finally { CONFIG.timeframes = prior.tf; CONFIG.auto_trade = prior.auto; CONFIG.symbol = prior.sym; }
});
