import express from 'express';
import { market } from '../services/brokerService.js';
import { instruments } from '../services/instrumentService.js';
import { asyncHandler, AppError } from '../utils/errors.js';
const router = express.Router();

router.get('/status', (_req,res)=>res.json({ok:true,data:market.status()}));
router.get('/universe', asyncHandler(async (req,res)=>{
  const data = await instruments.query(req.query);
  if (String(req.query.live).toLowerCase() === '1' && data.items.length && market.live) {
    const keys = data.items.map((x)=>`${x.exchange}:${x.tradingsymbol}`);
    const quotes = await market.quoteByKeys(keys,{mode:'ltp'});
    data.items = data.items.map((x)=>{ const q=quotes[`${x.exchange}:${x.tradingsymbol}`]; return q ? {...x, last_price:q.last_price, live:true, quote_timestamp:q.timestamp||null} : {...x, live:false}; });
  }
  res.json({ok:true,data});
}));
router.get('/search', asyncHandler(async (req,res)=>res.json({ok:true,data:await instruments.matching(req.query, req.query.limit || 30)})));
router.get('/universe/stats', asyncHandler(async (_req,res)=>res.json({ok:true,data:await instruments.stats()})));
router.post('/universe/refresh', asyncHandler(async (_req,res)=>{const data=await instruments.refresh(); market.setInstrumentLookup(data); res.json({ok:true,data:{total:data.length,loadedAt:Date.now()}});}));
router.get('/instrument/:exchange/:symbol', asyncHandler(async (req,res)=>{
  const key = `${String(req.params.exchange).toUpperCase()}:${String(req.params.symbol).toUpperCase()}`;
  const all = await instruments.load(); const item = all.find((x)=>`${x.exchange}:${x.tradingsymbol}`.toUpperCase()===key);
  if (!item) throw new AppError('Instrument not found',404,'INSTRUMENT_NOT_FOUND');
  res.json({ok:true,data:item});
}));
router.get('/quote', asyncHandler(async (req,res)=>{
  const keys = String(req.query.i || '').split(',').map(s=>s.trim()).filter(Boolean).slice(0,500);
  if (!keys.length) throw new AppError('Provide comma-separated instruments in i.',400,'QUOTE_INPUT_REQUIRED');
  const mode = ['full','ohlc','ltp'].includes(String(req.query.mode)) ? String(req.query.mode) : 'full';
  res.json({ok:true,data:await market.quoteByKeys(keys,{mode})});
}));
router.post('/quote/batch', asyncHandler(async (req,res)=>{
  const keys = Array.isArray(req.body?.instruments) ? req.body.instruments : [];
  if (!keys.length) throw new AppError('instruments must be a non-empty array',400,'QUOTE_INPUT_REQUIRED');
  const mode = ['full','ohlc','ltp'].includes(String(req.body?.mode)) ? String(req.body.mode) : 'ltp';
  res.json({ok:true,data:await market.quoteByKeys(keys.slice(0,500),{mode})});
}));
router.get('/historical/:token', asyncHandler(async (req, res) => {
  const token = Number(req.params.token);
  if (!Number.isFinite(token)) {
    throw new AppError('Invalid instrument token.', 400, 'INVALID_TOKEN');
  }

  const interval = String(req.query.interval || 'minute').trim();
  const allowed = ['minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day'];
  if (!allowed.includes(interval)) {
    throw new AppError('Unsupported historical interval.', 400, 'INVALID_INTERVAL');
  }

  const asDate = (value, fallbackDate, endOfDay = false) => {
    const raw = String(value || '').replace(/\+/g, ' ').trim();
    if (!raw) return fallbackDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return `${raw} ${endOfDay ? '15:30:00' : '09:15:00'}`;
    }
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    throw new AppError(`Invalid historical date: ${raw}`, 400, 'INVALID_DATE');
  };

  const days = Math.min(Math.max(Number(req.query.days) || (interval === 'day' ? 365 : 2), 1), interval === 'day' ? 3650 : 90);
  const nowIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const endDefault = `${nowIst} 15:30:00`;
  const startDate = new Date(Date.now() - days * 86400000);
  const startIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(startDate);

  const from = asDate(req.query.from, `${startIst} 09:15:00`, false);
  const to = asDate(req.query.to, endDefault, true);

  if (from >= to) {
    throw new AppError('Historical from date must be before to date.', 400, 'INVALID_DATE_RANGE');
  }

  const data = await market.historical({
    token,
    from,
    to,
    interval,
    continuous: String(req.query.continuous) === '1',
    oi: String(req.query.oi) === '1',
  });

  res.json({ ok: true, data });
}));
router.post('/subscribe', asyncHandler(async (req,res)=>{const tokens=Array.isArray(req.body?.tokens)?req.body.tokens:[]; if(!tokens.length) throw new AppError('tokens must be a non-empty array',400,'INVALID_SUBSCRIPTION'); res.json({ok:true,data:market.subscribe(tokens,{focus:Boolean(req.body?.focus)})});}));
router.post('/focus', asyncHandler(async (req,res)=>{market.focus(req.body?.token); res.json({ok:true,data:market.status()});}));
router.post('/unsubscribe', asyncHandler(async (req,res)=>{market.unsubscribe(Array.isArray(req.body?.tokens)?req.body.tokens:[]);res.json({ok:true,data:market.status()});}));

