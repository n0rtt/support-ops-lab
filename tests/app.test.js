import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase } from '../server/database.js';
import { temporaryDatabase } from './helpers.js';

async function listen(db) {
  const server = createServer(createApp({ db, buildDirectory: '/missing-supportops-build' }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: 'http://127.0.0.1:' + address.port,
    close: () => server.listening
      ? new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      : Promise.resolve(),
  };
}

async function testServer(t) {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  const server = await listen(db);
  t.after(async () => {
    await server.close();
    db.close();
  });
  return { databasePath, db, ...server };
}

function mutationHeaders(baseUrl, key, contentType = 'application/json') {
  return {
    'content-type': contentType,
    origin: new URL(baseUrl).origin,
    'idempotency-key': key,
  };
}

function post(baseUrl, caseId, key, payload, contentType) {
  return fetch(baseUrl + '/api/cases/' + caseId + '/activities', {
    method: 'POST',
    headers: mutationHeaders(baseUrl, key, contentType),
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function patchStatus(baseUrl, caseId, key, payload) {
  return fetch(baseUrl + '/api/cases/' + caseId + '/status', {
    method: 'PATCH',
    headers: mutationHeaders(baseUrl, key),
    body: JSON.stringify(payload),
  });
}

async function detail(baseUrl, caseId) {
  return (await fetch(baseUrl + '/api/cases/' + caseId)).json();
}

test('M1 seed and config remain intact with M2 queue filtering and chronological case detail', async (t) => {
  const { baseUrl, db } = await testServer(t);

  const config = await fetch(baseUrl + '/api/config');
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), {
    name: 'Support Engineering Workbench',
    dataMode: 'synthetic',
  });

  const all = await fetch(baseUrl + '/api/cases');
  const { cases } = await all.json();
  assert.equal(all.status, 200);
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map((item) => item.id), ['SEW-1003', 'SEW-1001', 'SEW-1002']);
  assert.deepEqual(cases.map((item) => item.priority), ['low', 'high', 'medium']);
  assert.deepEqual(cases.map((item) => item.channel).sort(), ['email', 'manual', 'telegram']);
  assert.ok(cases.every((item) => item.id.startsWith('SEW-') && item.initialReport));
  assert.deepEqual(
    (await (await fetch(baseUrl + '/api/cases?status=open')).json()).cases.map((item) => item.id).sort(),
    ['SEW-1001', 'SEW-1003'],
  );
  assert.deepEqual(
    (await (await fetch(baseUrl + '/api/cases?status=in_progress')).json()).cases.map((item) => item.id),
    ['SEW-1002'],
  );
  const noteResponse = await post(baseUrl, 'SEW-1002', 'queue-latest-activity', {
    type: 'internal_note', text: 'This case was just updated.', expectedVersion: 1,
  });
  assert.equal(noteResponse.status, 200);
  db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run('2026-10-21T00:00:00.000Z', 'SEW-1002');
  const updatedQueue = await (await fetch(baseUrl + '/api/cases')).json();
  assert.deepEqual(updatedQueue.cases.map((item) => item.id), ['SEW-1002', 'SEW-1003', 'SEW-1001']);
  assert.equal((await fetch(baseUrl + '/api/cases?status=unknown')).status, 400);

  const response = await fetch(baseUrl + '/api/cases/SEW-1001');
  const { case: item } = await response.json();
  assert.equal(response.status, 200);
  assert.equal(item.id, 'SEW-1001');
  assert.equal(item.activities.length, 1);
  assert.equal(item.activities[0].type, 'initial_report');
  assert.equal(item.activities[0].payload.text, item.initialReport);
  assert.equal((await fetch(baseUrl + '/api/cases/SEW-4040')).status, 404);
  assert.equal((await fetch(baseUrl + '/api/diagnostics')).status, 404);

  const invalidHost = await new Promise((resolve, reject) => {
    const address = new URL(baseUrl);
    const hostRequest = request(
      { hostname: '127.0.0.1', port: address.port, path: '/api/config', headers: { host: 'example.test' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response));
      },
    );
    hostRequest.on('error', reject);
    hostRequest.end();
  });
  assert.equal(invalidHost.statusCode, 400);
});

