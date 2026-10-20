import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

// Regression fixture for the JCTUSDT 2026-10-20 round trip the operator
// reported:
//
//   LONG JCTUSDT 5286895160562027071, entry 0.004041, 30x, ISOLATION
//   ATR stop 0.003973 shipped BELOW the exchange's own live liqPrice 0.003988
//   — a stop the exchange could never fill; the position sat "🚨 liquidation"
//   with a stop that offered no protection. Two defects combined:
//
//   1. the pre-entry estimate ran the CROSS formula (position_type 'crossed')
//      while the ACCOUNT traded the order under ISOLATION, so the 60%
//      clamp room looked bigger than reality and never fired;
//   2. rows reporting liqPrice "0" while still live switched every guard off
//      (rearm early-returned, the liquidation guard skipped, the clamp saw 0).
//
// These tests lock down: the estimate follows the ACCOUNT's real margin mode,
// and a "0"/missing liqPrice resolves to an estimated boundary the guards and
// the protection clamp actually use.

const baseSettings = {
  symbol: 'JCTUSDT',
  tpsl_method: 'position',
  on_tpsl_failure: 'close',
  leverage: 30,
  min_confidence: 80,
  sl_liquidation_safety: 0.60,
  breakeven_threshold_pct: 20,
  trailing_trigger_roi_pct: 25,
  trailing_callback_pct: 5,
  cooldown_minutes: 5,
  partial_tp_fractions: [0.3, 0.4, 0.3],
  partial_tp_roi_steps: [1, 2, 3],
  position_type: 'crossed',
};

// JCT's actual numbers from the incident.
const JCT_ENTRY = 0.00404115;
const JCT_LEV = 30;
const JCT_QTY = 2327;

const originalVerifyDelay = PositionManager.STOP_VERIFY_DELAY_MS;
afterEach(() => {
  PositionManager.STOP_VERIFY_DELAY_MS = originalVerifyDelay;
});

describe('the liquidation estimate follows the account, not the config', () => {
  const TIERS = [{ level: 1, startValue: 0, endValue: 1e9, maintenanceMarginRate: 0.004 }];

  it('uses the isolated formula when the account runs ISOLATION, though the config says crossed', async () => {
    const pm = new PositionManager({
      getLeverageAndMarginMode: async () => ({ leverage: JCT_LEV, marginMode: 'ISOLATION' }),
      getPositionTiers: async () => TIERS,
    }, 'JCTUSDT', baseSettings);
    const liq = await pm.estimateLiqPrice(JCT_ENTRY, 'BUY', JCT_QTY, 0.31, JCT_LEV);
    const expected = JCT_ENTRY * (1 - 1 / JCT_LEV + 0.004);
    assert.ok(Math.abs(liq - expected) < 1e-12, `got ${liq}, want the isolated estimate ${expected}`);
    // The mode defect bites when the cross formula eats the WHOLE account
    // balance as cushion: with an account holding ~3 USDT free the cross
    // estimate floats far below the true liquidation, inflating the 60% clamp
    // room until the ATR stop ships unclamped — the decorative stop of the
    // incident. The isolated formula ignores other positions' collateral.
    const wrongCross = JCT_ENTRY * (1 + 0.004) - 3 / JCT_QTY;
    assert.ok(liq > wrongCross, `estimated ${liq} must be tighter than the cross estimate ${wrongCross}`);
  });

  it('keeps the cross formula when the account itself answers CROSS', async () => {
    const pm = new PositionManager({
      getLeverageAndMarginMode: async () => ({ leverage: 30, marginMode: 'CROSS' }),
      getPositionTiers: async () => TIERS,
    }, 'JCTUSDT', baseSettings);
    const liq = await pm.estimateLiqPrice(0.12, 'BUY', 50000, 1000, 30);
    assert.ok(Math.abs(liq - (0.12 * 1.004 - 1000 / 50000)) < 1e-12, `got ${liq}`);
  });

  it('falls back to the configured intent when the account cannot be asked', async () => {
    const pm = new PositionManager({
      getPositionTiers: async () => TIERS,
      // No getLeverageAndMarginMode at all — the deployed-stub shape.
    }, 'JCTUSDT', baseSettings);
    const liq = await pm.estimateLiqPrice(0.12, 'BUY', 50000, 1000, 30);
    assert.ok(Math.abs(liq - (0.12 * 1.004 - 1000 / 50000)) < 1e-12, `got ${liq}`);
  });
});

