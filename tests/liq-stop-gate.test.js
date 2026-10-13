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

it('refuses a stop beyond liquidation at 30x isolated (1m-sized ATR, ~6% stop)', async () => {
  const { err, placed } = await attempt(0.0055 * 1.5);
  assert.ok(err && /beyond liquidation/.test(err.message), `expected refusal, got ${err?.message}`);
  assert.equal(placed.length, 0);
});

it('allows a stop inside liquidation at 30x (small ATR, ~1% stop)', async () => {
  const { err, placed } = await attempt(0.0011);
  assert.equal(err, null, `unexpected refusal: ${err?.message}`);
  assert.equal(placed.length, 1);
});

it('cross margin: liquidation sits at 1/(leverage x margin share), so a ~6% stop at 30x with 2% margin is allowed', async () => {
  const { err, placed } = await attempt(0.0055 * 1.5, { type: 'crossed', pct: 2 });
  assert.equal(err, null, `unexpected refusal: ${err?.message}`);
  assert.equal(placed.length, 1);
});

it('cross margin with ~all the balance as margin still refuses a stop beyond liquidation', async () => {
  const { err, placed } = await attempt(0.0055 * 1.5, { type: 'crossed', pct: 100 });
  assert.ok(err && /beyond liquidation/.test(err.message), `expected refusal, got ${err?.message}`);
  assert.equal(placed.length, 0);
});
