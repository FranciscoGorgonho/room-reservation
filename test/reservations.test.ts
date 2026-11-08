import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AvailabilityReader } from '../src/availability.js';
import { createPool, pgErrorCode, type Pool } from '../src/db.js';
import { FakeEmailSender } from '../src/email.js';
import { processOutboxBatch } from '../src/outbox.js';
import {
  at,
  cancel,
  countRows,
  OTHER_ROOM,
  overlappingPairs,
  reserve,
  resetDb,
  ROOM,
  TEST_URL,
} from './helpers.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(TEST_URL, 20);
  app = await buildApp({ pool, availability: new AvailabilityReader(pool, 60_000) });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(() => resetDb(pool));

const sequence = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('tentativas simultâneas', () => {
  it('200 pessoas no mesmo horário: exatamente uma confirma', async () => {
    const responses = await Promise.all(
      sequence(200).map((user) => reserve(app, { user, start: at(10), end: at(11) })),
    );

    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(199);
    expect(await countRows(pool, 'reservations')).toBe(1);
    expect(await countRows(pool, 'outbox')).toBe(1);
    expect(responses.find((r) => r.statusCode === 409)!.json().error.outcome).toBe('not_reserved');
  });

  it('intervalos parcialmente sobrepostos nunca coexistem', async () => {
    await Promise.all(
      sequence(120).map((user) => {
        const offset = user % 12;
        return reserve(app, { user, start: at(9, offset * 5), end: at(10, offset * 5) });
      }),
    );

    expect(await countRows(pool, 'reservations')).toBeGreaterThan(0);
    expect(await overlappingPairs(pool)).toBe(0);
  });

  it('sem a trava da aplicação, o próprio banco ainda impede a sobreposição', async () => {
    // Poucas inserções de propósito: sem a trava, cada deadlock custa ~1s e prende conexões.
    const results = await Promise.allSettled(
      sequence(8).map((user) =>
        pool.query(
          `INSERT INTO reservations (room_id, user_id, period, idempotency_key)
           VALUES ($1, $2, tstzrange($3, $4, '[)'), $5)`,
          [ROOM, user, at(10), at(11), randomUUID()],
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(['23P01', '40P01']).toContain(pgErrorCode(r.reason));
    }
    expect(await overlappingPairs(pool)).toBe(0);
  });

  it('salas diferentes não disputam entre si', async () => {
    const [a, b] = await Promise.all([
      reserve(app, { user: 1, room: ROOM, start: at(10), end: at(11) }),
      reserve(app, { user: 2, room: OTHER_ROOM, start: at(10), end: at(11) }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
  });

  it('horários encostados são permitidos', async () => {
    const first = await reserve(app, { user: 1, start: at(10), end: at(11) });
    const second = await reserve(app, { user: 2, start: at(11), end: at(12) });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
  });
});

describe('sem dúvida sobre o resultado', () => {
  it('repetir a mesma chave devolve a mesma reserva e um único e-mail', async () => {
    const key = randomUUID();
    const first = await reserve(app, { user: 1, key, start: at(10), end: at(11) });
    const retry = await reserve(app, { user: 1, key, start: at(10), end: at(11) });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().reservation.id).toBe(first.json().reservation.id);
    expect(retry.json().replayed).toBe(true);
    expect(await countRows(pool, 'outbox')).toBe(1);
  });

  it('a mesma chave em paralelo produz uma reserva, e todos recebem sucesso', async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      sequence(30).map(() => reserve(app, { user: 1, key, start: at(10), end: at(11) })),
    );

    expect(new Set(responses.map((r) => r.json().reservation.id)).size).toBe(1);
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(29);
    expect(await countRows(pool, 'reservations')).toBe(1);
  });

  it('a mesma chave em salas diferentes, em paralelo, cria uma reserva só', async () => {
    const key = randomUUID();
    const responses = await Promise.all([
      reserve(app, { user: 1, key, room: ROOM, start: at(10), end: at(11) }),
      reserve(app, { user: 1, key, room: OTHER_ROOM, start: at(10), end: at(11) }),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    expect(await countRows(pool, 'reservations')).toBe(1);
  });

  it('chave reaproveitada para outro horário é recusada', async () => {
    const key = randomUUID();
    await reserve(app, { user: 1, key, start: at(10), end: at(11) });
    const reused = await reserve(app, { user: 1, key, start: at(14), end: at(15) });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('falha do banco responde "desconhecido", nunca "não reservou"', async () => {
    const brokenPool = {
      connect: async () => {
        throw new Error('conexão perdida');
      },
    } as unknown as Pool;
    const brokenApp = await buildApp({
      pool: brokenPool,
      availability: new AvailabilityReader(brokenPool),
    });
    const response = await reserve(brokenApp, { user: 1, start: at(10), end: at(11) });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.outcome).toBe('unknown');
    await brokenApp.close();
  });

  it('horário que já passou é recusado no momento da confirmação', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() - 1_800_000).toISOString();
    const response = await reserve(app, { user: 1, start: past, end });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('START_IN_PAST');
  });

  it.each([
    ['fim antes do início', at(11), at(10)],
    ['mais de 8 horas', at(1), at(10)],
    ['data inválida', 'amanhã', at(10)],
  ])('entrada inválida é recusada: %s', async (_name, start, end) => {
    const response = await reserve(app, { user: 1, start, end });
    expect(response.statusCode).toBe(400);
    expect(await countRows(pool, 'reservations')).toBe(0);
  });

  it('pessoa inexistente não reserva', async () => {
    const response = await reserve(app, { user: 99_999, start: at(10), end: at(11) });
    expect(response.statusCode).toBe(401);
  });
});

describe('cancelamento', () => {
  it('libera o horário imediatamente', async () => {
    const made = await reserve(app, { user: 1, start: at(10), end: at(11) });
    await cancel(app, 1, made.json().reservation.id);
    const next = await reserve(app, { user: 2, start: at(10), end: at(11) });
    expect(next.statusCode).toBe(201);
  });

  it('cancelamentos simultâneos geram um único aviso', async () => {
    const made = await reserve(app, { user: 1, start: at(10), end: at(11) });
    const id = made.json().reservation.id;
    const responses = await Promise.all(sequence(20).map(() => cancel(app, 1, id)));

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const { rows } = await pool.query(
      `SELECT 1 FROM outbox WHERE type = 'reservation.cancelled'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('só quem reservou pode cancelar', async () => {
    const made = await reserve(app, { user: 1, start: at(10), end: at(11) });
    const response = await cancel(app, 2, made.json().reservation.id);
    expect(response.statusCode).toBe(404);
  });

  it('reserva já iniciada não pode ser cancelada', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO reservations (room_id, user_id, period, idempotency_key)
       VALUES ($1, 1, tstzrange(now() - interval '10 minutes', now() + interval '1 hour', '[)'), 'k-iniciada')
       RETURNING id`,
      [ROOM],
    );
    const response = await cancel(app, 1, rows[0]!.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ALREADY_STARTED');
  });

  it('corrida entre cancelar e reservar o horário não produz sobreposição', async () => {
    const made = await reserve(app, { user: 1, start: at(10), end: at(11) });
    await Promise.all([
      cancel(app, 1, made.json().reservation.id),
      ...sequence(20).map((n) => reserve(app, { user: n + 1, start: at(10), end: at(11) })),
    ]);
    expect(await overlappingPairs(pool)).toBe(0);
  });
});

describe('consulta com atraso', () => {
  const dateOf = (iso: string) => iso.slice(0, 10);

  async function slotAt(start: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/availability?date=${dateOf(start)}`,
    });
    expect(response.statusCode).toBe(200);
    const slots: { start: string; available: boolean }[] = response.json().slots;
    return slots.find((s) => s.start === start)!;
  }

  it('consulta defasada mostra livre, mas a confirmação valida e recusa', async () => {
    const start = at(15);
    const end = at(16);

    expect((await slotAt(start)).available).toBe(true);
    const winner = await reserve(app, { user: 1, start, end });
    expect(winner.statusCode).toBe(201);

    expect((await slotAt(start)).available).toBe(true); // ainda dentro do TTL
    const late = await reserve(app, { user: 2, start, end });
    expect(late.statusCode).toBe(409);
  });

  it('depois do TTL, a consulta reflete a reserva', async () => {
    const shortTtl = await buildApp({ pool, availability: new AvailabilityReader(pool, 30) });
    const start = at(15);
    await shortTtl.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/availability?date=${dateOf(start)}`,
    });
    await reserve(shortTtl, { user: 1, start, end: at(16) });
    await new Promise((r) => setTimeout(r, 60));

    const response = await shortTtl.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/availability?date=${dateOf(start)}`,
    });
    const slot = response.json().slots.find((s: { start: string }) => s.start === start);
    expect(slot.available).toBe(false);
    await shortTtl.close();
  });

  it('muitas consultas simultâneas viram uma única ida ao banco', async () => {
    let queries = 0;
    const counting = {
      query: (...args: Parameters<Pool['query']>) => {
        queries += 1;
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Pool;
    const reader = new AvailabilityReader(counting, 60_000);
    await Promise.all(sequence(500).map(() => reader.get(ROOM, dateOf(at(10)))));
    expect(queries).toBe(1);
  });
});

describe('avisos por e-mail', () => {
  const instant = { baseRetryMs: 0 };

  it('e-mail fora do ar não impede reservar, e os avisos saem quando volta', async () => {
    const sender = new FakeEmailSender();
    sender.down = true;

    const made = await Promise.all(
      [8, 9, 10, 11, 12].map((h, i) =>
        reserve(app, { user: i + 1, start: at(h), end: at(h + 1) }),
      ),
    );
    expect(made.every((r) => r.statusCode === 201)).toBe(true);

    await processOutboxBatch(pool, sender, instant);
    expect(sender.sent).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT 1 FROM outbox WHERE status = 'pending' AND last_error IS NOT NULL`,
    );
    expect(rows).toHaveLength(5);

    sender.down = false;
    await processOutboxBatch(pool, sender, instant);
    expect(sender.sent).toHaveLength(5);
    expect(new Set(sender.sent.map((m) => m.dedupeId)).size).toBe(5);
    expect(await processOutboxBatch(pool, sender, instant)).toBe(0);
  });

  it('reserva que falha não gera aviso', async () => {
    await reserve(app, { user: 1, start: at(10), end: at(11) });
    await reserve(app, { user: 2, start: at(10), end: at(11) });
    expect(await countRows(pool, 'outbox')).toBe(1);
  });

  it('vários workers em paralelo não entregam em duplicidade', async () => {
    await Promise.all(
      sequence(10).map((n) => reserve(app, { user: n, start: at(n), end: at(n, 30) })),
    );
    const sender = new FakeEmailSender();
    await Promise.all(
      sequence(5).map(() => processOutboxBatch(pool, sender, { batchSize: 4 })),
    );
    while (await processOutboxBatch(pool, sender)) {
      // esvazia o que sobrou
    }
    expect(sender.sent).toHaveLength(10);
    expect(new Set(sender.sent.map((m) => m.dedupeId)).size).toBe(10);
  });

  it('evento de worker que morreu volta a ficar disponível depois da concessão', async () => {
    await reserve(app, { user: 1, start: at(10), end: at(11) });
    const sender = new FakeEmailSender();
    await pool.query(
      `UPDATE outbox SET attempts = 1, next_attempt_at = now() + interval '60 seconds'`,
    );
    expect(await processOutboxBatch(pool, sender)).toBe(0);

    await pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second'`);
    expect(await processOutboxBatch(pool, sender)).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  it('desiste depois do limite de tentativas, sem afetar a reserva', async () => {
    await reserve(app, { user: 1, start: at(10), end: at(11) });
    const sender = new FakeEmailSender();
    sender.down = true;
    await processOutboxBatch(pool, sender, { ...instant, maxAttempts: 1 });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM outbox');
    expect(rows[0]!.status).toBe('dead');
    const reservation = await pool.query<{ status: string }>('SELECT status FROM reservations');
    expect(reservation.rows[0]!.status).toBe('confirmed');
  });
});
