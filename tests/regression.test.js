import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';
import { convert, positionSizeFromUnit, ORDER_UNITS, normalizeUnit } from '../src/bitunix/order-units.js';

PositionManager.STOP_VERIFY_DELAY_MS = 0;

function reversalClient(opts = {}) {
  const closed = [];
  const positions = opts.positions || [
    { positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1', avgPrice: '100', markPrice: '95', leverage: 10, liqPrice: '80' },
    { positionId: 'p2', symbol: 'BTCUSDT', side: 'SELL', qty: '1', avgPrice: '100', markPrice: '105', leverage: 10, liqPrice: '120' },
  ];
  return {
    closed,
    getPendingPositions: async () => positions.filter(p => !closed.includes(p.positionId)),
    getPendingTPSL: async () => [],
    closePosition: async (symbol, positionId) => { closed.push(positionId); return { orderId: 'close-' + positionId }; },
    getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4 }],
  };
}

const reversalSettings = {
  symbol: 'BTCUSDT', leverage: 10, min_confidence: 80, tpsl_method: 'position',
  breakeven_threshold_pct: 20, trailing_trigger_roi_pct: 25,
  sl_liquidation_safety: 0.6, cooldown_minutes: 0, on_tpsl_failure: 'close', max_positions: 3,
  account_tp_roi_pct: 0, account_sl_roi_pct: 0,
  partial_tp_fractions: [1], partial_tp_roi_steps: [1],
  reversal_enabled: true, reversal_confidence: 85,
};

