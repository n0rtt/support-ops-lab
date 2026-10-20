import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase } from '../server/database.js';
import { temporaryDatabase } from './helpers.js';

async function listen(db, options = {}) {
  const server = createServer(createApp({ db, buildDirectory: '/missing-supportops-build', ...options }));
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

async function testServer(t, options = {}) {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  const server = await listen(db, options);
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

function postAnalysis(baseUrl, caseId, key, payload) {
  return fetch(baseUrl + '/api/cases/' + caseId + '/analyses', {
    method: 'POST', headers: mutationHeaders(baseUrl, key), body: JSON.stringify(payload),
  });
}

function postReview(baseUrl, caseId, analysisId, key, payload) {
  return fetch(baseUrl + '/api/cases/' + caseId + '/analyses/' + analysisId + '/reviews', {
    method: 'POST', headers: mutationHeaders(baseUrl, key), body: JSON.stringify(payload),
  });
}

async function waitForAnalysis(baseUrl, analysisId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(baseUrl + '/api/analyses/' + analysisId);
    if (!response.ok) throw new Error('analysis request failed');
    const { analysis } = await response.json();
    if (analysis.status !== 'running') return analysis;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('analysis did not reach a terminal state');
}

test('M1 seed and config remain intact with M2 queue filtering and chronological case detail', async (t) => {
  const { baseUrl, db } = await testServer(t);

  const config = await fetch(baseUrl + '/api/config');
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), {
    name: 'Support Engineering Workbench',
    dataMode: 'synthetic',
    liveInferenceAvailable: false,
  });

  const all = await fetch(baseUrl + '/api/cases');
  const { cases } = await all.json();
  assert.equal(all.status, 200);
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map((item) => item.id), ['SEW-1001', 'SEW-1003', 'SEW-1002']);
  assert.deepEqual(cases.map((item) => item.priority), ['high', 'low', 'medium']);
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
  assert.deepEqual(updatedQueue.cases.map((item) => item.id), ['SEW-1002', 'SEW-1001', 'SEW-1003']);
  assert.equal((await fetch(baseUrl + '/api/cases?status=unknown')).status, 400);

  const response = await fetch(baseUrl + '/api/cases/SEW-1001');
  const { case: item } = await response.json();
  assert.equal(response.status, 200);
  assert.equal(item.id, 'SEW-1001');
  assert.equal(item.activities.length, 2);
  assert.equal(item.activities[0].type, 'initial_report');
  assert.equal(item.activities[0].payload.text, item.initialReport);
  assert.deepEqual(item.evidence.map((diagnostic) => diagnostic.id), ['DIAG-AUTH-401-001', 'DIAG-AUTH-401-002', 'DIAG-AUTH-401-003']);
  assert.equal((await fetch(baseUrl + '/api/cases/SEW-4040')).status, 404);
  assert.equal((await fetch(baseUrl + '/api/diagnostics')).status, 400);

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

  const note = { type: 'internal_note', text: 'Confirmed the customer has rotated the API key.', expectedVersion: 2 };
  let response = await post(server.baseUrl, 'SEW-1001', 'manual-note-1', note);
  assert.equal(response.status, 200);
  const savedNote = await response.json();
  assert.equal(savedNote.caseId, 'SEW-1001');
  assert.match(savedNote.activityId, /^ACT-/);
  assert.equal(savedNote.version, 3);
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
    expectedVersion: 3,
  });
  assert.equal(response.status, 200);
  response = await patchStatus(server.baseUrl, 'SEW-1001', 'manual-resolve-1', {
    status: 'resolved',
    outcome: 'The API key was rotated and the customer confirmed a successful sync.',
    expectedVersion: 4,
  });
  assert.equal(response.status, 200);

  response = await post(server.baseUrl, 'SEW-1001', 'manual-note-after-resolution', {
    type: 'internal_note',
    text: 'Follow-up recorded after resolution.',
    expectedVersion: 5,
  });
  assert.equal(response.status, 200);
  response = await patchStatus(server.baseUrl, 'SEW-1001', 'manual-reopen-1', {
    status: 'in_progress',
    expectedVersion: 6,
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
  assert.equal(saved.version, 6);
  assert.deepEqual(
    saved.activities.map((activity) => activity.type),
    ['initial_report', 'evidence_seeded', 'internal_note', 'simulated_reply', 'status_changed', 'internal_note'],
  );
  assert.equal(saved.activities[3].payload.text, 'Please confirm the next scheduled sync succeeds.');
  assert.equal(saved.activities[4].payload.outcome, 'The API key was rotated and the customer confirmed a successful sync.');
  assert.equal(saved.activities[5].payload.text, 'Follow-up recorded after resolution.');
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
  assert.deepEqual(await response.json(), {
    error: 'invalid_evidence',
    details: { notFoundIds: ['DIAG-FUTURE-1001'], differentOrganizationIds: [], unlinkedIds: [] },
  });

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
    status: 'resolved', outcome: 'The customer confirmed resolution.', expectedVersion: 2,
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
    expectedVersion: 2,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_resolution_outcome' });

  db.exec(
    "CREATE TRIGGER force_receipt_failure BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'private database detail'); END",
  );
  response = await post(baseUrl, 'SEW-1001', 'atomic-failure', {
    type: 'internal_note', text: 'Must not partially save', expectedVersion: 2,
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'save_failed' });
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1001').version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE case_id = ?').get('SEW-1001').count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
  db.exec('DROP TRIGGER force_receipt_failure');
});

