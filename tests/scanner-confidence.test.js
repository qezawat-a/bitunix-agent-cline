// Regression: the scanner's confidence must describe the direction that won.
// It used to average EVERY eligible timeframe, so a strong timeframe voting
// against the signal raised its confidence instead of being excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Scanner from '../src/bitunix/scanner.js';
import { CONFIG } from '../src/config.js';

// Chronological (oldest-first) candles with a given drift. Each timeframe gets
// its own path so the timeframes can disagree with each other.
function candles(n, drift, seed) {
  const out = [];
  let price = 100 + seed;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * (1 + drift + Math.sin(i * 0.7 + seed) * 0.002);
    const high = Math.max(open, price) * 1.001;
    const low = Math.min(open, price) * 0.999;
    out.push({
      time: String(1700000000000 + i * 60000),
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(price),
      baseVol: String(1000 + (i % 7) * 50),
    });
  }
  return out;
}

function fakeClient(driftByTimeframe) {
  return {
    async getKlines(_symbol, timeframe) {
      return candles(220, driftByTimeframe[timeframe], timeframe.length + timeframe.charCodeAt(0));
    },
    async getFundingRate() { return { fundingRate: '0' }; },
    async getTickers() { return [{ symbol: CONFIG.symbol, lastPrice: '100' }]; },
  };
}

test('rawConfidence is the mean of the timeframes that agree with the winning direction', async () => {
  const saved = CONFIG.timeframes;
  CONFIG.timeframes = ['1m', '3m', '5m', '15m'];
  try {
    const drift = { '1m': 0.004, '3m': 0.004, '5m': 0.004, '15m': -0.006 };
    const result = await new Scanner(fakeClient(drift)).scan(CONFIG.symbol);
    const winner = result.rawDirection;
    if (winner === 'neutral') return; // nothing to assert against this fixture
    const aligned = Object.values(result.tfSignals)
      .filter(s => s.direction === winner && s.confidence >= CONFIG.tf_min_confidence);
    if (!aligned.length) return;
    const expected = Math.round(aligned.reduce((sum, s) => sum + s.confidence, 0) / aligned.length);
    assert.equal(result.rawConfidence, expected);
  } finally {
    CONFIG.timeframes = saved;
  }
});
