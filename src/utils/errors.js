export class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details = null, expose = true) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Classifies an error from the upstream broker API into a stable code + a short, actionable
 * hint the UI can show directly. The upstream SDK/API surfaces a handful of named
 * `error_type` values (TokenException, UserException, OrderException, InputException,
 * NetworkException, DataException, GeneralException, PermissionException) plus occasional
 * plain network failures (no response at all - DNS/timeout/connection reset). We map all of
 * these into one shape so callers never have to sniff raw upstream text themselves.
 */
export function normalizeExternalError(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  const data = error?.response?.data || error?.data || {};
  const message = data?.message || error?.message || 'External service error';
  const type = data?.error_type || error?.name || '';
  const networkCode = error?.code; // e.g. ECONNABORTED, ECONNRESET, ENOTFOUND, ETIMEDOUT

  let mappedStatus = status || 502;
  let code = 'UPSTREAM_ERROR';
  let hint = 'Something unexpected happened talking to the broker. Try again in a moment.';
  let retryable = false;

  const looksLikeTokenIssue = /incorrect.*api_key|incorrect.*access_token|invalid.*token|token.*expired|token.*invalid/i.test(message);

  if (type === 'TokenException' || looksLikeTokenIssue || (status === 403 && /token|access/i.test(message))) {
    mappedStatus = 401;
    code = 'TOKEN_EXPIRED';
    hint = 'Your broker access token has expired or is invalid. Zerodha invalidates every access token once a day (around 6 AM IST) as a security measure - this is expected, not a bug. Click "Reconnect broker account" to get a fresh one.';
    retryable = false;
  } else if (type === 'UserException') {
    mappedStatus = 403;
    code = 'BROKER_USER_ERROR';
    hint = 'Your broker account itself rejected this request (e.g. account not activated for this segment, or T&Cs pending). Check your Zerodha account status directly.';
  } else if (type === 'PermissionException') {
    mappedStatus = 403;
    code = 'BROKER_PERMISSION_DENIED';
    hint = 'Your API app or account doesn\'t have permission for this action. For orders, confirm your Kite Connect app has trading permissions enabled, not just read-only market data.';
  } else if (type === 'OrderException') {
    mappedStatus = 400;
    code = 'BROKER_ORDER_REJECTED';
    hint = 'The exchange or broker rejected this order (common causes: insufficient margin, invalid price/quantity for this instrument, or market closed).';
  } else if (type === 'InputException' || status === 400) {
    mappedStatus = 400;
    code = 'BROKER_INVALID_INPUT';
    hint = 'The request was malformed - double check symbol, exchange, quantity and price fields.';
  } else if (type === 'NetworkException') {
    mappedStatus = 503;
    code = 'BROKER_NETWORK_ERROR';
    hint = 'The broker\'s own systems are unreachable or timed out. This is usually transient - it will retry automatically.';
    retryable = true;
  } else if (type === 'DataException') {
    mappedStatus = 502;
    code = 'BROKER_DATA_ERROR';
    hint = 'The broker returned data this app couldn\'t process. If this persists, the upstream API may have changed shape.';
    retryable = true;
  } else if (type === 'GeneralException') {
    mappedStatus = 500;
    code = 'BROKER_GENERAL_ERROR';
    hint = 'The broker reported an internal error on their end. Try again shortly.';
    retryable = true;
  } else if (status === 429) {
    mappedStatus = 429;
    code = 'BROKER_RATE_LIMITED';
    hint = 'Too many requests reached the broker API too quickly. This app rate-limits itself, so seeing this usually means multiple tabs/instances are running at once.';
    retryable = true;
  } else if (!status && ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(networkCode)) {
    mappedStatus = 503;
    code = 'NETWORK_UNREACHABLE';
    hint = 'Could not reach the broker API at all (DNS/timeout/connection reset). Check your internet connection.';
    retryable = true;
  }

  return new AppError(message, mappedStatus, code, {
    upstreamStatus: status || null,
    upstreamErrorType: type || null,
    hint,
    retryable,
  });
}
