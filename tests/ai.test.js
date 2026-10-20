import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIConnectionTimeoutError } from 'openai';
import { createOpenAIAnalyzer, defaultOpenAIModel } from '../server/ai.js';
import { analysisFixtures } from '../fixtures/analyses.js';

function sdkResponse({ id = 'resp_sdk_test', model = 'gpt-6.1-sol', status = 'completed', content } = {}) {
  return {
    id,
    object: 'response',
    created_at: 1,
    status,
    model,
    output: [{
      id: 'msg_sdk_test',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: content || [{ type: 'output_text', text: JSON.stringify(analysisFixtures[0].recommendation), annotations: [] }],
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

test('the pinned OpenAI SDK sends the saved context through Responses strict Structured Outputs', async () => {
  let request;
  const analyzer = createOpenAIAnalyzer({
    apiKey: 'sdk-test-key-do-not-log',
    model: 'gpt-6.1-sol',
    fetchImpl: async (url, init) => {
      request = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify(sdkResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const context = { case: { id: 'SEW-1001' }, diagnostics: [{ id: 'DIAG-AUTH-401-001' }] };
  const savedEnvelope = JSON.parse(JSON.stringify(analyzer.buildRequestEnvelope(context)));
  const result = await analyzer(context, savedEnvelope);

  assert.equal(result.status, 'completed');
  assert.equal(result.provider, 'openai');
  assert.equal(result.requestedModel, 'gpt-6.1-sol');
  assert.equal(result.returnedModel, 'gpt-6.1-sol');
  assert.equal(result.responseId, 'resp_sdk_test');
  assert.deepEqual(result.recommendation, analysisFixtures[0].recommendation);
  assert.match(request.url, /\/v1\/responses$/);
  assert.equal(request.body.model, 'gpt-6.1-sol');
  assert.deepEqual(request.body, savedEnvelope);
  assert.equal(analyzer.provider, 'openai');
  assert.equal(analyzer.requestedModel, 'gpt-6.1-sol');
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.tools, []);
  assert.equal(request.body.max_output_tokens, 4096);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
  assert.deepEqual(request.body.text.format.schema.required, [
    'classification', 'observations', 'possibleCause', 'nextSteps', 'draftResponse', 'references', 'uncertainty',
  ]);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
  assert.equal(request.body.input[1].content, JSON.stringify(context));
  assert.equal(request.init.headers.get('authorization'), 'Bearer sdk-test-key-do-not-log');
  assert.equal(defaultOpenAIModel, 'gpt-6.1-sol');
});

test('SDK transport errors are not retried or logged and timeout is explicit', async () => {
  let calls = 0;
  const logs = [];
  const originalLogs = Object.fromEntries(['error', 'warn', 'log'].map((method) => [method, console[method]]));
  for (const method of Object.keys(originalLogs)) console[method] = (...values) => logs.push(values.join(' '));
  const analyzer = createOpenAIAnalyzer({
    apiKey: 'sdk-test-key-do-not-log',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'secret provider response body' } }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    },
  });
  let result;
  try {
    result = await analyzer({ case: { id: 'SEW-1001', privateNote: 'fictional sensitive test context' } });
  } finally {
    for (const [method, log] of Object.entries(originalLogs)) console[method] = log;
  }
  assert.deepEqual(result, {
    provider: 'openai', requestedModel: defaultOpenAIModel, status: 'failed', failureCode: 'provider_unavailable',
  });
  assert.equal(calls, 1);
  assert.deepEqual(logs, []);

  const timeoutAnalyzer = createOpenAIAnalyzer({
    apiKey: 'sdk-test-key-do-not-log',
    fetchImpl: async () => { throw new APIConnectionTimeoutError(); },
  });
  assert.deepEqual(await timeoutAnalyzer({ case: { id: 'SEW-1001' } }), {
    provider: 'openai', requestedModel: defaultOpenAIModel, status: 'failed', failureCode: 'provider_timeout',
  });
});

test('Responses refusal and incomplete states stay distinct from malformed structured output', async () => {
  const run = async (payload) => createOpenAIAnalyzer({
    apiKey: 'sdk-test-key-do-not-log',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
  })({ case: { id: 'SEW-1001' } });

  const refusal = await run(sdkResponse({ content: [{ type: 'refusal', refusal: 'I cannot help with that request.' }] }));
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.failureCode, 'provider_refusal');
  const incomplete = await run(sdkResponse({ status: 'incomplete' }));
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.failureCode, 'provider_incomplete');
  const failed = await run(sdkResponse({ status: 'failed' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'provider_unavailable');
  const withoutStatus = sdkResponse();
  delete withoutStatus.status;
  const parsedWithoutStatus = await run(withoutStatus);
  assert.equal(parsedWithoutStatus.status, 'completed');
  assert.deepEqual(parsedWithoutStatus.recommendation, analysisFixtures[0].recommendation);
  const malformed = await run(sdkResponse({ content: [{ type: 'output_text', text: '{"classification":"unknown"}', annotations: [] }] }));
  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.failureCode, 'invalid_output');
});

test('live inference stays unavailable without a server-side API credential', () => {
  assert.equal(createOpenAIAnalyzer({ apiKey: '' }), null);
});
