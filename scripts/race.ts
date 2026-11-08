/**
 * Dispara confirmações simultâneas por HTTP de verdade contra um servidor em execução.
 * Uso: npm run race -- [pessoas] [salaId]   (com `npm run dev` rodando em outro terminal)
 */
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const people = Number(process.argv[2] ?? 200);
const roomId = Number(process.argv[3] ?? 7);

// Horário diferente a cada execução, longe da agenda semeada, para sempre haver disputa nova.
const start = new Date(Date.now() + 60 * 86_400_000 + Math.floor(Math.random() * 1e6) * 60_000);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 3_600_000);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const began = performance.now();
const results = await Promise.all(
  Array.from({ length: people }, async (_, i) => {
    const t0 = performance.now();
    const response = await fetch(`${base}/api/reservations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': String(i + 1),
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ roomId, start: start.toISOString(), end: end.toISOString() }),
    });
    await response.arrayBuffer();
    return { status: response.status, ms: performance.now() - t0 };
  }),
);
const totalMs = performance.now() - began;

const byStatus = new Map<number, number>();
for (const { status } of results) byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);

console.log(`${people} pessoas disputando a sala ${roomId}, ${start.toISOString()}`);
console.log(`  201 confirmada:  ${byStatus.get(201) ?? 0}`);
console.log(`  409 recusada:    ${byStatus.get(409) ?? 0}`);
console.log(`  outros:          ${people - (byStatus.get(201) ?? 0) - (byStatus.get(409) ?? 0)}`);
console.log(`  tempo total:     ${totalMs.toFixed(0)} ms`);
console.log(`  latência p50:    ${percentile(latencies, 0.5).toFixed(0)} ms`);
console.log(`  latência p99:    ${percentile(latencies, 0.99).toFixed(0)} ms`);

// Leitura: mede a agenda sob carga simples, variando salas para não medir só o cache.
const readCount = 2_000;
const readLatencies: number[] = [];
const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const readsBegan = performance.now();
await Promise.all(
  Array.from({ length: 50 }, async (_, worker) => {
    for (let i = 0; i < readCount / 50; i += 1) {
      const t0 = performance.now();
      const response = await fetch(
        `${base}/api/rooms/${1 + ((worker * 40 + i) % 2000)}/availability?date=${date}`,
      );
      await response.arrayBuffer();
      readLatencies.push(performance.now() - t0);
    }
  }),
);
const readsMs = performance.now() - readsBegan;
readLatencies.sort((a, b) => a - b);
console.log(`${readCount} consultas de agenda, 50 clientes simultâneos`);
console.log(`  vazão:           ${((readCount / readsMs) * 1000).toFixed(0)} req/s`);
console.log(`  latência p50:    ${percentile(readLatencies, 0.5).toFixed(1)} ms`);
console.log(`  latência p99:    ${percentile(readLatencies, 0.99).toFixed(1)} ms`);
