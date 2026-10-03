import { CONFIG } from '../config.js';

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function computeQty({ available, price, leverage, marginPct = 2 }) {
  if (!positiveNumber(available) || !positiveNumber(price)) return 0;
  const selectedLeverage = Number.isInteger(leverage) ? leverage : CONFIG.leverage;
  // The ceiling is per symbol on /market/trading_pairs (minLeverage/maxLeverage;
  // the docs' BTCUSDT example is 125). This guard is a last-resort bound against
  // a nonsense value — the exchange is the real authority.
  if (!Number.isInteger(selectedLeverage) || selectedLeverage < 1 || selectedLeverage > 125) return 0;
  const selectedMarginPct = Number(marginPct);
  if (!Number.isFinite(selectedMarginPct) || selectedMarginPct <= 0 || selectedMarginPct > 100) return 0;
  const notional = Number(available) * selectedMarginPct / 100;
  const size = notional / Number(price) * selectedLeverage;
  return Number.isFinite(size) && size > 0 ? size : 0;
}

export function roundToPrecision(value, precision, mode = 'down') {
  const number = Number(value);
  const digits = Number(precision);
  if (!Number.isFinite(number) || !Number.isInteger(digits) || digits < 0 || digits > 20) return null;
  const factor = 10 ** digits;
  const rounded = mode === 'nearest' ? Math.round(number * factor) / factor : Math.floor(number * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function liqDistanceOk({ markPrice, liqPrice }) {
  if (!positiveNumber(markPrice)) return false;
  if (liqPrice === undefined || liqPrice === null || liqPrice === '') return false;
  const liquidation = Number(liqPrice);
  if (!Number.isFinite(liquidation) || liquidation <= 0) return true;
  const distance = Math.abs(Number(markPrice) - liquidation) / Number(markPrice);
  const minimum = Number(CONFIG.sl_liquidation_safety) / 100;
  return Number.isFinite(distance) && Number.isFinite(minimum) && distance >= minimum;
}

export function positionAllowed({ openCount }) {
  const count = Number(openCount);
  const maximum = Number(CONFIG.max_positions);
  return Number.isInteger(count) && count >= 0 && Number.isInteger(maximum) && maximum > 0 && count < maximum;
}

export function marginOk({ available, requiredMargin }) {
  const availableValue = Number(available);
  const requiredValue = Number(requiredMargin);
  return Number.isFinite(availableValue) && Number.isFinite(requiredValue) && requiredValue >= 0 && availableValue >= requiredValue;
}
