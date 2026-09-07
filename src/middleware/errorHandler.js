import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`,
      requestId: randomUUID(),
    },
  });
}

export function errorHandler(error, req, res, _next) {
  const requestId = req.id || randomUUID();
  const appError = error instanceof AppError
    ? error
    : new AppError('Unexpected server error', 500, 'INTERNAL_ERROR', null, false);

  if (!appError.expose) console.error(`[${requestId}]`, error);

  res.status(appError.status).json({
    ok: false,
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : 'Unexpected server error',
      details: appError.expose ? appError.details : null,
      requestId,
    },
  });
}
