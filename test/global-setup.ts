import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, migrate } from '../src/db.js';
import { startEmbeddedPostgres } from '../src/embedded.js';
import { TEST_PORT } from './helpers.js';

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'room-reservation-test-'));
  const database = await startEmbeddedPostgres({ dir, port: TEST_PORT, persistent: true });
  const pool = createPool(database.url);
  await migrate(pool);
  await pool.end();
  return async () => {
    await database.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
