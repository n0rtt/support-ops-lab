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
import { DatabaseSync } from 'node:sqlite';
import {
  appendCaseActivity,
  demoDatabasePath,
  getCase,
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

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name),
    ['activities', 'case_evidence', 'cases', 'diagnostics', 'knowledge_entries', 'mutation_receipts'],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cases').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnostics').get().count, 9);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1001').count, 3);
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, 2);
  assert.equal(db.prepare("SELECT activity_type FROM activities WHERE case_id = ? ORDER BY sequence DESC LIMIT 1").get('SEW-1001').activity_type, 'evidence_seeded');

  db.prepare("UPDATE cases SET status = 'resolved', version = 4 WHERE id = ?").run('SEW-1001');
  initializeDatabase(db);
  assert.deepEqual(
    { ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1001') },
    { status: 'resolved', version: 4 },
  );
});

test('M2 activity-order migration preserves existing cases, activities, and receipts', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    "CREATE TABLE cases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, organization_name TEXT NOT NULL, subject TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'manual')), priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')), status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'escalated', 'resolved')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)) STRICT; " +
      'CREATE TABLE activities (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, created_at TEXT NOT NULL, activity_type TEXT NOT NULL, payload TEXT NOT NULL) STRICT; ' +
      'CREATE TABLE mutation_receipts (request_key TEXT PRIMARY KEY CHECK (length(request_key) BETWEEN 1 AND 200), fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT; ' +
      "INSERT INTO cases VALUES ('SEW-OLD', 'ORG-OLD', 'Old fictional organization', 'Existing issue', 'email', 'low', 'open', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 3); " +
      "INSERT INTO activities VALUES ('ACT-OLD', 'SEW-OLD', '2026-10-01T00:00:00.000Z', 'note', '{\"text\":\"Existing history\"}'); " +
      "INSERT INTO activities VALUES ('ACT-Z-FIRST', 'SEW-OLD', '2026-10-01T00:01:00.000Z', 'note', '{\"text\":\"First tied activity\"}'); " +
      "INSERT INTO activities VALUES ('ACT-A-SECOND', 'SEW-OLD', '2026-10-01T00:01:00.000Z', 'note', '{\"text\":\"Second tied activity\"}'); " +
      "INSERT INTO mutation_receipts VALUES ('old-request', 'fingerprint', '{\"ok\":true}', '2026-10-01T00:00:00.000Z'); " +
      'PRAGMA user_version = 1;',
  );
  t.after(() => db.close());

  initializeDatabase(db);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(
    { ...db.prepare('SELECT id, status, version FROM cases WHERE id = ?').get('SEW-OLD') },
    { id: 'SEW-OLD', status: 'open', version: 3 },
  );
  assert.equal(db.prepare('SELECT payload FROM activities WHERE id = ?').get('ACT-OLD').payload, '{"text":"Existing history"}');
  assert.equal(db.prepare('SELECT response_json FROM mutation_receipts WHERE request_key = ?').get('old-request').response_json, '{"ok":true}');
  assert.deepEqual(
    db.prepare('SELECT id, sequence FROM activities WHERE case_id = ? ORDER BY sequence').all('SEW-OLD').map((row) => ({ ...row })),
    [
      { id: 'ACT-OLD', sequence: 1 },
      { id: 'ACT-Z-FIRST', sequence: 2 },
      { id: 'ACT-A-SECOND', sequence: 3 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name),
    ['activities', 'case_evidence', 'cases', 'diagnostics', 'knowledge_entries', 'mutation_receipts'],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnostics').get().count, 9);
  assert.deepEqual(
    db.prepare('PRAGMA index_info(activities_case_order)').all().map((row) => row.name),
    ['case_id', 'sequence'],
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const request = {
    requestKey: 'append-after-migration',
    method: 'POST',
    route: '/api/cases/SEW-OLD/activities',
    caseId: 'SEW-OLD',
    payload: { type: 'internal_note', text: 'Appended after migration' },
    expectedVersion: 3,
  };
  const appended = runIdempotentMutation(db, request, (connection) => appendCaseActivity(connection, {
    caseId: 'SEW-OLD', type: 'internal_note', text: 'Appended after migration', now: '2026-10-01T00:01:00.000Z',
  }));
  assert.equal(appended.response.version, 4);
  assert.deepEqual(getCase(db, 'SEW-OLD').activities.map(({ payload, sequence }) => [payload.text, sequence]), [
    ['Existing history', 1],
    ['First tied activity', 2],
    ['Second tied activity', 3],
    ['Appended after migration', 4],
  ]);
  initializeDatabase(db);
  assert.equal(runIdempotentMutation(db, request, () => { throw new Error('must replay'); }).replayed, true);
});

test('schema-v3 upgrade preserves M2 history and receipts while auditing A seed links once', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    "CREATE TABLE cases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, organization_name TEXT NOT NULL, subject TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'manual')), priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')), status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'escalated', 'resolved')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)) STRICT; " +
      'CREATE TABLE activities (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, created_at TEXT NOT NULL, activity_type TEXT NOT NULL, payload TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0)) STRICT; ' +
      'CREATE UNIQUE INDEX activities_case_order ON activities (case_id, sequence); ' +
      'CREATE TABLE mutation_receipts (request_key TEXT PRIMARY KEY CHECK (length(request_key) BETWEEN 1 AND 200), fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT; ' +
      "INSERT INTO cases VALUES ('SEW-1001', 'ORG-ALDER-01', 'Alder Ridge Analytics', 'Existing M2 case', 'email', 'high', 'escalated', '2026-10-19T08:15:00.000Z', '2026-10-20T09:00:00.000Z', 7); " +
      "INSERT INTO activities VALUES ('ACT-A-REPORT', 'SEW-1001', '2026-10-19T08:15:00.000Z', 'initial_report', '{\"text\":\"Original report\"}', 1); " +
      "INSERT INTO activities VALUES ('ACT-A-NOTE', 'SEW-1001', '2026-10-20T08:00:00.000Z', 'internal_note', '{\"text\":\"Preserved note\"}', 2); " +
      "INSERT INTO activities VALUES ('ACT-A-REPLY', 'SEW-1001', '2026-10-20T08:10:00.000Z', 'simulated_reply', '{\"text\":\"Preserved reply\"}', 3); " +
      "INSERT INTO activities VALUES ('ACT-A-ESC', 'SEW-1001', '2026-10-20T09:00:00.000Z', 'status_changed', '{\"from\":\"open\",\"to\":\"escalated\",\"reason\":\"Existing escalation\",\"findings\":\"Existing facts\",\"questions\":\"\",\"evidenceIds\":[]}', 4); " +
      'PRAGMA user_version = 3;',
  );
  const oldReceipt = {
    requestKey: 'm2-escalation-receipt',
    method: 'PATCH',
    route: '/api/cases/SEW-1001/status',
    caseId: 'SEW-1001',
    payload: { status: 'escalated', reason: 'Existing escalation', findings: 'Existing facts', questions: '', evidenceIds: [], expectedVersion: 7 },
    expectedVersion: 7,
  };
  runIdempotentMutation(db, oldReceipt, () => ({
    changed: false,
    response: { caseId: 'SEW-1001', status: 'escalated', version: 7 },
  }));
  t.after(() => db.close());

  initializeDatabase(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual({ ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1001') }, { status: 'escalated', version: 8 });
  assert.deepEqual(
    getCase(db, 'SEW-1001').activities.map((activity) => [activity.type, activity.sequence]),
    [['initial_report', 1], ['internal_note', 2], ['simulated_reply', 3], ['status_changed', 4], ['evidence_seeded', 5]],
  );
  assert.deepEqual(getCase(db, 'SEW-1001').activities[3].payload.evidenceIds, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1001').count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cases').get().count, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const replay = runIdempotentMutation(db, oldReceipt, () => { throw new Error('The preserved M2 receipt must replay.'); });
  assert.deepEqual(replay, { replayed: true, response: { caseId: 'SEW-1001', status: 'escalated', version: 7 } });

  const version = db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version;
  initializeDatabase(db);
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, version);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activities WHERE case_id = ? AND activity_type = 'evidence_seeded'").get('SEW-1001').count, 1);
});

test('diagnostic constraints preserve unknown observations without inventing responses or timestamps', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());
  const insert = db.prepare('INSERT INTO diagnostics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('DIAG-UNKNOWN-API', 'ORG-ALDER-01', 'api_request', 'req_unknown', null, 'GET /v1/sync', null, 'failed', null, null, null, null);
  assert.deepEqual(
    { ...db.prepare('SELECT observed_at, http_status FROM diagnostics WHERE id = ?').get('DIAG-UNKNOWN-API') },
    { observed_at: null, http_status: null },
  );
  assert.throws(
    () => insert.run('DIAG-HTTP-ZERO', 'ORG-ALDER-01', 'api_request', 'req_zero', null, 'GET /v1/sync', null, 'failed', 0, null, null, null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run('DIAG-ACK-ERROR', 'ORG-ALDER-01', 'api_request', 'req_ack', null, 'GET /v1/sync', null, 'acknowledged', 503, null, null, null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run('DIAG-ACK-UNKNOWN', 'ORG-ALDER-01', 'api_request', 'req_ack_unknown', null, 'GET /v1/sync', null, 'acknowledged', null, null, null, null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run('DIAG-PENDING-TIME', 'ORG-CEDAR-02', 'webhook_attempt', null, 'evt_pending_bad', 'example.created', '2026-10-20T10:00:00.000Z', 'pending', null, 1, null, null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run('DIAG-TIMEOUT-RESPONSE', 'ORG-CEDAR-02', 'webhook_attempt', null, 'evt_timeout_bad', 'example.created', null, 'timed_out', 504, 1, null, null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run('DIAG-ATTEMPT-ZERO', 'ORG-CEDAR-02', 'webhook_attempt', null, 'evt_attempt_bad', 'example.created', null, 'failed', null, 0, null, null),
    /CHECK constraint failed/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnostics WHERE event_id = ? AND attempt_number = 1').get('evt_subscription_480').count, 2);
  assert.throws(
    () => insert.run('DIAG-DUPLICATE-ATTEMPT', 'ORG-CEDAR-02', 'webhook_attempt', null, 'evt_subscription_480', 'subscription.updated', null, 'failed', null, 1, null, null),
    /UNIQUE constraint failed/,
  );
});

test('initialization does not add A seed links when its case belongs to another organization', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());
  db.prepare("DELETE FROM case_evidence WHERE case_id = 'SEW-1001'").run();
  db.prepare("DELETE FROM activities WHERE case_id = 'SEW-1001' AND activity_type = 'evidence_seeded'").run();
  db.prepare("UPDATE cases SET organization_id = 'ORG-OTHER-55', version = 1 WHERE id = 'SEW-1001'").run();
  initializeDatabase(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1001').count, 0);
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activities WHERE case_id = ? AND activity_type = 'evidence_seeded'").get('SEW-1001').count, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('mutation commit, rollback, receipt replay, collision, and stale versions persist', (t) => {
  const { databasePath } = temporaryDatabase(t);
  let db = openDatabase(databasePath);
  initializeDatabase(db);

  const context = {
    requestKey: 'request-1001',
    method: 'PATCH',
    route: '/api/cases/SEW-1003/status',
    payload: { status: 'in_progress', note: 'starting review' },
    caseId: 'SEW-1003',
    expectedVersion: 1,
  };
  assert.throws(
    () => runIdempotentMutation(db, { ...context, payload: null }, () => null),
    /JSON object/,
  );
  const mutate = (connection) => {
    connection
      .prepare('UPDATE cases SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run('in_progress', '2026-10-20T10:00:00.000Z', 'SEW-1003', 1);
    connection
      .prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'ACT-SEW-1003-STATUS',
        'SEW-1003',
        '2026-10-20T10:00:00.000Z',
        'status_changed',
        JSON.stringify({ from: 'open', to: 'in_progress' }),
        2,
      );
    return {
      changed: true,
      response: { caseId: 'SEW-1003', status: 'in_progress', version: 2 },
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
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1003').version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);

  assert.deepEqual(runIdempotentMutation(db, context, mutate), {
    replayed: false,
    response: { caseId: 'SEW-1003', status: 'in_progress', version: 2 },
  });
  db.close();

  db = openDatabase(databasePath);
  initializeDatabase(db);
  assert.deepEqual(
    { ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1003') },
    { status: 'in_progress', version: 2 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 5);

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
    { replayed: true, response: { caseId: 'SEW-1003', status: 'in_progress', version: 2 } },
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
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1003').version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 5);
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
    route: '/api/cases/SEW-1003/status',
    payload: { status: 'in_progress' },
    caseId: 'SEW-1003',
    expectedVersion: 1,
  };

  assert.throws(
    () => runIdempotentMutation(db, context, (connection) => {
      connection.prepare('UPDATE cases SET status = ? WHERE id = ?').run('in_progress', 'SEW-1003');
      connection
        .prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)')
        .run('ACT-MISSING-VERSION', 'SEW-1003', '2026-10-20T10:00:00.000Z', 'status_changed', '{}', 2);
      return { changed: true, response: { status: 'in_progress' } };
    }),
    /advance the case version exactly once/,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT status, version FROM cases WHERE id = ?').get('SEW-1003') },
    { status: 'open', version: 1 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);

  assert.throws(
    () => runIdempotentMutation(db, { ...context, requestKey: 'request-writing-noop' }, (connection) => {
      connection.prepare('UPDATE cases SET status = ? WHERE id = ?').run('in_progress', 'SEW-1003');
      return { changed: false, response: { unchanged: true } };
    }),
    /No-op mutation callbacks must not write/,
  );
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get('SEW-1003').status, 'open');
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

test('demo reset atomically restores linked A evidence and initially unlinked B fixtures', async (t) => {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'supportops-reset-project-'));
  t.after(() => rmSync(projectDirectory, { recursive: true, force: true }));
  const serverDirectory = join(projectDirectory, 'server');
  const fixtureDirectory = join(projectDirectory, 'fixtures');
  mkdirSync(serverDirectory);
  mkdirSync(fixtureDirectory);
  writeFileSync(join(projectDirectory, 'package.json'), '{"type":"module"}\n');
  for (const name of ['database.js']) copyFileSync(new URL('../server/' + name, import.meta.url), join(serverDirectory, name));
  for (const name of ['cases.js', 'diagnostics.js', 'knowledge.js']) {
    copyFileSync(new URL('../fixtures/' + name, import.meta.url), join(fixtureDirectory, name));
  }
  const isolatedDatabase = await import(pathToFileURL(join(serverDirectory, 'database.js')).href);
  let db = isolatedDatabase.openDemoDatabase();
  isolatedDatabase.initializeDatabase(db);
  db.prepare("INSERT INTO case_evidence (case_id, diagnostic_id, linked_at, source) VALUES ('SEW-1002', 'DIAG-WH-SUB-001', '2026-10-20T12:00:00.000Z', 'operator')").run();
  db.prepare('UPDATE cases SET version = version + 1 WHERE id = ?').run('SEW-1002');
  db.prepare("INSERT INTO mutation_receipts VALUES ('operator-work', 'fingerprint', '{\"ok\":true}', '2026-10-20T12:00:00.000Z')").run();
  db.close();

  isolatedDatabase.resetDemoDatabase({ confirmed: true });
  db = isolatedDatabase.openDemoDatabase();
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cases').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnostics').get().count, 9);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1001').count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1002').count, 0);
    assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1002').version, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
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
  for (const name of ['cases.js', 'diagnostics.js', 'knowledge.js']) {
    copyFileSync(new URL('../fixtures/' + name, import.meta.url), join(fixtureDirectory, name));
  }

  const targetPath = join(outsideDirectory, 'supportops.sqlite');
  const databasePath = join(dataDirectory, 'supportops.sqlite');
  symlinkSync(targetPath, databasePath);
  const isolatedDatabase = await import(pathToFileURL(join(serverDirectory, 'database.js')).href);

  assert.throws(() => isolatedDatabase.openDemoDatabase(), /cannot be a symbolic link/);
  assert.equal(existsSync(targetPath), false);
});
