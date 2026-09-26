import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, bollinger, atr, macd, superTrend, atrBreakout, computeSignal } from '../src/bitunix/indicators.js';
import {
  applyPersistedSettings,
  applySettings,
  getPersistentSettings,
  getTraderSettings,
  normalizeSettings,
  parseSettingValue,
  validateSettings,
} from '../src/trader/settings.js';
import { parseThinkingLevel } from '../src/agent/thinking.js';
import { CONFIG, parseBoolean, applySettingsFile } from '../src/config.js';
import { BitunixClient } from '../src/bitunix/client.js';
import Scanner from '../src/bitunix/scanner.js';
import { liqDistanceOk } from '../src/bitunix/risk.js';
import { Trader } from '../src/trader/trader.js';
import { PositionManager } from '../src/trader/position-manager.js';
import { setPositionManager, setTraderInstances, traderTools } from '../src/trader/agent-tools.js';
import { bitunixTools, setBitunixClient } from '../src/bitunix/futures-tools.js';
import { detectProviders } from '../src/agent/config.js';
import { chat, listOpenAiModels, resolveOpenAiModelsUrl, resolveOpenAiUrl, shouldSendTemperature } from '../src/agent/brain.js';
import { createAgent, sanitizeHistory, say, resetAgent } from '../src/agent/loop.js';
import { stringifyToolResult, validateToolArguments } from '../src/agent/tools.js';
import { splitHtml } from '../src/telegram-bot.js';
import {
  BitunixWs,
  KLINE_INTERVALS,
  PRIVATE_CHANNELS,
  normalizePrivateChannel,
  normalizePublicChannel,
} from '../src/bitunix/ws.js';
import crypto from 'node:crypto';
import { mock } from 'node:test';

const originalConfig = { ...CONFIG, timeframes: [...CONFIG.timeframes] };
const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.assign(CONFIG, originalConfig, { timeframes: [...originalConfig.timeframes] });
  globalThis.fetch = originalFetch;
  setTraderInstances(null, null);
  setPositionManager(null);
  setBitunixClient(null);
});

function fakePosition(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    positionId: 'p1',
    side: 'BUY',
    size: '1',
    avgPrice: '100',
    markPrice: '100',
    liqPrice: '50',
    openTime: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('indicators', () => {
  it('ema returns number for enough data', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + i);
    assert.ok(typeof ema(arr, 20) === 'number');
  });

  it('rsi returns 0-100', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5 + i * 0.2);
    const v = rsi(arr);
    assert.ok(v === null || (v >= 0 && v <= 100));
  });

  it('bollinger returns band', () => {
    const arr = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const bb = bollinger(arr);
    assert.ok(bb && bb.upper > bb.mid && bb.mid > bb.lower);
  });

  it('computeSignal returns direction+confidence', () => {
    const kl = Array.from({ length: 60 }, (_, i) => ({
      open: String(100 + i), high: String(101 + i), low: String(99 + i), close: String(100 + i),
    }));
    const vols = Array.from({ length: 60 }, () => 10);
    const res = computeSignal(kl, vols, 0);
    assert.ok(['bullish', 'bearish', 'neutral'].includes(res.direction));
    assert.ok(res.confidence >= 0 && res.confidence <= 100);
    assert.ok(Object.hasOwn(res.signals, 'supertrend'));
    assert.ok(Object.hasOwn(res.signals, 'atr_breakout'));
  });
});

describe('settings', () => {
  it('normalize fills defaults', () => {
    const s = normalizeSettings({});
    assert.equal(s.symbol, 'BTCUSDT');
    assert.ok(s.timeframes.includes('3m'));
    assert.ok(s.min_confidence === 80);
  });

  it('validate catches bad leverage', () => {
    const errs = validateSettings({ ...normalizeSettings({}), leverage: 999 });
    assert.ok(errs.length > 0);
  });
});

describe('thinking', () => {
  it('parses levels', () => {
    assert.equal(parseThinkingLevel('high'), 'high');
    assert.equal(parseThinkingLevel('off'), 'off');
    assert.equal(parseThinkingLevel('zzz'), 'mid');
  });
});

