import type { Pool } from './db.js';
import type { EmailMessage, EmailSender } from './email.js';

interface OutboxRow {
  id: string;
  type: string;
  attempts: number;
  payload: {
    userName: string;
    userEmail: string;
    roomName: string;
    timezone: string;
    start: string;
    end: string;
  };
}

export interface WorkerOptions {
  batchSize: number;
  leaseSeconds: number;
  sendTimeoutMs: number;
  baseRetryMs: number;
  maxRetryMs: number;
  maxAttempts: number;
}

export const defaultWorkerOptions: WorkerOptions = {
  batchSize: 20,
  leaseSeconds: 60,
  sendTimeoutMs: 10_000,
  baseRetryMs: 1_000,
  maxRetryMs: 5 * 60_000,
  // Com o teto de 5 min entre tentativas, cobre uma indisponibilidade de cerca de 3h30.
  maxAttempts: 48,
};

function toEmail(row: OutboxRow): EmailMessage {
  const { payload: p } = row;
  const when = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: p.timezone,
  }).format(new Date(p.start));
  const until = new Intl.DateTimeFormat('pt-BR', {
    timeStyle: 'short',
    timeZone: p.timezone,
  }).format(new Date(p.end));
  const cancelled = row.type === 'reservation.cancelled';
  return {
    dedupeId: `outbox-${row.id}`,
    to: p.userEmail,
    subject: `${cancelled ? 'Reserva cancelada' : 'Reserva confirmada'}: ${p.roomName}`,
    body: `Olá, ${p.userName}. ${cancelled ? 'Sua reserva foi cancelada' : 'Sua reserva está confirmada'}: ${p.roomName}, ${when} até ${until}.`,
  };
}

async function sendWithTimeout(sender: EmailSender, message: EmailMessage, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Tempo limite no envio do e-mail')), timeoutMs);
  });
  try {
    await Promise.race([sender.send(message), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Processa um lote e devolve quantos eventos pegou. Entrega "pelo menos uma vez":
 * se o worker cair entre enviar e marcar, o evento é reenviado com o mesmo dedupeId.
 */
export async function processOutboxBatch(
  pool: Pool,
  sender: EmailSender,
  options: Partial<WorkerOptions> = {},
): Promise<number> {
  const opts = { ...defaultWorkerOptions, ...options };

  // A concessão é gravada e confirmada antes do envio, para não manter
  // uma transação aberta enquanto o provedor de e-mail responde.
  const { rows } = await pool.query<OutboxRow>(
    `UPDATE outbox
        SET attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, attempts, payload`,
    [opts.batchSize, opts.leaseSeconds],
  );

  await Promise.all(
    rows.map(async (row) => {
      try {
        await sendWithTimeout(sender, toEmail(row), opts.sendTimeoutMs);
        await pool.query(
          `UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
          [row.id],
        );
      } catch (err) {
        const backoffMs = Math.min(opts.baseRetryMs * 2 ** (row.attempts - 1), opts.maxRetryMs);
        await pool.query(
          `UPDATE outbox
              SET status = CASE WHEN attempts >= $2 THEN 'dead' ELSE 'pending' END,
                  next_attempt_at = now() + make_interval(secs => $3),
                  last_error = $4
            WHERE id = $1`,
          [row.id, opts.maxAttempts, backoffMs / 1000, String(err)],
        );
      }
    }),
  );
  return rows.length;
}

/** Laço do worker; devolve a função que o encerra. */
export function startOutboxWorker(
  pool: Pool,
  sender: EmailSender,
  pollMs = 500,
  options: Partial<WorkerOptions> = {},
): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      let processed = 0;
      try {
        processed = await processOutboxBatch(pool, sender, options);
      } catch (err) {
        console.error('Falha no worker de e-mails:', err);
      }
      if (processed === 0 && running) await new Promise((r) => setTimeout(r, pollMs));
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}
