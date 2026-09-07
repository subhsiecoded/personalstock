# Subh's stock dashboard - hardened Kite backend

Production-oriented local backend for a React market terminal using Zerodha Kite Connect v3.

## Architecture

- Node.js + Express 5
- Kite Connect JavaScript SDK
- KiteTicker WebSockets
- Native `fetch` for high-throughput REST market requests
- In-memory quote cache
- Complete Kite instrument master cache with O(1) token/symbol lookup
- Server-side encrypted daily session token storage (AES-256-GCM)
- Strict CORS allow-list
- Helmet security headers
- Request IDs and structured error responses
- Global/auth rate limiting
- HTTP timeouts and graceful shutdown
- Socket.IO client-level tick filtering
- WebSocket reconnect handling
- Kite quote/historical rate gates
- Demo mode only when explicitly enabled

## Security model

Never commit `.env`, API secrets, access tokens, or `.kite-session.enc`.

Recommended `.env`:

```env
HOST=127.0.0.1
PORT=5000
FRONTEND_URL=http://localhost:5173

KITE_API_KEY=YOUR_API_KEY
KITE_API_SECRET=YOUR_API_SECRET
KITE_REDIRECT_URL=http://localhost:5000/api/kite/callback

MARKET_MODE=auto
DEFAULT_EXCHANGE=NSE
INSTRUMENT_CACHE_TTL_MS=21600000
KITE_REQUEST_TIMEOUT_MS=12000
KITE_QUOTE_MIN_INTERVAL_MS=1050
KITE_HISTORICAL_MIN_INTERVAL_MS=360
DEMO_FALLBACK=false

# Generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
KITE_TOKEN_ENCRYPTION_KEY=64_HEX_CHAR_KEY
```

The encrypted token file is created at `backend/data/.kite-session.enc` only when `KITE_TOKEN_ENCRYPTION_KEY` is configured. Without the encryption key, the fresh access token is memory-only and disappears on restart, which is safer than silently writing plaintext tokens.

## Kite login

1. Register exactly `http://localhost:5000/api/kite/callback` in the Kite Connect developer console.
2. Start the backend:

```bash
npm install
npm run dev
```

3. Open:

```text
http://localhost:5000/api/kite/login
```

4. Complete Zerodha login/2FA.
5. Kite redirects to `/api/kite/callback` with a one-time `request_token`.
6. The backend calls `generateSession(request_token, api_secret)`, stores the resulting daily access token encrypted, validates the profile, and starts KiteTicker.

## Diagnostics

```bash
npm run check:live
```

The command never prints the actual key/secret/token.

## Useful endpoints

- `GET /api/health`
- `GET /api/ready`
- `GET /api/auth/status`
- `GET /api/kite/login`
- `GET /api/kite/callback`
- `POST /api/auth/revalidate`
- `POST /api/auth/logout`
- `GET /api/market/search?q=RELIANCE`
- `GET /api/market/universe`
- `GET /api/market/universe/stats`
- `GET /api/market/quote?i=NSE:RELIANCE`
- `GET /api/market/quote/ohlc?i=NSE:RELIANCE`
- `GET /api/market/quote/ltp?i=NSE:RELIANCE`
- `GET /api/market/historical/:token?interval=minute&days=2`

## Live feed limits

The service caps live subscriptions at 3,000 instruments per WebSocket and three WebSockets per API key (9,000 live instrument capacity). The application keeps the complete Kite instrument universe searchable independently from the live-stream subscription set.

## Performance choices

- Instrument token -> exchange:symbol is indexed with Maps instead of scanning 108k+ rows.
- REST quote batches use Kite's documented request sizes.
- Quote/historical requests are serialized through rate gates instead of burst polling.
- WebSocket ticks are filtered per client so one user's 2,000-token subscription is not broadcast to every connected browser.
- Only focused instruments are promoted to full-mode depth; broad subscriptions use LTP mode.
- Instrument downloads are written atomically to the local cache.

## Important

The backend intentionally does not expose `KITE_API_SECRET` or `KITE_ACCESS_TOKEN` to the React browser. For a public deployment, put this behind HTTPS, an authenticated reverse proxy, and a server-side identity/session layer rather than exposing the raw local API directly.
