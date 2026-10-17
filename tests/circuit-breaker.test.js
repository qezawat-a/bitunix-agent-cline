import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Trader } from '../src/trader/trader.js';

// The account bled 0.40 USDT to 0.07 in one session: each loss re-entered the
// next scan, so the bot traded right down to zero. Two independent breakers
// must exist before any more money is sent in:
//   1. max_daily_loss_pct  — today's realized losses vs the day's starting
//                            balance; breach halts auto_trade for the day.
//   2. min_balance         — the account can never trade below a floor, so a
//                            dust balance (0.07 USDT) cannot open a position
//                            whose fees alone would eat it.
// Neither exists yet; these tests pin the behaviour so a future fix is
// forced to satisfy them, and both are enforced in trader.openPosition, the
// only path a position can be created.

const baseClient = {
  getAccount: async () => ({ available: '0.40' }),
  getLeverageAndMarginMode: async () => ({ leverage: 5, marginMode: 'ISOLATION' }),
  getPositionMode: async () => ({ positionMode: 'HEDGE' }),
  getTradingPairs: async () => [{ symbol: 'BTCUSDT', basePrecision: 8, minTradeVolume: '0.001', minLeverage: 1, maxLeverage: 25 }],
  getPositionTiers: async () => [{ endValue: 1e9, maintenanceMarginRate: 0.004 }],
  getPendingOrders: async () => [], getHistoryOrders: async () => [],
  getPendingPositions: async () => [],
  getHistoryPositions: async () => [],
  getKlines: async () => Array.from({ length: 60 }, () => ({ open: '100', high: '101', low: '99', close: '100', baseVol: '1', time: '0' })),
};

function snapshotState() {
  return {
    auto_trade: CONFIG.auto_trade,
    max_daily_loss_pct: CONFIG.max_daily_loss_pct,
    min_balance: CONFIG.min_balance,
    leverage: CONFIG.leverage,
    symbol: CONFIG.symbol,
    position_type: CONFIG.position_type,
    sizing: CONFIG.position_sizing_margin_pct,
    safety: CONFIG.sl_liquidation_safety,
    cooldown: CONFIG.cooldown_minutes,
  };
}
function restoreState(s) {
  CONFIG.auto_trade = s.auto_trade;
  CONFIG.max_daily_loss_pct = s.max_daily_loss_pct;
  CONFIG.min_balance = s.min_balance;
  CONFIG.leverage = s.leverage;
  CONFIG.symbol = s.symbol;
  CONFIG.position_type = s.position_type;
  CONFIG.position_sizing_margin_pct = s.sizing;
  CONFIG.sl_liquidation_safety = s.safety;
  CONFIG.cooldown_minutes = s.cooldown;
}

function traderWith(accountAvailable) {
  const placed = [];
  const client = {
    ...baseClient,
    getAccount: async () => ({ available: String(accountAvailable) }),
    placeOrder: async body => { placed.push(body); return { orderId: 'o1' }; },
  };
  const t = new Trader(client);
  t.computeAtr = async () => 2;
  return { t, placed };
}


// Prime the breaker bookkeeping without letting refreshLossBreakers() overwrite
// it: matching dayKey means the refresh path is skipped entirely.
function primeBreaker(t, { dayStartBalance, realizedToday }) {
  t.state.dayKey = new Date().toISOString().slice(0, 10);
  t.state.dayStartBalance = dayStartBalance;
  t.state.realizedToday = realizedToday;
}

