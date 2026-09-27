// Pure take-profit / stop-loss arithmetic for the four Bitunix methods
// (position / partial / trailing / account).
// https://www.bitunix.com/help-center/function/Trading/How-to-Set-Up-TP-SL-Orders.html
//
// Everything exported here is side-effect free and touches no client, so the
// ladder maths, the callback maths and the account PnL maths can be unit
// tested without a network or a live account. PositionManager owns all
// orchestration (and the only file allowed to talk to the client).

// The four methods Bitunix offers for a futures position.
export const TPSL_METHODS = Object.freeze(['position', 'partial', 'trailing', 'account']);

export function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

// Prices travel to the exchange as strings; never send a rounded-up price that
// the exchange would reject or fill at a worse level than intended.
export function formatPrice(value) {
  if (!finitePositive(value)) throw new Error('price must be a positive finite number');
  return String(Number(Number(value).toFixed(8)));
}

// Quantities are strings on the wire too. A partial close is sized by
// subtraction, so it is floored (never rounded up) at base precision.
export function formatQty(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('quantity must be a positive finite number');
  return String(Number(number.toFixed(8)));
}

// Bitunix names the open quantity differently across endpoints/models; the
// position-level model uses `qty`, the order model uses `size`.
export function positionBaseQty(position) {
  const qty = position?.qty ?? position?.size ?? position?.positionQty ?? position?.positionSize;
  return finitePositive(qty) ? Number(qty) : 0;
}

export function positionBasePrecision(position) {
  const precision = Number(position?.basePrecision);
  return Number.isInteger(precision) && precision >= 0 ? precision : 8;
}

// Unknown / missing / typo'd settings must never leave a position unprotected:
// anything that is not a known method falls back to the all-in/all-out method.
export function normalizeMethod(value) {
  const method = String(value ?? '').trim().toLowerCase();
  return TPSL_METHODS.includes(method) ? method : 'position';
}

// The ATR multiples shared by the position and partial methods, so a ladder
// step of 1 lands on exactly the target computeTPSL would have used.
// More confidence -> tighter stop and a slightly more ambitious target.
export function atrMultiples(confidence) {
  const normalizedConfidence = Math.max(0, Math.min(100, Number(confidence) || 0));
  const strength = normalizedConfidence / 100;
  return {
    strength,
    targetMultiple: 1.8 + strength * 1.2,
    stopMultiple: 1.55 - strength * 0.45,
  };
}

// Settings validation already keeps fractions and steps the same length, but a
// hand-edited settings.json must fail loudly instead of silently mis-sizing the
// ladder.
export function validateLadder(fractions, steps) {
  if (!Array.isArray(fractions) || !Array.isArray(steps) || !fractions.length) {
    throw new Error('partial TP/SL needs a non-empty partial_tp_fractions array');
  }
  if (fractions.length !== steps.length) {
    throw new Error(`partial TP/SL needs matching ladder arrays: ${fractions.length} fractions vs ${steps.length} roi steps`);
  }
  const ladder = fractions.map((fraction, index) => {
    const share = Number(fraction);
    if (!Number.isFinite(share) || share <= 0) throw new Error(`partial_tp_fractions[${index}] must be a positive number`);
    const step = Number(steps[index]);
    if (!Number.isFinite(step) || step <= 0) throw new Error(`partial_tp_roi_steps[${index}] must be a positive number`);
    return { fraction: share, step };
  });
  const total = ladder.reduce((sum, item) => sum + item.fraction, 0);
  // Fractions above 1 would ask the exchange to close more than is open.
  if (total > 1 + 1e-9) throw new Error(`partial_tp_fractions must not sum above 1 (got ${total})`);
  return ladder;
}

