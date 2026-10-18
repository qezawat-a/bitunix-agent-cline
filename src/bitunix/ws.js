import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import crypto from 'crypto';

// Verified against the official Bitunix futures WebSocket docs and against live
// pushes on wss://fapi.bitunix.com/public/ (2026-09-26). Unknown channel names
// are NOT rejected by the server — the subscribe is silently ignored, so the
// client validates channels locally instead of losing data silently.
export const PUBLIC_CHANNELS = ['depth_books', 'depth_book1', 'depth_book5', 'depth_book15', 'price', 'ticker', 'tickers', 'trade'];
export const PRIVATE_CHANNELS = ['balance', 'order', 'position', 'tpsl'];

// WS kline channels are <price>_kline_<interval> and use interval strings that
// differ from the REST kline API (1min/60min/1day instead of 1m/1h/1d).
export const KLINE_INTERVALS = ['1min', '3min', '5min', '15min', '30min', '60min', '2h', '4h', '6h', '8h', '12h', '1day', '3day', '1week', '1month'];
const KLINE_INTERVAL_ALIASES = {
  '1m': '1min', '3m': '3min', '5m': '5min', '15m': '15min', '30m': '30min',
  '1h': '60min', '60m': '60min', '1d': '1day', '3d': '3day', '1w': '1week', '1mo': '1month', '1M': '1month',
};
// Aliases people commonly reach for; each maps to a real channel name.
const PUBLIC_CHANNEL_ALIASES = { depth: 'depth_books', market_price: 'price', book1: 'depth_book1', book5: 'depth_book5', book15: 'depth_book15' };
const PRIVATE_CHANNEL_ALIASES = { tp_sl: 'tpsl', 'tp-sl': 'tpsl', tpSl: 'tpsl' };
const KLINE_CHANNEL_RE = /^(market|mark)_kline_(.+)$/i;
const WS_PING_INTERVAL_MS = 15000;

export function normalizeKlineInterval(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`kline channel needs an interval, e.g. ${KLINE_INTERVALS.slice(0, 3).join('/')} or market_kline_15min`);
  const interval = KLINE_INTERVALS.includes(raw) ? raw : (KLINE_INTERVAL_ALIASES[raw] || KLINE_INTERVAL_ALIASES[raw.toLowerCase()] || '');
  if (!interval) throw new Error(`unsupported kline interval "${raw}"; expected one of ${KLINE_INTERVALS.join(', ')}`);
  return interval;
}

/**
 * Turn a caller friendly channel description into the exact args object Bitunix
 * expects ({ ch, symbol }). Throws instead of subscribing to a channel the
 * server would quietly ignore.
 */
export function normalizePublicChannel(channel) {
  const input = typeof channel === 'string' ? { ch: channel } : (channel && typeof channel === 'object' ? channel : null);
  const raw = String(input?.ch ?? '').trim();
  if (!raw) throw new Error('public WS channel must be a channel name or an object with a ch field');
  const lower = raw.toLowerCase();
  const symbol = input.symbol === undefined || input.symbol === null || input.symbol === '' ? undefined : String(input.symbol);
  if (lower === 'kline') {
    return { ...(symbol ? { symbol } : {}), ch: `market_kline_${normalizeKlineInterval(input.interval)}` };
  }
  const kline = KLINE_CHANNEL_RE.exec(raw);
  if (kline) return { ...(symbol ? { symbol } : {}), ch: `${kline[1].toLowerCase()}_kline_${normalizeKlineInterval(kline[2])}` };
  const resolved = PUBLIC_CHANNELS.includes(lower) ? lower : PUBLIC_CHANNEL_ALIASES[lower];
  if (!resolved) {
    throw new Error(`unknown public WS channel "${raw}"; expected ${PUBLIC_CHANNELS.join(', ')} or market_kline_<interval>`);
  }
  return { ...(symbol ? { symbol } : {}), ch: resolved };
}

export function normalizePrivateChannel(channel) {
  const raw = String(typeof channel === 'string' ? channel : channel?.ch ?? '').trim();
  const lower = raw.toLowerCase();
  const resolved = PRIVATE_CHANNELS.includes(lower) ? lower : PRIVATE_CHANNEL_ALIASES[lower];
  if (!resolved) throw new Error(`unknown private WS channel "${raw}"; expected ${PRIVATE_CHANNELS.join(', ')}`);
  return resolved;
}

// WS login signature (NOT the REST one in client.js, which also folds in the
// canonical query string and body): sign = sha256(sha256(nonce + timestamp +
// apiKey) + secretKey) with NO sorted key/value blob appended.
// https://www.bitunix.com/api-docs/futures/websocket/prepare/WebSocket.html
function signWs(params, secret) {
  const digest = crypto.createHash('sha256').update(`${params.nonce}${params.timestamp}${params.apiKey}`).digest('hex');
  return crypto.createHash('sha256').update(digest + secret).digest('hex');
}


export class BitunixWs {
  constructor({ onPublic = () => {}, onPrivate = () => {}, onError = () => {} } = {}, WebSocketImpl = WebSocket) {
    this.onPublic = onPublic;
    this.onPrivate = onPrivate;
    this.onError = onError;
    this.WebSocketImpl = WebSocketImpl;
    this.publicWs = null;
    this.privateWs = null;
    this.publicReconnectTimer = null;
    this.privateReconnectTimer = null;
    this.publicPingTimer = null;
    this.privatePingTimer = null;
    this.stopped = true;
  }

