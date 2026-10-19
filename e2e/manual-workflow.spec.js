import { expect, test } from '@playwright/test';

test('manual resolution preserves history, simulated labeling, selection, and case draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('M2 manual workflow · no AI credentials needed')).toBeVisible();
  await expect(page).toHaveURL(/#SEW-1003$/);
  await page.getByRole('button', { name: /SEW-1002/ }).click();
  await expect(page).toHaveURL(/#SEW-1002$/);
  await page.goBack();
  await expect(page).toHaveURL(/#SEW-1003$/);
  await expect(page.getByRole('heading', { name: 'Intermittent API failures with no request IDs' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#SEW-1002$/);
  await expect(page.getByRole('heading', { name: 'Subscription updates are not appearing' })).toBeVisible();
  await page.getByRole('button', { name: /SEW-1001/ }).click();
  await page.getByLabel('Filter cases by status').selectOption('open');

  await page.getByLabel('Visible to support operators only').fill('Customer confirmed the API key rotation.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Customer confirmed the API key rotation.', { exact: true })).toBeVisible();

  await page.getByLabel('Record a fictional outgoing reply. No message leaves this app.').fill('Please confirm the next scheduled sync succeeds.');
  await page.getByRole('button', { name: 'Record simulated reply' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Simulated reply to customer — not sent', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Please confirm the next scheduled sync succeeds.', { exact: true })).toBeVisible();

  await page.getByLabel('Visible to support operators only').fill('Draft to keep while the case leaves the Open filter.');
  await page.getByLabel('Move case to').selectOption('resolved');
  await page.getByLabel('Resolution outcome').fill('The customer confirmed the integration works after rotating the key.');
  await page.getByRole('button', { name: 'Save status and history' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'outside the current Open filter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nightly API sync returns 401 responses' })).toBeVisible();
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('Draft to keep while the case leaves the Open filter.');
  await expect(page.getByRole('button', { name: /SEW-1001/ })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'outside the current Open filter' })).toBeVisible();
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('Draft to keep while the case leaves the Open filter.');
  await expect(page.getByText('Initial customer report', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Internal note', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Simulated reply to customer — not sent', { exact: true })).toBeVisible();
  await expect(page.getByText('Resolution outcome: The customer confirmed the integration works after rotating the key.')).toBeVisible();
  await expect(page.getByText('Resolved is terminal. Internal notes and simulated replies can still be recorded without changing the resolution.')).toBeVisible();
});

test('insufficient-information case can be escalated with an empty evidence list', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /SEW-1003/ }).click();
  await page.getByLabel('Move case to').selectOption('escalated');
  await page.getByLabel('Escalation reason').fill('The report does not identify an affected request.');
  await page.getByLabel('Current findings').fill('No request ID, exact time, or matching technical evidence is available.');
  await page.getByLabel('Outstanding questions').fill('Which request IDs and UTC time window are affected?');
  await expect(page.getByText('No diagnostic evidence is linked in M2; this escalation records an empty evidence list.')).toBeVisible();
  await page.getByRole('button', { name: 'Save status and history' }).click();

  await expect(page.getByText('Status changed from Open to Escalated.')).toBeVisible();
  await expect(page.getByText('Escalation reason: The report does not identify an affected request.')).toBeVisible();
  await expect(page.getByText('Findings: No request ID, exact time, or matching technical evidence is available.')).toBeVisible();
  await expect(page.getByText('Outstanding questions: Which request IDs and UTC time window are affected?')).toBeVisible();
  await expect(page.getByText('Diagnostic evidence: None linked.')).toBeVisible();
});

test('interrupted saves retry with the same key and stale conflicts require explicit reconciliation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /SEW-1002/ }).click();
  await page.route('**/api/cases/SEW-1002/activities', async (route) => {
    const savedResponse = await route.fetch();
    expect(savedResponse.status()).toBe(200);
    await route.abort();
  });
  await page.getByLabel('Visible to support operators only').fill('Retain this note through an interrupted save.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByRole('alert').getByText(/connection ended before the save was confirmed/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('A previous save is awaiting confirmation. The exact request is retained.')).toBeVisible();
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('Retain this note through an interrupted save.');
  await page.unroute('**/api/cases/SEW-1002/activities');
  await page.getByRole('button', { name: 'Retry exact save' }).click();
  await expect(page.getByText('Save confirmed from the existing receipt.', { exact: true })).toBeVisible();
  await expect(page.getByText('Retain this note through an interrupted save.')).toBeVisible();

  const { case: current } = await (await page.request.get('/api/cases/SEW-1002')).json();
  const externalResult = await page.evaluate(async (expectedVersion) => {
    const response = await fetch('/api/cases/SEW-1002/activities', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'browser-other-tab' },
      body: JSON.stringify({ type: 'note', text: 'Saved from another tab.', expectedVersion }),
    });
    return { status: response.status, body: await response.json() };
  }, current.version);
  expect(externalResult.status).toBe(200);

  await page.getByLabel('Visible to support operators only').fill('My draft after another tab updated the case.');
  let conflictRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/cases/SEW-1002/activities')) conflictRequests += 1;
  });
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByRole('button', { name: 'Reload case and review draft' })).toBeVisible();
  expect(conflictRequests).toBe(1);
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('My draft after another tab updated the case.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reload case and review draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry exact save' })).toHaveCount(0);
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('My draft after another tab updated the case.');
  await page.getByRole('button', { name: 'Reload case and review draft' }).click();
  await expect(page.getByText('Latest case history loaded. Your draft remains available for review.')).toBeVisible();
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('My draft after another tab updated the case.');
  await expect(page.locator('.activity-list').getByText('My draft after another tab updated the case.', { exact: true })).toHaveCount(0);
});
