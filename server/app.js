import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCases } from './database.js';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const defaultBuildDirectory = resolve(serverDirectory, '../dist');
const localHostnames = new Set(['127.0.0.1', 'localhost']);

export function createApp({ db, buildDirectory = defaultBuildDirectory }) {
  if (!db) throw new TypeError('A database connection is required.');
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!localHostnames.has(req.hostname)) {
      return res.status(400).json({ error: 'invalid_host' });
    }
    next();
  });

  app.get('/api/config', (_req, res) => {
    res.json({ name: 'Support Engineering Workbench', dataMode: 'synthetic' });
  });

  app.get('/api/cases', (_req, res) => {
    try {
      res.json({ cases: listCases(db) });
    } catch {
      res.status(500).json({ error: 'case_list_unavailable' });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  if (existsSync(buildDirectory)) {
    app.use(express.static(buildDirectory, { dotfiles: 'deny' }));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
