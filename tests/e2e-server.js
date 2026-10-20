import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase } from '../server/database.js';

const dataDirectory = mkdtempSync(join(tmpdir(), 'supportops-browser-'));
const db = openDatabase(join(dataDirectory, 'supportops.sqlite'));
initializeDatabase(db);
const server = createApp({ db }).listen(4173, '127.0.0.1');
let stopped = false;

function stop() {
  if (stopped) return;
  stopped = true;
  server.close(() => {
    db.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
}

server.once('listening', () => console.log('Browser test app ready on http://127.0.0.1:4173'));
server.once('error', () => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
  process.exitCode = 1;
});
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
