import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** PostgreSQL real, baixado via npm, para rodar o projeto sem Docker ou instalação. */
export async function startEmbeddedPostgres(options: {
  dir: string;
  port: number;
  persistent: boolean;
}): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = new EmbeddedPostgres({
    databaseDir: options.dir,
    user: 'reservas',
    password: 'reservas',
    port: options.port,
    persistent: options.persistent,
    onLog: () => {},
    onError: () => {},
  });
  const isNew = !existsSync(join(options.dir, 'PG_VERSION'));
  if (isNew) await server.initialise();
  await server.start();
  if (isNew) await server.createDatabase('reservas');
  return {
    url: `postgres://reservas:reservas@localhost:${options.port}/reservas`,
    stop: () => server.stop(),
  };
}