describe('safety configuration', () => {
  it('parses common boolean values and rejects unsafe values', () => {
    assert.equal(parseBoolean('true', false, 'TEST'), true);
    assert.equal(parseBoolean('0', true, 'TEST'), false);
    assert.throws(() => parseBoolean('maybe', true, 'TEST'), /TEST/);
  });

  it('normalizes aliases and rejects invalid persisted values', () => {
    const settings = normalizeSettings({ margin_mode: 'isolated', timeframes: '1m, 5m' });
    assert.equal(settings.position_type, 'isolated');
    assert.deepEqual(settings.timeframes, ['1m', '5m']);
    assert.ok(validateSettings({ ...settings, leverage: NaN }).length > 0);
    assert.ok(validateSettings({ ...settings, max_positions: 0 }).length > 0);
    assert.equal(parseSettingValue('max_positions', '4'), 4);
  });

  it('migrates persisted settings while ignoring secret and unknown fields', () => {
    const target = { ...getTraderSettings(CONFIG), auto_trade: false };
    applyPersistedSettings(target, { symbol: 'ETHUSDT', leverage: 12, BITUNIX_API_SECRET: 'secret', unknown: 'value', dry_run: false });
    assert.equal(target.symbol, 'ETHUSDT');
    assert.equal(target.leverage, 12);
    assert.equal(Object.hasOwn(target, 'unknown'), false);
    assert.equal(Object.hasOwn(target, 'dry_run'), false);
    assert.equal(Object.hasOwn(target, 'BITUNIX_API_SECRET'), false);
  });

  it('exposes only public settings and excludes auto_trade from persistence', () => {
    CONFIG.BITUNIX_API_SECRET = 'secret-sentinel';
    const publicSettings = getTraderSettings(CONFIG);
    assert.equal(Object.hasOwn(publicSettings, 'BITUNIX_API_SECRET'), false);
    const persistent = getPersistentSettings(CONFIG);
    // auto_trade is the live trading authority: never resume it after a restart.
    assert.equal(Object.hasOwn(persistent, 'auto_trade'), false);
    assert.equal(Object.hasOwn(persistent, 'symbol'), true);
    assert.equal(Object.hasOwn(persistent, 'BITUNIX_API_SECRET'), false);
  });
});

describe('indicator correctness', () => {
  it('calculates directional RSI, MACD, Super Trend, and ATR breakout', () => {
    const increasing = Array.from({ length: 80 }, (_, index) => 100 + index * index);
    const highs = increasing.map(value => value + 1);
    const lows = increasing.map(value => value - 1);
    assert.equal(rsi(increasing), 100);
    assert.equal(macd(increasing), 'bullish');
    assert.equal(superTrend(highs, lows, increasing), 'bullish');
    const decreasing = Array.from({ length: 80 }, (_, index) => 1000 - index * index);
    assert.equal(superTrend(decreasing.map(value => value + 1), decreasing.map(value => value - 1), decreasing), 'bearish');
    const flat = Array.from({ length: 60 }, () => 100);
    assert.equal(superTrend(flat.map(value => value + 1), flat.map(value => value - 1), flat), 'neutral');
    const breakout = [...increasing];
    breakout[breakout.length - 2] = breakout[breakout.length - 3];
    breakout[breakout.length - 1] += 10;
    const breakoutHighs = breakout.map(value => value + 1);
    const breakoutLows = breakout.map(value => value - 1);
    assert.equal(atrBreakout(breakoutHighs, breakoutLows, breakout, 5, 5, 0.1), 'bullish');
  });

  it('rejects malformed kline values', () => {
    const klines = Array.from({ length: 60 }, (_, index) => ({ close: String(100 + index), high: 'NaN', low: '1' }));
    const volumes = Array.from({ length: 60 }, () => 1);
    assert.throws(() => computeSignal(klines, volumes, 0), /positive finite/);
  });
});

