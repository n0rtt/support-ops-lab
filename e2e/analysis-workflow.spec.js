import { expect, test } from '@playwright/test';
import { withFreshApp } from './support.js';

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
    await expect(fixtureButton).toBeEnabled();
    await page.getByLabel('Record a fictional outgoing reply. No message leaves this app.').fill('Keep this existing unsent text.');
    await fixtureButton.click();

    const analysis = page.locator('.analysis-card').first();
    await expect(analysis).toContainText('HTTP 204 acknowledgment');
    await expect(analysis).toContainText('downstream processing was not observed');
    await analysis.getByRole('button', { name: 'Edit draft and approve' }).click();
    const reviewedResponse = 'Edited response: the endpoint acknowledged the event, but processing remains unconfirmed.';
    await analysis.getByLabel('Reviewed customer-response draft').fill(reviewedResponse);
    await analysis.getByRole('button', { name: 'Save edited recommendation as approved' }).click();
    await expect(analysis).toContainText('Edited');
    await expect(analysis.getByRole('button', { name: 'Replace unsent draft with reviewed draft' })).toBeVisible();
    await analysis.getByRole('button', { name: 'Replace unsent draft with reviewed draft' }).click();
    await expect(page.getByLabel('Record a fictional outgoing reply. No message leaves this app.')).toHaveValue(reviewedResponse);
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
