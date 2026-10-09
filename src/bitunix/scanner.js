import { computeSignal } from './indicators.js';
import { CONFIG } from '../config.js';

// Read a gate threshold without letting a broken value disable the gate.
// `Number(x) || 0` is the obvious version and it fails open twice over: an
// unreadable value (min_adx=abc) and an absent one (null, "", " ") both become
// 0, which is the documented "gate off" value. A typo in the environment would
// then silently remove the one control standing between the bot and a range.
// Only a real number counts; everything else returns null and the caller blocks
// and says why.
function gateThreshold(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

class Scanner {
  client;

  constructor(client) {
    this.client = client;
  }

  async getKlinesFor(symbol, timeframes) {
    const output = {};
    for (const timeframe of timeframes) {
      const klines = await this.client.getKlines(symbol, timeframe, 200);
      if (!Array.isArray(klines) || klines.length < 60) throw new Error(`invalid ${timeframe} kline response for ${symbol}`);
      output[timeframe] = klines;
    }
    return output;
  }

  async getFunding(symbol) {
    try {
      const data = await this.client.getFundingRate(symbol);
      const record = Array.isArray(data) ? data[0] : data;
      const value = Number(record?.fundingRate ?? record?.value);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async getLastPrice(symbol) {
    // computeSignal needs klines, but a kline's `close` is a snapshot as of
    // when that candle formed — up to a full timeframe interval stale (worse
    // the more `timeframes[0]` is a slow interval like 15m/1h). Bitunix's
    // actual live price is the "tickers" endpoint's lastPrice/markPrice.
    // https://www.bitunix.com/api-docs/futures/market/get_tickers.html
    const tickers = await this.client.getTickers(symbol);
    const ticker = Array.isArray(tickers) ? tickers.find(t => t.symbol === symbol) : tickers;
    const price = Number(ticker?.lastPrice ?? ticker?.markPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid ticker price for ${symbol}`);
    return price;
  }

  async scan(symbol) {
    const timeframes = CONFIG.timeframes;
    const klinesMap = await this.getKlinesFor(symbol, timeframes);
    const funding = await this.getFunding(symbol);
    const tfSignals = {};
    const eligible = [];
    const directionCounts = { bullish: 0, bearish: 0, neutral: 0 };

    for (const timeframe of timeframes) {
      const klines = klinesMap[timeframe];
      const result = computeSignal(klines, klines.map(kline => Number(kline.baseVol)), funding);
      tfSignals[timeframe] = result;
      directionCounts[result.direction]++;
      if (result.confidence >= CONFIG.tf_min_confidence && result.direction !== 'neutral') eligible.push(result);
    }

    // Weight each timeframe by its own confidence instead of summing raw scores.
    // A raw sum let one loud timeframe outvote two quieter ones pointing the
    // other way, and it treated "60% sure" and "95% sure" as equally loud.
    const net = eligible.reduce((sum, result) => sum + result.score * (result.confidence / 100), 0);
    const direction = net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral';

    // A weighted vote still lets a minority of timeframes win, so the direction
    // additionally has to be the majority of the eligible timeframes. Previously
    // directionCounts was computed and then never read, so one timeframe
    // screaming against three quiet ones was indistinguishable from agreement.
    const alignedTimeframes = direction === 'neutral'
      ? 0
      : eligible.filter(result => result.direction === direction).length;
    const timeframeQuorum = Math.max(1, Math.ceil(eligible.length / 2));
    // A single qualifying timeframe used to be enough on its own, because the
    // strategy quorum then degenerated to ceil(1/2) = 1. Requiring two keeps the
    // "multi-timeframe" gate honest.
    const enoughTimeframes = eligible.length >= Math.max(1, Number(CONFIG.min_eligible_timeframes) || 1);
    // With one eligible timeframe the majority *is* that timeframe, so the
    // majority gate above is vacuously true and a single lone reading carries
    // the entire signal: three timeframes silent, 5m bullish 93%, rawDirection
    // bullish, timeframesAgree true. Agreement across timeframes means nothing
    // below the quorum, so it is reported false rather than passing on a
    // technicality. The count gate already blocks the trade; this also stops
    // the report from claiming the timeframes agreed when only one spoke.
    const timeframesAgree = enoughTimeframes && alignedTimeframes >= timeframeQuorum;

    const strategyAgreement = {};
    if (direction !== 'neutral') {
      for (const name of Object.keys(eligible[0]?.strategyDirections || {})) {
        const aligned = eligible.filter(result => result.strategyDirections[name] === direction);
        const quorum = Math.max(1, Math.ceil(eligible.length / 2));
        if (aligned.length >= quorum) {
          strategyAgreement[name] = {
            timeframes: aligned.length,
            contribution: aligned.reduce((sum, result) => sum + result.contributions[name], 0),
          };
        }
      }
    }

    const agreeingStrategies = Object.keys(strategyAgreement).length;
    const averageConfidence = eligible.length
      ? eligible.reduce((sum, result) => sum + result.confidence, 0) / eligible.length
      : 0;

    // ---- regime gates ------------------------------------------------------
    // Every gate above measures HOW MANY strategies agreed. None of them asks
    // whether the market is trending at all — and in a range, EMA crossovers,
    // MACD, Supertrend and the ATR breakout all ride the same close series, so
    // they flip together and flip wrong together. The result was a unanimous,
    // 100%-confidence reading of a range, which is what took the OGNUSDT
    // position down one stop at a time.
    //
    // The gate is net progress over path travelled (efficiency ratio). ADX was
    // tried first and is measurably the wrong tool here: it scores directional
    // MOVEMENT, so a slow bounded oscillation rates as a strong trend. Across
    // bounded sawtooths ADX read up to 70.8 while a genuine trend read as low
    // as 52.1 — the range scored HIGHER than the trend. Efficiency inverts that
    // cleanly: ranges topped out at 16.1%, real trends bottomed out at 38.9%.
    // ADX is still reported (it is a standard read an operator expects to see)
    // but it no longer decides.
    const effValues = eligible
      .map(result => Number(result.efficiency))
      .filter(value => Number.isFinite(value) && value >= 0);
    const trendEfficiency = effValues.length
      ? effValues.reduce((sum, value) => sum + value, 0) / effValues.length
      : null;
    const adxValues = eligible
      .map(result => Number(result.adx))
      .filter(value => Number.isFinite(value) && value >= 0);
    const trendAdx = adxValues.length
      ? adxValues.reduce((sum, value) => sum + value, 0) / adxValues.length
      : null;
    // Both thresholds fail CLOSED (see gateThreshold above).
    const minEfficiency = gateThreshold(CONFIG.min_efficiency);
    const effConfigured = minEfficiency !== null;
    const efficiencyOk = !effConfigured
      ? false
      : minEfficiency <= 0 || (trendEfficiency !== null && trendEfficiency >= minEfficiency);

    // ADX stays as an optional second opinion rather than being deleted: at its
    // 25 default it independently blocked 7 of 18 bounded shapes, and requiring
    // a market to be both moving strongly AND going somewhere is the right
    // shape for the gate even though ADX alone cannot do the job.
    const minAdx = gateThreshold(CONFIG.min_adx);
    const adxConfigured = minAdx !== null;
    const adxOk = !adxConfigured
      ? false
      : minAdx <= 0 || (trendAdx !== null && trendAdx >= minAdx);

    // A margin-of-victory gate. `net > 0` treats a +3 net score exactly like a
    // +90, so in a range — where the book sits near even and the sign flips on
    // noise — a barely tilted score was promoted to a full directional entry.
    //
    // Measured per qualifying timeframe rather than summed. netScore is a sum
    // over eligible timeframes, so a sum-based threshold gets weaker every time
    // another timeframe qualifies: at the default of 12 with five timeframes
    // each only had to lean 2.4 points out of a 146-point book — 1.6% — and
    // the gate blocked nothing at all. Averaging holds the threshold constant
    // in book points however many timeframes show up, and makes the 0-146
    // validation range mean exactly what it says.
    const minMargin = gateThreshold(CONFIG.min_score_margin);
    const marginConfigured = minMargin !== null;
    const netScore = eligible.length ? Math.abs(net) / eligible.length : 0;
    const marginOk = !marginConfigured
      ? false
      : minMargin <= 0 || netScore >= minMargin;

    // Both gates name themselves when they hold. A gate that blocks without
    // saying so is indistinguishable from a broken scanner, which is the exact
    // confusion that made this whole failure look like a bug elsewhere. A
    // misconfigured threshold is reported as its own condition rather than as
    // "below min_efficiency 0", because the number shown would be a lie.
    const blockedBy = [];
    if (!effConfigured) {
      blockedBy.push(`min_efficiency is not a readable number (got ${JSON.stringify(CONFIG.min_efficiency)}) — refusing to trade without a range gate`);
    } else if (!efficiencyOk) {
      blockedBy.push(`efficiency ${trendEfficiency === null ? 'unavailable' : trendEfficiency.toFixed(1) + '%'} below min_efficiency ${minEfficiency}% (price is going nowhere)`);
    }
    if (!adxConfigured) {
      blockedBy.push(`min_adx is not a readable number (got ${JSON.stringify(CONFIG.min_adx)}) — refusing to trade without a trend gate`);
    } else if (!adxOk) {
      blockedBy.push(`ADX ${trendAdx === null ? 'unavailable' : trendAdx.toFixed(1)} below min_adx ${minAdx} (no trend to ride)`);
    }
    if (!marginConfigured) {
      blockedBy.push(`min_score_margin is not a readable number (got ${JSON.stringify(CONFIG.min_score_margin)}) — refusing to trade without a margin gate`);
    } else if (!marginOk) {
      blockedBy.push(`mean net score ${netScore.toFixed(1)} below min_score_margin ${minMargin}`);
    }

    const passes = direction !== 'neutral'
      && timeframesAgree
      && enoughTimeframes
      && averageConfidence >= CONFIG.min_confidence
      && agreeingStrategies >= CONFIG.min_agreeing_strategies
      && efficiencyOk
      && adxOk
      && marginOk;

    // Previously: klinesMap[timeframes[0]]?.at(-1)?.close — stale by up to
    // one full bar of whichever timeframe happened to be listed first, which
    // is the "price tolerance" drift between what the bot thinks the price
    // is and the live market. Fall back to the kline close only if the
    // ticker call itself fails, so scanning doesn't hard-stop on a blip.
    let lastPrice;
    try {
      lastPrice = await this.getLastPrice(symbol);
    } catch {
      lastPrice = klinesMap[timeframes[0]]?.at(-1)?.close;
    }
    if (!Number.isFinite(Number(lastPrice)) || Number(lastPrice) <= 0) throw new Error(`invalid latest price for ${symbol}`);
    return {
      symbol,
      signal: passes ? direction : 'hold',
      rawDirection: direction,
      direction: passes ? direction : 'neutral',
      confidence: passes ? Math.round(averageConfidence) : 0,
      rawConfidence: Math.round(averageConfidence),
      agreeingStrategies,
      strategyAgreement,
      timeframesAgree,
      alignedTimeframes,
      lastPrice,
      tfSignals,
      directionCounts,
      eligibleTimeframes: eligible.length,
      trendAdx: trendAdx === null ? null : Math.round(trendAdx * 10) / 10,
      minAdx,
      adxOk,
      trendEfficiency: trendEfficiency === null ? null : Math.round(trendEfficiency * 10) / 10,
      minEfficiency,
      efficiencyOk,
      marginOk,
      netScore: Math.round(netScore * 10) / 10,
      minMargin,
      blockedBy,
    };
  }
}

export default Scanner;