test('concurrent stale writes conflict without duplicating, and a receipt replays after later changes', async (t) => {
  const { baseUrl } = await testServer(t);
  const requests = [
    { key: 'concurrent-a', body: { type: 'internal_note', text: 'First tab', expectedVersion: 2 } },
    { key: 'concurrent-b', body: { type: 'internal_note', text: 'Second tab', expectedVersion: 2 } },
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
    type: 'internal_note', text: 'Later intentional note', expectedVersion: 3,
  });
  assert.equal(next.status, 200);
  const staleReceiptReplay = await post(baseUrl, 'SEW-1001', winner.key, winner.body);
  assert.equal((await staleReceiptReplay.json()).replayed, true);

  const { case: saved } = await detail(baseUrl, 'SEW-1001');
  assert.equal(saved.version, 4);
  assert.equal(saved.activities.filter((activity) => activity.type === 'internal_note').length, 2);
  assert.equal(saved.activities.filter((activity) => activity.payload.text === 'Second tab').length + saved.activities.filter((activity) => activity.payload.text === 'First tab').length, 1);
});

test('diagnostic lookup is exact, global, read-only, and returns complete organization-scoped histories and KB entries', async (t) => {
  const { baseUrl, db } = await testServer(t);
  const beforeCases = db.prepare('SELECT id, version, updated_at FROM cases ORDER BY id').all();
  const beforeActivities = db.prepare('SELECT case_id, COUNT(*) AS count FROM activities GROUP BY case_id ORDER BY case_id').all();
  const beforeLinks = db.prepare('SELECT case_id, diagnostic_id FROM case_evidence ORDER BY case_id, diagnostic_id').all();

  let response = await fetch(baseUrl + '/api/diagnostics?q=%20req_auth_20261019_001%20');
  assert.equal(response.status, 200);
  let result = await response.json();
  assert.deepEqual(result.matches.map((row) => row.id), ['DIAG-AUTH-401-001']);
  assert.deepEqual(result.histories, []);
  assert.equal((await fetch(baseUrl + '/api/diagnostics?q=req_auth_20261019_001x')).status, 200);
  assert.deepEqual((await (await fetch(baseUrl + '/api/diagnostics?q=req_auth_20261019_001x')).json()).matches, []);
  assert.deepEqual((await (await fetch(baseUrl + '/api/diagnostics?q=REQ_AUTH_20261019_001')).json()).matches, []);
  assert.equal((await fetch(baseUrl + '/api/diagnostics?q=%20%20')).status, 400);
  assert.equal((await fetch(baseUrl + '/api/diagnostics?q=a&q=b')).status, 400);

  response = await fetch(baseUrl + '/api/diagnostics?q=evt_subscription_480');
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.matches.length, 4);
  assert.deepEqual(result.histories.map((history) => [history.organizationId, history.eventId, history.attempts.length]), [
    ['ORG-CEDAR-02', 'evt_subscription_480', 3],
    ['ORG-MAPLE-99', 'evt_subscription_480', 1],
  ]);
  assert.deepEqual(result.histories[0].attempts.map((row) => row.attemptNumber), [1, 2, 3]);
  assert.deepEqual(result.histories[0].attempts.map((row) => row.httpStatus), [500, null, 204]);
  assert.equal(result.histories[0].attempts[2].outcome, 'acknowledged');
  assert.equal(result.histories[1].organizationId, 'ORG-MAPLE-99');

  response = await fetch(baseUrl + '/api/diagnostics/DIAG-WH-INV-002');
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.diagnostic.observedAt, null);
  assert.equal(result.diagnostic.httpStatus, null);
  assert.deepEqual(result.attempts.map((row) => row.id), ['DIAG-WH-INV-001', 'DIAG-WH-INV-002']);
  assert.equal((await fetch(baseUrl + '/api/diagnostics/DIAG-MISSING')).status, 404);

  response = await fetch(baseUrl + '/api/knowledge');
  assert.equal(response.status, 200);
  const { entries } = await response.json();
  assert.deepEqual(entries.map((entry) => entry.id), ['KB-AUTH-01', 'KB-OUTAGE-01', 'KB-REQUEST-01', 'KB-WEBHOOK-01']);
  assert.ok(entries.every((entry) => entry.version === 1 && !Object.hasOwn(entry, 'content')));
  response = await fetch(baseUrl + '/api/knowledge/KB-WEBHOOK-01');
  assert.equal(response.status, 200);
  assert.match((await response.json()).entry.content, /downstream business processing/i);
  assert.equal((await fetch(baseUrl + '/api/knowledge/KB-MISSING')).status, 404);

  assert.deepEqual(db.prepare('SELECT id, version, updated_at FROM cases ORDER BY id').all(), beforeCases);
  assert.deepEqual(db.prepare('SELECT case_id, COUNT(*) AS count FROM activities GROUP BY case_id ORDER BY case_id').all(), beforeActivities);
  assert.deepEqual(db.prepare('SELECT case_id, diagnostic_id FROM case_evidence ORDER BY case_id, diagnostic_id').all(), beforeLinks);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnostics').get().count, 9);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count, 4);
});

