import express from 'express';
import fs from 'node:fs/promises';
import { KiteConnect as BrokerClient } from 'kiteconnect';
import { env } from '../config/env.js';
import { market } from '../services/brokerService.js';
import { hasApiCredentials } from '../config/env.js';
import { asyncHandler, AppError, normalizeExternalError } from '../utils/errors.js';

const router = express.Router();

// Kite request_tokens are single-use. Keep a short-lived local record so a browser
// refresh/double-callback cannot accidentally try to exchange the same token twice.
const exchangedRequestTokens = new Map();
const inFlightExchanges = new Map();
const REQUEST_TOKEN_TTL_MS = 10 * 60 * 1000;

function pruneRequestTokenState() {
  const cutoff = Date.now() - REQUEST_TOKEN_TTL_MS;
  for (const [token, usedAt] of exchangedRequestTokens) {
    if (usedAt < cutoff) exchangedRequestTokens.delete(token);
  }
}

function validateCallbackQuery(req) {
  const requestToken = String(req.query.request_token || '').trim();
  const upstreamStatus = String(req.query.status || '').trim().toLowerCase();
  const action = String(req.query.action || '').trim().toLowerCase();
  const type = String(req.query.type || '').trim().toLowerCase();

  pruneRequestTokenState();

  if (upstreamStatus && upstreamStatus !== 'success') {
    throw new AppError(
      `Broker login was not completed (status: ${upstreamStatus}).`,
      400,
      'BROKER_LOGIN_CANCELLED'
    );
  }

  if (!requestToken) {
    throw new AppError(
      'The broker callback did not include a request_token.',
      400,
      'BROKER_REQUEST_TOKEN_MISSING'
    );
  }

  // Do not over-constrain the broker token format: treat it as an opaque one-time
  // credential, but reject obviously malformed/oversized values.
  if (requestToken.length > 512 || /[\s<>"']/.test(requestToken)) {
    throw new AppError(
      'The broker request_token format is invalid.',
      400,
      'BROKER_REQUEST_TOKEN_INVALID'
    );
  }

  // Kite normally sends action=login&type=login. Validate them when supplied,
  // while keeping the callback compatible with clients that omit either field.
  if (action && action !== 'login') {
    throw new AppError('Unexpected broker callback action.', 400, 'BROKER_CALLBACK_INVALID');
  }
  if (type && type !== 'login') {
    throw new AppError('Unexpected broker callback type.', 400, 'BROKER_CALLBACK_INVALID');
  }

  if (exchangedRequestTokens.has(requestToken)) {
    throw new AppError(
      'This request_token has already been exchanged. Start a new broker login to obtain a fresh request_token.',
      409,
      'BROKER_REQUEST_TOKEN_REPLAY'
    );
  }

  return requestToken;
}

async function exchangeRequestToken(requestToken) {
  if (inFlightExchanges.has(requestToken)) return inFlightExchanges.get(requestToken);

  const promise = (async () => {
    const client = new BrokerClient({ api_key: env.apiKey });
    const session = await client.generateSession(requestToken, env.apiSecret);
    exchangedRequestTokens.set(requestToken, Date.now());
    return session;
  })();

  inFlightExchanges.set(requestToken, promise);
  try {
    return await promise;
  } finally {
    inFlightExchanges.delete(requestToken);
  }
}

async function persistAccessToken(accessToken) {
  const envPath = env.envFiles.backend;
  let content = '';
  try { content = await fs.readFile(envPath, 'utf8'); } catch {}
  const line = /^BROKER_ACCESS_TOKEN=.*$/m;
  content = line.test(content)
    ? content.replace(line, `BROKER_ACCESS_TOKEN=${accessToken}`)
    : `${content.trimEnd()}\nBROKER_ACCESS_TOKEN=${accessToken}\n`;
  await fs.writeFile(envPath, content, 'utf8');
  process.env.BROKER_ACCESS_TOKEN = accessToken;
  env.accessToken = accessToken;
}

function page({ title, heading, body, tone = 'ok' }) {
  const accent = tone === 'error' ? '#c23b41' : '#1f8a52';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#0f1115;color:#eae6da;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
    .card{max-width:440px;border:1px solid #2a2d35;border-radius:14px;padding:32px;background:#15171d}
    h1{font-size:20px;margin:0 0 12px;color:${accent}}
    p{font-size:13px;line-height:1.7;color:#a9a49a;margin:0 0 10px}
    a{color:#d6b256}
  </style></head>
  <body><div class="card"><h1>${heading}</h1>${body}</div></body></html>`;
}

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    data: {
      ...market.status(),
      apiKeyPresent: Boolean(env.apiKey),
      apiSecretPresent: Boolean(env.apiSecret),
      accessTokenPresent: Boolean(env.accessToken),
      redirectUrl: env.redirectUrl,
      supportedCallbackPaths: ['/api/kite/callback', '/api/broker/callback', '/api/auth/callback'],
      requestTokenFlow: 'A new request_token is issued by the broker for every interactive login and is exchanged server-side for a daily access_token.',
    },
  });
});

router.get('/login', (_req, res) => {
  if (!hasApiCredentials()) throw new AppError('Broker API key and API secret are required before login.', 400, 'BROKER_CREDENTIALS_MISSING');
  const client = new BrokerClient({ api_key: env.apiKey });
  res.redirect(client.getLoginURL());
});

router.get('/callback', async (req, res) => {
  let requestToken;

  try {
    requestToken = validateCallbackQuery(req);
  } catch (error) {
    const status = Number(error?.status || 400);
    const code = error?.code || 'BROKER_CALLBACK_INVALID';
    const message = error?.message || 'The broker callback could not be validated.';
    const replay = code === 'BROKER_REQUEST_TOKEN_REPLAY';
    return res.status(status).send(page({
      title: 'Broker login error',
      heading: replay ? 'Request token already used' : 'Broker callback rejected',
      tone: 'error',
      body: `<p>${message}</p><p>Use <a href="/api/auth/login">Connect broker account</a> to start a new login and receive a fresh request_token.</p>`,
    }));
  }

  if (!hasApiCredentials()) {
    return res.status(400).send(page({
      title: 'Broker login error',
      heading: 'Credentials not configured',
      tone: 'error',
      body: `<p>BROKER_API_KEY / BROKER_API_SECRET are missing on the server. Set them in backend/.env and restart the backend, then try again.</p>`,
    }));
  }

  try {
    const session = await exchangeRequestToken(requestToken);
    if (!session?.access_token) {
      throw new AppError('The broker did not return an access token.', 502, 'BROKER_ACCESS_TOKEN_MISSING');
    }
    await persistAccessToken(session.access_token);
    await market.start();

    const redirectTarget = env.frontendUrl;
    res.send(page({
      title: "Subh's stock dashboard",
      heading: 'Broker session connected',
      tone: 'ok',
      body: `<p>Your access token was saved and the live market feed is starting. This tab will close automatically.</p><p>If it doesn't, <a href="${redirectTarget}">return to the dashboard</a> manually - it updates live, no refresh needed.</p>
      <script>setTimeout(function(){ try { window.opener && window.close(); } catch(e){} location.href = ${JSON.stringify(redirectTarget)}; }, 1600);</script>`,
    }));
  } catch (error) {
    const normalized = normalizeExternalError(error);
    res.status(normalized.status || 500).send(page({
      title: 'Broker login failed',
      heading: 'Could not complete login',
      tone: 'error',
      body: `<p>${normalized.message}</p>${normalized.details?.hint ? `<p>${normalized.details.hint}</p>` : ''}<p><a href="/api/broker/login">Try again</a></p>`,
    }));
  }
});

/**
 * Two ways to (re)establish a session, both landing here:
 *  - No body: re-attempt with whatever access token is already in memory/.env (useful after
 *    a transient network failure, or just to re-check current state).
 *  - { access_token }: persist and use a valid daily access_token obtained some other way.
 *    A request_token is deliberately not accepted here because it is a one-time credential
 *    that must be exchanged with the API secret server-side.
 */
router.post('/revalidate', asyncHandler(async (req, res) => {
  const pastedToken = String(req.body?.access_token || '').trim();
  if (pastedToken) {
    if (!hasApiCredentials()) throw new AppError('Broker API key/secret must be configured before applying an access token.', 400, 'BROKER_CREDENTIALS_MISSING');
    await persistAccessToken(pastedToken);
  }
  await market.start();
  res.json({ ok: true, data: market.status() });
}));

export default router;