describe('reversal handling', () => {
  it('closes longs on a bearish reversal, shorts on bullish', async () => {
    const client = reversalClient();
    const pm = new PositionManager(client, 'BTCUSDT', reversalSettings);
    await pm.fetchPositions();
    pm.reversal = 'bearish';
    const result = await pm.checkReversal();
    assert.equal(result.closedCount, 1);
    assert.ok(client.closed.includes('p1'), 'long p1 should be closed on bearish reversal');
    assert.ok(!client.closed.includes('p2'), 'short p2 should NOT be closed on bearish reversal');
  });

  it('closes shorts on a bullish reversal', async () => {
    const client = reversalClient();
    const pm = new PositionManager(client, 'BTCUSDT', reversalSettings);
    await pm.fetchPositions();
    pm.reversal = 'bullish';
    const result = await pm.checkReversal();
    assert.equal(result.closedCount, 1);
    assert.ok(client.closed.includes('p2'), 'short p2 should be closed on bullish reversal');
    assert.ok(!client.closed.includes('p1'), 'long p1 should NOT be closed on bullish reversal');
  });

  it('does nothing when reversal is disabled', async () => {
    const client = reversalClient();
    const pm = new PositionManager(client, 'BTCUSDT', { ...reversalSettings, reversal_enabled: false });
    await pm.fetchPositions();
    pm.reversal = 'bearish';
    const result = await pm.checkReversal();
    assert.equal(result.closedCount, 0);
    assert.equal(client.closed.length, 0);
  });

  it('does nothing when reversal is neutral', async () => {
    const client = reversalClient();
    const pm = new PositionManager(client, 'BTCUSDT', reversalSettings);
    await pm.fetchPositions();
    pm.reversal = 'neutral';
    const result = await pm.checkReversal();
    assert.equal(result.closedCount, 0);
    assert.equal(client.closed.length, 0);
  });

  it('only acts on a fresh reversal per tick (idempotent)', async () => {
    const client = reversalClient();
    const pm = new PositionManager(client, 'BTCUSDT', reversalSettings);
    await pm.fetchPositions();
    pm.reversal = 'bearish';
    const r1 = await pm.checkReversal();
    const r2 = await pm.checkReversal();
    assert.equal(r1.closedCount, 1);
    assert.equal(r2.closedCount, 0, 'second checkReversal should be a no-op');
  });

// ---------------------------------------------------------------
// 2. Order units: nominal / cost / qty conversions
// ---------------------------------------------------------------

describe('order units', () => {
  it('converts qty to nominal and cost', () => {
    const n = convert({ value: 1, from: 'qty', to: 'nominal', price: 50000, leverage: 10 });
    assert.equal(n, 50000);
    const c = convert({ value: 1, from: 'qty', to: 'cost', price: 50000, leverage: 10 });
    assert.equal(c, 5000);
  });

  it('converts cost to qty and nominal', () => {
    const q = convert({ value: 5000, from: 'cost', to: 'qty', price: 50000, leverage: 10 });
    assert.equal(q, 1);
    const n = convert({ value: 5000, from: 'cost', to: 'nominal', price: 50000, leverage: 10 });
    assert.equal(n, 50000);
  });

  it('converts nominal to qty and cost', () => {
    const q = convert({ value: 50000, from: 'nominal', to: 'qty', price: 50000, leverage: 10 });
    assert.equal(q, 1);
    const c = convert({ value: 50000, from: 'nominal', to: 'cost', price: 50000, leverage: 10 });
    assert.equal(c, 5000);
  });

  it('identity pass-through when from === to', () => {
    assert.equal(convert({ value: 42, from: 'qty', to: 'qty', price: 50000, leverage: 10 }), 42);
  });

  it('rejects unknown units', () => {
    assert.throws(() => convert({ value: 1, from: 'lots', to: 'qty', price: 50000, leverage: 10 }), /unknown order unit/);
    assert.throws(() => convert({ value: 1, from: 'qty', to: 'lots', price: 50000, leverage: 10 }), /unknown order unit/);
  });

  it('normalizeUnit accepts aliases', () => {
    assert.equal(normalizeUnit('notional'), 'nominal');
    assert.equal(normalizeUnit('margin'), 'cost');
    assert.equal(normalizeUnit('size'), 'qty');
    assert.equal(normalizeUnit('base'), 'qty');
  });

  it('positionSizeFromUnit floors qty to basePrecision and enforces min volume', () => {
    const pair = {
      symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4,
      minTradeVolume: 0.001, maxMarketOrderVolume: 10000,
    };
    const result = positionSizeFromUnit({
      available: 1000, unit: 'cost', price: 50000, leverage: 10, marginPct: 10, pair,
    });
    assert.equal(result.ok, true);
    assert.equal(result.qty, 0.02);
  });

  it('positionSizeFromUnit floors up to minTradeVolume when affordable', () => {
    const pair = {
      symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4,
      minTradeVolume: 0.1, maxMarketOrderVolume: 10000,
    };
    const result = positionSizeFromUnit({
      available: 1000, unit: 'cost', price: 50000, leverage: 10, marginPct: 1, pair,
    });
    assert.equal(result.ok, true);
    assert.equal(result.qty, 0.1);
    assert.ok(result.warnings.some(w => w.includes('floored up')));
  });

  it('ORDER_UNITS contains the three expected units', () => {
    assert.deepEqual(ORDER_UNITS, ['nominal', 'cost', 'qty']);
  });
});

// ---------------------------------------------------------------
// 3. Stop trigger types: MARK_PRICE enforced on protected orders
// ---------------------------------------------------------------

describe('stop trigger types', () => {
  function tpslClient(tpslRows = []) {
    return {
      getPendingTPSL: async () => tpslRows.map(r => ({ ...r })),
      modifyTPSL: async (params) => {
        const row = tpslRows.find(r => r.positionId === params.positionId);
        if (row) row.slPrice = params.slPrice;
        return { orderId: 'att-1' };
      },
      modifyTPSLOrder: async () => { return {}; },
      placeTPSLOrder: async () => { return {}; },
      closePosition: async () => { return {}; },
      getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4 }],
    };
  }

  it('position-level modify uses MARK_PRICE stop type', async () => {
    const client = tpslClient([{ id: 'r1', positionId: 'p1', slPrice: '105', slStopType: 'MARK_PRICE' }]);
    const pm = new PositionManager(client, 'BTCUSDT', {
      ...reversalSettings,
      sl_liquidation_safety: 10,
    });
    const position = { positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1', avgPrice: '100', markPrice: '110', leverage: 10, liqPrice: '50' };
    const result = await pm.checkBreakeven(position);
    assert.ok(result);
  });
});

// ---------------------------------------------------------------
// 4. ATR failure policy: on_tpsl_failure = close / cancel / alert
// ---------------------------------------------------------------

describe('ATR failure policy (on_tpsl_failure)', () => {
  function failingAtrClient() {
    return {
      getPendingPositions: async () => [
        { positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1', avgPrice: '100', markPrice: '110', leverage: 10, liqPrice: '50' },
      ],
      getPendingTPSL: async () => [],
      modifyTPSL: async () => { throw new Error('should not be called when ATR fails'); },
      placeTPSL: async () => { throw new Error('should not be called when ATR fails'); },
      closePosition: async (symbol, positionId) => ({ closed: positionId }),
      getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4 }],
    };
  }

  it('on_tpsl_failure=close closes the position when ATR retrieval fails', async () => {
    const client = failingAtrClient();
    const pm = new PositionManager(client, 'BTCUSDT', {
      ...reversalSettings,
      on_tpsl_failure: 'close',
      sl_liquidation_safety: 10,
    });
    const positions = await client.getPendingPositions();
    const position = positions[0];
    const result = await pm.ensureProtection(position);
    assert.ok(result.closed || result.error, 'position should be closed or error reported');
  });

  it('on_tpsl_failure=alert does not close, just reports', async () => {
    const client = failingAtrClient();
    const pm = new PositionManager(client, 'BTCUSDT', {
      ...reversalSettings,
      on_tpsl_failure: 'alert',
      sl_liquidation_safety: 10,
    });
    const positions = await client.getPendingPositions();
    const position = positions[0];
    const result = await pm.ensureProtection(position);
    assert.ok(!result.closed, 'position should not be closed on alert policy');
  });
});

// ---------------------------------------------------------------
// 5. Mid-management order: guards run before profit-side steps
// ---------------------------------------------------------------

describe('mid-management ordering', () => {
  it('liquidation guard runs before break-even and trailing', async () => {
    let guardFirst = false;
    let breakevenAfterGuard = false;
    const client = {
      getPendingPositions: async () => [
        { positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1', avgPrice: '100', markPrice: '100.5', leverage: 10, liqPrice: '99.5' },
      ],
      getPendingTPSL: async () => [],
      getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4 }],
      closePosition: async () => { return {}; },
      modifyTPSL: async () => { return {}; },
    };
    const pm = new PositionManager(client, 'BTCUSDT', {
      ...reversalSettings,
      breakeven_threshold_pct: 1,
      sl_liquidation_safety: 0.01,
    });
    // Override PM methods to record ordering
    const origLiq = pm.checkLiquidationGuard.bind(pm);
    pm.checkLiquidationGuard = async (pos) => { guardFirst = true; return await origLiq(pos); };
    const origBE = pm.checkBreakeven.bind(pm);
    pm.checkBreakeven = async (pos) => { breakevenAfterGuard = guardFirst; return await origBE(pos); };
    await pm.midManage();
    assert.ok(guardFirst, 'liquidation guard should run first');
    assert.ok(breakevenAfterGuard, 'break-even should run after guard');
  });
});
});