import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initialCases } from '../fixtures/cases.js';
import { initialDiagnostics } from '../fixtures/diagnostics.js';
import { initialKnowledgeEntries } from '../fixtures/knowledge.js';
import { analysisFixtures } from '../fixtures/analyses.js';
import { recommendationReferences, recommendationSchemaVersion, validateRecommendation } from '../shared/recommendation.js';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = realpathSync(resolve(serverDirectory, '..'));
export const demoDatabasePath = resolve(projectRoot, 'data', 'supportops.sqlite');

const migrations = [
  {
    version: 1,
    up(db) {
      db.exec(
        'CREATE TABLE cases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, organization_name TEXT NOT NULL, subject TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN (\'email\', \'telegram\', \'manual\')), priority TEXT NOT NULL CHECK (priority IN (\'low\', \'medium\', \'high\', \'urgent\')), status TEXT NOT NULL CHECK (status IN (\'open\', \'in_progress\', \'escalated\', \'resolved\')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)) STRICT; ' +
          'CREATE TABLE activities (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, created_at TEXT NOT NULL, activity_type TEXT NOT NULL, payload TEXT NOT NULL) STRICT; ' +
          'CREATE TABLE mutation_receipts (request_key TEXT PRIMARY KEY CHECK (length(request_key) BETWEEN 1 AND 200), fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;',
      );
    },
  },
  {
    version: 2,
    up(db) {
      db.exec('CREATE INDEX activities_case_order ON activities (case_id, created_at, id)');
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(
        'DROP INDEX activities_case_order; ' +
          'CREATE TABLE activities_with_sequence (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, created_at TEXT NOT NULL, activity_type TEXT NOT NULL, payload TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0)) STRICT; ' +
          'INSERT INTO activities_with_sequence (id, case_id, created_at, activity_type, payload, sequence) ' +
          'SELECT id, case_id, created_at, activity_type, payload, ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY created_at, rowid) FROM activities; ' +
          'DROP TABLE activities; ' +
          'ALTER TABLE activities_with_sequence RENAME TO activities; ' +
          'CREATE UNIQUE INDEX activities_case_order ON activities (case_id, sequence)',
      );
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(
        "CREATE TABLE diagnostics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('api_request', 'webhook_attempt')), request_id TEXT, event_id TEXT, event_type TEXT NOT NULL, observed_at TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'timed_out', 'acknowledged', 'pending')), http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599), attempt_number INTEGER CHECK (attempt_number IS NULL OR attempt_number > 0), error_code TEXT, error_details TEXT, CHECK ((kind = 'api_request' AND request_id IS NOT NULL AND event_id IS NULL AND attempt_number IS NULL) OR (kind = 'webhook_attempt' AND request_id IS NULL AND event_id IS NOT NULL AND attempt_number IS NOT NULL)), CHECK (outcome <> 'pending' OR (observed_at IS NULL AND http_status IS NULL)), CHECK (outcome <> 'timed_out' OR http_status IS NULL), CHECK (outcome <> 'acknowledged' OR (http_status IS NOT NULL AND http_status BETWEEN 200 AND 299)), UNIQUE (organization_id, event_id, attempt_number)) STRICT; " +
          'CREATE INDEX diagnostics_request_id ON diagnostics (request_id); ' +
          'CREATE INDEX diagnostics_event_id ON diagnostics (event_id, organization_id); ' +
          "CREATE TABLE case_evidence (case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, diagnostic_id TEXT NOT NULL REFERENCES diagnostics(id), linked_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('synthetic_seed', 'operator')), PRIMARY KEY (case_id, diagnostic_id)) STRICT; " +
          'CREATE INDEX case_evidence_diagnostic_id ON case_evidence (diagnostic_id); ' +
          'CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version > 0), title TEXT NOT NULL, content TEXT NOT NULL) STRICT;',
      );
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(
        "CREATE TABLE analyses (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, source TEXT NOT NULL CHECK (source IN ('live', 'fixture')), fixture_id TEXT, fixture_version TEXT, request_envelope_json TEXT, pending_result_json TEXT, status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'refused', 'incomplete', 'interrupted')), created_at TEXT NOT NULL, completed_at TEXT, captured_case_version INTEGER NOT NULL CHECK (captured_case_version > 0), context_json TEXT NOT NULL, reference_allowlist_json TEXT NOT NULL, prompt_version TEXT, schema_version TEXT NOT NULL, provider TEXT, requested_model TEXT, returned_model TEXT, response_id TEXT, output_json TEXT, reference_validation_json TEXT, failure_code TEXT, CHECK ((source = 'fixture' AND fixture_id IS NOT NULL AND fixture_version IS NOT NULL AND request_envelope_json IS NULL AND pending_result_json IS NULL AND provider IS NULL AND requested_model IS NULL AND returned_model IS NULL AND response_id IS NULL AND status <> 'running') OR (source = 'live' AND fixture_id IS NULL AND fixture_version IS NULL)), CHECK ((status = 'running' AND completed_at IS NULL AND output_json IS NULL AND reference_validation_json IS NULL AND failure_code IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND output_json IS NOT NULL AND reference_validation_json IS NOT NULL AND failure_code IS NULL AND pending_result_json IS NULL) OR (status IN ('failed', 'refused', 'incomplete', 'interrupted') AND completed_at IS NOT NULL AND failure_code IS NOT NULL AND pending_result_json IS NULL))) STRICT; " +
          'CREATE INDEX analyses_case_order ON analyses (case_id, captured_case_version, created_at, id); ' +
          "CREATE UNIQUE INDEX analyses_one_running_live_per_case ON analyses (case_id) WHERE source = 'live' AND status = 'running'; " +
          "CREATE TABLE reviews (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE, decision TEXT NOT NULL CHECK (decision IN ('accepted', 'edited', 'rejected')), created_at TEXT NOT NULL, case_version INTEGER NOT NULL CHECK (case_version > 0), reviewed_recommendation_json TEXT, feedback TEXT, CHECK ((decision = 'rejected' AND reviewed_recommendation_json IS NULL AND feedback IS NOT NULL AND length(trim(feedback)) > 0) OR (decision IN ('accepted', 'edited') AND reviewed_recommendation_json IS NOT NULL AND feedback IS NULL))) STRICT; " +
          'CREATE INDEX reviews_case_order ON reviews (case_id, created_at, id); ' +
          'CREATE INDEX reviews_analysis_order ON reviews (analysis_id, created_at, id)',
      );
    },
  },
];