test('diagnostic association validates the whole batch, deduplicates, records one activity, and keeps no-ops and stale writes safe', async (t) => {
  const { baseUrl, db } = await testServer(t);
  let response;
  const postEvidence = (key, diagnosticIds, expectedVersion) => fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(baseUrl, key),
    body: JSON.stringify({ diagnosticIds, expectedVersion }),
  });

  response = await fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(baseUrl, 'assoc-invalid-body'),
    body: JSON.stringify({ diagnosticIds: ['invalid id'], expectedVersion: 1 }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_evidence' });
  response = await postEvidence('assoc-unknown', ['DIAG-WH-SUB-001', 'DIAG-NOT-FOUND-01'], 1);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'evidence_association_rejected',
    details: { notFoundIds: ['DIAG-NOT-FOUND-01'], differentOrganizationIds: [] },
  });
  response = await postEvidence('assoc-wrong-org', ['DIAG-OTHER-001'], 1);
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).details, { notFoundIds: [], differentOrganizationIds: ['DIAG-OTHER-001'] });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1002').count, 0);
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1002').version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE case_id = ?').get('SEW-1002').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);

  response = await postEvidence('assoc-first', ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-001'], 1);
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.deepEqual(body.addedIds, ['DIAG-WH-SUB-001']);
  assert.deepEqual(body.alreadyLinkedIds, []);
  assert.equal(body.version, 2);
  response = await postEvidence('assoc-mixed', ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-002', 'DIAG-WH-SUB-002'], 2);
  assert.equal(response.status, 200);
  body = await response.json();
  assert.deepEqual(body.addedIds, ['DIAG-WH-SUB-002']);
  assert.deepEqual(body.alreadyLinkedIds, ['DIAG-WH-SUB-001']);
  assert.equal(body.version, 3);
  const afterChange = await detail(baseUrl, 'SEW-1002');
  assert.deepEqual(afterChange.case.activities.at(-1).payload.diagnosticIds, ['DIAG-WH-SUB-002']);
  assert.equal(afterChange.case.activities.filter((activity) => activity.type === 'evidence_linked').length, 2);

  response = await postEvidence('assoc-noop', ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-001'], 3);
  assert.equal(response.status, 200);
  body = await response.json();
  assert.deepEqual(body.addedIds, []);
  assert.deepEqual(body.alreadyLinkedIds, ['DIAG-WH-SUB-001']);
  assert.equal(body.version, 3);
  const afterNoop = await detail(baseUrl, 'SEW-1002');
  assert.equal(afterNoop.case.activities.length, afterChange.case.activities.length);
  assert.equal(afterNoop.case.updatedAt, afterChange.case.updatedAt);
  response = await postEvidence('assoc-noop', ['DIAG-WH-SUB-002'], 3);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'idempotency_key_reused' });
  response = await postEvidence('assoc-stale', ['DIAG-WH-SUB-001'], 2);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'stale_case' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1002').count, 2);
});

