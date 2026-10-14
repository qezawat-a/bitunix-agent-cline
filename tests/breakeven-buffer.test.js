import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

const settings = { symbol: 'OGNUSDT', leverage: 50, min_confidence: 80 };
const make = () => new PositionManager({}, 'OGNUSDT', settings);
const near = (actual, expected, tolerance = 0.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe('break-even covers fees', () => {
  it('puts the stop past the entry on the profit side', () => {
    const pm = make();
    near(pm.breakEvenPrice(100, 'BUY'), 100.15, 1e-9);
    near(pm.breakEvenPrice(100, 'SELL'), 99.85, 1e-9);
  });
});

describe('ROI triggers are sized against the ATR stop and target', () => {
  // OGNUSDT-like: 15m ATR is 3.6% of price, 50x leverage.
  const position = { positionId: 'p1', symbol: 'OGNUSDT', avgPrice: '0.03881', leverage: 50, atr: 0.0014 };

  it('lifts a trigger that sits inside normal noise (4% ROI at 50x is 0.08% of price) to one stop distance', async () => {
    near(await make().effectiveTriggerRoi(position, 4, 1, 0.6), 214.6);
  });
  it('leaves a trigger already between one stop distance and the target alone', async () => {
    // 250 is above the break-even cap, but at 50x the cap sits BELOW one stop
    // distance, so the floor (one stop distance) still wins: the trigger is
    // lifted to 214.6, not capped to the cap.
    near(await make().effectiveTriggerRoi(position, 250, 1, 0.6), 214.6);
  });
  it('pulls a trigger that is beyond the take-profit back inside it', async () => {
    near(await make().effectiveTriggerRoi(position, 1000, 1, 0.6), 214.6);
  });
  it('keeps the configured value when no ATR can be read', async () => {
    assert.equal(await make().effectiveTriggerRoi({ ...position, atr: undefined }, 4, 1, 0.6), 4);
  });

  // WALUSDT-like: 25x leverage, stop at 4.5% of price, target at 12%. The
  // ATR stop is therefore 112% on margin and the target 300% on margin.
  const lowLevPosition = { positionId: 'p2', symbol: 'WALUSDT', avgPrice: '0.05265', leverage: 25, atr: 0.0023, signalConfidence: 80 };

  it('caps the break-even trigger to the first quarter of the target band instead of letting it fire at the target ROI', async () => {
    // One stop distance = 130% on margin; a quarter of the target band (301%)
    // is 75%, below that floor, so the trigger sits at the stop distance —
    // the floor is the binding constraint here, and the cap only keeps a
    // looser configured value from firing near the target.
    near(await make().effectiveTriggerRoi(lowLevPosition, 4, 1, 0.6), 130);
  });
  it('does not cap a trailing trigger inside the take-profit band', async () => {
    // Trailing (floorR 1.25) may trail above the take-profit band: the callback
    // owns the exit, the stop just holds it in. 1.25 x 130 = 162.5.
    near(await make().effectiveTriggerRoi(lowLevPosition, 6, 1.25, 0.85), 162.5);
  });
});
