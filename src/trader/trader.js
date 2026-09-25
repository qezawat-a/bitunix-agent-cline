import Scanner from '../bitunix/scanner.js';
import { PositionManager } from './position-manager.js';
import { CONFIG } from '../config.js';

function validPositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export class Trader {
  client;
  scanner;
  positionManager;
  state = {
    lastScan: 0,
    lastGuard: 0,
    lastReport: 0,
    lastManage: 0,
    cooldownUntil: 0,
    orderUnknownUntil: 0,
    positions: [],
    lastPrivateEvent: null,
    lastSignal: null,
    lastReportData: null,
    lastMarketDirection: null,
    confirmations: new Map(),
  };
  entryInFlight = new Set();
  guardInFlight = null;
  manageInFlight = null;
  privateRefreshInFlight = null;

  constructor(client) {
    this.client = client;
    this.scanner = new Scanner(client);
    this.positionManager = new PositionManager(client, CONFIG.symbol, CONFIG);
  }

  async reconcilePositions() {
    const positions = await this.positionManager.fetchPositions();
    this.state.positions = positions.map(position => ({
      positionId: position.positionId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: Number(position.avgPrice),
      markPrice: Number(position.markPrice),
      openedAt: Number(position.ctime ?? position.openTime ?? Date.now()),
    }));
    return this.state.positions;
  }

  updateConfirmation(symbol, signal) {
    if (!['bullish', 'bearish'].includes(signal)) {
      this.state.confirmations.delete(symbol);
      return 0;
    }
    const current = this.state.confirmations.get(symbol);
    const count = current?.signal === signal ? current.count + 1 : 1;
    this.state.confirmations.set(symbol, { signal, count });
    return count;
  }

  async verifyAccountSettings() {
    const [account, leverageData, positionModeData] = await Promise.all([
      this.client.getAccount('USDT'),
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
      this.client.getPositionMode(),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const leverageValue = Number(leverageRecord?.leverage ?? leverageRecord?.marginLeverage);
    if (Number.isFinite(leverageValue) && leverageValue !== CONFIG.leverage) {
      throw new Error(`exchange leverage ${leverageValue} does not match configured leverage ${CONFIG.leverage}`);
    }
    const exchangeMode = String(positionModeData?.positionMode ?? account?.positionMode ?? account?.position_mode ?? '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) {
      throw new Error(`exchange position mode ${exchangeMode} does not match configured mode ${configuredMode}`);
    }
    const exchangeMarginMode = String(leverageRecord?.marginMode ?? '').toUpperCase();
    const configuredMarginMode = CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS';
    if (exchangeMarginMode && exchangeMarginMode !== configuredMarginMode) {
      throw new Error(`exchange margin mode ${exchangeMarginMode} does not match configured mode ${configuredMarginMode}`);
    }
    return { checked: true, leverage: Number.isFinite(leverageValue) ? leverageValue : null, positionMode: exchangeMode || null, marginMode: exchangeMarginMode || null };
  }

  async syncAccountSettings({ apply = false } = {}) {
    const [positions, orders] = await Promise.all([
      this.client.getPendingPositions(CONFIG.symbol),
      this.client.getPendingOrders(CONFIG.symbol),
    ]);
    if (!Array.isArray(positions) || !Array.isArray(orders)) throw new Error('exchange exposure state is invalid');
    const current = await this.verifyAccountSettings();
    if (!apply) return { ...current, applied: false };
    if (positions.length || orders.length) return { ...current, applied: false, skipped: 'open_exposure' };

    const [leverageData, positionModeData] = await Promise.all([
      this.client.getLeverageAndMarginMode(CONFIG.symbol),
      this.client.getPositionMode(),
    ]);
    const leverageRecord = Array.isArray(leverageData) ? leverageData[0] : leverageData;
    const leverage = Number(leverageRecord?.leverage);
    if (Number.isFinite(leverage) && leverage !== CONFIG.leverage) await this.client.changeLeverage(CONFIG.symbol, CONFIG.leverage);
    const marginMode = String(leverageRecord?.marginMode || '').toUpperCase();
    const configuredMarginMode = CONFIG.position_type === 'isolated' ? 'ISOLATION' : 'CROSS';
    if (marginMode && marginMode !== configuredMarginMode) await this.client.changeMarginMode(CONFIG.symbol, CONFIG.position_type);
    const exchangeMode = String(positionModeData?.positionMode || '').toUpperCase();
    const configuredMode = CONFIG.position_mode === 'hedge' ? 'HEDGE' : 'ONE_WAY';
    if (exchangeMode && exchangeMode !== configuredMode) await this.client.changePositionMode(CONFIG.position_mode);
    return { ...(await this.verifyAccountSettings()), applied: true };
  }

  async scanOnly() {
    const symbol = CONFIG.symbol;
    const result = await this.scanner.scan(symbol);
    if (CONFIG.symbol !== symbol) return null;
    const previousDirection = this.state.lastMarketDirection;
    const reversal = CONFIG.reversal_enabled
      && previousDirection
      && result.rawDirection !== 'neutral'
      && previousDirection !== result.rawDirection
      && result.rawConfidence >= CONFIG.reversal_confidence;
    if (result.rawDirection && result.rawDirection !== 'neutral') this.state.lastMarketDirection = result.rawDirection;
    result.reversal = reversal;
    if (!['bullish', 'bearish'].includes(result.signal)) {
      this.updateConfirmation(symbol, 'neutral');
      return { ...result, confirmations: 0, executed: false };
    }
    const confirmations = this.updateConfirmation(symbol, result.signal);
    return { ...result, confirmations, executed: false };
  }

  async executeSignal(signal) {
    if (!signal || !['bullish', 'bearish'].includes(signal.signal)) return { executed: false, reason: 'no directional signal' };
    if (!CONFIG.auto_trade) return { executed: false, reason: 'auto_trade_disabled' };
    if ((signal.confirmations || 0) < CONFIG.signal_confirm_scans) return { executed: false, reason: 'confirmation_pending' };
    const symbol = CONFIG.symbol;
    const now = Date.now();
    if (now < this.state.cooldownUntil || now < this.state.orderUnknownUntil) return { executed: false, reason: 'cooldown' };
    if (this.entryInFlight.has(symbol)) return { executed: false, reason: 'entry_in_flight' };
    this.entryInFlight.add(symbol);
    try {
      await this.reconcilePositions();
      if (this.state.positions.length >= CONFIG.max_positions) return { executed: false, reason: 'max_positions' };
      const entryPrice = Number(signal.lastPrice);
      if (!validPositive(entryPrice)) throw new Error('scanner returned an invalid entry price');
      const atr = signal.tfSignals?.[CONFIG.timeframes[0]]?.atr ?? null;
      const order = await this.openPosition(symbol, entryPrice, signal.signal, atr, signal.confidence);
      return { ...signal, executed: true, order, price: entryPrice };
    } finally {
      this.entryInFlight.delete(symbol);
    }
  }

  async scanAndOpen() {
    return this.executeSignal(await this.scanOnly());
  }

  async reconcileOrder(symbol, clientId) {
    if (typeof this.client.getPendingOrders !== 'function' || typeof this.client.getHistoryOrders !== 'function') return null;
    const results = await Promise.allSettled([
      this.client.getPendingOrders(symbol),
      this.client.getHistoryOrders(symbol),
    ]);
    for (const result of results) {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
      const match = result.value.find(order => String(order.clientId || order.client_id || '') === clientId);
      if (match) return match;
    }
    return null;
  }

  async openPosition(symbol, entryPrice, direction, atr = null, signalConfidence = null) {
    if (!CONFIG.auto_trade) throw new Error('auto_trade is disabled');
    if (!['bullish', 'bearish'].includes(direction)) throw new Error('invalid trade direction');
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    this.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
    this.state.confirmations.delete(symbol);

    const qty = await this.computePositionSize(entryPrice);
    const clientId = `jrock-open-${symbol}-${Date.now()}`;
    const levels = this.positionManager.computeTPSL(entryPrice, direction, atr, signalConfidence ?? CONFIG.min_confidence);
    const body = {
      symbol,
      side: direction === 'bullish' ? 'BUY' : 'SELL',
      price: String(Number(Number(entryPrice).toFixed(8))),
      qty: String(qty),
      orderType: 'LIMIT',
      effect: 'GTC',
      ...levels,
      tpOrderType: 'MARKET',
      slOrderType: 'MARKET',
      reduceOnly: false,
      tradeSide: 'OPEN',
      clientId,
    };

    if (!CONFIG.auto_trade) throw new Error('auto_trade was disabled before order submission');
    if (CONFIG.symbol !== symbol) throw new Error('symbol changed before order submission');
    let order;
    try {
      order = await this.client.placeOrder(body);
    } catch (error) {
      const reconciled = await this.reconcileOrder(symbol, clientId);
      if (!reconciled) {
        this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
        throw error;
      }
      order = reconciled;
    }
    const positions = await this.reconcilePositions();
    try {
      for (const position of positions) await this.positionManager.ensureProtection(position);
    } catch (error) {
      this.state.orderUnknownUntil = Date.now() + Math.max(Number(CONFIG.cooldown_minutes) * 60000, 300000);
      throw error;
    }
    return order;
  }

  async computePositionSize(entryPrice) {
    if (!validPositive(entryPrice)) throw new Error('entry price must be positive');
    if (!Number.isInteger(CONFIG.leverage) || CONFIG.leverage < 1 || CONFIG.leverage > 125) {
      throw new Error('leverage must be an integer 1-125');
    }
    const account = await this.client.getAccount('USDT');
    const available = Number(account?.available);
    if (!validPositive(available)) throw new Error('available USDT balance must be positive');
    const pairs = await this.client.getTradingPairs(CONFIG.symbol);
    const pair = (Array.isArray(pairs) ? pairs : []).find(item => String(item.symbol).toUpperCase() === CONFIG.symbol.toUpperCase());
    if (!pair) throw new Error(`trading pair metadata missing for ${CONFIG.symbol}`);
    const precision = Number.isInteger(Number(pair.basePrecision)) ? Number(pair.basePrecision) : 8;
    const notional = available * Number(CONFIG.position_sizing_margin_pct) / 100 * CONFIG.leverage;
    const size = notional / Number(entryPrice);
    const rounded = Math.floor(size * 10 ** precision) / 10 ** precision;
    if (!validPositive(rounded)) throw new Error('calculated position size must be positive');
    if (pair.minTradeVolume && rounded < Number(pair.minTradeVolume)) throw new Error(`position size ${rounded} is below Bitunix minimum ${pair.minTradeVolume}`);
    return rounded;
  }

  async guard() {
    if (this.guardInFlight) return this.guardInFlight;
    const now = Date.now();
    if (now < this.state.lastGuard + CONFIG.guard_interval_sec * 1000) return null;
    this.state.lastGuard = now;
    this.guardInFlight = (async () => {
      const positions = await this.positionManager.fetchPositions();
      const errors = [];
      for (const position of positions) {
        try {
          const result = await this.positionManager.checkLiquidationGuard(position);
          if (result?.dryRun && result.positionId) this.state.cooldownUntil = this.positionManager.state.cooldownUntil;
        } catch (error) {
          errors.push({ positionId: position.positionId, message: error.message });
        }
      }
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.positionManager.state.cooldownUntil);
      this.state.positions = positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));
      return errors;
    })();
    try {
      return await this.guardInFlight;
    } finally {
      this.guardInFlight = null;
    }
  }

  async midManage() {
    if (this.manageInFlight) return this.manageInFlight;
    const now = Date.now();
    if (now < this.state.lastManage + CONFIG.mid_manage_interval_sec * 1000) return null;
    this.state.lastManage = now;
    this.manageInFlight = this.positionManager.midManage();
    try {
      const errors = await this.manageInFlight;
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.positionManager.state.cooldownUntil);
      this.state.positions = this.positionManager.state.positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));
      return errors;
    } finally {
      this.manageInFlight = null;
    }
  }

  async handlePrivateEvent(event) {
    const channel = event?.ch;
    const data = event?.data;
    this.state.lastPrivateEvent = { channel: channel || null, event: data?.event || null, at: Date.now() };
    if (channel === 'position' && data) {
      const positionId = String(data.positionId || '');
      if (positionId) {
        this.state.positions = this.state.positions.filter(position => String(position.positionId) !== positionId);
        if (data.event !== 'CLOSE') {
          this.state.positions.push({
            positionId,
            symbol: data.symbol,
            side: data.side === 'LONG' ? 'BUY' : data.side === 'SHORT' ? 'SELL' : data.side,
            qty: data.qty,
            openedAt: data.ctime ? Date.parse(data.ctime) || Date.now() : Date.now(),
          });
        }
      }
    }
    if (channel === 'tpsl' && data?.status === 'FAILED') console.error('TP/SL private event failed:', data.positionId || data.orderId || 'unknown');
    if (!['order', 'position', 'tpsl'].includes(channel)) return null;
    if (this.privateRefreshInFlight) return this.privateRefreshInFlight;
    this.privateRefreshInFlight = this.reconcilePositions();
    try {
      return await this.privateRefreshInFlight;
    } finally {
      this.privateRefreshInFlight = null;
    }
  }

  async report() {
    const now = Date.now();
    if (now < this.state.lastReport + CONFIG.report_interval_sec * 1000) return;
    console.log(`[Report ${new Date().toISOString()}] symbol=${CONFIG.symbol} positions=${this.state.positions.length}`);
    this.state.lastReport = now;
  }

  async scanCycle() {
    let signal = null;
    try { signal = await this.scanOnly(); } catch (error) { console.error('scan error:', error.message); }
    try { await this.guard(); } catch (error) { console.error('guard error:', error.message); }
    try { await this.midManage(); } catch (error) { console.error('manage error:', error.message); }
    try { await this.report(); } catch (error) { console.error('report error:', error.message); }
    return signal;
  }
}
