// sim.js — event-driven portfolio simulation of Pivot C over real bars.
//
// Semantics are ports of the repository's trading layer, with the execution
// model documented here (zero-discretion, decided once, argued nowhere):
//
// - Vote at each closed 5m bar's close time T (votes.js does the windows).
// - Entry fill: the NEXT 5m bar's open +- slippage (market entry, trader.js
//   "MARKET priced off the live mark"). No look-ahead: windows are closed-bar
//   only, fills one bar after the decision.
// - Initial stop: stopMultiple(avgConf) * ATR(14)[15m] — tpsl.js
//   atrMultiples() (confidence 80 == 1.19x ATR, the draft's 1.2 in disguise).
//   Draft gate: stop distance >= 1.0x ATR.
// - TP ladder (tpsl.js buildPartialLadder): fractions[i] of the position
//   closes at steps[i] * targetMultiple * ATR from entry. Remainder (0.0
//   here because fractions sum to 1) rides the stop.
// - TP fills: trigger price -+ slippage (MARK trigger on the mark series);
//   a gap open beyond the level fills at the open. Stop fills with
//   slippage; gap-open stops fill at the opened-through price (worse).
// - Intrabar ties: a bar that would fill BOTH an unfilled TP leg and the
//   stop resolves stop-first (backtest-expert "punish the strategy").
// - Breakeven (position-manager.js checkBreakeven): SL moves to entry once
//   favorable ROI% (price move * leverage, ROI on margin) reaches
//   breakeven_threshold_pct; idempotent; only if it tightens.
// - Account SL (tpsl.js accountPnlSummary semantics): flatten ALL positions
//   when combined unrealized price PnL / combined committed margin <= -4%.
//   Price PnL only, exactly as positionPnlAndMargin reads it.
// - Funding: at every 8h funding event while open, cash flow = -side * rate
//   * (remaining qty * entry); rates are the Binance proxy normalized to the
//   8h basis. Accrued per bar for events <= bar close; a fill inside the bar
//   forfeits later-in-that-bar events (5m-vs-8h cadence: negligible).
// - Costs: taker fee (bps of fill notional) on every fill + slippage bps on
//   market fills.
// - Entries: skip if the same direction is already open (trader.js
//   no-stacking filter), <= max_positions concurrent, cooldown_minutes
//   lockout that starts only when an order really exists (trader.js).
// - Funding veto (draft): never enter AGAINST carry above 0.05%/8h: long
//   blocked if funding > +0.05%/8h, short blocked if funding < -0.05%/8h.
// - Reversals disabled (draft). Exits never flip a position.
//
// Round trip = one position lifecycle (entry -> ladder/stop/flatten end).
// Per-trip return% is ROI ON COMMITTED MARGIN, net of fees/slippage/funding.
// R-units normalize each trip's PnL by the margin ROI at the INITIAL stop,
// so tail VaR95 reads in "R" like the draft's validation gate. The draft's
// spread gate is UNMODELED (order-book history is not in the archive); the
// all-in cost model stands in for it.

import { atr } from './votes.js';
import { SPAN_MS, bisectRight } from './data.js';

export const TAKER_FEE_BPS = 5.0;   // Bitunix USDT-M taker ~0.05%
export const SLIPPAGE_BPS = 2.5;    // per market fill; stress runs scale up

export const DEFAULTS = Object.freeze({
  leverage: 5,
  marginFrac: 0.015,
  maxPositions: 2,
  cooldownMin: 15,
  stopAtrMin: 1.0,
  accountSlRoiPct: -4.0,
  breakevenRoiPct: 20.0,
  fundingVeto: 0.0005,
  ladderFractions: [0.4, 0.3, 0.3],
  ladderSteps: [1, 2, 3],
  feeBps: TAKER_FEE_BPS,
  slipBps: SLIPPAGE_BPS,
  stopMultOverride: null,
  startMs: 0,
  endMs: null,
});

export function makeParams(overrides = {}) {
  const p = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in DEFAULTS)) throw new Error(`unknown sim param: ${k}`);
    p[k] = v;
  }
  return p;
}

export function directionBlocked(side, fundingRate, p) {
  if (fundingRate === null || fundingRate === undefined) return false;
  if (side === 'long' && fundingRate > p.fundingVeto) return true;
  if (side === 'short' && fundingRate < -p.fundingVeto) return true;
  return false;
}

