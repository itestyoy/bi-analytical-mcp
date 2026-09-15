// A point-in-time join reads the version of a slowly-changing row that was valid at the event's
// time. The CURRENT version usually has NO END yet — dbt's own snapshots write NULL into
// `dbt_valid_to` — and `BETWEEN from AND NULL` is never true, so the plain form dropped exactly
// the rows a "what is it now" question is about: every recent event lost its attributes silently.
//
// Asserted on DATA: the join runs against a real Postgres (PGlite) over a dimension whose latest
// version is open-ended, and the test reads the VALUES that come back per event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPglite } from './pglite-harness.js';
import { getDialect } from '../../src/dialects/index.js';

const d = getDialect('postgres');
const AT = { value: 'event_time', from: 'valid_from', to: 'valid_until' };

test('a point-in-time join keeps the open-ended current version, and still picks the right one per event', async (t) => {
  const pg = await startPglite();
  t.after(async () => { await pg.stop(); });

  await pg.db.exec(`
    CREATE TABLE ev (id int, player_id text, event_time timestamp, amount numeric);
    INSERT INTO ev VALUES
      (1, 'u1', '2026-01-01 10:00:00', 10),
      (2, 'u1', '2026-01-05 10:00:00', 20),
      (3, 'u2', '2026-01-05 10:00:00', 30);
    CREATE TABLE dim (player_id text, country text, valid_from timestamp, valid_until timestamp);
    INSERT INTO dim VALUES
      ('u1', 'US', '2026-01-01 00:00:00', '2026-01-02 23:59:59'),  -- closed: the old version
      ('u1', 'GB', '2026-01-03 00:00:00', NULL),                   -- CURRENT: no end yet
      ('u2', 'BR', '2026-01-01 00:00:00', NULL);
  `);

  const op = { on: ['player_id'], attrs: [{ column: 'country', as: 'country' }], relation: 'dim', between: AT };
  const sql = d.joinCte('ev', op);
  const r = await pg.db.query(`SELECT id, country, amount FROM (${sql}) x ORDER BY id`);

  // every event kept its row, and each got the country valid AT ITS OWN TIME
  assert.deepEqual(r.rows.map((x) => [x.id, x.country]), [[1, 'US'], [2, 'GB'], [3, 'BR']]);
  // …so the per-country totals are the real ones, not a hole where the current version should be
  const sums = await pg.db.query(`SELECT country, sum(amount)::int AS total FROM (${sql}) x GROUP BY country ORDER BY country`);
  assert.deepEqual(sums.rows.map((x) => [x.country, x.total]), [['BR', 30], ['GB', 20], ['US', 10]]);

  // and the window still EXCLUDES a version that had already ended: no event matches two versions
  const fanout = await pg.db.query(`SELECT count(*)::int AS n FROM (${sql}) x`);
  assert.equal(fanout.rows[0].n, 3, 'one row per event — the key alone would have matched both u1 versions');
});
