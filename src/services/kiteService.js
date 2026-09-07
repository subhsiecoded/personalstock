import axios from 'axios';
import fs from 'node:fs/promises';
import { KiteConnect, KiteTicker } from 'kiteconnect';
import { env, hasApiCredentials, hasAccessToken, isExplicitDemoMode } from '../config/env.js';
import { DemoMarket } from './demoMarket.js';
import { AppError, normalizeExternalError } from '../utils/errors.js';

const MAX_PER_SOCKET = 3000;
const MAX_SOCKETS = 3;
const MAX_LIVE = MAX_PER_SOCKET * MAX_SOCKETS;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RateGate {
  constructor(minIntervalMs) { this.minIntervalMs = minIntervalMs; this.lastAt = 0; this.queue = Promise.resolve(); }
  run(task) {
    const execute = this.queue.then(async () => {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastAt));
      if (wait) await sleep(wait);
      this.lastAt = Date.now();
      return task();
    });
    this.queue = execute.catch(() => {});
    return execute;
  }
}

const quoteGate = new RateGate(1050);
const historicalGate = new RateGate(360);

export class MarketService {
  constructor() {
    this.kc = hasApiCredentials() ? new KiteConnect({ api_key: env.apiKey }) : null;
    this.demo = new DemoMarket();
    this.live = false;
    this.mode = isExplicitDemoMode() ? 'demo' : 'not-configured';
    this.authenticated = false;
    this.authError = null;
    this.tickers = [];
    this.tickerTokens = new Map();
    this.connectedSockets = 0;
    this.connected = false;
    this.lastTickAt = null;
    this.subscriptions = new Set();
    this.focusTokens = new Set();
    this.tickHandlers = new Set();
    this.statusHandlers = new Set();
    this.orderHandlers = new Set();
    this.lastError = null;
    this.fallbackActive = false;
    this.universeSize = 0;
    this.quoteCache = new Map();
  }

  onTick(handler) { this.tickHandlers.add(handler); return () => this.tickHandlers.delete(handler); }
  onStatus(handler) { this.statusHandlers.add(handler); return () => this.statusHandlers.delete(handler); }
  onOrder(handler) { this.orderHandlers.add(handler); return () => this.orderHandlers.delete(handler); }
  emitStatus(payload) {
    if (payload?.error) this.lastError = payload.error;
    for (const fn of this.statusHandlers) fn(payload);
  }
  emitOrder(update) { for (const fn of this.orderHandlers) fn(update); }

  headers() {
    return {
      'X-Kite-Version': '3',
      Authorization: `token ${env.apiKey}:${env.accessToken}`,
    };
  }

  async validateAccessToken() {
    if (!hasAccessToken() || !this.kc) throw new Error('Kite API key/access token is not configured.');
    this.kc.setAccessToken(env.accessToken);
    const profile = await this.kc.getProfile();
    this.authenticated = true;
    this.authError = null;
    return profile;
  }

  async start() {
    if (isExplicitDemoMode()) { this.startDemo(); return; }
    if (!hasApiCredentials() || !hasAccessToken()) {
      this.mode = 'not-configured';
      this.connected = false;
      this.emitStatus(this.status());
      if (env.demoFallback) this.startDemo('Live credentials are not configured. Demo fallback was explicitly enabled.');
      return;
    }

    try {
      await this.validateAccessToken();
      this.live = true;
      this.mode = 'live';
      this.fallbackActive = false;
      this.emitStatus({ ...this.status(), authenticated: true, error: null });
      this.startTickers();
    } catch (error) {
      const normalized = normalizeExternalError(error);
      this.live = false;
      this.authenticated = false;
      this.mode = 'auth-error';
      this.authError = normalized.message;
      this.emitStatus({ ...this.status(), connected: false, authenticated: false, error: normalized.message, requiresLogin: true });
      if (env.demoFallback) this.startDemo(`Kite authentication failed: ${normalized.message}`);
    }
  }