export function openDatabase(databasePath) {
  const path = resolve(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function withTransaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(db) {
  withTransaction(db, () => {
    const currentVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new Error('Invalid database schema version.');
    }
    if (currentVersion > migrations.length) {
      throw new Error('Database schema is newer than this application.');
    }

    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      migration.up(db);
      db.exec('PRAGMA user_version = ' + migration.version);
    }
  });
}

function insertInitialCases(db) {
  const insertCase = db.prepare(
    'INSERT INTO cases (id, organization_id, organization_name, subject, channel, priority, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  );
  const insertActivity = db.prepare(
    "INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, 'initial_report', ?, 1)",
  );

  for (const item of initialCases) {
    insertCase.run(
      item.id,
      item.organizationId,
      item.organizationName,
      item.subject,
      item.channel,
      item.priority,
      item.status,
      item.createdAt,
      item.updatedAt,
    );
    insertActivity.run(
      'ACT-' + item.id + '-REPORT',
      item.id,
      item.createdAt,
      JSON.stringify({ text: item.initialReport }),
    );
  }
}

function seedIfEmpty(db) {
  withTransaction(db, () => {
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM cases').get().count);
    if (count === 0) insertInitialCases(db);
  });
}

export function initializeDatabase(db) {
  migrate(db);
  seedIfEmpty(db);
  withTransaction(db, () => seedTechnicalFixtures(db));
}

function insertDiagnosticFixtures(db) {
  const insert = db.prepare(
    'INSERT INTO diagnostics (id, organization_id, kind, request_id, event_id, event_type, observed_at, outcome, http_status, attempt_number, error_code, error_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  );
  for (const item of initialDiagnostics) {
    insert.run(
      item.id, item.organizationId, item.kind, item.requestId, item.eventId, item.eventType,
      item.observedAt, item.outcome, item.httpStatus, item.attemptNumber, item.errorCode, item.errorDetails,
    );
  }
}

function seedTechnicalFixtures(db, now = new Date().toISOString()) {
  insertDiagnosticFixtures(db);
  const insertKnowledge = db.prepare(
    'INSERT INTO knowledge_entries (id, version, title, content) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  );
  for (const item of initialKnowledgeEntries) insertKnowledge.run(item.id, item.version, item.title, item.content);

  const caseRow = db.prepare('SELECT organization_id FROM cases WHERE id = ?').get('SEW-1001');
  if (!caseRow || caseRow.organization_id !== 'ORG-ALDER-01') return;
  const seedIds = initialDiagnostics.filter((item) => item.organizationId === 'ORG-ALDER-01').map((item) => item.id);
  const rows = db.prepare(
    'SELECT id, organization_id FROM diagnostics WHERE id IN (' + seedIds.map(() => '?').join(', ') + ')',
  ).all(...seedIds);
  if (rows.length !== seedIds.length || rows.some((row) => row.organization_id !== caseRow.organization_id)) {
    throw new Error('Synthetic diagnostic seed identifiers conflict with existing data.');
  }
  const linked = new Set(
    db.prepare('SELECT diagnostic_id FROM case_evidence WHERE case_id = ?').all('SEW-1001').map((row) => row.diagnostic_id),
  );
  const addedIds = seedIds.filter((id) => !linked.has(id));
  if (addedIds.length === 0) return;

  const insertEvidence = db.prepare(
    "INSERT INTO case_evidence (case_id, diagnostic_id, linked_at, source) VALUES ('SEW-1001', ?, ?, 'synthetic_seed')",
  );
  for (const id of addedIds) insertEvidence.run(id, now);
  const activityId = 'ACT-' + randomUUID();
  const sequence = nextActivitySequence(db, 'SEW-1001');
  db.prepare('UPDATE cases SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, 'SEW-1001');
  db.prepare(
    'INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(activityId, 'SEW-1001', now, 'evidence_seeded', JSON.stringify({
    source: 'synthetic_seed',
    diagnosticIds: addedIds,
    note: 'Synthetic demo evidence associations installed during initialization.',
  }), sequence);
}

function mapCase(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    subject: row.subject,
    channel: row.channel,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    initialReport: row.initial_report ? JSON.parse(row.initial_report).text : null,
  };
}

const caseSelect =
  "SELECT c.id, c.organization_id, c.organization_name, c.subject, c.channel, c.priority, c.status, c.created_at, c.updated_at, c.version, a.payload AS initial_report FROM cases AS c LEFT JOIN activities AS a ON a.case_id = c.id AND a.activity_type = 'initial_report'";

export function listCases(db, status) {
  const query = caseSelect + (status ? ' WHERE c.status = ?' : '') + ' ORDER BY c.updated_at DESC, c.id';
  return (status ? db.prepare(query).all(status) : db.prepare(query).all()).map(mapCase);
}

export function getCase(db, caseId) {
  const row = db.prepare(caseSelect + ' WHERE c.id = ?').get(caseId);
  if (!row) return null;
  const item = mapCase(row);
  item.activities = db
    .prepare('SELECT id, created_at, activity_type, payload, sequence FROM activities WHERE case_id = ? ORDER BY sequence')
    .all(caseId)
    .map((activity) => ({
      id: activity.id,
      createdAt: activity.created_at,
      type: activity.activity_type,
      payload: JSON.parse(activity.payload),
      sequence: activity.sequence,
    }));
  item.evidence = db.prepare(
    'SELECT d.id, d.organization_id, d.kind, d.request_id, d.event_id, d.event_type, d.observed_at, d.outcome, d.http_status, d.attempt_number, d.error_code, d.error_details, e.linked_at, e.source FROM case_evidence AS e JOIN diagnostics AS d ON d.id = e.diagnostic_id WHERE e.case_id = ? ORDER BY e.linked_at, d.id',
  ).all(caseId).map(mapDiagnostic);
  item.analyses = listCaseAnalyses(db, caseId);
  item.analysisFixtures = listAvailableAnalysisFixtures(db, caseId);
  return item;
}

function mapDiagnostic(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    requestId: row.request_id,
    eventId: row.event_id,
    eventType: row.event_type,
    observedAt: row.observed_at,
    outcome: row.outcome,
    httpStatus: row.http_status,
    attemptNumber: row.attempt_number,
    errorCode: row.error_code,
    errorDetails: row.error_details,
    ...(row.linked_at === undefined ? {} : { linkedAt: row.linked_at, source: row.source }),
  };
}

