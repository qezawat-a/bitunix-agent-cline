import { roundToPrecision } from './risk.js';

// Bitunix offers three order units for USDT-M perpetuals (help centre
// "Explanation of the Order Units in Futures Trading", id=170). They are three
// views of the very same position, so every conversion lives here to stop the
// trader/risk code from quietly disagreeing about which unit a number means:
//   nominal = qty * price            USDT market value of the contract
//   cost    = nominal / leverage     USDT actually paid to open (initial margin)
//   qty     = nominal / price        base-coin amount, e.g. BTC

export const ORDER_UNITS = ['nominal', 'cost', 'qty'];

// config keys are snake_case, CLI flags camelCase, the docs say "quantity" and
// users say "margin" — accept every spelling we have ever printed or accepted.
const UNIT_ALIASES = {
  nominal: 'nominal',
  nominalvalue: 'nominal',
  notional: 'nominal',
  notionalvalue: 'nominal',
  amount: 'nominal',
  contracts: 'nominal',
  contract: 'nominal',
  value: 'nominal',
  cost: 'cost',
  costvalue: 'cost',
  margin: 'cost',
  initialmargin: 'cost',
  qty: 'qty',
  quantity: 'qty',
  quantityunit: 'qty',
  size: 'qty',
  coins: 'qty',
  coin: 'qty',
  base: 'qty',
  basequantity: 'qty',
};

// 12 dp on a size and 8 dp on a money amount are far below anything Bitunix
// trades, but they strip binary-float noise (0.1 * 3 === 0.30000000000000004).
const QTY_DECIMALS = 12;
const MONEY_DECIMALS = 8;

// Booleans and objects coerce to 1/0 through Number(), which would silently
// pass validation, so only accept what could plausibly be a real measurement.
function numeric(value) {
  if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string')) return NaN;
  return Number(value);
}