test('notes, simulated replies, resolution, and terminal history are durable and idempotent', async (t) => {
  const { databasePath } = temporaryDatabase(t);
  let db = openDatabase(databasePath);
  initializeDatabase(db);
  let server = await listen(db);
  t.after(async () => {
    await server.close();
    db.close();
  });

  const note = { type: 'internal_note', text: 'Confirmed the customer has rotated the API key.', expectedVersion: 1 };
  let response = await post(server.baseUrl, 'SEW-1001', 'manual-note-1', note);
  assert.equal(response.status, 200);
  const savedNote = await response.json();
  assert.equal(savedNote.caseId, 'SEW-1001');
  assert.match(savedNote.activityId, /^ACT-/);
  assert.equal(savedNote.version, 2);
  assert.equal(savedNote.replayed, false);
  response = await post(server.baseUrl, 'SEW-1001', 'manual-note-1', note);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  response = await post(server.baseUrl, 'SEW-1001', 'manual-note-1', {
    ...note,
    text: 'Changed payload under the committed key.',
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'idempotency_key_reused' });

  response = await post(server.baseUrl, 'SEW-1001', 'manual-reply-1', {
    type: 'simulated_reply',
    text: 'Please confirm the next scheduled sync succeeds.',
    expectedVersion: 2,
  });
  assert.equal(response.status, 200);
  response = await patchStatus(server.baseUrl, 'SEW-1001', 'manual-resolve-1', {
    status: 'resolved',
    outcome: 'The API key was rotated and the customer confirmed a successful sync.',
    expectedVersion: 3,
  });
  assert.equal(response.status, 200);

  response = await post(server.baseUrl, 'SEW-1001', 'manual-note-after-resolution', {
    type: 'internal_note',
    text: 'Follow-up recorded after resolution.',
    expectedVersion: 4,
  });
  assert.equal(response.status, 200);
  response = await patchStatus(server.baseUrl, 'SEW-1001', 'manual-reopen-1', {
    status: 'in_progress',
    expectedVersion: 5,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'invalid_transition' });

  await server.close();
  db.close();
  db = openDatabase(databasePath);
  initializeDatabase(db);
  server = await listen(db);

  const { case: saved } = await detail(server.baseUrl, 'SEW-1001');
  assert.equal(saved.status, 'resolved');
  assert.equal(saved.version, 5);
  assert.deepEqual(
    saved.activities.map((activity) => activity.type),
    ['initial_report', 'internal_note', 'simulated_reply', 'status_changed', 'internal_note'],
  );
  assert.equal(saved.activities[2].payload.text, 'Please confirm the next scheduled sync succeeds.');
  assert.equal(saved.activities[3].payload.outcome, 'The API key was rotated and the customer confirmed a successful sync.');
  assert.equal(saved.activities[4].payload.text, 'Follow-up recorded after resolution.');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 4);
});

