import { CONFIG } from '../config.js';

export const DEFAULTS = {
  symbol: 'BTCUSDT',
  leverage: 10,
  position_type: 'crossed',
  timeframes: ['1m', '3m', '5m', '15m', '1h'],
  margin_amount_pct: 2,
  margin_risk_pct: 2,
  min_confidence: 80,
  tf_min_confidence: 60,
  min_agreeing_strategies: 2,
  signal_confirm_scans: 1,
  cooldown_minutes: 5,
  max_positions: 3,
  position_mode: 'hedge',
  scan_interval_sec: 15,
  guard_interval_sec: 15,
  breakeven_threshold_pct: 20,
  trailing_trigger_roi_pct: 25,
  sl_liquidation_safety: 0.60,
  on_tpsl_failure: 'close',
  reversal_enabled: true,
  reversal_confidence: 85,
  report_interval_sec: 30,
  mid_manage_interval_sec: 15,
  order_unit: 'cost',
  position_sizing_margin_pct: 2,
  auto_trade: false,
};

export const ALIASES = {
  margin_mode: 'position_type',
  position_type: 'position_type',
  symbol: 'symbol',
  leverage: 'leverage',
};

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULTS));
const SETTING_KEY_SET = new Set(SETTING_KEYS);
const INTEGER_KEYS = new Set([
  'leverage',
  'min_agreeing_strategies',
  'signal_confirm_scans',
  'cooldown_minutes',
  'max_positions',
]);
const NUMBER_KEYS = new Set([
  'margin_amount_pct',
  'margin_risk_pct',
  'min_confidence',
  'tf_min_confidence',
  'scan_interval_sec',
  'guard_interval_sec',
  'breakeven_threshold_pct',
  'trailing_trigger_roi_pct',
  'sl_liquidation_safety',
  'reversal_confidence',
  'report_interval_sec',
  'mid_manage_interval_sec',
  'position_sizing_margin_pct',
]);
const BOOLEAN_KEYS = new Set(['auto_trade', 'reversal_enabled']);
const ENUMS = {
  position_type: ['crossed', 'isolated'],
  position_mode: ['hedge', 'one-way'],
  order_unit: ['cost', 'qty'],
  on_tpsl_failure: ['cancel', 'close', 'alert'],
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeValue(key, value) {
  if (key === 'symbol') return String(value).trim().toUpperCase();
  if (key === 'timeframes') {
    const values = Array.isArray(value) ? value : String(value).split(',');
    return [...new Set(values.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  }
  if (key === 'position_type' || key === 'position_mode') return String(value).trim().toLowerCase();
  if (key === 'order_unit' || key === 'on_tpsl_failure') return String(value).trim().toLowerCase();
  return value;
}

function normalizePatch(input) {
  if (!isPlainObject(input)) throw new Error('settings must be an object');
  const out = {};
  for (const [inputKey, value] of Object.entries(input)) {
    const key = ALIASES[inputKey] || inputKey;
    if (!SETTING_KEY_SET.has(key)) throw new Error(`unknown setting: ${inputKey}`);
    if (Object.hasOwn(out, key)) throw new Error(`duplicate setting: ${key}`);
    out[key] = normalizeValue(key, value);
  }
  return out;
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function addRangeError(errors, key, value, min, max, integer = false) {
  if (!validNumber(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    errors.push(`${key} must be ${integer ? 'an integer ' : ''}${min}-${max}`);
  }
}

export function normalizeSettings(s = {}) {
  const patch = normalizePatch(s);
  return {
    ...DEFAULTS,
    ...patch,
    timeframes: [...(patch.timeframes ?? DEFAULTS.timeframes)],
  };
}

export function validateSettings(s) {
  if (!isPlainObject(s)) return ['settings must be an object'];
  const errors = [];
  const unknown = Object.keys(s).filter(key => !SETTING_KEY_SET.has(key));
  if (unknown.length) errors.push(`unknown settings: ${unknown.join(', ')}`);

  if (typeof s.symbol !== 'string' || !/^[A-Z0-9]{5,32}$/.test(s.symbol)) {
    errors.push('symbol must be 5-32 uppercase letters or digits');
  }

  addRangeError(errors, 'leverage', s.leverage, 1, 125, true);
  addRangeError(errors, 'margin_amount_pct', s.margin_amount_pct, 0.01, 100);
  addRangeError(errors, 'margin_risk_pct', s.margin_risk_pct, 0.01, 100);
  addRangeError(errors, 'min_confidence', s.min_confidence, 0, 100);
  addRangeError(errors, 'tf_min_confidence', s.tf_min_confidence, 0, 100);
  addRangeError(errors, 'min_agreeing_strategies', s.min_agreeing_strategies, 1, 100, true);
  addRangeError(errors, 'signal_confirm_scans', s.signal_confirm_scans, 1, 100, true);
  addRangeError(errors, 'cooldown_minutes', s.cooldown_minutes, 0, 1440, true);
  addRangeError(errors, 'max_positions', s.max_positions, 1, 100, true);
  addRangeError(errors, 'scan_interval_sec', s.scan_interval_sec, 5, 86400, true);
  addRangeError(errors, 'guard_interval_sec', s.guard_interval_sec, 5, 86400, true);
  addRangeError(errors, 'breakeven_threshold_pct', s.breakeven_threshold_pct, 0, 1000);
  addRangeError(errors, 'trailing_trigger_roi_pct', s.trailing_trigger_roi_pct, 0, 10000);
  addRangeError(errors, 'sl_liquidation_safety', s.sl_liquidation_safety, 0.01, 1);
  addRangeError(errors, 'reversal_confidence', s.reversal_confidence, 0, 100);
  addRangeError(errors, 'report_interval_sec', s.report_interval_sec, 5, 86400, true);
  addRangeError(errors, 'mid_manage_interval_sec', s.mid_manage_interval_sec, 5, 86400, true);
  addRangeError(errors, 'position_sizing_margin_pct', s.position_sizing_margin_pct, 0.01, 100);

  for (const [key, values] of Object.entries(ENUMS)) {
    if (typeof s[key] !== 'string' || !values.includes(s[key])) {
      errors.push(`${key} must be ${values.join('/')}`);
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof s[key] !== 'boolean') errors.push(`${key} must be boolean`);
  }

  if (Array.isArray(s.timeframes) && s.timeframes.length === 0) {
    errors.push('timeframes must be a non-empty array');
  } else if (Array.isArray(s.timeframes)) {
    if (s.timeframes.some(tf => typeof tf !== 'string' || !/^\d+[mhdw]$/.test(tf))) {
      errors.push('timeframes must contain values like 1m, 5m, 15m, 1h, or 1d');
    }
    if (new Set(s.timeframes).size !== s.timeframes.length) errors.push('timeframes must be unique');
    // min_agreeing_strategies counts strategies, not timeframes. Ten strategies are implemented.
    if (validNumber(s.min_agreeing_strategies) && s.min_agreeing_strategies > 10) {
      errors.push('min_agreeing_strategies cannot exceed 10');
    }
  } else {
    errors.push('timeframes must be a non-empty array');
  }

  return errors;
}

export function getTraderSettings(source = CONFIG) {
  return Object.fromEntries(SETTING_KEYS.map(key => [key, Array.isArray(source[key]) ? [...source[key]] : source[key]]));
}

export function getPersistentSettings(source = CONFIG) {
  const settings = getTraderSettings(source);
  delete settings.auto_trade; // never resume trading authority after a restart
  return settings;
}

export function applySettings(target, patch) {
  const normalized = normalizePatch(patch);
  const next = { ...getTraderSettings(target), ...normalized };
  const errors = validateSettings(next);
  if (errors.length) throw new Error(errors.join('; '));
  Object.assign(target, normalized);
  return getTraderSettings(target);
}

export function applyPersistedSettings(target, stored) {
  if (!isPlainObject(stored)) return getTraderSettings(target);
  const filtered = Object.create(null);
  for (const [key, value] of Object.entries(stored)) {
    const canonical = ALIASES[key] || key;
    if (SETTING_KEY_SET.has(canonical)) filtered[canonical] = value;
  }
  const normalized = normalizePatch(filtered);
  delete normalized.auto_trade;
  const next = { ...getTraderSettings(target), ...normalized };
  const errors = validateSettings(next);
  if (errors.length) throw new Error(`invalid persisted settings: ${errors.join('; ')}`);
  Object.assign(target, normalized);
  return getTraderSettings(target);
}

export function parseSettingValue(key, raw) {
  const canonical = ALIASES[key] || key;
  if (!SETTING_KEY_SET.has(canonical)) throw new Error(`unknown setting: ${key}`);
  if (BOOLEAN_KEYS.has(canonical)) {
    const normalized = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`${canonical} must be true/false or 1/0`);
  }
  if (NUMBER_KEYS.has(canonical) || INTEGER_KEYS.has(canonical)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${canonical} must be numeric`);
    return value;
  }
  return raw;
}