const diagnosticSelect =
  'SELECT id, organization_id, kind, request_id, event_id, event_type, observed_at, outcome, http_status, attempt_number, error_code, error_details FROM diagnostics';

export function searchDiagnostics(db, query) {
  const matches = db.prepare(
    diagnosticSelect + ' WHERE id = ? COLLATE BINARY OR request_id = ? COLLATE BINARY OR event_id = ? COLLATE BINARY ORDER BY kind, event_id, request_id, attempt_number, observed_at, id',
  ).all(query, query, query).map(mapDiagnostic);
  const seen = new Set();
  const histories = [];
  for (const match of matches) {
    if (match.kind !== 'webhook_attempt') continue;
    const key = JSON.stringify([match.organizationId, match.eventId]);
    if (seen.has(key)) continue;
    seen.add(key);
    histories.push({
      organizationId: match.organizationId,
      eventId: match.eventId,
      attempts: db.prepare(
        diagnosticSelect + ' WHERE organization_id = ? COLLATE BINARY AND event_id = ? COLLATE BINARY ORDER BY attempt_number, id',
      ).all(match.organizationId, match.eventId).map(mapDiagnostic),
    });
  }
  return { matches, histories };
}

export function getDiagnostic(db, diagnosticId) {
  const row = db.prepare(diagnosticSelect + ' WHERE id = ?').get(diagnosticId);
  if (!row) return null;
  const diagnostic = mapDiagnostic(row);
  const attempts = diagnostic.kind === 'webhook_attempt'
    ? db.prepare(diagnosticSelect + ' WHERE organization_id = ? COLLATE BINARY AND event_id = ? COLLATE BINARY ORDER BY attempt_number, id')
      .all(diagnostic.organizationId, diagnostic.eventId).map(mapDiagnostic)
    : [];
  return { diagnostic, attempts };
}

export function listKnowledgeEntries(db) {
  return db.prepare('SELECT id, version, title FROM knowledge_entries ORDER BY id').all().map((row) => ({
    id: row.id,
    version: row.version,
    title: row.title,
  }));
}

export function getKnowledgeEntry(db, entryId) {
  const row = db.prepare('SELECT id, version, title, content FROM knowledge_entries WHERE id = ?').get(entryId);
  return row ? { id: row.id, version: row.version, title: row.title, content: row.content } : null;
}

function nextActivitySequence(db, caseId) {
  return db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM activities WHERE case_id = ?').get(caseId).sequence;
}

const analysisSelect = 'SELECT id, case_id, source, fixture_id, fixture_version, request_envelope_json, pending_result_json, status, created_at, completed_at, captured_case_version, context_json, reference_allowlist_json, prompt_version, schema_version, provider, requested_model, returned_model, response_id, output_json, reference_validation_json, failure_code FROM analyses';

function mapReview(row) {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    caseId: row.case_id,
    decision: row.decision,
    createdAt: row.created_at,
    caseVersion: row.case_version,
    recommendation: row.reviewed_recommendation_json ? JSON.parse(row.reviewed_recommendation_json) : null,
    feedback: row.feedback,
  };
}

function mapAnalysis(db, row, { includeContext = false } = {}) {
  const reviews = db.prepare('SELECT id, analysis_id, case_id, decision, created_at, case_version, reviewed_recommendation_json, feedback FROM reviews WHERE analysis_id = ? ORDER BY case_version')
    .all(row.id).map(mapReview);
  return {
    id: row.id,
    caseId: row.case_id,
    source: row.source,
    fixtureId: row.fixture_id,
    fixtureVersion: row.fixture_version,
    fixtureLabel: row.fixture_id ? analysisFixtures.find((item) => item.id === row.fixture_id)?.label : null,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    capturedCaseVersion: row.captured_case_version,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    provider: row.provider,
    requestedModel: row.requested_model,
    returnedModel: row.returned_model,
    responseId: row.response_id,
    completionPending: Boolean(row.pending_result_json),
    recommendation: row.output_json ? JSON.parse(row.output_json) : null,
    referenceValidation: row.reference_validation_json ? JSON.parse(row.reference_validation_json) : null,
    failureCode: row.failure_code,
    reviews,
    latestReview: reviews.at(-1) || null,
    referenceAllowlist: JSON.parse(row.reference_allowlist_json),
    ...(includeContext ? {
      context: JSON.parse(row.context_json),
      requestEnvelope: row.request_envelope_json ? JSON.parse(row.request_envelope_json) : null,
    } : {}),
  };
}

export function listCaseAnalyses(db, caseId) {
  return db.prepare(analysisSelect + ' WHERE case_id = ? ORDER BY captured_case_version, created_at, id').all(caseId)
    .map((row) => mapAnalysis(db, row));
}

export function getAnalysis(db, analysisId) {
  const row = db.prepare(analysisSelect + ' WHERE id = ?').get(analysisId);
  return row ? mapAnalysis(db, row, { includeContext: true }) : null;
}

export class AnalysisInProgressError extends Error {
  constructor() { super('A live analysis is already running for this case.'); this.code = 'analysis_in_progress'; }
}

