// votes.js — the consensus-vote layer of the Pivot C backtest.
//
// It imports the repository's ACTUAL strategy book and signal math
// (src/bitunix/indicators.js) so the backtest votes exactly what the live bot
// votes — there is no re-implementation here, only the pure gate slice of
// scanner.js scan(), which is not exported as its own function (it lives in
// the class between lines ~85-239; the mirrors reference those lines).
//
// Gate configuration comes from the Pivot C draft
// (reports/strategy-pivot/pivot_drafts/exportable/pivot_C_carry_filter.yaml):
// timeframes [5m,15m,1h], min_confidence 80, eligible 2, efficiency 20,
// adx 25, margin 12 — the same thresholds as config.js defaults except the
// timeframe list.

import { computeSignal, STRATEGIES, atr } from '../../src/bitunix/indicators.js';
import { atrMultiples } from '../../src/trader/tpsl.js';
import { TARGET_TFS, SPAN_MS } from './data.js';

export const GATES = Object.freeze({
  tfMinConfidence: 60,          // config.js tf_min_confidence
  minConfidence: 80,            // draft base_vote
  minAgreeingStrategies: 2,     // config.js
  minEligibleTimeframes: 2,     // draft
  minEfficiency: 20,            // config.js/draft
  minAdx: 25,                   // config.js/draft
  minScoreMargin: 12,           // draft (mean-per-TF book points)
});

/** Pure port of scanner.js gating over per-timeframe computeSignal results.
 * tfSignals: array of computeSignal() outputs in the configured TF order. */
export function evaluateVote(tfSignals) {
  const eligible = tfSignals.filter(
    (s) => s.direction !== 'neutral' && s.confidence >= GATES.tfMinConfidence,
  );

  let net = 0;
  for (const s of eligible) net += s.score * (s.confidence / 100);
  const direction = net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral';

  const alignedTimeframes =
    direction === 'neutral' ? [] : eligible.filter((s) => s.direction === direction);
  const quorum = Math.max(1, Math.ceil(eligible.length / 2));
  const enoughTimeframes = eligible.length >= GATES.minEligibleTimeframes;
  const timeframesAgree = enoughTimeframes && alignedTimeframes.length >= quorum;

  // scanner.js strategyAgreement: a strategy aligned in at least quorum
  // eligible timeframes counts toward agreeingStrategies.
  const seen = {};
  if (direction !== 'neutral' && eligible.length) {
    for (const { key } of STRATEGIES) {
      const alignedCount = eligible.filter((s) => s.strategyDirections[key] === direction).length;
      if (alignedCount >= quorum) seen[key] = alignedCount;
    }
  }
  const agreeingStrategies = Object.keys(seen).length;

  const averageConfidence = alignedTimeframes.length
    ? alignedTimeframes.reduce((sum, s) => sum + s.confidence, 0) / alignedTimeframes.length
    : 0;

  // regime gates, fail closed like gateThreshold() does in scanner.js
  const effValues = eligible.map((s) => Number(s.efficiency))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const efficiencyOk = effValues.length
    ? effValues.reduce((a, b) => a + b, 0) / effValues.length >= GATES.minEfficiency
    : false;
  const adxValues = eligible.map((s) => Number(s.adx))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const adxOk = adxValues.length
    ? adxValues.reduce((a, b) => a + b, 0) / adxValues.length >= GATES.minAdx
    : false;
  const netScore = eligible.length ? Math.abs(net) / eligible.length : 0;
  const marginOk = netScore >= GATES.minScoreMargin;

  const passes =
    direction !== 'neutral' &&
    timeframesAgree &&
    enoughTimeframes &&
    averageConfidence >= GATES.minConfidence &&
    agreeingStrategies >= GATES.minAgreeingStrategies &&
    efficiencyOk &&
    adxOk &&
    marginOk;

  return {
    passes,
    direction,
    net_score: netScore,
    avg_confidence: averageConfidence,
    eligible: eligible.length,
    aligned_tfs: alignedTimeframes.length,
    agreeing_strategies: agreeingStrategies,
    trend_efficiency: effValues.length ? effValues.reduce((a, b) => a + b, 0) / effValues.length : null,
    trend_adx: adxValues.length ? adxValues.reduce((a, b) => a + b, 0) / adxValues.length : null,
    atr15: tfSignals.length > 1 ? tfSignals[1].atr : null,
  };
}

/** Vote at a 5m bar close time T (windows exactly as the live bot builds
 * them: last <=200 CLOSED bars per TF). Returns evaluateVote result or null
 * when any TF lacks the 60-bar minimum (scanner throws there; refusing to
 * trade is the fail-closed translation). */
export function voteAt(market, tClose) {
  const tfs = [];
  for (const tf of TARGET_TFS) {
    const span = SPAN_MS[tf];
    const win = market.windowAt(tf, tClose - span + 1);
    if (!win) return null;
    tfs.push(computeSignal(win.klines, win.volumes, market.fundingAsof(tClose) ?? 0));
  }
  return evaluateVote(tfs);
}

export { atrMultiples, atr };
