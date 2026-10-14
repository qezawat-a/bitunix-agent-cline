import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Trader } from '../src/trader/trader.js';

const pair = { symbol: 'STRKUSDT', minTradeVolume: '8', basePrecision: 1, quotePrecision: 5, minLeverage: 1, maxLeverage: 50 };
function make(atrValue) {
  const placed = [];
  const client = {
    placeOrder: async b => { placed.push(b); return { orderId: '1' }; },
    getTradingPairs: async () => [pair],
    getAccount: async () => ({ available: '1000' }),
    getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS' }),
    getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    getPendingPositions: async () => [], getPendingOrders: async () => [],
    getKlines: async () => [],
  };
  const t = new Trader(client);
  t.computeAtr = async () => atrValue;
  return { t, placed };
}

async function attempt(atrValue, opts = {}) {
  const prior = { auto: CONFIG.auto_trade, lev: CONFIG.leverage, sym: CONFIG.symbol, type: CONFIG.position_type, pct: CONFIG.position_sizing_margin_pct };
  CONFIG.auto_trade = true; CONFIG.leverage = 30; CONFIG.symbol = 'STRKUSDT';
  CONFIG.position_type = opts.type ?? 'isolated'; CONFIG.position_sizing_margin_pct = opts.pct ?? 2;
  try {
    const { t, placed } = make(atrValue);
    const err = await t.openPosition('STRKUSDT', 0.12, 'bullish', atrValue, 90).then(() => null, e => e);
    return { err, placed };
  } finally { CONFIG.auto_trade = prior.auto; CONFIG.leverage = prior.lev; CONFIG.symbol = prior.sym; CONFIG.position_type = prior.type; CONFIG.position_sizing_margin_pct = prior.pct; }
}

// The bot no longer second-guesses the exchange with its own liquidation estimate:
// the official docs give no pre-trade formula, and the post-entry guards read the
// exchange's own liqPrice. A wide ATR stop is therefore not refused at entry.
for (const [name, opts] of [['isolated', { type: 'isolated', pct: 2 }], ['cross', { type: 'crossed', pct: 45 }], ['cross, all balance', { type: 'crossed', pct: 100 }]]) {
  it(`does not refuse a wide (~6%) stop at entry: ${name}`, async () => {
    const { err, placed } = await attempt(0.0055 * 1.5, opts);
    assert.equal(err, null, `unexpected refusal: ${err?.message}`);
    assert.equal(placed.length, 1);
  });
}