export class AnalysisContextTooLargeError extends Error {
  constructor() { super('The saved analysis context exceeds the supported limit.'); this.code = 'analysis_context_too_large'; }
}

export class AnalysisContextIntegrityError extends Error {
  constructor() { super('Linked diagnostic ownership does not match the case organization.'); this.code = 'analysis_context_integrity_error'; }
}

export class InvalidAnalysisFixtureError extends Error {
  constructor() { super('The requested evaluation fixture is not available for this case.'); this.code = 'invalid_analysis_fixture'; }
}

export class AnalysisNotFoundError extends Error {
  constructor() { super('The requested analysis does not exist.'); this.code = 'analysis_not_found'; }
}

export class AnalysisNotReadyError extends Error {
  constructor() { super('The analysis is not ready for review.'); this.code = 'analysis_not_ready'; }
}

export class UnsupportedAnalysisReferencesError extends Error {
  constructor(details) { super('The recommendation contains references outside its supplied context.'); this.code = 'unsupported_references'; this.details = details; }
}

export class InvalidReviewError extends Error {
  constructor() { super('The review request is invalid.'); this.code = 'invalid_review'; }
}

function buildAnalysisContext(db, caseId) {
  const item = getCase(db, caseId);
  if (item.evidence.some((diagnostic) => diagnostic.organizationId !== item.organizationId)) {
    throw new AnalysisContextIntegrityError();
  }
  const knowledge = db.prepare('SELECT id, version, title, content FROM knowledge_entries ORDER BY id').all().map((row) => ({
    id: row.id, version: row.version, title: row.title, content: row.content,
  }));
  const correctiveFeedback = db.prepare(
    "SELECT r.id, r.analysis_id, r.created_at, r.feedback, a.source, a.fixture_id, a.fixture_version, a.provider, a.requested_model, a.returned_model, a.response_id FROM reviews AS r JOIN analyses AS a ON a.id = r.analysis_id WHERE r.case_id = ? AND r.decision = 'rejected' ORDER BY r.case_version, r.id",
  ).all(caseId).map((row) => ({
    reviewId: row.id,
    analysisId: row.analysis_id,
    createdAt: row.created_at,
    feedback: row.feedback,
    source: row.source,
    ...(row.fixture_id ? { fixtureId: row.fixture_id, fixtureVersion: row.fixture_version } : {
      provider: row.provider,
      requestedModel: row.requested_model,
      returnedModel: row.returned_model,
      responseId: row.response_id,
    }),
  }));
  const operatorHistory = item.activities
    .filter((activity) => activity.type === 'status_changed' && ['escalated', 'resolved'].includes(activity.payload.to))
    .slice(-20)
    .map((activity) => ({
      id: activity.id,
      createdAt: activity.createdAt,
      from: activity.payload.from,
      to: activity.payload.to,
      ...(activity.payload.reason !== undefined ? { reason: activity.payload.reason } : {}),
      ...(activity.payload.findings !== undefined ? { findings: activity.payload.findings } : {}),
      ...(activity.payload.questions !== undefined ? { questions: activity.payload.questions } : {}),
      ...(activity.payload.evidenceIds !== undefined ? { evidenceIds: activity.payload.evidenceIds } : {}),
      ...(activity.payload.outcome !== undefined ? { outcome: activity.payload.outcome } : {}),
    }));
  const context = {
    case: {
      id: item.id,
      organizationId: item.organizationId,
      organizationName: item.organizationName,
      subject: item.subject,
      channel: item.channel,
      priority: item.priority,
      status: item.status,
      initialReport: item.initialReport,
    },
    conversation: item.activities
      .filter((activity) => ['initial_report', 'internal_note', 'simulated_reply'].includes(activity.type))
      .map((activity) => ({ id: activity.id, createdAt: activity.createdAt, type: activity.type, text: activity.payload.text })),
    operatorHistory,
    correctiveFeedback,
    diagnostics: item.evidence.map((diagnostic) => ({
      id: diagnostic.id,
      kind: diagnostic.kind,
      requestId: diagnostic.requestId,
      eventId: diagnostic.eventId,
      eventType: diagnostic.eventType,
      observedAt: diagnostic.observedAt,
      outcome: diagnostic.outcome,
      httpStatus: diagnostic.httpStatus,
      attemptNumber: diagnostic.attemptNumber,
      errorCode: diagnostic.errorCode,
      errorDetails: diagnostic.errorDetails,
    })),
    knowledge,
  };
  return {
    context,
    contextJson: JSON.stringify(context),
    allowlist: { diagnostics: context.diagnostics.map((record) => record.id), knowledge: knowledge.map((entry) => entry.id) },
  };
}

function validateSuppliedReferences(recommendation, allowlist) {
  const supplied = {
    diagnostic: new Set(allowlist.diagnostics),
    knowledge: new Set(allowlist.knowledge),
  };
  const unsupportedReferences = recommendationReferences(recommendation).filter((reference) => !supplied[reference.kind]?.has(reference.id));
  return { valid: unsupportedReferences.length === 0, unsupportedReferences };
}

