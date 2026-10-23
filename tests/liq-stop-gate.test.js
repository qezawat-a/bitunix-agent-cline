import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Trader } from '../src/trader/trader.js';

const pair = { symbol: 'STRKUSDT', minTradeVolume: '8', basePrecision: 1, quotePrecision: 5, minLeverage: 1, maxLeverage: 50 };
// Fixed tier so the liquidation estimate is deterministic: one top tier with the
// tier-1 maintenance margin rate the docs publish for small notionals.
const TIERS = [{ endValue: 1e9, maintenanceMarginRate: 0.004 }];
function make(atrValue) {
  const placed = [];
  const client = {
    placeOrder: async b => { placed.push(b); return { orderId: '1' }; },
    getTradingPairs: async () => [pair],
    getAccount: async () => ({ available: '1000' }),
    getPositionTiers: async () => TIERS,
    getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS' }),
    getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    getPendingPositions: async () => [], getPendingOrders: async () => [],
    getKlines: async () => [],
  };
  const t = new Trader(client);
  t.computeAtr = async () => atrValue;
  return { t, placed };
}

async function attempt(atrValue, opts = {}) {
  const prior = { auto: CONFIG.auto_trade, lev: CONFIG.leverage, sym: CONFIG.symbol, type: CONFIG.position_type, pct: CONFIG.position_sizing_margin_pct };
  CONFIG.auto_trade = true; CONFIG.leverage = 30; CONFIG.symbol = 'STRKUSDT';
  CONFIG.position_type = opts.type ?? 'isolated'; CONFIG.position_sizing_margin_pct = opts.pct ?? 2;
  try {
    const { t, placed } = make(atrValue);
    const err = await t.openPosition('STRKUSDT', 0.12, 'bullish', atrValue, 90).then(() => null, e => e);
    return { err, placed };
  } finally { CONFIG.auto_trade = prior.auto; CONFIG.leverage = prior.lev; CONFIG.symbol = prior.sym; CONFIG.position_type = prior.type; CONFIG.position_sizing_margin_pct = prior.pct; }
}

// A wide ATR stop is still placed (never refused) — but it is clamped inside
// the estimated liquidation price so the exchange cannot force-close before the
// stop gets a chance to fill. The stop that lands on the entry order is the
// tighter of the raw ATR distance and "just inside the liq estimate".
// ATR stop = entry - (1.55 - strength*0.45)*ATR; strength = 0.9 at conf 90,
// ATR = 0.0055*1.5, so raw stop = 0.12 - 1.145*0.00825 = 0.11055.
const MMR = 0.004;
function estLiq(entry, side, lev, qty, balance, cross, pct) {
  if (!cross) return entry * (1 - 1 / lev + MMR);
  // cross: budget = available*pct/100 margin; qty = budget*lev/entry (basePrec 1 -> floor)
  const budget = Math.min(1000 * pct / 100, 1000 * 0.99 / (1 + 2 * lev * 0.0006));
  const q = Math.floor(budget * lev / entry);
  return side === 'long' ? entry * (1 + MMR) - 1000 / q : entry * (1 - MMR) + 1000 / q;
}
for (const [name, opts, cross, pct] of [
  ['isolated', { type: 'isolated', pct: 2 }, false, 2],
  ['cross', { type: 'crossed', pct: 45 }, true, 45],
  ['cross, all balance', { type: 'crossed', pct: 100 }, true, 100],
]) {
  it(`places (never refuses) the wide stop, clamped inside liquidation: ${name}`, async () => {
    const atrValue = 0.0055 * 1.5;
    const { err, placed } = await attempt(atrValue, opts);
    assert.equal(err, null, `unexpected refusal: ${err?.message}`);
    assert.equal(placed.length, 1);
    assert.ok(placed[0]?.slPrice, 'entry order must carry a stop-loss price');
    const rawStop = 0.12 - (1.55 - 0.9 * 0.45) * atrValue; // 0.11055
    const liq = cross ? estLiq(0.12, 'long', 30, null, 1000, true, pct) : estLiq(0.12, 'long', 30, null, null, false, pct);
    // expected stop = the raw ATR stop, unless it uses more than 60% of the
    // entry-to-liquidation distance (STOP_MAX_LIQ_FRACTION), in which case it is
    // pulled back to exactly 60%. A stop hugging the liquidation price still loses.
    const room = (0.12 - liq) * 0.6;
    const expected = (0.12 - rawStop) > room ? 0.12 - room : rawStop;
    const rounded = Math.round(Number(placed[0].slPrice) * 10 ** pair.quotePrecision) / 10 ** pair.quotePrecision;
    const want = Math.round(expected * 10 ** pair.quotePrecision) / 10 ** pair.quotePrecision;
    assert.equal(rounded, want, `stop ${rounded} should sit just inside liq ${liq}`);
  });
}
