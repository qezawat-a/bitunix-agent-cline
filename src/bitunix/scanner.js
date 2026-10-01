import { computeSignal } from './indicators.js';
import { CONFIG } from '../config.js';

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
    const passes = direction !== 'neutral'
      && timeframesAgree
      && enoughTimeframes
      && averageConfidence >= CONFIG.min_confidence
      && agreeingStrategies >= CONFIG.min_agreeing_strategies;

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
    };
  }
}

export default Scanner;
