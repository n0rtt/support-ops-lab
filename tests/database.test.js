import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  demoDatabasePath,
  initializeDatabase,
  openDatabase,
  resetDemoDatabase,
  runIdempotentMutation,
  StaleCaseError,
  IdempotencyKeyReusedError,
} from '../server/database.js';
import { temporaryDatabase } from './helpers.js';

test('initialization migrates and seeds once without replacing existing records', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  t.after(() => db.close());

  initializeDatabase(db);
  initializeDatabase(db);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name),
    ['activities', 'cases', 'mutation_receipts'],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cases').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 3);

  db.prepare("UPDATE cases SET status = 'resolved', version = 4 WHERE id = ?").run('SEW-1001');
  initializeDatabase(db);
  assert.deepEqual(
    { ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1001') },
    { status: 'resolved', version: 4 },
  );
});

test('mutation commit, rollback, receipt replay, collision, and stale versions persist', (t) => {
  const { databasePath } = temporaryDatabase(t);
  let db = openDatabase(databasePath);
  initializeDatabase(db);

  const context = {
    requestKey: 'request-1001',
    method: 'PATCH',
    route: '/api/cases/SEW-1001/status',
    payload: { status: 'in_progress', note: 'starting review' },
    caseId: 'SEW-1001',
    expectedVersion: 1,
  };
  assert.throws(
    () => runIdempotentMutation(db, { ...context, payload: null }, () => null),
    /JSON object/,
  );
  const mutate = (connection) => {
    connection
      .prepare('UPDATE cases SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run('in_progress', '2026-10-20T10:00:00.000Z', 'SEW-1001', 1);
    connection
      .prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(
        'ACT-SEW-1001-STATUS',
        'SEW-1001',
        '2026-10-20T10:00:00.000Z',
        'status_changed',
        JSON.stringify({ from: 'open', to: 'in_progress' }),
      );
    return { caseId: 'SEW-1001', status: 'in_progress', version: 2 };
  };

  assert.throws(
    () =>
      runIdempotentMutation(
        db,
        { ...context, requestKey: 'request-failure' },
        (connection) => {
          mutate(connection);
          throw new Error('injected failure');
        },
      ),
    /injected failure/,
  );
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);

  assert.deepEqual(runIdempotentMutation(db, context, mutate), {
    replayed: false,
    response: { caseId: 'SEW-1001', status: 'in_progress', version: 2 },
  });
  db.close();

  db = openDatabase(databasePath);
  initializeDatabase(db);
  assert.deepEqual(
    { ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1001') },
    { status: 'in_progress', version: 2 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 4);

  assert.deepEqual(
    runIdempotentMutation(
      db,
      {
        ...context,
        payload: { note: 'starting review', status: 'in_progress' },
      },
      () => {
        throw new Error('a replay must not run the mutation again');
      },
    ),
    { replayed: true, response: { caseId: 'SEW-1001', status: 'in_progress', version: 2 } },
  );
  assert.throws(
    () => runIdempotentMutation(db, { ...context, payload: { status: 'resolved' } }, mutate),
    IdempotencyKeyReusedError,
  );
  assert.throws(
    () =>
      runIdempotentMutation(
        db,
        { ...context, requestKey: 'request-stale' },
        mutate,
      ),
    StaleCaseError,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 1);
});

test('reset confirmation and path guards leave unrelated files untouched', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'supportops-reset-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const unrelatedPath = join(directory, 'unrelated.sqlite');
  writeFileSync(unrelatedPath, 'keep this file');

  assert.notEqual(demoDatabasePath, unrelatedPath);
  assert.throws(
    () => resetDemoDatabase({ databasePath: unrelatedPath, confirmed: true }),
    /restricted to this project’s demo database/,
  );
  assert.throws(() => resetDemoDatabase(), /--confirm flag/);
  assert.equal(readFileSync(unrelatedPath, 'utf8'), 'keep this file');
});
