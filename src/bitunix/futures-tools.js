import { CONFIG } from '../config.js';

let sharedClient = null;

export function setBitunixClient(c) { sharedClient = c; }

function requireClient() {
  if (!sharedClient) throw new Error('Client not ready');
  return sharedClient;
}

export const bitunixTools = [
  {
    name: 'bitunix_get_tickers',
    description: 'Get current tickers',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getTickers(symbol || CONFIG.symbol);
    },
  },
  {
    name: 'bitunix_get_kline',
    description: 'Get kline data',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string' }, interval: { type: 'string' }, limit: { type: 'number' } },
      required: ['symbol'],
    },
    async handler({ symbol, interval = '15m', limit = 200 }) {
      return requireClient().getKlines(symbol, interval, limit);
    },
  },
  {
    name: 'bitunix_get_depth',
    description: 'Get order book depth. limit is a fixed gear: 1, 5, 15, 50 or max (default: exchange default).',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, limit: { type: 'string', enum: ['1', '5', '15', '50', 'max'] } }, required: ['symbol'] },
    async handler({ symbol, limit }) {
      return requireClient().getDepth(symbol, limit);
    },
  },
  {
    name: 'bitunix_get_account',
    description: 'Get account info',
    parameters: { type: 'object', properties: { marginCoin: { type: 'string' } } },
    async handler({ marginCoin = 'USDT' }) {
      return requireClient().getAccount(marginCoin);
    },
  },
  {
    name: 'bitunix_get_funding_rate',
    description: 'Get funding rate',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol = CONFIG.symbol }) {
      return requireClient().getFundingRate(symbol);
    },
  },
  {
    name: 'bitunix_get_pending_positions',
    description: 'Get pending positions',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getPendingPositions(symbol);
    },
  },
  {
    name: 'bitunix_get_history_positions',
    description: 'Get history positions',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getHistoryPositions(symbol);
    },
  },
  {
    name: 'bitunix_place_order',
    description: 'Place a live Bitunix futures order that REDUCES or CLOSES existing exposure only. This tool cannot open a new position: an order sent here gets no automatic take-profit, so a naked entry can lose the whole margin. To open, use trader_open_position (manual, always sends TP+SL) or trader_execute_signal (autonomous, full risk gates). tradeSide must be CLOSE; hedge mode requires positionId.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        qty: { type: 'string' },
        price: { type: 'string', description: 'Required when orderType is LIMIT' },
        orderType: { type: 'string', enum: ['LIMIT', 'MARKET'] },
        tradeSide: { type: 'string', enum: ['CLOSE'], description: 'Only CLOSE is accepted. Opening through this tool is rejected.' },
        positionId: { type: 'string', description: 'Required when tradeSide is CLOSE (hedge mode)' },
        reduceOnly: { type: 'boolean' },
      },
      required: ['symbol', 'side', 'qty', 'tradeSide'],
    },
    async handler(params) {
      // SAFETY: this tool used to pass its arguments straight to place_order,
      // which let an OPEN order through with no take-profit and no stop — the
      // position then had no defined exit and could only be closed by hand
      // (a real -38% ROI trade on 25x came out of exactly this path). Only
      // position-reducing orders are allowed here; every entry goes through a
      // path that computes and attaches TP+SL before submitting.
      const tradeSide = String(params?.tradeSide || '').toUpperCase();
      if (tradeSide !== 'CLOSE') {
        throw new Error(
          'bitunix_place_order cannot open a position: tradeSide must be CLOSE. '
          + 'Use trader_open_position (manual entry, sends take-profit + stop-loss with the order) '
          + 'or trader_execute_signal (autonomous entry) instead.',
        );
      }
      if (params?.reduceOnly === false) {
        throw new Error('reduceOnly: false is not allowed on a CLOSE order; it would increase exposure instead of reducing it');
      }
      return requireClient().placeOrder({ ...params, tradeSide: 'CLOSE', reduceOnly: true });
    },
  },
  {
    name: 'bitunix_place_tpsl',
    description: 'Place a position TP/SL order. Requires symbol + positionId and at least one of tpPrice / slPrice.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        positionId: { type: 'string' },
        tpPrice: { type: 'string', description: 'Take-profit trigger price' },
        slPrice: { type: 'string', description: 'Stop-loss trigger price' },
      },
      required: ['symbol', 'positionId'],
    },
    async handler({ symbol, positionId, tpPrice, slPrice }) {
      if (!tpPrice && !slPrice) throw new Error('at least one of tpPrice or slPrice is required');
      return requireClient().placeTPSL({ symbol, positionId, ...(tpPrice ? { tpPrice } : {}), ...(slPrice ? { slPrice } : {}) });
    },
  },
  {
    name: 'bitunix_cancel_tpsl',
    description: 'Cancel TP/SL order',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, orderId: { type: 'string' } }, required: ['symbol', 'orderId'] },
    async handler({ symbol, orderId }) {
      return requireClient().cancelTPSL(symbol, orderId);
    },
  },
  {
    name: 'bitunix_get_pending_tpsl',
    description: 'Get pending TP/SL orders',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getPendingTPSL(symbol);
    },
  },
  {
    name: 'bitunix_get_history_tpsl',
    description: 'Get history TP/SL orders',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getHistoryTPSL(symbol);
    },
  },
  {
    name: 'bitunix_change_leverage',
    description: 'Change leverage',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, leverage: { type: 'number' } }, required: ['symbol', 'leverage'] },
    async handler({ symbol, leverage }) {
      return requireClient().changeLeverage(symbol, leverage);
    },
  },
  {
    name: 'bitunix_change_margin_mode',
    description: 'Change margin mode (crossed/isolated)',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, marginMode: { type: 'string' } }, required: ['symbol', 'marginMode'] },
    async handler({ symbol, marginMode }) {
      return requireClient().changeMarginMode(symbol, marginMode);
    },
  },
  {
    name: 'bitunix_change_position_mode',
    description: 'Change position mode (ONE_WAY/HEDGE)',
    parameters: { type: 'object', properties: { positionMode: { type: 'string' } }, required: ['positionMode'] },
    async handler({ positionMode }) {
      return requireClient().changePositionMode(positionMode);
    },
  },
  {
    name: 'bitunix_adjust_position_margin',
    description: 'Adjust position margin. amount>0 adds margin, amount<0 removes it. Requires marginCoin and one of side/positionId.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        amount: { type: 'string', description: 'Signed amount as string, e.g. "-100" or "25"' },
        marginCoin: { type: 'string', description: 'Margin coin, usually USDT' },
        side: { type: 'string', enum: ['LONG', 'SHORT'] },
        positionId: { type: 'string' },
      },
      required: ['symbol', 'amount', 'marginCoin'],
    },
    async handler({ symbol, amount, marginCoin, side, positionId }) {
      return requireClient().adjustPositionMargin(symbol, amount, { marginCoin, side, positionId });
    },
  },
  {
    name: 'bitunix_get_position_mode',
    description: 'Get current account position mode',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return requireClient().getPositionMode();
    },
  },
  {
    name: 'bitunix_get_trading_pairs',
    description: 'Get trading pairs list',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return requireClient().getTradingPairs();
    },
  },
  {
    name: 'bitunix_get_error_code',
    description: 'Get error code info',
    parameters: { type: 'object', properties: { code: { type: 'string' } } },
    async handler({ code }) {
      return requireClient().getErrorCode(code);
    },
  },
  {
    name: 'bitunix_get_leverage_and_margin_mode',
    description: 'Get leverage and margin mode',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getLeverageAndMarginMode(symbol);
    },
  },
  {
    name: 'bitunix_get_trades',
    description: 'Get recent trades',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
    async handler({ symbol }) {
      return requireClient().getHistoryTrades(symbol);
    },
  },
  {
    name: 'bitunix_flash_close',
    description: 'Flash close position by exact positionId',
    parameters: { type: 'object', properties: { positionId: { type: 'string' } }, required: ['positionId'] },
    async handler({ positionId }) {
      return requireClient().flashClosePosition(positionId);
    },
  },
];

export default bitunixTools;
