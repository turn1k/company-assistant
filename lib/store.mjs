import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const invalid = message => Object.assign(new Error(message), { status: 400 });
export const defaults = Object.freeze({ fileMB: 20, totalMB: 50, files: 5, inputTokens: 32000, outputTokens: 8000, dailyTokens: 300000, dailyUSD: 1 });
export const sha = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw invalid('Пароль должен содержать от 12 до 128 символов.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, hex] = stored.split(':');
  const key = await derive(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'app.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      blocked INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 1,
      limits TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
      created INTEGER NOT NULL, seen INTEGER NOT NULL, expires INTEGER NOT NULL,
      ip TEXT NOT NULL, agent TEXT NOT NULL, device TEXT NOT NULL, location TEXT);
    CREATE TABLE IF NOT EXISTS latest (
      user_id TEXT PRIMARY KEY REFERENCES users(id), id TEXT NOT NULL, prompt TEXT NOT NULL,
      answer TEXT NOT NULL, files TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
      created INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
      usd REAL NOT NULL, status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS usage_user_day ON usage(user_id, day);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('limits', JSON.stringify(defaults));
  return db;
}
export function limitsFor(db, user) {
  return { ...defaults, ...JSON.parse(db.prepare("SELECT value FROM settings WHERE key='limits'").get().value), ...(user.limits ? JSON.parse(user.limits) : {}) };
}
export function validateLimits(input, partial = false) {
  const ranges = { fileMB: [1, 20], totalMB: [1, 50], files: [1, 5], inputTokens: [1000, 128000], outputTokens: [256, 32000], dailyTokens: [1000, 10000000], dailyUSD: [0.01, 1000] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Некорректные лимиты.');
  const out = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (partial && input[key] === undefined) continue;
    const n = input[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (key !== 'dailyUSD' && !Number.isInteger(n))) throw invalid(`Недопустимый лимит: ${key} (${min}–${max}).`);
    out[key] = n;
  }
  return out;
}
export const publicUser = u => ({ id: u.id, login: u.login, email: u.email, name: u.name, role: u.role, blocked: !!u.blocked, mustChange: !!u.must_change, limits: u.limits ? JSON.parse(u.limits) : null });
export function dayKey(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = key => parts.find(p => p.type === key).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function usageFor(db, userId, day) {
  return db.prepare('SELECT COALESCE(SUM(input+output),0) tokens, COALESCE(SUM(usd),0) usd, COUNT(*) requests FROM usage WHERE user_id=? AND day=?').get(userId, day);
}
