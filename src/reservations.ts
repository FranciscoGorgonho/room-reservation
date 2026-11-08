import { pgErrorCode, withTransaction, type Pool, type Tx } from './db.js';
import { AppError } from './errors.js';

export interface Reservation {
  id: string;
  roomId: number;
  userId: number;
  start: string;
  end: string;
  status: 'confirmed' | 'cancelled';
  createdAt: string;
  cancelledAt: string | null;
}

export interface ConfirmInput {
  userId: number;
  roomId: number;
  start: Date;
  end: Date;
  idempotencyKey: string;
}

const COLUMNS = `id, room_id, user_id, lower(period) AS start_at, upper(period) AS end_at,
                 status, created_at, cancelled_at`;

interface Row {
  id: string;
  room_id: number;
  user_id: number;
  start_at: Date;
  end_at: Date;
  status: Reservation['status'];
  created_at: Date;
  cancelled_at: Date | null;
}

function toReservation(row: Row): Reservation {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    start: row.start_at.toISOString(),
    end: row.end_at.toISOString(),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

async function findByKey(db: Pool | Tx, input: ConfirmInput): Promise<Row | undefined> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM reservations WHERE user_id = $1 AND idempotency_key = $2`,
    [input.userId, input.idempotencyKey],
  );
  return rows[0];
}

function replay(row: Row, input: ConfirmInput) {
  const same =
    row.room_id === input.roomId &&
    row.start_at.getTime() === input.start.getTime() &&
    row.end_at.getTime() === input.end.getTime();
  if (!same) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'Esta Idempotency-Key já foi usada para outra reserva.',
    );
  }
  return { reservation: toReservation(row), replayed: true };
}

async function enqueueEmail(tx: Tx, type: string, reservationId: string): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (type, payload)
     SELECT $1, jsonb_build_object(
              'reservationId', r.id,
              'userName', u.name,
              'userEmail', u.email,
              'roomName', m.name,
              'timezone', m.timezone,
              'start', lower(r.period),
              'end', upper(r.period))
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       JOIN rooms m ON m.id = r.room_id
      WHERE r.id = $2`,
    [type, reservationId],
  );
}

/**
 * Tudo acontece em uma transação: ou existem a reserva e o aviso, ou nenhum dos dois.
 * A resposta de sucesso só é enviada depois do COMMIT, então "confirmada" é sempre verdade.
 */
export async function confirmReservation(
  pool: Pool,
  input: ConfirmInput,
): Promise<{ reservation: Reservation; replayed: boolean }> {
  try {
    return await withTransaction(pool, async (tx) => {
      // Enfileira as disputas pela mesma sala. Sem isso, inserções simultâneas na
      // restrição de exclusão podem entrar em deadlock e esperar ~1s para abortar.
      // Não é esta trava que garante a regra: quem garante é reservations_no_overlap.
      const room = await tx.query<{ now: Date }>(
        'SELECT clock_timestamp() AS now FROM rooms WHERE id = $1 FOR NO KEY UPDATE',
        [input.roomId],
      );
      const now = room.rows[0]?.now;
      if (!now) throw new AppError(404, 'ROOM_NOT_FOUND', 'Sala não encontrada.');

      const existing = await findByKey(tx, input);
      if (existing) return replay(existing, input);

      if (input.start <= now) {
        throw new AppError(422, 'START_IN_PAST', 'O horário escolhido já passou.');
      }

      const { rows } = await tx.query<Row>(
        `INSERT INTO reservations (room_id, user_id, period, idempotency_key)
         VALUES ($1, $2, tstzrange($3, $4, '[)'), $5)
         RETURNING ${COLUMNS}`,
        [input.roomId, input.userId, input.start, input.end, input.idempotencyKey],
      );
      const row = rows[0]!;
      await enqueueEmail(tx, 'reservation.confirmed', row.id);
      return { reservation: toReservation(row), replayed: false };
    });
  } catch (err) {
    switch (pgErrorCode(err)) {
      case '23P01':
        throw new AppError(
          409,
          'SLOT_TAKEN',
          'Este horário acabou de ser reservado por outra pessoa. Sua reserva não foi feita.',
        );
      case '23503':
        throw new AppError(401, 'UNKNOWN_USER', 'Pessoa não cadastrada.');
      case '23505': {
        // Mesma chave em paralelo para salas diferentes: a trava por sala não as serializa.
        const existing = await findByKey(pool, input);
        if (existing) return replay(existing, input);
        throw err;
      }
      default:
        throw err;
    }
  }
}

/** Idempotente: cancelar de novo devolve o mesmo estado e não gera outro e-mail. */
export async function cancelReservation(
  pool: Pool,
  userId: number,
  reservationId: string,
): Promise<Reservation> {
  return withTransaction(pool, async (tx) => {
    // FOR UPDATE: de dois cancelamentos simultâneos, o segundo já enxerga 'cancelled'.
    const { rows } = await tx.query<Row & { now: Date }>(
      `SELECT ${COLUMNS}, clock_timestamp() AS now
         FROM reservations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [reservationId, userId],
    );
    const current = rows[0];
    if (!current) throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reserva não encontrada.');
    if (current.status === 'cancelled') return toReservation(current);
    if (current.start_at <= current.now) {
      throw new AppError(
        409,
        'ALREADY_STARTED',
        'Esta reserva já começou e não pode mais ser cancelada.',
      );
    }

    const updated = await tx.query<Row>(
      `UPDATE reservations SET status = 'cancelled', cancelled_at = clock_timestamp()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [reservationId],
    );
    await enqueueEmail(tx, 'reservation.cancelled', reservationId);
    return toReservation(updated.rows[0]!);
  });
}

/** Lê sempre direto do banco, sem cache: é a visão que a pessoa usa para conferir o que tem. */
export async function listUserReservations(pool: Pool, userId: number) {
  const { rows } = await pool.query<Row & { room_name: string; timezone: string }>(
    `SELECT r.id, r.room_id, r.user_id, lower(r.period) AS start_at, upper(r.period) AS end_at,
            r.status, r.created_at, r.cancelled_at, m.name AS room_name, m.timezone
       FROM reservations r
       JOIN rooms m ON m.id = r.room_id
      WHERE r.user_id = $1 AND upper(r.period) > now() - interval '1 day'
      ORDER BY lower(r.period)
      LIMIT 100`,
    [userId],
  );
  return rows.map((row) => ({
    ...toReservation(row),
    roomName: row.room_name,
    timezone: row.timezone,
  }));
}
