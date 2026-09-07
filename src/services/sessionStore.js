import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const DATA_DIR = path.resolve('data');
const SESSION_FILE = path.join(DATA_DIR, '.kite-session.enc');
const ALGORITHM = 'aes-256-gcm';

function getKey() {
  if (env.tokenEncryptionKey && /^[a-fA-F0-9]{64}$/.test(env.tokenEncryptionKey)) return Buffer.from(env.tokenEncryptionKey, 'hex');
  return null;
}

class SessionStore {
  constructor() { this.session = null; }

  async init() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const key = getKey();
    if (!key) return null;
    try {
      const payload = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final()
      ]).toString('utf8');
      const parsed = JSON.parse(plain);
      if (parsed?.accessToken && (!parsed.expiresAt || Date.now() < Number(parsed.expiresAt))) {
        this.session = parsed;
        return parsed;
      }
      await this.clear();
    } catch {
      // Missing, expired, or tampered session is treated as logged out.
    }
    return null;
  }

  async save(session) {
    const key = getKey();
    this.session = { ...session };
    if (!key) return false; // secure-by-default: no plaintext persistence.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(session), 'utf8')), cipher.final()]);
    const payload = JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    });
    const temp = `${SESSION_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, SESSION_FILE);
    return true;
  }

  async clear() {
    this.session = null;
    try { await fs.unlink(SESSION_FILE); } catch {}
  }

  getAccessToken() { return this.session?.accessToken || null; }
  getSessionMeta() {
    if (!this.session) return null;
    return { userId: this.session.userId || null, loginAt: this.session.loginAt || null, expiresAt: this.session.expiresAt || null };
  }
}

export const sessionStore = new SessionStore();
export { SESSION_FILE };