test('escalation requires findings and questions, accepts empty evidence, and records each re-entry', async (t) => {
  const { baseUrl } = await testServer(t);

  let response = await patchStatus(baseUrl, 'SEW-1003', 'escalation-missing-context', {
    status: 'escalated',
    reason: 'Needs engineering review',
    expectedVersion: 1,
  });
  assert.equal(response.status, 400);

  response = await patchStatus(baseUrl, 'SEW-1003', 'escalation-evidence-not-yet-supported', {
    status: 'escalated',
    reason: 'Needs engineering review',
    findings: 'No request ID or occurrence time was provided.',
    questions: '',
    evidenceIds: ['DIAG-FUTURE-1001'],
    expectedVersion: 1,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_evidence' });

  response = await patchStatus(baseUrl, 'SEW-1003', 'escalation-1', {
    status: 'escalated',
    reason: 'The report does not include enough detail to isolate the failure.',
    findings: 'No request ID or exact occurrence time is available.',
    questions: '',
    expectedVersion: 1,
  });
  assert.equal(response.status, 200);

  response = await patchStatus(baseUrl, 'SEW-1003', 'escalation-work-1', {
    status: 'in_progress',
    expectedVersion: 2,
  });
  assert.equal(response.status, 200);
  response = await patchStatus(baseUrl, 'SEW-1003', 'escalation-2', {
    status: 'escalated',
    reason: 'Still waiting on identifiers after customer follow-up.',
    findings: 'The available report remains insufficient.',
    questions: 'Which request IDs and UTC time window are affected?',
    evidenceIds: [],
    expectedVersion: 3,
  });
  assert.equal(response.status, 200);

  const { case: saved } = await detail(baseUrl, 'SEW-1003');
  const escalations = saved.activities.filter((activity) => activity.type === 'status_changed' && activity.payload.to === 'escalated');
  assert.equal(saved.status, 'escalated');
  assert.equal(escalations.length, 2);
  assert.deepEqual(escalations[0].payload.evidenceIds, []);
  assert.equal(escalations[0].payload.questions, '');
  assert.equal(escalations[1].payload.questions, 'Which request IDs and UTC time window are affected?');
});

test('current-state requests in every status are replayable no-ops without changing the case', async (t) => {
  const { baseUrl, db } = await testServer(t);
  async function assertNoop(caseId, status, key, context = {}) {
    const { case: before } = await detail(baseUrl, caseId);
    const payload = { status, expectedVersion: before.version, ...context };
    let response = await patchStatus(baseUrl, caseId, key, payload);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { caseId, status, version: before.version, replayed: false });
    response = await patchStatus(baseUrl, caseId, key, payload);
    assert.deepEqual(await response.json(), { caseId, status, version: before.version, replayed: true });
    assert.deepEqual((await detail(baseUrl, caseId)).case, before);
  }

  await assertNoop('SEW-1001', 'open', 'current-status-noop-open');
  await assertNoop('SEW-1002', 'in_progress', 'current-status-noop-in-progress');
  const escalated = await patchStatus(baseUrl, 'SEW-1003', 'prepare-escalated-noop', {
    status: 'escalated', reason: 'Needs engineering', findings: 'No identifiers.', questions: '', expectedVersion: 1,
  });
  assert.equal(escalated.status, 200);
  await assertNoop('SEW-1003', 'escalated', 'current-status-noop-escalated', {
    reason: '', findings: '', questions: '',
  });
  const resolved = await patchStatus(baseUrl, 'SEW-1001', 'prepare-resolved-noop', {
    status: 'resolved', outcome: 'The customer confirmed resolution.', expectedVersion: 1,
  });
  assert.equal(resolved.status, 200);
  await assertNoop('SEW-1001', 'resolved', 'current-status-noop-resolved', { outcome: '' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 6);
});

test('strict HTTP validation and failed receipt writes preserve case data with safe errors', async (t) => {
  const { baseUrl, db } = await testServer(t);

  let response = await fetch(baseUrl + '/api/cases/SEW-1001/activities', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(baseUrl).origin },
    body: JSON.stringify({ type: 'internal_note', text: 'Missing key', expectedVersion: 1 }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'idempotency_key_required' });

  response = await fetch(baseUrl + '/api/cases/SEW-1001/activities', {
    method: 'POST',
    headers: { ...mutationHeaders(baseUrl, 'invalid-origin'), origin: 'https://attacker.example' },
    body: JSON.stringify({ type: 'internal_note', text: 'Wrong origin', expectedVersion: 1 }),
  });
  assert.equal(response.status, 403);

  response = await post(baseUrl, 'SEW-1001', 'wrong-content-type', '{}', 'text/plain');
  assert.equal(response.status, 415);
  response = await post(baseUrl, 'SEW-1001', 'invalid-json', '{', 'application/json');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_json' });

  response = await post(baseUrl, 'SEW-1001', 'unknown-field', {
    type: 'internal_note', text: 'Unknown field', expectedVersion: 1, status: 'resolved',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unknown_fields' });

  response = await post(baseUrl, 'SEW-1001', 'legacy-note-type', {
    type: 'note', text: 'Wrong discriminator', expectedVersion: 1,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_activity_type' });

  response = await patchStatus(baseUrl, 'SEW-1001', 'missing-resolution-outcome', {
    status: 'resolved',
    expectedVersion: 1,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_resolution_outcome' });

  db.exec(
    "CREATE TRIGGER force_receipt_failure BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'private database detail'); END",
  );
  response = await post(baseUrl, 'SEW-1001', 'atomic-failure', {
    type: 'internal_note', text: 'Must not partially save', expectedVersion: 1,
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'save_failed' });
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE case_id = ?').get('SEW-1001').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
  db.exec('DROP TRIGGER force_receipt_failure');
});

test('concurrent stale writes conflict without duplicating, and a receipt replays after later changes', async (t) => {
  const { baseUrl } = await testServer(t);
  const requests = [
    { key: 'concurrent-a', body: { type: 'internal_note', text: 'First tab', expectedVersion: 1 } },
    { key: 'concurrent-b', body: { type: 'internal_note', text: 'Second tab', expectedVersion: 1 } },
  ];
  const attempts = await Promise.all(requests.map(async (request) => ({
    ...request,
    response: await post(baseUrl, 'SEW-1001', request.key, request.body),
  })));
  const statuses = attempts.map(({ response }) => response.status);
  assert.deepEqual(statuses.sort(), [200, 409]);
  const winner = attempts.find(({ response }) => response.status === 200);
  const winnerResponse = await post(baseUrl, 'SEW-1001', winner.key, winner.body);
  assert.equal((await winnerResponse.json()).replayed, true);

  const next = await post(baseUrl, 'SEW-1001', 'after-concurrent-1', {
    type: 'internal_note', text: 'Later intentional note', expectedVersion: 2,
  });
  assert.equal(next.status, 200);
  const staleReceiptReplay = await post(baseUrl, 'SEW-1001', winner.key, winner.body);
  assert.equal((await staleReceiptReplay.json()).replayed, true);

  const { case: saved } = await detail(baseUrl, 'SEW-1001');
  assert.equal(saved.version, 3);
  assert.equal(saved.activities.filter((activity) => activity.type === 'internal_note').length, 2);
  assert.equal(saved.activities.filter((activity) => activity.payload.text === 'Second tab').length + saved.activities.filter((activity) => activity.payload.text === 'First tab').length, 1);
});