describe('a live row without a liquidation price is estimated, never ignored', () => {
  it('returns the exchange value when the row carries one', async () => {
    const pm = new PositionManager({}, 'JCTUSDT', baseSettings);
    const liq = await pm.effectiveLiqPrice({
      positionId: 'p1', side: 'BUY', liqPrice: '0.003988',
      avgPrice: String(JCT_ENTRY), leverage: JCT_LEV,
    });
    assert.equal(liq, 0.003988);
  });

  it('estimates from the row itself when liqPrice is "0"', async () => {
    const pm = new PositionManager({
      getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.02 }],
    }, 'JCTUSDT', baseSettings);
    const liq = await pm.effectiveLiqPrice({
      positionId: 'p1', side: 'BUY', liqPrice: '0',
      avgPrice: String(JCT_ENTRY), leverage: JCT_LEV, qty: String(JCT_QTY),
    });
    const expected = JCT_ENTRY * (1 - 1 / JCT_LEV + 0.02);
    assert.ok(Math.abs(liq - expected) < 1e-12, `got ${liq}, want ${expected}`);
  });

  it('mirrors the formula for a short', async () => {
    const pm = new PositionManager({
      getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.02 }],
    }, 'JCTUSDT', baseSettings);
    const liq = await pm.effectiveLiqPrice({
      positionId: 'p1', side: 'SELL', liqPrice: '0',
      avgPrice: String(JCT_ENTRY), leverage: JCT_LEV, qty: String(JCT_QTY),
    });
    const expected = JCT_ENTRY * (1 + 1 / JCT_LEV - 0.02);
    assert.ok(Math.abs(liq - expected) < 1e-12);
  });

  it('returns null when the row gives nothing to estimate from', async () => {
    const pm = new PositionManager({}, 'JCTUSDT', baseSettings);
    const liq = await pm.effectiveLiqPrice({ positionId: 'p1', side: 'BUY', liqPrice: '0' });
    assert.equal(liq, null);
  });
});

describe('the liquidation guard stays armed when the row zeroes its liqPrice', () => {
  // Estimated liq = entry × (1 − 1/30 + 0.02) ≈ 0.0039873 — right where the
  // exchange reported its own 0.003988. A mark inside the 0.60% safety
  // distance must close; a mark far outside must be treated as safe.
  const setup = async () => {
    const closed = [];
    const pm = new PositionManager({
      getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.02 }],
      closePosition: async (...args) => { closed.push(args); return { closed: 'p1' }; },
    }, 'JCTUSDT', baseSettings);
    const position = {
      positionId: 'p1', symbol: 'JCTUSDT', side: 'BUY',
      avgPrice: String(JCT_ENTRY), leverage: JCT_LEV, qty: String(JCT_QTY),
      liqPrice: '0',
    };
    return { pm, position, closed };
  };

  it('closes inside the safety distance of the ESTIMATED liq', async () => {
    const { pm, position, closed } = await setup();
    const result = await pm.checkLiquidationGuard({ ...position, markPrice: '0.004005' });
    assert.equal(result.closed, true, `expected an emergency close, got ${JSON.stringify(result)}`);
    assert.equal(result.trigger, 'liquidation_guard');
    assert.equal(result.liqEstimated, true, 'the close must be labelled as acting on an estimate');
    assert.equal(closed.length, 1);
  });

  it('treats a mark far from the estimated liq as safe', async () => {
    const { pm, position, closed } = await setup();
    const result = await pm.checkLiquidationGuard({ ...position, markPrice: '0.0045' });
    assert.equal(result.skipped, 'liquidation distance safe');
    assert.equal(closed.length, 0);
  });

  it('keeps the old behaviour for a row that cannot be estimated', async () => {
    const pm = new PositionManager({
      getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.02 }],
      closePosition: async () => { throw new Error('must not close'); },
    }, 'JCTUSDT', baseSettings);
    const result = await pm.checkLiquidationGuard({
      positionId: 'p1', side: 'BUY', liqPrice: '0', markPrice: '100',
    });
    assert.equal(result.skipped, 'no active liquidation price');
  });
});

