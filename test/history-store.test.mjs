import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';

test('legacy single-result migration is lossless, repeatable and allows multiple results', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'history-migration-'));
  let db;
  try {
    db = openStore(directory);
    db.prepare('INSERT INTO users(id,login,name,password,created) VALUES (?,?,?,?,?)').run('user', 'legacy', 'Legacy', 'test-hash', 1);
    db.exec('DROP TABLE latest; CREATE TABLE latest(user_id TEXT PRIMARY KEY REFERENCES users(id),id TEXT NOT NULL,prompt TEXT NOT NULL,answer TEXT NOT NULL,files TEXT NOT NULL,created INTEGER NOT NULL)');
    db.prepare('INSERT INTO latest VALUES (?,?,?,?,?,?)').run('user', 'old-id', 'Original prompt', 'Original answer', '[{"id":"file"}]', 123);
    db.close(); db = openStore(directory);
    const migrated = db.prepare('SELECT * FROM latest').get();
    assert.equal(migrated.id, 'old-id'); assert.equal(migrated.answer, 'Original answer');
    assert.equal(migrated.files, '[{"id":"file"}]'); assert.equal(migrated.context, null);
    assert.ok(migrated.chat_id); assert.equal(migrated.chat_title, 'Original prompt');
    db.prepare('INSERT INTO latest(user_id,id,prompt,answer,files,created,chat_id,chat_title) VALUES (?,?,?,?,?,?,?,?)').run('user','new-id','Next','Answer','[]',124,migrated.chat_id,migrated.chat_title);
    db.close(); db = openStore(directory);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM latest').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT chat_id) n FROM latest').get().n, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db?.close(); await rm(directory, { recursive:true, force:true }); }
});

test('existing multi-message history migrates into one chat per account without losing context', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-migration-'));
  let db;
  try {
    db = openStore(directory);
    for (const user of ['alice','bob']) db.prepare('INSERT INTO users(id,login,name,password,created) VALUES (?,?,?,?,?)').run(user,user,user,'hash',1);
    db.exec('DROP TABLE latest; CREATE TABLE latest(user_id TEXT NOT NULL REFERENCES users(id),id TEXT PRIMARY KEY,prompt TEXT NOT NULL,answer TEXT NOT NULL,files TEXT NOT NULL,created INTEGER NOT NULL,context TEXT)');
    const insert = db.prepare('INSERT INTO latest VALUES (?,?,?,?,?,?,?)');
    insert.run('alice','1','First question','Answer 1','[]',1,'[{"type":"text","text":"document"}]');
    insert.run('alice','2','Follow-up','Answer 2','[]',2,null);
    insert.run('bob','3','Other account','Answer 3','[]',1,null);
    db.close(); db = openStore(directory);
    const rows = db.prepare('SELECT * FROM latest ORDER BY id').all();
    assert.equal(rows.length,3); assert.equal(rows[0].chat_id,rows[1].chat_id);
    assert.notEqual(rows[0].chat_id,rows[2].chat_id);
    assert.equal(rows[1].chat_title,'First question'); assert.match(rows[0].context,/document/);
    const id = rows[0].chat_id;
    db.close(); db = openStore(directory);
    assert.equal(db.prepare('SELECT chat_id FROM latest WHERE id=?').get('1').chat_id,id);
  } finally { db?.close(); await rm(directory,{recursive:true,force:true}); }
});