function appendAnalysisActivity(db, caseId, type, payload, now) {
  const activityId = 'ACT-' + randomUUID();
  const sequence = nextActivitySequence(db, caseId);
  db.prepare('UPDATE cases SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, caseId);
  db.prepare('INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(activityId, caseId, now, type, JSON.stringify(payload), sequence);
  return db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version;
}

export function reserveAnalysis(db, {
  caseId,
  source,
  fixtureId = null,
  promptVersion = 'support-triage-v1',
  provider = null,
  requestedModel = null,
  buildRequestEnvelope = null,
  now = new Date().toISOString(),
}) {
  if (source === 'live' && db.prepare("SELECT 1 FROM analyses WHERE case_id = ? AND source = 'live' AND status = 'running'").get(caseId)) {
    throw new AnalysisInProgressError();
  }

  const { contextJson, allowlist } = buildAnalysisContext(db, caseId);
  if (Buffer.byteLength(contextJson, 'utf8') > 100 * 1024) throw new AnalysisContextTooLargeError();
  const caseVersion = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version;
  const id = 'AN-' + randomUUID();
  let status = 'running';
  let completedAt = null;
  let outputJson = null;
  let referenceValidationJson = null;
  let fixtureVersion = null;
  let requestEnvelopeJson = null;

  if (source === 'fixture') {
    const fixture = analysisFixtures.find((item) => item.id === fixtureId && item.caseId === caseId);
    const available = listAvailableAnalysisFixtures(db, caseId).find((item) => item.id === fixtureId)?.available;
    if (!fixture || !available) throw new InvalidAnalysisFixtureError();
    const parsed = validateRecommendation(fixture.recommendation);
    if (!parsed.success) throw new Error('The bundled evaluation fixture violates the shared recommendation contract.');
    const report = validateSuppliedReferences(parsed.data, allowlist);
    if (!report.valid) throw new Error('The bundled evaluation fixture references evidence outside its supplied context.');
    status = 'completed';
    completedAt = now;
    outputJson = JSON.stringify(parsed.data);
    referenceValidationJson = JSON.stringify(report);
    fixtureVersion = fixture.version;
    promptVersion = null;
  } else if (buildRequestEnvelope) {
    requestEnvelopeJson = JSON.stringify(buildRequestEnvelope(JSON.parse(contextJson)));
  }

  db.prepare(
    'INSERT INTO analyses (id, case_id, source, fixture_id, fixture_version, request_envelope_json, status, created_at, completed_at, captured_case_version, context_json, reference_allowlist_json, prompt_version, schema_version, provider, requested_model, output_json, reference_validation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id, caseId, source, source === 'fixture' ? fixtureId : null, fixtureVersion, requestEnvelopeJson,
    status, now, completedAt, caseVersion, contextJson, JSON.stringify(allowlist), promptVersion,
    recommendationSchemaVersion, source === 'live' ? provider : null, source === 'live' ? requestedModel : null,
    outputJson, referenceValidationJson,
  );
  const version = appendAnalysisActivity(db, caseId, source === 'fixture' ? 'analysis_fixture_loaded' : 'analysis_started', {
    analysisId: id, source, ...(source === 'fixture' ? { fixtureId, fixtureVersion } : {}), status,
  }, now);
  return { changed: true, response: { analysisId: id, source, status, createdAt: now, version, ...(fixtureVersion ? { fixtureVersion } : {}) } };
}

function normalizeAnalysisResult(result) {
  const safeMetadata = Object.fromEntries(['provider', 'requestedModel', 'returnedModel', 'responseId']
    .filter((key) => typeof result?.[key] === 'string' && result[key].length <= 300)
    .map((key) => [key, result[key]]));
  let status = result?.status;
  let failureCode = typeof result?.failureCode === 'string' && result.failureCode.length <= 120 ? result.failureCode : null;
  let recommendation = null;
  if (status === 'completed') {
    const parsed = validateRecommendation(result.recommendation);
    if (parsed.success) recommendation = parsed.data;
    else {
      status = 'failed';
      failureCode = 'invalid_output';
    }
  }
  if (!['completed', 'failed', 'refused', 'incomplete'].includes(status)) {
    status = 'failed';
    failureCode = 'provider_unavailable';
  }
  if (status !== 'completed' && !failureCode) failureCode = 'provider_unavailable';
  return { ...safeMetadata, status, failureCode, ...(recommendation ? { recommendation } : {}) };
}

export function stageAnalysisResult(db, { analysisId, result }) {
  const row = db.prepare("SELECT 1 FROM analyses WHERE id = ? AND source = 'live' AND status = 'running'").get(analysisId);
  if (!row) return { applied: false };
  const pendingResultJson = JSON.stringify(normalizeAnalysisResult(result));
  return withTransaction(db, () => {
    const saved = db.prepare("UPDATE analyses SET pending_result_json = ? WHERE id = ? AND source = 'live' AND status = 'running'")
      .run(pendingResultJson, analysisId);
    return { applied: saved.changes === 1 };
  });
}

export function finishAnalysis(db, { analysisId, result, now = new Date().toISOString() }) {
  return withTransaction(db, () => {
    const row = db.prepare(analysisSelect + " WHERE id = ? AND source = 'live' AND status = 'running'").get(analysisId);
    if (!row) return { applied: false };
    const storedResult = result === undefined
      ? row.pending_result_json && JSON.parse(row.pending_result_json)
      : normalizeAnalysisResult(result);
    if (!storedResult) return { applied: false };
    let status = storedResult.status;
    let failureCode = storedResult.failureCode;
    let recommendation = null;
    let referenceValidation = null;
    if (status === 'completed') {
      const parsed = validateRecommendation(storedResult.recommendation);
      if (!parsed.success) {
        status = 'failed';
        failureCode = 'invalid_output';
      } else {
        recommendation = parsed.data;
        referenceValidation = validateSuppliedReferences(recommendation, JSON.parse(row.reference_allowlist_json));
      }
    }
    if (status !== 'completed' && !failureCode) failureCode = 'provider_unavailable';
    db.prepare(
      'UPDATE analyses SET status = ?, completed_at = ?, provider = ?, requested_model = ?, returned_model = ?, response_id = ?, output_json = ?, reference_validation_json = ?, failure_code = ?, pending_result_json = NULL WHERE id = ? AND status = \'running\'',
    ).run(
      status, now, storedResult.provider || row.provider || null, storedResult.requestedModel || row.requested_model || null,
      storedResult.returnedModel || null, storedResult.responseId || null,
      recommendation ? JSON.stringify(recommendation) : null, referenceValidation ? JSON.stringify(referenceValidation) : null,
      failureCode, analysisId,
    );
    const eventType = status === 'completed' ? 'analysis_completed' : 'analysis_failed';
    const version = appendAnalysisActivity(db, row.case_id, eventType, {
      analysisId, source: 'live', status, ...(failureCode ? { failureCode } : {}),
    }, now);
    return { applied: true, status, version };
  });
}

export function recoverPendingAnalysisCompletions(db, now = new Date().toISOString()) {
  const rows = db.prepare("SELECT id FROM analyses WHERE source = 'live' AND status = 'running' AND pending_result_json IS NOT NULL ORDER BY created_at, id").all();
  const recovered = [];
  for (const row of rows) {
    try {
      if (finishAnalysis(db, { analysisId: row.id, now }).applied) recovered.push(row.id);
    } catch {
      // Keep the durable result staged so the analysis endpoint can retry after storage recovers.
    }
  }
  return recovered;
}

export function recoverInterruptedAnalyses(db, now = new Date().toISOString()) {
  return withTransaction(db, () => {
    const rows = db.prepare("SELECT id, case_id FROM analyses WHERE source = 'live' AND status = 'running' AND pending_result_json IS NULL ORDER BY created_at, id").all();
    const recovered = [];
    for (const row of rows) {
      const result = db.prepare("UPDATE analyses SET status = 'interrupted', completed_at = ?, failure_code = 'process_interrupted' WHERE id = ? AND status = 'running'")
        .run(now, row.id);
      if (result.changes !== 1) continue;
      appendAnalysisActivity(db, row.case_id, 'analysis_failed', {
        analysisId: row.id, source: 'live', status: 'interrupted', failureCode: 'process_interrupted',
      }, now);
      recovered.push(row.id);
    }
    return recovered;
  });
}

export function appendAnalysisReview(db, { caseId, analysisId, decision, recommendation, feedback, now = new Date().toISOString() }) {
  const row = db.prepare(analysisSelect + ' WHERE id = ? AND case_id = ?').get(analysisId, caseId);
  if (!row) throw new AnalysisNotFoundError();
  if (row.status !== 'completed') throw new AnalysisNotReadyError();
  const original = JSON.parse(row.output_json);
  const originalValidation = JSON.parse(row.reference_validation_json);
  if (decision === 'accept' && !originalValidation.valid) {
    throw new UnsupportedAnalysisReferencesError(originalValidation.unsupportedReferences);
  }

  let storedDecision;
  let reviewedRecommendation = null;
  let storedFeedback = null;
  if (decision === 'accept') {
    storedDecision = 'accepted';
    reviewedRecommendation = original;
  } else if (decision === 'edit') {
    const parsed = validateRecommendation(recommendation);
    if (!parsed.success) throw new InvalidReviewError();
    const validation = validateSuppliedReferences(parsed.data, JSON.parse(row.reference_allowlist_json));
    if (!validation.valid) throw new UnsupportedAnalysisReferencesError(validation.unsupportedReferences);
    storedDecision = 'edited';
    reviewedRecommendation = parsed.data;
  } else if (decision === 'reject' && typeof feedback === 'string' && feedback.trim()) {
    storedDecision = 'rejected';
    storedFeedback = feedback;
  } else {
    throw new InvalidReviewError();
  }

  const id = 'REV-' + randomUUID();
  const nextVersion = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version + 1;
  db.prepare(
    'INSERT INTO reviews (id, case_id, analysis_id, decision, created_at, case_version, reviewed_recommendation_json, feedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, caseId, analysisId, storedDecision, now, nextVersion, reviewedRecommendation ? JSON.stringify(reviewedRecommendation) : null, storedFeedback);
  const version = appendAnalysisActivity(db, caseId, 'analysis_reviewed', { analysisId, reviewId: id, decision: storedDecision }, now);
  return { changed: true, response: { caseId, analysisId, reviewId: id, decision: storedDecision, version } };
}

export function listReviewQuality(db) {
  const totals = {
    fixture: { reviewed: 0, accepted: 0, edited: 0, rejected: 0 },
    live: { reviewed: 0, accepted: 0, edited: 0, rejected: 0 },
  };
  const latest = db.prepare(
    'WITH ranked AS (SELECT r.analysis_id, r.decision, a.source, ROW_NUMBER() OVER (PARTITION BY r.analysis_id ORDER BY r.case_version DESC) AS position FROM reviews AS r JOIN analyses AS a ON a.id = r.analysis_id) SELECT source, decision, COUNT(*) AS count FROM ranked WHERE position = 1 GROUP BY source, decision',
  ).all();
  for (const row of latest) {
    totals[row.source].reviewed += row.count;
    totals[row.source][row.decision] = row.count;
  }
  const history = db.prepare(
    'SELECT r.id, r.analysis_id, r.case_id, r.decision, r.created_at, r.case_version, r.reviewed_recommendation_json, r.feedback, a.source, a.fixture_id, a.fixture_version, a.provider, a.requested_model, a.returned_model, a.response_id, a.reference_validation_json FROM reviews AS r JOIN analyses AS a ON a.id = r.analysis_id ORDER BY r.created_at DESC, r.case_id, r.case_version DESC',
  ).all().map((row) => ({
    ...mapReview(row),
    source: row.source,
    fixtureId: row.fixture_id,
    fixtureVersion: row.fixture_version,
    fixtureLabel: row.fixture_id ? analysisFixtures.find((item) => item.id === row.fixture_id)?.label : null,
    provider: row.provider,
    requestedModel: row.requested_model,
    returnedModel: row.returned_model,
    responseId: row.response_id,
    referenceValidation: row.reference_validation_json ? JSON.parse(row.reference_validation_json) : null,
  }));
  return { totals, history };
}

export function listAvailableAnalysisFixtures(db, caseId) {
  const linked = new Set(db.prepare('SELECT diagnostic_id FROM case_evidence WHERE case_id = ?').all(caseId).map((row) => row.diagnostic_id));
  return analysisFixtures.filter((fixture) => fixture.caseId === caseId).map((fixture) => {
    const missing = fixture.requires.diagnosticIds.filter((id) => !linked.has(id));
    const available = missing.length === 0 && (!fixture.requires.noDiagnostics || linked.size === 0);
    return {
      id: fixture.id,
      version: fixture.version,
      title: fixture.title,
      label: fixture.label,
      available,
      prerequisite: available ? null : fixture.requires.noDiagnostics
        ? 'This evaluation is for a case with no linked diagnostic evidence.'
        : 'Associate all required diagnostic records first: ' + missing.join(', ') + '.',
    };
  });
}

export function appendCaseActivity(db, { caseId, type, text, now = new Date().toISOString() }) {
  const id = 'ACT-' + randomUUID();
  const sequence = nextActivitySequence(db, caseId);
  db.prepare('UPDATE cases SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, caseId);
  db.prepare(
    'INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, caseId, now, type, JSON.stringify({ text }), sequence);
  const version = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version;
  return { changed: true, response: { caseId, activityId: id, version } };
}

function inspectEvidenceIds(db, caseId, organizationId, ids) {
  const uniqueIds = [...new Set(ids)];
  const rows = uniqueIds.length
    ? db.prepare('SELECT id, organization_id FROM diagnostics WHERE id IN (' + uniqueIds.map(() => '?').join(', ') + ')').all(...uniqueIds)
    : [];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const linked = new Set(uniqueIds.length
    ? db.prepare('SELECT diagnostic_id FROM case_evidence WHERE case_id = ? AND diagnostic_id IN (' + uniqueIds.map(() => '?').join(', ') + ')')
      .all(caseId, ...uniqueIds).map((row) => row.diagnostic_id)
    : []);
  return {
    uniqueIds,
    rowsById,
    linked,
    notFoundIds: uniqueIds.filter((id) => !rowsById.has(id)),
    differentOrganizationIds: uniqueIds.filter((id) => rowsById.has(id) && rowsById.get(id).organization_id !== organizationId),
    unlinkedIds: uniqueIds.filter((id) => rowsById.has(id) && rowsById.get(id).organization_id === organizationId && !linked.has(id)),
  };
}

export class InvalidEvidenceAssociationError extends Error {
  constructor(details) {
    super('One or more diagnostic records cannot be associated with this case.');
    this.code = 'evidence_association_rejected';
    this.details = details;
  }
}

export function associateCaseEvidence(db, { caseId, diagnosticIds, now = new Date().toISOString() }) {
  const caseRow = db.prepare('SELECT organization_id, version FROM cases WHERE id = ?').get(caseId);
  if (!caseRow) throw new CaseNotFoundError();
  const inspected = inspectEvidenceIds(db, caseId, caseRow.organization_id, diagnosticIds);
  if (inspected.notFoundIds.length || inspected.differentOrganizationIds.length) {
    throw new InvalidEvidenceAssociationError({
      notFoundIds: inspected.notFoundIds,
      differentOrganizationIds: inspected.differentOrganizationIds,
    });
  }

  const addedIds = inspected.uniqueIds.filter((id) => !inspected.linked.has(id));
  const alreadyLinkedIds = inspected.uniqueIds.filter((id) => inspected.linked.has(id));
  if (addedIds.length === 0) {
    return {
      changed: false,
      response: { caseId, addedIds, alreadyLinkedIds, version: caseRow.version },
    };
  }

  const insert = db.prepare(
    "INSERT INTO case_evidence (case_id, diagnostic_id, linked_at, source) VALUES (?, ?, ?, 'operator')",
  );
  for (const id of addedIds) insert.run(caseId, id, now);
  const activityId = 'ACT-' + randomUUID();
  const sequence = nextActivitySequence(db, caseId);
  db.prepare('UPDATE cases SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, caseId);
  db.prepare(
    'INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(activityId, caseId, now, 'evidence_linked', JSON.stringify({ source: 'operator', diagnosticIds: addedIds }), sequence);
  const version = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version;
  return { changed: true, response: { caseId, addedIds, alreadyLinkedIds, activityId, version } };
}

const allowedTransitions = {
  open: new Set(['in_progress', 'escalated', 'resolved']),
  in_progress: new Set(['escalated', 'resolved']),
  escalated: new Set(['in_progress', 'resolved']),
  resolved: new Set(),
};

export class InvalidCaseTransitionError extends Error {
  constructor() {
    super('The requested status transition is not allowed.');
    this.code = 'invalid_transition';
  }
}

export class InvalidEscalationEvidenceError extends Error {
  constructor(details = {}) {
    super('Escalation evidence must already be linked to this case.');
    this.code = 'invalid_evidence';
    this.details = details;
  }
}

export class InvalidStatusContextError extends Error {
  constructor(code) {
    super('The requested status transition is missing valid context.');
    this.code = code;
  }
}

export function changeCaseStatus(db, { caseId, status, context = {}, now = new Date().toISOString() }) {
  const current = db.prepare('SELECT status, organization_id FROM cases WHERE id = ?').get(caseId);
  if (current.status === status) {
    return {
      changed: false,
      response: { caseId, status, version: db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version },
    };
  }
  if (!allowedTransitions[current.status]?.has(status)) throw new InvalidCaseTransitionError();
  let activityContext = context;
  if (status === 'escalated') {
    if (typeof context.reason !== 'string' || !context.reason.trim()) throw new InvalidStatusContextError('invalid_escalation_reason');
    if (typeof context.findings !== 'string' || !context.findings.trim()) throw new InvalidStatusContextError('invalid_escalation_findings');
    if (typeof context.questions !== 'string' || context.questions.length > 10000) throw new InvalidStatusContextError('invalid_escalation_questions');
    if (!Array.isArray(context.evidenceIds)) throw new InvalidEscalationEvidenceError();
    const inspected = inspectEvidenceIds(db, caseId, current.organization_id, context.evidenceIds);
    const details = {
      notFoundIds: inspected.notFoundIds,
      differentOrganizationIds: inspected.differentOrganizationIds,
      unlinkedIds: inspected.unlinkedIds,
    };
    if (details.notFoundIds.length || details.differentOrganizationIds.length || details.unlinkedIds.length) {
      throw new InvalidEscalationEvidenceError(details);
    }
    activityContext = { ...context, evidenceIds: inspected.uniqueIds };
  }
  if (status === 'resolved' && (typeof context.outcome !== 'string' || !context.outcome.trim())) {
    throw new InvalidStatusContextError('invalid_resolution_outcome');
  }

  const activityId = 'ACT-' + randomUUID();
  const sequence = nextActivitySequence(db, caseId);
  db.prepare('UPDATE cases SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(
    status,
    now,
    caseId,
  );
  db.prepare(
    'INSERT INTO activities (id, case_id, created_at, activity_type, payload, sequence) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(activityId, caseId, now, 'status_changed', JSON.stringify({ from: current.status, to: status, ...activityContext }), sequence);
  const version = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId).version;
  return { changed: true, response: { caseId, status, activityId, version } };
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('The idempotency key was already used with a different request.');
    this.code = 'idempotency_key_reused';
  }
}

export class StaleCaseError extends Error {
  constructor() {
    super('The case changed after this request was prepared.');
    this.code = 'stale_case';
  }
}

export class CaseNotFoundError extends Error {
  constructor() {
    super('The requested case does not exist.');
    this.code = 'case_not_found';
  }
}

function requestFingerprint({ method, route, caseId, payload, expectedVersion }) {
  const canonicalRequest = JSON.stringify(
    { method: method.toUpperCase(), route, caseId, payload, expectedVersion },
    (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]]));
      }
      return value;
    },
  );
  if (canonicalRequest === undefined) throw new TypeError('Mutation payload must be JSON serializable.');
  return createHash('sha256').update(canonicalRequest).digest('hex');
}

export function runIdempotentMutation(db, request, mutate) {
  const { requestKey, method, route, payload, caseId, expectedVersion } = request;
  if (typeof requestKey !== 'string' || requestKey.trim().length === 0 || requestKey.length > 200) {
    throw new TypeError('Request key must contain 1 to 200 characters.');
  }
  if (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method)) {
    throw new TypeError('Mutation method is invalid.');
  }
  if (typeof route !== 'string' || !route.startsWith('/')) {
    throw new TypeError('Mutation route must be an absolute path.');
  }
  if (typeof caseId !== 'string' || caseId.length === 0) {
    throw new TypeError('Case ID is required.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Mutation payload must be a JSON object.');
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('Expected case version must be a positive integer.');
  }
  if (typeof mutate !== 'function' || mutate.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Mutation callbacks must be synchronous.');
  }

  const fingerprint = requestFingerprint({ method, route, caseId, payload, expectedVersion });
  return withTransaction(db, () => {
    const receipt = db
      .prepare('SELECT fingerprint, response_json FROM mutation_receipts WHERE request_key = ?')
      .get(requestKey);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new IdempotencyKeyReusedError();
      return { replayed: true, response: JSON.parse(receipt.response_json) };
    }

    const currentCase = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId);
    if (!currentCase) throw new CaseNotFoundError();
    if (currentCase.version !== expectedVersion) throw new StaleCaseError();

    // node:sqlite transactions must not span awaits.
    const beforeChanges = db.prepare('SELECT total_changes() AS count').get().count;
    const result = mutate(db);
    if (result && typeof result.then === 'function') {
      throw new TypeError('Mutation callbacks must be synchronous.');
    }
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.changed !== 'boolean' ||
      !Object.hasOwn(result, 'response')
    ) {
      throw new TypeError('Mutation callbacks must return { changed, response }.');
    }
    const afterCase = db.prepare('SELECT version FROM cases WHERE id = ?').get(caseId);
    const expectedResultVersion = expectedVersion + Number(result.changed);
    if (!afterCase || afterCase.version !== expectedResultVersion) {
      throw new Error(
        'Mutation callbacks must advance the case version exactly once for changes and leave it unchanged for no-ops.',
      );
    }
    if (!result.changed && db.prepare('SELECT total_changes() AS count').get().count !== beforeChanges) {
      throw new Error('No-op mutation callbacks must not write to the database.');
    }
    const response = result.response;
    const responseJson = JSON.stringify(response);
    if (responseJson === undefined) throw new TypeError('Mutation response must be JSON serializable.');

    db.prepare(
      'INSERT INTO mutation_receipts (request_key, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(requestKey, fingerprint, responseJson, new Date().toISOString());
    return { replayed: false, response };
  });
}

