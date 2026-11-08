import type { Pool } from './db.js';

/** Popula o volume do enunciado: 2 mil salas, 50 mil pessoas e duas semanas de agenda. */
export async function seed(pool: Pool): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM rooms LIMIT 1');
  if (rows.length) return;

  await pool.query(`
    INSERT INTO rooms (id, name, city, capacity, timezone)
    SELECT n,
           'Sala ' || lpad(n::text, 4, '0'),
           (ARRAY['São Paulo','Rio de Janeiro','Belo Horizonte','Curitiba','Recife','Porto Alegre','Manaus'])[1 + n % 7],
           (ARRAY[4, 6, 8, 12, 20])[1 + n % 5],
           CASE WHEN n % 7 = 6 THEN 'America/Manaus' ELSE 'America/Sao_Paulo' END
      FROM generate_series(1, 2000) AS n
  `);
  await pool.query(`
    INSERT INTO users (id, name, email)
    SELECT n, 'Pessoa ' || n, 'pessoa' || n || '@exemplo.test'
      FROM generate_series(1, 50000) AS n
  `);
  // Blocos fixos de 2h, que por construção não se sobrepõem na mesma sala.
  await pool.query(`
    INSERT INTO reservations (room_id, user_id, period, idempotency_key)
    SELECT m.id,
           1 + floor(random() * 50000)::int,
           tstzrange(
             (current_date + d + make_time(h, 0, 0)) AT TIME ZONE m.timezone,
             (current_date + d + make_time(h + 2, 0, 0)) AT TIME ZONE m.timezone,
             '[)'),
           'seed-' || m.id || '-' || d || '-' || h
      FROM rooms m,
           generate_series(1, 14) AS d,
           generate_series(8, 18, 2) AS h
     WHERE random() < 0.3
  `);
}
