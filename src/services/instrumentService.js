import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const CACHE_DIR = path.resolve('data');
const CACHE_FILE = path.join(CACHE_DIR, 'instrument-universe.json');

function parseCsvLine(line) {
  const out = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i += 1; } else quoted = !quoted; }
    else if (ch === ',' && !quoted) { out.push(value); value = ''; } else value += ch;
  }
  out.push(value); return out;
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!lines.length) return [];
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const cols = parseCsvLine(line); const row = Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
    row.instrument_token = Number(row.instrument_token); row.exchange_token = Number(row.exchange_token);
    row.strike = Number(row.strike || 0); row.lot_size = Number(row.lot_size || 0); row.tick_size = Number(row.tick_size || 0);
    return row;
  }).filter((x) => Number.isFinite(x.instrument_token));
}

const score = (item, term) => {
  if (!term) return 0;
  const s = String(item.tradingsymbol || '').toUpperCase(); const n = String(item.name || '').toUpperCase();
  if (s === term) return 1000; if (s.startsWith(term)) return 800; if (n.startsWith(term)) return 700; if (s.includes(term)) return 600; if (n.includes(term)) return 500;
  return [item.exchange, item.segment, item.instrument_type].some((v) => String(v || '').toUpperCase().includes(term)) ? 200 : 0;
};

export class InstrumentService {
  constructor() { this.cache = []; this.loadedAt = 0; this.loading = null; }
  async load({ force = false } = {}) {
    const fresh = this.cache.length && Date.now() - this.loadedAt < env.instrumentCacheTtlMs;
    if (!force && fresh) return this.cache; if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        // Real upstream endpoint for the full instrument dump (CSV) - kept as-is since it's
        // a live network address, not a naming choice.
        const response = await axios.get('https://api.kite.trade/instruments', { responseType: 'text', timeout: env.brokerRequestTimeoutMs });
        const data = parseCsv(response.data); if (!data.length) throw new Error('Broker returned an empty instrument dump');
        this.cache = data; this.loadedAt = Date.now();
        await fs.writeFile(CACHE_FILE, JSON.stringify({ loadedAt: this.loadedAt, data }), 'utf8'); return this.cache;
      } catch (error) {
        if (!this.cache.length) {
          try { const cached = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')); if (Array.isArray(cached?.data) && cached.data.length) { this.cache = cached.data; this.loadedAt = Number(cached.loadedAt || 0); return this.cache; } } catch {}
        }
        if (this.cache.length) return this.cache;
        throw new AppError('Unable to load broker instrument universe', 502, 'INSTRUMENT_UNIVERSE_UNAVAILABLE', error);
      } finally { this.loading = null; }
    })();
    return this.loading;
  }
  async refresh() { return this.load({ force: true }); }

  filter(items, { q = '', exchange = '', segment = '', type = '' } = {}) {
    const term = String(q).trim().toUpperCase(); const ex = String(exchange).trim().toUpperCase(); const seg = String(segment).trim().toUpperCase(); const instrumentType = String(type).trim().toUpperCase();
    return items.filter((x) => {
      if (ex && String(x.exchange).toUpperCase() !== ex) return false;
      if (seg && String(x.segment).toUpperCase() !== seg) return false;
      if (instrumentType && String(x.instrument_type).toUpperCase() !== instrumentType) return false;
      if (!term) return true;
      return score(x, term) > 0;
    }).sort((a, b) => score(b, term) - score(a, term));
  }

  async query(params = {}) {
    const items = await this.load();
    const filtered = this.filter(items, params);
    const size = Math.min(Math.max(Number(params.pageSize) || 100, 10), 250);
    const page = Math.max(Number(params.page) || 1, 1); const start = (page - 1) * size;
    return { items: filtered.slice(start, start + size), page, pageSize: size, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / size)), loadedAt: this.loadedAt, universeSize: items.length };
  }
  async matching(params = {}, limit = 25) { const items = await this.load(); return this.filter(items, params).slice(0, Math.min(Number(limit) || 25, 100)); }
  async findByToken(token) { const items = await this.load(); return items.find((x) => Number(x.instrument_token) === Number(token)) || null; }
  async stats() {
    const items = await this.load(); const by = (key) => Object.entries(items.reduce((acc, x) => { const k = x[key] || 'UNKNOWN'; acc[k] = (acc[k] || 0) + 1; return acc; }, {})).sort((a,b)=>b[1]-a[1]);
    return { total: items.length, exchanges: by('exchange'), segments: by('segment'), types: by('instrument_type'), loadedAt: this.loadedAt };
  }
}
export const instruments = new InstrumentService();
