import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initialCases } from '../fixtures/cases.js';

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
    "INSERT INTO activities (id, case_id, created_at, activity_type, payload) VALUES (?, ?, ?, 'initial_report', ?)",
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
}

export function listCases(db) {
  return db
    .prepare(
      "SELECT c.id, c.organization_id, c.organization_name, c.subject, c.channel, c.priority, c.status, c.created_at, c.updated_at, c.version, a.payload AS initial_report FROM cases AS c LEFT JOIN activities AS a ON a.case_id = c.id AND a.activity_type = 'initial_report' ORDER BY c.created_at DESC, c.id",
    )
    .all()
    .map((row) => ({
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
    }));
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
    initializeDatabase(db);
    withTransaction(db, () => {
      db.exec('DELETE FROM mutation_receipts; DELETE FROM activities; DELETE FROM cases;');
      insertInitialCases(db);
    });
  } finally {
    db.close();
  }
}
