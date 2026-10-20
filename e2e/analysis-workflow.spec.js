import { expect, test } from '@playwright/test';
import { withFreshApp } from './support.js';
import { analysisFixtures } from '../fixtures/analyses.js';

test('A shows the intentionally incorrect offline diagnosis, records a correction, and reuses it as context', async ({ browser }, testInfo) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1001');
    await expect(page.getByRole('heading', { name: 'AI-assisted troubleshooting' })).toBeVisible();
    await expect(page.getByText(/Not configured\. Set OPENAI_API_KEY on the server/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate live analysis' })).toBeDisabled();
    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();

    const analyses = page.locator('.analysis-card');
    const first = analyses.first();
    await expect(first).toContainText('Synthetic evaluation fixture · intentionally incorrect');
    await expect(first).toContainText('The provider is likely experiencing a service outage');
    await expect(first.getByRole('heading', { name: 'Possible cause — hypothesis' })).toBeVisible();
    await expect(first).toContainText('Supplied diagnostic: DIAG-AUTH-401-001');
    await expect(first).toContainText('does not prove the AI’s interpretation is true');

    const correction = 'The supplied 401 responses point to rejected authentication. They do not establish an outage; verify the configured key and scopes.';
    await first.getByLabel('Reason or corrective feedback').fill(correction);
    await first.getByRole('button', { name: 'Reject recommendation and record correction' }).click();
    await expect(first.getByText(/Rejected/)).toBeVisible();
    await expect(first).toContainText(correction);
    await expect(page.getByText('1 reviewed · 0 accepted · 0 edited · 1 rejected')).toBeVisible();
    await expect(page.locator('.case-detail .status-open')).toBeVisible();
    await expect(page.locator('.activity-list')).not.toContainText('Simulated reply to customer');

    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    await expect(analyses).toHaveCount(2);
    const second = analyses.nth(1);
    await second.getByRole('button', { name: 'Inspect saved context' }).click();
    await expect(second.locator('.saved-context pre')).toContainText(correction);
    await expect(second.locator('.saved-context')).toContainText('DIAG-AUTH-401-001');
    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1001')).json();
    const snapshot = await (await page.request.get(baseUrl + '/api/analyses/' + saved.analyses[1].id)).json();
    expect(snapshot.analysis.context.correctiveFeedback).toContainEqual(expect.objectContaining({ feedback: correction }));
    await page.screenshot({ path: testInfo.outputPath('m4-a-reviewed-context.png'), fullPage: true });
  });
});

test('A can correct structured diagnosis and supplied references while preserving the original', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1001');
    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    const analysis = page.locator('.analysis-card').first();
    const originalHypothesis = 'The provider is likely experiencing a service outage that is causing the authentication failures.';
    await expect(analysis).toContainText(originalHypothesis);
    await analysis.getByRole('button', { name: 'Edit draft and approve' }).click();
    const editor = analysis.locator('.review-structured-editor');
    await editor.getByLabel('Classification').selectOption('authentication');
    await editor.getByLabel('Hypothesis').fill('The supplied 401 responses indicate rejected authentication; they do not establish a provider outage.');
    const references = editor.getByRole('group', { name: 'Overall supplied references' });
    await references.getByLabel('KB-AUTH-01').uncheck();
    await references.getByLabel('KB-OUTAGE-01').check();
    await analysis.getByRole('button', { name: 'Save edited recommendation as approved' }).click();
    await expect(analysis).toContainText('Edited');
    await expect(analysis).toContainText(originalHypothesis);

    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1001')).json();
    const inspected = await (await page.request.get(baseUrl + '/api/analyses/' + saved.analyses[0].id)).json();
    expect(inspected.analysis.recommendation.possibleCause.text).toBe(originalHypothesis);
    expect(inspected.analysis.latestReview.recommendation.classification).toBe('authentication');
    expect(inspected.analysis.latestReview.recommendation.possibleCause.text).toContain('rejected authentication');
    expect(inspected.analysis.latestReview.recommendation.references).toContainEqual({ kind: 'knowledge', id: 'KB-OUTAGE-01' });
    expect(inspected.analysis.latestReview.recommendation.references).not.toContainEqual({ kind: 'knowledge', id: 'KB-AUTH-01' });

    await page.reload();
    const reloaded = page.locator('.analysis-card').first();
    await reloaded.getByText('Inspect reviewed recommendation').click();
    await expect(reloaded).toContainText('Classification: Authentication');
    await expect(reloaded).toContainText('rejected authentication');
    await expect(reloaded).toContainText('knowledge · KB-OUTAGE-01');
    await expect(reloaded).toContainText(originalHypothesis);
  });
});

