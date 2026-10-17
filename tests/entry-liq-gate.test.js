import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Trader } from '../src/trader/trader.js';

// The loss in this account was not a single bug — the stop sat inside the
// liquidation-safety distance at entry, so every losing close happened at
// liquidation, not at the stop. The entry path now refuses a trade whose
// mark is already inside that distance, instead of opening into a loss it
// cannot exit from.

const TIERS = [{ endValue: 1e9, maintenanceMarginRate: 0.004 }];
// estimateLiqPrice, isolated 50x, the formula pinned in the gate test:
// a tiny margin makes liq sit ~1/leverage from entry, inside any safety
// distance that is bigger than 2%.
const estLiq = (entry, side, qty, lev) =>
  side === 'BUY' ? entry * (1 - 1 / lev + 0.004) : entry * (1 + 1 / lev - 0.004);

function make(pair, available, atrValue) {
  const placed = [];
  const client = {
    placeOrder: async b => { placed.push(b); return { orderId: '1' }; },
    getTradingPairs: async () => [pair],
    getAccount: async () => ({ available }),
    getPositionTiers: async () => TIERS,
    getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: 'ISOLATION' }),
    getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    getPendingPositions: async () => [], getPendingOrders: async () => [],
    getKlines: async () => Array.from({ length: 60 }, () => ({ high: '0.064', low: '0.061', close: '0.062' })),
  };
  const t = new Trader(client);
  t.computeAtr = async () => atrValue;
  return { t, placed };
}

function run(entry, dir, { pair, available = '50', atrValue = 0.0009, safety = 1 } = {}) {
  const prior = {
    auto: CONFIG.auto_trade, lev: CONFIG.leverage, sym: CONFIG.symbol,
    type: CONFIG.position_type, pct: CONFIG.position_sizing_margin_pct,
    safety: CONFIG.sl_liquidation_safety,
  };
  CONFIG.auto_trade = true; CONFIG.leverage = 50; CONFIG.symbol = pair.symbol;
  CONFIG.position_type = 'isolated'; CONFIG.position_sizing_margin_pct = 2;
  CONFIG.sl_liquidation_safety = safety;
  return {
    run: async () => {
      const { t, placed } = make(pair, available, atrValue);
      const err = await t.openPosition(pair.symbol, entry, dir).then(() => null, e => e);
      return { err, placed };
    },
    restore: () => {
      CONFIG.auto_trade = prior.auto; CONFIG.leverage = prior.lev; CONFIG.symbol = prior.sym;
      CONFIG.position_type = prior.type; CONFIG.position_sizing_margin_pct = prior.pct;
      CONFIG.sl_liquidation_safety = prior.safety;
    },
  };
}

describe('entry is refused when it would die at liquidation, not at the stop', () => {
  const sand = { symbol: 'SANDUSDT', minTradeVolume: '1', basePrecision: 1, quotePrecision: 5, minLeverage: 1, maxLeverage: 125 };

  it('refuses the live SAND condition: 50x, liq inside the safety distance', () => {
    // The operator's long @0.06347 @50x: liq 0.06179 is 2.6% below entry.
    // A 2% safety distance covers it (the default 1% does not) — the trade
    // that lost, refused at the wider distance.
    const { run: go, restore } = run(0.06347, 'bullish', { pair: sand, safety: 2 });
    return go().then(({ err, placed }) => {
      restore();
      assert.equal(placed.length, 0, 'no order may be sent into the liquidation zone');
      assert.match(err?.message ?? '', /liquidation-safety/);
    });
  });

  it('refuses when the operator widens the safety distance', () => {
    // Same entry at 3%: even more clearly inside the zone.
    const { run: go, restore } = run(0.06347, 'bullish', { pair: sand, safety: 3 });
    return go().then(({ err, placed }) => {
      restore();
      assert.equal(placed.length, 0);
      assert.match(err?.message ?? '', /liquidation-safety/);
    });
  });

  it('allows a funded trade whose estimated liq clears the distance', () => {
    // A long at 50x with liq 3.75% below entry: the default 1% gate is clear,
    // the order goes out with a stop clamped above liq.
    const { run: go, restore } = run(0.12, 'bullish', {
      pair: { symbol: 'STRKUSDT', minTradeVolume: '1', basePrecision: 1, quotePrecision: 5, minLeverage: 1, maxLeverage: 50 },
      available: '10000', safety: 1,
    });
    // liq = 0.12*(1 - 1/50 + 0.004) = 0.11549 -> 3.75% below entry.
    const liq = estLiq(0.12, 'BUY', 1, 50);
    assert.ok((0.12 - liq) / 0.12 * 100 > 1, 'precondition: liq outside the 1% gate');
    return go().then(({ err, placed }) => {
      restore();
      assert.equal(err, null, `entry should pass: ${err?.message}`);
      assert.equal(placed.length, 1);
      assert.ok(placed[0]?.slPrice, 'entry carries a stop');
    });
  });
});
