import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 20): Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3_000 });
  // Sem este handler, a queda de uma conexão ociosa derrubaria o processo.
  pool.on('error', (err) => console.error('Erro em conexão ociosa do PostgreSQL:', err.message));
  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');
    // Limites curtos: ninguém fica esperando indefinidamente em uma sala disputada.
    await client.query(
      `SELECT set_config('lock_timeout', '2s', true), set_config('statement_timeout', '5s', true)`,
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      connectionBroken = true;
    }
    throw err;
  } finally {
    client.release(connectionBroken);
  }
}

export function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export async function migrate(pool: Pool): Promise<void> {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  for (const name of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (done.rowCount) continue;
    const sql = await readFile(new URL(name, dir), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
