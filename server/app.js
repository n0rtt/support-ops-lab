import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendCaseActivity,
  CaseNotFoundError,
  changeCaseStatus,
  getCase,
  IdempotencyKeyReusedError,
  InvalidCaseTransitionError,
  InvalidEscalationEvidenceError,
  listCases,
  runIdempotentMutation,
  StaleCaseError,
} from './database.js';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const defaultBuildDirectory = resolve(serverDirectory, '../dist');
const localHostnames = new Set(['127.0.0.1', 'localhost']);
const statuses = new Set(['open', 'in_progress', 'escalated', 'resolved']);
const activityTypes = new Set(['note', 'simulated_reply']);
const caseIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class RequestValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = 400;
  }
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('invalid_request');
  }
}

function requireKeys(value, expectedKeys) {
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new RequestValidationError('unknown_fields');
  }
}

function requireText(value, code, { allowBlank = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > 10000 ||
    (!allowBlank && value.trim().length === 0)
  ) {
    throw new RequestValidationError(code);
  }
  return value;
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RequestValidationError('invalid_expected_version');
  }
}

function validateCaseId(caseId) {
  if (!caseIdPattern.test(caseId)) throw new RequestValidationError('invalid_case_id');
}

function validateRequestKey(requestKey) {
  if (typeof requestKey !== 'string' || requestKey.trim().length === 0 || requestKey.length > 200) {
    throw new RequestValidationError('idempotency_key_required');
  }
}

function validateActivityBody(body) {
  requireObject(body);
  requireKeys(body, new Set(['type', 'text', 'expectedVersion']));
  if (!activityTypes.has(body.type)) throw new RequestValidationError('invalid_activity_type');
  requireText(body.text, 'invalid_text');
  validateExpectedVersion(body.expectedVersion);
  return { type: body.type, text: body.text, expectedVersion: body.expectedVersion };
}

function validateStatusBody(body) {
  requireObject(body);
  if (!statuses.has(body.status)) throw new RequestValidationError('invalid_status');
  validateExpectedVersion(body.expectedVersion);

  const payload = { status: body.status, expectedVersion: body.expectedVersion };
  if (body.status === 'escalated') {
    requireKeys(body, new Set(['status', 'expectedVersion', 'reason', 'findings', 'questions', 'evidenceIds']));
    payload.reason = requireText(body.reason, 'invalid_escalation_reason');
    payload.findings = requireText(body.findings, 'invalid_escalation_findings');
    payload.questions = requireText(body.questions, 'invalid_escalation_questions', { allowBlank: true });
    if (!Array.isArray(body.evidenceIds) || body.evidenceIds.length !== 0) {
      throw new RequestValidationError('invalid_evidence');
    }
    payload.evidenceIds = [];
  } else if (body.status === 'resolved') {
    requireKeys(body, new Set(['status', 'expectedVersion', 'outcome']));
    payload.outcome = requireText(body.outcome, 'invalid_resolution_outcome');
  } else {
    requireKeys(body, new Set(['status', 'expectedVersion']));
  }
  return payload;
}

function sendMutationError(res, error) {
  if (error instanceof RequestValidationError) {
    return res.status(error.status).json({ error: error.code });
  }
  if (error instanceof CaseNotFoundError) return res.status(404).json({ error: error.code });
  if (error instanceof IdempotencyKeyReusedError || error instanceof StaleCaseError || error instanceof InvalidCaseTransitionError) {
    return res.status(409).json({ error: error.code });
  }
  if (error instanceof InvalidEscalationEvidenceError) return res.status(400).json({ error: error.code });
  if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
    return res.status(503).json({ error: 'save_temporarily_unavailable' });
  }
  return res.status(500).json({ error: 'save_failed' });
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === 'http://' + req.get('host');
  } catch {
    return false;
  }
}

export function createApp({ db, buildDirectory = defaultBuildDirectory }) {
  if (!db) throw new TypeError('A database connection is required.');
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!localHostnames.has(req.hostname)) return res.status(400).json({ error: 'invalid_host' });
    next();
  });

  app.use('/api', (req, res, next) => {
    if (!['POST', 'PATCH'].includes(req.method)) return next();
    if (!sameOrigin(req)) return res.status(403).json({ error: 'invalid_origin' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/api/config', (_req, res) => {
    res.json({ name: 'Support Engineering Workbench', dataMode: 'synthetic' });
  });

  app.get('/api/cases', (req, res) => {
    const status = req.query.status;
    if (status !== undefined && (typeof status !== 'string' || !statuses.has(status))) {
      return res.status(400).json({ error: 'invalid_status_filter' });
    }
    try {
      res.json({ cases: listCases(db, status) });
    } catch {
      res.status(500).json({ error: 'case_list_unavailable' });
    }
  });

  app.get('/api/cases/:caseId', (req, res) => {
    if (!caseIdPattern.test(req.params.caseId)) return res.status(400).json({ error: 'invalid_case_id' });
    try {
      const item = getCase(db, req.params.caseId);
      if (!item) return res.status(404).json({ error: 'case_not_found' });
      res.json({ case: item });
    } catch {
      res.status(500).json({ error: 'case_detail_unavailable' });
    }
  });

  app.post('/api/cases/:caseId/activities', (req, res) => {
    try {
      validateCaseId(req.params.caseId);
      const requestKey = req.get('idempotency-key');
      validateRequestKey(requestKey);
      const payload = validateActivityBody(req.body);
      const result = runIdempotentMutation(
        db,
        {
          requestKey,
          method: req.method,
          route: req.path,
          caseId: req.params.caseId,
          payload,
          expectedVersion: payload.expectedVersion,
        },
        (connection) => appendCaseActivity(connection, { caseId: req.params.caseId, ...payload }),
      );
      res.json({ ...result.response, replayed: result.replayed });
    } catch (error) {
      sendMutationError(res, error);
    }
  });

  app.patch('/api/cases/:caseId/status', (req, res) => {
    try {
      validateCaseId(req.params.caseId);
      const requestKey = req.get('idempotency-key');
      validateRequestKey(requestKey);
      const payload = validateStatusBody(req.body);
      const context = Object.fromEntries(
        ['reason', 'findings', 'questions', 'evidenceIds', 'outcome']
          .filter((key) => Object.hasOwn(payload, key))
          .map((key) => [key, payload[key]]),
      );
      const result = runIdempotentMutation(
        db,
        {
          requestKey,
          method: req.method,
          route: req.path,
          caseId: req.params.caseId,
          payload,
          expectedVersion: payload.expectedVersion,
        },
        (connection) => changeCaseStatus(connection, { caseId: req.params.caseId, status: payload.status, context }),
      );
      res.json({ ...result.response, replayed: result.replayed });
    } catch (error) {
      sendMutationError(res, error);
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'request_too_large' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    res.status(500).json({ error: 'request_failed' });
  });

  if (existsSync(buildDirectory)) {
    app.use(express.static(buildDirectory, { dotfiles: 'deny' }));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
