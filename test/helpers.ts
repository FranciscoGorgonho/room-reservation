import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../src/db.js';

export const TEST_PORT = 54331;
export const TEST_URL = `postgres://reservas:reservas@localhost:${TEST_PORT}/reservas`;

export const ROOM = 1;
export const OTHER_ROOM = 2;

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE outbox, reservations, users, rooms RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO rooms (id, name, city, capacity)
     SELECT n, 'Sala ' || n, 'São Paulo', 6 FROM generate_series(1, 3) AS n`,
  );
  await pool.query(
    `INSERT INTO users (id, name, email)
     SELECT n, 'Pessoa ' || n, 'p' || n || '@exemplo.test' FROM generate_series(1, 300) AS n`,
  );
}

/** Horário sempre no futuro: o dia depois de amanhã, às `hours`:`minutes` UTC. */
export function at(hours: number, minutes = 0): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 2);
  base.setUTCHours(hours, minutes, 0, 0);
  return base.toISOString();
}

export function reserve(
  app: FastifyInstance,
  opts: { user: number; start: string; end: string; room?: number; key?: string },
) {
  return app.inject({
    method: 'POST',
    url: '/api/reservations',
    headers: { 'x-user-id': String(opts.user), 'idempotency-key': opts.key ?? randomUUID() },
    payload: { roomId: opts.room ?? ROOM, start: opts.start, end: opts.end },
  });
}

export function cancel(app: FastifyInstance, user: number, id: string) {
  return app.inject({
    method: 'POST',
    url: `/api/reservations/${id}/cancel`,
    headers: { 'x-user-id': String(user) },
  });
}

/** Conta pares de reservas confirmadas que se sobrepõem. Precisa ser sempre 0. */
export async function overlappingPairs(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM reservations a
       JOIN reservations b
         ON a.room_id = b.room_id AND a.id < b.id AND a.period && b.period
      WHERE a.status = 'confirmed' AND b.status = 'confirmed'`,
  );
  return rows[0]!.count;
}

export async function countRows(pool: Pool, table: 'reservations' | 'outbox'): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return rows[0]!.count;
}
