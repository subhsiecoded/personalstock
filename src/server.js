import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';

import { env } from './config/env.js';

import marketRouter from './routes/market.js';
import authRouter from './routes/auth.js';
import accountRouter from './routes/account.js';
import ordersRouter from './routes/orders.js';

import { market } from './services/brokerService.js';
import { instruments } from './services/instrumentService.js';

import {
  errorHandler,
  notFoundHandler,
} from './middleware/errorHandler.js';

import { setupSocket } from './socket/marketSocket.js';

const app = express();
const server = http.createServer(app);

/**
 * ---------------------------------------------------------
 * Runtime state
 * ---------------------------------------------------------
 */

let io = null;
let bootstrapStarted = false;
let shuttingDown = false;

const startedAt = Date.now();

/**
 * ---------------------------------------------------------
 * CORS
 * ---------------------------------------------------------
 */

const allowedOrigins = String(env.frontendUrl || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser / same-origin / server-to-server requests.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error(`CORS origin not allowed: ${origin}`)
    );
  },
  credentials: true,
};

/**
 * ---------------------------------------------------------
 * Security / compression / body parsing
 * ---------------------------------------------------------
 */

app.set('trust proxy', env.trustProxy ?? 1);

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin',
    },

    contentSecurityPolicy: false,
  })
);

app.use(compression());

app.use(cors(corsOptions));

app.use(
  express.json({
    limit: '2mb',
  })
);

/**
 * ---------------------------------------------------------
 * Request ID
 * ---------------------------------------------------------
 */

app.use((req, res, next) => {
  const requestId = randomUUID();

  req.id = requestId;

  res.setHeader(
    'x-request-id',
    requestId
  );

  next();
});

/**
 * ---------------------------------------------------------
 * HTTP request logging
 * ---------------------------------------------------------
 */

app.use(
  morgan(
    ':method :url :status :response-time ms [:req[x-request-id]]'
  )
);

/**
 * ---------------------------------------------------------
 * Basic root endpoint
 * ---------------------------------------------------------
 */

app.get('/', (_req, res) => {
  res.json({
    ok: true,

    service:
      "Subh's stock dashboard API",

    status: 'running',

    timestamp: Date.now(),

    uptime: process.uptime(),
  });
});

/**
 * ---------------------------------------------------------
 * Health endpoint
 * ---------------------------------------------------------
 */

app.get('/api/health', (_req, res) => {
  const status = market.status();

  res.json({
    ok: true,

    data: {
      service:
        "Subh's stock dashboard",

      status: 'running',

      uptime: process.uptime(),

      uptimeSeconds: Math.floor(
        process.uptime()
      ),

      startedAt,

      now: Date.now(),

      environment:
        process.env.NODE_ENV ||
        'development',

      market: status,
    },
  });
});

/**
 * ---------------------------------------------------------
 * Authentication
 *
 * IMPORTANT:
 *
 * authRouter should contain:
 *
 * GET /login
 * GET /callback
 * GET /status
 * POST /revalidate
 * POST /logout
 *
 * Therefore:
 *
 * /api/auth/login
 * /api/auth/callback
 *
 * remain available.
 *
 * We also mount the same router under:
 *
 * /api/broker
 *
 * so your registered broker redirect:
 *
 * http://localhost:5000/api/broker/callback
 *
 * resolves to:
 *
 * authRouter -> /callback
 *
 * The legacy /api/kite/callback path remains mounted for compatibility, and is the
 * default redirect used by this project. /api/broker/callback and /api/auth/callback
 * remain available as aliases.
 *
 * ---------------------------------------------------------
 */

app.use(
  '/api/auth',
  authRouter
);

app.use(
  '/api/broker',
  authRouter
);

// Backwards-compatible alias for Kite Connect apps that still have the legacy
// /api/kite/callback URL registered. Keeping this alias prevents the broker from
// landing on Express's 404 handler while the app is being migrated to the newer
// /api/broker path.
app.use(
  '/api/kite',
  authRouter
);

/**
 * ---------------------------------------------------------
 * Market API
 * ---------------------------------------------------------
 */

app.use(
  '/api/market',
  marketRouter
);

/**
 * ---------------------------------------------------------
 * Account API
 * ---------------------------------------------------------
 */

app.use(
  '/api/account',
  accountRouter
);

