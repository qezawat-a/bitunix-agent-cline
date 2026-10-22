#!/usr/bin/env node
// run.js — CLI orchestrator for the Pivot C carry-filter backtest.
//
// Pipeline: load market CSVs → shard the memoryless per-event vote precompute
// across worker threads → merge the vote tables → run the portfolio
// simulation sequentially → compute whole/IS/OOS metrics (split at
// 2024-01-01, the pivot report's boundary), per-year profit factors, max
// drawdown on the closed-trade equity curve, and VaR95 of per-trip R-units →
// write JSON + Markdown → print the evaluate_backtest.py handoff line.
//
// Grading inputs for the handoff (documented so nothing can be misread):
//   win-rate and avg-win/avg-loss are ROI% ON COMMITTED MARGIN per winning /
//   losing round trip (roe_pct in trip records; margin-ROI is what the live
//   bot's breakeven and account-SL math use).
//   num-parameters = 10: TF min-confidence, vote min-confidence, min agreeing
//   strategies, min eligible TFs, efficiency gate, ADX gate, score margin,
//   stop/target multiples, TP-ladder fractions+steps, funding-veto threshold.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { loadKlinesDir, loadFundingDir, Market, bisectRight, SPAN_MS } from './data.js';
import { GATES, voteAt } from './votes.js';
import { makeParams, runSimulation, TAKER_FEE_BPS, SLIPPAGE_BPS } from './sim.js';

// ---------------------------------------------------------------- CLI ----

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}
const flag = (name) => argv.includes(name);

const dataDir = arg('--data', '/tmp/opencode/pivot-c-data');
const startArg = arg('--start', '2020-01-02');
const endArg = arg('--end', null);
const outDir = arg('--out', 'reports/strategy-pivot');
const tag = arg('--tag', 'base');
const procs = Math.max(1, Number(arg('--sigprocs', '8')) || 1);
const frictionMult = Number(arg('--friction-mult', '1')) || 1;
const stopMultArg = arg('--stop-mult', null);
const note = arg('--note', '');
const direct = flag('--direct');

const num = (name, fallback) => {
  const v = Number(arg(name, null));
  return Number.isFinite(v) ? v : fallback;
};

const startMs = Date.parse(`${startArg}T00:00:00Z`);
const endMs = endArg ? Date.parse(`${endArg}T00:00:00Z`) : null;
if (!Number.isFinite(startMs)) throw new Error(`bad --start ${startArg}`);
if (endArg && !Number.isFinite(endMs)) throw new Error(`bad --end ${endArg}`);

const t0 = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

// ------------------------------------------------------------- market ----

function loadMarket(dir) {
  const bars = {};
  for (const tf of ['5m', '15m', '1h']) bars[tf] = loadKlinesDir(`${dir}/${tf}`);
  const { events } = loadFundingDir(`${dir}/funding`);
  return new Market(bars, events);
}

console.log(`[1/4] loading market from ${dataDir} ...`);
const market = loadMarket(dataDir);
const times5 = market.tf['5m'].times;

// Event index range — MUST match sim.js's internal bisect exactly by
// construction (same array, same bisectRight, same guards).
const i0 = Math.max(1, bisectRight(times5, startMs));
const iEnd = endMs ? bisectRight(times5, endMs) - 1 : times5.length - 1;
const evCount = iEnd - i0;
if (evCount <= 0) throw new Error(`empty event range (${startArg}..${endArg}) over ${times5.length} bars`);
console.log(`      events [${iso(times5[i0])} .. ${iso(times5[iEnd - 1] + SPAN_MS['5m'])}] count=${evCount}`);
console.log(`      5m=${times5.length} 15m=${market.tf['15m'].times.length} 1h=${market.tf['1h'].times.length} funding=${market.fundingTimes.length}`);

// -------------------------------------------------------------- votes ----
// Memoryless per event → contiguous shards need no overlap. Worker result
// tables are full-length arrays filled by offset, so the sim's `table.pass[i]`
// is indexed by the SAME event index i the sim iterates.

