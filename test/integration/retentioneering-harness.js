// What the two files of THE RETENTIONEERING FEATURE'S integration tests stand on —
// retentioneering.test.js (the analyses, the contexts, the starts from a pipeline's tasks) and
// retentioneering-steps.test.js (an eventstream's steps, the specs a start takes): the fixture warehouse
// seeded and run on the feature's own dbt environment (`retentioneering`: dbt 1.x + the library), an
// engine with the feature on, the rows every expectation is counted from, and the users' paths
// (`paths`: platform as a segment, sessions at 30-minute gaps) built once. Each file opens a world of
// its own — its own warehouse file, project copy and engine — so the two run side by side.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { createDbt } from '../../src/dbt/index.js';
import { Engine } from '../../src/engine.js';
import { createRetentioneeringFeature } from '../../src/retentioneering/index.js';
import { settle, one } from '../helpers/settle.js';
import { dbtEnv } from '../helpers/dbt-env.js';
import { fixtureProject, startWarehouse } from './warehouse-harness.js';

const execFileP = promisify(execFile);

export const ENV = dbtEnv('retentioneering');
export const opts = { timeout: 900000 };
/** Skipped when the environment is not built (npm run dbt:env -- create retentioneering). */
export const skip = (t) => { if (!ENV) { t.skip('dbt environment retentioneering not installed (npm run dbt:env -- create retentioneering)'); return true; } return false; };

export const FUNNEL = ['tutorial', 'level_started', 'shop_opened', 'iap_purchase_completed'];

/** Each user's event names in path order, collapsed runs of one event into one. */
export const collapsed = (list) => list.map((r) => r.e).filter((e, i, all) => i === 0 || e !== all[i - 1]);

/** One of the library's tables of a result, as records. */
export const table = (result, name) => {
  const t = result.tables.find((x) => x.name === name);
  assert.ok(t, `a table '${name}' (has ${result.tables.map((x) => x.name).join(', ')})`);
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
};

/** A segment overview's sizes, level by level. */
export const sizes = (overview) => Object.fromEntries(overview.levels.map((l) => [l.name, l.size]));

/**
 * The world one test file runs in: the warehouse built, the engine, the rows, `paths` built (its
 * build's read is `built`), and the users per platform (`perPlatform`, ordered by platform).
 */
export async function openWorld() {
  const BASE = fixtureProject('dbt_project');
  const wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(ENV.dbtBin, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 1 << 26 });
  await execFileP(ENV.dbtBin, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 1 << 26 });
  const runner = createDbt({ environment: ENV, profilesDir: BASE, timeout: 600000 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'rete-ctx-')), timeSpineDialect: 'duckdb' });
  const engine = settle(new Engine({
    catalog, contextManager: ctxs, runner, dbPath: join(mkdtempSync(join(tmpdir(), 'rete-db-')), 'x.sqlite'),
    // a read keeps 7 rows of a table (not 1000), so these few users' per-path tables are cut as a large
    // eventstream's are, and every whole read is proved by the numbers
    features: [createRetentioneeringFeature({ runner, keptRows: 7 })], featureStatus: [{ id: 'retentioneering', available: true }],
  }));
  const close = async () => { try { engine.close(); } catch { /* noop */ } await wh.stop(); };
  let rows; let built; let perPlatform;

  /** A task's read, followed until it is done (one read waits at most 30 s; a build under load can take longer). */
  const readDone = async (id, extra = {}) => {
    for (;;) {
      const r = await one(engine.query_retentioneering_model({ task_ids: [id], ...extra }));
      if (r.status !== 'running') return r;
    }
  };
  /** Each user's events in time order (ties by name, as the eventstream orders them). */
  const paths = () => {
    const by = new Map();
    for (const r of rows) (by.get(r.u) || by.set(r.u, []).get(r.u)).push(r);
    for (const list of by.values()) list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.e.localeCompare(b.e)));
    return by;
  };
  /** The analyses of one call over `eventstream`, read back. */
  const analyze = async (ctx, eventstream, analyses, detail) => {
    const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream, analyses });
    const r = await readDone(q.task_id, { ...(detail ? { detail } : {}) });
    assert.equal(r.status, 'done', JSON.stringify(r.error));
    return r.analyses;
  };

  try {
    // the rows every expectation is counted from: each event, its user, its time — in path order
    rows = (await wh.query('select player_id_of_internal as u, event_name as e, device_time as t from fct_analytics_events order by 1, 3, 2')).rows;
    const b = await engine.build_retentioneering_model({ name: 'paths', source: 'events', segments: [{ model: 'users', attribute: 'platform' }], sessions: { gap_minutes: 30 } });
    built = await readDone(b.task_id);
    assert.equal(built.status, 'done', `the users' paths: ${JSON.stringify(built.error)}`);
    perPlatform = (await wh.query('select platform, count(distinct u.player_id_of_internal) as n from dim_users u join (select distinct player_id_of_internal from fct_analytics_events) e using (player_id_of_internal) group by platform order by platform')).rows
      .map((r) => ({ platform: String(r.platform), n: Number(r.n) }));
  } catch (e) {
    // the engine's library check is a process of its own: a world that did not open lets go of it
    await close();
    throw e;
  }

  /** The context of `paths`, where the step tests fork it. */
  const stepsContext = async () => built.context_id;
  /** A fork of `paths` with these steps, materialized; its build's read. */
  const shaped = async (name, steps) => {
    const ctx = await stepsContext();
    await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'paths', name, after: 0 });
    const added = await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: name, steps });
    const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: name });
    const read = await readDone(m.task_id);
    assert.equal(read.status, 'done', JSON.stringify(read.error));
    return { ctx, added, read };
  };

  return { engine, wh, rows, built, perPlatform, readDone, paths, analyze, stepsContext, shaped, close };
}
