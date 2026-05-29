// Boots an in-process PGlite database exposed over a TCP socket (Postgres wire
// protocol) so the Python dbt-postgres adapter can connect — no real Postgres.

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createServer } from 'node:net';

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function startPglite() {
  // Boot an empty PGlite; the test data is loaded by `dbt seed` (CSV seeds).
  const db = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return {
    port,
    db,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