// Splitting one position into partial closes must be exact. Doing it in floats
// loses the dust (1.234 at 3dp split 0.3/0.4/0.3 can leave a 0.001 remainder
// that rounds away to zero), and that sliver would then have neither a
// take-profit leg nor a stop. Integer base-precision ticks make the parts plus
// the remainder equal the position exactly.
export function splitQuantity(totalQty, fractions, precision) {
  const qty = Number(totalQty);
  if (!finitePositive(qty)) throw new Error('partial TP/SL requires a positive position quantity');
  const digits = Number.isInteger(Number(precision)) && Number(precision) >= 0 ? Number(precision) : 8;
  const scale = 10 ** digits;
  const totalTicks = Math.round(qty * scale);
  const parts = fractions.map(fraction => Math.floor(qty * Number(fraction) * scale + 1e-6));
  const remainderTicks = totalTicks - parts.reduce((sum, ticks) => sum + ticks, 0);
  // Only reachable if the fractions ask for more than is open; refuse rather
  // than sending the exchange an over-sized partial close.
  if (remainderTicks < 0) throw new Error('partial TP/SL fractions exceed the open position quantity');
  return { parts, remainderTicks, scale, digits, totalTicks };
}

// Method 2 (partial). Each step i triggers at `roiSteps[i] x` the base ATR
// take-profit distance and closes `fraction` of the open quantity. Whatever
// the fractions do not cover is the remainder that keeps riding the stop.
export function buildPartialLadder({ position, entryPrice, direction, atr, confidence, fractions, steps }) {
  if (!finitePositive(entryPrice)) throw new Error('entryPrice must be positive');
  if (!finitePositive(atr)) throw new Error('ATR is required for dynamic TP/SL; refusing a static fallback');
  if (!['bullish', 'bearish'].includes(direction)) throw new Error('direction must be bullish or bearish');
  const ladder = validateLadder(fractions, steps);
  const { targetMultiple } = atrMultiples(confidence);
  const tpDist = Number(atr) * targetMultiple;
  const totalQty = positionBaseQty(position);
  const precision = positionBasePrecision(position);
  const { parts, remainderTicks, scale } = splitQuantity(totalQty, ladder.map(item => item.fraction), precision);
  const sign = direction === 'bullish' ? 1 : -1;
  const legs = [];
  ladder.forEach((item, index) => {
    // A leg that rounds away to nothing cannot be sent: the exchange rejects a
    // zero partial quantity, and silently dropping it would lose that share.
    if (!(parts[index] > 0)) return;
    legs.push({
      index,
      fraction: item.fraction,
      tpPrice: formatPrice(entryPrice + sign * tpDist * item.step),
      qty: parts[index] / scale,
      tpOrderType: 'MARKET',
      tpStopType: 'MARK_PRICE',
    });
  });
  if (!legs.length) {
    throw new Error('partial TP/SL ladder produced no executable legs; the position is too small for partial_tp_fractions');
  }
  return { legs, remainder: remainderTicks / scale, qty: totalQty, precision, tpDist };
}

// Method 4 (account). One position's unrealised PnL and the margin it commits.
export function positionPnlAndMargin(position, defaultLeverage = 1) {
  const side = position?.side === 'BUY' ? 1 : position?.side === 'SELL' ? -1 : 0;
  const entry = Number(position?.avgPrice);
  const mark = Number(position?.markPrice);
  const qty = positionBaseQty(position);
  const leverage = finitePositive(position?.leverage)
    ? Number(position.leverage)
    : finitePositive(defaultLeverage) ? Number(defaultLeverage) : 1;
  const rawPnl = position?.unrealizedPNL ?? position?.unrealizedPnl ?? position?.unrealisedPNL ?? position?.pnl;
  // The pending-position model carries unrealizedPNL; derive it only when the
  // exchange did not send it.
  const pnl = Number.isFinite(Number(rawPnl))
    ? Number(rawPnl)
    : finitePositive(entry) && finitePositive(mark) && side ? (mark - entry) * qty * side : null;
  const rawMargin = position?.margin ?? position?.initialMargin ?? position?.positionMargin;
  const margin = Number.isFinite(Number(rawMargin)) && Number(rawMargin) > 0
    ? Number(rawMargin)
    : finitePositive(entry) && qty > 0 && side ? Math.abs(entry * qty) / leverage : null;
  return { pnl, margin };
}