test('quarantined output can be rejected but not accepted, edited into approval, or reused', async ({ browser }) => {
  const invalidRecommendation = structuredClone(analysisFixtures[2].recommendation);
  invalidRecommendation.references.push({ kind: 'diagnostic', id: 'DIAG-AUTH-401-001' });
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1003');
    await page.getByRole('button', { name: 'Generate live analysis' }).click();
    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('This original output is quarantined');
    await expect(analysis.getByRole('button', { name: 'Accept recommendation' })).toBeDisabled();
    await expect(analysis.getByRole('button', { name: 'Edit draft and approve' })).toBeDisabled();
    await expect(analysis.getByRole('button', { name: /Use reviewed draft/ })).toHaveCount(0);
    await analysis.getByLabel('Reason or corrective feedback').fill('This case supplied no diagnostic evidence; request the exact request ID and time window.');
    await analysis.getByRole('button', { name: 'Reject recommendation and record correction' }).click();
    await expect(analysis).toContainText('Rejected');
    await expect(analysis).toContainText('This case supplied no diagnostic evidence');
    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json();
    expect(saved.analyses[0].latestReview.decision).toBe('rejected');
  }, { analyze: async () => ({
    status: 'completed', recommendation: invalidRecommendation, provider: 'openai', requestedModel: 'test-model',
  }) });
});

test('failed result staging is described as temporary and never as saved', async ({ browser }) => {
  let db;
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1003');
    await page.getByRole('button', { name: 'Generate live analysis' }).click();
    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('The provider result was received but could not be saved durably');
    await expect(analysis).toContainText('could be lost if the process stops');
    await expect(analysis).not.toContainText('provider result is saved');
    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json();
    expect(saved.analyses[0].completionPending).toBe(false);
    expect(saved.analyses[0].volatileCompletionPending).toBe(true);
    expect(db.prepare('SELECT pending_result_json, output_json FROM analyses WHERE id = ?').get(saved.analyses[0].id)).toEqual({ pending_result_json: null, output_json: null });

    db.exec('DROP TRIGGER fail_result_staging');
    await expect(analysis.locator('.analysis-state-completed')).toBeVisible();
    expect(db.prepare('SELECT status, pending_result_json FROM analyses WHERE id = ?').get(saved.analyses[0].id)).toMatchObject({ status: 'completed', pending_result_json: null });
  }, { analyze: async () => ({
    status: 'completed', recommendation: analysisFixtures[2].recommendation, provider: 'openai', requestedModel: 'test-model',
  }) }, (database) => {
    db = database;
    db.exec("CREATE TRIGGER fail_result_staging BEFORE UPDATE OF pending_result_json ON analyses WHEN NEW.pending_result_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected staging failure'); END");
  });
});