function positive(value, label) {
  const number = numeric(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a finite positive number (got ${JSON.stringify(value)})`);
  return number;
}

// The accepted leverage band is published per symbol on /market/trading_pairs
// (minLeverage/maxLeverage) and differs between contracts, so it is read from
// the pair metadata rather than assumed. This fallback applies only when the
// pair carries no band; it is the docs' BTCUSDT example, not a venue-wide cap.
export const MAX_LEVERAGE = 125;

// Resolve the band for `pair`, falling back to the documented example range
// when the metadata does not advertise one.
function leverageBand(pair) {
  const max = numeric(pair?.maxLeverage);
  const min = numeric(pair?.minLeverage);
  return {
    min: min !== null && min >= 1 ? Math.trunc(min) : 1,
    max: max !== null && max >= 1 ? Math.trunc(max) : MAX_LEVERAGE,
  };
}

function leverageOf(value, pair) {
  const number = numeric(value);
  const { min, max } = leverageBand(pair);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`leverage must be an integer ${min}-${max} (got ${JSON.stringify(value)})`);
  }
  return number;
}

function tidy(value, decimals) {
  const rounded = roundToPrecision(value, decimals, 'nearest');
  if (rounded === null || !Number.isFinite(rounded) || rounded <= 0) {
    throw new Error(`order unit conversion produced an unusable value (${value})`);
  }
  return rounded;
}

export function normalizeUnit(unit) {
  const key = String(unit ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  const canonical = UNIT_ALIASES[key];
  if (!canonical) throw new Error(`unknown order unit ${JSON.stringify(unit)}; expected one of ${ORDER_UNITS.join(', ')}`);
  return canonical;
}

// Convert a number between any two of the three units, using the exact formulas
// from the help-centre article. from === to is an identity pass-through so that
// callers can hand a user-supplied unit straight through.
export function convert({ value, from, to, price, leverage, pair }) {
  const source = normalizeUnit(from);
  const target = normalizeUnit(to);
  const amount = positive(value, 'value');
  const mark = positive(price, 'price');
  const lev = leverageOf(leverage, pair);
  const decimals = target === 'qty' ? QTY_DECIMALS : MONEY_DECIMALS;
  if (source === target) return tidy(amount, decimals);
  let result;
  if (source === 'nominal') {
    result = target === 'cost' ? amount / lev : amount / mark;
  } else if (source === 'cost') {
    result = target === 'nominal' ? amount * lev : amount * lev / mark;
  } else {
    result = target === 'nominal' ? amount * mark : amount * mark / lev;
  }
  return tidy(result, decimals);
}

// trading_pairs metadata: basePrecision is the decimal count for the base-asset
// qty, quotePrecision the decimal count for the USDT price. A missing field
// falls back (8 matches the long-standing default); a present-but-junk value is
// a hard error, because guessing a size precision could overspend the balance.
function precisionOf(pair, field, fallback) {
  if (pair === undefined || pair === null) return fallback;
  if (typeof pair !== 'object' || Array.isArray(pair)) throw new Error(`trading pair metadata must be an object (got ${JSON.stringify(pair)})`);
  const raw = pair[field];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const digits = Number(raw);
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) throw new Error(`trading pair ${field} must be an integer 0-20 (got ${JSON.stringify(raw)})`);
  return digits;
}

export function roundQty(value, pair) {
  const digits = precisionOf(pair, 'basePrecision', 8);
  // Floor, never round up: an upsized qty would commit more margin than the balance allows.
  const rounded = roundToPrecision(value, digits, 'down');
  if (rounded === null || !Number.isFinite(rounded) || rounded <= 0) return 0;
  return rounded;
}

export function roundPrice(value, pair) {
  const digits = precisionOf(pair, 'quotePrecision', 8);
  // Prices may round to nearest — being a few ticks off still fills, unlike an oversized size.
  const rounded = roundToPrecision(value, digits, 'nearest');
  if (rounded === null || !Number.isFinite(rounded) || rounded <= 0) return 0;
  return rounded;
}

export function describeUnits() {
  return [
    'Bitunix order units (USDT-M perpetual):',
    '  nominal - nominal value / notional: market value of the contract in USDT. nominal = qty * price',
    '  cost    - cost value / margin:      USDT actually paid to open.        cost = nominal / leverage',
    '  qty     - quantity unit / size:     base-coin amount (e.g. BTC).      qty = nominal / price',
    '  so: nominal = cost * leverage, qty = cost * leverage / price, cost = qty * price / leverage',
  ].join('\n');
}

// Production sizing entry point: turn a free USDT balance plus a margin budget
// into an exchange-legal base-coin quantity. A legal-but-untradeable size is
// reported as ok:false with a reason the caller can log, not thrown.
export function positionSizeFromUnit({ available, unit, price, leverage, marginPct, pair, orderType = 'MARKET' }) {
  const balance = positive(available, 'available USDT balance');
  const selected = normalizeUnit(unit);
  const mark = positive(price, 'price');
  const lev = leverageOf(leverage, pair);
  const pct = numeric(marginPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error(`marginPct must be a number in (0,100] (got ${JSON.stringify(marginPct)})`);
  const type = String(orderType ?? 'MARKET').trim().toUpperCase();
  if (!['LIMIT', 'MARKET'].includes(type)) throw new Error(`orderType must be LIMIT or MARKET (got ${JSON.stringify(orderType)})`);

  // All three units are anchored on the same margin budget (at most 100% of the
  // balance), so the branches collapse to one line: the unit changes how the
  // caller reads the number, not the size that ends up on the wire.
  const budget = balance * pct / 100;  // USDT committed as initial margin
  const rawQty = budget * lev / mark;   // nominal = cost * leverage; qty = nominal / price
  const roundedTo = precisionOf(pair, 'basePrecision', 8);
  const qty = roundQty(rawQty, pair);
  const warnings = [];
  if (qty !== rawQty) warnings.push(`qty floored from ${rawQty} to ${qty} at basePrecision ${roundedTo}`);

  // Cost/nominal are reported for the size we would actually trade, so a log
  // line never shows a bigger position than the exchange will accept.
  const result = {
    ok: false,
    unit: selected,
    qty,
    marginCost: qty > 0 ? tidy(qty * mark / lev, MONEY_DECIMALS) : 0,
    nominalValue: qty > 0 ? tidy(qty * mark, MONEY_DECIMALS) : 0,
    price: mark,
    leverage: lev,
    roundedTo,
    warnings,
  };

  if (qty <= 0) return { ...result, reason: 'qty_rounded_to_zero' };

  const minVolume = numeric(pair?.minTradeVolume);
  if (Number.isFinite(minVolume) && minVolume > 0 && qty < minVolume) {
    warnings.push(`qty ${qty} is below the Bitunix minimum ${minVolume}`);
    return { ...result, reason: 'below_min_trade_volume' };
  }

  const maxField = type === 'LIMIT' ? 'maxLimitOrderVolume' : 'maxMarketOrderVolume';
  const maxVolume = numeric(pair?.[maxField]);
  if (Number.isFinite(maxVolume) && maxVolume > 0 && qty > maxVolume) {
    warnings.push(`qty ${qty} exceeds the Bitunix ${type.toLowerCase()} maximum ${maxVolume}`);
    return { ...result, reason: 'above_max_order_volume' };
  }

  return { ...result, ok: true };
}