console.log(`[2/4] precomputing votes (${direct ? 'in-process recompute' : `${procs} worker shards`}) ...`);
const table = {
  pass: new Uint8Array(times5.length),
  dir: new Uint8Array(times5.length),
  conf: new Float32Array(times5.length),
};

if (direct) {
  for (let i = i0; i < iEnd; i++) {
    const vote = voteAt(market, times5[i] + SPAN_MS['5m']);
    if (!vote || !vote.passes) continue;
    table.pass[i] = 1;
    table.dir[i] = vote.direction === 'bullish' ? 1 : 2;
    table.conf[i] = vote.avg_confidence;
  }
} else {
  const nShards = Math.min(procs, evCount);
  const shardSize = Math.ceil(evCount / nShards);
  const workerUrl = new URL('./votes.worker.js', import.meta.url);
  const tVote = Date.now();
  await Promise.all(
    Array.from({ length: nShards }, (_, s) =>
      new Promise((resolve, reject) => {
        const startIdx = i0 + s * shardSize;
        const total = Math.min(shardSize, iEnd - startIdx);
        if (total <= 0) { resolve(); return; }
        let done = false;
        const w = new Worker(workerUrl, { workerData: { dataDir, startIdx, total } });
        w.on('message', (msg) => {
          table.pass.set(msg.pass, msg.first);
          table.dir.set(msg.dir, msg.first);
          table.conf.set(msg.conf, msg.first);
          done = true;
          resolve();
        });
        w.on('exit', (code) => {
          if (!done) reject(new Error(`vote worker exited before posting (code ${code})`));
        });
        w.on('error', reject);
      }),
    ),
  );
  console.log(`      votes done in ${((Date.now() - tVote) / 1000).toFixed(1)}s, pass=${table.pass.reduce((a, b) => a + b, 0)}`);
}

// voteFn consumed by runSimulation: precomputed table lookup keyed by event
// index (--direct recomputes live windows instead; same shape).
const voteFn = direct
  ? (i, tClose) => voteAt(market, tClose)
  : (i) => (table.pass[i]
      ? { passes: true, direction: table.dir[i] === 1 ? 'bullish' : 'bearish', avg_confidence: table.conf[i] }
      : null);

// ----------------------------------------------------------------- sim ---

const params = makeParams({
  leverage: num('--leverage', 5),
  marginFrac: num('--margin-frac', 0.015),
  maxPositions: num('--max-positions', 2),
  cooldownMin: num('--cooldown-min', 15),
  stopAtrMin: num('--stop-atr-min', 1.0),
  accountSlRoiPct: num('--account-sl', -4.0),
  breakevenRoiPct: num('--breakeven', 20.0),
  fundingVeto: num('--funding-veto', 0.0005),
  feeBps: TAKER_FEE_BPS * frictionMult,
  slipBps: SLIPPAGE_BPS * frictionMult,
  stopMultOverride: stopMultArg !== null ? Number(stopMultArg) : null,
  startMs,
  endMs,
});

console.log('[3/4] running simulation ...');
const tSim = Date.now();
const res = runSimulation(market, params, voteFn);
console.log(`      sim done in ${((Date.now() - tSim) / 1000).toFixed(1)}s, ${res.trips.length} round trips`);

// ------------------------------------------------------------- metrics ---

const IS_OOS_MS = Date.UTC(2024, 0, 1); // pivot report's shared boundary

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(trips) {
  const n = trips.length;
  if (!n) return { n: 0, note: 'no trades' };
  const wins = trips.filter((t) => t.pnl > 0);
  const losses = trips.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const sortedR = trips.map((t) => t.r_units).sort((a, b) => a - b);

  let eq = 1;
  let peak = 1;
  let maxDD = 0;
  for (const t of [...trips].sort((a, b) => a.close_t - b.close_t)) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: (wins.length / n) * 100,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    avg_win_roi_pct: wins.length ? wins.reduce((s, t) => s + t.roe_pct, 0) / wins.length : 0,
    avg_loss_roi_pct: losses.length ? Math.abs(losses.reduce((s, t) => s + t.roe_pct, 0) / losses.length) : 0,
    expectancy_r: trips.reduce((s, t) => s + t.r_units, 0) / n,
    var95_r: percentile(sortedR, 0.05),
    total_pnl: trips.reduce((s, t) => s + t.pnl, 0),
    max_dd_pct: maxDD * 100,
  };
}

