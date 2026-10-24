// A READ LEAVES THE CONTEXT'S target/ AS IT FOUND IT. Every read of a stored table (a page of a
// task, a card's drill-down, a probe) is a `dbt show` in the context's project, and a context lives
// until CONTEXT_TTL_MS retires it — never, by default. A dbt that wrote a file of its own into target/
// on every show (dbt v2: three, named for a fresh id) would grow it with every read. Context
// lifecycle: the number of files in the context's target/ after a pipeline build is the number after
// several reads of its stored table — on the test environment, and on dbt v2 by name, where the
// growth was seen (skipped when it is not built). The pages themselves are checked on the seed's
// numbers (SEED_DATA.md §2: 184 events, 14 names).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { createDbt } from '../../src/dbt/index.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, one } from '../helpers/settle.js';
import { HAS_DBT, TEST_ENV, dbtEnv } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const PAGE = 5;

let wh;
before(async () => { if (HAS_DBT) wh = await buildWarehouse(BASE); }, opts);
after(async () => { if (wh) await wh.stop(); });

/** Every file under `dir`, at any depth. */
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;

for (const name of new Set([TEST_ENV, 'dbt-v2'])) {
  test(`${name}: reading a stored pipeline table again and again leaves the context's target/ with as many files as before`, opts, async (t) => {
    if (!HAS_DBT) { t.skip('dbt/mf not installed'); return; }
    const environment = dbtEnv(name);
    if (!environment) { t.skip(`dbt environment ${name} not built (npm run dbt:env -- create ${name})`); return; }
    const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
    const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('tgt'), timeSpineDialect: 'duckdb' });
    const engine = settle(new Engine({ catalog, contextManager: ctxs, runner: createDbt({ environment, profilesDir: BASE }) }));
    const s = await engine.build_model({ action: 'start', name: 'per_event', source: 'events' });
    await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [
      { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
      { stage: 'order_by', keys: [{ key: 'event_name', direction: 'asc' }] },
    ] });
    const built = await engine.build_model({ action: 'materialize', context_id: s.context_id });
    assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
    const target = join(ctxs.dir(built.context_id), 'target');
    const before = filesUnder(target);

    // the whole table page by page, twice
    const reads = [];
    for (const offset of [0, PAGE, 2 * PAGE, 0, PAGE, 2 * PAGE]) {
      const page = await one(engine.query_model({ task_ids: [built.task_id], limit: PAGE, offset }));
      assert.equal(page.status, 'done', JSON.stringify(page.error || page));
      reads.push(page.rows);
    }
    const rows = reads.slice(0, 3).flat();
    assert.equal(rows.length, 14, 'one row per event name');
    assert.equal(rows.reduce((s, r) => s + Number(r.n), 0), 184);
    assert.equal(Number(rows.find((r) => r.event_name === 'level_started').n), 28);
    assert.deepEqual(reads.slice(3).flat(), rows, 'read again, the same rows');

    assert.equal(filesUnder(target), before, `the files in ${target} after ${reads.length} reads`);
  });
}
