import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AnalysisContextTooLargeError,
  AnalysisContextIntegrityError,
  AnalysisInProgressError,
  UnsupportedAnalysisReferencesError,
  appendAnalysisReview,
  appendCaseActivity,
  associateCaseEvidence,
  changeCaseStatus,
  finishAnalysis,
  getAnalysis,
  getCase,
  listCaseAnalyses,
  initializeDatabase,
  listReviewQuality,
  openDatabase,
  recoverInterruptedAnalyses,
  recoverPendingAnalysisCompletions,
  reserveAnalysis,
  runIdempotentMutation,
  stageAnalysisResult,
} from '../server/database.js';
import { analysisFixtures } from '../fixtures/analyses.js';
import { validateRecommendation } from '../shared/recommendation.js';
import { temporaryDatabase } from './helpers.js';

function mutation(db, { key, caseId, route, payload }, mutate) {
  return runIdempotentMutation(db, {
    requestKey: key,
    method: route.includes('/status') ? 'PATCH' : 'POST',
    route,
    caseId,
    payload,
    expectedVersion: payload.expectedVersion,
  }, mutate);
}

function reserveLive(db, caseId, key, version) {
  const payload = { source: 'live', expectedVersion: version };
  return mutation(db, { key, caseId, route: `/api/cases/${caseId}/analyses`, payload }, (connection) =>
    reserveAnalysis(connection, { caseId, source: 'live' }));
}

