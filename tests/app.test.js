import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase } from '../server/database.js';
import { temporaryDatabase } from './helpers.js';

test('the local API serves seeded cases and keeps later write routes out of M1', async (t) => {
  const { databasePath } = temporaryDatabase(t);
  const db = openDatabase(databasePath);
  initializeDatabase(db);
  const server = createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
  });
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;

  const configResponse = await fetch(baseUrl + '/api/config');
  assert.equal(configResponse.status, 200);
  assert.deepEqual(await configResponse.json(), {
    name: 'Support Engineering Workbench',
    dataMode: 'synthetic',
  });

  const casesResponse = await fetch(baseUrl + '/api/cases');
  assert.equal(casesResponse.status, 200);
  const { cases } = await casesResponse.json();
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map((item) => item.channel).sort(), ['email', 'manual', 'telegram']);
  assert.ok(cases.every((item) => item.id.startsWith('SEW-') && item.initialReport));

  const diagnosticsResponse = await fetch(baseUrl + '/api/diagnostics');
  const mutationResponse = await fetch(baseUrl + '/api/cases/SEW-1001/status', { method: 'PATCH' });
  const invalidHostResponse = await new Promise((resolve, reject) => {
    const hostRequest = request(
      { hostname: '127.0.0.1', port: address.port, path: '/api/config', headers: { host: 'example.test' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response));
      },
    );
    hostRequest.on('error', reject);
    hostRequest.end();
  });
  assert.equal(diagnosticsResponse.status, 404);
  assert.equal(mutationResponse.status, 404);
  assert.equal(invalidHostResponse.statusCode, 400);
});
