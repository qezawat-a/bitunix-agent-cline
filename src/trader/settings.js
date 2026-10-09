import { CONFIG } from '../config.js';

export const DEFAULTS = {
  symbol: 'BTCUSDT',
  leverage: 10,
  position_type: 'crossed',
  timeframes: ['1m', '3m', '5m', '15m', '1h'],
  min_confidence: 80,
  tf_min_confidence: 60,
  min_agreeing_strategies: 2,
  min_eligible_timeframes: 2,
  // Regime gates. Every other gate measures how many strategies agreed; these
  // ask whether there is a trend to ride and whether the vote was decisive
  // enough to act on. 0 disables any of them.
  //
  // min_efficiency is the gate that actually discriminates. ADX alone does not:
  // it scores directional MOVEMENT, so a slow bounded oscillation reads as a
  // strong trend (measured: ranges up to ADX 70.8, real trends as low as 52.1).
  // Efficiency — net progress over path travelled — separated the same set with
  // ranges maxing at 16.1% and real trends bottoming out at 38.9%.
  min_efficiency: 20,
  min_adx: 25,
  min_score_margin: 12,
  signal_confirm_scans: 1,
  cooldown_minutes: 5,
  max_positions: 3,
  position_mode: 'hedge',
  scan_interval_sec: 15,
  guard_interval_sec: 15,
  breakeven_threshold_pct: 20,
  trailing_trigger_roi_pct: 25,
  trailing_atr_multiple: 1.25,
  trailing_atr_strength_reduction: 0.25,
  sl_liquidation_safety: 0.60,
  on_tpsl_failure: 'close',
  reversal_enabled: true,
  reversal_confidence: 85,
  report_interval_sec: 30,
  mid_manage_interval_sec: 15,
  order_unit: 'cost',
  // Which of Bitunix's four take-profit / stop-loss methods protects a position:
  // position (all-in/all-out), partial (laddered closes), trailing (peak + callback),
  // or account (aggregate PnL across every open position).
  tpsl_method: 'position',
  // Partial TP/SL ladder. fractions are shares of the position closed at each
  // step; the remainder (1 - sum) keeps riding with the breakeven/trailing stop.
  partial_tp_fractions: [0.3, 0.4, 0.3],
  // Each step triggers at roiSteps[i] x the base ATR take-profit distance.
  partial_tp_roi_steps: [1, 2, 3],
  trailing_callback_pct: 5,
  // Account-level TP/SL. 0 disables that side; values are ROI percent on the
  // sum of unrealised PnL across all open positions.
  account_tp_roi_pct: 0,
  account_sl_roi_pct: 0,
  position_sizing_margin_pct: 2,
  auto_trade: false,
  // Telegram notifications. The position lifecycle was silent: the bot only
  // reported signals, so an entry or an exit happened with no message at all.
  notify_open: true,
  notify_close: true,
  // Stop / take-profit moves (break-even, trailing) are chatty on a fast
  // market, so they are off unless asked for.
  notify_tpsl: false,
};

// Bitunix exposes three order units (help centre "Explanation of the Order Units
// in Futures Trading"): nominal (contract size in USDT), cost (margin actually
// paid) and qty (base-asset quantity).
const ORDER_UNITS = ['nominal', 'cost', 'qty'];
// The four take-profit / stop-loss methods Bitunix offers for futures positions.
const TPSL_METHODS = ['position', 'partial', 'trailing', 'account'];

