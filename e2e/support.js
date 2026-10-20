import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase } from '../server/database.js';

export async function withFreshApp(browser, run, appOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'supportops-browser-'));
  const db = openDatabase(join(directory, 'supportops.sqlite'));
  initializeDatabase(db);
  const server = createApp({ db, ...appOptions }).listen(0, '127.0.0.1');
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