/**
 * Option chain for one underlying + expiry, merged server-side (instrument metadata + live
 * quotes in one round trip) so the frontend never has to stitch hundreds of quote responses
 * together itself.
 */
const INDEX_SPOT_ALIASES = {
  NIFTY: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  FINNIFTY: 'NIFTY FIN SERVICE',
  MIDCPNIFTY: 'NIFTY MID SELECT',
  SENSEX: 'SENSEX',
  BANKEX: 'BANKEX',
};

router.get('/optionchain', asyncHandler(async (req, res) => {
  const underlying = String(req.query.underlying || '').trim().toUpperCase();
  if (!underlying) throw new AppError('underlying is required (e.g. NIFTY, BANKNIFTY, RELIANCE).', 400, 'OPTIONCHAIN_INPUT_REQUIRED');

  const all = await instruments.load();
  const optionRows = all.filter((x) =>
    String(x.name).toUpperCase() === underlying &&
    ['CE', 'PE'].includes(String(x.instrument_type).toUpperCase()) &&
    ['NFO', 'BFO'].includes(String(x.exchange).toUpperCase()));

  if (!optionRows.length) throw new AppError(`No options found for underlying "${underlying}". Check the symbol (e.g. NIFTY, BANKNIFTY, RELIANCE).`, 404, 'OPTIONCHAIN_NOT_FOUND');

  const expiries = [...new Set(optionRows.map((x) => x.expiry))].filter(Boolean).sort();
  const expiry = req.query.expiry && expiries.includes(req.query.expiry) ? req.query.expiry : expiries[0];
  const rows = optionRows.filter((x) => x.expiry === expiry);

  let spotKey = null;
  const aliasSymbol = INDEX_SPOT_ALIASES[underlying];
  if (aliasSymbol) {
    const idx = all.find((x) => String(x.segment).toUpperCase().includes('INDICES') && String(x.tradingsymbol).toUpperCase() === aliasSymbol);
    if (idx) spotKey = `${idx.exchange}:${idx.tradingsymbol}`;
  } else {
    const eq = all.find((x) => String(x.exchange).toUpperCase() === 'NSE' && String(x.instrument_type).toUpperCase() === 'EQ' && String(x.tradingsymbol).toUpperCase() === underlying);
    if (eq) spotKey = `${eq.exchange}:${eq.tradingsymbol}`;
  }

  const keys = rows.map((r) => `${r.exchange}:${r.tradingsymbol}`).slice(0, 490);
  const quotes = market.live ? await market.quoteByKeys([...(spotKey ? [spotKey] : []), ...keys], { mode: 'full' }) : {};
  const spot = spotKey ? quotes[spotKey]?.last_price ?? null : null;

  const strikes = {};
  rows.forEach((r) => {
    const key = `${r.exchange}:${r.tradingsymbol}`;
    const q = quotes[key];
    const bucket = strikes[r.strike] || (strikes[r.strike] = { strike: r.strike });
    bucket[r.instrument_type] = {
      tradingsymbol: r.tradingsymbol,
      instrument_token: r.instrument_token,
      exchange: r.exchange,
      lot_size: r.lot_size,
      tick_size: r.tick_size,
      last_price: q?.last_price ?? 0,
      oi: q?.oi ?? 0,
      change: Number.isFinite(Number(q?.net_change)) ? Number(q.net_change) : null,
      bid: q?.depth?.buy?.[0]?.price ?? null,
      ask: q?.depth?.sell?.[0]?.price ?? null,
    };
  });

  res.json({
    ok: true,
    data: {
      underlying,
      expiry,
      expiries,
      spot,
      live: market.live,
      strikes: Object.values(strikes).sort((a, b) => a.strike - b.strike),
    },
  });
}));

export default router;
