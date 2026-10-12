import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('one live position per symbol', () => {
  const setup = async open => {
    const { CONFIG } = await import('../src/config.js');
    const { Trader } = await import('../src/trader/trader.js');
    CONFIG.auto_trade = true;
    CONFIG.cooldown_minutes = 0;
    CONFIG.signal_confirm_scans = 1;
    CONFIG.max_positions = 3;
    const trader = new Trader({
      getPendingPositions: async () => open.map((side, i) => ({
        symbol: CONFIG.symbol, positionId: String(i + 1), side, qty: '1', avgOpenPrice: '100', markPrice: '100',
      })),
    });
    return { trader, CONFIG };
  };
  const signal = (dir, symbol) => ({ signal: dir, confirmations: 1, lastPrice: 100, symbol, confidence: 90, tfSignals: {} });

  it('refuses a second entry on the same side', async () => {
    const { trader, CONFIG } = await setup(['LONG']);
    const res = await trader.executeSignal(signal('bullish', CONFIG.symbol));
    assert.equal(res.reason, 'same_side_position_open');
  });

  it('refuses the opposite side while a position is open', async () => {
    const { trader, CONFIG } = await setup(['LONG']);
    const res = await trader.executeSignal(signal('bearish', CONFIG.symbol));
    assert.equal(res.reason, 'opposite_side_position_open');
  });
});

describe('scanner scores closed candles only', () => {
  it('drops the forming (newest) bar', async () => {
    const { CONFIG } = await import('../src/config.js');
    const Scanner = (await import('../src/bitunix/scanner.js')).default;
    const seen = [];
    const bars = Array.from({ length: 200 }, (_, i) => ({ time: String(i), open: '100', high: '101', low: '99', close: '100', baseVol: '10' }));
    const scanner = new Scanner({ getKlines: async () => bars });
    const out = await scanner.getKlinesFor(CONFIG.symbol, ['15m']);
    seen.push(out['15m']);
    assert.equal(seen[0].length, 199);
    assert.equal(seen[0].at(-1).time, '198');
  });
});
