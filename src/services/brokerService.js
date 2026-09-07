import axios from 'axios';
// The underlying npm package is Zerodha's official "kiteconnect" SDK - that dependency name
// comes from the published package and can't be renamed without forking it. Everywhere else
// in this codebase (classes, variables, logs, routes, env vars, UI copy) uses generic
// "broker" / "market data" language instead, so the import is aliased immediately below.
import { KiteConnect as BrokerClient, KiteTicker as BrokerFeed } from 'kiteconnect';
import { env, hasApiCredentials, hasAccessToken, isExplicitDemoMode } from '../config/env.js';
import { DemoMarket } from './demoMarket.js';
import { AppError, normalizeExternalError } from '../utils/errors.js';

// This is the live host for the upstream broker's REST API. It's a real network address
// required for requests to succeed, so it stays as-is even though everything else is rebranded.
const BROKER_API_BASE = 'https://api.kite.trade';

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
// Order-writing endpoints (place/modify/cancel/GTT) get their own, more conservative gate -
// separate from the read-only quote/historical gates above - since these calls can move real
// money and the upstream API enforces its own stricter throttling on this class of request.
const orderGate = new RateGate(250);

export class MarketService {
  constructor() {
    this.client = hasApiCredentials() ? new BrokerClient({ api_key: env.apiKey }) : null;
    this.demo = new DemoMarket();
    this.live = false;
    this.mode = isExplicitDemoMode() ? 'demo' : 'not-configured';
    this.authenticated = false;
    this.authError = null;
    this.authErrorCode = null;
    this.authErrorHint = null;
    this.authErrorRetryable = false;
    this.feeds = [];
    this.feedTokens = new Map();
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
    this.lastAuthAttemptAt = null;
    this.lastAuthSuccessAt = null;
    this.watchdogTimer = null;
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
      // This exact header name/value is mandated by the upstream broker's REST API contract
      // (it selects the API version); the request is rejected without it, so it can't be renamed.
      'X-Kite-Version': '3',
      Authorization: `token ${env.apiKey}:${env.accessToken}`,
    };
  }

  async validateAccessToken() {
    if (!hasAccessToken() || !this.client) throw new Error('Broker API key/access token is not configured.');
    this.client.setAccessToken(env.accessToken);
    const profile = await this.client.getProfile();
    this.authenticated = true;
    this.authError = null;
    this.authErrorCode = null;
    this.authErrorHint = null;
    this.lastAuthSuccessAt = Date.now();
    return profile;
  }

  /**
   * Retries validateAccessToken a few times with short backoff, but ONLY for errors flagged
   * as `retryable` (transient network/upstream-general issues). An expired/incorrect token
   * (TOKEN_EXPIRED) is never retried here - retrying it cannot succeed, since it requires a
   * fresh interactive login, and hammering the broker's auth endpoint with a known-bad token
   * is exactly the kind of behaviour that gets rate-limited or flagged.
   */
  async validateAccessTokenWithRetry(maxAttempts = 3) {
    let lastNormalized;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.validateAccessToken();
      } catch (error) {
        lastNormalized = normalizeExternalError(error);
        if (!lastNormalized.details?.retryable || attempt === maxAttempts) throw lastNormalized;
        await sleep(400 * attempt);
      }
    }
    throw lastNormalized;
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

    this.lastAuthAttemptAt = Date.now();
    try {
      await this.validateAccessTokenWithRetry();
      this.live = true;
      this.mode = 'live';
      this.fallbackActive = false;
      this.authErrorRetryable = false;
      this.clearWatchdog();
      this.emitStatus({ ...this.status(), authenticated: true, error: null });
      this.startFeeds();
    } catch (normalized) {
      // normalizeExternalError already ran inside validateAccessTokenWithRetry's catch path,
      // but a non-network throw (e.g. missing credentials) reaches here unnormalized.
      const err = normalized?.code ? normalized : normalizeExternalError(normalized);
      this.live = false;
      this.authenticated = false;
      this.mode = 'auth-error';
      this.authError = err.message;
      this.authErrorCode = err.code || 'UPSTREAM_ERROR';
      this.authErrorHint = err.details?.hint || null;
      this.authErrorRetryable = Boolean(err.details?.retryable);
      this.emitStatus({
        ...this.status(),
        connected: false,
        authenticated: false,
        error: err.message,
        errorCode: this.authErrorCode,
        errorHint: this.authErrorHint,
        requiresLogin: !this.authErrorRetryable,
      });
      if (env.demoFallback) this.startDemo(`Broker authentication failed: ${err.message}`);
      // Only schedule an automatic silent retry for genuinely transient failures (network
      // blips, upstream 5xx). A rejected/expired token is never auto-retried - see the retry
      // helper above for why.
      if (this.authErrorRetryable) this.scheduleWatchdog();
    }
  }

  scheduleWatchdog(delayMs = 5 * 60 * 1000) {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this.mode === 'auth-error' && this.authErrorRetryable) this.start();
    }, delayMs);
    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }
  clearWatchdog() {
    if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  startFeeds() {
    this.stopFeeds();
    const initial = [...this.subscriptions].slice(0, MAX_LIVE);
    const chunks = [];
    for (let i = 0; i < initial.length; i += MAX_PER_SOCKET) chunks.push(initial.slice(i, i + MAX_PER_SOCKET));
    if (!chunks.length) chunks.push([]);

    chunks.slice(0, MAX_SOCKETS).forEach((tokens, index) => {
      const feed = new BrokerFeed({ api_key: env.apiKey, access_token: env.accessToken });
      feed.autoReconnect(true, 10, 5);
      feed.on('connect', () => {
        this.connectedSockets += 1;
        this.connected = true;
        this.mode = 'live';
        this.feedTokens.set(feed, new Set(tokens));
        if (tokens.length) { feed.subscribe(tokens); feed.setMode(feed.modeLTP, tokens); }
        const focus = tokens.filter((token) => this.focusTokens.has(token));
        if (focus.length) feed.setMode(feed.modeFull, focus);
        this.emitStatus({ ...this.status(), connected: true, reconnecting: false, socketIndex: index + 1 });
      });
      feed.on('ticks', (ticks) => ticks.forEach((tick) => this.acceptTick(tick)));
      feed.on('order_update', (update) => this.emitOrder(update));
      feed.on('disconnect', (error) => {
        this.connectedSockets = Math.max(0, this.connectedSockets - 1);
        this.connected = this.connectedSockets > 0;
        this.emitStatus({ ...this.status(), reconnecting: true, error: error?.message || 'Live market feed disconnected' });
      });
      feed.on('error', (error) => this.emitStatus({ ...this.status(), reconnecting: true, error: error?.message || 'Live market feed error' }));
      feed.on('reconnect', (count, interval) => this.emitStatus({ ...this.status(), connected: false, reconnecting: true, attempt: count, interval }));
      feed.on('noreconnect', () => this.emitStatus({ ...this.status(), reconnecting: false, error: 'Live market feed exhausted its reconnect attempts.' }));
      this.feeds.push(feed);
    });
    this.feeds.forEach((feed) => feed.connect());
  }

  startDemo(reason = null) {
    this.stopFeeds();
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

  stopFeeds() {
    for (const feed of this.feeds) { try { feed.disconnect(); } catch {} }
    this.feeds = [];
    this.feedTokens = new Map();
    this.connectedSockets = 0;
  }

  acceptTick(tick) {
    this.lastTickAt = Date.now();
    this.quoteCache.set(Number(tick.instrument_token), { ...tick, cachedAt: Date.now() });
    for (const fn of this.tickHandlers) fn(tick);
  }

  async historical({ token, from, to, interval = 'minute', continuous = false, oi = false }) {
    if (!this.live || !this.client) {
      if (env.demoFallback || this.mode === 'demo') return this.demo.getHistorical(token, 2);
      throw new AppError('Live broker session is not connected. Historical data is unavailable.', 503, 'BROKER_NOT_CONNECTED');
    }
    return historicalGate.run(async () => {
      try {
        const response = await this.client.getHistoricalData(
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

  /**
   * mode: 'full' | 'ohlc' | 'ltp' - mirrors the three quote depths the upstream API offers.
   */
  async quoteByKeys(keys, { mode = 'full' } = {}) {
    const clean = [...new Set(keys.map((x) => String(x).trim()).filter(Boolean))];
    if (!clean.length) return {};
    if (!this.live || !this.client) {
      const result = {};
      for (const item of clean) result[item] = { last_price: 0, instrument_token: null, fallback: true };
      return result;
    }
    return quoteGate.run(async () => {
      const endpoint = mode === 'ltp' ? '/quote/ltp' : mode === 'ohlc' ? '/quote/ohlc' : '/quote';
      try {
        const response = await axios.get(`${BROKER_API_BASE}${endpoint}`, {
          headers: this.headers(),
          paramsSerializer: () => { const p = new URLSearchParams(); clean.forEach((instrument) => p.append('i', instrument)); return p.toString(); },
          timeout: env.brokerRequestTimeoutMs,
        });
        const data = response.data?.data || {};
        for (const [key, value] of Object.entries(data)) if (value?.instrument_token) this.quoteCache.set(Number(value.instrument_token), { ...value, key, cachedAt: Date.now() });
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
    if (!this.live || !this.client) return clean.map((token) => this.quoteCache.get(token) || { instrument_token: token, last_price: 0 });
    const instruments = clean.map((token) => this.tokenToKey(token)).filter(Boolean);
    const chunks = [];
    const size = mode === 'full' ? 500 : 1000;
    for (let i = 0; i < instruments.length; i += size) chunks.push(instruments.slice(i, i + size));
    const out = {};
    for (const chunk of chunks) {
      const data = await this.quoteByKeys(chunk, { mode });
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
    this.feeds.forEach((feed, index) => {
      const desired = new Set(tokens.slice(index * MAX_PER_SOCKET, (index + 1) * MAX_PER_SOCKET));
      const previous = this.feedTokens.get(feed) || new Set();
      const remove = [...previous].filter((t) => !desired.has(t));
      const add = [...desired].filter((t) => !previous.has(t));
      if (remove.length) { try { feed.unsubscribe(remove); } catch {} }
      if (add.length) { try { feed.subscribe(add); feed.setMode(feed.modeLTP, add); } catch {} }
      const focus = [...desired].filter((t) => this.focusTokens.has(t));
      if (focus.length) { try { feed.setMode(feed.modeFull, focus); } catch {} }
      this.feedTokens.set(feed, desired);
    });
  }

  async getProfile() { if (!this.live || !this.client) throw new Error('Broker session is not authenticated.'); return this.client.getProfile(); }
  async getMargins() { if (!this.live || !this.client) return null; return this.client.getMargins(); }
  async getHoldings() { if (!this.live || !this.client) return []; return this.client.getHoldings(); }
  async getPositions() { if (!this.live || !this.client) return { net: [], day: [] }; return this.client.getPositions(); }
  async getOrders() { if (!this.live || !this.client) return []; return this.client.getOrders(); }
  async getTrades() { if (!this.live || !this.client) return []; return this.client.getTrades(); }
  // Good-Till-Triggered orders: read-only listing of standing trigger orders on the account.
  async getGTTs() { if (!this.live || !this.client) return []; return this.client.getGTTs(); }

  // ---------------------------------------------------------------------------------------
  // Order & GTT writes. Every one of these goes through `guardedOrderCall`, which enforces
  // the ORDER_DRY_RUN safety switch (env.orderDryRun) and a conservative rate gate before
  // ever touching the live broker API. In dry-run mode nothing is sent upstream at all - a
  // deterministic simulated response is returned instead, shaped like the real one, so the
  // UI and calling code exercise the exact same path in both modes.
  // ---------------------------------------------------------------------------------------
  async guardedOrderCall(kind, simulate, real) {
    if (!this.live || !this.client) {
      throw new AppError('Broker session is not authenticated. Connect your broker account before placing orders.', 409, 'BROKER_NOT_AUTHENTICATED');
    }
    if (env.orderDryRun) {
      return { dryRun: true, kind, ...simulate() };
    }
    return orderGate.run(async () => {
      try {
        const result = await real();
        return { dryRun: false, kind, ...result };
      } catch (error) {
        const normalized = normalizeExternalError(error);
        if (normalized.code === 'TOKEN_EXPIRED') this.handleTokenExpired(normalized.message);
        throw normalized;
      }
    });
  }

  simulatedOrderId() { return `DRYRUN${Date.now()}${Math.floor(Math.random() * 900 + 100)}`; }

  /**
   * params mirrors the upstream placeOrder payload: variety, exchange, tradingsymbol,
   * transaction_type (BUY/SELL), quantity, product (CNC/MIS/NRML), order_type
   * (MARKET/LIMIT/SL/SL-M), price, trigger_price, validity, tag.
   */
  async placeOrder(params) {
    const variety = params.variety || 'regular';
    return this.guardedOrderCall(
      'place_order',
      () => ({ order_id: this.simulatedOrderId(), status: 'SIMULATED', message: 'Dry-run: no order was sent to the broker.' }),
      () => this.client.placeOrder(variety, params),
    );
  }

  async modifyOrder(orderId, params) {
    const variety = params.variety || 'regular';
    return this.guardedOrderCall(
      'modify_order',
      () => ({ order_id: orderId, status: 'SIMULATED', message: 'Dry-run: no modification was sent to the broker.' }),
      () => this.client.modifyOrder(variety, orderId, params),
    );
  }

  async cancelOrder(orderId, variety = 'regular') {
    return this.guardedOrderCall(
      'cancel_order',
      () => ({ order_id: orderId, status: 'SIMULATED', message: 'Dry-run: no cancellation was sent to the broker.' }),
      () => this.client.cancelOrder(variety, orderId),
    );
  }

  async getOrderHistory(orderId) {
    if (!this.live || !this.client) return [];
    return this.client.getOrderHistory(orderId);
  }

  async getOrderTrades(orderId) {
    if (!this.live || !this.client) return [];
    return this.client.getOrderTrades(orderId);
  }

  /**
   * Order margin calculator - reports the margin the exchange would block for a proposed
   * (not-yet-placed) order, so the UI can show "this will require ₹X" before the person
   * commits. Always a real, live-quoted read against the upstream API when connected;
   * there's no meaningful "simulate" version of a margin quote.
   */
  async getOrderMargins(orders) {
    if (!this.live || !this.client) {
      throw new AppError('Broker session is not authenticated. Connect your broker account to calculate margins.', 409, 'BROKER_NOT_AUTHENTICATED');
    }
    return orderGate.run(async () => {
      try {
        return await this.client.orderMargins(orders);
      } catch (error) {
        throw normalizeExternalError(error);
      }
    });
  }

  /**
   * condition: { exchange, tradingsymbol, trigger_values, last_price }
   * gttOrders: [{ transaction_type, quantity, order_type, product, price }]
   * type: 'single' | 'two-leg' (OCO)
   */
  async placeGTT({ type = 'single', condition, orders }) {
    return this.guardedOrderCall(
      'place_gtt',
      () => ({ trigger_id: Math.floor(Date.now() / 1000), status: 'SIMULATED', message: 'Dry-run: no GTT was created on the broker.' }),
      () => this.client.placeGTT({ trigger_type: type, tradingsymbol: condition.tradingsymbol, exchange: condition.exchange, trigger_values: condition.trigger_values, last_price: condition.last_price, orders }),
    );
  }

  async modifyGTT(triggerId, { type = 'single', condition, orders }) {
    return this.guardedOrderCall(
      'modify_gtt',
      () => ({ trigger_id: triggerId, status: 'SIMULATED', message: 'Dry-run: no GTT modification was sent to the broker.' }),
      () => this.client.modifyGTT(triggerId, { trigger_type: type, tradingsymbol: condition.tradingsymbol, exchange: condition.exchange, trigger_values: condition.trigger_values, last_price: condition.last_price, orders }),
    );
  }

  async deleteGTT(triggerId) {
    return this.guardedOrderCall(
      'delete_gtt',
      () => ({ trigger_id: triggerId, status: 'SIMULATED', message: 'Dry-run: no GTT deletion was sent to the broker.' }),
      () => this.client.deleteGTT(triggerId),
    );
  }

  handleTokenExpired(message) {
    this.authenticated = false;
    this.live = false;
    this.connected = false;
    this.mode = 'auth-error';
    this.authError = message || 'Broker access token expired or was invalidated.';
    this.authErrorCode = 'TOKEN_EXPIRED';
    this.authErrorHint = 'Zerodha invalidates every access token once a day (around 6 AM IST). Click "Reconnect broker account" to get a fresh one - this is expected daily behaviour, not a bug.';
    this.authErrorRetryable = false;
    this.clearWatchdog();
    this.stopFeeds();
    this.emitStatus({ ...this.status(), connected: false, authenticated: false, requiresLogin: true, error: this.authError, errorCode: this.authErrorCode, errorHint: this.authErrorHint });
  }

  setUniverseSize(size) { this.universeSize = Number(size) || 0; }
  status() {
    return {
      mode: this.fallbackActive ? 'demo-fallback' : this.mode,
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
      authErrorCode: this.authErrorCode,
      authErrorHint: this.authErrorHint,
      authErrorRetryable: this.authErrorRetryable,
      lastAuthAttemptAt: this.lastAuthAttemptAt,
      lastAuthSuccessAt: this.lastAuthSuccessAt,
      credentialsPresent: hasAccessToken(),
      orderDryRun: env.orderDryRun,
    };
  }
}

export const market = new MarketService();