test('migration 5 adds only analyses and reviews while preserving M1–M3 state', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());

  let caseA = getCase(db, 'SEW-1001');
  mutation(db, {
    key: 'm4-migration-note', caseId: caseA.id, route: `/api/cases/${caseA.id}/activities`,
    payload: { type: 'internal_note', text: 'Preserve this M2 note.', expectedVersion: caseA.version },
  }, (connection) => appendCaseActivity(connection, { caseId: caseA.id, type: 'internal_note', text: 'Preserve this M2 note.' }));
  const caseB = getCase(db, 'SEW-1002');
  mutation(db, {
    key: 'm4-migration-evidence', caseId: caseB.id, route: `/api/cases/${caseB.id}/evidence`,
    payload: { diagnosticIds: ['DIAG-WH-SUB-001'], expectedVersion: caseB.version },
  }, (connection) => associateCaseEvidence(connection, { caseId: caseB.id, diagnosticIds: ['DIAG-WH-SUB-001'] }));
  const updatedB = getCase(db, 'SEW-1002');
  mutation(db, {
    key: 'm4-migration-resolution', caseId: updatedB.id, route: `/api/cases/${updatedB.id}/status`,
    payload: { status: 'resolved', outcome: 'Preserve the M2 outcome.', expectedVersion: updatedB.version },
  }, (connection) => changeCaseStatus(connection, {
    caseId: updatedB.id, status: 'resolved', context: { outcome: 'Preserve the M2 outcome.' },
  }));

  const before = {
    cases: db.prepare('SELECT id, status, version, updated_at FROM cases ORDER BY id').all().map((row) => ({ ...row })),
    activities: db.prepare('SELECT id, case_id, activity_type, payload, sequence FROM activities ORDER BY case_id, sequence').all().map((row) => ({ ...row })),
    evidence: db.prepare('SELECT case_id, diagnostic_id, linked_at, source FROM case_evidence ORDER BY case_id, diagnostic_id').all().map((row) => ({ ...row })),
    diagnostics: db.prepare('SELECT id, organization_id, outcome, http_status FROM diagnostics ORDER BY id').all().map((row) => ({ ...row })),
    receipts: db.prepare('SELECT request_key, fingerprint, response_json FROM mutation_receipts ORDER BY request_key').all().map((row) => ({ ...row })),
  };
  db.exec('DROP TABLE reviews; DROP TABLE analyses; PRAGMA user_version = 4');
  initializeDatabase(db);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('analyses', 'reviews') ORDER BY name").all().map((row) => row.name), ['analyses', 'reviews']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count, 0);
  assert.deepEqual({
    cases: db.prepare('SELECT id, status, version, updated_at FROM cases ORDER BY id').all().map((row) => ({ ...row })),
    activities: db.prepare('SELECT id, case_id, activity_type, payload, sequence FROM activities ORDER BY case_id, sequence').all().map((row) => ({ ...row })),
    evidence: db.prepare('SELECT case_id, diagnostic_id, linked_at, source FROM case_evidence ORDER BY case_id, diagnostic_id').all().map((row) => ({ ...row })),
    diagnostics: db.prepare('SELECT id, organization_id, outcome, http_status FROM diagnostics ORDER BY id').all().map((row) => ({ ...row })),
    receipts: db.prepare('SELECT request_key, fingerprint, response_json FROM mutation_receipts ORDER BY request_key').all().map((row) => ({ ...row })),
  }, before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('analysis reservation is atomic, idempotent, snapshot-isolated, and late results are fenced', (t) => {
  const { databasePath } = temporaryDatabase(t);
  let db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());

  db.exec("CREATE TRIGGER fail_analysis_activity BEFORE INSERT ON activities WHEN NEW.activity_type = 'analysis_started' BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END");
  const originalVersion = getCase(db, 'SEW-1001').version;
  assert.throws(() => reserveLive(db, 'SEW-1001', 'atomic-analysis-failure', originalVersion));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
  assert.equal(getCase(db, 'SEW-1001').version, originalVersion);
  db.exec('DROP TRIGGER fail_analysis_activity');

  const reservation = reserveLive(db, 'SEW-1001', 'live-analysis-once', originalVersion);
  const duplicate = reserveLive(db, 'SEW-1001', 'live-analysis-once', originalVersion);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(duplicate.response, reservation.response);
  assert.throws(() => reserveLive(db, 'SEW-1001', 'another-live-analysis', reservation.response.version), AnalysisInProgressError);

  const noteVersion = reservation.response.version;
  mutation(db, {
    key: 'after-snapshot-note', caseId: 'SEW-1001', route: '/api/cases/SEW-1001/activities',
    payload: { type: 'internal_note', text: 'Added while the provider request was running.', expectedVersion: noteVersion },
  }, (connection) => appendCaseActivity(connection, {
    caseId: 'SEW-1001', type: 'internal_note', text: 'Added while the provider request was running.',
  }));
  const originalRecommendation = structuredClone(analysisFixtures[0].recommendation);
  originalRecommendation.observations[0].references.push({ kind: 'diagnostic', id: 'DIAG-WH-INV-001' });
  originalRecommendation.references.push({ kind: 'diagnostic', id: 'DIAG-WH-INV-001' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnostics WHERE id = ?').get('DIAG-WH-INV-001').count, 1);
  const completion = finishAnalysis(db, {
    analysisId: reservation.response.analysisId,
    result: {
      status: 'completed', recommendation: originalRecommendation, provider: 'openai',
      requestedModel: 'gpt-6.1-sol', returnedModel: 'gpt-6.1-sol', responseId: 'resp_persisted_test',
    },
  });
  assert.equal(completion.applied, true);
  const completed = getAnalysis(db, reservation.response.analysisId);
  assert.equal(completed.referenceValidation.valid, false);
  assert.ok(completed.referenceValidation.unsupportedReferences.some((item) => item.id === 'DIAG-WH-INV-001'));
  assert.equal(completed.context.conversation.some((item) => item.text === 'Added while the provider request was running.'), false);
  assert.equal(getCase(db, 'SEW-1001').activities.some((activity) => activity.payload.text === 'Added while the provider request was running.'), true);
  assert.equal(completed.provider, 'openai');
  assert.equal(completed.returnedModel, 'gpt-6.1-sol');

  const beforeReview = getCase(db, 'SEW-1001');
  const rejectPayload = {
    decision: 'reject', expectedVersion: beforeReview.version,
    feedback: 'This real diagnostic record was not included in the supplied context.',
  };
  const request = {
    requestKey: 'unsupported-reference-accept', method: 'POST',
    route: '/api/cases/SEW-1001/analyses/' + completed.id + '/reviews',
    caseId: 'SEW-1001', payload: { decision: 'accept', expectedVersion: beforeReview.version },
    expectedVersion: beforeReview.version,
  };
  assert.throws(() => runIdempotentMutation(db, request, (connection) => appendAnalysisReview(connection, {
    caseId: 'SEW-1001', analysisId: completed.id, decision: 'accept',
  })), UnsupportedAnalysisReferencesError);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_key = ?').get('unsupported-reference-accept').count, 0);

  const rejected = runIdempotentMutation(db, {
    ...request,
    requestKey: 'unsupported-reference-reject',
    payload: rejectPayload,
    expectedVersion: rejectPayload.expectedVersion,
  }, (connection) => appendAnalysisReview(connection, {
    caseId: 'SEW-1001', analysisId: completed.id, decision: 'reject', feedback: rejectPayload.feedback,
  }));
  assert.equal(rejected.response.decision, 'rejected');
  assert.equal(getCase(db, 'SEW-1001').status, 'open');
  const afterReview = getAnalysis(db, completed.id);
  assert.deepEqual(afterReview.recommendation, originalRecommendation);
  assert.equal(afterReview.reviews[0].feedback, rejectPayload.feedback);
  assert.deepEqual(listReviewQuality(db).totals.live, { reviewed: 1, accepted: 0, edited: 0, rejected: 1 });
  assert.equal(finishAnalysis(db, {
    analysisId: completed.id,
    result: { status: 'completed', recommendation: analysisFixtures[1].recommendation },
  }).applied, false);
  assert.deepEqual(getAnalysis(db, completed.id).recommendation, originalRecommendation);

  const corrected = structuredClone(originalRecommendation);
  corrected.classification = 'authentication';
  corrected.possibleCause = { text: 'The supplied 401 responses indicate rejected authentication.', references: [{ kind: 'diagnostic', id: 'DIAG-AUTH-401-001' }] };
  corrected.observations = corrected.observations.map((item) => ({
    ...item,
    references: item.references.filter((reference) => reference.id !== 'DIAG-WH-INV-001'),
  }));
  corrected.references = corrected.references.filter((reference) => reference.id !== 'DIAG-WH-INV-001');
  const currentCase = getCase(db, 'SEW-1001');
  const correctedReview = runIdempotentMutation(db, {
    requestKey: 'correct-unsupported-output', method: 'POST',
    route: `/api/cases/SEW-1001/analyses/${completed.id}/reviews`, caseId: 'SEW-1001',
    payload: { decision: 'edit', recommendation: corrected, expectedVersion: currentCase.version }, expectedVersion: currentCase.version,
  }, (connection) => appendAnalysisReview(connection, { caseId: 'SEW-1001', analysisId: completed.id, decision: 'edit', recommendation: corrected }));
  assert.equal(correctedReview.response.decision, 'edited');
  assert.equal(getAnalysis(db, completed.id).latestReview.recommendation.classification, 'authentication');
  assert.deepEqual(getAnalysis(db, completed.id).recommendation, originalRecommendation);

  const current = getCase(db, 'SEW-1001');
  const next = reserveLive(db, current.id, 'deliberate-reanalysis', current.version);
  assert.equal(getAnalysis(db, next.response.analysisId).context.correctiveFeedback[0].feedback, rejectPayload.feedback);

  db.close();
  db = openDatabase(databasePath);
  initializeDatabase(db);
  assert.equal(getAnalysis(db, next.response.analysisId).status, 'running');
  assert.deepEqual(recoverInterruptedAnalyses(db, '2026-10-20T12:00:00.000Z'), [next.response.analysisId]);
  const interrupted = getAnalysis(db, next.response.analysisId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.failureCode, 'process_interrupted');
  assert.equal(finishAnalysis(db, {
    analysisId: next.response.analysisId,
    result: { status: 'completed', recommendation: analysisFixtures[0].recommendation },
  }).applied, false);
  assert.equal(getAnalysis(db, next.response.analysisId).status, 'interrupted');

  db.exec('DELETE FROM reviews; DELETE FROM analyses;');
  assert.equal(finishAnalysis(db, {
    analysisId: next.response.analysisId,
    result: { status: 'completed', recommendation: analysisFixtures[0].recommendation },
  }).applied, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('terminal persistence failure keeps a staged result recoverable without another inference', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());
  const current = getCase(db, 'SEW-1001');
  const reservation = reserveLive(db, current.id, 'stage-result-before-terminal', current.version);
  const result = {
    status: 'completed', recommendation: analysisFixtures[0].recommendation,
    provider: 'openai', requestedModel: 'gpt-6.1-sol', returnedModel: 'gpt-6.1-sol', responseId: 'resp_staged_result',
  };
  assert.equal(stageAnalysisResult(db, { analysisId: reservation.response.analysisId, result }).applied, true);
  db.exec("CREATE TRIGGER fail_terminal_analysis BEFORE UPDATE OF status ON analyses WHEN NEW.status <> OLD.status BEGIN SELECT RAISE(ABORT, 'injected terminal write failure'); END");
  assert.throws(() => finishAnalysis(db, { analysisId: reservation.response.analysisId }));
  assert.equal(getAnalysis(db, reservation.response.analysisId).completionPending, true);
  assert.deepEqual(recoverInterruptedAnalyses(db), []);
  db.exec('DROP TRIGGER fail_terminal_analysis');
  assert.deepEqual(recoverPendingAnalysisCompletions(db), [reservation.response.analysisId]);
  const recovered = getAnalysis(db, reservation.response.analysisId);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.recommendation.classification, 'other');
  assert.equal(recovered.responseId, 'resp_staged_result');
});

test('context integrity rejects stale cross-organization evidence without a receipt', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());
  const current = getCase(db, 'SEW-1001');
  db.prepare('UPDATE cases SET organization_id = ? WHERE id = ?').run('ORG-CHANGED', current.id);
  const payload = { source: 'live', expectedVersion: current.version };
  assert.throws(() => runIdempotentMutation(db, {
    requestKey: 'reject-cross-organization-context', method: 'POST', route: '/api/cases/SEW-1001/analyses',
    caseId: current.id, payload, expectedVersion: current.version,
  }, (connection) => reserveAnalysis(connection, { caseId: current.id, source: 'live' })), AnalysisContextIntegrityError);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
});

