import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AvailabilityReader, searchRooms } from './availability.js';
import type { Pool } from './db.js';
import type { FakeEmailSender } from './email.js';
import { AppError } from './errors.js';
import { cancelReservation, confirmReservation, listUserReservations } from './reservations.js';

export interface AppDeps {
  pool: Pool;
  availability: AvailabilityReader;
  /** Presente só em desenvolvimento: habilita o painel de demonstração. */
  devEmail?: FakeEmailSender;
}

const MAX_DURATION_MS = 8 * 60 * 60 * 1000;

const confirmBody = z
  .object({
    roomId: z.number().int().positive(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .refine((b) => new Date(b.start) < new Date(b.end), {
    message: 'O início deve ser anterior ao fim.',
  })
  .refine((b) => new Date(b.end).getTime() - new Date(b.start).getTime() <= MAX_DURATION_MS, {
    message: 'A reserva pode durar no máximo 8 horas.',
  });

const idParam = z.object({ id: z.coerce.number().int().positive() });
const availabilityQuery = z.object({ date: z.iso.date() });
const roomsQuery = z.object({ q: z.string().trim().max(80).default('') });
const reservationParam = z.object({ id: z.uuid() });
const idempotencyKey = z.string().min(8).max(128);
const userHeader = z.coerce.number().int().positive();

function currentUser(req: FastifyRequest): number {
  // Identidade simplificada para a demonstração. Ver "Limitações" no README.
  const parsed = userHeader.safeParse(req.headers['x-user-id']);
  if (!parsed.success) throw new AppError(401, 'UNAUTHENTICATED', 'Informe o cabeçalho X-User-Id.');
  return parsed.data;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool, availability, devEmail } = deps;
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({
        error: { code: err.code, message: err.message, outcome: err.outcome },
      });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: err.issues[0]?.message ?? 'Requisição inválida.',
          outcome: 'not_reserved',
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({
        error: { code: 'BAD_REQUEST', message: 'Requisição inválida.', outcome: 'not_reserved' },
      });
    }
    // Falha inesperada pode ter acontecido depois do COMMIT: nunca afirmar que não reservou.
    console.error(err);
    return reply.status(503).send({
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'Não foi possível concluir agora. Repita com a mesma Idempotency-Key.',
        outcome: 'unknown',
      },
    });
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public/', import.meta.url)),
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.get('/api/rooms', async (req) => {
    const { q } = roomsQuery.parse(req.query);
    return { rooms: await searchRooms(pool, q) };
  });

  app.get('/api/rooms/:id/availability', async (req) => {
    const { id } = idParam.parse(req.params);
    const { date } = availabilityQuery.parse(req.query);
    return availability.get(id, date);
  });

  app.post('/api/reservations', async (req, reply) => {
    const userId = currentUser(req);
    const body = confirmBody.parse(req.body);
    const key = idempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!key.success) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Informe o cabeçalho Idempotency-Key.');
    }
    const result = await confirmReservation(pool, {
      userId,
      roomId: body.roomId,
      start: new Date(body.start),
      end: new Date(body.end),
      idempotencyKey: key.data,
    });
    return reply.status(result.replayed ? 200 : 201).send({
      reservation: result.reservation,
      replayed: result.replayed,
    });
  });

  app.post('/api/reservations/:id/cancel', async (req) => {
    const userId = currentUser(req);
    const { id } = reservationParam.parse(req.params);
    return { reservation: await cancelReservation(pool, userId, id) };
  });

  app.get('/api/me/reservations', async (req) => {
    return { reservations: await listUserReservations(pool, currentUser(req)) };
  });

  if (devEmail) {
    app.get('/api/dev/status', async () => {
      const { rows } = await pool.query<{ status: string; count: number }>(
        'SELECT status, count(*)::int AS count FROM outbox GROUP BY status',
      );
      const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
      return {
        emailDown: devEmail.down,
        pending: counts.pending ?? 0,
        sent: counts.sent ?? 0,
        dead: counts.dead ?? 0,
        recent: devEmail.sent.slice(0, 5),
      };
    });

    app.post('/api/dev/email', async (req) => {
      devEmail.down = z.object({ down: z.boolean() }).parse(req.body).down;
      return { emailDown: devEmail.down };
    });
  }

  return app;
}