describe('exchange safety', () => {
  it('rejects Bitunix API error envelopes', async () => {
    const client = new BitunixClient();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: '1001', msg: 'rejected', data: null }) });
    await assert.rejects(() => client.request('POST', '/test', { a: 1 }), /rejected/);
  });

  it('uses official Bitunix position close and TP/SL contracts', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ code: 0, data: { orderId: 'x' } }) };
    };
    const client = new BitunixClient();
    await client.closePosition('BTCUSDT', 'p1', { symbol: 'BTCUSDT', positionId: 'p1', side: 'LONG', qty: '2' });
    await client.placeTPSL({ symbol: 'BTCUSDT', positionId: 'p1', tpPrice: '110', slPrice: '90' });
    await client.getLeverageAndMarginMode('BTCUSDT');
    await client.getPositionMode();
    assert.match(requests[0].url, /trade\/place_order/);
    assert.equal(requests[0].body.side, 'BUY');
    assert.equal(requests[0].body.tradeSide, 'CLOSE');
    assert.match(requests[1].url, /tpsl\/position\/place_order/);
    assert.equal(Object.hasOwn(requests[1].body, 'tpOrderType'), false);
    assert.match(requests[2].url, /account\/get_leverage_margin_mode\?symbol=BTCUSDT&marginCoin=USDT/);
    assert.match(requests[3].url, /account\/position_mode/);
  });

  it('does not substitute a different margin coin', async () => {
    const client = new BitunixClient();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: [{ marginCoin: 'USDC', available: '10' }] }) });
    await assert.rejects(() => client.getAccount('USDT'), /USDT not found/);
  });

  it('fails closed when liquidation data is missing', () => {
    assert.equal(liqDistanceOk({ markPrice: 100, liqPrice: undefined }), false);
    assert.equal(liqDistanceOk({ markPrice: 0, liqPrice: 50 }), false);
    assert.equal(liqDistanceOk({ markPrice: 100, liqPrice: 0 }), true);
    assert.equal(liqDistanceOk({ markPrice: 100, liqPrice: 50 }), true);
  });

  it('enforces minimum scanner confidence', async () => {
    const klines = Array.from({ length: 60 }, (_, index) => ({ close: String(100 + index * index), high: String(101 + index * index), low: String(99 + index * index), baseVol: '10' }));
    const scanner = new Scanner({ getKlines: async () => klines, getFundingRate: async () => ({ value: 0 }) });
    Object.assign(CONFIG, { timeframes: ['1m'], min_agreeing_strategies: 1, tf_min_confidence: 0, min_confidence: 101 });
    const result = await scanner.scan('BTCUSDT');
    assert.equal(result.signal, 'hold');
  });

  it('does not order when auto-trade is disabled', async () => {
    const calls = [];
    const client = {
      getPendingPositions: async () => [],
      getAccount: async () => ({ available: '100' }),
      placeOrder: async body => { calls.push(body); return { orderId: 'o1' }; },
    };
    const trader = new Trader(client);
    trader.scanner.scan = async symbol => ({ symbol, signal: 'bullish', lastPrice: '100', tfSignals: {} });
    CONFIG.auto_trade = false;
    CONFIG.dry_run = true;
    const result = await trader.scanAndOpen();
    assert.equal(result.executed, false);
    assert.equal(calls.length, 0);
  });

  it('reconciles an order after an ambiguous write failure', async () => {
    let submitted;
    const client = {
      getAccount: async () => ({ available: '100' }),
      getTradingPairs: async () => [{ symbol: 'BTCUSDT', basePrecision: 8, minTradeVolume: '0.001' }],
      placeOrder: async body => { submitted = body; throw Object.assign(new Error('timeout'), { executionUnknown: true }); },
      getPendingOrders: async () => [{ clientId: submitted.clientId, orderId: 'o1', status: 'FILLED' }],
      getHistoryOrders: async () => [],
      getPendingPositions: async () => [],
    };
    const trader = new Trader(client);
    Object.assign(CONFIG, { auto_trade: true, leverage: 10, margin_amount_pct: 2, cooldown_minutes: 5 });
    const result = await trader.openPosition('BTCUSDT', 100, 'bullish', 2);
    assert.equal(result.orderId, 'o1');
  });

  it('rechecks auto-trade immediately before order submission', async () => {
    let resolveAccount;
    let orders = 0;
    const account = new Promise(resolve => { resolveAccount = resolve; });
    const client = {
      getPendingPositions: async () => [],
      getAccount: async () => account,
      getTradingPairs: async () => [{ symbol: 'BTCUSDT', basePrecision: 8, minTradeVolume: '0.001' }],
      placeOrder: async () => { orders++; return { orderId: 'o1' }; },
    };
    const trader = new Trader(client);
    trader.scanner.scan = async symbol => ({ symbol, signal: 'bullish', lastPrice: '100', tfSignals: { [CONFIG.timeframes[0]]: { atr: 2 } } });
    Object.assign(CONFIG, { auto_trade: true, signal_confirm_scans: 1, cooldown_minutes: 0, leverage: 10 });
    const pending = trader.scanAndOpen();
    await new Promise(resolve => setImmediate(resolve));
    CONFIG.auto_trade = false;
    resolveAccount({ available: '100' });
    await assert.rejects(() => pending, /disabled before order/);
    assert.equal(orders, 0);
  });

  it('rejects a minimum order when available balance is zero', async () => {
    const client = { getAccount: async () => ({ available: '0' }) };
    const trader = new Trader(client);
    await assert.rejects(() => trader.computePositionSize(100), /positive/);
  });

  it('serializes concurrent scan cycles into one entry', async () => {
    let orders = 0;
    const client = {
      getPendingPositions: async () => [],
      getAccount: async () => ({ available: '100' }),
      getTradingPairs: async () => [{ symbol: 'BTCUSDT', basePrecision: 8, minTradeVolume: '0.001' }],
      placeOrder: async () => { orders++; await new Promise(resolve => setTimeout(resolve, 10)); return { orderId: 'o1' }; },
    };
    const trader = new Trader(client);
    trader.scanner.scan = async symbol => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { symbol, signal: 'bullish', lastPrice: '100', tfSignals: { [CONFIG.timeframes[0]]: { atr: 2 } } };
    };
    Object.assign(CONFIG, { auto_trade: true, signal_confirm_scans: 1, cooldown_minutes: 0, leverage: 10 });
    const results = await Promise.all([trader.scanAndOpen(), trader.scanAndOpen()]);
    // The guard is on order submission, not on the scan itself: both cycles may
    // scan, but the in-flight lock must let exactly one order through.
    assert.equal(orders, 1);
    assert.equal(results.filter(result => result?.executed).length, 1);
    assert.equal(results.find(result => !result?.executed).reason, 'entry_in_flight');
  });

  it('verifies exchange account settings before live trading', async () => {
    const trader = new Trader({
      getAccount: async () => ({ positionMode: 'HEDGE' }),
      getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: 'CROSS' }),
      getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    });
    await trader.verifyAccountSettings();
    const mismatched = new Trader({
      getAccount: async () => ({ positionMode: 'HEDGE' }),
      getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage + 1, marginMode: 'CROSS' }),
      getPositionMode: async () => ({ positionMode: 'HEDGE' }),
    });
    await assert.rejects(() => mismatched.verifyAccountSettings(), /does not match/);
  });

  it('does not apply account settings while exposure is open', async () => {
    let changed = 0;
    const client = {
      getPendingPositions: async () => [fakePosition()],
      getPendingOrders: async () => [],
      getAccount: async () => ({ positionMode: 'HEDGE' }),
      getLeverageAndMarginMode: async () => ({ leverage: CONFIG.leverage, marginMode: 'CROSS' }),
      getPositionMode: async () => ({ positionMode: 'HEDGE' }),
      changeLeverage: async () => { changed++; },
    };
    const trader = new Trader(client);
    const result = await trader.syncAccountSettings({ apply: true });
    assert.equal(result.skipped, 'open_exposure');
    assert.equal(changed, 0);
  });

  it('places missing TP/SL protection after a fill', async () => {
    const calls = [];
    const client = {
      getPendingTPSL: async () => [],
      getKlines: async () => Array.from({ length: 60 }, (_, i) => ({ high: String(101 + i), low: String(99 + i), close: String(100 + i) })),
      placeTPSL: async params => { calls.push(params); return { orderId: 'sl-1' }; },
    };
    const pm = new PositionManager(client, 'BTCUSDT', getTraderSettings(CONFIG));
    const result = await pm.ensureProtection(fakePosition({ slPrice: undefined, atr: 2 }));
    assert.equal(result.placed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].positionId, 'p1');
  });

  it('closes the exact position when the liquidation guard trips', async () => {
    const calls = [];
    const client = {
      getPendingPositions: async () => [fakePosition()],
      closePosition: async (...args) => { calls.push(args); return { ok: true, closed: 'p1' }; },
    };
    // sl_liquidation_safety 90 => a 0.5% mark-to-liq distance must trigger a close.
    const pm = new PositionManager(client, 'BTCUSDT', { ...getTraderSettings(CONFIG), sl_liquidation_safety: 90, cooldown_minutes: 1 });
    const result = await pm.checkLiquidationGuard(fakePosition({ markPrice: '100', liqPrice: '99.5' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'BTCUSDT');
    assert.equal(calls[0][1], 'p1');
    assert.equal(result.closed, 'p1');
  });

  it('leaves positions alone when the liquidation distance is safe', async () => {
    let closes = 0;
    const client = { getPendingPositions: async () => [fakePosition()], closePosition: async () => { closes++; } };
    const pm = new PositionManager(client, 'BTCUSDT', { ...getTraderSettings(CONFIG), sl_liquidation_safety: 10 });
    const result = await pm.checkLiquidationGuard(fakePosition({ markPrice: '100', liqPrice: '50' }));
    assert.equal(result.skipped, 'liquidation distance safe');
    assert.equal(closes, 0);
  });

  it('normalizes documented LONG positions for management', async () => {
    const client = { getPendingPositions: async () => [{ symbol: 'BTCUSDT', positionId: 'p1', side: 'LONG', qty: '1', avgOpenPrice: '100', liqPrice: '50' }], getTickers: async () => [{ lastPrice: '101' }] };
    const pm = new PositionManager(client, 'BTCUSDT', { ...getTraderSettings(CONFIG), symbol: 'BTCUSDT' });
    const positions = await pm.fetchPositions();
    assert.equal(positions[0].side, 'BUY');
    assert.equal(positions[0].avgPrice, '100');
    assert.equal(positions[0].markPrice, 101);
  });

  it('uses the configured symbol for position reads', async () => {
    const requested = [];
    const client = { getPendingPositions: async symbol => { requested.push(symbol); return []; } };
    const settings = { ...getTraderSettings(CONFIG), symbol: 'ETHUSDT' };
    const pm = new PositionManager(client, 'ETHUSDT', settings);
    await pm.fetchPositions();
    assert.deepEqual(requested, ['ETHUSDT']);
  });
});

