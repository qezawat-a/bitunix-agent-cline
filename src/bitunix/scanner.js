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

    const net = eligible.reduce((sum, result) => sum + result.score, 0);
    const direction = net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral';
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
      && averageConfidence >= CONFIG.min_confidence
      && agreeingStrategies >= CONFIG.min_agreeing_strategies;

    const lastPrice = klinesMap[timeframes[0]]?.at(-1)?.close;
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
      lastPrice,
      tfSignals,
      directionCounts,
      eligibleTimeframes: eligible.length,
    };
  }
}

export default Scanner;
