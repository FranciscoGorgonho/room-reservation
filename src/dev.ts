import { buildApp } from './app.js';
import { AvailabilityReader } from './availability.js';
import { createPool, migrate } from './db.js';
import { FakeEmailSender } from './email.js';
import { startEmbeddedPostgres } from './embedded.js';
import { startOutboxWorker } from './outbox.js';
import { seed } from './seed.js';

// Tudo em um processo para a demonstração: banco embutido, API e worker.
const port = Number(process.env.PORT ?? 3000);
const database = await startEmbeddedPostgres({
  dir: '.data/postgres',
  port: Number(process.env.PG_PORT ?? 54320),
  persistent: true,
});
const pool = createPool(database.url);
await migrate(pool);
console.log('Preparando dados (a primeira execução leva alguns segundos)...');
await seed(pool);

const devEmail = new FakeEmailSender();
const stopWorker = startOutboxWorker(pool, devEmail);
const app = await buildApp({ pool, availability: new AvailabilityReader(pool), devEmail });
await app.listen({ port, host: '127.0.0.1' });
console.log(`Pronto: http://localhost:${port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await stopWorker();
  await pool.end();
  await database.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
