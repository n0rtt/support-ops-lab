import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createOpenAIAnalyzer } from './ai.js';
import { initializeDatabase, openDemoDatabase, recoverInterruptedAnalyses, recoverPendingAnalysisCompletions } from './database.js';

const serverDirectory = fileURLToPath(new URL('.', import.meta.url));
const buildDirectory = resolve(serverDirectory, '../dist');
if (!existsSync(resolve(buildDirectory, 'index.html'))) {
  console.error('build_required: run npm run build before npm start');
  process.exitCode = 1;
} else {
  const db = openDemoDatabase();
  try {
    initializeDatabase(db);
    recoverPendingAnalysisCompletions(db);
    recoverInterruptedAnalyses(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const app = createApp({ db, buildDirectory, analyze: createOpenAIAnalyzer() });
  const server = app.listen(3000, '127.0.0.1');
  server.on('listening', () => console.log('Support Engineering Workbench: http://127.0.0.1:3000'));
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? 'port_in_use: 3000' : 'server_start_failed');
    db.close();
    process.exitCode = 1;
  });

  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
