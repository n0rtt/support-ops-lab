import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    return {
      changed: true,
      response: { caseId: 'SEW-1001', status: 'in_progress', version: 2 },
    };
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
  let staleCallbackRan = false;
  assert.throws(
    () => runIdempotentMutation(db, { ...context, requestKey: 'request-stale' }, (connection) => {
      staleCallbackRan = true;
      return mutate(connection);
    }),
    StaleCaseError,
  );
  assert.equal(staleCallbackRan, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 1);

  const noOpContext = { ...context, requestKey: 'request-noop', expectedVersion: 2 };
  assert.deepEqual(
    runIdempotentMutation(db, noOpContext, () => ({ changed: false, response: { unchanged: true } })),
    { replayed: false, response: { unchanged: true } },
  );
  assert.deepEqual(
    runIdempotentMutation(db, noOpContext, () => {
      throw new Error('a no-op receipt replay must not call the callback');
    }),
    { replayed: true, response: { unchanged: true } },
  );
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 2);
});

test('mutation callbacks must report changes and advance the case version or roll back', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());

  const context = {
    requestKey: 'request-missing-version',
    method: 'PATCH',
    route: '/api/cases/SEW-1001/status',
    payload: { status: 'in_progress' },
    caseId: 'SEW-1001',
    expectedVersion: 1,
  };

  assert.throws(
    () => runIdempotentMutation(db, context, (connection) => {
      connection.prepare('UPDATE cases SET status = ? WHERE id = ?').run('in_progress', 'SEW-1001');
      connection
        .prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload) VALUES (?, ?, ?, ?, ?)')
        .run('ACT-MISSING-VERSION', 'SEW-1001', '2026-10-20T10:00:00.000Z', 'status_changed', '{}');
      return { changed: true, response: { status: 'in_progress' } };
    }),
    /advance the case version exactly once/,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1001') },
    { status: 'open', version: 1 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);

  assert.throws(
    () => runIdempotentMutation(db, { ...context, requestKey: 'request-writing-noop' }, (connection) => {
      connection.prepare('UPDATE cases SET status = ? WHERE id = ?').run('in_progress', 'SEW-1001');
      return { changed: false, response: { unchanged: true } };
    }),
    /No-op mutation callbacks must not write/,
  );
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get('SEW-1001').status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
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

test('demo database opening rejects a dangling symlink before SQLite can create its target', async (t) => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'supportops-symlink-project-'));
  t.after(() => rmSync(projectDirectory, { recursive: true, force: true }));
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'supportops-symlink-target-'));
  t.after(() => rmSync(outsideDirectory, { recursive: true, force: true }));
  const serverDirectory = join(projectDirectory, 'server');
  const fixtureDirectory = join(projectDirectory, 'fixtures');
  const dataDirectory = join(projectDirectory, 'data');
  mkdirSync(serverDirectory);
  mkdirSync(fixtureDirectory);
  mkdirSync(dataDirectory);
  writeFileSync(join(projectDirectory, 'package.json'), '{"type":"module"}\n');
  copyFileSync(new URL('../server/database.js', import.meta.url), join(serverDirectory, 'database.js'));
  copyFileSync(new URL('../fixtures/cases.js', import.meta.url), join(fixtureDirectory, 'cases.js'));

  const targetPath = join(outsideDirectory, 'supportops.sqlite');
  const databasePath = join(dataDirectory, 'supportops.sqlite');
  symlinkSync(targetPath, databasePath);
  const isolatedDatabase = await import(pathToFileURL(join(serverDirectory, 'database.js')).href);

  assert.throws(() => isolatedDatabase.openDemoDatabase(), /cannot be a symbolic link/);
  assert.equal(existsSync(targetPath), false);
});
