import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initialCases } from '../fixtures/cases.js';
import { initialDiagnostics } from '../fixtures/diagnostics.js';
import { initialKnowledgeEntries } from '../fixtures/knowledge.js';

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
      db.exec('DELETE FROM mutation_receipts; DELETE FROM case_evidence; DELETE FROM activities; DELETE FROM diagnostics; DELETE FROM knowledge_entries; DELETE FROM cases;');
      insertInitialCases(db);
      seedTechnicalFixtures(db);
    });
  } finally {
    db.close();
  }
}
