import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendCaseActivity,
  appendAnalysisReview,
  associateCaseEvidence,
  AnalysisContextTooLargeError,
  AnalysisInProgressError,
  AnalysisNotFoundError,
  AnalysisNotReadyError,
  getAnalysis,
  finishAnalysis,
  CaseNotFoundError,
  changeCaseStatus,
  getDiagnostic,
  getCase,
  getKnowledgeEntry,
  IdempotencyKeyReusedError,
  InvalidEvidenceAssociationError,
  InvalidCaseTransitionError,
  InvalidEscalationEvidenceError,
  InvalidStatusContextError,
  listCases,
  listReviewQuality,
  listKnowledgeEntries,
  searchDiagnostics,
  runIdempotentMutation,
  reserveAnalysis,
  StaleCaseError,
  UnsupportedAnalysisReferencesError,
  InvalidAnalysisFixtureError,
  InvalidReviewError,
} from './database.js';
import { z } from 'zod';
import { recommendationSchema } from '../shared/recommendation.js';
import { analysisPromptVersion } from './ai.js';

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
const evidenceBodySchema = z.strictObject({
  diagnosticIds: z.array(caseIdSchema).max(100),
  expectedVersion: expectedVersionSchema,
});
const diagnosticQuerySchema = z.strictObject({
  q: z.string().max(200).refine((value) => value.trim().length > 0),
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
    evidenceIds: z.array(caseIdSchema).max(100).optional().default([]),
  }),
  z.strictObject({
    status: z.literal('resolved'),
    expectedVersion: expectedVersionSchema,
    outcome: boundedTextSchema.optional(),
  }),
]);
const analysisBodySchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('live'), expectedVersion: expectedVersionSchema }),
  z.strictObject({ source: z.literal('fixture'), fixtureId: caseIdSchema, expectedVersion: expectedVersionSchema }),
]);
const reviewBodySchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('accept'), expectedVersion: expectedVersionSchema }),
  z.strictObject({ decision: z.literal('edit'), expectedVersion: expectedVersionSchema, recommendation: recommendationSchema }),
  z.strictObject({ decision: z.literal('reject'), expectedVersion: expectedVersionSchema, feedback: nonblankTextSchema }),
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

