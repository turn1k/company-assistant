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
    db.prepare('INSERT INTO latest(user_id,id,prompt,answer,files,created) VALUES (?,?,?,?,?,?)').run('user','new-id','Next','Answer','[]',124);
    db.close(); db = openStore(directory);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM latest').get().n, 2);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db?.close(); await rm(directory, { recursive:true, force:true }); }
});
