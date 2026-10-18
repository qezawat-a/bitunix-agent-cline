import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

PositionManager.STOP_VERIFY_DELAY_MS = 0;

// A long, entry 100, ATR 1, 10x. Several manage ticks against a stateful exchange.
function run(marks) {
  const rows = [{ id: 'att-1', positionId: 'p1', tpPrice: '110', tpStopType: 'MARK_PRICE', slPrice: '98.8', slStopType: 'MARK_PRICE', slQty: '1', tpQty: '1' }];
  let mark = 100;
  const client = {
    getPendingPositions: async () => [{ positionId: 'p1', symbol: 'BTCUSDT', side: 'LONG', qty: '1', avgOpenPrice: '100', leverage: 10, liqPrice: '50', markPrice: String(mark), atr: 1 }],
    getPendingTPSL: async () => rows.map(row => ({ ...row })),
    modifyTPSL: async params => { rows[0].slPrice = params.slPrice; return { orderId: 'att-1' }; },
    getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4 }],
    closePosition: async () => { throw new Error('must not close'); },
  };
  const pm = new PositionManager(client, 'BTCUSDT', {
    symbol: 'BTCUSDT', leverage: 10, min_confidence: 80, tpsl_method: 'position',
    breakeven_threshold_pct: 5, trailing_trigger_roi_pct: 8, trailing_atr_multiple: 1.25, trailing_atr_strength_reduction: 0.25,
    sl_liquidation_safety: 0.5, cooldown_minutes: 0, on_tpsl_failure: 'close', max_positions: 1,
    account_tp_roi_pct: 0, account_sl_roi_pct: 0, partial_tp_fractions: [1], partial_tp_roi_steps: [1],
  });
  return (async () => {
    const stops = [];
    for (const m of marks) {
      mark = m;
      await pm.midManage();
      stops.push(Number(rows[0].slPrice));
    }
    return stops;
  })();
}

describe('the stop follows price up and never back down', () => {
  it('trails higher on every new high, then holds when price retraces', async () => {
    const stops = await run([100.6, 101, 102, 103, 104, 103.5, 102.5, 105]);
    assert.deepEqual(stops.map(s => Math.round(s * 100) / 100), [100, 100, 100.95, 101.95, 102.95, 102.95, 102.95, 103.95]);
    for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] >= stops[i - 1], `stop loosened at tick ${i}`);
  });
});
