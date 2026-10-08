import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

// Regression: the entry order carries its stop attached, which is an ORDER-level
// TP/SL row. /tpsl/position/modify_order answers code 0 for it and changes
// nothing, so break-even / trailing "moved" a stop that never moved and the
// profit round-tripped into a loss. A move now counts only once a fresh read of
// the exchange shows it.

PositionManager.STOP_VERIFY_DELAY_MS = 0;

const settings = () => ({
  symbol: 'BTCUSDT', leverage: 10, min_confidence: 80, tpsl_method: 'position',
  breakeven_threshold_pct: 5, trailing_trigger_roi_pct: 25, trailing_callback_pct: 5,
  sl_liquidation_safety: 10, cooldown_minutes: 1, on_tpsl_failure: 'close', max_positions: 3,
  account_tp_roi_pct: 0, account_sl_roi_pct: 0,
  partial_tp_fractions: [0.3, 0.4, 0.3], partial_tp_roi_steps: [1, 2, 3],
});

// A short, entry 100, now 98 (+20% ROI at 10x), stop still wide at 103.
const short = (over = {}) => ({
  positionId: 'p1', symbol: 'BTCUSDT', side: 'SELL', qty: '1',
  avgPrice: '100', markPrice: '98', liqPrice: '150', ...over,
});

function exchange({ positionModifyWorks = false, orderModifyWorks = false, placeWorks = false } = {}) {
  const calls = [];
  const rows = [{ id: 'att-1', positionId: 'p1', slPrice: '103', slQty: '1', slStopType: 'MARK_PRICE' }];
  const client = {
    calls, rows,
    getPendingTPSL: async () => rows.map(row => ({ ...row })),
    modifyTPSL: async (params) => {
      calls.push('modifyTPSL');
      if (positionModifyWorks) rows[0].slPrice = params.slPrice;   // accepted either way
      return { orderId: 'att-1' };
    },
    modifyTPSLOrder: async (body) => {
      calls.push('modifyTPSLOrder');
      client.orderBody = body;
      if (orderModifyWorks) rows[0].slPrice = body.slPrice;
      return {};
    },
    placeTPSLOrder: async (body) => {
      calls.push('placeTPSLOrder');
      if (placeWorks) rows.push({ id: 'new-1', positionId: 'p1', slPrice: body.slPrice, slQty: body.slQty });
      return {};
    },
    closePosition: async (_s, positionId) => { calls.push(`close:${positionId}`); return {}; },
    getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 1, basePrecision: 4 }],
  };
  return client;
}

describe('confirmed stop moves', () => {
  it('uses the plain position modify when the exchange honours it', async () => {
    const client = exchange({ positionModifyWorks: true });
    const pm = new PositionManager(client, 'BTCUSDT', settings());
    await pm.checkBreakeven(short());
    assert.deepEqual(client.calls, ['modifyTPSL']);
    assert.equal(pm.breakEvenApplied.has('p1'), true);
  });

  it('falls through to modify_order by id when position modify is silently ignored', async () => {
    const client = exchange({ orderModifyWorks: true });
    const pm = new PositionManager(client, 'BTCUSDT', settings());
    await pm.checkBreakeven(short());
    assert.deepEqual(client.calls, ['modifyTPSL', 'modifyTPSLOrder']);
    assert.equal(client.orderBody.orderId, 'att-1');
    assert.equal(client.orderBody.slQty, '1');
    assert.equal(client.orderBody.slPrice, '100');
    assert.equal(pm.breakEvenApplied.has('p1'), true, 'recorded only after the exchange shows it');
    assert.equal(pm.softStops.size, 0);
  });

  it('adds a new stop as a last resort and never cancels the old one', async () => {
    const client = exchange({ placeWorks: true });
    const pm = new PositionManager(client, 'BTCUSDT', settings());
    await pm.checkBreakeven(short());
    assert.deepEqual(client.calls, ['modifyTPSL', 'modifyTPSLOrder', 'placeTPSLOrder']);
    assert.equal(client.rows.some(row => row.slPrice === '103'), true, 'old stop untouched');
    assert.equal(await pm.currentStop(short()), 100, 'the most protective stop is the live one');
  });

  it('throws, does not record break-even and arms a software stop when nothing sticks', async () => {
    const client = exchange();
    const pm = new PositionManager(client, 'BTCUSDT', settings());
    await assert.rejects(() => pm.checkBreakeven(short()), /not confirmed/);
    assert.equal(pm.breakEvenApplied.has('p1'), false, 'a failed move is retried, not remembered as done');
    assert.equal(pm.softStops.get('p1').slPrice, 100);
  });

  it('the software stop closes the position once price crosses, and only then', async () => {
    const client = exchange();
    const pm = new PositionManager(client, 'BTCUSDT', settings());
    await assert.rejects(() => pm.checkBreakeven(short()));
    assert.equal(await pm.checkSoftStop(short({ markPrice: '99' })), null, 'still on the right side');
    const result = await pm.checkSoftStop(short({ markPrice: '100.4' }));
    assert.equal(result.closed, true);
    assert.deepEqual(client.calls.filter(call => call.startsWith('close:')), ['close:p1']);
    assert.equal(pm.softStops.size, 0);
  });
});
