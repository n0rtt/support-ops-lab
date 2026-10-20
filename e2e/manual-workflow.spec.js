import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase } from '../server/database.js';

async function holdCommittedResponse(page, matcher) {
  let release;
  let committed;
  let fulfilled;
  let held = false;
  const responseHeld = new Promise((resolve) => { release = resolve; });
  const requestCommitted = new Promise((resolve) => { committed = resolve; });
  const responseFulfilled = new Promise((resolve) => { fulfilled = resolve; });
  await page.route(matcher, async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await responseHeld;
    await route.fulfill({ response });
    fulfilled();
  });
  return { requestCommitted, responseFulfilled, release };
}

async function withFreshApp(browser, run) {
  const directory = mkdtempSync(join(tmpdir(), 'supportops-diagnostic-ui-'));
  const db = openDatabase(join(directory, 'supportops.sqlite'));
  initializeDatabase(db);
  const server = createApp({ db }).listen(0, '127.0.0.1');
  let context;
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    context = await browser.newContext();
    await run(await context.newPage(), 'http://127.0.0.1:' + server.address().port);
  } finally {
    await context?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('A shows its three linked 401 records and KB inspection without losing the case draft', async ({ page }, testInfo) => {
  await page.goto('/#SEW-1001');
  await expect(page.getByRole('heading', { name: 'Nightly API sync returns 401 responses' })).toBeVisible();
  await expect(page.locator('.linked-evidence-list .diagnostic-card')).toHaveCount(3);
  await expect(page.locator('.linked-evidence-list')).toContainText('HTTP 401');
  const note = page.getByLabel('Visible to support operators only');
  await note.fill('Keep this A draft while inspecting diagnostic and KB context.');
  await page.locator('#diagnostic-query').fill('req_auth_20261019_001');
  await page.getByRole('button', { name: 'Search diagnostics' }).click();
  await expect(page.locator('.diagnostic-result')).toHaveCount(1);
  await expect(page.locator('.diagnostic-result')).toContainText('DIAG-AUTH-401-001');
  await page.getByRole('button', { name: /KB-AUTH-01/ }).click();
  await expect(page.getByRole('heading', { name: /Interpreting API authentication failures/ })).toBeVisible();
  await expect(page.getByText(/Repeated 401 responses alone do not establish a provider outage/)).toBeVisible();
  await expect(note).toHaveValue('Keep this A draft while inspecting diagnostic and KB context.');
  await page.screenshot({ path: testInfo.outputPath('m3-a-investigation.png'), fullPage: true });
});

test('evidence selection stays actionable after reload and search states', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    await page.goto(baseUrl + '/#SEW-1002');
    await page.locator('#diagnostic-query').fill('evt_invoice_731');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    const firstAttempt = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-INV-001' });
    await firstAttempt.getByRole('checkbox', { name: 'Select for association' }).check();
    await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

    await page.reload();
    const linkedAttempt = page.locator('.linked-evidence-list .diagnostic-card').filter({ hasText: 'DIAG-WH-INV-001' });
    await linkedAttempt.getByRole('button', { name: 'Inspect record and attempts' }).click();
    const remainingAttempt = page.locator('.attempt-history .diagnostic-card').filter({ hasText: 'DIAG-WH-INV-002' });
    await remainingAttempt.getByRole('checkbox', { name: 'Select this attempt for association' }).check();
    await expect(page.getByText('Rows selected for SEW-1002: 1')).toBeVisible();
    await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    const linked = await page.evaluate(async () => (await (await fetch('/api/cases/SEW-1002')).json()).case.evidence.map((item) => item.id));
    expect(linked).toEqual(['DIAG-WH-INV-001', 'DIAG-WH-INV-002']);

    await page.locator('#diagnostic-query').fill('evt_subscription_480');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    const subscriptionAttempt = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-001' });
    await subscriptionAttempt.getByRole('checkbox', { name: 'Select for association' }).check();

    await page.locator('#diagnostic-query').fill('no-such-diagnostic');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No diagnostic records matched this exact ID' })).toBeVisible();
    await expect(page.getByText('Rows selected for SEW-1002: 1')).toBeVisible();
    await page.getByRole('button', { name: 'Remove DIAG-WH-SUB-001 from selection' }).click();
    await expect(page.getByText('Rows selected for SEW-1002: 0')).toBeVisible();

    await page.locator('#diagnostic-query').fill('evt_subscription_480');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-001' }).getByRole('checkbox', { name: 'Select for association' }).check();
    const failedSearch = (url) => url.pathname === '/api/diagnostics' && url.searchParams.get('q') === 'search-unavailable';
    await page.route(failedSearch, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
    await page.locator('#diagnostic-query').fill('search-unavailable');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Diagnostic search is unavailable' })).toBeVisible();
    await expect(page.getByText('Rows selected for SEW-1002: 1')).toBeVisible();
    await page.getByRole('button', { name: 'Remove DIAG-WH-SUB-001 from selection' }).click();
    await expect(page.getByText('Rows selected for SEW-1002: 0')).toBeVisible();
    await page.unroute(failedSearch);

    await page.locator('#diagnostic-query').fill('evt_subscription_480');
    await page.getByRole('button', { name: 'Search diagnostics' }).click();
    await page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-001' }).getByRole('checkbox', { name: 'Select for association' }).check();
    await page.getByRole('button', { name: /SEW-1001/ }).click();
    await expect(page.getByText('Rows selected for SEW-1001: 0')).toBeVisible();
    await page.getByRole('button', { name: /SEW-1002/ }).click();
    await expect(page.getByText('Rows selected for SEW-1002: 1')).toBeVisible();
  });
});

