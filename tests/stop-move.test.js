import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

// These suites pin the stop to the exact entry price; the break-even fee buffer has its own test.

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
// A short's liquidation price sits ABOVE the entry (the loss side is up), so
// liqPrice 150 keeps the guard far from interfering with the confirmation
// cases below: candidate stop 100 < liq 150.
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

describe('the stop never moves inside the liquidation distance', () => {
  // The live bug: a position whose stop sits barely above its liquidation price
  // had its break-even / trailing stop pushed all the way down to liquidation,
  // so the exchange force-closed it (full loss) instead of our stop filling.
  // The candidate stop must stay sl_liquidation_safety away from the mark AND
  // clear of the liquidation price itself; otherwise the move is skipped.

  const settings = () => ({
    symbol: 'WALUSDT', leverage: 25, min_confidence: 80, tpsl_method: 'position',
    breakeven_threshold_pct: 5, trailing_trigger_roi_pct: 25, trailing_callback_pct: 5,
    sl_liquidation_safety: 0.6, cooldown_minutes: 1, on_tpsl_failure: 'close', max_positions: 3,
    account_tp_roi_pct: 0, account_sl_roi_pct: 0,
    partial_tp_fractions: [0.3, 0.4, 0.3], partial_tp_roi_steps: [1, 2, 3],
  });

  const close = async () => { throw new Error('unexpected close'); };
  const rows = [];
  const client = {
    getPendingTPSL: async () => rows.map(row => ({ ...row })),
    modifyTPSL: async (params) => {
      rows.push({ id: 'att-1', positionId: 'w1', slPrice: params.slPrice, slQty: '38' });
      return { orderId: 'att-1' };
    },
    closePosition: close,
    getTradingPairs: async () => [{ symbol: 'WALUSDT', quotePrecision: 5, basePrecision: 1 }],
  };

  // Mirror of the 25x WALUSDT loss: entry 0.06116, liq 0.0591. ATR is pinned on
  // the position so the guard paths never reach the klines fetch.
  const tight = (over = {}) => ({
    positionId: 'w1', symbol: 'WALUSDT', side: 'BUY', qty: '38',
    avgPrice: '0.06116', markPrice: '0.062', liqPrice: '0.0591', atr: 0.00226, ...over,
  });

  // A stop that would land beyond its own liquidation price is useless: the
  // exchange force-closes at liq before the stop fills. For a long the stop
  // must stay ABOVE liq.
  it('break-even refuses to move the stop across the liquidation price', async () => {
    // liq 0.0620 is ABOVE the candidate 0.06125: a long whose stop would sit
    // below liquidation. The guard refuses instead of sending the modify.
    const pm = new PositionManager(client, 'WALUSDT', settings());
    const result = await pm.checkBreakeven(tight({ liqPrice: '0.0620' }));
    assert.equal(result.skipped, 'break-even would sit inside the liquidation distance');
    assert.equal(client.calls?.length ?? 0, 0, 'no modify was sent to the exchange');
  });

  it('break-even moves the stop when it stays clear of liquidation', async () => {
    rows.length = 0;
    // liq 0.0591 sits below the candidate 0.06116: a healthy long. The guard
    // passes and the modify reaches the exchange, confirmed by the read-back.
    const pm = new PositionManager(client, 'WALUSDT', settings());
    const result = await pm.checkBreakeven(tight());
    assert.notEqual(result?.skipped, 'break-even would sit inside the liquidation distance');
    assert.equal(result?.skipped, undefined, 'the move completed, not skipped');
  });

  it('trailing refuses to ratchet the stop across the liquidation price', async () => {
    rows.length = 0;
    rows.push({ id: 's1', positionId: 'w1', slPrice: '0.05925', slQty: '38' });
    const pm = new PositionManager(client, 'WALUSDT', settings());
    // Trailing trigger at 25 ROI: mark 0.0619 gives 30.2% on margin, clears it.
    // Candidate = mark - atr*1.05 = 0.0619 - 0.002373 = 0.059527, which sits
    // BELOW liq 0.0596: the exchange would liquidate before the stop fills, so
    // the move is refused.
    const result = await pm.checkTrailing(tight({ markPrice: '0.0619', liqPrice: '0.0596' }));
    assert.equal(result?.skipped, 'trailing would sit inside the liquidation distance');
  });

  it('a missing liqPrice does not block the move', async () => {
    rows.length = 0;
    const pm = new PositionManager(client, 'WALUSDT', settings());
    const result = await pm.checkBreakeven(tight({ liqPrice: undefined }));
    assert.notEqual(result?.skipped, 'break-even would sit inside the liquidation distance');
  });

  // Regression: sl_liquidation_safety is a PERCENT (0.60 = 0.60%). It was once
  // compared as a fraction, which demanded a stop 60% beyond liquidation and
  // refused every break-even / trailing move at the default setting.
  it('the default sl_liquidation_safety never blocks a normal break-even or trailing move', async () => {
    rows.length = 0;
    const pm = new PositionManager(client, 'WALUSDT', { ...settings(), sl_liquidation_safety: 0.6 });
    const be = await pm.checkBreakeven(tight());
    assert.equal(be?.skipped, undefined, 'break-even fired at the default safety');
    rows.length = 0;
    rows.push({ id: 's1', positionId: 'w1', slPrice: '0.0600', slQty: '38' });
    const tr = await pm.checkTrailing(tight({ markPrice: '0.0640', atr: 0.0005 }));
    assert.equal(tr?.skipped, undefined, 'trailing fired at the default safety');
  });
});