describe('tool safety', () => {
  it('redacts configuration from the settings tool', async () => {
    setTraderInstances(null, {});
    CONFIG.BITUNIX_API_SECRET = 'secret-sentinel';
    const tool = traderTools.find(item => item.name === 'trader_get_settings');
    const result = await tool.handler();
    assert.equal(JSON.stringify(result).includes('secret-sentinel'), false);
  });

  it('forwards a specific position ID and never closes all positions', async () => {
    const calls = [];
    setTraderInstances(null, { closePosition: async (...args) => { calls.push(args); return { ok: true }; } });
    const tool = traderTools.find(item => item.name === 'trader_close_position');
    await tool.handler({ symbol: 'BTCUSDT', positionId: 'p1' });
    assert.deepEqual(calls, [['BTCUSDT', 'p1']]);
  });

  it('forwards a valid Bitunix change_leverage request', async () => {
    const calls = [];
    setBitunixClient({ changeLeverage: async (...args) => { calls.push(args); return { ok: true }; } });
    const tool = bitunixTools.find(item => item.name === 'bitunix_change_leverage');
    await tool.handler({ symbol: 'BTCUSDT', leverage: 5 });
    assert.deepEqual(calls, [['BTCUSDT', 5]]);
  });

  it('rejects an out-of-range leverage before calling the exchange', async () => {
    // Use the real client so changeLeverage's own 1-125 guard is exercised.
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { leverage: 5 } }) });
    const client = new BitunixClient();
    await assert.rejects(() => client.changeLeverage('BTCUSDT', 500), /1-125/);
  });

  it('validates tool arguments and serializes undefined results', () => {
    assert.throws(() => validateToolArguments({ type: 'object', required: ['symbol'] }, {}), /missing required/);
    assert.equal(stringifyToolResult(undefined), '{"ok":true}');
  });

});