test('B requires associated evidence and keeps approval separate from the simulated reply action', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1002');
    const fixtureButton = page.getByRole('button', { name: 'Load evaluation fixture' });
    await expect(fixtureButton).toBeDisabled();
    await expect(page.getByText(/Associate all required diagnostic records first/)).toBeVisible();

    await page.locator('#diagnostic-query').fill('evt_subscription_480');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await page.getByRole('button', { name: 'Select all 3 unlinked attempt records for this event' }).click();
    await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(fixtureButton).toBeDisabled();
    await page.locator('#diagnostic-query').fill('evt_invoice_731');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await page.getByRole('button', { name: 'Select all 2 unlinked attempt records for this event' }).click();
    await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(fixtureButton).toBeEnabled();
    await page.getByLabel('Record a fictional outgoing reply. No message leaves this app.').fill('Keep this existing unsent text.');
    await fixtureButton.click();

    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('HTTP 204 acknowledgment');
    await expect(analysis).toContainText('downstream processing was not observed');
    await expect(analysis).toContainText('HTTP 503');
    await expect(analysis).toContainText('pending retry');
    await analysis.getByRole('button', { name: 'Edit draft and approve' }).click();
    const reviewedResponse = 'Edited response: the endpoint acknowledged the event, but processing remains unconfirmed.';
    const editor = analysis.locator('.review-structured-editor');
    await editor.getByRole('button', { name: 'Add hypothesis' }).click();
    await editor.getByLabel('Hypothesis').fill('Endpoint acknowledgment does not establish downstream processing.');
    await editor.getByLabel('Customer-response draft').fill(reviewedResponse);
    const causeReferences = editor.getByRole('group', { name: 'Possible cause — hypothesis' }).getByRole('group', { name: 'Supplied references' });
    await causeReferences.getByLabel('DIAG-WH-INV-001').check();
    await analysis.getByRole('button', { name: 'Save edited recommendation as approved' }).click();
    await expect(analysis).toContainText('Edited');
    await expect(analysis.getByRole('button', { name: 'Replace unsent draft with reviewed draft' })).toBeVisible();
    await analysis.getByRole('button', { name: 'Replace unsent draft with reviewed draft' }).click();
    await expect(page.getByLabel('Record a fictional outgoing reply. No message leaves this app.')).toHaveValue(reviewedResponse);
    await analysis.getByText('Inspect reviewed recommendation').click();
    await expect(analysis).toContainText('Endpoint acknowledgment does not establish downstream processing.');
    await expect(analysis).toContainText('diagnostic · DIAG-WH-INV-001');
    await expect(page.locator('.activity-list')).not.toContainText(reviewedResponse);
    await expect(page.locator('.case-detail .status-in_progress')).toBeVisible();

    await page.getByRole('button', { name: 'Record simulated reply' }).click();
    await expect(page.locator('.activity-list')).toContainText(reviewedResponse);
    await expect(page.locator('.case-detail .status-in_progress')).toBeVisible();
    await expect(page.getByText('1 reviewed · 0 accepted · 1 edited · 0 rejected')).toBeVisible();
  });
});

test('C accepts an uncertainty-first fixture and Use reviewed draft only fills the composer', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1003');
    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('Insufficient Evidence');
    await expect(analysis).toContainText('No cause is proposed.');
    await expect(analysis).toContainText('No supported observations were returned.');
    await analysis.getByRole('button', { name: 'Accept recommendation' }).click();
    await expect(analysis).toContainText('Accepted');
    await analysis.getByRole('button', { name: 'Use reviewed draft' }).click();
    await expect(page.getByLabel('Record a fictional outgoing reply. No message leaves this app.')).toHaveValue(/We do not yet have enough technical detail/);
    await expect(page.locator('.activity-list')).not.toContainText('We do not yet have enough technical detail');
    await expect(page.locator('.case-detail .status-open')).toBeVisible();
  });
});