  startTickers() {
    this.stopTickers();
    const initial = [...this.subscriptions].slice(0, MAX_LIVE);
    const chunks = [];
    for (let i = 0; i < initial.length; i += MAX_PER_SOCKET) chunks.push(initial.slice(i, i + MAX_PER_SOCKET));
    if (!chunks.length) chunks.push([]);

    chunks.slice(0, MAX_SOCKETS).forEach((tokens, index) => {
      const ticker = new KiteTicker({ api_key: env.apiKey, access_token: env.accessToken });
      ticker.autoReconnect(true, 10, 5);
      ticker.on('connect', () => {
        this.connectedSockets += 1;
        this.connected = true;
        this.mode = 'live';
        this.tickerTokens.set(ticker, new Set(tokens));
        if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeLTP, tokens); }
        const focus = tokens.filter((token) => this.focusTokens.has(token));
        if (focus.length) ticker.setMode(ticker.modeFull, focus);
        this.emitStatus({ ...this.status(), connected: true, reconnecting: false, socketIndex: index + 1 });
      });
      ticker.on('ticks', (ticks) => ticks.forEach((tick) => this.acceptTick(tick)));
      ticker.on('order_update', (update) => this.emitOrder(update));
      ticker.on('disconnect', (error) => {
        this.connectedSockets = Math.max(0, this.connectedSockets - 1);
        this.connected = this.connectedSockets > 0;
        this.emitStatus({ ...this.status(), reconnecting: true, error: error?.message || 'Kite WebSocket disconnected' });
      });
      ticker.on('error', (error) => this.emitStatus({ ...this.status(), reconnecting: true, error: error?.message || 'Kite WebSocket error' }));
      ticker.on('reconnect', (count, interval) => this.emitStatus({ ...this.status(), connected: false, reconnecting: true, attempt: count, interval }));
      ticker.on('noreconnect', () => this.emitStatus({ ...this.status(), reconnecting: false, error: 'Kite WebSocket exhausted its reconnect attempts.' }));
      this.tickers.push(ticker);
    });
    this.tickers.forEach((ticker) => ticker.connect());
  }

  startDemo(reason = null) {
    this.stopTickers();
    this.fallbackActive = Boolean(reason);
    this.live = false;
    this.authenticated = false;
    this.mode = reason ? 'demo-fallback' : 'demo';
    this.connected = false;
    this.demo.removeAllListeners('tick');
    this.demo.removeAllListeners('status');
    this.demo.on('tick', (tick) => this.acceptTick(tick));
    this.demo.on('status', (status) => this.emitStatus({ ...status, mode: this.mode, fallback: this.fallbackActive, error: reason || undefined }));
    this.demo.start();
    this.connected = true;
    this.emitStatus({ ...this.status(), connected: true, error: reason || null });
  }

  stopTickers() {
    for (const ticker of this.tickers) { try { ticker.disconnect(); } catch {} }
    this.tickers = [];
    this.tickerTokens = new Map();
    this.connectedSockets = 0;
  }

  acceptTick(tick) {
    this.lastTickAt = Date.now();
    this.quoteCache.set(Number(tick.instrument_token), { ...tick, cachedAt: Date.now() });
    for (const fn of this.tickHandlers) fn(tick);
  }

  async historical({ token, from, to, interval = 'minute', continuous = false, oi = false }) {
    if (!this.live || !this.kc) {
      if (env.demoFallback || this.mode === 'demo') return this.demo.getHistorical(token, 2);
      throw new AppError('Kite live session is not connected. Historical data is unavailable.', 503, 'KITE_NOT_CONNECTED');
    }
    return historicalGate.run(async () => {
      try {
        const response = await this.kc.getHistoricalData(
          Number(token),
          interval,
          from,
          to,
          Boolean(continuous),
          Boolean(oi),
        );

        const candles = Array.isArray(response)
          ? response
          : Array.isArray(response?.data?.candles)
            ? response.data.candles
            : Array.isArray(response?.data)
              ? response.data
              : [];

        return candles
          .map((row) => {
            if (Array.isArray(row)) {
              return {
                time: Math.floor(new Date(row[0]).getTime() / 1000),
                open: Number(row[1]),
                high: Number(row[2]),
                low: Number(row[3]),
                close: Number(row[4]),
                volume: Number(row[5] ?? 0),
                oi: Number(row[6] ?? 0),
              };
            }

            return {
              time: Math.floor(new Date(row?.time || row?.date).getTime() / 1000),
              open: Number(row?.open),
              high: Number(row?.high),
              low: Number(row?.low),
              close: Number(row?.close),
              volume: Number(row?.volume ?? 0),
              oi: Number(row?.oi ?? 0),
            };
          })
          .filter((row) => Number.isFinite(row.time) && [row.open, row.high, row.low, row.close].every(Number.isFinite));
      } catch (error) {
        const normalized = normalizeExternalError(error);
        if (normalized.code === 'TOKEN_EXPIRED') this.handleTokenExpired(normalized.message);
        if (env.demoFallback) return this.demo.getHistorical(token, 2);
        throw normalized;
      }
    });
  }

  async quoteByKeys(keys, { full = true } = {}) {
    const clean = [...new Set(keys.map((x) => String(x).trim()).filter(Boolean))];
    if (!clean.length) return {};
    if (!this.live || !this.kc) {
      const result = {};
      for (const item of clean) result[item] = { last_price: 0, instrument_token: null, fallback: true };
      return result;
    }
    return quoteGate.run(async () => {
      const endpoint = full ? '/quote' : '/quote/ltp';
      try {
        const response = await axios.get(`https://api.kite.trade${endpoint}`, {
          headers: this.headers(),
          paramsSerializer: () => { const p = new URLSearchParams(); clean.forEach((instrument) => p.append('i', instrument)); return p.toString(); },
          timeout: env.kiteRequestTimeoutMs,
        });
        const data = response.data?.data || {};
        for (const [key, value] of Object.entries(data)) this.quoteCache.set(Number(value.instrument_token), { ...value, key, cachedAt: Date.now() });
        return data;
      } catch (error) {
        const normalized = normalizeExternalError(error);
        if (normalized.code === 'TOKEN_EXPIRED') this.handleTokenExpired(normalized.message);
        if (env.demoFallback) return {};
        throw normalized;
      }
    });
  }

  async quoteTokens(tokens, mode = 'ohlc') {
    const clean = [...new Set(tokens.map(Number).filter(Number.isFinite))];
    if (!this.live || !this.kc) return clean.map((token) => this.quoteCache.get(token) || { instrument_token: token, last_price: 0 });
    const instruments = clean.map((token) => this.tokenToKey(token)).filter(Boolean);
    const chunks = [];
    const size = mode === 'full' ? 500 : 1000;
    for (let i = 0; i < instruments.length; i += size) chunks.push(instruments.slice(i, i + size));
    const out = {};
    for (const chunk of chunks) {
      const data = await this.quoteByKeys(chunk, { full: mode === 'full' });
      Object.assign(out, data);
    }
    return out;
  }

  tokenToKey(token) {
    for (const item of this._instrumentLookup || []) if (Number(item.instrument_token) === Number(token)) return `${item.exchange}:${item.tradingsymbol}`;
    return null;
  }
  setInstrumentLookup(items) {
    this._instrumentLookup = Array.isArray(items) ? items : [];
    this.setUniverseSize(this._instrumentLookup.length);
  }

  subscribe(tokens, { focus = false } = {}) {
    const clean = [...new Set(tokens.map(Number).filter(Number.isFinite))];
    const before = new Set(this.subscriptions);
    clean.forEach((token) => this.subscriptions.add(token));
    let overflow = Math.max(0, this.subscriptions.size - MAX_LIVE);
    if (overflow) [...this.subscriptions].slice(MAX_LIVE).forEach((token) => this.subscriptions.delete(token));
    if (!this.live && this.mode !== 'auth-error' && this.mode !== 'not-configured') this.demo.subscribe(clean);
    if (focus) clean.forEach((token) => this.focusTokens.add(token));
    if (this.live && this.connected) this.rebalanceSubscriptions();
    const added = [...this.subscriptions].filter((t) => !before.has(t));
    return { requested: clean.length, subscribed: this.subscriptions.size, capacity: MAX_LIVE, accepted: added.length, overflow, added };
  }

  focus(token) {
    const t = Number(token);
    if (!Number.isFinite(t)) return;
    this.focusTokens.add(t);
    this.subscribe([t]);
    if (this.live && this.connected) this.rebalanceSubscriptions();
  }

  unsubscribe(tokens) {
    const clean = [...new Set(tokens.map(Number).filter(Number.isFinite))];
    clean.forEach((token) => { this.subscriptions.delete(token); this.focusTokens.delete(token); });
    if (this.live && this.connected) this.rebalanceSubscriptions();
  }

  rebalanceSubscriptions() {
    const tokens = [...this.subscriptions].slice(0, MAX_LIVE);
    this.tickers.forEach((ticker, index) => {
      const desired = new Set(tokens.slice(index * MAX_PER_SOCKET, (index + 1) * MAX_PER_SOCKET));
      const previous = this.tickerTokens.get(ticker) || new Set();
      const remove = [...previous].filter((t) => !desired.has(t));
      const add = [...desired].filter((t) => !previous.has(t));
      if (remove.length) { try { ticker.unsubscribe(remove); } catch {} }
      if (add.length) { try { ticker.subscribe(add); ticker.setMode(ticker.modeLTP, add); } catch {} }
      const focus = [...desired].filter((t) => this.focusTokens.has(t));
      if (focus.length) { try { ticker.setMode(ticker.modeFull, focus); } catch {} }
      this.tickerTokens.set(ticker, desired);
    });
  }

  async getProfile() {
    if (!this.live || !this.kc) throw new Error('Kite is not authenticated.');
    return this.kc.getProfile();
  }
  async getMargins() { if (!this.live || !this.kc) return null; return this.kc.getMargins(); }
  async getHoldings() { if (!this.live || !this.kc) return []; return this.kc.getHoldings(); }
  async getPositions() { if (!this.live || !this.kc) return { net: [], day: [] }; return this.kc.getPositions(); }
  async getOrders() { if (!this.live || !this.kc) return []; return this.kc.getOrders(); }
  async getTrades() { if (!this.live || !this.kc) return []; return this.kc.getTrades(); }

  handleTokenExpired(message) {
    this.authenticated = false;
    this.live = false;
    this.connected = false;
    this.mode = 'auth-error';
    this.authError = message || 'Kite access token expired or was invalidated.';
    this.stopTickers();
    this.emitStatus({ ...this.status(), connected: false, authenticated: false, requiresLogin: true, error: this.authError });
  }

  setUniverseSize(size) { this.universeSize = Number(size) || 0; }
  status() {
    const effectiveMode = this.fallbackActive
      ? 'demo-fallback'
      : (this.live && this.authenticated ? 'live' : this.mode);

    return {
      mode: effectiveMode,
      connected: this.connected,
      authenticated: this.authenticated,
      connectedSockets: this.connectedSockets,
      lastTickAt: this.lastTickAt,
      instruments: this.subscriptions.size,
      universeSize: this.universeSize,
      liveCapacity: MAX_LIVE,
      socketsCapacity: MAX_SOCKETS,
      perSocketCapacity: MAX_PER_SOCKET,
      fallback: this.fallbackActive,
      authError: this.authError,
      credentialsPresent: hasAccessToken(),
    };
  }
}

export const market = new MarketService();
