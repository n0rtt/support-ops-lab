import { expect, test } from '@playwright/test';

async function holdCommittedResponse(page, matcher) {
  let release;
  let committed;
  const responseHeld = new Promise((resolve) => { release = resolve; });
  const requestCommitted = new Promise((resolve) => { committed = resolve; });
  await page.route(matcher, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await responseHeld;
    await route.fulfill({ response });
  });
  return { requestCommitted, release };
}

test('manual resolution preserves history, simulated labeling, selection, and case draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('M2 manual workflow · no AI credentials needed')).toBeVisible();
  await expect(page.getByRole('button', { name: /SEW-1001/ }).getByText('High priority', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /SEW-1002/ }).getByText('Medium priority', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /SEW-1003/ }).getByText('Low priority', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: /SEW-1002/ })).toHaveAttribute('aria-pressed', 'true');
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
  await expect(page.getByText('Resolution outcome: Submitted resolution outcome.')).toBeVisible();
  await page.unroute(statusMatcher);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.case-drafts.v1'))['SEW-1002'])).toMatchObject({
    noteText: 'Newer note draft must remain.',
    replyText: 'Newer reply draft must remain.',
    resolutionOutcome: 'Newer outcome draft must remain.',
  });

  await page.reload();
  await expect(page.getByText('Resolution outcome: Submitted resolution outcome.')).toBeVisible();
  await expect(note).toHaveValue('Newer note draft must remain.');
  await expect(reply).toHaveValue('Newer reply draft must remain.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('supportops.case-drafts.v1'))['SEW-1002'].resolutionOutcome))
    .toBe('Newer outcome draft must remain.');
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