export function runSimulation(market, p, voteFn) {
  const equity = { value: 1.0 };
  const positions = new Map();   // 'long'|'short' -> position
  const state = { cooldownUntil: 0 };
  const events = [];
  const trips = [];

  const times5 = market.tf['5m'].times;
  const opens5 = market.tf['5m'].opens;
  const highs5 = market.tf['5m'].highs;
  const lows5 = market.tf['5m'].lows;
  const closes5 = market.tf['5m'].closes;

  let i0 = 1;
  if (p.startMs) i0 = Math.max(1, bisectRight(times5, p.startMs));
  let iEnd = times5.length - 1;
  if (p.endMs) iEnd = bisectRight(times5, p.endMs) - 1;

  for (let i = i0; i < iEnd; i++) {
    const tsOpen = times5[i];
    const tsClose = tsOpen + SPAN_MS['5m'];
    const nxtOpen = opens5[i + 1];
    const nxtHigh = highs5[i + 1];
    const nxtLow = lows5[i + 1];

    // 1. funding accrual for everything open (events <= bar close)
    for (const side of [...positions.keys()]) {
      equity.value += accrueFunding(positions.get(side), market, side, tsClose);
    }

    // 2. exits/legs/breakeven on the bar that just opened
    managePositions(positions, equity, tsClose, nxtOpen, nxtHigh, nxtLow, p, events, trips);

    // 3. account-level flatten (accountPnlSummary ROI on committed margin)
    if (positions.size) {
      let pnl = 0;
      let margin = 0;
      for (const pos of positions.values()) {
        pnl += pos.side === 'long' ? (nxtOpen - pos.entry) * pos.qty : (pos.entry - nxtOpen) * pos.qty;
        margin += pos.margin;
      }
      if (margin > 0 && (pnl / margin) * 100 <= p.accountSlRoiPct) {
        state.cooldownUntil = tsClose + p.cooldownMin * 60_000;
        flattenAll(positions, equity, tsClose, nxtOpen, 'account_sl', p, events, trips);
      }
    }

    // 4. entries
    if (tsClose < state.cooldownUntil || positions.size >= p.maxPositions) continue;
    let vote;
    try {
      vote = voteFn(i, tsClose);
    } catch {
      continue; // scanner throw == live scan failure == no entry (fail closed)
    }
    if (!vote || !vote.passes) continue;
    const side = vote.direction === 'bullish' ? 'long' : 'short';
    if (positions.has(side)) continue;
    if (directionBlocked(side, market.fundingAsof(tsClose), p)) continue;

    const atr15 = atrAt(market, '15m', tsClose);
    if (!Number.isFinite(atr15) || atr15 <= 0) continue;
    const strength = Math.max(0, Math.min(100, vote.avg_confidence)) / 100;
    const stopMult = p.stopMultOverride ?? (1.55 - strength * 0.45);
    const tgtMult = 1.8 + strength * 1.2;
    const stopDist = atr15 * stopMult;
    if (stopDist < p.stopAtrMin * atr15 || stopDist <= 0) continue;

    const margin = equity.value * p.marginFrac;
    if (margin <= 0) continue;
    const fill = side === 'long'
      ? nxtOpen * (1 + p.slipBps / 10_000)
      : nxtOpen * (1 - p.slipBps / 10_000);
    const notional0 = margin * p.leverage;
    const fee0 = notional0 * p.feeBps / 10_000;
    equity.value -= fee0;
    const entry = fill;
    const qty0 = notional0 / entry;
    const stopLvl = side === 'long' ? entry - stopDist : entry + stopDist;
    positions.set(side, {
      side,
      entry,
      qty: qty0,
      qty0,
      margin,
      feesPaid: fee0,
      openT: tsClose,
      atr15,
      stopMult,
      tgtMult,
      stopLvl,
      beApplied: false,
      legsFilled: 0,
      fundingSeen: tsClose,
      riskUsd: qty0 * stopDist,
      flows: [],
      legs: '',
    });
    state.cooldownUntil = tsClose + p.cooldownMin * 60_000;
    events.push({ t: tsClose, event: 'entry', side, price: entry, qty: qty0, fee: fee0 });

    // The entry fills at the reaction bar's OPEN, so that same bar's own
    // high/low can already trip the stop or first TP leg. Manage ONLY the
    // new position now; the others were managed in step 2 and must not be
    // double-processed on this bar.
    managePositions(positions, equity, tsClose, nxtOpen, nxtHigh, nxtLow, p, events, trips, side);
  }

  if (positions.size) {
    flattenAll(positions, equity, times5[iEnd] + SPAN_MS['5m'], closes5[iEnd], 'end_of_data', p, events, trips);
  }
  return { equityEnd: equity.value, trips, events };
}

export function atrAt(market, tfname, tClose) {
  const win = market.windowAt(tfname, tClose - SPAN_MS[tfname] + 1);
  if (!win) return NaN;
  const c = win.klines.map((k) => k.close);
  const h = win.klines.map((k) => k.high);
  const l = win.klines.map((k) => k.low);
  const value = atr(h, l, c, 14);
  return Number.isFinite(value) ? value : NaN;
}

function accrueFunding(pos, market, side, untilT) {
  const k = bisectRight(market.fundingTimes, pos.fundingSeen);
  const j = bisectRight(market.fundingTimes, untilT);
  if (j <= k) return 0.0;
  const notional = pos.qty * pos.entry;
  let total = 0;
  for (let idx = k; idx < j; idx++) {
    const rate = market.fundingRates[idx];
    total += side === 'long' ? -rate * notional : rate * notional;
    pos.fundingSeen = market.fundingTimes[idx];
  }
  if (total) pos.flows.push(total);
  return total;
}

