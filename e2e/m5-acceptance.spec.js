import { expect, test } from '@playwright/test';
import { withFreshApp } from './support.js';

const replyLabel = 'Record a fictional outgoing reply. No message leaves this app.';

test('M5 A preserves the wrong fixture and correction through review, reply, resolution, and reload', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1001');
    await expect(page.locator('.linked-evidence-list .diagnostic-card')).toHaveCount(3);
    for (const id of ['DIAG-AUTH-401-001', 'DIAG-AUTH-401-002', 'DIAG-AUTH-401-003']) {
      await expect(page.locator('.linked-evidence-list .diagnostic-card').filter({ hasText: id })).toContainText('HTTP 401');
    }

    await page.getByRole('button', { name: 'KB-AUTH-01 · Interpreting API authentication failures · v1' }).click();
    await expect(page.locator('.knowledge-entry')).toContainText('Repeated 401 responses alone do not establish a provider outage');
    await page.getByRole('button', { name: 'KB-AUTH-01 · Interpreting API authentication failures · v1' }).click();
    await expect(page.locator('.knowledge-entry')).toHaveCount(0);
    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();

    const analyses = page.locator('.analysis-card');
    const first = analyses.first();
    const wrongCause = 'The provider is likely experiencing a service outage that is causing the authentication failures.';
    const correction = 'The three supplied HTTP 401 responses show rejected authentication. They do not establish a provider outage; verify the configured API key and required scopes.';
    await expect(first).toContainText('Synthetic evaluation fixture · intentionally incorrect');
    await expect(first).toContainText(wrongCause);
    await first.getByRole('button', { name: 'Inspect saved context' }).click();
    await expect(first.locator('.saved-context')).toContainText('DIAG-AUTH-401-001');
    await expect(first.locator('.saved-context')).toContainText('KB-AUTH-01');
    const originalReferences = first.locator('.recommendation-content');
    await expect(originalReferences.getByRole('button', { name: 'Supplied diagnostic: DIAG-AUTH-401-001' }).first()).toBeVisible();
    await originalReferences.getByRole('button', { name: 'Supplied diagnostic: DIAG-AUTH-401-001' }).first().click();
    await expect(page.locator('.diagnostic-inspection')).toContainText('HTTP 401');
    await originalReferences.getByRole('button', { name: 'Supplied knowledge: KB-AUTH-01' }).click();
    await expect(page.locator('.knowledge-entry')).toContainText('Confirm the configured key, its active status, and required scopes');

    await first.getByLabel('Reason or corrective feedback').fill(correction);
    await first.getByRole('button', { name: 'Reject recommendation and record correction' }).click();
    await expect(first.locator('.analysis-review-history')).toContainText(correction);
    await expect(page.locator('.case-detail .status-open')).toBeVisible();
    await expect(page.locator('.activity-list')).not.toContainText('Simulated reply to customer');

    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    await expect(analyses).toHaveCount(2);
    const next = analyses.nth(1);
    await next.getByRole('button', { name: 'Inspect saved context' }).click();
    await expect(next.locator('.saved-context pre')).toContainText(correction);
    await expect(next).toContainText('Synthetic evaluation fixture · intentionally incorrect');
    await expect(next).toContainText(wrongCause);
    const { case: afterReanalysis } = await (await page.request.get(baseUrl + '/api/cases/SEW-1001')).json();
    expect(afterReanalysis.analyses[1].source).toBe('fixture');
    const { analysis: nextSnapshot } = await (await page.request.get(baseUrl + '/api/analyses/' + afterReanalysis.analyses[1].id)).json();
    expect(nextSnapshot.context.correctiveFeedback).toContainEqual(expect.objectContaining({ feedback: correction }));
    expect(afterReanalysis.analyses[1].recommendation.possibleCause.text).toBe(wrongCause);

    await next.getByRole('button', { name: 'Edit draft and approve' }).click();
    const editor = next.locator('.review-structured-editor');
    const response = 'Three requests returned HTTP 401, which means those requests were rejected during authentication. This evidence does not confirm a provider outage. Please verify that your configured API key is current and includes the required scopes. We have not inspected your credentials or confirmed that service has been restored.';
    await editor.getByLabel('Classification').selectOption('authentication');
    await editor.getByLabel('Observation 1').fill('All three linked API requests returned HTTP 401 Unauthorized.');
    const observationReferences = editor.getByRole('group', { name: 'Observations — facts to verify' }).getByRole('group', { name: 'Supplied references' });
    for (const id of ['DIAG-AUTH-401-001', 'DIAG-AUTH-401-002', 'DIAG-AUTH-401-003']) {
      await observationReferences.getByLabel(id).check();
    }
    const cause = editor.getByRole('group', { name: 'Possible cause — hypothesis' });
    await cause.getByLabel('Hypothesis').fill('The supplied 401 responses indicate rejected authentication; they do not establish a provider outage.');
    await cause.getByRole('group', { name: 'Supplied references' }).getByLabel('KB-AUTH-01').check();
    await editor.getByLabel('Recommended next steps — not executed').fill('Verify the configured API key is current.\nConfirm that it includes the required scopes.\nRetry with verified credentials and compare the response.');
    await editor.getByLabel('Customer-response draft').fill(response);
    await editor.getByLabel('Uncertainty and missing information — one item per line').fill('The customer credentials were not inspected.\nNo provider incident source was supplied.\nCustomer remediation and service restoration are unverified.');
    const overallReferences = editor.getByRole('group', { name: 'Overall supplied references' });
    for (const id of ['DIAG-AUTH-401-001', 'DIAG-AUTH-401-002', 'DIAG-AUTH-401-003', 'KB-AUTH-01']) {
      await overallReferences.getByLabel(id).check();
    }
    await next.getByRole('button', { name: 'Save edited recommendation as approved' }).click();
    await expect(next).toContainText('Edited');
    await expect(next).toContainText(wrongCause);
    await next.getByText('Inspect reviewed recommendation').click();
    await expect(next).toContainText('Classification: Authentication');
    await expect(next).toContainText('The customer credentials were not inspected');

    const reply = page.getByLabel(replyLabel);
    await expect(reply).toHaveValue('');
    await next.getByRole('button', { name: 'Use reviewed draft' }).click();
    await expect(reply).toHaveValue(response);
    await expect(page.locator('.activity-list')).not.toContainText(response);
    await expect(page.locator('.case-detail .status-open')).toBeVisible();
    await page.getByRole('button', { name: 'Record simulated reply' }).click();
    await expect(page.locator('.activity-list')).toContainText(response);
    await expect(page.locator('.activity-list')).toContainText('Simulated reply to customer — not sent');

    const outcome = 'Completed this demonstration investigation and recorded authentication guidance. The customer credential change and service restoration remain unverified.';
    await page.getByLabel('Move case to').selectOption('resolved');
    await page.getByLabel('Resolution outcome').fill(outcome);
    await page.getByRole('button', { name: 'Save status and history' }).click();
    await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
    await expect(page.locator('.activity-list')).toContainText('Resolution outcome: ' + outcome);

    await page.reload();
    await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
    await expect(page.locator('.activity-list')).toContainText('Initial customer report');
    await expect(page.locator('.activity-list')).toContainText('Simulated reply to customer — not sent');
    await expect(page.locator('.activity-list')).toContainText(response);
    await expect(page.locator('.activity-list')).toContainText('Resolution outcome: ' + outcome);
    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1001')).json();
    expect(saved.analyses[0].recommendation.possibleCause.text).toBe(wrongCause);
    expect(saved.analyses[0].latestReview).toMatchObject({ decision: 'rejected', feedback: correction });
    expect(saved.analyses[1].recommendation.possibleCause.text).toBe(wrongCause);
    expect(saved.analyses[1].latestReview.decision).toBe('edited');
    expect(saved.status).toBe('resolved');
    expect(saved.activities.some((item) => item.type === 'simulated_reply' && item.payload.text === response)).toBe(true);
    expect(saved.activities.some((item) => item.type === 'status_changed' && item.payload.outcome === outcome)).toBe(true);
  });
});

