import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { hashPassword, dayKey, defaults } from '../lib/store.mjs';
import { parseFile } from '../lib/uploads.mjs';
import sharp from 'sharp';
import ExcelJS from 'exceljs';

const password = 'Test-only-password-123';
async function fixture(t, provider) {
  const directory = await mkdtemp(path.join(tmpdir(), 'company-assistant-test-'));
  const app = await createApplication({ dataDir: directory, origin: 'http://localhost', provider: provider || (async () => ({ choices: [{ message: { content: 'Проверенный ответ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })) });
  const hash = await hashPassword(password);
  const ids = {};
  for (const [login, role] of [['admin', 'admin'], ['alice', 'user'], ['bob', 'user']]) {
    ids[login] = randomUUID();
    app.db.prepare('INSERT INTO users(id,login,email,name,password,role,must_change,created) VALUES (?,?,?,?,?,?,0,?)').run(ids[login], login, `${login}@example.test`, login, hash, role, Date.now());
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, { cookie, body, method = body ? 'POST' : 'GET', origin = 'http://localhost' } = {}) => {
    const response = await fetch(base + route, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    return response;
  };
  const login = async (name, device = randomUUID()) => {
    const response = await call('/api/login', { body: { login: name, password, device } });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  t.after(async () => { await app.close(); assert.ok(directory.startsWith(path.join(tmpdir(), 'company-assistant-test-'))); await rm(directory, { recursive: true, force: true }); });
  return { app, ids, base, call, login, directory };
}
function queryForm(prompt, files = []) { const data = new FormData(); data.append('prompt', prompt); for (const [name, contents, type] of files) data.append('files', new Blob([contents], { type: type || 'text/plain' }), name); return data; }

test('authentication, origin checks, email login and administrator authorization', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/state')).status, 401);
  assert.equal((await f.call('/api/login', { body: { login: 'alice', password: 'wrong' } })).status, 401);
  assert.equal((await f.call('/api/login', { origin: 'https://attacker.test', body: { login: 'alice', password } })).status, 403);
  const cookie = await f.login('ALICE@example.test');
  assert.equal((await f.call('/api/admin', { cookie })).status, 403);
  const response = await f.call('/api/state', { cookie }), state = await response.json();
  assert.equal(state.user.login, 'alice'); assert.equal(state.user.password, undefined);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('successful results replace previous files; accounts cannot read each other’s files', async t => {
  const f = await fixture(t), alice = await f.login('alice'), bob = await f.login('bob');
  const firstResponse = await f.call('/api/query', { cookie: alice, body: queryForm('Прочитай', [['one.txt', 'First document']]) });
  assert.equal(firstResponse.status, 200, JSON.stringify(await firstResponse.clone().json()));
  const first = (await firstResponse.json()).latest;
  assert.equal((await f.call(`/api/files/${first.files[0].id}`, { cookie: bob })).status, 404);
  assert.equal(await (await f.call(`/api/files/${first.files[0].id}`, { cookie: alice })).text(), 'First document');
  const next = await f.call('/api/query', { cookie: alice, body: queryForm('Второй запрос') });
  assert.equal(next.status, 200);
  assert.equal((await f.call(`/api/files/${first.files[0].id}`, { cookie: alice })).status, 404);
  await assert.rejects(access(path.join(f.directory, 'uploads', first.id)));
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM latest').get().n, 1);
  assert.equal(f.app.db.prepare('SELECT SUM(input+output) n FROM usage').get().n, 300);
});

test('concurrency is per account, shared across devices; other users proceed', async t => {
  let release, notify;
  const reached = new Promise(resolve => notify = resolve), gate = new Promise(resolve => release = resolve);
  const f = await fixture(t, async content => {
    if (content[0].text === 'hold') { notify(); await gate; }
    return { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  });
  const alice = await f.login('alice'), otherDevice = await f.login('alice'), bob = await f.login('bob');
  const running = f.call('/api/query', { cookie: alice, body: queryForm('hold') });
  await reached;
  try {
    assert.equal((await f.call('/api/query', { cookie: otherDevice, body: queryForm('again') })).status, 409);
    assert.equal((await f.call('/api/query', { cookie: bob, body: queryForm('independent') })).status, 200);
  } finally { release(); }
  assert.equal((await running).status, 200);
});

test('failed responses preserve previous result; known rejections refund, uncertain errors reserve', async t => {
  let mode = 'ok';
  const f = await fixture(t, async () => {
    if (mode !== 'ok') throw Object.assign(new Error('Provider unavailable'), { noCharge: mode === 'rejected' });
    return { choices: [{ message: { content: 'Keep me' } }], usage: { prompt_tokens: 30, completion_tokens: 20 } };
  });
  const cookie = await f.login('alice');
  assert.equal((await f.call('/api/query', { cookie, body: queryForm('first') })).status, 200);
  mode = 'rejected'; assert.equal((await f.call('/api/query', { cookie, body: queryForm('fail') })).status, 502);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM usage').get().n, 1);
  mode = 'uncertain'; assert.equal((await f.call('/api/query', { cookie, body: queryForm('unknown') })).status, 502);
  assert.equal(f.app.db.prepare("SELECT COUNT(*) n FROM usage WHERE status='uncertain'").get().n, 1);
  const result = await (await f.call('/api/state', { cookie })).json(); assert.equal(result.latest.answer, 'Keep me');
});

test('daily tokens, money, file count, size and text limits are enforced server-side', async t => {
  const f = await fixture(t), cookie = await f.login('alice');
  const set = limits => f.app.db.prepare('UPDATE users SET limits=? WHERE id=?').run(JSON.stringify(limits), f.ids.alice);
  set({ dailyTokens: 1000 }); assert.equal((await f.call('/api/query', { cookie, body: queryForm('test') })).status, 429);
  set({ dailyUSD: .00001 }); assert.equal((await f.call('/api/query', { cookie, body: queryForm('test') })).status, 429);
  set({ files: 1 }); assert.equal((await f.call('/api/query', { cookie, body: queryForm('test', [['a.txt','a'], ['b.txt','b']]) })).status, 400);
  set({ fileMB: 1 }); assert.equal((await f.call('/api/query', { cookie, body: queryForm('test', [['a.txt','a'.repeat(1024*1024+1)]]) })).status, 400);
  set({ inputTokens: 1000 }); assert.equal((await f.call('/api/query', { cookie, body: queryForm('ю'.repeat(1000)) })).status, 400);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
});

test('admin can create users, change limits, revoke sessions and block users', async t => {
  const f = await fixture(t), admin = await f.login('admin'), alice = await f.login('alice');
  assert.equal((await f.call('/api/admin/users', { cookie: admin, body: { login: 'charlie', name: 'Чарли', password } })).status, 201);
  const charlie = await f.login('charlie');
  assert.equal((await f.call('/api/query', { cookie: charlie, body: queryForm('test') })).status, 403);
  assert.equal((await f.call('/api/password', { cookie: charlie, body: { current: password, password: 'short' } })).status, 400);
  assert.equal((await f.call('/api/admin/limits', { cookie: admin, body: { ...defaults, dailyTokens: -1 } })).status, 400);
  assert.equal((await f.call('/api/admin/limits', { cookie: admin, body: { ...defaults, dailyTokens: 500000 } })).status, 200);
  await f.call('/api/heartbeat', { cookie: alice, method: 'POST' });
  const panel = await (await f.call('/api/admin', { cookie: admin })).json();
  assert.equal(panel.online, 3); assert.equal(panel.sessions[0].token, undefined);
  const aliceSession = panel.sessions.find(s => s.user_id === f.ids.alice);
  assert.equal((await f.call(`/api/admin/sessions/${aliceSession.id}`, { cookie: admin, method: 'DELETE' })).status, 200);
  assert.equal((await f.call('/api/state', { cookie: alice })).status, 401);
  const next = await f.login('alice');
  assert.equal((await f.call(`/api/admin/users/${f.ids.alice}`, { cookie: admin, method: 'PATCH', body: { blocked: true } })).status, 200);
  assert.equal((await f.call('/api/state', { cookie: next })).status, 401);
  assert.equal((await f.call(`/api/admin/users/${f.ids.admin}`, { cookie: admin, method: 'PATCH', body: { blocked: true } })).status, 400);
});

test('heartbeat expires from online count and repeated login on same browser is deduplicated', async t => {
  const f = await fixture(t), id = randomUUID(), admin = await f.login('admin');
  await f.login('alice', id); const cookie = await f.login('alice', id);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(f.ids.alice).n, 1);
  f.app.db.prepare('UPDATE sessions SET seen=? WHERE user_id=?').run(Date.now()-121000, f.ids.alice);
  let panel = await (await f.call('/api/admin', { cookie: admin })).json(); assert.equal(panel.online, 1);
  await f.call('/api/heartbeat', { cookie, method: 'POST' });
  panel = await (await f.call('/api/admin', { cookie: admin })).json(); assert.equal(panel.online, 2);
});

test('photo processing accepts real images and rejects renamed executable data', async t => {
  const f = await fixture(t);
  const file = { name: 'photo.jpg', path: path.join(f.directory, 'photo'), ext: '.jpg' };
  await writeFile(file.path, await sharp({ create: { width: 100, height: 100, channels: 3, background: '#123456' } }).jpeg().toBuffer());
  assert.match((await parseFile(file, 10000)).image, /^data:image\/jpeg;base64,/);
  await writeFile(file.path, 'not an image');
  await assert.rejects(parseFile(file, 10000));
});

test('daily reset follows the company timezone', () => {
  assert.equal(dayKey('Europe/Moscow', new Date('2026-09-25T20:59:59Z')), '2026-09-25');
  assert.equal(dayKey('Europe/Moscow', new Date('2026-09-25T21:00:00Z')), '2026-09-26');
});

test('DOCX, XLSX and text PDF contents are extracted without executing content', async t => {
  const f = await fixture(t);
  const docx = JSON.parse(await readFile(new URL('./docx-fixture.json', import.meta.url), 'utf8'));
  const wordFile = { name: 'report.docx', ext: '.docx', path: path.join(f.directory, 'word') };
  await writeFile(wordFile.path, Buffer.from(docx.base64, 'base64'));
  assert.match((await parseFile(wordFile, 32000)).text, /Quarterly revenue: 4200/);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Budget'); sheet.addRow(['Revenue', 4200]); sheet.addRow(['Formula', { formula: 'B1*2', result: 8400 }]);
  const sheetFile = { name: 'report.xlsx', ext: '.xlsx', path: path.join(f.directory, 'sheet') };
  await writeFile(sheetFile.path, await workbook.xlsx.writeBuffer());
  const extracted = (await parseFile(sheetFile, 32000)).text;
  assert.match(extracted, /Revenue\t4200/); assert.match(extracted, /8400/);
  const content = 'BT /F1 12 Tf 50 750 Td (Quarterly revenue: 4200) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pdfFile = { name: 'report.pdf', ext: '.pdf', path: path.join(f.directory, 'pdf') };
  await writeFile(pdfFile.path, pdf);
  assert.match((await parseFile(pdfFile, 32000)).text, /Quarterly revenue: 4200/);
});
