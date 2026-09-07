import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '../..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');
const backendEnv = path.join(BACKEND_DIR, '.env');
const rootEnv = path.join(ROOT_DIR, '.env');

// Load root first, then backend with override=true so backend/.env is authoritative.
const rootLoad = fs.existsSync(rootEnv)
  ? dotenv.config({ path: rootEnv })
  : { parsed: undefined };

const backendLoad = fs.existsSync(backendEnv)
  ? dotenv.config({ path: backendEnv, override: true })
  : { parsed: undefined };

const clean = (value) => String(value ?? '').trim();
const bool = (value, fallback = false) =>
  value == null
    ? fallback
    : ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());

export const env = {
  port: Number(process.env.PORT || 5000),
  frontendUrl: clean(process.env.FRONTEND_URL || 'http://localhost:5173'),
  apiKey: clean(process.env.BROKER_API_KEY),
  apiSecret: clean(process.env.BROKER_API_SECRET),
  accessToken: clean(process.env.BROKER_ACCESS_TOKEN),
  mode: clean(process.env.MARKET_MODE || 'auto').toLowerCase(),
  defaultExchange: clean(process.env.DEFAULT_EXCHANGE || 'NSE').toUpperCase(),
  instrumentCacheTtlMs: Number(process.env.INSTRUMENT_CACHE_TTL_MS || 21600000),
  brokerRequestTimeoutMs: Number(process.env.BROKER_REQUEST_TIMEOUT_MS || 20000),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  demoFallback: bool(process.env.DEMO_FALLBACK, false),
  // Safety default: real order/GTT placement is simulated (no live API call) unless this is
  // explicitly set to false. This exists so a fresh checkout of this project can never place
  // a real order by accident.
  orderDryRun: bool(process.env.ORDER_DRY_RUN, true),
  // Keep the legacy callback as the default because existing Kite Connect apps
  // commonly have /api/kite/callback registered. /api/auth/callback and
  // /api/broker/callback are also mounted by server.js for compatibility.
  redirectUrl: clean(
    process.env.BROKER_REDIRECT_URL ||
      `http://localhost:${Number(process.env.PORT || 5000)}/api/kite/callback`
  ),
  envFiles: {
    backend: backendEnv,
    root: rootEnv,
    backendExists: fs.existsSync(backendEnv),
    rootExists: fs.existsSync(rootEnv),
    rootLoaded: Boolean(rootLoad?.parsed),
    backendLoaded: Boolean(backendLoad?.parsed),
    source: fs.existsSync(backendEnv)
      ? backendEnv
      : fs.existsSync(rootEnv)
        ? rootEnv
        : 'none',
  },
};

export const hasApiCredentials = () => Boolean(env.apiKey && env.apiSecret);
export const hasAccessToken = () => Boolean(env.apiKey && env.accessToken);
export const credentialsConfigured = () => hasApiCredentials() && hasAccessToken();
export const isExplicitDemoMode = () => env.mode === 'demo';
export const isLiveRequested = () => !isExplicitDemoMode();
