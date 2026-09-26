import 'dotenv/config';
import fs from 'fs/promises';

const S = (v, fallback) => process.env[v] ?? fallback;
const E = (fallback, ...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return fallback;
};

export function parseBoolean(value, fallback, name = 'value') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function B(v, fallback, name) {
  return parseBoolean(v, fallback, name);
}

export const CONFIG = {
  // LLM — both the original names and the aliases requested for providers are accepted.
  AI_PROVIDER: E('auto', 'AI_PROVIDER', 'MODEL_PROVIDER'),
  AI_BASE_URL: E('', 'AI_BASE_URL', 'OPENAI_COMPATIBLE_URL', 'OPENAI_BASE_URL', 'BASE_URL'),
  AI_API_KEY: E('', 'AI_API_KEY', 'OPENAI_COMPATIBLE_KEY', 'OPENAI_API_KEY'),
  AI_MODEL: E('AUTO', 'AI_MODEL', 'OPENAI_COMPATIBLE_MODEL', 'OPENAI_MODEL', 'MODEL_AUTO_SET_BY_KEY'),
  ANTHROPIC_API_KEY: S('ANTHROPIC_API_KEY', ''),
  ANTHROPIC_BASE_URL: E('', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_URL'),
  ANTHROPIC_MODEL: E('AUTO', 'ANTHROPIC_MODEL', 'MODEL_AUTO_SET_BY_KEY'),
  GEMINI_API_KEY: E('', 'GEMINI_API_KEY', 'GEMINI_GOOGLE_KEY'),
  GEMINI_BASE_URL: E('', 'GEMINI_BASE_URL', 'GEMINI_GOOGLE_URL'),
  GEMINI_MODEL: E('AUTO', 'GEMINI_MODEL', 'MODEL_AUTO_SET_BY_KEY'),
  AI_AUTO_REFRESH: B(S('AI_AUTO_REFRESH', '1'), true, 'AI_AUTO_REFRESH'),
  AI_MODEL_TTL: Number(S('AI_MODEL_TTL', 600000)),
  AGENT_AUTO_COMPACT: B(S('AGENT_AUTO_COMPACT', '1'), true, 'AGENT_AUTO_COMPACT'),
  // Empty means "pick per model": reasoning/thinking endpoints reject a non-default
  // temperature outright, so it is only sent when explicitly asked for.
  AI_TEMPERATURE: S('AI_TEMPERATURE', ''),
  // Dump the exact outbound request body + provider response to stderr.
  AI_DEBUG_LOG: B(S('AI_DEBUG_LOG', '0'), false, 'AI_DEBUG_LOG'),


  // Bitunix
  BITUNIX_API_KEY: S('BITUNIX_API_KEY', ''),
  BITUNIX_API_SECRET: S('BITUNIX_API_SECRET', ''),
  BITUNIX_BASE_URL: S('BITUNIX_BASE_URL', 'https://fapi.bitunix.com'),
  BITUNIX_WS_PUBLIC: S('BITUNIX_WS_PUBLIC', 'wss://fapi.bitunix.com/public/'),
  BITUNIX_WS_PRIVATE: S('BITUNIX_WS_PRIVATE', 'wss://fapi.bitunix.com/private/'),

  // Database
  DATABASE_URL: S('DATABASE_URL', ''),

  // Telegram
  TELEGRAM_BOT_TOKEN: S('TELEGRAM_BOT_TOKEN', ''),
  ALLOWED_USER_ID: S('ALLOWED_USER_ID', ''),

  // Agent
  AGENT_NAME: S('AGENT_NAME', 'J-ROCK'),
  AGENT_AUTONOMOUS: B(S('AGENT_AUTONOMOUS', '0'), false, 'AGENT_AUTONOMOUS'),
  AGENT_MAX_STEP: Number(S('AGENT_MAX_STEP', 8)),
  AGENT_THINKING_ENABLED: B(S('AGENT_THINKING_ENABLED', 'true'), true, 'AGENT_THINKING_ENABLED'),
  AGENT_THINKING_LEVEL: S('AGENT_THINKING_LEVEL', 'mid'),
  AGENT_THINKING_BUDGET: Number(S('AGENT_THINKING_BUDGET', 5000)),
  AGENT_AUTONOMOUS_INTERVAL_SEC: Number(S('AGENT_AUTONOMOUS_INTERVAL_SEC', 15)),

  // Trader — defaults (mirrors kcex-signal-scanner + your spec)
  symbol: S('symbol', 'BTCUSDT'),
  leverage: Number(S('leverage', 10)),
  position_type: S('position_type', 'crossed'),
  timeframes: (S('timeframes', '1m,3m,5m,15m,1h')).split(',').map(t => t.trim()),
  margin_amount_pct: Number(S('margin_amount_pct', 2)),
  margin_risk_pct: Number(S('margin_risk_pct', 2)),
  min_confidence: Number(S('min_confidence', 80)),
  tf_min_confidence: Number(S('tf_min_confidence', 60)),
  min_agreeing_strategies: Number(S('min_agreeing_strategies', 2)),
  signal_confirm_scans: Number(S('signal_confirm_scans', 1)),
  cooldown_minutes: Number(S('cooldown_minutes', 5)),
  max_positions: Number(S('max_positions', 3)),
  position_mode: S('position_mode', 'hedge'),
  scan_interval_sec: Number(S('scan_interval_sec', 15)),
  guard_interval_sec: Number(S('guard_interval_sec', 15)),
  breakeven_threshold_pct: Number(S('breakeven_threshold_pct', 20)),
  trailing_trigger_roi_pct: Number(S('trailing_trigger_roi_pct', 25)),
  sl_liquidation_safety: Number(S('sl_liquidation_safety', 0.60)),
  on_tpsl_failure: S('on_tpsl_failure', 'close'),
  reversal_enabled: B(S('reversal_enabled', 'true'), true, 'reversal_enabled'),
  reversal_confidence: Number(S('reversal_confidence', 85)),
  report_interval_sec: Number(S('report_interval_sec', 30)),
  mid_manage_interval_sec: Number(S('mid_manage_interval_sec', 15)),
  order_unit: S('order_unit', 'cost'),
  position_sizing_margin_pct: Number(S('position_sizing_margin_pct', 2)),
  auto_trade: B(S('AUTO_TRADE', '0'), false, 'AUTO_TRADE'),
  store_id: S('STORE_ID', 'j-rock-1'),
};

const FILE_TRADER_KEYS = new Set([
  'symbol', 'leverage', 'position_type', 'timeframes', 'margin_amount_pct', 'margin_risk_pct',
  'min_confidence', 'tf_min_confidence', 'min_agreeing_strategies', 'signal_confirm_scans',
  'cooldown_minutes', 'max_positions', 'position_mode', 'scan_interval_sec', 'guard_interval_sec',
  'breakeven_threshold_pct', 'trailing_trigger_roi_pct', 'sl_liquidation_safety', 'on_tpsl_failure', 'reversal_enabled', 'reversal_confidence',
  'report_interval_sec', 'mid_manage_interval_sec', 'order_unit', 'position_sizing_margin_pct',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readSettingsFile(filePath = 'settings.json') {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('settings.json must contain an object');
  return parsed;
}

export function applySettingsFile(target, source) {
  if (!isPlainObject(source)) return source;
  const trader = isPlainObject(source.trader) ? source.trader : {};
  for (const key of FILE_TRADER_KEYS) {
    if (Object.hasOwn(trader, key) && !Object.hasOwn(process.env, key)) {
      target[key] = Array.isArray(trader[key]) ? [...trader[key]] : trader[key];
    }
  }
  const agent = isPlainObject(source.agent) ? source.agent : {};
  if (Object.hasOwn(agent, 'name') && !Object.hasOwn(process.env, 'AGENT_NAME')) target.AGENT_NAME = String(agent.name);
  if (Object.hasOwn(agent, 'autonomous') && !Object.hasOwn(process.env, 'AGENT_AUTONOMOUS')) target.AGENT_AUTONOMOUS = Number(agent.autonomous);
  if (Object.hasOwn(agent, 'autonomousIntervalSec') && !Object.hasOwn(process.env, 'AGENT_AUTONOMOUS_INTERVAL_SEC')) target.AGENT_AUTONOMOUS_INTERVAL_SEC = Number(agent.autonomousIntervalSec);
  if (Object.hasOwn(agent, 'maxRounds') && !Object.hasOwn(process.env, 'AGENT_MAX_STEP')) target.AGENT_MAX_STEP = Number(agent.maxRounds);
  if (Object.hasOwn(agent, 'autoCompact') && !Object.hasOwn(process.env, 'AGENT_AUTO_COMPACT')) target.AGENT_AUTO_COMPACT = Boolean(agent.autoCompact);
  const thinking = isPlainObject(agent.thinking) ? agent.thinking : {};
  if (Object.hasOwn(thinking, 'enabled') && !Object.hasOwn(process.env, 'AGENT_THINKING_ENABLED')) target.AGENT_THINKING_ENABLED = Boolean(thinking.enabled);
  if (Object.hasOwn(thinking, 'level') && !Object.hasOwn(process.env, 'AGENT_THINKING_LEVEL')) target.AGENT_THINKING_LEVEL = String(thinking.level);
  if (Object.hasOwn(thinking, 'budget') && !Object.hasOwn(process.env, 'AGENT_THINKING_BUDGET')) target.AGENT_THINKING_BUDGET = Number(thinking.budget);
  return source;
}

export function validate() {
  const missing = [];
  if (!CONFIG.BITUNIX_API_KEY) missing.push('BITUNIX_API_KEY');
  if (!CONFIG.BITUNIX_API_SECRET) missing.push('BITUNIX_API_SECRET');
  if (!CONFIG.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!CONFIG.ALLOWED_USER_ID) missing.push('ALLOWED_USER_ID');
  return missing;
}
