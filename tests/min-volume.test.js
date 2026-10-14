import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { positionSizeFromUnit } from '../src/bitunix/order-units.js';

// Regression test for the loop the operator watched on TRUTHUSDT:
//
//   [trade] entry failed: position size 347 below the Bitunix minimum 700
//   [trade] entry failed: position size 349 below the Bitunix minimum 700
//   [trade] entry failed: position size 352 below the Bitunix minimum 700
//   ... every signal, forever, position never opened
//
// Bitunix's minTradeVolume is a LOT-size floor on the pair, not a notional
// floor. A thinned-out balance sizing to ~347 units at 2% margin and 50x is
// below the floor, so the exchange refuses the order. The previous code
// returned below_min_trade_volume and gave up; the correct behaviour when the
// account can cover the extra few cents of margin is to size the order UP to
// the minimum so the trade can actually happen.

const PAIR = { basePrecision: 0, quotePrecision: 6, minTradeVolume: 700, maxMarketOrderVolume: 100000 };

describe('sizing reaches the exchange minimum instead of giving up', () => {
  it('floors the quantity up to minTradeVolume when the balance can cover it', () => {
    const result = positionSizeFromUnit({
      available: 5.6, unit: 'nominal', price: 0.0162, leverage: 50, marginPct: 2, pair: PAIR, orderType: 'MARKET',
    });
    assert.equal(result.ok, true);
    assert.equal(result.qty, 700);
    // The whole order still costs less than the free balance.
    assert.ok(result.marginCost <= 5.6, `marginCost ${result.marginCost} must fit in the balance`);
    assert.ok(result.warnings.some(w => w.includes('floored up to the Bitunix minimum')));
  });

  it('still refuses when the balance cannot even cover the minimum', () => {
    const result = positionSizeFromUnit({
      available: 0.10, unit: 'nominal', price: 0.0162, leverage: 50, marginPct: 2, pair: PAIR, orderType: 'MARKET',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'below_min_trade_volume');
  });

  it('does not touch a size that already clears the minimum', () => {
    const result = positionSizeFromUnit({
      available: 50, unit: 'nominal', price: 0.0162, leverage: 50, marginPct: 2, pair: PAIR, orderType: 'MARKET',
    });
    assert.equal(result.ok, true);
    assert.ok(result.qty > 700, 'a size above the minimum must keep its own size');
    assert.ok(!result.warnings.some(w => w.includes('floored up')));
  });

  it('never sizes up beyond what the free balance can pay margin on', () => {
    // 700 * 0.0162 / 50 = 0.2268 USDT of margin; available is only 0.20.
    const result = positionSizeFromUnit({
      available: 0.20, unit: 'nominal', price: 0.0162, leverage: 50, marginPct: 100, pair: PAIR, orderType: 'MARKET',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'below_min_trade_volume');
  });
});
