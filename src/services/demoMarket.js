import { EventEmitter } from 'node:events';

const WATCH = [
  { token: 256265, symbol: 'NIFTY 50', base: 24750 },
  { token: 260105, symbol: 'NIFTY BANK', base: 54820 },
  { token: 738561, symbol: 'RELIANCE', base: 1418 },
  { token: 408065, symbol: 'INFY', base: 1561 },
  { token: 341249, symbol: 'HDFCBANK', base: 1718 },
  { token: 1270529, symbol: 'ICICIBANK', base: 1288 },
];

function round(n, d=2) { return Number(n.toFixed(d)); }

export class DemoMarket extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.timer = null;
    this.prices = new Map(WATCH.map(x => [x.token, x.base]));
    this.bars = new Map();
  }

  getWatch() { return WATCH; }

  subscribe(tokens=[]) {
    for (const token of tokens.map(Number).filter(Number.isFinite)) {
      if (!this.prices.has(token)) this.prices.set(token, 500 + (token % 15000) / 7);
    }
  }

  start() {
    if (this.timer) return;
    this.connected = true;
    this.emit('status', { connected: true, mode: 'demo' });
    this.timer = setInterval(() => {
      const items = [...WATCH, ...[...this.prices.keys()].filter((token) => !WATCH.some((x) => x.token === token)).map((token) => ({ token, symbol: `TOKEN ${token}`, base: this.prices.get(token) || 1000 }))].slice(0, 120);
      for (const item of items) {
        const old = this.prices.get(item.token) ?? item.base;
        const move = (Math.random() - 0.48) * (item.base < 2000 ? 2.6 : 10);
        const price = Math.max(1, old + move);
        this.prices.set(item.token, price);
        const ts = Math.floor(Date.now()/1000);
        const bucket = ts - (ts % 60);
        const bars = this.bars.get(item.token) || [];
        let candle = bars[bars.length-1];
        if (!candle || candle.time !== bucket) {
          candle = { time: bucket, open: price, high: price, low: price, close: price, volume: Math.floor(500 + Math.random()*5000) };
          bars.push(candle);
        } else {
          candle.high = Math.max(candle.high, price);
          candle.low = Math.min(candle.low, price);
          candle.close = price;
          candle.volume += Math.floor(Math.random()*400);
        }
        while (bars.length > 900) bars.shift();
        this.bars.set(item.token, bars);
        this.emit('tick', {
          instrument_token: item.token,
          last_price: round(price),
          change: round(((price-item.base)/item.base)*100, 3),
          timestamp: Date.now(),
          volume_traded: candle.volume,
          ohlc: { open: candle.open, high: candle.high, low: candle.low, close: candle.close },
          depth: { buy: this.depth(price, true), sell: this.depth(price, false) },
        });
      }
    }, 900);
  }

  depth(price, buy) {
    return Array.from({length:5}, (_,i) => ({
      quantity: Math.floor(500 + Math.random()*5000),
      price: round(price + (buy ? -1 : 1) * (i+1) * 0.2),
      orders: Math.floor(10 + Math.random()*90),
    }));
  }

  getHistorical(token, days=2) {
    const base = this.prices.get(Number(token)) || 1000;
    const end = Math.floor(Date.now()/60000)*60;
    const points = days * 375;
    const out = [];
    let p = base * (0.97 + Math.random()*0.03);
    for (let i=points; i>=0; i--) {
      const time = end - i*60;
      const open = p;
      const delta = (Math.random()-0.49) * base * 0.0012;
      const close = Math.max(1, open + delta);
      const high = Math.max(open, close) + Math.random()*base*0.0007;
      const low = Math.min(open, close) - Math.random()*base*0.0007;
      out.push({ time, open:round(open), high:round(high), low:round(low), close:round(close), volume:Math.floor(1000+Math.random()*12000) });
      p = close;
    }
    return out;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
  }
}
