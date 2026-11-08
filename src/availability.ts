import type { Pool } from './db.js';
import { AppError } from './errors.js';

export interface Availability {
  roomId: number;
  date: string;
  timezone: string;
  asOf: string;
  maxStalenessSeconds: number;
  slots: { start: string; end: string; available: boolean }[];
}

interface Entry {
  value: Promise<Availability>;
  expiresAt: number;
}

/**
 * Cache em memória por sala e dia, sem invalidação: o atraso máximo é o próprio TTL,
 * em qualquer número de instâncias. Requisições simultâneas pelo mesmo dado
 * compartilham uma única consulta ao banco.
 */
export class AvailabilityReader {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 5_000,
    private readonly maxEntries = 20_000,
  ) {}

  get(roomId: number, date: string): Promise<Availability> {
    const key = `${roomId}:${date}`;
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    const value = this.load(roomId, date);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    // Erros não ficam em cache: a próxima consulta tenta de novo.
    value.catch(() => this.entries.delete(key));
    return value;
  }

  private async load(roomId: number, date: string): Promise<Availability> {
    const { rows } = await this.pool.query<{
      timezone: string;
      as_of: Date;
      slot_start: Date;
      slot_end: Date;
      available: boolean;
    }>(
      `WITH room AS (SELECT timezone FROM rooms WHERE id = $1),
       slots AS (
         SELECT local_start AT TIME ZONE room.timezone AS slot_start,
                (local_start + interval '30 minutes') AT TIME ZONE room.timezone AS slot_end
           FROM room,
                generate_series($2::date + time '08:00',
                                $2::date + time '19:30',
                                interval '30 minutes') AS local_start
       )
       SELECT room.timezone, clock_timestamp() AS as_of, s.slot_start, s.slot_end,
              NOT EXISTS (
                SELECT 1 FROM reservations r
                 WHERE r.room_id = $1
                   AND r.status = 'confirmed'
                   AND r.period && tstzrange(s.slot_start, s.slot_end, '[)')
              ) AS available
         FROM room, slots s
        ORDER BY s.slot_start`,
      [roomId, date],
    );
    const first = rows[0];
    if (!first) throw new AppError(404, 'ROOM_NOT_FOUND', 'Sala não encontrada.');
    return {
      roomId,
      date,
      timezone: first.timezone,
      asOf: first.as_of.toISOString(),
      maxStalenessSeconds: this.ttlMs / 1000,
      slots: rows.map((r) => ({
        start: r.slot_start.toISOString(),
        end: r.slot_end.toISOString(),
        available: r.available,
      })),
    };
  }
}

export async function searchRooms(pool: Pool, q: string) {
  const { rows } = await pool.query(
    `SELECT id, name, city, capacity, timezone FROM rooms
      WHERE name ILIKE '%' || $1 || '%' OR city ILIKE '%' || $1 || '%'
      ORDER BY city, name
      LIMIT 50`,
    [q.replace(/[\\%_]/g, '\\$&')],
  );
  return rows;
}
