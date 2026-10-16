import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

// The stop ladder: a rung fires every time the favorable ROI crosses the next
// multiple of trailing_trigger_roi_pct — e.g. trigger 4 -> the 4 / 8 / 12
// ladder — and ratchets the stop up to the PRIOR rung's line, lagging the
// price by one rung. It rides the EXISTING trigger setting; 0 disables.

PositionManager.STOP_VERIFY_DELAY_MS = 0;
PositionManager.ATR_SIZED_TRIGGERS = false;
PositionManager.BREAKEVEN_BUFFER_PCT = 0; // pin the buffer so levels are exact

const settings = (trigger) => ({
  symbol: 'BTCUSDT', leverage: 10, min_confidence: 80, tpsl_method: 'position',
  breakeven_threshold_pct: 5, trailing_trigger_roi_pct: trigger, trailing_callback_pct: 5,
  sl_liquidation_safety: 10,
  cooldown_minutes: 1, on_tpsl_failure: 'close', max_positions: 3,
  account_tp_roi_pct: 0, account_sl_roi_pct: 0,
  partial_tp_fractions: [0.3, 0.4, 0.3], partial_tp_roi_steps: [1, 2, 3],
});

// Long, entry 100, leverage 10x: a +4% price move is 40 ROI, +8% is 80.
// liqPrice 90 keeps the liquidation guard clear of every move.
const long = (over = {}) => ({
  positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1', leverage: 10,
  avgPrice: '100', markPrice: '104', liqPrice: '90', ...over,
});

function exchange({ work = false } = {}) {
  const calls = [];
  const rows = [];
  const client = {
    calls, rows,
    getPendingTPSL: async () => rows.map(row => ({ ...row })),
    modifyTPSL: async (params) => {
      calls.push('modifyTPSL');
      if (work) rows.push({ id: 'att-1', positionId: 'p1', slPrice: params.slPrice, slQty: '1' });
      return { orderId: 'att-1' };
    },
    closePosition: async () => { throw new Error('unexpected close'); },
    getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 1, basePrecision: 4 }],
  };
  return client;
}

describe('stop ladder (trailing_trigger_roi_pct)', () => {
  it('is a no-op when the trailing trigger is 0', async () => {
    const client = exchange();
    const pm = new PositionManager(client, 'BTCUSDT', settings(0));
    const result = await pm.checkStopStep(long({ markPrice: '200' }));
    assert.equal(result.skipped, 'stop ladder disabled');
    assert.equal(client.calls.length, 0);
  });

  it('fires at the first rung and lands the stop on the break-even line', async () => {
    const client = exchange({ work: true });
    const pm = new PositionManager(client, 'BTCUSDT', settings(40));
    // +4% price at 10x = 40 ROI: clears the trigger-40 rung-1 threshold.
    const result = await pm.checkStopStep(long());
    assert.equal(result.rung, 1);
    assert.equal(result.slPrice, '100', 'rung 1 is the entry/break-even line');
    assert.deepEqual(client.calls, ['modifyTPSL']);
  });

  it('does not fire below the first rung', async () => {
    const client = exchange();
    const pm = new PositionManager(client, 'BTCUSDT', settings(80));
    // +4% price = 40 ROI: under the 80-ROI rung-1 threshold.
    const result = await pm.checkStopStep(long());
    assert.equal(result.skipped, 'stop ladder threshold not reached');
    assert.equal(client.calls.length, 0);
  });

  it('climbs the ladder one rung per multiple and never re-sends', async () => {
    const client = exchange({ work: true });
    const pm = new PositionManager(client, 'BTCUSDT', settings(40));
    // Rung 1 at +4%: stop to the entry line.
    assert.equal((await pm.checkStopStep(long())).rung, 1);
    // +6% price = 60 ROI: still under rung 2's 80-ROI threshold — the rung
    // waits rather than re-sending rung 1's modify.
    assert.equal((await pm.checkStopStep(long({ markPrice: '106' }))).skipped, 'stop ladder threshold not reached');
    // +8% price = 80 ROI clears rung 2: stop to the +4% price line.
    const rung2 = await pm.checkStopStep(long({ markPrice: '108' }));
    assert.equal(rung2.rung, 2);
    assert.equal(rung2.slPrice, '104');
    // +12% price = 120 ROI clears rung 3: stop to the +8% price line.
    const rung3 = await pm.checkStopStep(long({ markPrice: '112' }));
    assert.equal(rung3.rung, 3);
    assert.equal(rung3.slPrice, '108');
    assert.equal(client.calls.length, 3, 'one modify per rung, no resends');
  });

  it('never drags the stop back down from a higher level', async () => {
    // Trailing already left the stop at 108, ahead of this rung's 104 line:
    // the rung cannot move the stop backward, so it is skipped instead of sent.
    const client = exchange();
    client.rows.push({ id: 's1', positionId: 'p1', slPrice: '108', slQty: '1' });
    const pm = new PositionManager(client, 'BTCUSDT', settings(40));
    pm.stepApplied.set('p1', { rung: 1, slPrice: '100' });
    const result = await pm.checkStopStep(long({ markPrice: '112' }));
    assert.equal(result.skipped, 'stop ladder already at or ahead of this rung');
    assert.equal(client.calls.length, 0);
  });

  it('refuses a rung that would sit inside the liquidation distance', async () => {
    // liq 104.5 sits above the rung-2 candidate 104: the exchange would
    // liquidate before the stop fills, so the rung is refused and never sent.
    const client = exchange();
    const pm = new PositionManager(client, 'BTCUSDT', settings(40));
    pm.stepApplied.set('p1', { rung: 1, slPrice: '100' });
    const result = await pm.checkStopStep(long({ markPrice: '108', liqPrice: '104.5' }));
    assert.equal(result.skipped, 'stop ladder would sit inside the liquidation distance');
    assert.equal(client.calls.length, 0);
  });

  it('waits while the price has not covered the rung line', async () => {
    // +3.9% price = 39 ROI: under the 40-ROI rung threshold — not reached.
    const client = exchange();
    const pm = new PositionManager(client, 'BTCUSDT', settings(40));
    const result = await pm.checkStopStep(long({ markPrice: '103.9' }));
    assert.equal(result.skipped, 'stop ladder threshold not reached');
    assert.equal(client.calls.length, 0);
  });
});
