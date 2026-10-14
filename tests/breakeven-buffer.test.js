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
    assert.equal(await make().effectiveTriggerRoi(position, 250, 1, 0.6), 250);
  });
  it('pulls a trigger that is beyond the take-profit back inside it', async () => {
    near(await make().effectiveTriggerRoi(position, 1000, 1, 0.6), 298.7);
  });
  it('keeps the configured value when no ATR can be read', async () => {
    assert.equal(await make().effectiveTriggerRoi({ ...position, atr: undefined }, 4, 1, 0.6), 4);
  });
});