function validateEvidenceBody(body) {
  return parseRequest(evidenceBodySchema, body, {
    diagnosticIds: 'invalid_evidence',
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

function validateAnalysisBody(body) {
  return parseRequest(analysisBodySchema, body, { source: 'invalid_analysis_source', fixtureId: 'invalid_analysis_fixture', expectedVersion: 'invalid_expected_version' });
}

function validateReviewBody(body) {
  return parseRequest(reviewBodySchema, body, { decision: 'invalid_review', expectedVersion: 'invalid_expected_version', recommendation: 'invalid_recommendation', feedback: 'invalid_review_feedback' });
}

function sendMutationError(res, error) {
  if (error instanceof RequestValidationError) {
    return res.status(error.status).json({ error: error.code });
  }
  if (error instanceof CaseNotFoundError) return res.status(404).json({ error: error.code });
  if (error instanceof AnalysisNotFoundError) return res.status(404).json({ error: error.code });
  if (error instanceof InvalidEvidenceAssociationError) {
    return res.status(400).json({ error: error.code, details: error.details });
  }
  if (error instanceof IdempotencyKeyReusedError || error instanceof StaleCaseError || error instanceof InvalidCaseTransitionError) {
    return res.status(409).json({ error: error.code });
  }
  if (error instanceof AnalysisInProgressError || error instanceof AnalysisNotReadyError || error instanceof InvalidAnalysisFixtureError || error instanceof UnsupportedAnalysisReferencesError) {
    return res.status(409).json({ error: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  if (error instanceof AnalysisContextTooLargeError) return res.status(413).json({ error: error.code });
  if (error instanceof InvalidReviewError) return res.status(400).json({ error: error.code });
  if (error instanceof InvalidEscalationEvidenceError || error instanceof InvalidStatusContextError) {
    return res.status(400).json(error instanceof InvalidEscalationEvidenceError
      ? { error: error.code, details: error.details }
      : { error: error.code });
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

export function createApp({ db, buildDirectory = defaultBuildDirectory, analyze = null }) {
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
    res.json({ name: 'Support Engineering Workbench', dataMode: 'synthetic', liveInferenceAvailable: Boolean(analyze) });
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

  app.get('/api/analyses/:analysisId', (req, res) => {
    if (!caseIdPattern.test(req.params.analysisId)) return res.status(400).json({ error: 'invalid_analysis_id' });
    try {
      const analysis = getAnalysis(db, req.params.analysisId);
      if (!analysis) return res.status(404).json({ error: 'analysis_not_found' });
      res.json({ analysis });
    } catch {
      res.status(500).json({ error: 'analysis_unavailable' });
    }
  });

  app.get('/api/reviews', (_req, res) => {
    try {
      res.json(listReviewQuality(db));
    } catch {
      res.status(500).json({ error: 'review_history_unavailable' });
    }
  });

  app.post('/api/cases/:caseId/analyses', (req, res) => {
    try {
      validateCaseId(req.params.caseId);
      const requestKey = req.get('idempotency-key');
      validateRequestKey(requestKey);
      const payload = validateAnalysisBody(req.body);
      if (payload.source === 'live' && !analyze) return res.status(503).json({ error: 'live_inference_unavailable' });
      const result = runIdempotentMutation(
        db,
        { requestKey, method: req.method, route: req.path, caseId: req.params.caseId, payload, expectedVersion: payload.expectedVersion },
        (connection) => reserveAnalysis(connection, {
          caseId: req.params.caseId,
          source: payload.source,
          fixtureId: payload.fixtureId,
          promptVersion: analysisPromptVersion,
        }),
      );
      if (payload.source === 'live' && !result.replayed) {
        const analysisId = result.response.analysisId;
        setImmediate(async () => {
          try {
            const snapshot = getAnalysis(db, analysisId);
            if (!snapshot || snapshot.status !== 'running') return;
            const inference = await analyze(snapshot.context);
            finishAnalysis(db, { analysisId, result: inference });
          } catch {
            try {
              finishAnalysis(db, { analysisId, result: { status: 'failed', failureCode: 'provider_unavailable', provider: 'openai' } });
            } catch {
              // A persistent database failure leaves the durable reservation for startup recovery.
            }
          }
        });
      }
      res.status(payload.source === 'fixture' ? 201 : 202).json({ ...result.response, replayed: result.replayed });
    } catch (error) {
      sendMutationError(res, error);
    }
  });

  app.post('/api/cases/:caseId/analyses/:analysisId/reviews', (req, res) => {
    try {
      validateCaseId(req.params.caseId);
      if (!caseIdPattern.test(req.params.analysisId)) throw new RequestValidationError('invalid_analysis_id');
      const requestKey = req.get('idempotency-key');
      validateRequestKey(requestKey);
      const payload = validateReviewBody(req.body);
      const result = runIdempotentMutation(
        db,
        { requestKey, method: req.method, route: req.path, caseId: req.params.caseId, payload, expectedVersion: payload.expectedVersion },
        (connection) => appendAnalysisReview(connection, {
          caseId: req.params.caseId,
          analysisId: req.params.analysisId,
          decision: payload.decision,
          recommendation: payload.recommendation,
          feedback: payload.feedback,
        }),
      );
      res.json({ ...result.response, replayed: result.replayed });
    } catch (error) {
      sendMutationError(res, error);
    }
  });

  app.get('/api/diagnostics', (req, res) => {
    const result = diagnosticQuerySchema.safeParse(req.query);
    if (!result.success) return res.status(400).json({ error: 'invalid_diagnostic_query' });
    try {
      res.json(searchDiagnostics(db, result.data.q.trim()));
    } catch {
      res.status(500).json({ error: 'diagnostic_search_unavailable' });
    }
  });

  app.get('/api/diagnostics/:diagnosticId', (req, res) => {
    if (!caseIdPattern.test(req.params.diagnosticId)) return res.status(400).json({ error: 'invalid_diagnostic_id' });
    try {
      const result = getDiagnostic(db, req.params.diagnosticId);
      if (!result) return res.status(404).json({ error: 'diagnostic_not_found' });
      res.json(result);
    } catch {
      res.status(500).json({ error: 'diagnostic_detail_unavailable' });
    }
  });

  app.get('/api/knowledge', (_req, res) => {
    try {
      res.json({ entries: listKnowledgeEntries(db) });
    } catch {
      res.status(500).json({ error: 'knowledge_unavailable' });
    }
  });

  app.get('/api/knowledge/:entryId', (req, res) => {
    if (!caseIdPattern.test(req.params.entryId)) return res.status(400).json({ error: 'invalid_knowledge_id' });
    try {
      const entry = getKnowledgeEntry(db, req.params.entryId);
      if (!entry) return res.status(404).json({ error: 'knowledge_entry_not_found' });
      res.json({ entry });
    } catch {
      res.status(500).json({ error: 'knowledge_unavailable' });
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

  app.post('/api/cases/:caseId/evidence', (req, res) => {
    try {
      validateCaseId(req.params.caseId);
      const requestKey = req.get('idempotency-key');
      validateRequestKey(requestKey);
      const payload = validateEvidenceBody(req.body);
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
        (connection) => associateCaseEvidence(connection, { caseId: req.params.caseId, ...payload }),
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