describe('the protection clamp uses the real boundary, not a cosmetic one', () => {
  // entry 100, 30x, tier MMR 0.004 -> estimated liq 97.0667; the 60% clamp
  // room is 1.76. An ATR-5 stop (confidence 80 -> multiple 1.19 -> raw stop
  // 94.05) is far past the liq, so the placed stop must be pulled to 98.24 —
  // with the old "row reports 0, so no clamp" behaviour it would have shipped
  // at 94.05, decorative exactly like the JCTUSDT incident.
  it('pulls the ATR stop inside the ESTIMATED liquidation price', async () => {
    const placed = [];
    const pm = new PositionManager({
      getPendingTPSL: async () => [],
      getTickers: async () => [{ symbol: 'JCTUSDT', markPrice: '100' }],
      getTradingPairs: async () => [{ symbol: 'JCTUSDT', quotePrecision: 6 }],
      getKlines: async () => [],
      placeTPSL: async (params) => { placed.push(params); return { ok: true }; },
      closePosition: async () => ({}),
      getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.004 }],
    }, 'JCTUSDT', baseSettings);
    const result = await pm.ensureProtection({
      positionId: 'p1', symbol: 'JCTUSDT', side: 'BUY',
      avgPrice: '100', leverage: 30, qty: '1', liqPrice: '0', atr: 5,
    });
    assert.equal(result.placed, true);
    assert.equal(placed.length, 1);
    const estLiq = 100 * (1 - 1 / 30 + 0.004);
    const stop = Number(placed[0].slPrice);
    assert.ok(Math.abs(stop - 98.24) <= 0.005, `stop ${placed[0].slPrice} should be pulled to 60% of the entry-to-liq room (98.24)`);
    assert.ok(stop > estLiq, `stop ${stop} must sit above the estimated liquidation ${estLiq}`);
  });
});

describe('the post-fill rearm rescues a stop that sits below the real boundary', () => {
  it('moves a stop below the estimated liquidation price to just above it', async () => {
    PositionManager.STOP_VERIFY_DELAY_MS = 0;
    let slOnExchange = '0.003973';
    const modified = [];
    const rows = () => [{
      positionId: 'p1',
      slPrice: slOnExchange, slStopType: 'MARK_PRICE',
      tpPrice: '0.004666', tpStopType: 'MARK_PRICE',
    }];
    const pm = new PositionManager({
      getPendingTPSL: async () => rows(),
      modifyTPSL: async (params) => {
        modified.push(params);
        slOnExchange = params.slPrice; // the exchange confirms the new level
        return { ok: true };
      },
      getTickers: async () => [{ symbol: 'JCTUSDT', markPrice: '0.004005' }],
      getTradingPairs: async () => [{ symbol: 'JCTUSDT', quotePrecision: 6 }],
      getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.02 }],
    }, 'JCTUSDT', baseSettings);
    const position = {
      positionId: 'p1', symbol: 'JCTUSDT', side: 'BUY',
      avgPrice: String(JCT_ENTRY), leverage: JCT_LEV, qty: String(JCT_QTY),
      liqPrice: '0', markPrice: '0.004005',
    };
    const result = await pm.rearmStopIfInsideLiq(position);
    assert.equal(modified.length, 1, 'the stop must be moved');
    const target = Number(modified[0].slPrice);
    const estLiq = JCT_ENTRY * (1 - 1 / JCT_LEV + 0.02);
    assert.ok(target > estLiq, `moved stop ${target} must clear the estimated liq ${estLiq}`);
    assert.ok(target < 0.004005, 'and still sit below the mark');
    assert.equal(modified[0].tpPrice, '0.004666', 'the live take-profit must be preserved on the modify');
    assert.equal(result?.rearm, true);
  });
});
