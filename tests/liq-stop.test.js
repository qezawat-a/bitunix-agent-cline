import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Regression test for the position the operator reported:
//
//   TRUTHUSDT LONG 4262117851369330275, 50x
//   Entry 0.020005   TP 0.022217   SL 0.019158   Liq 0.019431
//
// The stop was placed BELOW the liquidation price (0.019158 < 0.019431). Price
// reaches the liquidation first, so the stop is never filled and the position
// is force-closed by the exchange instead of exiting at the level we chose. At
// 50x the ATR stop lands past the liquidation price almost by construction, so
// computeTPSL has to clamp the stop back inside it.

const baseSettings = {
  symbol: 'TRUTHUSDT',
  tpsl_method: 'position',
  on_tpsl_failure: 'close',
  leverage: 50,
  min_confidence: 80,
  sl_liquidation_safety: 0.60,
  breakeven_threshold_pct: 4,
  trailing_trigger_roi_pct: 6,
  trailing_atr_multiple: 1.25,
  trailing_atr_strength_reduction: 0.25,
  trailing_callback_pct: 5,
  cooldown_minutes: 5,
  partial_tp_fractions: [0.3, 0.4, 0.3],
  partial_tp_roi_steps: [1, 2, 3],
};

const TRUTH = {
  positionId: '4262117851369330275',
  symbol: 'TRUTHUSDT',
  side: 'BUY',
  qty: '704',
  avgOpenPrice: '0.020005',
  avgPrice: '0.020005',
  markPrice: '0.020019',
  leverage: 50,
  liqPrice: '0.019431',
  unrealizedPNL: '0.00',
  margin: '0.28',
};

describe('a stop is never placed beyond the liquidation price', () => {
  const setup = async () => {
    const { PositionManager } = await import('../src/trader/position-manager.js');
    const placed = [];
    const pm = new PositionManager({
      getPendingTPSL: async () => [],
      getTickers: async () => [{ symbol: 'TRUTHUSDT', markPrice: '0.020019' }],
      getTradingPairs: async () => [{ symbol: 'TRUTHUSDT', quotePrecision: 6 }],
      getKlines: async () => Array.from({ length: 60 }, (_, i) => ({
        time: String(i), high: String(0.0203 + (i % 5) * 0.00005), low: String(0.0199), close: String(0.02005 + (i % 3) * 0.00001),
      })),
      placeTPSL: async (params) => { placed.push(params); return { ok: true }; },
      closePosition: async () => ({ closed: true }),
    }, 'TRUTHUSDT', baseSettings);
    return { pm, placed };
  };

  it('clamps a long stop that would land below the liquidation price', async () => {
    const { pm } = await setup();
    // ATR large enough that the raw stop (entry - 1.15*atr) falls under liq
    // 0.019431. entry 0.020005, confidence 80 -> stopMultiple 1.19.
    const levels = pm.computeTPSL(0.020005, 'bullish', 0.0006, 80, 6, 0.019431);
    assert.ok(Number(levels.slPrice) > 0.019431, `stop ${levels.slPrice} must sit above the liquidation price 0.019431`);
  });

  it('clamps a short stop that would land above the liquidation price', async () => {
    const { pm } = await setup();
    const levels = pm.computeTPSL(0.020005, 'bearish', 0.0006, 80, 6, 0.020579);
    assert.ok(Number(levels.slPrice) < 0.020579, `stop ${levels.slPrice} must sit below the liquidation price 0.020579`);
  });

  it('leaves a stop alone when it already sits clear of liquidation', async () => {
    const { pm } = await setup();
    const liq = 0.019431;
    // Small ATR: raw stop 0.020005 - 1.19*0.00005 = 0.0199455, well above liq.
    const levels = pm.computeTPSL(0.020005, 'bullish', 0.00005, 80, 6, liq);
    const expected = pm.computeTPSL(0.020005, 'bullish', 0.00005, 80, 6);
    assert.equal(levels.slPrice, expected.slPrice, 'a reachable stop must not be moved');
  });

  it('arms a fillable stop when a real high-leverage position is protected', async () => {
    const { pm, placed } = await setup();
    const result = await pm.ensureProtection(TRUTH);
    assert.equal(placed.length, 1);
    const sl = Number(placed[0].slPrice);
    const liq = Number(TRUTH.liqPrice);
    assert.ok(sl > liq, `armed stop ${sl} must be above the liquidation price ${liq}`);
    assert.equal(result.placed, true);
  });
});