test('a new search invalidates pending diagnostic detail success and failure responses', async ({ browser }) => {
  await withFreshApp(browser, async (page, baseUrl) => {
    async function search(query) {
      await page.locator('#diagnostic-query').fill(query);
      await page.getByRole('button', { name: 'Search diagnostics' }).click();
    }

    await page.goto(baseUrl + '/#SEW-1002');
    await search('evt_subscription_480');
    const heldSuccess = await holdCommittedResponse(page, '**/api/diagnostics/DIAG-WH-SUB-001');
    await page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-001' }).getByRole('button', { name: 'Inspect record and attempts' }).click();
    await heldSuccess.requestCommitted;
    await search('no-such-diagnostic');
    await expect(page.getByRole('status').filter({ hasText: 'No diagnostic records matched this exact ID' })).toBeVisible();
    heldSuccess.release();
    await heldSuccess.responseFulfilled;
    await page.waitForTimeout(100);
    await expect(page.getByLabel('Selected diagnostic details')).toHaveCount(0);
    await page.unroute('**/api/diagnostics/DIAG-WH-SUB-001');

    await search('evt_subscription_480');
    let release;
    let detailStarted;
    let detailFailed;
    let held = false;
    const responseHeld = new Promise((resolve) => { release = resolve; });
    const requestStarted = new Promise((resolve) => { detailStarted = resolve; });
    const requestFailed = new Promise((resolve) => { detailFailed = resolve; });
    await page.route('**/api/diagnostics/DIAG-WH-SUB-001', async (route) => {
      if (held) return route.continue();
      held = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      detailStarted();
      await responseHeld;
      await route.abort();
      detailFailed();
    });
    await page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-001' }).getByRole('button', { name: 'Inspect record and attempts' }).click();
    await requestStarted;
    await search('no-such-diagnostic');
    await expect(page.getByRole('status').filter({ hasText: 'No diagnostic records matched this exact ID' })).toBeVisible();
    release();
    await requestFailed;
    await page.waitForTimeout(100);
    await expect(page.getByLabel('Selected diagnostic details')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Diagnostic details are unavailable' })).toHaveCount(0);
  });
});

test('manual resolution preserves history, simulated labeling, selection, and case draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('M3 diagnostic investigation · no AI credentials needed')).toBeVisible();
  await expect(page.getByRole('button', { name: /SEW-1001/ }).getByText('High priority', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /SEW-1002/ }).getByText('Medium priority', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /SEW-1003/ }).getByText('Low priority', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#SEW-1001$/);
  await expect(page.getByRole('heading', { name: 'Nightly API sync returns 401 responses' })).toBeVisible();
  await page.getByRole('button', { name: /SEW-1002/ }).click();
  await expect(page).toHaveURL(/#SEW-1002$/);
  await page.goBack();
  await expect(page).toHaveURL(/#SEW-1001$/);
  await expect(page.getByRole('heading', { name: 'Nightly API sync returns 401 responses' })).toBeVisible();
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

  const staleDetail = await holdCommittedResponse(page, '**/api/cases/SEW-1001');
  await page.locator('button.case-card').filter({ hasText: 'SEW-1001' }).click();
  await staleDetail.requestCommitted;

  await page.getByLabel('Visible to support operators only').fill('Draft to keep while the case leaves the Open filter.');
  await page.getByLabel('Move case to').selectOption('resolved');
  await page.getByLabel('Resolution outcome').fill('The customer confirmed the integration works after rotating the key.');
  await page.getByRole('button', { name: 'Save status and history' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'outside the current Open filter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nightly API sync returns 401 responses' })).toBeVisible();
  await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
  await expect(page.getByText('Resolution outcome: The customer confirmed the integration works after rotating the key.')).toBeVisible();
  staleDetail.release();
  await staleDetail.responseFulfilled;
  await page.unroute('**/api/cases/SEW-1001');
  await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
  await expect(page.getByText('Resolution outcome: The customer confirmed the integration works after rotating the key.')).toBeVisible();
  await expect(page.getByLabel('Move case to')).toHaveCount(0);
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('Draft to keep while the case leaves the Open filter.');
  await expect(page.locator('button.case-card').filter({ hasText: 'SEW-1001' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'outside the current Open filter' })).toBeVisible();
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('Draft to keep while the case leaves the Open filter.');
  await expect(page.getByText('Initial customer report', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Internal note', { exact: true })).toBeVisible();
  await expect(page.locator('.activity-list').getByText('Simulated reply to customer — not sent', { exact: true })).toBeVisible();
  await expect(page.getByText('Resolution outcome: The customer confirmed the integration works after rotating the key.')).toBeVisible();
  await expect(page.getByText('Resolved is terminal. Internal notes and simulated replies can still be recorded without changing the resolution.')).toBeVisible();
});

test('a late save refresh respects the current status filter', async ({ page }) => {
  await page.goto('/#SEW-1001');
  const save = await holdCommittedResponse(page, '**/api/cases/SEW-1001/activities');
  await page.getByLabel('Visible to support operators only').fill('This note must not replace the active queue filter.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await save.requestCommitted;

  const filter = await holdCommittedResponse(
    page,
    (url) => url.pathname === '/api/cases' && url.searchParams.get('status') === 'in_progress',
  );
  await page.getByLabel('Filter cases by status').selectOption('in_progress');
  await filter.requestCommitted;
  save.release();
  await save.responseFulfilled;
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading synthetic cases…')).toHaveCount(0);
  const cards = page.locator('.case-card .status');
  await expect(cards).toHaveText(['In progress']);
  filter.release();
  await filter.responseFulfilled;

  await expect(page.getByLabel('Filter cases by status')).toHaveValue('in_progress');
  await expect(cards).toHaveText(['In progress']);
});

test('B search shows organization-scoped history and supports safe linking and evidence-backed escalation', async ({ page }) => {
  await page.goto('/#SEW-1002');
  const note = page.getByLabel('Visible to support operators only');
  await note.fill('Preserve B context while inspecting diagnostics.');
  await page.locator('#diagnostic-query').fill('evt_subscription_480');
  await page.getByRole('button', { name: 'Search diagnostics' }).click();
  await expect(page.locator('.diagnostic-result')).toHaveCount(4);
  await expect(page.getByRole('status').filter({ hasText: '4 matching diagnostic rows across 2 organization-scoped events' })).toBeVisible();

  const unrelated = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-OTHER-001' });
  await unrelated.getByRole('checkbox', { name: 'Select for association' }).check();
  await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
  await expect(page.getByText(/belongs to another organization: DIAG-OTHER-001/)).toBeVisible();
  await expect(unrelated.getByRole('checkbox')).toBeChecked();
  await unrelated.getByRole('checkbox', { name: 'Select for association' }).uncheck();

  const timeoutRow = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-SUB-002' });
  await timeoutRow.getByRole('button', { name: 'Inspect record and attempts' }).click();
  await expect(page.getByText('3 attempt records · one organization-scoped event')).toBeVisible();
  await expect(page.locator('.attempt-history')).toContainText('No HTTP response observed.');
  await expect(page.locator('.attempt-history')).toContainText('Acknowledged by endpoint; downstream processing not observed.');

  await page.getByRole('button', { name: 'Select all 3 unlinked attempt records for this event' }).click();
  await expect(page.getByText('Rows selected for SEW-1002: 3')).toBeVisible();
  await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.locator('.diagnostic-section .section-heading').first()).toContainText('3 associated records');

  await page.getByLabel('Filter cases by status').selectOption('open');
  await expect(page.getByRole('status').filter({ hasText: 'outside the current Open filter' })).toBeVisible();
  await expect(note).toHaveValue('Preserve B context while inspecting diagnostics.');
  await page.getByRole('button', { name: /KB-WEBHOOK-01/ }).click();
  await expect(page.getByRole('heading', { name: /Webhook retries and endpoint acknowledgment/ })).toBeVisible();
  await page.getByLabel('Move case to').selectOption('escalated');
  await page.getByLabel('Escalation reason').fill('Engineering should inspect the endpoint behavior.');
  await page.getByLabel('Current findings').fill('Three attempts were recorded; the last received HTTP 204 acknowledgment.');
  await page.getByLabel('Outstanding questions').fill('Did the receiver complete downstream processing?');
  const escalationEvidence = page.getByRole('group', { name: 'Diagnostic evidence already linked to this case' });
  await escalationEvidence.getByLabel(/DIAG-WH-SUB-003/).check();
  await page.getByRole('button', { name: 'Save status and history' }).click();
  await expect(page.locator('.case-detail .status-escalated')).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('Diagnostic evidence in this escalation: DIAG-WH-SUB-003.');
  await expect(page.getByRole('heading', { name: /Webhook retries and endpoint acknowledgment/ })).toBeVisible();
  await expect(note).toHaveValue('Preserve B context while inspecting diagnostics.');
});

test('association conflicts keep the selected IDs for review and a lost acknowledgment retries the same receipt', async ({ page }) => {
  await page.goto('/#SEW-1002');
  await page.locator('#diagnostic-query').fill('evt_invoice_731');
  await page.getByRole('button', { name: 'Search diagnostics' }).click();
  await expect(page.locator('.diagnostic-result')).toHaveCount(2);
  const firstInvoiceAttempt = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-INV-001' });
  await firstInvoiceAttempt.getByRole('checkbox', { name: 'Select for association' }).check();

  const externalUpdate = await page.evaluate(async () => {
    const { case: current } = await (await fetch('/api/cases/SEW-1002')).json();
    const response = await fetch('/api/cases/SEW-1002/activities', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-before-evidence-conflict' },
      body: JSON.stringify({ type: 'internal_note', text: 'Another view changed B before association.', expectedVersion: current.version }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(externalUpdate.status).toBe(200);
  await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
  await expect(page.getByText(/case changed in another view/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload case and review draft' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload case and review draft' }).click();
  await expect(page.getByText('Latest case history loaded. Your draft remains available for review.')).toBeVisible();
  await expect(firstInvoiceAttempt.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

  const secondInvoiceAttempt = page.locator('.diagnostic-result').filter({ hasText: 'DIAG-WH-INV-002' });
  await secondInvoiceAttempt.getByRole('checkbox', { name: 'Select for association' }).check();
  await page.route('**/api/cases/SEW-1002/evidence', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort();
  });
  await page.getByRole('button', { name: 'Link selected evidence to SEW-1002' }).click();
  await expect(page.getByRole('alert').getByText(/connection ended before the save was confirmed/)).toBeVisible();
  const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.pending-actions.v1') || '{}')['SEW-1002:evidence']);
  expect(pending).toMatchObject({ type: 'evidence', method: 'POST', state: 'uncertain', payload: { diagnosticIds: ['DIAG-WH-INV-002'] } });
  await page.unroute('**/api/cases/SEW-1002/evidence');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry exact save' })).toBeVisible();
  await expect(page.getByText('Submitted diagnostic rows: DIAG-WH-INV-002')).toBeVisible();
  await page.getByRole('button', { name: 'Retry exact save' }).click();
  await expect(page.getByText('Save confirmed from the existing receipt.', { exact: true })).toBeVisible();
  const { case: saved } = await (await page.request.get('/api/cases/SEW-1002')).json();
  expect(saved.evidence.map((row) => row.id)).toContain('DIAG-WH-INV-002');
  expect(saved.activities.filter((activity) => activity.type === 'evidence_linked' && activity.payload.diagnosticIds.includes('DIAG-WH-INV-002'))).toHaveLength(1);
});

test('a late acknowledgment cannot replace the selected case or redirect its next action', async ({ page }) => {
  await page.goto('/#SEW-1001');
  let hold = await holdCommittedResponse(page, '**/api/cases/SEW-1001/activities');
  await page.getByLabel('Visible to support operators only').fill('Saved on SEW-1001 while opening another case.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await hold.requestCommitted;

  await page.getByRole('button', { name: /SEW-1002/ }).click();
  await expect(page.getByRole('heading', { name: 'Subscription updates are not appearing' })).toBeVisible();
  hold.release();
  await expect(page).toHaveURL(/#SEW-1002$/);
  await expect(page.getByRole('heading', { name: 'Subscription updates are not appearing' })).toBeVisible();
  await expect(page.locator('button.case-card').filter({ hasText: 'SEW-1002' })).toHaveAttribute('aria-pressed', 'true');
  await page.unroute('**/api/cases/SEW-1001/activities');

  await page.getByLabel('Visible to support operators only').fill('This note belongs to selected SEW-1002.');
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/cases/SEW-1002/activities'));
  await page.getByRole('button', { name: 'Add internal note' }).click();
  expect((await saved).status()).toBe(200);
  const first = await (await page.request.get('/api/cases/SEW-1001')).json();
  const second = await (await page.request.get('/api/cases/SEW-1002')).json();
  expect(first.case.activities.at(-1).payload.text).toBe('Saved on SEW-1001 while opening another case.');
  expect(second.case.activities.at(-1).payload.text).toBe('This note belongs to selected SEW-1002.');
});

test('newer note, reply, and outcome drafts survive earlier acknowledgments and reload', async ({ page }) => {
  await page.goto('/#SEW-1002');

  let hold = await holdCommittedResponse(page, '**/api/cases/SEW-1002/activities');
  const note = page.getByLabel('Visible to support operators only');
  await note.fill('Submitted note text.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await hold.requestCommitted;
  await note.fill('Newer note draft must remain.');
  hold.release();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(note).toHaveValue('Newer note draft must remain.');
  await page.unroute('**/api/cases/SEW-1002/activities');

  hold = await holdCommittedResponse(page, '**/api/cases/SEW-1002/activities');
  const reply = page.getByLabel('Record a fictional outgoing reply. No message leaves this app.');
  await reply.fill('Submitted reply text.');
  await page.getByRole('button', { name: 'Record simulated reply' }).click();
  await hold.requestCommitted;
  await reply.fill('Newer reply draft must remain.');
  hold.release();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(reply).toHaveValue('Newer reply draft must remain.');
  await page.unroute('**/api/cases/SEW-1002/activities');

  const statusMatcher = '**/api/cases/SEW-1002/status';
  hold = await holdCommittedResponse(page, statusMatcher);
  await page.getByLabel('Move case to').selectOption('resolved');
  await page.getByLabel('Resolution outcome').fill('Submitted resolution outcome.');
  await page.getByRole('button', { name: 'Save status and history' }).click();
  await hold.requestCommitted;
  await page.getByLabel('Resolution outcome').fill('Newer outcome draft must remain.');
  hold.release();
  await expect(page.locator('.activity-list').getByText('Resolution outcome: Submitted resolution outcome.')).toBeVisible();
  await expect(page.locator('.status-section .save-feedback')).toHaveText('Saved.');
  await page.unroute(statusMatcher);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.case-drafts.v1'))['SEW-1002'])).toMatchObject({
    noteText: 'Newer note draft must remain.',
    replyText: 'Newer reply draft must remain.',
    resolutionOutcome: 'Newer outcome draft must remain.',
  });

  await page.reload();
  await expect(page.locator('.activity-list').getByText('Resolution outcome: Submitted resolution outcome.')).toBeVisible();
  await expect(note).toHaveValue('Newer note draft must remain.');
  await expect(reply).toHaveValue('Newer reply draft must remain.');
  const retainedOutcome = page.getByLabel('Unsaved resolution outcome draft');
  await expect(retainedOutcome).toHaveValue('Newer outcome draft must remain.');
  await retainedOutcome.fill('Edited retained outcome draft.');
  await page.reload();
  await expect(page.getByLabel('Unsaved resolution outcome draft')).toHaveValue('Edited retained outcome draft.');
});

test('separate tabs retain independent case drafts through reload', async ({ page, context }) => {
  await page.goto('/#SEW-1001');
  const second = await context.newPage();
  await second.goto('/#SEW-1002');
  await page.getByLabel('Visible to support operators only').fill('Draft belongs to SEW-1001.');
  await second.getByLabel('Visible to support operators only').fill('Draft belongs to SEW-1002.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.case-drafts.v1'))['SEW-1001']?.noteText))
    .toBe('Draft belongs to SEW-1001.');
  await expect.poll(() => second.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.case-drafts.v1'))['SEW-1002']?.noteText))
    .toBe('Draft belongs to SEW-1002.');
  await page.reload();
  await second.reload();
  await expect(page.getByLabel('Visible to support operators only')).toHaveValue('Draft belongs to SEW-1001.');
  await expect(second.getByLabel('Visible to support operators only')).toHaveValue('Draft belongs to SEW-1002.');
});

test('history timestamps are explicitly UTC and independent of browser timezone', async ({ browser }) => {
  const timestamps = [];
  for (const timezoneId of ['Europe/Prague', 'America/Los_Angeles']) {
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173/#SEW-1001');
    const time = page.locator('.activity-list time').first();
    await expect(time).toContainText('UTC');
    timestamps.push(await time.innerText());
    await context.close();
  }
  expect(timestamps[0]).toBe(timestamps[1]);
});

test('insufficient-information case can be escalated with an empty evidence list', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /SEW-1003/ }).click();
  await page.locator('#diagnostic-query').fill('req_missing_case_c_20261020');
  await page.getByRole('button', { name: 'Search diagnostics' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'No diagnostic records matched this exact ID' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Intermittent API failures with no request IDs' })).toBeVisible();
  await page.getByLabel('Move case to').selectOption('escalated');
  await page.getByLabel('Escalation reason').fill('The report does not identify an affected request.');
  await page.getByLabel('Current findings').fill('No request ID, exact time, or matching technical evidence is available.');
  await page.getByLabel('Outstanding questions').fill('Which request IDs and UTC time window are affected?');
  await expect(page.getByText('No evidence is linked. This escalation will record an empty list.')).toBeVisible();
  await page.getByRole('button', { name: 'Save status and history' }).click();

  await expect(page.getByText('Status changed from Open to Escalated.')).toBeVisible();
  await expect(page.getByText('Escalation reason: The report does not identify an affected request.')).toBeVisible();
  await expect(page.getByText('Findings: No request ID, exact time, or matching technical evidence is available.')).toBeVisible();
  await expect(page.getByText('Outstanding questions: Which request IDs and UTC time window are affected?')).toBeVisible();
  await expect(page.getByText('Diagnostic evidence: None linked.')).toBeVisible();
});

test('an uncertain resolution remains confirmable after reload on a resolved case', async ({ page }) => {
  await page.goto('/#SEW-1003');
  if (!(await page.locator('.case-detail .status-escalated').count())) {
    await page.getByLabel('Move case to').selectOption('escalated');
    await page.getByLabel('Escalation reason').fill('Engineering must investigate a reproducible upstream issue.');
    await page.getByLabel('Current findings').fill('The issue persists without request identifiers or linked diagnostics.');
    await page.getByLabel('Outstanding questions').fill('Can engineering identify the affected request path?');
    await page.getByRole('button', { name: 'Save status and history' }).click();
    await expect(page.locator('.case-detail .status-escalated')).toBeVisible();
  }
  await expect(page.locator('.case-detail .status-escalated')).toBeVisible();
  await page.route('**/api/cases/SEW-1003/status', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort();
  });
  await page.getByLabel('Move case to').selectOption('resolved');
  await page.getByLabel('Resolution outcome').fill('Engineering confirmed the reported issue is resolved.');
  await page.getByRole('button', { name: 'Save status and history' }).click();
  await expect(page.getByRole('alert').getByText(/connection ended before the save was confirmed/)).toBeVisible();

  await page.unroute('**/api/cases/SEW-1003/status');
  await page.reload();
  await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
  const resolutionEvent = page.locator('.activity-status_changed').filter({ hasText: 'Status changed from Escalated to Resolved.' });
  await expect(resolutionEvent.getByText('Resolution outcome: Engineering confirmed the reported issue is resolved.')).toBeVisible();
  await expect(page.getByText('Submitted resolution outcome: Engineering confirmed the reported issue is resolved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry exact save' })).toBeVisible();
  await expect(page.getByLabel('Unsaved resolution outcome draft')).toHaveCount(0);

  await page.getByRole('button', { name: 'Retry exact save' }).click();
  await expect(page.getByText('Save confirmed from the existing receipt.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry exact save' })).toHaveCount(0);
  await expect(page.getByLabel('Unsaved resolution outcome draft')).toHaveCount(0);
  const { case: saved } = await (await page.request.get('/api/cases/SEW-1003')).json();
  expect(saved.status).toBe('resolved');
  expect(saved.version).toBe(3);
  expect(saved.activities.filter((activity) => activity.type === 'status_changed' && activity.payload.to === 'resolved')).toHaveLength(1);
  expect(saved.activities.find((activity) => activity.type === 'status_changed' && activity.payload.to === 'resolved').payload.outcome)
    .toBe('Engineering confirmed the reported issue is resolved.');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.pending-actions.v1') || '{}')['SEW-1003:status']))
    .toBeUndefined();
});

test('a conflict that reveals a resolved case keeps an escalation draft available after reload', async ({ browser }) => {
  const directory = mkdtempSync(join(tmpdir(), 'supportops-conflict-'));
  const db = openDatabase(join(directory, 'supportops.sqlite'));
  initializeDatabase(db);
  const server = createApp({ db }).listen(0, '127.0.0.1');
  let context;
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl + '/#SEW-1003');
    await page.getByLabel('Move case to').selectOption('escalated');
    await page.getByLabel('Escalation reason').fill('Escalation draft from the first operator.');
    await page.getByLabel('Current findings').fill('The report still has no request ID or occurrence time.');
    await page.getByLabel('Outstanding questions').fill('Which request path and time window are affected?');

    const otherOperator = await context.newPage();
    await otherOperator.goto(baseUrl + '/#SEW-1003');
    await otherOperator.getByLabel('Move case to').selectOption('escalated');
    await otherOperator.getByLabel('Escalation reason').fill('The second operator escalated for engineering review.');
    await otherOperator.getByLabel('Current findings').fill('No matching diagnostics are available.');
    await otherOperator.getByLabel('Outstanding questions').fill('Can engineering identify the affected request path?');
    await otherOperator.getByRole('button', { name: 'Save status and history' }).click();
    await expect(otherOperator.locator('.case-detail .status-escalated')).toBeVisible();
    await otherOperator.getByLabel('Move case to').selectOption('resolved');
    await otherOperator.getByLabel('Resolution outcome').fill('The second operator completed the case investigation.');
    await otherOperator.getByRole('button', { name: 'Save status and history' }).click();
    await expect(otherOperator.locator('.case-detail .status-resolved')).toBeVisible();

    await page.getByRole('button', { name: 'Save status and history' }).click();
    await expect(page.getByRole('button', { name: 'Reload case and review draft' })).toBeVisible();
    await page.getByRole('button', { name: 'Reload case and review draft' }).click();
    await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
    await expect(page.getByLabel('Unsaved escalation reason')).toHaveValue('Escalation draft from the first operator.');
    await expect(page.getByLabel('Unsaved escalation findings')).toHaveValue('The report still has no request ID or occurrence time.');
    await expect(page.getByLabel('Unsaved outstanding questions')).toHaveValue('Which request path and time window are affected?');
    await expect(page.getByText('This escalation draft was not applied. The resolved case cannot accept another status change; review or copy the draft below.')).toBeVisible();

    await page.reload();
    await expect(page.locator('.case-detail .status-resolved')).toBeVisible();
    await expect(page.getByLabel('Unsaved escalation reason')).toHaveValue('Escalation draft from the first operator.');
    await expect(page.getByLabel('Unsaved escalation findings')).toHaveValue('The report still has no request ID or occurrence time.');
    await expect(page.getByLabel('Unsaved outstanding questions')).toHaveValue('Which request path and time window are affected?');
    await otherOperator.close();
  } finally {
    await context?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('conflict reconciliation preserves another case uncertain request and retry key across reload', async ({ browser }) => {
  const directory = mkdtempSync(join(tmpdir(), 'supportops-pending-'));
  const db = openDatabase(join(directory, 'supportops.sqlite'));
  initializeDatabase(db);
  const server = createApp({ db }).listen(0, '127.0.0.1');
  let context;
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl + '/#SEW-1001');
    await expect(page.getByRole('heading', { name: 'Nightly API sync returns 401 responses' })).toBeVisible();

    const externalUpdate = await page.evaluate(async () => {
      const { case: current } = await (await fetch('/api/cases/SEW-1001')).json();
      const response = await fetch('/api/cases/SEW-1001/activities', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'other-operator-update' },
        body: JSON.stringify({ type: 'internal_note', text: 'Another operator updated case A.', expectedVersion: current.version }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(externalUpdate.status).toBe(200);

    await page.getByLabel('Visible to support operators only').fill('Draft retained after case A conflict.');
    await page.getByRole('button', { name: 'Add internal note' }).click();
    await expect(page.getByRole('button', { name: 'Reload case and review draft' })).toBeVisible();

    const reconciliation = await holdCommittedResponse(
      page,
      (url) => url.pathname === '/api/cases/SEW-1001',
    );
    await page.getByRole('button', { name: 'Reload case and review draft' }).click();
    await reconciliation.requestCommitted;

    await page.getByRole('button', { name: /SEW-1002/ }).click();
    await expect(page.getByRole('heading', { name: 'Subscription updates are not appearing' })).toBeVisible();
    let uncertainRequestCommitted;
    const requestCommitted = new Promise((resolve) => { uncertainRequestCommitted = resolve; });
    await page.route('**/api/cases/SEW-1002/activities', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      uncertainRequestCommitted();
      await route.abort();
    });
    const noteText = 'Case B committed while case A reconciliation was pending.';
    await page.getByLabel('Visible to support operators only').fill(noteText);
    await page.getByRole('button', { name: 'Add internal note' }).click();
    await requestCommitted;
    await expect(page.getByRole('alert').getByText(/connection ended before the save was confirmed/)).toBeVisible();
    const slot = 'SEW-1002:activity:note';
    const originalPending = await page.evaluate((pendingSlot) =>
      JSON.parse(sessionStorage.getItem('supportops.pending-actions.v1') || '{}')[pendingSlot], slot);
    expect(originalPending).toMatchObject({
      caseId: 'SEW-1002',
      method: 'POST',
      state: 'uncertain',
      payload: { type: 'internal_note', text: noteText },
    });

    reconciliation.release();
    await reconciliation.responseFulfilled;
    await expect(page.getByRole('button', { name: 'Retry exact save' })).toBeVisible();
    await expect.poll(() => page.evaluate((pendingSlot) =>
      JSON.parse(sessionStorage.getItem('supportops.pending-actions.v1') || '{}')[pendingSlot], slot))
      .toEqual(originalPending);

    await page.unroute('**/api/cases/SEW-1002/activities');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Subscription updates are not appearing' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry exact save' })).toBeVisible();
    const restoredPending = await page.evaluate((pendingSlot) =>
      JSON.parse(sessionStorage.getItem('supportops.pending-actions.v1') || '{}')[pendingSlot], slot);
    expect(restoredPending).toEqual(originalPending);

    let retriedRequest;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/cases/SEW-1002/activities')) {
        retriedRequest = { key: request.headers()['idempotency-key'], payload: request.postDataJSON() };
      }
    });
    await page.getByRole('button', { name: 'Retry exact save' }).click();
    await expect(page.getByText('Save confirmed from the existing receipt.', { exact: true })).toBeVisible();
    expect(retriedRequest).toEqual({ key: originalPending.key, payload: originalPending.payload });
    const { case: saved } = await (await fetch(baseUrl + '/api/cases/SEW-1002')).json();
    expect(saved.activities.filter((activity) => activity.payload.text === noteText)).toHaveLength(1);
  } finally {
    await context?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
      body: JSON.stringify({ type: 'internal_note', text: 'Saved from another tab.', expectedVersion }),
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