export function accountPnlSummary(positions, defaultLeverage = 1) {
  let totalPnl = 0;
  let totalMargin = 0;
  let counted = 0;
  for (const position of Array.isArray(positions) ? positions : []) {
    const { pnl, margin } = positionPnlAndMargin(position, defaultLeverage);
    if (Number.isFinite(pnl)) {
      totalPnl += pnl;
      counted += 1;
    }
    if (Number.isFinite(margin) && margin > 0) totalMargin += margin;
  }
  // ROI on committed margin, which is the scale account_tp_roi_pct /
  // account_sl_roi_pct are quoted on.
  const roi = totalMargin > 0 ? (totalPnl / totalMargin) * 100 : 0;
  return { totalPnl, totalMargin, roi, positions: counted };
}

// Method 3 (trailing). Article example: long 50000, activation 55000, callback
// 10%; price runs to 70000 and drops to 63000 -> the position closes. Shorts
// mirror it: decline, then a rebound of the callback rate.
export function evaluateTrailingCallback({ side, mark, favorableRoi, triggerRoiPct, callbackPct, previous = null }) {
  if (side !== 'BUY' && side !== 'SELL') throw new Error('trailing callback requires a side of BUY or SELL');
  if (!finitePositive(mark)) throw new Error('trailing callback requires a positive mark price');
  const callback = Number(callbackPct);
  if (!Number.isFinite(callback) || callback <= 0) return { skipped: 'trailing callback disabled' };
  const isLong = side === 'BUY';
  const state = { peak: Number(mark), armed: false, activatedAt: 0 };
  if (previous && finitePositive(previous.peak)) {
    state.peak = Number(previous.peak);
    state.armed = Boolean(previous.armed);
    state.activatedAt = Number(previous.activatedAt) || 0;
  }
  const trigger = Number(triggerRoiPct) || 0;
  if (!state.armed) {
    if (!(Number(favorableRoi) >= trigger)) return { ...state, skipped: 'activation not reached' };
    // Arming and peak tracking happen on the same tick, so fold the current mark
    // into the peak immediately. Returning first would leave the peak one
    // observation stale, and since the trigger is measured back from the peak a
    // stale peak fires the exit early and locks in less profit than configured.
    state.armed = true;
    state.peak = isLong ? Math.max(state.peak, Number(mark)) : Math.min(state.peak, Number(mark));
    return { ...state, armedNow: true };
  }
  state.peak = isLong ? Math.max(state.peak, Number(mark)) : Math.min(state.peak, Number(mark));
  const threshold = isLong ? state.peak * (1 - callback / 100) : state.peak * (1 + callback / 100);
  if (isLong ? Number(mark) <= threshold : Number(mark) >= threshold) {
    return { ...state, triggered: true, callbackPrice: threshold };
  }
  return { ...state, tracking: true };
}

// Human-readable reference for the four methods, mirroring describeUnits() in
// bitunix/order-units.js. Used by the agent tool and the /help surfaces so the
// four choices can be described without hard-coding the docs prose anywhere.
export function describeTpslMethods() {
  return [
    'Bitunix offers four take-profit / stop-loss methods for a futures position:',
    '  position - fixed TP and SL on one position; the target closes the WHOLE position at once.',
    '  partial  - close the position in stages: partial_tp_fractions[i] is closed at',
    '             partial_tp_roi_steps[i] x the base ATR take-profit distance. The rest keeps riding the stop.',
    '  trailing - arms once trailing_trigger_roi_pct of favourable ROI is reached, tracks the peak',
    '             (trough on a short) and exits when price retraces trailing_callback_pct from it.',
    '  account  - closes ALL positions once total account PnL crosses account_tp_roi_pct',
    '             or account_sl_roi_pct (0 disables that side).',
    'Set tpsl_method to choose one. See https://www.bitunix.com/hub/helpcenter/article/bitunix-futures-position-a-guide-to-four-take-profit-and-stop-loss-methods-web?id=290',
  ].join('\n');
}