export function assertDemoDatabasePath(databasePath = demoDatabasePath) {
  if (resolve(databasePath) !== demoDatabasePath) {
    throw new Error('Reset is restricted to this project’s demo database.');
  }
}

export function openDemoDatabase() {
  assertDemoDatabasePath();
  const dataDirectory = dirname(demoDatabasePath);
  const lstatIfPresent = (path) => {
    try {
      return lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const directoryStat = lstatIfPresent(dataDirectory);
  if (directoryStat) {
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('The demo data directory must be a real directory.');
    }
  } else {
    mkdirSync(dataDirectory);
  }
  if (realpathSync(dataDirectory) !== dataDirectory) {
    throw new Error('The demo data directory resolves outside this project.');
  }
  if (lstatIfPresent(demoDatabasePath)?.isSymbolicLink()) {
    throw new Error('The demo database cannot be a symbolic link.');
  }
  return openDatabase(demoDatabasePath);
}

export function resetDemoDatabase({ databasePath = demoDatabasePath, confirmed = false } = {}) {
  if (!confirmed) throw new Error('Demo reset requires the --confirm flag.');
  assertDemoDatabasePath(databasePath);

  const db = openDemoDatabase();
  try {
    migrate(db);
    withTransaction(db, () => {
      db.exec('DELETE FROM mutation_receipts; DELETE FROM reviews; DELETE FROM analyses; DELETE FROM case_evidence; DELETE FROM activities; DELETE FROM diagnostics; DELETE FROM knowledge_entries; DELETE FROM cases;');
      insertInitialCases(db);
      seedTechnicalFixtures(db);
    });
  } finally {
    db.close();
  }
}