describe('provider and websocket safety', () => {
  it('auto-selects a discovered model without a hardcoded fallback', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://auto-provider.test/v1', AI_API_KEY: 'test-key', AI_MODEL: 'AUTO' });
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'standard' }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const result = await chat([{ role: 'user', content: 'hello' }], 'openai');
    assert.equal(result.text, 'ok');
    assert.equal(requests[1].body.model, 'standard');
  });

  it('lists models from an OpenAI-compatible endpoint', async () => {
    Object.assign(CONFIG, { AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'test-key' });
    globalThis.fetch = async url => {
      assert.equal(url, 'https://example.test/v1/models');
      return { ok: true, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) };
    };
    assert.deepEqual(await listOpenAiModels(), ['model-a', 'model-b']);
    assert.equal(resolveOpenAiModelsUrl('https://example.test/v1'), 'https://example.test/v1/models');
  });

  it('normalizes OpenAI-compatible base URLs', () => {
    assert.equal(resolveOpenAiUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(resolveOpenAiUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(resolveOpenAiUrl('https://example.test/custom/chat/completions'), 'https://example.test/custom/chat/completions');
  });

  it('sanitizes history into a provider-safe tool sequence', () => {
    const history = [
      { role: 'user', content: 'set tf' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_tf', arguments: { tf: '5m' } } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'set_tf', content: { ok: true } },
      { role: 'assistant', content: 'done' },
    ];
    const clean = sanitizeHistory(history, 20);
    assert.equal(clean.length, 4);
    assert.equal(clean[1].tool_calls[0].function.arguments, '{"tf":"5m"}');
    assert.deepEqual(Object.keys(clean[2]).sort(), ['content', 'role', 'tool_call_id']);
    assert.equal(clean[2].content, '{"ok":true}');
    // A window that cuts the assistant call away must drop the orphaned result,
    // otherwise the provider answers 400 and the session stays poisoned.
    const cut = sanitizeHistory(history, 2);
    assert.ok(!cut.some(message => message.role === 'tool'));
    assert.ok(!sanitizeHistory([{ role: 'assistant', content: null }], 5).length);
    assert.ok(!sanitizeHistory([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'f' } }] }], 5).length);
  });

  it('omits temperature for reasoning endpoints and sends it elsewhere', () => {
    assert.equal(shouldSendTemperature('ag/gemini-3.8-flash-high', ''), undefined);
    assert.equal(shouldSendTemperature('kc/deepseek/deepseek-reasoner', ''), undefined);
    assert.equal(shouldSendTemperature('kc/openai/o3', ''), undefined);
    assert.equal(shouldSendTemperature('ag/gemini-3-flash', ''), 0.7);
    assert.equal(shouldSendTemperature('ag/gemini-3-flash', '0.2'), 0.2);
  });

  it('rolls a failed turn back so the next message starts clean', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'auto', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://example.test/v1', AI_MODEL: 'fixed-model', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' });
    const agent = createAgent({ system: 'rules', tools: [], history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'noted' }] });
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'invalid_request_error' });
    const failed = await say(agent, 'set timeframes');
    assert.equal(failed.error, true);
    assert.match(failed.content, /LLM error/);
    assert.equal(agent.history.length, 2);
    assert.equal(agent.history[1].content, 'noted');
    assert.equal(resetAgent(agent), 2);
    assert.equal(agent.history.length, 0);
  });

  it('auto-selects an available provider', () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'auto', AI_API_KEY: '', ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: '' });
    assert.equal(detectProviders(), 'anthropic');
  });

  it('sends system and tool definitions to Anthropic and Gemini', async () => {
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    };
    Object.assign(CONFIG, { ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: 'gemini-key' });
    const tools = [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }];
    await chat([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }], 'anthropic', tools);
    await chat([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }], 'google', tools);
    assert.equal(bodies[0].system, 'rules');
    assert.equal(bodies[0].tools[0].name, 'probe');
    assert.equal(bodies[1].systemInstruction.parts[0].text, 'rules');
    assert.equal(bodies[1].tools[0].functionDeclarations[0].name, 'probe');
  });

  it('executes Anthropic tool calls through the shared loop', async () => {
    let calls = 0;
    let round = 0;
    Object.assign(CONFIG, { AI_PROVIDER: 'anthropic', AI_API_KEY: '', ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: '' });
    globalThis.fetch = async () => {
      round += 1;
      return { ok: true, json: async () => round === 1 ? { content: [{ type: 'tool_use', id: 'call-1', name: 'probe', input: { value: 1 } }] } : { content: [{ type: 'text', text: 'done' }] } };
    };
    const agent = createAgent({
      system: 'rules',
      tools: [{ name: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }, handler: async () => { calls += 1; return { ok: true }; } }],
      maxRounds: 3,
    });
    const result = await agent.say('run probe');
    assert.equal(calls, 1);
    assert.equal(result.content, 'done');
  });

  it('does not reconnect a socket after close', () => {
    const sockets = [];
    class FakeSocket {
      constructor(url) { this.url = url; this.handlers = {}; sockets.push(this); }
      on(event, handler) { this.handlers[event] = handler; }
      send() {}
      close() { this.handlers.close?.(); }
    }
    const ws = new BitunixWs({}, FakeSocket);
    const socket = ws.connectPublic();
    ws.close();
    socket.handlers.close?.();
    assert.equal(sockets.length, 1);
  });
});