  connectPublic(channels = [{ ch: 'tickers', symbol: CONFIG.symbol }]) {
    const args = (Array.isArray(channels) ? channels : [channels]).map(normalizePublicChannel);
    if (!args.length) throw new Error('connectPublic needs at least one channel');
    return this.#connect(CONFIG.BITUNIX_WS_PUBLIC, args, this.onPublic, () => this.connectPublic(channels), { pingTimer: 'publicPingTimer', socketKey: 'publicWs', reconnectTimer: 'publicReconnectTimer' });
  }

  connectPrivate(channels = PRIVATE_CHANNELS) {
    const requested = (Array.isArray(channels) ? channels : [channels]).map(normalizePrivateChannel);
    if (!requested.length) throw new Error('connectPrivate needs at least one channel');
    if (!CONFIG.BITUNIX_API_KEY || !CONFIG.BITUNIX_API_SECRET) throw new Error('private WS requires BITUNIX_API_KEY and BITUNIX_API_SECRET');
    const args = requested.map(ch => ({ ch }));
    return this.#connect(CONFIG.BITUNIX_WS_PRIVATE, args, this.onPrivate, () => this.connectPrivate(channels), { login: true, pingTimer: 'privatePingTimer', socketKey: 'privateWs', reconnectTimer: 'privateReconnectTimer' });
  }

  /** Subscribe extra channels on a live socket; returns the sent payload. */
  subscribePublic(channels) {
    const args = (Array.isArray(channels) ? channels : [channels]).map(normalizePublicChannel);
    return this.#send(this.publicWs, { op: 'subscribe', args }, 'public');
  }

  /** Docs require an unsubscribe before switching kline intervals on one socket. */
  unsubscribePublic(channels) {
    const args = (Array.isArray(channels) ? channels : [channels]).map(normalizePublicChannel);
    return this.#send(this.publicWs, { op: 'unsubscribe', args }, 'public');
  }

  subscribePrivate(channels) {
    const args = (Array.isArray(channels) ? channels : [channels]).map(normalizePrivateChannel).map(ch => ({ ch }));
    return this.#send(this.privateWs, { op: 'subscribe', args }, 'private');
  }

  #send(socket, payload, label = '') {
    if (!this.#isOpen(socket)) throw new Error(`${label} WebSocket is not connected`);
    socket.send(JSON.stringify(payload));
    return payload;
  }

  #isOpen(socket) {
    const open = this.WebSocketImpl?.OPEN ?? 1;
    return !!socket && socket.readyState === open;
  }

  #clearTimer(key) {
    if (this[key]) clearInterval(this[key]);
    this[key] = null;
  }

  /**
   * The server allows 5 messages/sec and drops idle sockets, so a periodic ping
   * frame ({ op: 'ping', ping: <unix seconds> }) keeps the connection alive; the
   * server answers with { op: 'ping', pong, ping } which is filtered out.
   */
  #startPing(socketKey, timerKey, pingIntervalMs) {
    this.#clearTimer(timerKey);
    this[timerKey] = setInterval(() => {
      const socket = this[socketKey];
      if (!this.#isOpen(socket)) return;
      try { socket.send(JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) })); } catch {}
    }, pingIntervalMs);
    this[timerKey].unref?.();
  }

  #connect(url, args, handler, reconnect, { login = false, pingTimer, socketKey, reconnectTimer, pingIntervalMs = WS_PING_INTERVAL_MS } = {}) {
    this.stopped = false;
    if (this[reconnectTimer]) clearTimeout(this[reconnectTimer]);
    this[reconnectTimer] = null;
    const previous = this[socketKey];
    this[socketKey] = null;
    try { previous?.close(); } catch {}
    const socket = new this.WebSocketImpl(url);
    this[socketKey] = socket;
    socket.on('open', () => {
      if (this[socketKey] !== socket || this.stopped) return;
      try {
        if (login) {
          const nonce = crypto.randomBytes(16).toString('hex');
          // Docs type the login timestamp as Int Unix seconds; the signature is
          // sha256(sha256(nonce + timestamp + apiKey) + secretKey) over the exact
          // values that get sent.
          // https://www.bitunix.com/api-docs/futures/websocket/prepare/WebSocket.html
          const timestamp = Math.floor(Date.now() / 1000);
          const base = { apiKey: CONFIG.BITUNIX_API_KEY, nonce, timestamp };
          const sign = signWs(base, CONFIG.BITUNIX_API_SECRET);
          socket.send(JSON.stringify({ op: 'login', args: [{ ...base, sign }] }));
        }
        socket.send(JSON.stringify({ op: 'subscribe', args }));
      } catch (error) {
        try { socket.close(); } catch {}
        this.onError(error);
        return;
      }
      this.#startPing(socketKey, pingTimer, pingIntervalMs);
    });
    socket.on('message', raw => {
      if (this[socketKey] !== socket) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      // Keep-alive answers and the connect ack carry no channel data.
      if (message?.op === 'ping' || message?.op === 'connect') return;
      try { handler(message); } catch (error) { this.onError(error); }
    });
    socket.on('close', () => {
      if (this[socketKey] !== socket) return;
      this[socketKey] = null;
      this.#clearTimer(pingTimer);
      if (!this.stopped) this[reconnectTimer] = setTimeout(reconnect, 5000);
    });
    socket.on('error', error => this.onError(error));
    return socket;
  }

  close() {
    this.stopped = true;
    for (const key of ['publicReconnectTimer', 'privateReconnectTimer']) {
      if (this[key]) clearTimeout(this[key]);
      this[key] = null;
    }
    this.#clearTimer('publicPingTimer');
    this.#clearTimer('privatePingTimer');
    const publicSocket = this.publicWs;
    const privateSocket = this.privateWs;
    this.publicWs = null;
    this.privateWs = null;
    try { publicSocket?.close(); } catch {}
    try { privateSocket?.close(); } catch {}
  }
}
