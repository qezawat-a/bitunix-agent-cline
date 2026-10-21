// Regression: a refused liquidation re-arm must not abort the rest of the tick.
//
// Observed on a live 50x row whose stop sat inside the liquidation padding:
// `rearmStopIfInsideLiq` -> `confirmedStopMove` could not get the exchange to
// confirm the move, so it armed a SOFTWARE stop and threw. That throw escaped
// `midManage`'s per-position try/catch, which meant every step after it was
// skipped for the one position that needed them most:
//
//   - `checkSoftStop` never ran, and it is the ONLY code that ever enforces the
//     software stop that was just armed. The stop was recorded and then never
//     watched.
//   - `checkBreakeven` and `checkTrailing` never ran, so the stop stayed parked
//     at its original ATR level for the whole trade ("the stop never moved even
//     though I'm in profit").
//
// The failure must still be reported to the operator; it must not be swallowed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PositionManager } from '../src/trader/position-manager.js';

// Stop-move confirmation polls the exchange with a real delay between attempts.
// Zero it so a refused move fails fast instead of costing seconds per tick.
PositionManager.STOP_VERIFY_DELAY_MS = 0;

const settings = {
  symbol: 'BTCUSDT',
  tpsl_method: 'position',
  leverage: 10,
  min_confidence: 80,
  breakeven_threshold_pct: 1,
  trailing_trigger_roi_pct: 25,
  sl_liquidation_safety: 0.6,
  cooldown_minutes: 0,
  on_tpsl_failure: 'alert',
  max_positions: 3,
  account_tp_roi_pct: 0,
  account_sl_roi_pct: 0,
  partial_tp_fractions: [1],
  partial_tp_roi_steps: [1],
  reversal_enabled: false,
  reversal_confidence: 85,
};

// A position already protected, whose stop (98) sits inside its liquidation
// padding, and where the exchange refuses to confirm any stop move.
function refusingClient() {
  return {
    getPendingPositions: async () => [
      {
        positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1',
        avgPrice: '100', markPrice: '100.5', leverage: 10, liqPrice: '99.5', atr: 1,
      },
    ],
    getPendingTPSL: async () => [{ positionId: 'p1', tpPrice: '103', slPrice: '98' }],
    getTradingPairs: async () => [{ symbol: 'BTCUSDT', quotePrecision: 2, basePrecision: 4 }],
    // Accepts the request, never reflects it back: the move is unconfirmed.
    modifyTPSL: async () => ({}),
    closePosition: async () => ({}),
  };
}

describe('a refused liquidation re-arm does not abort the manage tick', () => {
  it('still runs the soft-stop check and break-even for that position', async () => {
    const pm = new PositionManager(refusingClient(), 'BTCUSDT', settings);
    const ran = [];
    for (const name of ['checkSoftStop', 'checkBreakeven', 'checkTrailing']) {
      const orig = pm[name].bind(pm);
      pm[name] = async (position) => {
        ran.push(name);
        return orig(position);
      };
    }

    const errors = await pm.midManage();

    assert.ok(
      ran.includes('checkSoftStop'),
      'the software stop armed by the refused re-arm must still be enforced this tick',
    );
    assert.ok(
      ran.includes('checkBreakeven'),
      'break-even must still run after a refused re-arm',
    );
    // The refusal itself must still surface, not be silently dropped.
    assert.ok(
      errors.some(error => /not confirmed by the exchange/.test(error.message)),
      'the refused stop move must still be reported as an error',
    );
  });

  it('arms a software stop that is reachable, so a fall through it closes the position', async () => {
    const client = refusingClient();
    // Mark below the level the re-arm wanted (99.5 * 1.002 = 99.7) so the
    // software stop is crossed on the very next tick.
    client.getPendingPositions = async () => [
      {
        positionId: 'p1', symbol: 'BTCUSDT', side: 'BUY', qty: '1',
        avgPrice: '100', markPrice: '99.6', leverage: 10, liqPrice: '99.5', atr: 1,
      },
    ];
    const closes = [];
    client.closePosition = async (symbol, positionId) => {
      closes.push(positionId);
      return { closed: positionId };
    };
    const pm = new PositionManager(client, 'BTCUSDT', settings);

    await pm.midManage();

    assert.deepEqual(closes, ['p1'], 'the software stop must be enforced, not just recorded');
    assert.equal(pm.softStops.size, 0, 'an enforced software stop is cleared');
  });
});
