import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Trader } from '../src/trader/trader.js';
import { PositionManager } from '../src/trader/position-manager.js';

const position = { symbol: 'BTCUSDT', positionId: 'p1', side: 'LONG', qty: '1', avgOpenPrice: '100', markPrice: '100' };

function openClient(overrides = {}) {
  return {
    getAccount: async () => ({ available: '100' }),
    getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS' }),
    getPositionMode: async () => ({ positionMode: CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY' }),
    getTradingPairs: async () => [{ symbol: 'BTCUSDT', basePrecision: 8, minTradeVolume: '0.001' }],
    getPendingPositions: async () => [],
    getPendingOrders: async () => [],
    getHistoryOrders: async () => [],
    placeOrder: async () => ({ orderId: 'o1' }),
    ...overrides,
  };
}

describe('cooldown', () => {
  beforeEach(() => {
    Object.assign(CONFIG, {
      symbol: 'BTCUSDT', auto_trade: true, leverage: 10, cooldown_minutes: 5,
      signal_confirm_scans: 1, max_positions: 3, order_unit: 'cost', position_sizing_margin_pct: 2,
    });
  });

  it('a position that disappears on the exchange (stop or target filled there) starts the cooldown', async () => {
    let open = [position];
    const pm = new PositionManager({ getPendingPositions: async () => open }, 'BTCUSDT', CONFIG);
    await pm.fetchPositions();
    assert.equal(pm.state.cooldownUntil, 0, 'an open position alone is not an exit');
    open = [];
    await pm.fetchPositions();
    assert.ok(pm.state.cooldownUntil > Date.now() + 4 * 60000, 'the exit started a 5 minute rest');
  });

  it('the first look after a restart is not an exit', async () => {
    const pm = new PositionManager({ getPendingPositions: async () => [] }, 'BTCUSDT', CONFIG);
    await pm.fetchPositions();
    assert.equal(pm.state.cooldownUntil, 0);
  });

  it('executeSignal refuses an entry in the very tick that first sees the exit', async () => {
    let open = [position];
    const trader = new Trader(openClient({ getPendingPositions: async () => open }));
    await trader.positionManager.fetchPositions();
    open = [];
    const res = await trader.executeSignal({ signal: 'bullish', confirmations: 1, lastPrice: 100, confidence: 90, tfSignals: {} });
    assert.equal(res.executed, false);
    assert.equal(res.reason, 'cooldown');
    assert.ok(res.secondsLeft > 0);
  });

  it('a refusal before the order exists does NOT start a cooldown', async () => {
    const trader = new Trader(openClient({ getAccount: async () => ({ available: '0' }) }));
    await assert.rejects(() => trader.openPosition('BTCUSDT', 100, 'bullish', 2), /positive/);
    assert.equal(trader.state.cooldownUntil, 0);
    assert.equal(trader.entryLock(), null);
  });

  it('an order the exchange rejected is a short backoff, not a cooldown or an unknown order', async () => {
    const trader = new Trader(openClient({ placeOrder: async () => { throw new Error('Bitunix rejected: 10002'); } }));
    await assert.rejects(() => trader.openPosition('BTCUSDT', 100, 'bullish', 2), /rejected/);
    assert.equal(trader.state.cooldownUntil, 0);
    assert.equal(trader.state.orderUnknownUntil, 0);
    assert.equal(trader.entryLock().reason, 'order_rejected_backoff');
  });

  it('a network failure on the write still blocks stacking (order may be live)', async () => {
    const trader = new Trader(openClient({ placeOrder: async () => { throw Object.assign(new Error('timeout'), { executionUnknown: true }); } }));
    await assert.rejects(() => trader.openPosition('BTCUSDT', 100, 'bullish', 2), /timeout/);
    assert.equal(trader.entryLock().reason, 'order_unknown');
  });

  it('a real entry starts the cooldown', async () => {
    const trader = new Trader(openClient());
    await trader.openPosition('BTCUSDT', 100, 'bullish', 2);
    assert.equal(trader.entryLock().reason, 'cooldown');
  });
});