test('M5 B keeps Cedar event histories separate, links all five attempts, reviews safely, and escalates evidence', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1002');
    const fixtureButton = page.getByRole('button', { name: 'Load evaluation fixture' });
    await expect(fixtureButton).toBeDisabled();
    await expect(page.getByText(/Associate all required diagnostic records first/)).toBeVisible();

    await page.locator('#diagnostic-query').fill('evt_subscription');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No diagnostic records matched this exact ID' })).toBeVisible();
    await page.locator('#diagnostic-query').fill('evt_subscription_480');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await expect(page.locator('.diagnostic-result')).toHaveCount(4);
    const maple = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-OTHER-001' });
    await expect(maple).toContainText('ORG-MAPLE-99');
    const cedarFirst = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-001' });
    await expect(cedarFirst).toContainText('ORG-CEDAR-02');
    await maple.getByRole('button', { name: 'Inspect record and attempts' }).click();
    const mapleAttempts = page.locator('.attempt-history .diagnostic-card');
    await expect(mapleAttempts).toHaveCount(1);
    await expect(mapleAttempts.first()).toContainText('DIAG-OTHER-001');
    await expect(page.locator('.attempt-history')).not.toContainText('DIAG-WH-SUB-001');
    await cedarFirst.getByRole('button', { name: 'Inspect record and attempts' }).click();
    const subscriptionAttempts = page.locator('.attempt-history .diagnostic-card');
    await expect(subscriptionAttempts).toHaveCount(3);
    await expect(subscriptionAttempts.filter({ hasText: 'DIAG-WH-SUB-001' })).toContainText('HTTP 500');
    await expect(subscriptionAttempts.filter({ hasText: 'DIAG-WH-SUB-002' })).toContainText('No HTTP response observed.');
    await expect(subscriptionAttempts.filter({ hasText: 'DIAG-WH-SUB-003' })).toContainText('Acknowledged by endpoint; downstream processing not observed.');
    await expect(page.locator('.attempt-history')).not.toContainText('DIAG-OTHER-001');
    await page.getByRole('button', { name: 'Select all 3 unlinked attempt records for this event' }).click();
    await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

    await page.locator('#diagnostic-query').fill('evt_invoice_731');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    const invoiceFirst = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-INV-001' });
    await invoiceFirst.getByRole('button', { name: 'Inspect record and attempts' }).click();
    const invoiceAttempts = page.locator('.attempt-history .diagnostic-card');
    await expect(invoiceAttempts).toHaveCount(2);
    await expect(invoiceAttempts.filter({ hasText: 'DIAG-WH-INV-001' })).toContainText('HTTP 503');
    await expect(invoiceAttempts.filter({ hasText: 'DIAG-WH-INV-002' })).toContainText('Pending retry; no observed delivery time or response.');
    await page.getByRole('button', { name: 'Select all 2 unlinked attempt records for this event' }).click();
    await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(page.locator('.linked-evidence-list .diagnostic-card')).toHaveCount(5);
    await expect(fixtureButton).toBeEnabled();

    const unsent = 'Keep this unrelated B reply draft unchanged.';
    await page.getByLabel(replyLabel).fill(unsent);
    await fixtureButton.click();
    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('HTTP 500');
    await expect(analysis).toContainText('timed out without an HTTP response');
    await expect(analysis).toContainText('HTTP 204 acknowledgment');
    await expect(analysis).toContainText('HTTP 503');
    await expect(analysis).toContainText('pending retry');
    await expect(analysis).toContainText('downstream processing was not observed');

    await analysis.getByRole('button', { name: 'Edit draft and approve' }).click();
    const editor = analysis.locator('.review-structured-editor');
    const reviewedResponse = 'The subscription endpoint returned HTTP 204, which confirms acknowledgment only. We cannot confirm downstream processing. The invoice attempts show HTTP 503 followed by a pending retry with no observed response.';
    await editor.getByLabel('Customer-response draft').fill(reviewedResponse);
    await editor.getByLabel('Recommended next steps — not executed').fill('Compare both event IDs with receiver logs at the supplied attempt times.\nConfirm whether the acknowledged subscription event was processed downstream.');
    await analysis.getByRole('button', { name: 'Save edited recommendation as approved' }).click();
    await expect(analysis).toContainText('Edited');
    await expect(page.getByLabel(replyLabel)).toHaveValue(unsent);
    await expect(page.locator('.activity-list')).not.toContainText(reviewedResponse);
    await analysis.getByText('Inspect reviewed recommendation').click();
    await expect(analysis).toContainText(reviewedResponse);
    await page.reload();
    await expect(page.getByLabel(replyLabel)).toHaveValue(unsent);

    await page.getByLabel('Move case to').selectOption('escalated');
    await page.getByLabel('Escalation reason').fill('Engineering review is needed because downstream receipt cannot be verified from these attempt records.');
    await page.getByLabel('Current findings').fill('Cedar subscription attempts returned HTTP 500, timed out without a response, then received HTTP 204 acknowledgment. Invoice attempts show HTTP 503 and a pending retry.');
    await page.getByLabel('Outstanding questions').fill('Did the customer receiver process the acknowledged subscription event, and what happened after the invoice retry became pending?');
    const linkedForEscalation = page.getByRole('group', { name: 'Diagnostic evidence already linked to this case' });
    for (const id of ['DIAG-WH-SUB-001', 'DIAG-WH-SUB-002', 'DIAG-WH-SUB-003', 'DIAG-WH-INV-001', 'DIAG-WH-INV-002']) {
      await linkedForEscalation.getByLabel(new RegExp(id)).check();
    }
    await page.getByRole('button', { name: 'Save status and history' }).click();
    await expect(page.locator('.case-detail .status-escalated')).toBeVisible();
    await expect(page.locator('.activity-list')).toContainText('Diagnostic evidence in this escalation: DIAG-WH-SUB-001, DIAG-WH-SUB-002, DIAG-WH-SUB-003, DIAG-WH-INV-001, DIAG-WH-INV-002.');
    await expect(page.getByLabel(replyLabel)).toHaveValue(unsent);
    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1002')).json();
    expect(saved.evidence.map((item) => item.id)).toEqual(expect.arrayContaining(['DIAG-WH-SUB-001', 'DIAG-WH-SUB-002', 'DIAG-WH-SUB-003', 'DIAG-WH-INV-001', 'DIAG-WH-INV-002']));
    const escalation = saved.activities.find((item) => item.type === 'status_changed' && item.payload.to === 'escalated');
    expect(escalation.payload.evidenceIds).toHaveLength(5);
    expect(escalation.payload.questions).toContain('Did the customer receiver process');
    expect(saved.analyses[0].latestReview.decision).toBe('edited');
    expect(saved.status).toBe('escalated');
  });
});

