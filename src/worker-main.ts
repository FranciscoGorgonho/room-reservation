import { createPool } from './db.js';
import { FakeEmailSender } from './email.js';
import { startOutboxWorker } from './outbox.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL.');

// Processo separado da API: nada que aconteça aqui afeta quem está reservando.
// Troque FakeEmailSender por uma implementação de EmailSender do provedor real.
const pool = createPool(url, 5);
const stop = startOutboxWorker(pool, new FakeEmailSender());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await stop();
    await pool.end();
    process.exit(0);
  });
}
