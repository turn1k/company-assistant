import { openStore, hashPassword } from '../lib/store.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const input = createInterface({ input: process.stdin, output: process.stdout });
const login = (await input.question('Логин администратора (латиницей): ')).trim().toLowerCase();
const name = (await input.question('Имя администратора: ')).trim();
input.close();
if (!/^[a-z0-9._-]{3,48}$/.test(login) || !name || name.length > 100) throw new Error('Некорректное имя или логин.');
const password = randomBytes(18).toString('base64url');
const db = openStore(directory);
try {
  if (db.prepare('SELECT id FROM users WHERE login=?').get(login)) throw new Error('Такой логин уже существует.');
  db.prepare('INSERT INTO users(id,login,name,password,role,created) VALUES (?,?,?,?,?,?)').run(randomUUID(), login, name, await hashPassword(password), 'admin', Date.now());
  console.log(`Администратор создан. Временный пароль (показывается один раз): ${password}`);
  console.log('При первом входе смените пароль. Не добавляйте его в Git или переписку.');
} finally { db.close(); }