export const ALIASES = {
  margin_mode: 'position_type',
  position_type: 'position_type',
  tpsl: 'tpsl_method',
  order_units: 'order_unit',
  symbol: 'symbol',
  leverage: 'leverage',
  tf: 'timeframes',
  timeframes: 'timeframes',
  tf_min: 'tf_min_confidence',
  // The two older margin names were accepted, validated and confirmed back to
  // the operator, but nothing ever read them: sizing only reads
  // position_sizing_margin_pct. Setting `margin_amount_pct 25` was a confirmed
  // no-op and every position still went in at the 2% default. Both names now
  // resolve to the key the sizing code actually uses.
  margin_amount_pct: 'position_sizing_margin_pct',
  margin_risk_pct: 'position_sizing_margin_pct',
  margin_pct: 'position_sizing_margin_pct',
};

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULTS));
const SETTING_KEY_SET = new Set(SETTING_KEYS);
const INTEGER_KEYS = new Set([
  'leverage',
  'min_agreeing_strategies',
  'min_eligible_timeframes',
  'signal_confirm_scans',
  'min_efficiency',
  'min_adx',
  'min_score_margin',
  'cooldown_minutes',
  'max_positions',
]);
const NUMBER_KEYS = new Set([
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
  'trailing_callback_pct',
  'account_tp_roi_pct',
  'account_sl_roi_pct',
]);
// Arrays that must hold finite numbers. Declared separately from timeframes,
// which are validated as a set of unique interval strings.
const NUMERIC_ARRAY_KEYS = new Set(['partial_tp_fractions', 'partial_tp_roi_steps']);
const BOOLEAN_KEYS = new Set(['auto_trade', 'reversal_enabled', 'notify_open', 'notify_close', 'notify_tpsl']);
const ENUMS = {
  position_type: ['crossed', 'isolated'],
  position_mode: ['hedge', 'one-way'],
  order_unit: ORDER_UNITS,
  tpsl_method: TPSL_METHODS,
  on_tpsl_failure: ['cancel', 'close', 'alert'],
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNumberArray(value, key) {
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = list.map(item => {
    const n = Number(String(item).trim());
    if (!Number.isFinite(n)) throw new Error(`${key} must contain only numbers`);
    return n;
  }).filter(item => String(item).trim() !== '');
  if (!out.length) throw new Error(`${key} must not be empty`);
  return out;
}

function normalizeValue(key, value) {
  if (key === 'symbol') return String(value).trim().toUpperCase();
  if (NUMERIC_ARRAY_KEYS.has(key)) return toNumberArray(value, key);
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

// The single source of truth for every numeric setting boundary. validateSettings()
// enforces exactly this table and describeSettingBounds() renders the same table into
// the agent's system prompt, so the agent can never be told a different limit than the
// code enforces. The optional third tuple element means "whole number".
export const SETTING_RANGES = Object.freeze({
  min_confidence: [0, 100],
  tf_min_confidence: [0, 100],
  min_agreeing_strategies: [1, 100, true],
  min_eligible_timeframes: [1, 20, true],
  // 0 disables the gate, so the lower bound is 0 rather than >0. The score margin is a
  // mean per qualifying timeframe, so its ceiling is one timeframe's whole book weight
  // — see the note on netScore in scanner.js.
  min_efficiency: [0, 100],
  min_adx: [0, 100],
  min_score_margin: [0, 146],
  signal_confirm_scans: [1, 100, true],
  cooldown_minutes: [0, 1440, true],
  max_positions: [1, 100, true],
  scan_interval_sec: [5, 86400, true],
  guard_interval_sec: [5, 86400, true],
  breakeven_threshold_pct: [0, 1000],
  trailing_trigger_roi_pct: [0, 10000],
  trailing_atr_multiple: [0.01, 100],
  trailing_atr_strength_reduction: [0, 1],
  sl_liquidation_safety: [0.01, 1],
  reversal_confidence: [0, 100],
  report_interval_sec: [5, 86400, true],
  mid_manage_interval_sec: [5, 86400, true],
  // There is no allocation ceiling. This is the entire bound. A stricter prose limit
  // once lived in soul/SOUL.md ("25% of account capital"), which made the agent refuse
  // values this validator accepts — so the prompt renders this table and nothing else.
  position_sizing_margin_pct: [0.01, 100],
  trailing_callback_pct: [0.1, 90],
  // 0 disables the account-level side, so the lower bound is 0 rather than >0.
  account_tp_roi_pct: [0, 10000],
  account_sl_roi_pct: [0, 10000],
});

// describeSettingBounds() -> the authoritative table, rendered for the agent prompt.
// State what is enforced, never what you think should be enforced.
export function describeSettingBounds() {
  const lines = Object.entries(SETTING_RANGES).map(([key, [min, max, integer]]) =>
    `- ${key}: ${min} to ${max}${integer ? ' (whole number)' : ''}`);
  lines.push('- leverage: any positive integer. The accepted band is published per symbol by the exchange and enforced by the venue, not by a limit in this table.');
  for (const [key, values] of Object.entries(ENUMS)) lines.push(`- ${key}: ${values.join(' | ')}`);
  lines.push('- symbol: 5-32 uppercase letters or digits');
  lines.push('- timeframes: interval strings such as 1m, 5m, 15m, 1h, 1d — non-empty and unique');
  lines.push(`- boolean settings: ${[...BOOLEAN_KEYS].join(', ')}`);
  lines.push('- partial_tp_fractions: 1-10 numbers, each greater than 0 and at most 1, totalling at most 1');
  lines.push('- partial_tp_roi_steps: 1-10 positive numbers, strictly increasing, same length as partial_tp_fractions');
  return lines.join('\n');
}

export function validateSettings(s) {
  if (!isPlainObject(s)) return ['settings must be an object'];
  const errors = [];
  const unknown = Object.keys(s).filter(key => !SETTING_KEY_SET.has(key));
  if (unknown.length) errors.push(`unknown settings: ${unknown.join(', ')}`);

  if (typeof s.symbol !== 'string' || !/^[A-Z0-9]{5,32}$/.test(s.symbol)) {
    errors.push('symbol must be 5-32 uppercase letters or digits');
  }

  // Deliberately NO upper bound here. The accepted band is per symbol
  // (trading_pairs minLeverage/maxLeverage) and differs between symbols, so a
  // literal ceiling in the settings form either blocks a leverage this symbol
  // accepts or admits one it refuses. This only rejects a value that is not a
  // positive integer; the exchange is the authority on the real band, enforced
  // by changeLeverage and re-checked in Trader.computePositionSize against the
  // pair metadata it fetches.
  if (!validNumber(s.leverage) || s.leverage < 1 || !Number.isInteger(s.leverage)) {
    errors.push('leverage must be a positive integer');
  }
  // Enforced from SETTING_RANGES so the prompt and the validator can never disagree.
  for (const [key, [min, max, integer]] of Object.entries(SETTING_RANGES)) {
    addRangeError(errors, key, s[key], min, max, integer);
  }

  // Partial TP/SL ladder: the two arrays must line up, every step must be
  // positive, ROI steps must strictly increase, and the fractions must not
  // attempt to close more than the whole position.
  const fractions = s.partial_tp_fractions;
  const steps = s.partial_tp_roi_steps;
  const fractionsOk = Array.isArray(fractions) && fractions.length > 0 && fractions.length <= 10
    && fractions.every(n => validNumber(n) && n > 0 && n <= 1);
  const stepsOk = Array.isArray(steps) && steps.length > 0 && steps.length <= 10
    && steps.every(n => validNumber(n) && n > 0);
  if (!fractionsOk) errors.push('partial_tp_fractions must be 1-10 numbers, each greater than 0 and at most 1');
  if (!stepsOk) errors.push('partial_tp_roi_steps must be 1-10 positive numbers');
  if (fractionsOk && stepsOk) {
    if (fractions.length !== steps.length) {
      errors.push('partial_tp_fractions and partial_tp_roi_steps must have the same length');
    } else {
      const total = fractions.reduce((sum, n) => sum + n, 0);
      if (total > 1 + 1e-9) errors.push('partial_tp_fractions must not total more than 1 (100% of the position)');
      for (let i = 1; i < steps.length; i += 1) {
        if (steps[i] <= steps[i - 1]) errors.push('partial_tp_roi_steps must be strictly increasing');
      }
    }
  }

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
    // Asking for more qualifying timeframes than are configured can never be
    // satisfied, which looks exactly like "the scanner stopped working".
    if (Number.isInteger(s.min_eligible_timeframes) && s.min_eligible_timeframes > s.timeframes.length) {
      errors.push(`min_eligible_timeframes (${s.min_eligible_timeframes}) cannot exceed the number of timeframes (${s.timeframes.length})`);
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
  // auto_trade is trading authority: by default it is never written, so a
  // restart can never silently resume live trading. AUTO_TRADE_PERSIST=1 is the
  // explicit opt-in for operators who want /autotrade on to survive a deploy.
  if (!source.AUTO_TRADE_PERSIST) delete settings.auto_trade;
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
  // Mirrors getPersistentSettings: only restore auto_trade when the operator has
  // explicitly opted in via AUTO_TRADE_PERSIST=1.
  if (!target.AUTO_TRADE_PERSIST) delete normalized.auto_trade;
  const next = { ...getTraderSettings(target), ...normalized };
  const errors = validateSettings(next);
  if (errors.length) throw new Error(`invalid persisted settings: ${errors.join('; ')}`);
  Object.assign(target, normalized);
  return getTraderSettings(target);
}

// resolveSettingKey(key) — map an alias to its canonical setting name.
// Returns the input unchanged when it is already a valid key.
export function resolveSettingKey(key) {
  const wanted = String(key || '').trim();
  return ALIASES[wanted] || wanted;
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
  if (NUMERIC_ARRAY_KEYS.has(canonical)) return toNumberArray(raw, canonical);
  if (NUMBER_KEYS.has(canonical) || INTEGER_KEYS.has(canonical)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${canonical} must be numeric`);
    return value;
  }
  return raw;
}

// --- Natural-language settings routing --------------------------------------------------
// "set the margin risk to 30" arrived as chat text, went to the model, and was refused
// with an invented ceiling — while the alias table already held the words the owner used
// (margin_risk_pct). Nothing routed a sentence to it. parseNaturalSetting() matches a
// plain sentence to an alias so it takes the identical validated path as /set.
const NL_PHRASES = {
  'margin risk pct': 'margin_risk_pct',
  'margin risk percentage': 'margin_risk_pct',
  'margin risk': 'margin_risk_pct',
  'margin percentage': 'margin_risk_pct',
  'margin amount': 'margin_risk_pct',
  'risk per trade': 'position_sizing_margin_pct',
  'position sizing': 'position_sizing_margin_pct',
  'position size': 'position_sizing_margin_pct',
  'position margin': 'position_sizing_margin_pct',
  'min confidence': 'min_confidence',
  'confidence': 'min_confidence',
  'efficiency': 'min_efficiency',
  'adx': 'min_adx',
  'score margin': 'min_score_margin',
  'cooldown': 'cooldown_minutes',
  'max positions': 'max_positions',
};

// parseNaturalSetting(text) -> { key, value } | null
// Only an explicit imperative counts; anything else stays a question for the agent.
export function parseNaturalSetting(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('/')) return null;
  if (!/^(please\s+)?(set|change|update|adjust|make|put|raise|increase|lower|reduce|switch|use|set\s+the)\b/i.test(raw)) return null;

  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Longest phrase wins, so "position sizing" beats a bare "sizing".
  const phrase = Object.keys(NL_PHRASES)
    .filter(p => normalized.includes(p))
    .sort((a, b) => b.length - a.length)[0];
  if (!phrase) return null;

  // Prefer a number after the value preposition ("to", "at", "="), else the last one.
  const tail = normalized.split(/\b(?:to|at|=|as)\b/).pop() || '';
  const found = tail.match(/\d+(?:\.\d+)?/g) || normalized.match(/\d+(?:\.\d+)?/g);
  if (!found || !found.length) return null;

  const canonical = resolveSettingKey(NL_PHRASES[phrase]);
  return { key: canonical, value: parseSettingValue(canonical, found[found.length - 1]) };
}
