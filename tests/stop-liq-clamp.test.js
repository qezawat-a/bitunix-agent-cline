import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

const pm = new PositionManager({}, 'SANDUSDT', { symbol: 'SANDUSDT', leverage: 50, min_confidence: 80 });

describe('the stop keeps clear of the liquidation price', () => {
  it('pulls a long stop back to 60% of the entry-to-liquidation distance', () => {
    // ATR 5 -> raw stop 94.05; liquidation 96 -> room (100-96) x 0.6 = 2.4 -> stop 97.6
    assert.equal(Number(pm.computeTPSL(100, 'bullish', 5, 80, 2, 96).slPrice), 97.6);
  });
  it('mirrors it for a short', () => {
    assert.equal(Number(pm.computeTPSL(100, 'bearish', 5, 80, 2, 104).slPrice), 102.4);
  });
  it('leaves a stop that is already inside that room alone', () => {
    // ATR 0.5 -> stop 99.405, room 2.4
    assert.ok(Math.abs(Number(pm.computeTPSL(100, 'bullish', 0.5, 80, 2, 96).slPrice) - 99.405) <= 0.005 + 1e-9); // rounded to quotePrecision 2
  });
  it('does not touch the stop when no liquidation price is known', () => {
    assert.ok(Math.abs(Number(pm.computeTPSL(100, 'bullish', 5, 80, 2).slPrice) - (100 - 5 * 1.19)) <= 0.005 + 1e-9);
  });
});
