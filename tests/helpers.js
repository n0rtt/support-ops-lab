import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'supportops-m1-'));
  const databasePath = join(directory, 'supportops.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, databasePath };
}
