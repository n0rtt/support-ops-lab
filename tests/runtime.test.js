import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

test('the pinned Node runtime provides working node:sqlite', () => {
  assert.equal(process.version, 'v24.15.0');
  assert.equal(typeof DatabaseSync, 'function');

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE runtime_check (value TEXT NOT NULL)');
    db.prepare('INSERT INTO runtime_check (value) VALUES (?)').run('available');
    assert.equal(db.prepare('SELECT value FROM runtime_check').get().value, 'available');
  } finally {
    db.close();
  }
});
