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
  InvalidStatusContextError,
  listCases,
  runIdempotentMutation,
  StaleCaseError,
} from './database.js';
import { z } from 'zod';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const defaultBuildDirectory = resolve(serverDirectory, '../dist');
const localHostnames = new Set(['127.0.0.1', 'localhost']);
const caseIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const statusSchema = z.enum(['open', 'in_progress', 'escalated', 'resolved']);
const expectedVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonblankTextSchema = z.string().min(1).max(10000).refine((value) => value.trim().length > 0);
const boundedTextSchema = z.string().max(10000);
const caseIdSchema = z.string().regex(caseIdPattern);
const requestKeySchema = z.string().max(200).refine((value) => value.trim().length > 0);
const activityBodySchema = z.strictObject({
  type: z.enum(['internal_note', 'simulated_reply']),
  text: nonblankTextSchema,
  expectedVersion: expectedVersionSchema,
});
const statusBodySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('open'), expectedVersion: expectedVersionSchema }),
  z.strictObject({ status: z.literal('in_progress'), expectedVersion: expectedVersionSchema }),
  z.strictObject({
    status: z.literal('escalated'),
    expectedVersion: expectedVersionSchema,
    reason: boundedTextSchema.optional(),
    findings: boundedTextSchema.optional(),
    questions: boundedTextSchema.optional(),
    evidenceIds: z.array(z.string()).length(0).optional().default([]),
  }),
  z.strictObject({
    status: z.literal('resolved'),
    expectedVersion: expectedVersionSchema,
    outcome: boundedTextSchema.optional(),
  }),
]);

class RequestValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = 400;
  }
}

function parseRequest(schema, value, codes) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues.find((item) => item.code === 'unrecognized_keys') || result.error.issues[0];
  const code = issue.code === 'unrecognized_keys'
    ? 'unknown_fields'
    : codes[issue.path[0]] || 'invalid_request';
  throw new RequestValidationError(code);
}

function validateCaseId(caseId) {
  if (!caseIdSchema.safeParse(caseId).success) throw new RequestValidationError('invalid_case_id');
}

function validateRequestKey(requestKey) {
  if (!requestKeySchema.safeParse(requestKey).success) throw new RequestValidationError('idempotency_key_required');
}

function validateActivityBody(body) {
  return parseRequest(activityBodySchema, body, {
    type: 'invalid_activity_type',
    text: 'invalid_text',
    expectedVersion: 'invalid_expected_version',
  });
}

function validateStatusBody(body) {
  return parseRequest(statusBodySchema, body, {
    status: 'invalid_status',
    expectedVersion: 'invalid_expected_version',
    reason: 'invalid_escalation_reason',
    findings: 'invalid_escalation_findings',
    questions: 'invalid_escalation_questions',
    evidenceIds: 'invalid_evidence',
    outcome: 'invalid_resolution_outcome',
  });
}

function sendMutationError(res, error) {
  if (error instanceof RequestValidationError) {
    return res.status(error.status).json({ error: error.code });
  }
  if (error instanceof CaseNotFoundError) return res.status(404).json({ error: error.code });
  if (error instanceof IdempotencyKeyReusedError || error instanceof StaleCaseError || error instanceof InvalidCaseTransitionError) {
    return res.status(409).json({ error: error.code });
  }
  if (error instanceof InvalidEscalationEvidenceError || error instanceof InvalidStatusContextError) {
    return res.status(400).json({ error: error.code });
  }
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
    if (status !== undefined && !statusSchema.safeParse(status).success) {
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