test('association receipt failure rolls back links, version, and activity', async (t) => {
  const { baseUrl, db } = await testServer(t);
  db.exec("CREATE TRIGGER force_receipt_failure BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'private database detail'); END");
  const response = await fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(baseUrl, 'assoc-rollback'),
    body: JSON.stringify({ diagnosticIds: ['DIAG-WH-SUB-001'], expectedVersion: 1 }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'save_failed' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1002').count, 0);
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1002').version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE case_id = ?').get('SEW-1002').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
});

test('concurrent evidence associations have one winner at a case version', async (t) => {
  const { baseUrl, db } = await testServer(t);
  const requests = [
    { key: 'concurrent-evidence-a', diagnosticIds: ['DIAG-WH-SUB-001'] },
    { key: 'concurrent-evidence-b', diagnosticIds: ['DIAG-WH-SUB-002'] },
  ];
  const attempts = await Promise.all(requests.map(async ({ key, diagnosticIds }) => ({
    key,
    diagnosticIds,
    response: await fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
      method: 'POST',
      headers: mutationHeaders(baseUrl, key),
      body: JSON.stringify({ diagnosticIds, expectedVersion: 1 }),
    }),
  })));
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [200, 409]);
  const winner = attempts.find(({ response }) => response.status === 200);
  const replay = await fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(baseUrl, winner.key),
    body: JSON.stringify({ diagnosticIds: winner.diagnosticIds, expectedVersion: 1 }),
  });
  assert.equal((await replay.json()).replayed, true);
  assert.equal(db.prepare('SELECT version FROM cases WHERE id = ?').get('SEW-1002').version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM case_evidence WHERE case_id = ?').get('SEW-1002').count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activities WHERE case_id = ? AND activity_type = 'evidence_linked'").get('SEW-1002').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 1);
});

test('association receipts and case history survive restart and replay without a duplicate link', async (t) => {
  const { databasePath } = temporaryDatabase(t);
  let db = openDatabase(databasePath);
  initializeDatabase(db);
  let server = await listen(db);
  t.after(async () => {
    await server.close();
    db.close();
  });
  const body = { diagnosticIds: ['DIAG-WH-INV-001'], expectedVersion: 1 };
  let response = await fetch(server.baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(server.baseUrl, 'association-persists'),
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, false);
  await server.close();
  db.close();
  db = openDatabase(databasePath);
  initializeDatabase(db);
  server = await listen(db);
  response = await fetch(server.baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(server.baseUrl, 'association-persists'),
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  const { case: saved } = await detail(server.baseUrl, 'SEW-1002');
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.evidence.map((row) => row.id), ['DIAG-WH-INV-001']);
  assert.equal(saved.activities.filter((activity) => activity.type === 'evidence_linked').length, 1);
});