/**
 * ---------------------------------------------------------
 * Orders API - place/modify/cancel + margin calculator.
 * Every write here is guarded by ORDER_DRY_RUN (see backend/.env).
 * ---------------------------------------------------------
 */

app.use(
  '/api/orders',
  ordersRouter
);

/**
 * ---------------------------------------------------------
 * API 404 handler
 * ---------------------------------------------------------
 */

app.use(
  notFoundHandler
);

/**
 * ---------------------------------------------------------
 * Global error handler
 * ---------------------------------------------------------
 */

app.use(
  errorHandler
);

/**
 * ---------------------------------------------------------
 * Socket.IO
 * ---------------------------------------------------------
 */

io = new Server(server, {
  cors: corsOptions,

  transports: [
    'websocket',
    'polling',
  ],

  allowEIO3: false,

  pingTimeout: 20000,

  pingInterval: 25000,

  maxHttpBufferSize:
    2 * 1024 * 1024,

  connectionStateRecovery: {
    maxDisconnectionDuration:
      2 * 60 * 1000,

    skipMiddlewares: true,
  },
});

/**
 * Connect Socket.IO to market service.
 *
 * setupSocket() should:
 *
 * - subscribe/unsubscribe instruments
 * - emit live ticks
 * - emit candles
 * - emit depth
 * - emit connection status
 * - handle reconnects
 */

setupSocket(
  io,
  market
);

/**
 * ---------------------------------------------------------
 * Graceful shutdown
 * ---------------------------------------------------------
 */

async function shutdown(reason) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `\nShutdown requested: ${reason}`
  );

  try {
    /**
     * Stop demo feed first.
     */
    if (
      market?.demo &&
      typeof market.demo.stop === 'function'
    ) {
      try {
        market.demo.stop();
      } catch (error) {
        console.error(
          'Failed to stop demo market:',
          error
        );
      }
    }

    /**
     * Stop all live broker WebSocket feeds.
     */
    if (
      typeof market.stopFeeds ===
      'function'
    ) {
      try {
        market.stopFeeds();
      } catch (error) {
        console.error(
          'Failed to stop broker feeds:',
          error
        );
      }
    }

    /**
     * Close Socket.IO.
     */
    if (io) {
      try {
        await new Promise((resolve) => {
          io.close(() => resolve());
        });
      } catch (error) {
        console.error(
          'Failed to close Socket.IO:',
          error
        );
      }
    }

    /**
     * Close HTTP server.
     */
    await new Promise((resolve) => {
      server.close((error) => {
        if (error) {
          console.error(
            'HTTP server close error:',
            error
          );
        }

        resolve();
      });
    });

    console.log(
      'Subh\'s stock dashboard stopped cleanly.'
    );

    process.exit(0);
  } catch (error) {
    console.error(
      'Fatal shutdown error:',
      error
    );

    process.exit(1);
  }
}

/**
 * ---------------------------------------------------------
 * Process-level error handlers
 * ---------------------------------------------------------
 */

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'uncaughtException',
  (error) => {
    console.error(
      'UNCAUGHT EXCEPTION:',
      error
    );

    shutdown(
      'uncaughtException'
    );
  }
);

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      'UNHANDLED PROMISE REJECTION:',
      reason
    );

    /**
     * Do not immediately kill the server
     * because a single upstream broker API failure
     * should not destroy the whole terminal.
     *
     * The market layer should expose its own
     * connection/error state.
     */
  }
);

/**
 * ---------------------------------------------------------
 * Bootstrap
 * ---------------------------------------------------------
 */