describe('telegram formatting', () => {
  it('keeps long HTML messages within safe chunks', () => {
    const chunks = splitHtml(`<b>${'x'.repeat(9000)}</b>`);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 3500);
      assert.equal((chunk.match(/<b>/g) || []).length, (chunk.match(/<\/b>/g) || []).length);
    }
  });

describe('bitunix websocket channel contracts', () => {
  it('maps documented channel names and common aliases', () => {
    assert.deepEqual(normalizePublicChannel({ ch: 'tickers', symbol: 'BTCUSDT' }), { symbol: 'BTCUSDT', ch: 'tickers' });
    assert.deepEqual(normalizePublicChannel('price'), { ch: 'price' });
    assert.deepEqual(normalizePublicChannel('depth'), { ch: 'depth_books' });
    assert.deepEqual(normalizePublicChannel('market_price'), { ch: 'price' });
    assert.deepEqual(normalizePublicChannel('depth_book1'), { ch: 'depth_book1' });
  });

  it('translates kline intervals to the websocket naming scheme', () => {
    assert.deepEqual(normalizePublicChannel({ ch: 'kline', interval: '15m', symbol: 'BTCUSDT' }), { symbol: 'BTCUSDT', ch: 'market_kline_15min' });
    assert.deepEqual(normalizePublicChannel('mark_kline_1h'), { ch: 'mark_kline_60min' });
    assert.deepEqual(normalizePublicChannel('market_kline_1d'), { ch: 'market_kline_1day' });
    assert.deepEqual(normalizePublicChannel('market_kline_1M'), { ch: 'market_kline_1month' });
    assert.equal(normalizePublicChannel({ ch: 'kline', interval: '1week' }).ch, 'market_kline_1week');
    assert.ok(KLINE_INTERVALS.includes('1min') && KLINE_INTERVALS.includes('1month'));
  });

  it('rejects channels the server would silently ignore', () => {
    for (const bad of ['', 'depths', 'klines', 'ticker_1s']) {
      assert.throws(() => normalizePublicChannel(bad), /public WS channel/);
    }
    assert.throws(() => normalizePublicChannel({ ch: 'kline', symbol: 'BTCUSDT' }), /interval/);
    assert.throws(() => normalizePublicChannel({ ch: 'kline', interval: '7m' }), /interval/);
    assert.throws(() => normalizePublicChannel('market_kline_3s'), /interval/);
  });

  it('normalizes private channels, including the tp_sl alias', () => {
    assert.equal(normalizePrivateChannel('tp_sl'), 'tpsl');
    assert.equal(normalizePrivateChannel({ ch: 'TPSL' }), 'tpsl');
    for (const channel of PRIVATE_CHANNELS) assert.equal(normalizePrivateChannel(channel), channel);
    assert.throws(() => normalizePrivateChannel('positions'), /unknown private WS channel/);
  });
});