function managePositions(positions, equity, tsClose, nxtOpen, hi, lo, p, events, trips, onlySide = null) {
  for (const side of [...positions.keys()]) {
    const pos = positions.get(side);
    const isLong = side === 'long';
    if (onlySide && side !== onlySide) continue;

    // stop-first at the PRE-BAR stop level; gap-open fills at the opened
    // -through price which is the worst realistic case on gap stops
    const stopHit = isLong ? lo <= pos.stopLvl : hi >= pos.stopLvl;
    if (stopHit) {
      const gap = isLong ? nxtOpen <= pos.stopLvl : nxtOpen >= pos.stopLvl;
      const fill = gap
        ? (isLong ? nxtOpen * (1 - p.slipBps / 10_000) : nxtOpen * (1 + p.slipBps / 10_000))
        : (isLong ? pos.stopLvl * (1 - p.slipBps / 10_000) : pos.stopLvl * (1 + p.slipBps / 10_000));
      closeQty(positions, pos, equity, pos.qty, fill, tsClose, 'stop', p, events, trips);
      continue;
    }

    // ladder legs
    while (pos.legsFilled < p.ladderFractions.length) {
      const step = p.ladderSteps[pos.legsFilled];
      const dist = pos.atr15 * pos.tgtMult * step;
      const tpLvl = isLong ? pos.entry + dist : pos.entry - dist;
      const gap = isLong ? nxtOpen >= tpLvl : nxtOpen <= tpLvl;
      const hit = isLong ? hi >= tpLvl : lo <= tpLvl;
      if (!hit && !gap) break;
      const fillLvl = gap ? (isLong ? Math.max(tpLvl, nxtOpen) : Math.min(tpLvl, nxtOpen)) : tpLvl;
      const fill = isLong ? fillLvl * (1 - p.slipBps / 10_000) : fillLvl * (1 + p.slipBps / 10_000);
      const qClose = Math.min(pos.qty, pos.qty0 * p.ladderFractions[pos.legsFilled]);
      pos.legsFilled += 1;
      pos.legs += `tp${pos.legsFilled}@${fill.toFixed(2)};`;
      closeQty(positions, pos, equity, qClose, fill, tsClose, `tp${pos.legsFilled}`, p, events, trips);
      if (!positions.has(side)) break;
    }
    if (!positions.has(side)) continue;

    // breakeven (idempotent, tighten-only)
    if (!pos.beApplied) {
      const move = isLong ? (nxtOpen - pos.entry) / pos.entry : (pos.entry - nxtOpen) / pos.entry;
      const roiNow = move * p.leverage * 100;
      const tightens = isLong ? pos.stopLvl <= pos.entry : pos.stopLvl >= pos.entry;
      if (roiNow >= p.breakevenRoiPct && tightens) {
        pos.stopLvl = pos.entry;
        pos.beApplied = true;
        events.push({ t: tsClose, event: 'breakeven', side, price: pos.entry });
      }
    }
  }
}

function closeQty(positions, pos, equity, qty, fillPrice, when, cause, p, events, trips) {
  const isLong = pos.side === 'long';
  const cash = isLong ? (fillPrice - pos.entry) * qty : (pos.entry - fillPrice) * qty;
  const fee = fillPrice * qty * p.feeBps / 10_000;
  pos.feesPaid += fee;
  equity.value += cash - fee;
  pos.flows.push(cash - fee);
  pos.qty -= qty;
  events.push({ t: when, event: `exit_${cause}`, side: pos.side, price: fillPrice, qty, fee, cash });
  const dust = pos.qty0 * 1e-9;
  if (pos.qty <= dust || pos.qty <= 1e-12) {
    pos.closedAt = when;
    trips.push(finalizeTrip(pos, p, cause));
    positions.delete(pos.side);
  }
}

function flattenAll(positions, equity, when, mark, reason, p, events, trips) {
  for (const side of [...positions.keys()]) {
    const pos = positions.get(side);
    const isLong = side === 'long';
    const fill = isLong ? mark * (1 - p.slipBps / 10_000) : mark * (1 + p.slipBps / 10_000);
    closeQty(positions, pos, equity, pos.qty, fill, when, reason, p, events, trips);
  }
}

function finalizeTrip(pos, p, cause) {
  const pnl = pos.flows.reduce((a, b) => a + b, 0);
  const margin = pos.margin;
  const roePct = margin ? (pnl / margin) * 100 : 0;
  return {
    side: pos.side,
    open_t: pos.openT,
    close_t: pos.closedAt,
    entry: pos.entry,
    qty0: pos.qty0,
    margin,
    pnl,
    roe_pct: roePct,
    r_units: pos.riskUsd > 0 ? pnl / pos.riskUsd : 0,
    legs_filled: pos.legsFilled,
    fees_total: pos.feesPaid,
    cause,
    flows: pos.flows,
  };
}
