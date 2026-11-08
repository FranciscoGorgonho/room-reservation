import { buildApp } from './app.js';
import { AvailabilityReader } from './availability.js';
import { createPool, migrate } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL.');

const pool = createPool(url);
await migrate(pool);
const app = await buildApp({ pool, availability: new AvailabilityReader(pool) });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