test('recommendation semantic validation rejects whitespace while allowing empty observations and nullable causes', () => {
  const valid = structuredClone(analysisFixtures[2].recommendation);
  assert.equal(validateRecommendation(valid).success, true);
  for (const invalid of [
    { ...valid, draftResponse: '   ' },
    { ...valid, nextSteps: ['\t'] },
    { ...valid, uncertainty: ['  '] },
    { ...valid, observations: [{ text: ' ', references: [] }] },
    { ...valid, possibleCause: { text: '\n', references: [] } },
  ]) assert.equal(validateRecommendation(invalid).success, false);
});

test('analyses remain in creation order when timestamps are equal', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());

  const caseA = getCase(db, 'SEW-1001');
  const fixtureId = 'fixture-a-intentional-outage-error';
  const now = '2026-10-20T12:00:00.000Z';
  const create = (key, expectedVersion) => mutation(db, {
    key, caseId: caseA.id, route: `/api/cases/${caseA.id}/analyses`,
    payload: { source: 'fixture', fixtureId, expectedVersion },
  }, (connection) => reserveAnalysis(connection, { caseId: caseA.id, source: 'fixture', fixtureId, now }));

  const first = create('same-time-analysis-1', caseA.version);
  const second = create('same-time-analysis-2', first.response.version);
  const analyses = listCaseAnalyses(db, caseA.id);
  assert.deepEqual(analyses.map((analysis) => analysis.id), [first.response.analysisId, second.response.analysisId]);
  assert.deepEqual(analyses.map((analysis) => analysis.capturedCaseVersion), [caseA.version, first.response.version]);
});

test('oversized saved context is rejected without a partial reservation', (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  t.after(() => db.close());
  const insert = db.prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 11; i += 1) {
    insert.run('ACT-LARGE-' + i, 'SEW-1001', `2026-10-20T12:00:${String(i).padStart(2, '0')}.000Z`, 'internal_note', JSON.stringify({ text: 'x'.repeat(10000) }), 3 + i);
  }
  const version = getCase(db, 'SEW-1001').version;
  const payload = { source: 'live', expectedVersion: version };
  assert.throws(() => mutation(db, {
    key: 'oversized-analysis', caseId: 'SEW-1001', route: '/api/cases/SEW-1001/analyses', payload,
  }, (connection) => reserveAnalysis(connection, { caseId: 'SEW-1001', source: 'live' })), AnalysisContextTooLargeError);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_key = ?').get('oversized-analysis').count, 0);
  assert.equal(getCase(db, 'SEW-1001').version, version);
  assert.equal(getAnalysis(db, 'AN-DOES-NOT-EXIST'), null);
});