test('M5 C preserves uncertainty, records a specific information request, and escalates without evidence', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1003');
    await page.locator('#diagnostic-query').fill('req_missing_case_c_20261020');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No diagnostic records matched this exact ID' })).toBeVisible();
    await expect(page.locator('.linked-evidence-list .diagnostic-card')).toHaveCount(0);

    await page.getByRole('button', { name: 'Load evaluation fixture' }).click();
    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('Insufficient Evidence');
    await expect(analysis).toContainText('No supported observations were returned.');
    await expect(analysis).toContainText('No cause is proposed.');
    await analysis.getByRole('button', { name: 'Inspect saved context' }).click();
    await expect(analysis.locator('.saved-context')).toContainText('Allowed diagnostic IDs');
    await expect(analysis.locator('.saved-context')).toContainText('None');
    await expect(analysis.locator('.saved-context')).toContainText('KB-REQUEST-01');
    const { case: beforeReview } = await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json();
    expect(beforeReview.analyses[0].referenceAllowlist.diagnostics).toEqual([]);
    expect(beforeReview.analyses[0].recommendation.possibleCause).toBeNull();
    expect(beforeReview.analyses[0].recommendation.observations).toEqual([]);

    await analysis.getByRole('button', { name: 'Accept recommendation' }).click();
    await expect(analysis).toContainText('Accepted');
    await analysis.getByRole('button', { name: 'Use reviewed draft' }).click();
    const reply = page.getByLabel(replyLabel);
    await expect(reply).toHaveValue(/We do not yet have enough technical detail/);
    await expect(page.locator('.activity-list')).not.toContainText('We do not yet have enough technical detail');
    await expect(page.locator('.case-detail .status-open')).toBeVisible();

    const request = 'Please share one exact request ID, the affected environment, and a narrow UTC time window. Include the sanitized error response and remove tokens, secrets, and personal data before sending.';
    await reply.fill(request);
    await page.getByRole('button', { name: 'Record simulated reply' }).click();
    await expect(page.locator('.activity-list')).toContainText('Simulated reply to customer — not sent');
    await expect(page.locator('.activity-list')).toContainText('exact request ID');
    await expect(page.locator('.case-detail .status-open')).toBeVisible();

    await page.getByLabel('Move case to').selectOption('escalated');
    await page.getByLabel('Escalation reason').fill('Engineering triage cannot identify the affected path without request-level evidence.');
    await page.getByLabel('Current findings').fill('The exact lookup returned no diagnostic rows. No cause or request failure has been established.');
    await page.getByLabel('Outstanding questions').fill('Which request ID, environment, UTC time window, and sanitized error can engineering use to investigate?');
    await expect(page.getByText('No evidence is linked. This escalation will record an empty list.')).toBeVisible();
    await page.getByRole('button', { name: 'Save status and history' }).click();
    await expect(page.locator('.case-detail .status-escalated')).toBeVisible();
    await expect(page.locator('.activity-list')).toContainText('Diagnostic evidence: None linked.');
    const { case: saved } = await (await page.request.get(baseUrl + '/api/cases/SEW-1003')).json();
    expect(saved.evidence).toEqual([]);
    expect(saved.analyses[0].latestReview.decision).toBe('accepted');
    expect(saved.activities.some((item) => item.type === 'simulated_reply' && item.payload.text === request)).toBe(true);
    const escalation = saved.activities.find((item) => item.type === 'status_changed' && item.payload.to === 'escalated');
    expect(escalation.payload.evidenceIds).toEqual([]);
    expect(escalation.payload.findings).toContain('No cause or request failure has been established');
    expect(saved.status).toBe('escalated');
  });
});

test('M5 narrow layout keeps keyboard focus, labels, and save feedback usable', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(baseUrl + '/#SEW-1001');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByLabel('Visible to support operators only')).toBeVisible();
    await expect(page.getByLabel(replyLabel)).toBeVisible();
    await expect(page.getByLabel('Move case to')).toBeVisible();

    const fixture = page.getByRole('button', { name: 'Load evaluation fixture' });
    await fixture.focus();
    const focus = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focus).toEqual({ outlineStyle: 'solid', outlineWidth: '3px' });
    await page.keyboard.press('Enter');
    await expect(page.locator('.analysis-card')).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