async function bootstrap() {
  if (bootstrapStarted) {
    console.warn(
      'Bootstrap already started. Skipping duplicate startup.'
    );

    return;
  }

  bootstrapStarted = true;

  console.log(
    '\n----------------------------------------'
  );

  console.log(
    "Subh's stock dashboard"
  );

  console.log(
    'Market infrastructure starting...'
  );

  console.log(
    '----------------------------------------'
  );

  /**
   * -------------------------------------------------------
   * 1. Load the complete broker instrument universe
   * -------------------------------------------------------
   */

  let universe;

  try {
    universe =
      await instruments.load();

    if (
      !Array.isArray(universe) ||
      typeof universe.length !== 'number'
    ) {
      throw new Error(
        'Instrument service returned an invalid universe.'
      );
    }

    market.setInstrumentLookup(
      universe
    );

    console.log(
      `Instrument universe loaded: ${universe.length}`
    );
  } catch (error) {
    console.error(
      'Instrument universe failed to load:',
      error
    );

    /**
     * Keep server alive.
     *
     * This lets:
     * - auth work
     * - health work
     * - frontend render
     *
     * while the instrument subsystem reports
     * its failure.
     */

    market.emitStatus({
      ...market.status(),

      error:
        error?.message ||
        'Instrument universe unavailable',
    });

    return;
  }

  /**
   * -------------------------------------------------------
   * 2. Subscribe to priority instruments
   * -------------------------------------------------------
   *
   * These should be valid broker instrument tokens.
   *
   * LTP/quote mode can be used broadly while FULL
   * mode should be reserved for instruments where depth
   * is actually needed.
   */

  const priorityTokens = [
    256265,   // NIFTY 50
    260105,   // NIFTY BANK
    738561,   // RELIANCE
    408065,   // INFY
    341249,   // HDFCBANK
    1270529,  // ICICIBANK
    779521,   // SBIN
    2815745,  // TCS
  ];

  try {
    market.subscribe(
      priorityTokens,
      {
        focus: false,
      }
    );
  } catch (error) {
    console.error(
      'Priority subscription failed:',
      error
    );

    market.emitStatus({
      ...market.status(),

      error:
        error?.message ||
        'Priority subscription failed',
    });
  }

  /**
   * -------------------------------------------------------
   * 3. Start market service
   * -------------------------------------------------------
   */

  try {
    await market.start();

    console.log(
      `Market service started. Mode: ${
        market.status().mode
      }`
    );
  } catch (error) {
    console.error(
      'Market service failed to start:',
      error
    );

    market.emitStatus({
      ...market.status(),

      error:
        error?.message ||
        'Market service failed to start',
    });
  }

  /**
   * -------------------------------------------------------
   * 4. Final state
   * -------------------------------------------------------
   */

  const finalStatus =
    market.status();

  console.log(
    `Mode: ${finalStatus.mode}`
  );

  console.log(
    `Instruments: ${finalStatus.universeSize}`
  );

  console.log(
    `Live capacity: ${finalStatus.liveCapacity}`
  );

  console.log(
    `Connected sockets: ${
      finalStatus.connectedSockets
    }`
  );

  console.log(
    `Subscriptions: ${
      finalStatus.instruments || 0
    } / ${finalStatus.liveCapacity || 9000}`
  );

  console.log(
    `----------------------------------------\n`
  );
}

server.on('error', (error) => {
  console.error('HTTP server error:', error);
});

io?.engine?.on?.('connection_error', (error) => {
  console.error('Socket.IO engine connection error:', error?.message || error);
});

/**
 * ---------------------------------------------------------
 * HTTP server startup
 * ---------------------------------------------------------
 */

server.listen(
  env.port,
  () => {
    console.log(
      `Subh's stock dashboard API listening on http://localhost:${env.port}`
    );

    console.log(
      `Frontend URL: ${env.frontendUrl}`
    );

    console.log(
      `Broker environment source: ${
        env.envFiles?.source ||
        'unknown'
      }`
    );

    /**
     * Never print actual credentials.
     */
    console.log(
      `Broker API key: ${
        env.apiKey
          ? 'present'
          : 'missing'
      }`
    );

    console.log(
      `Broker API secret: ${
        env.apiSecret
          ? 'present'
          : 'missing'
      }`
    );

    console.log(
      `Broker access token: ${
        env.accessToken
          ? 'present'
          : 'not configured'
      }`
    );

    console.log(
      `Broker redirect URL: ${
        env.redirectUrl ||
        'not configured'
      }`
    );

    console.log(
      `Market mode: ${
        env.mode ||
        'auto'
      }`
    );

    console.log(
      `Demo fallback: ${
        env.demoFallback
      }`
    );

    /**
     * Start the application asynchronously.
     */
    bootstrap().catch(
      (error) => {
        console.error(
          'Fatal bootstrap error:',
          error
        );

        market.emitStatus({
          ...market.status(),

          error:
            error?.message ||
            'Fatal bootstrap error',
        });
      }
    );
  }
);