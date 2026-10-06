import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { hashPassword, dayKey, defaults } from '../lib/store.mjs';
import { parseFile, prepareContent } from '../lib/uploads.mjs';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { exportAnswer } from '../lib/exports.mjs';
import { budgetStored } from '../public/money.js';
import { ATTACHMENT_IDLE_MS, conversationContext } from '../lib/history.mjs';

const password = 'Test-only-password-123';
test('deleting employee revokes access, removes files and identity, preserves anonymous accounting', async t => {
  const f=await fixture(t), admin=await f.login('admin'), alice=await f.login('alice');
  const route='/api/admin/users/'+f.ids.alice;
  assert.equal((await f.call(route,{method:'DELETE'})).status,401);
  assert.equal((await f.call(route,{method:'DELETE',cookie:alice})).status,403);
  assert.equal((await f.call(route,{method:'DELETE',cookie:admin,origin:'https://evil.test'})).status,403);
  assert.equal((await f.call('/api/admin/users/'+f.ids.admin,{method:'DELETE',cookie:admin})).status,400);
  const result=await (await f.call('/api/query',{cookie:alice,body:queryForm('test',[['note.txt','hello']])})).json();
  const before=await (await f.call('/api/admin',{cookie:admin})).json();
  f.app.jobs.set(f.ids.alice,{phase:'test'});
  assert.equal((await f.call(route,{method:'DELETE',cookie:admin})).status,409);
  f.app.jobs.delete(f.ids.alice);
  assert.equal((await f.call(route,{method:'DELETE',cookie:admin})).status,200);
  assert.equal((await f.call('/api/state',{cookie:alice})).status,401);
  assert.equal((await f.call('/api/login',{body:{login:'alice',password,device:randomUUID()}})).status,401);
  assert.equal(f.app.db.prepare('SELECT id FROM users WHERE id=?').get(f.ids.alice),undefined);
  for(const table of ['latest','sessions','usage']) assert.equal(f.app.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(f.ids.alice).n,0);
  await assert.rejects(access(path.join(f.directory,'uploads',result.latest.id)));
  const after=await (await f.call('/api/admin',{cookie:admin})).json();
  assert.equal(after.users.length,2);
  assert.equal(after.deletedUsage.month.usd,before.users.find(u=>u.id===f.ids.alice).month.usd);
  assert.equal(after.deletedUsage.today.tokens,150);
  assert.equal((await f.call(route,{method:'DELETE',cookie:admin})).status,404);
  assert.equal((await f.call('/api/admin/users',{cookie:admin,body:{login:'alice',email:'alice@example.test',name:'New employee',password}})).status,201);
});
test('admin model switch persists and in-flight requests keep their original model tariff', async t => {
  const old=process.env.ACCOUNTING_RUB_PER_USD;
  process.env.ACCOUNTING_RUB_PER_USD='100';
  t.after(()=>{if(old===undefined) delete process.env.ACCOUNTING_RUB_PER_USD; else process.env.ACCOUNTING_RUB_PER_USD=old;});
  let release, entered;
  const started=new Promise(r=>entered=r);
  const gate=new Promise(r=>release=r);
  const bodies=[];
  const f=await fixture(t,null,{provider:undefined,apiKey:'fake-key',baseURL:'https://api.ranvik.ru/v1',providerFetch:async(url,opts)=>{
    bodies.push(JSON.parse(opts.body));
    if(bodies.length===1){entered();await gate;}
    return Response.json({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:100,completion_tokens:50}});
  }});
  const admin=await f.login('admin'), alice=await f.login('alice');
  assert.equal((await f.call('/api/admin/model',{body:{model:'gpt-6-luna'}})).status,401);
  assert.equal((await f.call('/api/admin/model',{cookie:alice,body:{model:'gpt-6-luna'}})).status,403);
  assert.equal((await f.call('/api/admin/model',{cookie:admin,origin:'https://evil.test',body:{model:'gpt-6-luna'}})).status,403);
  assert.equal((await f.call('/api/admin/model',{cookie:admin,body:{model:'other'}})).status,400);
  assert.equal((await f.call('/api/admin/model',{cookie:admin,body:{model:'gpt-6-luna'}})).status,200);
  const pending=f.call('/api/query',{cookie:alice,body:queryForm('test')});
  await started;
  assert.equal((await f.call('/api/admin/model',{cookie:admin,body:{model:'claude-sonnet-5-5'}})).status,200);
  release();
  assert.equal((await pending).status,200);
  assert.equal(bodies[0].model,'gpt-6-luna');
  assert.equal(bodies[0].reasoning_effort,'none');
  let usage=f.app.db.prepare('SELECT usd FROM usage').get();
  assert.ok(Math.abs(usage.usd-(100*33.25+50*166)/1e8)<1e-12);
  assert.equal((await f.call('/api/query',{cookie:alice,body:queryForm('second')})).status,200);
  assert.equal(bodies[1].model,'claude-sonnet-5-5');
  assert.equal(bodies[1].reasoning_effort,undefined);
  const report=await (await f.call('/api/admin',{cookie:admin})).json();
  assert.equal(report.apiProvider,'Ranvik'); assert.equal(report.modelName,'Claude Sonnet 5.5');
  assert.equal(report.prices.input,2.66);
  const sum=f.app.db.prepare('SELECT SUM(usd) total FROM usage').get().total;
  assert.ok(Math.abs(sum-((100*33.25+50*166)+(100*266+50*1330))/1e8)<1e-12);
  const reopened=await createApplication({dataDir:f.directory,origin:'http://localhost',baseURL:'https://api.ranvik.ru/v1',apiKey:'fake-key'});
  try {assert.equal(reopened.db.prepare("SELECT value FROM settings WHERE key='model'").get().value,'claude-sonnet-5-5');} finally {await reopened.close();}
});
async function fixture(t, provider, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'company-assistant-test-'));
  const app = await createApplication({ dataDir: directory, origin: 'http://localhost', provider: provider || (async () => ({ choices: [{ message: { content: 'Проверенный ответ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })), ...options });
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
function queryForm(prompt, files = [], chatId) { const data = new FormData(); data.append('prompt', prompt); if (chatId !== undefined) data.append('chatId', chatId); for (const [name, contents, type] of files) data.append('files', new Blob([contents], { type: type || 'text/plain' }), name); return data; }

test('ruble display metadata and converted budgets enforce limits before provider calls', async t => {
  const env = { DISPLAY_CURRENCY:'RUB', ACCOUNTING_RUB_PER_USD:'84.4283', INPUT_USD_PER_MILLION:String(33.25/84.4283), OUTPUT_USD_PER_MILLION:String(166/84.4283) };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; } });
  let calls=0;
  const f=await fixture(t, async()=>{calls++; return {choices:[{message:{content:'OK'}}],usage:{prompt_tokens:100,completion_tokens:50}};});
  const cookie=await f.login('alice');
  const state=await (await f.call('/api/state',{cookie})).json();
  assert.deepEqual(state.billing,{currency:'RUB',rubPerUSD:84.4283});
  f.app.db.prepare('UPDATE users SET limits=? WHERE id=?').run(JSON.stringify({dailyUSD:budgetStored(.85,state.billing)}),f.ids.alice);
  assert.equal((await f.call('/api/query',{cookie,body:queryForm('test')})).status,429);
  assert.equal(calls,0);
  f.app.db.prepare('UPDATE users SET limits=? WHERE id=?').run(JSON.stringify({dailyUSD:budgetStored(100,state.billing)}),f.ids.alice);
  const response=await f.call('/api/query',{cookie,body:queryForm('test')});
  assert.equal(response.status,200); assert.equal(calls,1);
  assert.ok(Math.abs((await response.json()).usage.usd*84.4283-.011625)<1e-10);
  assert.equal((await f.call('/money.js')).status,200);
});

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

test('monitoring summary is admin-only and excludes notification secrets', async t => {
  const old=process.env.MONITOR_STATUS_FILE;
  t.after(()=>{if(old===undefined)delete process.env.MONITOR_STATUS_FILE;else process.env.MONITOR_STATUS_FILE=old;});
  const f=await fixture(t);
  process.env.MONITOR_STATUS_FILE=path.join(f.directory,'monitor.json');
  await writeFile(process.env.MONITOR_STATUS_FILE,JSON.stringify({checkedAt:Date.now(),checks:{app:true},telegramConfigured:true,deliveryPending:false,token:'must-not-leak',chat_id:'private'}));
  const admin=await f.login('admin'),alice=await f.login('alice');
  assert.equal((await f.call('/api/admin',{cookie:alice})).status,403);
  const response=await f.call('/api/admin',{cookie:admin}),text=await response.text();
  assert.equal(JSON.parse(text).monitoring.checks.app,true);
  assert.ok(!text.includes('must-not-leak'));assert.ok(!text.includes('chat_id'));
});

test('ten successful results survive; the eleventh removes the oldest files and exports, isolated per account', async t => {
  const f = await fixture(t), alice = await f.login('alice'), bob = await f.login('bob');
  const firstResponse = await f.call('/api/query', { cookie: alice, body: queryForm('Прочитай', [['one.txt', 'First document']]) });
  assert.equal(firstResponse.status, 200, JSON.stringify(await firstResponse.clone().json()));
  const first = (await firstResponse.json()).latest;
  assert.equal((await f.call(`/api/files/${first.files[0].id}`, { cookie: bob })).status, 404);
  assert.equal(await (await f.call(`/api/files/${first.files[0].id}`, { cookie: alice })).text(), 'First document');
  const next = await f.call('/api/query', { cookie: alice, body: queryForm('Второй запрос') });
  assert.equal(next.status, 200);
  assert.equal((await f.call(`/api/files/${first.files[0].id}`, { cookie: alice })).status, 200);
  for (let i = 3; i <= 10; i++) assert.equal((await f.call('/api/query', { cookie: alice, body: queryForm(`Запрос ${i}`) })).status, 200);
  assert.equal((await f.call(`/api/exports/${first.id}.docx`, { cookie: alice })).status, 200);
  assert.equal((await f.call('/api/query', { cookie: alice, body: queryForm('Запрос 11') })).status, 200);
  assert.equal((await f.call(`/api/files/${first.files[0].id}`, { cookie: alice })).status, 404);
  assert.equal((await f.call(`/api/exports/${first.id}.docx`, { cookie: alice })).status, 404);
  await assert.rejects(access(path.join(f.directory, 'uploads', first.id)));
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM latest').get().n, 10);
  const state = await (await f.call('/api/state', { cookie: alice })).json();
  assert.equal(state.history.length, 10); assert.equal(state.history[0].prompt, 'Запрос 11');
  assert.equal(state.history.at(-1).prompt, 'Второй запрос');
  assert.equal(state.chats.length, 1); assert.equal(state.chats[0].title, 'Прочитай');
  assert.equal((await (await f.call('/api/state', { cookie: bob })).json()).history.length, 0);
  assert.equal(f.app.db.prepare('SELECT SUM(input+output) n FROM usage').get().n, 1650);
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

test('Luna HTTP contract sends documents and photos, disables storage, bills usage and handles rejection', async t => {
  let mode = 'ok', request;
  const f = await fixture(t, null, { provider: undefined, apiKey: 'test-only-not-a-real-key', providerFetch: async (url, init) => {
    request = JSON.parse(init.body);
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-only-not-a-real-key');
    if (mode === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    if (mode === 'quota') return Response.json({ error: { code: 'insufficient_quota', message: 'do not expose raw provider text' } }, { status: 429 });
    if (mode === 'key') return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
    return Response.json({ choices: [{ message: { content: 'Luna answer' }, finish_reason: 'length' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  } });
  const cookie = await f.login('alice');
  const photo = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const response = await f.call('/api/query', { cookie, body: queryForm('Read these', [['doc.txt', 'Document content'], ['photo.png', photo, 'image/png']]) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.reasoning_effort, 'none');
  assert.equal(request.max_completion_tokens, defaults.outputTokens);
  assert.equal(request.max_tokens, undefined);
  assert.equal(request.thinking, undefined);
  assert.equal(request.store, false);
  assert.equal(request.service_tier, 'default');
  assert.match(request.messages.at(-1).content.find(x => x.text?.includes('Document content')).text, /doc.txt/);
  assert.equal(request.messages.at(-1).content.find(x => x.type === 'image_url').image_url.detail, 'high');
  assert.match(body.latest.answer, /лимиту выходных токенов/);
  assert.ok(Math.abs(body.usage.usd - 0.00015) < 1e-10);
  for (const [failure, status, message] of [['quota', 502, /баланс или бюджет/], ['key', 502, /API-ключ/], ['timeout', 504, /вовремя/]]) {
    mode = failure;
    const failed = await f.call('/api/query', { cookie, body: queryForm('fail') });
    assert.equal(failed.status, status);
    assert.match((await failed.json()).error, message);
    assert.equal(f.app.db.prepare('SELECT id FROM latest WHERE user_id=?').get(f.ids.alice).id, body.latest.id);
  }
  assert.equal(f.app.db.prepare("SELECT COUNT(*) n FROM usage WHERE status='uncertain'").get().n, 1);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM usage').get().n, 2);
});

test('office exports contain Cyrillic text and inert spreadsheet cells', async () => {
  const answer = '# План работы\nПривет, команда & коллеги!\n\n| Задача | Сумма |\n| --- | --- |\n| Закупки | 1200 |\n| =HYPERLINK("https://example.test") | 300 |';
  const word = await exportAnswer(answer, 'docx');
  assert.equal(word.buffer.subarray(0, 2).toString(), 'PK');
  const extracted = await mammoth.extractRawText({ buffer: word.buffer });
  assert.match(extracted.value, /План работы/); assert.match(extracted.value, /Привет, команда & коллеги!/); assert.match(extracted.value, /Закупки/);
  const excel = await exportAnswer(answer, 'xlsx');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(excel.buffer);
  assert.equal(workbook.worksheets.length, 2);
  assert.equal(workbook.getWorksheet('Таблица 1').getCell('A3').value, '=HYPERLINK("https://example.test")');
  assert.equal(workbook.getWorksheet('Таблица 1').getCell('A3').type, ExcelJS.ValueType.String);
  assert.equal(workbook.getWorksheet('Ответ').getCell('A1').value, '# План работы');
  await assert.rejects(exportAnswer('x'.repeat(500001), 'docx'), /слишком большой/);
});

test('exports require own retained result, authentication and a changed password', async t => {
  const f = await fixture(t), cookie = await f.login('alice'), other = await f.login('bob');
  const first = (await (await f.call('/api/query', { cookie, body: queryForm('Документ') })).json()).latest;
  const route = `/api/exports/${first.id}.docx`;
  assert.equal((await f.call(route)).status, 401);
  assert.equal((await f.call(route, { cookie: other })).status, 404);
  const download = await f.call(route, { cookie });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match((await mammoth.extractRawText({ buffer: Buffer.from(await download.arrayBuffer()) })).value, /Проверенный ответ/);
  assert.equal((await f.call(`/api/exports/${first.id}.xlsx`, { cookie })).status, 200);
  assert.equal((await f.call(`/api/exports/${first.id}.exe`, { cookie })).status, 404);
  f.app.db.prepare('UPDATE users SET must_change=1 WHERE id=?').run(f.ids.alice);
  assert.equal((await f.call(route, { cookie })).status, 403);
  f.app.db.prepare('UPDATE users SET must_change=0 WHERE id=?').run(f.ids.alice);
  await f.call('/api/query', { cookie, body: queryForm('Следующий') });
  assert.equal((await f.call(route, { cookie })).status, 200);
});

test('conversation includes at most five private pairs and retained document content', async t => {
  let sentHistory;
  const f = await fixture(t, async (content, max, history) => {
    sentHistory = history;
    return { choices: [{ message: { content: 'Ответ ' + content[0].text } }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
  });
  const cookie = await f.login('alice'), bob = await f.login('bob');
  for (let i = 0; i < 7; i++) {
    assert.equal((await f.call('/api/query', { cookie, body: queryForm(String(i), i === 5 ? [['source.txt', 'Secret document detail 789']] : []) })).status, 200);
  }
  assert.equal(sentHistory.length, 10);
  assert.equal(sentHistory[0].content, '1'); assert.equal(sentHistory.at(-1).content, 'Ответ 5');
  assert.match(JSON.stringify(sentHistory), /Secret document detail 789/);
  const state = await (await f.call('/api/state', { cookie })).json();
  assert.ok(!JSON.stringify(state).includes('Secret document detail 789'));
  await f.call('/api/query', { cookie: bob, body: queryForm('Other account') });
  assert.deepEqual(sentHistory, []);
});

test('24-hour idle cleanup removes original files and parsed context, preserves text and exports', async t => {
  const f = await fixture(t), cookie = await f.login('alice');
  const first = (await (await f.call('/api/query', { cookie, body: queryForm('Документ', [['source.txt','Heavy private content']]) })).json()).latest;
  const start = first.created;
  await f.app.cleanupHistory(start + ATTACHMENT_IDLE_MS - 1);
  await access(path.join(f.directory, 'uploads', first.id));
  f.app.jobs.set(f.ids.alice, { phase: 'Working' });
  await f.app.cleanupHistory(start + ATTACHMENT_IDLE_MS);
  await access(path.join(f.directory, 'uploads', first.id));
  f.app.jobs.delete(f.ids.alice);
  await f.app.cleanupHistory(start + ATTACHMENT_IDLE_MS);
  await assert.rejects(access(path.join(f.directory, 'uploads', first.id)));
  const row = f.app.db.prepare('SELECT * FROM latest WHERE id=?').get(first.id);
  assert.equal(row.context, null); assert.equal(row.answer, first.answer);
  assert.equal(JSON.parse(row.files)[0].expired, true);
  assert.equal((await f.call(`/api/files/${first.files[0].id}`, { cookie })).status, 404);
  assert.equal((await f.call(`/api/exports/${first.id}.docx`, { cookie })).status, 200);
  assert.equal((await f.call(`/api/exports/${first.id}.xlsx`, { cookie })).status, 200);
  await f.app.cleanupHistory(start + ATTACHMENT_IDLE_MS + 1);
});

test('context budget preserves new input and complete pairs, omits oversized old attachments', () => {
  const row = { prompt: 'Before', answer: 'Answer', files: '[{"name":"photo.png"}]', context: JSON.stringify([{type:'image_url',image_url:{url:'data:image/png;base64,abc'}}]) };
  const result = conversationContext([row], { upperBound: 600 }, 2000);
  assert.equal(result.messages.length, 2); assert.equal(result.omittedAttachments, true);
  assert.ok(result.upperBound <= 2000); assert.ok(!JSON.stringify(result).includes('base64'));
  assert.equal(conversationContext([row], { upperBound: 1999 }, 2000).messages.length, 0);
  assert.equal(conversationContext([{ ...row, files:'[]', prompt:'x'.repeat(2000) }], { upperBound:600 }, 2000).messages.length, 0);
});

test('a new successful request extends attachment retention for the whole conversation', async t => {
  const f = await fixture(t), cookie = await f.login('alice');
  const first = (await (await f.call('/api/query', { cookie, body: queryForm('Первый', [['old.txt','Keep during active chat']]) })).json()).latest;
  f.app.db.prepare('UPDATE latest SET created=? WHERE id=?').run(Date.now() - ATTACHMENT_IDLE_MS + 60000, first.id);
  const next = (await (await f.call('/api/query', { cookie, body: queryForm('Продолжить') })).json()).latest;
  await f.app.cleanupHistory(next.created + 120000);
  await access(path.join(f.directory, 'uploads', first.id));
  assert.ok(f.app.db.prepare('SELECT context FROM latest WHERE id=?').get(first.id).context);
});

test('chat list uses first prompt only, resumes selected chat and isolates context and ownership', async t => {
  const calls = [];
  const f = await fixture(t, async (content, max, history) => {
    calls.push({ prompt:content[0].text, history });
    return { choices:[{message:{content:'Ответ '+content[0].text}}],usage:{prompt_tokens:20,completion_tokens:10} };
  });
  const cookie = await f.login('alice'), bob = await f.login('bob');
  async function send(prompt, chatId) {
    const response = await f.call('/api/query',{cookie,body:queryForm(prompt,[],chatId)});
    assert.equal(response.status,200); return response.json();
  }
  const first = await send('Первый разговор', 'new'), chatA = first.latest.chatId;
  const followup = await send('Уточнение A', chatA);
  assert.equal(followup.chats.length,1); assert.equal(followup.chats[0].title,'Первый разговор');
  assert.equal(calls[1].history[0].content,'Первый разговор');
  const second = await send('Другой разговор', 'new'), chatB = second.latest.chatId;
  assert.notEqual(chatA,chatB); assert.deepEqual(calls[2].history,[]);
  assert.equal(second.chats.length,2);
  const resumed = await send('Продолжение A', chatA);
  assert.equal(resumed.latest.chatId,chatA); assert.equal(resumed.chats[0].title,'Первый разговор');
  assert.equal(calls[3].history.length,4); assert.ok(!JSON.stringify(calls[3].history).includes('Другой разговор'));
  const count = calls.length;
  assert.equal((await f.call('/api/query',{cookie:bob,body:queryForm('Чужой чат',[],chatA)})).status,404);
  assert.equal((await f.call('/api/query',{cookie,body:queryForm('Несуществующий',[],randomUUID())})).status,404);
  assert.equal((await f.call('/api/query',{cookie,body:queryForm('Некорректный',[],'invalid')})).status,400);
  assert.equal(calls.length,count);
});

test('failed new chats do not appear in history and do not change existing chat titles', async t => {
  let reject = false;
  const f = await fixture(t,async () => {
    if (reject) throw Object.assign(new Error('Rejected'),{noCharge:true});
    return { choices:[{message:{content:'Ответ'}}],usage:{prompt_tokens:20,completion_tokens:10} };
  });
  const cookie = await f.login('alice');
  const first = await (await f.call('/api/query',{cookie,body:queryForm('Сохранённый чат',[],'new')})).json();
  reject = true;
  assert.equal((await f.call('/api/query',{cookie,body:queryForm('Неудачный новый чат',[],'new')})).status,502);
  const state = await (await f.call('/api/state',{cookie})).json();
  assert.deepEqual(state.chats,first.chats); assert.equal(state.history.length,1);
});

test('attachment inactivity is measured per chat, not per account', async t => {
  const f = await fixture(t), cookie = await f.login('alice');
  const first = (await (await f.call('/api/query',{cookie,body:queryForm('Чат A',[['a.txt','File A']],'new')})).json()).latest;
  f.app.db.prepare('UPDATE latest SET created=? WHERE id=?').run(Date.now()-ATTACHMENT_IDLE_MS+60000, first.id);
  const second = (await (await f.call('/api/query',{cookie,body:queryForm('Чат B',[['b.txt','File B']],'new')})).json()).latest;
  await f.app.cleanupHistory(second.created+120000);
  await assert.rejects(access(path.join(f.directory,'uploads',first.id)));
  await access(path.join(f.directory,'uploads',second.id));
  assert.equal(f.app.db.prepare('SELECT context FROM latest WHERE id=?').get(first.id).context,null);
  assert.ok(f.app.db.prepare('SELECT context FROM latest WHERE id=?').get(second.id).context);
  assert.equal((await f.call(`/api/exports/${first.id}.docx`,{cookie})).status,200);
});

test('deleting a chat removes its messages, files and exports but preserves other chats and accounting', async t => {
  const f = await fixture(t), cookie = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('admin');
  const first = (await (await f.call('/api/query',{cookie,body:queryForm('Delete this',[['a.txt','A']],'new')})).json()).latest;
  const followup = (await (await f.call('/api/query',{cookie,body:queryForm('Follow-up',[['b.txt','B']],first.chatId)})).json()).latest;
  const keep = (await (await f.call('/api/query',{cookie,body:queryForm('Keep this',[['c.txt','C']],'new')})).json()).latest;
  const route = `/api/chats/${first.chatId}`;
  assert.equal((await f.call(route,{method:'DELETE'})).status,401);
  assert.equal((await f.call(route,{cookie:bob,method:'DELETE'})).status,404);
  assert.equal((await f.call(route,{cookie:admin,method:'DELETE'})).status,404);
  assert.equal((await f.call(route,{cookie,method:'DELETE',origin:'https://evil.test'})).status,403);
  const response = await f.call(route,{cookie,method:'DELETE'});
  assert.equal(response.status,200);
  const state = await response.json(); assert.equal(state.chats.length,1); assert.equal(state.chats[0].id,keep.chatId);
  assert.equal(state.history.length,1); assert.equal(state.usage.tokens,450);
  for (const result of [first,followup]) {
    await assert.rejects(access(path.join(f.directory,'uploads',result.id)));
    assert.equal((await f.call(`/api/files/${result.files[0].id}`,{cookie})).status,404);
    assert.equal((await f.call(`/api/exports/${result.id}.docx`,{cookie})).status,404);
  }
  assert.equal((await f.call(`/api/files/${keep.files[0].id}`,{cookie})).status,200);
  assert.equal((await f.call(route,{cookie,method:'DELETE'})).status,404);
  const empty = await (await f.call(`/api/chats/${keep.chatId}`,{cookie,method:'DELETE'})).json();
  assert.deepEqual(empty.chats,[]); assert.deepEqual(empty.history,[]); assert.equal(empty.latest,null);
});

test('chat deletion is rejected during an in-flight request', async t => {
  let release, reached;
  const gate = new Promise(resolve=>release=resolve), entered = new Promise(resolve=>reached=resolve);
  const f = await fixture(t,async content=>{
    if (content[0].text === 'Wait') { reached(); await gate; }
    return {choices:[{message:{content:'Answer'}}],usage:{prompt_tokens:10,completion_tokens:10}};
  });
  const cookie = await f.login('alice');
  const first = (await (await f.call('/api/query',{cookie,body:queryForm('Start',[],'new')})).json()).latest;
  const running = f.call('/api/query',{cookie,body:queryForm('Wait',[],first.chatId)});
  await entered;
  try { assert.equal((await f.call(`/api/chats/${first.chatId}`,{cookie,method:'DELETE'})).status,409); }
  finally { release(); }
  assert.equal((await running).status,200);
  const state = await (await f.call('/api/state',{cookie})).json(); assert.equal(state.history.length,2);
});

test('Ranvik base URL uses compatible auth and preserves selected model', async t => {
  const saved = [process.env.INPUT_USD_PER_MILLION, process.env.OUTPUT_USD_PER_MILLION];
  process.env.INPUT_USD_PER_MILLION = '1'; process.env.OUTPUT_USD_PER_MILLION = '2';
  t.after(() => { ['INPUT_USD_PER_MILLION','OUTPUT_USD_PER_MILLION'].forEach((key,i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); });
  let sent = false;
  const f = await fixture(t, null, { provider: undefined, apiKey: 'test-only', baseURL: 'https://api.ranvik.ru/v1/', providerFetch: async (url, init) => {
    sent = true; assert.equal(url, 'https://api.ranvik.ru/v1/chat/completions'); assert.equal(init.headers.Authorization, 'Bearer test-only');
    const request = JSON.parse(init.body); assert.equal(request.model, 'gpt-6-luna'); assert.equal(request.service_tier, undefined); assert.equal(request.reasoning_effort, 'none'); assert.equal(request.store, false);
    assert.equal(request.max_completion_tokens, defaults.outputTokens);
    return Response.json({ choices: [{ message: { content: 'Ответ' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  } });
  const cookie = await f.login('alice');
  const response = await f.call('/api/query', { cookie, body: queryForm('Тест') });
  assert.equal(response.status, 200); assert.ok(sent);
  assert.equal((await response.json()).usage.usd, 0.0002);
});


test('scanned PDF pages render as images in order and respect request limits', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-scan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drawing = 'q 100 0 0 100 20 20 cm /Im1 Do Q';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream',
    '<< /Length '+drawing.length+' >>\nstream\n'+drawing+'\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 39 >>\nstream\nBT /F1 12 Tf 20 100 Td (Page two) Tj ET\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += (i+1)+' 0 obj\n'+obj+'\nendobj\n'; });
  const xref=Buffer.byteLength(pdf);
  pdf += 'xref\n0 9\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  const file = { path: path.join(directory, 'scan.pdf'), name: 'scan.pdf', ext: '.pdf' };
  await writeFile(file.path, pdf);
  const parsed = await parseFile(file, 32000);
  assert.deepEqual(parsed.parts.map(p=>p.type), ['text','image_url','text']);
  assert.match(parsed.parts[2].text, /Page two/);
  const image=Buffer.from(parsed.parts[1].image_url.url.split(',')[1], 'base64');
  const pixel=await sharp(image).extract({left:50,top:250,width:1,height:1}).raw().toBuffer();
  assert.ok(pixel[0] > 200 && pixel[1] < 50, 'scan image retains its red pixels');
  const prepared=await prepareContent('Read all pages', [file], 32000);
  assert.equal(prepared.content.filter(p=>p.type==='image_url').length,1);
  assert.ok(prepared.upperBound>8192);
  await assert.rejects(prepareContent('Read', [file], 8000), /лимит/);
});


test('20 employees run concurrently, overload is rejected and results remain isolated', { timeout: 20000 }, async t => {
  let active = 0, peak = 0, entered = 0, release, ready;
  const gate = new Promise(resolve => { release = resolve; });
  const allEntered = new Promise(resolve => { ready = resolve; });
  t.after(() => release());
  const f = await fixture(t, async content => {
    active++; entered++; peak = Math.max(peak, active);
    if (entered === 20) ready();
    await gate;
    active--;
    return { choices: [{ message: { content: content[0].text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
  });
  const hash = f.app.db.prepare('SELECT password FROM users WHERE login=?').get('alice').password;
  const cookies = [];
  for (let i=0; i<20; i++) {
    const login='load-'+i;
    f.app.db.prepare('INSERT INTO users(id,login,name,password,role,must_change,created) VALUES (?,?,?,?,?,0,?)').run(randomUUID(),login,login,hash,'user',Date.now());
    cookies.push(await f.login(login));
  }
  const extra = await f.login('bob');
  const start = performance.now();
  const requests = cookies.map((cookie,i) => f.call('/api/query', { cookie, body: queryForm('Private answer '+i, i%4===0 ? [['note.txt','Sample document '+i]] : []) }));
  const timeout = setTimeout(() => ready(), 8000);
  await allEntered; clearTimeout(timeout);
  assert.equal(entered,20);
  assert.equal(peak,20);
  const healthStart=performance.now();
  assert.equal((await f.call('/health')).status,200);
  const healthMs=Math.round(performance.now()-healthStart);
  assert.equal((await f.call('/api/query', { cookie: cookies[0], body: queryForm('duplicate') })).status,409);
  assert.equal((await f.call('/api/query', { cookie: extra, body: queryForm('overload') })).status,503);
  release();
  const responses = await Promise.all(requests);
  for(let i=0;i<responses.length;i++) {
    assert.equal(responses[i].status,200);
    assert.equal((await responses[i].json()).latest.answer,'Private answer '+i);
    const state=await (await f.call('/api/state',{cookie:cookies[i]})).json();
    assert.equal(state.latest.answer,'Private answer '+i);
    assert.equal(state.usage.tokens,150);
  }
  assert.equal((await f.call('/api/query',{cookie:extra,body:queryForm('After capacity frees')})).status,200);
  t.diagnostic('20 concurrent mock-model requests: '+Math.round(performance.now()-start)+' ms; health while busy: '+healthMs+' ms. This does not measure Ranvik throughput.');
});