describe('daily-loss circuit breaker', () => {
  it('halts auto_trade when today realized a loss at the configured percentage', async () => {
    const s = snapshotState();
    CONFIG.auto_trade = true;
    CONFIG.max_daily_loss_pct = 20; // 20% of the day-start balance
    CONFIG.min_balance = 0;
    CONFIG.leverage = 5;
    CONFIG.symbol = 'BTCUSDT';
    CONFIG.position_type = 'isolated';
    CONFIG.position_sizing_margin_pct = 2;
    CONFIG.sl_liquidation_safety = 1;
    CONFIG.cooldown_minutes = 1;
    const { t } = traderWith(0.40);
    // Simulate: the day started at 0.50, today's closes realized -0.10.
    primeBreaker(t, { dayStartBalance: 0.50, realizedToday: -0.10 }); // 20% of 0.50
    const refused = await t.openPosition('BTCUSDT', 100, 'bullish', 2, 80).then(() => null, e => e);
    restoreState(s);
    assert.match(refused?.message ?? '', /daily loss|circuit|loss limit/i, 'entry must be refused');
  });

  it('allows the trade while the daily loss is under the threshold', async () => {
    const s = snapshotState();
    CONFIG.auto_trade = true;
    CONFIG.max_daily_loss_pct = 20;
    CONFIG.min_balance = 0;
    CONFIG.leverage = 5;
    CONFIG.symbol = 'BTCUSDT';
    CONFIG.position_type = 'isolated';
    CONFIG.position_sizing_margin_pct = 2;
    CONFIG.sl_liquidation_safety = 1;
    CONFIG.cooldown_minutes = 1;
    const { t, placed } = traderWith(0.40);
    primeBreaker(t, { dayStartBalance: 0.50, realizedToday: -0.02 }); // 4%, well under 20%
    const err = await t.openPosition('BTCUSDT', 100, 'bullish', 2, 80).then(() => null, e => e);
    restoreState(s);
    assert.equal(err, null, `entry should pass: ${err?.message}`);
    assert.equal(placed.length, 1);
  });

  it('is a no-op when max_daily_loss_pct is 0 (disabled)', async () => {
    const s = snapshotState();
    CONFIG.auto_trade = true;
    CONFIG.max_daily_loss_pct = 0; // disabled
    CONFIG.min_balance = 0;
    CONFIG.leverage = 5;
    CONFIG.symbol = 'BTCUSDT';
    CONFIG.position_type = 'isolated';
    CONFIG.position_sizing_margin_pct = 2;
    CONFIG.sl_liquidation_safety = 1;
    CONFIG.cooldown_minutes = 1;
    const { t, placed } = traderWith(0.40);
    primeBreaker(t, { dayStartBalance: 0.50, realizedToday: -0.49 }); // 98% lost, but the breaker is off
    const err = await t.openPosition('BTCUSDT', 100, 'bullish', 2, 80).then(() => null, e => e);
    restoreState(s);
    assert.equal(err, null, `breaker disabled, entry should pass: ${err?.message}`);
    assert.equal(placed.length, 1);
  });
});

describe('minimum balance floor', () => {
  it('refuses to open when available balance is below min_balance', async () => {
    const s = snapshotState();
    CONFIG.auto_trade = true;
    CONFIG.max_daily_loss_pct = 0;
    CONFIG.min_balance = 10; // 10 USDT floor
    CONFIG.leverage = 5;
    CONFIG.symbol = 'BTCUSDT';
    CONFIG.position_type = 'isolated';
    CONFIG.position_sizing_margin_pct = 2;
    CONFIG.sl_liquidation_safety = 1;
    CONFIG.cooldown_minutes = 1;
    const { t, placed } = traderWith(0.07); // the real account
    primeBreaker(t, { dayStartBalance: 0.40, realizedToday: 0 });
    const refused = await t.openPosition('BTCUSDT', 100, 'bullish', 2, 80).then(() => null, e => e);
    restoreState(s);
    assert.match(refused?.message ?? '', /minimum balance|min_balance/i, 'entry must be refused below the floor');
    assert.equal(placed.length, 0);
  });

  it('allows the trade when the balance is at or above the floor', async () => {
    const s = snapshotState();
    CONFIG.auto_trade = true;
    CONFIG.max_daily_loss_pct = 0;
    CONFIG.min_balance = 10;
    CONFIG.leverage = 5;
    CONFIG.symbol = 'BTCUSDT';
    CONFIG.position_type = 'isolated';
    CONFIG.position_sizing_margin_pct = 2;
    CONFIG.sl_liquidation_safety = 1;
    CONFIG.cooldown_minutes = 1;
    const { t, placed } = traderWith(12); // above the 10 USDT floor
    primeBreaker(t, { dayStartBalance: 12, realizedToday: 0 });
    const err = await t.openPosition('BTCUSDT', 100, 'bullish', 2, 80).then(() => null, e => e);
    restoreState(s);
    assert.equal(err, null, `entry should pass: ${err?.message}`);
    assert.equal(placed.length, 1);
  });

  it('is a no-op when min_balance is 0 (disabled)', async () => {
    const s = snapshotState();
    CONFIG.auto_trade = true;
    CONFIG.max_daily_loss_pct = 0;
    CONFIG.min_balance = 0; // disabled
    CONFIG.leverage = 5;
    CONFIG.symbol = 'BTCUSDT';
    CONFIG.position_type = 'isolated';
    CONFIG.position_sizing_margin_pct = 2;
    CONFIG.sl_liquidation_safety = 1;
    CONFIG.cooldown_minutes = 1;
    const { t, placed } = traderWith(0.07);
    primeBreaker(t, { dayStartBalance: 0.40, realizedToday: 0 });
    const err = await t.openPosition('BTCUSDT', 100, 'bullish', 2, 80).then(() => null, e => e);
    restoreState(s);
    assert.equal(err, null, `breaker disabled, entry should pass: ${err?.message}`);
    assert.equal(placed.length, 1);
  });
});