test('escalation snapshots only linked evidence and old empty-list request receipts remain replayable', async (t) => {
  const { baseUrl } = await testServer(t);
  let response = await patchStatus(baseUrl, 'SEW-1002', 'reject-unlinked-escalation-evidence', {
    status: 'escalated', reason: 'Evidence must already be linked.', findings: 'The record exists but is not associated.', questions: '',
    evidenceIds: ['DIAG-WH-SUB-001'], expectedVersion: 1,
  });
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).details, { notFoundIds: [], differentOrganizationIds: [], unlinkedIds: ['DIAG-WH-SUB-001'] });
  let saved = (await detail(baseUrl, 'SEW-1002')).case;
  assert.equal(saved.version, 1);
  assert.equal(saved.activities.length, 1);
  response = await patchStatus(baseUrl, 'SEW-1002', 'reject-wrong-organization-escalation-evidence', {
    status: 'escalated', reason: 'Evidence must match the case organization.', findings: 'The record belongs to another organization.', questions: '',
    evidenceIds: ['DIAG-OTHER-001'], expectedVersion: 1,
  });
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).details, { notFoundIds: [], differentOrganizationIds: ['DIAG-OTHER-001'], unlinkedIds: [] });
  response = await patchStatus(baseUrl, 'SEW-1002', 'empty-escalation', {
    status: 'escalated', reason: 'Awaiting more technical evidence.', findings: 'No linked evidence was selected.', questions: '', expectedVersion: 1,
  });
  assert.equal(response.status, 200);
  response = await fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST',
    headers: mutationHeaders(baseUrl, 'associate-after-escalation'),
    body: JSON.stringify({ diagnosticIds: ['DIAG-WH-SUB-001'], expectedVersion: 2 }),
  });
  assert.equal(response.status, 200);
  saved = (await detail(baseUrl, 'SEW-1002')).case;
  assert.deepEqual(saved.activities.find((activity) => activity.payload.to === 'escalated').payload.evidenceIds, []);
  response = await patchStatus(baseUrl, 'SEW-1002', 'resume-after-empty-escalation', {
    status: 'in_progress', expectedVersion: 3,
  });
  assert.equal(response.status, 200);
  response = await patchStatus(baseUrl, 'SEW-1002', 'linked-escalation', {
    status: 'escalated', reason: 'Engineering review with selected evidence.', findings: 'A 500 was observed.', questions: '',
    evidenceIds: ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-001'], expectedVersion: 4,
  });
  assert.equal(response.status, 200);
  saved = (await detail(baseUrl, 'SEW-1002')).case;
  assert.deepEqual(saved.activities.filter((activity) => activity.payload.to === 'escalated').map((activity) => activity.payload.evidenceIds), [[], ['DIAG-WH-SUB-001']]);
});

