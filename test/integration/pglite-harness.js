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
  const db = await PGlite.create();
  await seed(db);
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

async function seed(db) {
  await db.exec(`
    create table raw_campaigns (
      campaign_id text, channel text, network text, cost_model text
    );
    insert into raw_campaigns values
      ('c1','social','meta','cpi'),
      ('c2','search','google','cpc');

    create table raw_users (
      user_id text, install_date date, platform text, os_version text,
      device_model text, country text, region text, language text,
      media_source text, acquisition_type text, app_version text, campaign_id text
    );
    insert into raw_users values
      ('u1','2026-01-01','ios','17','iphone','US','NA','en','meta','paid','1.0','c1'),
      ('u2','2026-01-01','android','14','pixel','US','NA','en','organic','organic','1.0','c2'),
      ('u3','2026-01-02','ios','17','iphone','GB','EU','en','meta','paid','1.0','c1');

    create table raw_events (
      event_id text, user_id text, session_id text, event_name text,
      event_timestamp timestamp, event_properties jsonb
    );
    insert into raw_events values
      ('e1','u1','s1','purchase','2026-01-03 10:00:00','{"revenue": 100, "product_id": "p1", "level": 5}'),
      ('e2','u1','s1','purchase','2026-01-03 11:00:00','{"revenue": 50,  "product_id": "p2", "level": 6}'),
      ('e3','u3','s2','purchase','2026-01-04 09:00:00','{"revenue": 200, "product_id": "p1", "level": 9}'),
      ('e4','u2','s3','purchase','2026-01-03 12:00:00','{"revenue": 999, "product_id": "p1", "level": 3}'),
      ('e5','u1','s1','level_complete','2026-01-03 09:00:00','{"level": 5, "score": 1200}'),
      ('e6','u3','s2','session_start','2026-01-04 08:00:00','{}');
  `);
}
