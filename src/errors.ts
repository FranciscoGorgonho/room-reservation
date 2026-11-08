/**
 * - `not_reserved`: resposta definitiva, a reserva não existe.
 * - `unknown`: o servidor não sabe o desfecho; repetir com a mesma Idempotency-Key resolve.
 */
export type Outcome = 'not_reserved' | 'unknown';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly outcome: Outcome = 'not_reserved',
  ) {
    super(message);
  }
}