test('all three offline evaluations keep explicit provenance, prerequisites, context snapshots, and append-only review history', async (t) => {
  const { baseUrl, db } = await testServer(t);
  const config = await (await fetch(baseUrl + '/api/config')).json();
  assert.equal(config.liveInferenceAvailable, false);

  let a = (await detail(baseUrl, 'SEW-1001')).case;
  let response = await postAnalysis(baseUrl, 'SEW-1001', 'no-key-live-request', { source: 'live', expectedVersion: a.version });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'live_inference_unavailable' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_key = 'no-key-live-request'").get().count, 0);
  const fixtureA = a.analysisFixtures[0];
  assert.equal(fixtureA.available, true);
  assert.match(fixtureA.label, /intentionally incorrect/);
  response = await postAnalysis(baseUrl, 'SEW-1001', 'fixture-a', {
    source: 'fixture', fixtureId: fixtureA.id, expectedVersion: a.version,
  });
  assert.equal(response.status, 201);
  const firstAck = await response.json();
  response = await postAnalysis(baseUrl, 'SEW-1001', 'fixture-a', {
    source: 'fixture', fixtureId: fixtureA.id, expectedVersion: a.version,
  });
  assert.equal((await response.json()).replayed, true);
  let { analysis: incorrect } = await (await fetch(baseUrl + '/api/analyses/' + firstAck.analysisId)).json();
  assert.equal(incorrect.source, 'fixture');
  assert.equal(incorrect.fixtureId, fixtureA.id);
  assert.match(incorrect.fixtureLabel, /intentionally incorrect/);
  assert.equal(incorrect.provider, null);
  assert.equal(incorrect.requestedModel, null);
  assert.equal(incorrect.returnedModel, null);
  assert.equal(incorrect.responseId, null);
  assert.equal(incorrect.referenceValidation.valid, true);
  assert.match(incorrect.recommendation.possibleCause.text, /outage/i);
  assert.equal(incorrect.referenceAllowlist.diagnostics.length, 3);
  assert.equal(incorrect.referenceAllowlist.knowledge.length, 4);
  assert.equal(incorrect.context.diagnostics.some((row) => row.id === 'DIAG-WH-INV-001'), false);
  assert.equal(incorrect.context.case.id, 'SEW-1001');

  a = (await detail(baseUrl, 'SEW-1001')).case;
  response = await postReview(baseUrl, 'SEW-1001', incorrect.id, 'reject-a', {
    decision: 'reject', expectedVersion: a.version,
    feedback: 'The supplied 401 responses indicate rejected authentication. They do not establish a provider-wide outage; verify the configured key and scopes.',
  });
  assert.equal(response.status, 200);
  a = (await detail(baseUrl, 'SEW-1001')).case;
  response = await postAnalysis(baseUrl, 'SEW-1001', 'fixture-a-reanalysis', {
    source: 'fixture', fixtureId: fixtureA.id, expectedVersion: a.version,
  });
  assert.equal(response.status, 201);
  const reanalysis = await response.json();
  const secondA = (await (await fetch(baseUrl + '/api/analyses/' + reanalysis.analysisId)).json()).analysis;
  assert.equal(secondA.context.correctiveFeedback.length, 1);
  assert.match(secondA.context.correctiveFeedback[0].feedback, /401 responses indicate rejected authentication/);
  incorrect = (await (await fetch(baseUrl + '/api/analyses/' + incorrect.id)).json()).analysis;
  assert.equal(incorrect.reviews.length, 1);
  assert.equal(incorrect.reviews[0].decision, 'rejected');

  let b = (await detail(baseUrl, 'SEW-1002')).case;
  const fixtureB = b.analysisFixtures[0];
  assert.equal(fixtureB.available, false);
  assert.match(fixtureB.prerequisite, /Associate all required diagnostic records/);
  response = await postAnalysis(baseUrl, 'SEW-1002', 'fixture-b-before-evidence', {
    source: 'fixture', fixtureId: fixtureB.id, expectedVersion: b.version,
  });
  assert.equal(response.status, 409);
  response = await fetch(baseUrl + '/api/cases/SEW-1002/evidence', {
    method: 'POST', headers: mutationHeaders(baseUrl, 'link-b-attempts'),
    body: JSON.stringify({ diagnosticIds: ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-002', 'DIAG-WH-SUB-003'], expectedVersion: b.version }),
  });
  assert.equal(response.status, 200);
  b = (await detail(baseUrl, 'SEW-1002')).case;
  assert.equal(b.analysisFixtures[0].available, true);
  response = await postAnalysis(baseUrl, 'SEW-1002', 'fixture-b', {
    source: 'fixture', fixtureId: fixtureB.id, expectedVersion: b.version,
  });
  assert.equal(response.status, 201);
  const bAck = await response.json();
  const originalB = (await (await fetch(baseUrl + '/api/analyses/' + bAck.analysisId)).json()).analysis;
  assert.equal(originalB.referenceValidation.valid, true);
  assert.equal(originalB.context.diagnostics.length, 3);

  const edited = {
    ...originalB.recommendation,
    draftResponse: 'We observed two unsuccessful attempts and a later HTTP 204 acknowledgment. We cannot confirm downstream processing; please check your receiver logs.',
  };
  b = (await detail(baseUrl, 'SEW-1002')).case;
  response = await postReview(baseUrl, 'SEW-1002', originalB.id, 'edit-b', {
    decision: 'edit', expectedVersion: b.version, recommendation: edited,
  });
  assert.equal(response.status, 200);
  b = (await detail(baseUrl, 'SEW-1002')).case;
  response = await postReview(baseUrl, 'SEW-1002', originalB.id, 'accept-edited-b', {
    decision: 'accept', expectedVersion: b.version,
  });
  assert.equal(response.status, 200);
  const afterReviews = (await detail(baseUrl, 'SEW-1002')).case;
  assert.equal(afterReviews.status, 'in_progress');
  assert.equal(afterReviews.activities.some((activity) => activity.type === 'simulated_reply'), false);
  assert.equal(afterReviews.activities.some((activity) => activity.type === 'status_changed'), false);
  const preservedB = (await (await fetch(baseUrl + '/api/analyses/' + originalB.id)).json()).analysis;
  assert.equal(preservedB.recommendation.draftResponse, originalB.recommendation.draftResponse);
  assert.deepEqual(preservedB.reviews.map((review) => review.decision), ['edited', 'accepted']);
  assert.equal(preservedB.reviews[0].recommendation.draftResponse, edited.draftResponse);

  let c = (await detail(baseUrl, 'SEW-1003')).case;
  assert.equal(c.analysisFixtures[0].available, true);
  response = await postAnalysis(baseUrl, 'SEW-1003', 'fixture-c', {
    source: 'fixture', fixtureId: c.analysisFixtures[0].id, expectedVersion: c.version,
  });
  assert.equal(response.status, 201);
  const cAnalysis = (await (await fetch(baseUrl + '/api/analyses/' + (await response.json()).analysisId)).json()).analysis;
  assert.equal(cAnalysis.recommendation.classification, 'insufficient_evidence');
  assert.equal(cAnalysis.recommendation.possibleCause, null);
  assert.equal(cAnalysis.recommendation.observations.length, 0);
  assert.ok(cAnalysis.recommendation.uncertainty.length);

  const quality = await (await fetch(baseUrl + '/api/reviews')).json();
  assert.deepEqual(quality.totals.fixture, { reviewed: 2, accepted: 1, edited: 0, rejected: 1 });
  assert.deepEqual(quality.totals.live, { reviewed: 0, accepted: 0, edited: 0, rejected: 0 });
  assert.equal(quality.history.length, 3);
  assert.deepEqual(quality.history.filter((review) => review.analysisId === originalB.id).map((review) => review.decision), ['accepted', 'edited']);
});

test('live analysis reservation is durable and idempotent, rejects unsupported references, and allows corrective review only', async (t) => {
  let releaseInference;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let calls = 0;
  const { baseUrl } = await testServer(t, {
    analyze: async () => {
      calls += 1;
      signalStarted();
      return new Promise((resolve) => { releaseInference = resolve; });
    },
  });
  const caseA = (await detail(baseUrl, 'SEW-1001')).case;
  const payload = { source: 'live', expectedVersion: caseA.version };
  let response = await postAnalysis(baseUrl, caseA.id, 'live-analysis-one', payload);
  assert.equal(response.status, 202);
  const ack = await response.json();
  await started;
  response = await postAnalysis(baseUrl, caseA.id, 'live-analysis-one', payload);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).replayed, true);
  assert.equal(calls, 1);
  response = await postAnalysis(baseUrl, caseA.id, 'live-analysis-two', { source: 'live', expectedVersion: ack.version });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'analysis_in_progress' });

  const recommendation = {
    classification: 'authentication',
    observations: [{ text: 'A 401 response was observed.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-INV-001' }] }],
    possibleCause: { text: 'This is an authentication failure.', references: [{ kind: 'diagnostic', id: 'DIAG-WH-INV-001' }] },
    nextSteps: ['Ask the customer to verify the configured key.'],
    draftResponse: 'Please verify the API key.',
    references: [{ kind: 'diagnostic', id: 'DIAG-WH-INV-001' }],
    uncertainty: [],
  };
  releaseInference({
    status: 'completed', recommendation, provider: 'openai', requestedModel: 'gpt-6.1-sol',
    returnedModel: 'gpt-6.1-sol', responseId: 'resp_test_transport_only',
  });
  const analysis = await waitForAnalysis(baseUrl, ack.analysisId);
  assert.equal(analysis.source, 'live');
  assert.equal(analysis.provider, 'openai');
  assert.equal(analysis.returnedModel, 'gpt-6.1-sol');
  assert.equal(analysis.responseId, 'resp_test_transport_only');
  assert.equal(analysis.referenceValidation.valid, false);
  assert.ok(analysis.referenceValidation.unsupportedReferences.some((item) => item.id === 'DIAG-WH-INV-001'));
  assert.equal(analysis.context.diagnostics.some((item) => item.id === 'DIAG-WH-INV-001'), false);

  const updated = (await detail(baseUrl, 'SEW-1001')).case;
  assert.equal(updated.status, 'open');
  assert.equal(updated.activities.some((activity) => activity.type === 'simulated_reply'), false);
  assert.equal(updated.activities.some((activity) => activity.type === 'status_changed'), false);
  response = await postReview(baseUrl, caseA.id, analysis.id, 'bad-reference-accept', { decision: 'accept', expectedVersion: updated.version });
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).error, 'unsupported_references');
  response = await postReview(baseUrl, caseA.id, analysis.id, 'bad-reference-reject', {
    decision: 'reject', expectedVersion: updated.version,
    feedback: 'This diagnostic exists but was not supplied to the analysis. It cannot support the recommendation.',
  });
  assert.equal(response.status, 200);
  assert.equal((await detail(baseUrl, 'SEW-1001')).case.status, 'open');
});