describe('bitunix websocket frames', () => {
  let sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = FakeSocket.OPEN; this.handlers = {}; this.sent = []; sockets.push(this); }
    on(event, handler) { this.handlers[event] = handler; }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; this.handlers.close?.(); }
    open() { this.handlers.open?.(); }
    message(payload) { this.handlers.message?.(Buffer.from(JSON.stringify(payload))); }
  }

  beforeEach(() => { sockets = []; });

  it('sends normalized subscribe args and forwards only channel data', () => {
    const received = [];
    const ws = new BitunixWs({ onPublic: message => received.push(message) }, FakeSocket);
    const socket = ws.connectPublic(['tickers', { ch: 'depth', symbol: 'BTCUSDT' }]);
    socket.open();
    assert.deepEqual(socket.sent[0], { op: 'subscribe', args: [{ ch: 'tickers' }, { symbol: 'BTCUSDT', ch: 'depth_books' }] });
    socket.message({ op: 'connect', data: { result: true } });
    socket.message({ op: 'ping', pong: 1, ping: 2 });
    socket.message({ ch: 'tickers', symbol: 'BTCUSDT', data: [{ s: 'BTCUSDT' }] });
    assert.equal(received.length, 1);
    assert.equal(received[0].ch, 'tickers');
    ws.close();
  });

  it('logs in with an integer seconds timestamp and a matching signature', () => {
    Object.assign(CONFIG, { BITUNIX_API_KEY: 'test-key', BITUNIX_API_SECRET: 'test-secret' });
    const ws = new BitunixWs({}, FakeSocket);
    const socket = ws.connectPrivate(['balance', 'tp_sl']);
    socket.open();
    const [login, subscribe] = socket.sent;
    assert.equal(login.op, 'login');
    const arg = login.args[0];
    assert.equal(typeof arg.timestamp, 'number');
    assert.ok(Math.abs(arg.timestamp - Math.floor(Date.now() / 1000)) <= 2);
    assert.equal(arg.apiKey, 'test-key');
    assert.match(arg.nonce, /^[0-9a-f]{32}$/);
    assert.match(arg.sign, /^[0-9a-f]{64}$/);
    const params = `apiKey${arg.apiKey}nonce${arg.nonce}timestamp${arg.timestamp}`;
    const digest = crypto.createHash('sha256').update(`${arg.nonce}${arg.timestamp}${arg.apiKey}${params}`).digest('hex');
    assert.equal(arg.sign, crypto.createHash('sha256').update(digest + 'test-secret').digest('hex'));
    assert.deepEqual(subscribe, { op: 'subscribe', args: [{ ch: 'balance' }, { ch: 'tpsl' }] });
    ws.close();
  });

  it('refuses to open a socket for an unknown channel', () => {
    const ws = new BitunixWs({}, FakeSocket);
    assert.throws(() => ws.connectPublic(['depth_book7']), /unknown public WS channel/);
    assert.throws(() => ws.connectPrivate(['tp_sl_v2']), /unknown private WS channel/);
    assert.equal(sockets.length, 0);
  });

  it('requires an unsubscribe before switching kline intervals', () => {
    const ws = new BitunixWs({}, FakeSocket);
    const socket = ws.connectPublic([{ ch: 'kline', interval: '1m', symbol: 'BTCUSDT' }]);
    socket.open();
    assert.deepEqual(socket.sent[0].args[0], { symbol: 'BTCUSDT', ch: 'market_kline_1min' });
    ws.unsubscribePublic([{ ch: 'kline', interval: '5m', symbol: 'BTCUSDT' }]);
    ws.subscribePublic([{ ch: 'kline', interval: '5m', symbol: 'BTCUSDT' }]);
    assert.deepEqual(socket.sent.at(-2), { op: 'unsubscribe', args: [{ symbol: 'BTCUSDT', ch: 'market_kline_5min' }] });
    assert.deepEqual(socket.sent.at(-1), { op: 'subscribe', args: [{ symbol: 'BTCUSDT', ch: 'market_kline_5min' }] });
    ws.close();
  });

  it('keeps the connection alive with a ping frame and stops it on close', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const ws = new BitunixWs({}, FakeSocket);
      const socket = ws.connectPublic(['tickers']);
      socket.open();
      mock.timers.tick(15000);
      const ping = socket.sent.at(-1);
      assert.equal(ping.op, 'ping');
      assert.equal(typeof ping.ping, 'number');
      assert.ok(Math.abs(ping.ping - Math.floor(Date.now() / 1000)) <= 2);
      mock.timers.tick(15000);
      assert.equal(socket.sent.length, 3);
      ws.close();
      mock.timers.tick(60000);
      assert.equal(socket.sent.length, 3);
    } finally {
      mock.timers.reset();
    }
  });

  it('surfaces socket errors without reconnecting after close', () => {
    const errors = [];
    const ws = new BitunixWs({ onError: error => errors.push(error.message) }, FakeSocket);
    const socket = ws.connectPublic(['tickers']);
    socket.handlers.error(new Error('boom'));
    assert.deepEqual(errors, ['boom']);
    ws.close();
    assert.equal(ws.publicWs, null);
    assert.equal(ws.publicPingTimer, null);
  });
});

});
