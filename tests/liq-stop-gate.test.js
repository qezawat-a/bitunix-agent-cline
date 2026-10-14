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
//
// `position_type` is validated against ['crossed', 'isolated'] in settings.js,
// so use those values here. The ATR stop is (1.55 - strength*0.45) times ATR,
// strength = confidence/100; at confidence 90 that is 1.145 x ATR, and ATR
// here is 0.0055 * 1.5 = 8.25% of the 0.12 entry, so the stop lands at
// 0.12 - 1.145 * 0.00825.
for (const [name, opts] of [['isolated', { type: 'isolated', pct: 2 }], ['cross', { type: 'crossed', pct: 45 }], ['cross, all balance', { type: 'crossed', pct: 100 }]]) {
  it(`does not refuse a wide (~8.25%) ATR stop at entry: ${name}`, async () => {
    const atrValue = 0.0055 * 1.5;
    const { err, placed } = await attempt(atrValue, opts);
    assert.equal(err, null, `unexpected refusal: ${err?.message}`);
    assert.equal(placed.length, 1);
    // The wide ATR stop is what we are exercising: assert it actually landed on
    // the entry order, not just that a single order was placed.
    assert.ok(placed[0], 'expected an entry order to be placed');
    assert.ok(placed[0].slPrice, 'entry order must carry a stop-loss price');
    const expectedStop = 0.12 - (1.55 - 0.9 * 0.45) * atrValue; // 1.145x ATR at confidence 90
    // The entry order snaps its stop to the pair's quotePrecision (5 here), so
    // compare the rounded value rather than the exact one.
    const rounded = Math.round(Number(placed[0].slPrice) * 10 ** pair.quotePrecision) / 10 ** pair.quotePrecision;
    assert.equal(rounded, Math.round(expectedStop * 10 ** pair.quotePrecision) / 10 ** pair.quotePrecision, 'ATR stop must be on the entry order');
  });
}