test('live refusal, incomplete, timeout, and malformed-output results become durable terminal states', async (t) => {
  const results = new Map([
    ['SEW-1001', { status: 'refused', failureCode: 'provider_refusal', provider: 'openai', requestedModel: 'gpt-6.1-sol', returnedModel: 'gpt-6.1-sol', responseId: 'resp_refusal_test' }],
    ['SEW-1002', { status: 'incomplete', failureCode: 'provider_incomplete', provider: 'openai', requestedModel: 'gpt-6.1-sol', returnedModel: 'gpt-6.1-sol', responseId: 'resp_incomplete_test' }],
    ['SEW-1003', { status: 'failed', failureCode: 'provider_timeout', provider: 'openai', requestedModel: 'gpt-6.1-sol' }],
  ]);
  const { baseUrl } = await testServer(t, { analyze: async (context) => results.get(context.case.id) });
  const ids = [];
  for (const caseId of ['SEW-1001', 'SEW-1002', 'SEW-1003']) {
    const item = (await detail(baseUrl, caseId)).case;
    const response = await postAnalysis(baseUrl, caseId, 'failure-' + caseId, { source: 'live', expectedVersion: item.version });
    assert.equal(response.status, 202);
    ids.push((await response.json()).analysisId);
  }
  const failures = await Promise.all(ids.map((id) => waitForAnalysis(baseUrl, id)));
  assert.deepEqual(failures.map((item) => [item.status, item.failureCode]), [
    ['refused', 'provider_refusal'],
    ['incomplete', 'provider_incomplete'],
    ['failed', 'provider_timeout'],
  ]);
  assert.equal(failures.every((item) => item.recommendation === null), true);

  const currentA = (await detail(baseUrl, 'SEW-1001')).case;
  results.set('SEW-1001', {
    status: 'completed', recommendation: { classification: 'unknown' },
    provider: 'openai', requestedModel: 'gpt-6.1-sol', returnedModel: 'gpt-6.1-sol', responseId: 'resp_malformed_test',
  });
  const malformed = await postAnalysis(baseUrl, 'SEW-1001', 'failure-malformed', {
    source: 'live', expectedVersion: currentA.version,
  });
  const malformedAck = await malformed.json();
  const malformedAnalysis = await waitForAnalysis(baseUrl, malformedAck.analysisId);
  assert.equal(malformedAnalysis.status, 'failed');
  assert.equal(malformedAnalysis.failureCode, 'invalid_output');
  assert.equal(malformedAnalysis.recommendation, null);
});

test('analysis context over 100 KiB is rejected without a durable reservation', async (t) => {
  const { baseUrl, db } = await testServer(t, { analyze: async () => ({ status: 'failed', failureCode: 'not_expected' }) });
  const insert = db.prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 11; i += 1) {
    insert.run('ACT-LARGE-' + i, 'SEW-1001', `2026-10-20T12:00:${String(i).padStart(2, '0')}.000Z`, 'internal_note', JSON.stringify({ text: 'x'.repeat(10000) }), 3 + i);
  }
  const current = (await detail(baseUrl, 'SEW-1001')).case;
  const response = await postAnalysis(baseUrl, 'SEW-1001', 'oversized-context', {
    source: 'live', expectedVersion: current.version,
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'analysis_context_too_large' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_key = 'oversized-context'").get().count, 0);
  assert.equal((await detail(baseUrl, 'SEW-1001')).case.version, current.version);
});