function perYear(trips) {
  const years = {};
  for (const t of trips) {
    const y = new Date(t.close_t).getUTCFullYear();
    (years[y] ||= []).push(t.pnl);
  }
  return Object.fromEntries(Object.entries(years).sort().map(([y, ps]) => {
    const win = ps.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const loss = Math.abs(ps.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
    return [y, { n: ps.length, pf: loss > 0 ? +(win / loss).toFixed(3) : null }];
  }));
}

const isTrips = res.trips.filter((t) => t.close_t < IS_OOS_MS);
const oosTrips = res.trips.filter((t) => t.close_t >= IS_OOS_MS);
const whole = summarize(res.trips);
const isStats = summarize(isTrips);
const oosStats = summarize(oosTrips);
const years = perYear(res.trips);

const spanYears = (times5[iEnd - 1] + SPAN_MS['5m'] - times5[i0]) / (365.25 * 86_400_000);

// conservation sanity: equity == 1 + Σtrip flows − Σentry fees
const sumFlows = res.trips.reduce((s, t) => s + t.flows.reduce((a, b) => a + b, 0), 0);
const entryFees = res.events.filter((e) => e.event === 'entry').reduce((s, e) => s + e.fee, 0);
const identityErr = res.equityEnd - (1 + sumFlows - entryFees);

// draft validation gate: OOS PF > 1.25 AND tail VaR95 ≥ −2.0R
const gate = {
  oos_pf: oosStats.profit_factor ?? null,
  oos_pf_pass: Number.isFinite(oosStats.profit_factor) && oosStats.profit_factor > 1.25,
  oos_var95_r: oosStats.var95_r ?? null,
  oos_var_pass: Number.isFinite(oosStats.var95_r) && oosStats.var95_r >= -2.0,
};
gate.overall = gate.oos_pf_pass && gate.oos_var_pass;

// -------------------------------------------------------------- output ---

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonPath = path.join(outDir, `pivotC_eval_${tag}_${stamp}.json`);
const mdPath = jsonPath.replace(/\.json$/, '.md');

const report = {
  meta: {
    tag, note, data_dir: dataDir,
    start: startArg, end: endArg ?? 'end-of-data',
    sigprocs: direct ? 'direct' : procs,
    friction_mult: frictionMult,
    stop_mult_override: stopMultArg !== null ? Number(stopMultArg) : null,
    generated_at: new Date().toISOString(),
    duration_s: +((Date.now() - t0) / 1000).toFixed(1),
  },
  params,
  gates: { ...GATES, venue: 'Binance UM BTCUSDT archive as Bitunix proxy (few-bps price/funding error)',
    spread_gate: 'UNMODELED — cost model stands in' },
  data: {
    bars_5m: times5.length, bars_15m: market.tf['15m'].times.length, bars_1h: market.tf['1h'].times.length,
    funding_events: market.fundingTimes.length,
    window: [iso(times5[i0]), iso(times5[iEnd - 1] + SPAN_MS['5m'])],
    span_years: +spanYears.toFixed(2),
    is_oos_boundary_utc: new Date(IS_OOS_MS).toISOString().slice(0, 10),
  },
  metrics: { whole, in_sample: isStats, out_of_sample: oosStats },
  per_year: years,
  validation_gate: gate,
  equity: { end: +res.equityEnd.toFixed(9), conservation_identity_err: +identityErr.toFixed(12) },
  trips: res.trips,
};

writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const fmt = (m) => (!m.n ? 'n=0' :
  `n=${m.n} win=${m.win_rate_pct.toFixed(1)}% PF=${Number.isFinite(m.profit_factor) ? m.profit_factor.toFixed(2) : '∞'} ` +
  `avgW=${m.avg_win_roi_pct.toFixed(1)}% avgL=${m.avg_loss_roi_pct.toFixed(1)}% ` +
  `E[R]=${m.expectancy_r.toFixed(3)} VaR95=${m.var95_r.toFixed(2)}R maxDD=${m.max_dd_pct.toFixed(2)}%`);

const lines = [
  `# Pivot C carry-filter evaluation — tag "${tag}"`,
  '',
  `- window: ${report.data.window[0]} → ${report.data.window[1]} (span ${report.data.span_years}y, IS/OOS at ${report.data.is_oos_boundary_utc})`,
  `- friction: fees ${params.feeBps} bps/side, slippage ${params.slipBps} bps/side (multiplier ${frictionMult})`,
  note ? `- note: ${note}` : '',
  '',
  `**Whole:** ${fmt(whole)}`,
  `**IS:**     ${fmt(isStats)}`,
  `**OOS:**    ${fmt(oosStats)}`,
  '',
  `| year | n | PF |`,
  `|---|---|---|`,
  ...Object.entries(years).map(([y, v]) => `| ${y} | ${v.n} | ${v.pf ?? '—'} |`),
  '',
  `Validation gate: OOS PF ${Number.isFinite(gate.oos_pf) ? gate.oos_pf.toFixed(2) : '—'} (>1.25? ${gate.oos_pf_pass ? 'yes' : 'no'}), OOS VaR95 ${Number.isFinite(gate.oos_var95_r) ? gate.oos_var95_r.toFixed(2) : '—'}R (≥−2.0R? ${gate.oos_var_pass ? 'yes' : 'no'}) → **${gate.overall ? 'PASS' : 'FAIL'}**`,
  '',
  `Equity end: ${res.equityEnd.toFixed(6)} (conservation error ${identityErr.toExponential(2)})`,
  '',
  'Caveats: Binance UM BTCUSDT archive stands in for Bitunix (few-bps price/funding difference); the draft\'s spread gate is unmodeled and replaced by the all-in cost model; a bar that would fill both a TP leg and the stop resolves stop-first (strategy punished).',
  '',
];
writeFileSync(mdPath, `${lines.filter((l) => l !== '').join('\n')}\n`);

// --------------------------------------------- evaluate_backtest handoff —

let handoff = null;
if (whole.n > 0) {
  const evalScript = '/root/.agents/skills/backtest-expert/scripts/evaluate_backtest.py';
  handoff = [
    'python3', evalScript,
    `--total-trades ${whole.n}`,
    `--win-rate ${whole.win_rate_pct.toFixed(1)}`,
    `--avg-win-pct ${whole.avg_win_roi_pct.toFixed(2)}`,
    `--avg-loss-pct ${whole.avg_loss_roi_pct.toFixed(2)}`,
    `--max-drawdown-pct ${whole.max_dd_pct.toFixed(2)}`,
    `--years-tested ${Math.floor(spanYears)}`,
    '--num-parameters 10',
    '--slippage-tested',
    '--max-acceptable-drawdown-pct 25',
    `--output-dir ${outDir}`,
  ].join(' ');
  console.log('');
  console.log('Handoff (win/avg = ROI% on committed margin per winning/losing trip):');
  console.log(`  ${handoff}`);
} else {
  console.log('No trips — no evaluate_backtest handoff.');
}

console.log(`[4/4] wrote ${jsonPath}`);
console.log(`      wrote ${mdPath}`);
console.log(`Validation gate: ${gate.overall ? 'PASS' : 'FAIL'} (OOS PF ${Number.isFinite(gate.oos_pf) ? gate.oos_pf.toFixed(2) : '—'}, OOS VaR95 ${Number.isFinite(gate.oos_var95_r) ? `${gate.oos_var95_r.toFixed(2)}R` : '—'})`);