test('polling does not rebase an open review draft after another view changes the decision', async ({ browser }) => {
  let releaseInference;
  const pendingInference = new Promise((resolve) => { releaseInference = resolve; });
  await withFreshApp(browser, async (page, baseUrl) => {
    try {
      await page.goto(baseUrl + '/#SEW-1003');
      await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
      const analysis = page.locator('.analysis-card').first();
      await analysis.getByRole('button', { name: 'Edit draft and approve' }).click();
      const editor = analysis.locator('.review-structured-editor');
      await editor.getByLabel('Customer-response draft').fill('A stale reviewed response that must not overwrite a newer rejection.');
      let current = (await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json()).case;
      const running = await page.request.post(baseUrl + '/api/cases/SEW-1003/analyses', {
        headers: { origin: new URL(baseUrl).origin, 'idempotency-key': 'polling-live-analysis' },
        data: { source: 'live', expectedVersion: current.version },
      });
      expect(running.status()).toBe(202);
      const fixtureAnalysis = current.analyses[0];
      current = (await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json()).case;
      const reject = await page.request.post(baseUrl + `/api/cases/SEW-1003/analyses/${fixtureAnalysis.id}/reviews`, {
        headers: { origin: new URL(baseUrl).origin, 'idempotency-key': 'polling-other-view-rejection' },
        data: { decision: 'reject', expectedVersion: current.version, feedback: 'Another view rejected this recommendation.' },
      });
      expect(reject.status()).toBe(200);

      await page.reload();
      const reloadedAnalysis = page.locator('.analysis-card').first();
      await expect(reloadedAnalysis).toContainText('Rejected');
      await reloadedAnalysis.getByRole('button', { name: 'Edit draft and approve' }).click();
      await reloadedAnalysis.getByRole('button', { name: 'Save edited recommendation as approved' }).click();
      const reviewPending = reloadedAnalysis.locator('.pending-action');
      await expect(reviewPending).toContainText('rejected');
      await expect(reviewPending).toContainText('case changed in another view');
      expect((await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json()).case.analyses[0].latestReview.decision).toBe('rejected');

      await reviewPending.getByRole('button', { name: 'Reload case and rebase review draft' }).click();
      await expect(reloadedAnalysis).toContainText('Latest case history loaded');
      await expect(reloadedAnalysis.getByLabel('Customer-response draft')).toHaveValue('A stale reviewed response that must not overwrite a newer rejection.');
      expect((await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json()).case.analyses[0].latestReview.decision).toBe('rejected');
    } finally {
      releaseInference({ status: 'failed', failureCode: 'provider_unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, { analyze: async () => pendingInference });
});

test('legacy review drafts without a captured case version require explicit reconciliation', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1003');
    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    const analysis = page.locator('.analysis-card').first();
    const analysisId = await analysis.locator('.analysis-card-heading strong').innerText();
    await page.evaluate((id) => {
      const drafts = JSON.parse(sessionStorage.getItem('supportops.case-drafts.v1') || '{}');
      const draft = drafts['SEW-1003'] || {};
      draft.reviewFeedbackByAnalysis = { ...(draft.reviewFeedbackByAnalysis || {}), [id]: 'A previously saved correction.' };
      delete draft.reviewExpectedVersionByAnalysis?.[id];
      delete draft.reviewVersionNeedsReconcileByAnalysis?.[id];
      drafts['SEW-1003'] = draft;
      sessionStorage.setItem('supportops.case-drafts.v1', JSON.stringify(drafts));
    }, analysisId);
    await page.reload();

    const reloaded = page.locator('.analysis-card').first();
    await reloaded.getByLabel('Reason or corrective feedback').fill('Updated legacy correction stays version-bound.');
    await expect(reloaded).toContainText('This saved review draft has no captured case version. Reconcile it explicitly before submitting.');
    const reject = reloaded.getByRole('button', { name: 'Reject recommendation and record correction' });
    await expect(reject).toBeDisabled();
    await reloaded.getByRole('button', { name: /Reconcile saved review draft with case version/ }).click();
    await expect(reject).toBeEnabled();
    await reject.click();
    await expect(reloaded).toContainText('Rejected');
    const latest = (await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json()).case.analyses[0].latestReview;
    expect(latest.feedback).toBe('Updated legacy correction stays version-bound.');
  });
});

test('uncertain reply and rejection acknowledgments disable reviewed-draft reuse', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1003');
    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    const analysis = page.locator('.analysis-card').first();
    await analysis.getByRole('button', { name: 'Accept recommendation' }).click();
    await expect(analysis).toContainText('Accepted');

    let replyCommitted = false;
    await page.route('**/api/cases/SEW-1003/activities', async (route) => {
      if (replyCommitted) return route.continue();
      replyCommitted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort();
    });
    const reply = page.getByLabel('Record a fictional outgoing reply. No message leaves this app.');
    await reply.fill('Existing unsent response during an uncertain save.');
    await page.getByRole('button', { name: 'Record simulated reply' }).click();
    const reuseWhileReplyPending = analysis.getByRole('button', { name: 'Replace unsent draft with reviewed draft' });
    await expect(reuseWhileReplyPending).toBeDisabled();
    await expect(reply).toHaveValue('Existing unsent response during an uncertain save.');
    await page.locator('.reply-card .pending-action').getByRole('button', { name: 'Retry exact save' }).click();
    await expect(reply).toHaveValue('');
    await expect(page.locator('.activity-list')).toContainText('Existing unsent response during an uncertain save.');

    let reviewCommitted = false;
    await page.route('**/api/cases/SEW-1003/analyses/*/reviews', async (route) => {
      if (reviewCommitted) return route.continue();
      reviewCommitted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort();
    });
    await analysis.getByLabel('Reason or corrective feedback').fill('Revoke the prior approval.');
    await analysis.getByRole('button', { name: 'Reject recommendation and record correction' }).click();
    const reuseWhileReviewPending = analysis.getByRole('button', { name: 'Use reviewed draft' });
    await expect(reuseWhileReviewPending).toBeDisabled();
    await expect(reply).toHaveValue('');
    await analysis.locator('.pending-action').getByRole('button', { name: 'Retry exact save' }).click();
    await expect(analysis).toContainText('Rejected');
    await expect(analysis.getByRole('button', { name: 'Use reviewed draft' })).toHaveCount(0);
    await expect(reply).toHaveValue('');
  });
});
