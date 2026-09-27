import { CONFIG } from '../config.js';
import { applySettings, getTraderSettings, resolveSettingKey } from './settings.js';
import { convert, positionSizeFromUnit } from '../bitunix/order-units.js';
import { describeTpslMethods } from './tpsl.js';

let sharedTrader = null;
let sharedClient = null;
let sharedPositionManager = null;

export function setTraderInstances(trader, client) {
  sharedTrader = trader;
  sharedClient = client;
}

export function setPositionManager(pm) {
  sharedPositionManager = pm;
}

function requireClient() {
  if (!sharedClient) throw new Error('Client not ready');
  return sharedClient;
}

function markCooldown() {
  if (sharedTrader?.state) sharedTrader.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
}

export const traderTools = [
  {
    name: 'trader_scan_signal',
    description: 'Run the live Bitunix multi-timeframe scanner and return a signal without placing an order',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!sharedTrader) throw new Error('Trader not ready');
      return sharedTrader.scanOnly();
    },
  },
  {
    name: 'trader_execute_signal',
    description: 'Re-scan, apply all signal/risk gates, and execute one live Bitunix position if auto-trade is enabled',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!sharedTrader) throw new Error('Trader not ready');
      if (!CONFIG.auto_trade) return { executed: false, reason: 'auto_trade_disabled' };
      return sharedTrader.executeSignal(await sharedTrader.scanOnly());
    },
  },
  {
    name: 'trader_get_settings',
    description: 'Get non-secret trader settings',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return { settings: getTraderSettings(CONFIG) };
    },
  },
  {
    name: 'trader_set_setting',
    description: 'Update one validated non-safety trader setting',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: ['string', 'number', 'boolean', 'array', 'null'] },
      },
      required: ['key', 'value'],
    },
    async handler({ key, value }) {
      if (key === 'auto_trade') throw new Error('auto_trade requires an authenticated Telegram command');
      if (key === 'symbol' && String(value).toUpperCase() !== CONFIG.symbol) {
        const client = requireClient();
        const positions = await client.getPendingPositions(CONFIG.symbol);
        if (!Array.isArray(positions) || positions.length) throw new Error('cannot change symbol while positions are open');
      }
      const settings = applySettings(CONFIG, { [key]: value });
      // applySettings keys the result canonically, so resolve the alias to echo
      // back the stored value (e.g. key "tf" -> "timeframes").
      const canonical = resolveSettingKey(key);
      return { ok: true, key: canonical, value: settings[canonical] };
    },
  },
  {
    name: 'trader_get_positions',
    description: 'Get current open positions',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!sharedPositionManager) return { positions: [] };
      const positions = await sharedPositionManager.fetchPositions();
      return { positions };
    },
  },
  {
    name: 'trader_open_position',
    description: 'Manually open a position after explicit live-mode approval',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        qty: { type: 'string' },
        price: { type: 'string' },
      },
      required: ['symbol', 'side', 'qty'],
    },
    async handler({ symbol, side, qty, price }) {
      const client = requireClient();
      const params = {
        symbol: String(symbol).toUpperCase(),
        side,
        qty: String(qty),
        price: price ? String(price) : '',
        orderType: price ? 'LIMIT' : 'MARKET',
        effect: 'GTC',
        tradeSide: 'OPEN',
        reduceOnly: false,
      };
      const order = await client.placeOrder(params);
      markCooldown();
      if (sharedTrader?.reconcilePositions) await sharedTrader.reconcilePositions();
      return { order };
    },
  },
  {
    name: 'trader_convert_order_unit',
    description: 'Convert an order size between Bitunix\'s three order units (nominal/notional in USDT, cost/margin paid, qty in base coin) and show what it would cost to trade',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        from: { type: 'string', enum: ['nominal', 'cost', 'qty'] },
        to: { type: 'string', enum: ['nominal', 'cost', 'qty'] },
        price: { type: 'number', description: 'current mark price of the symbol' },
        leverage: { type: 'number' },
      },
      required: ['value', 'from', 'to', 'price', 'leverage'],
    },
    async handler({ value, from, to, price, leverage }) {
      return convert({ value: Number(value), from, to, price: Number(price), leverage: Number(leverage) });
    },
  },
  {
    name: 'trader_preview_position_size',
    description: 'Preview the exchange-legal order size for a margin budget, in any of the three Bitunix order units, including precision rounding and min/max volume limits',
    parameters: {
      type: 'object',
      properties: {
        available: { type: 'number', description: 'free USDT balance; omit to use the live account' },
        unit: { type: 'string', enum: ['nominal', 'cost', 'qty'] },
        price: { type: 'number' },
        leverage: { type: 'number' },
        marginPct: { type: 'number' },
      },
      required: ['price'],
    },
    async handler({ available, unit, price, leverage, marginPct }) {
      const client = requireClient();
      const lev = Number(leverage ?? CONFIG.leverage);
      const mark = Number(price);
      let balance = Number(available);
      if (!Number.isFinite(balance) || balance <= 0) {
        const account = await client.getAccount('USDT');
        balance = Number(account?.available);
      }
      if (!Number.isFinite(balance) || balance <= 0) throw new Error('available USDT balance must be positive');
      const pairs = await client.getTradingPairs(CONFIG.symbol);
      const pair = (Array.isArray(pairs) ? pairs : [])
        .find(item => String(item.symbol).toUpperCase() === CONFIG.symbol.toUpperCase());
      if (!pair) throw new Error(`trading pair metadata missing for ${CONFIG.symbol}`);
      return {
        ...positionSizeFromUnit({
          available: balance,
          unit: unit || CONFIG.order_unit,
          price: mark,
          leverage: lev,
          marginPct: Number(marginPct ?? CONFIG.position_sizing_margin_pct),
          pair,
        }),
        pair: { symbol: pair.symbol, basePrecision: pair.basePrecision, minTradeVolume: pair.minTradeVolume },
      };
    },
  },
  {
    name: 'trader_explain_tpsl',
    description: 'Explain Bitunix\'s four take-profit/stop-loss methods and show the plan currently configured for this account',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        methods: describeTpslMethods(),
        active: {
          tpsl_method: CONFIG.tpsl_method,
          partial_tp_fractions: CONFIG.partial_tp_fractions,
          partial_tp_roi_steps: CONFIG.partial_tp_roi_steps,
          trailing_callback_pct: CONFIG.trailing_callback_pct,
          account_tp_roi_pct: CONFIG.account_tp_roi_pct,
          account_sl_roi_pct: CONFIG.account_sl_roi_pct,
          order_unit: CONFIG.order_unit,
        },
        reference: 'https://www.bitunix.com/hub/helpcenter/article/bitunix-futures-position-a-guide-to-four-take-profit-and-stop-loss-methods-web?id=290',
      };
    },
  },
  {
    name: 'trader_close_position',
    description: 'Close one position by its exact position ID',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        positionId: { type: 'string' },
      },
      required: ['symbol', 'positionId'],
    },
    async handler({ symbol, positionId }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      const result = await client.closePosition(normalizedSymbol, positionId);
      markCooldown();
      return { result };
    },
  },
  {
    name: 'trader_close_all',
    description: 'Close every position for one explicitly named symbol',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      const result = await client.closeAllPosition(normalizedSymbol);
      markCooldown();
      return { result };
    },
  },
  {
    name: 'trader_set_leverage',
    description: 'Change leverage',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, leverage: { type: 'number' } }, required: ['symbol', 'leverage'] },
    async handler({ symbol, leverage }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      const result = await client.changeLeverage(normalizedSymbol, leverage);
      if (normalizedSymbol === CONFIG.symbol) applySettings(CONFIG, { leverage });
      return result;
    },
  },
  {
    name: 'trader_set_margin_mode',
    description: 'Change margin mode',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, marginMode: { type: 'string', enum: ['crossed', 'isolated'] } }, required: ['symbol', 'marginMode'] },
    async handler({ symbol, marginMode }) {
      const client = requireClient();
      const normalizedSymbol = String(symbol).toUpperCase();
      const result = await client.changeMarginMode(normalizedSymbol, marginMode);
      if (normalizedSymbol === CONFIG.symbol) applySettings(CONFIG, { position_type: marginMode });
      return result;
    },
  },
  {
    name: 'trader_set_auto_trade',
    description: 'Disable autonomous trading; enabling requires an authenticated Telegram command',
    parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    async handler({ enabled }) {
      if (enabled) throw new Error('auto-trade cannot be enabled through an LLM tool');
      CONFIG.auto_trade = false;
      return { ok: true, auto_trade: false };
    },
  },
  {
    name: 'trader_get_balance',
    description: 'Get USDT balance',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return { balance: await requireClient().getAccount('USDT') };
    },
  },
  {
    name: 'trader_get_history',
    description: 'Get order/position history',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    async handler({ symbol }) {
      const client = requireClient();
      const [orders, positions] = await Promise.all([
        client.getHistoryOrders(symbol || CONFIG.symbol),
        client.getHistoryPositions(symbol || CONFIG.symbol),
      ]);
      return { orders, positions };
    },
  },
];
