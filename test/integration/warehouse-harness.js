// The integration tests' warehouse: a DuckDB database in a file of its own per test file (dbt reads
// its path from DUCKDB_PATH — see the fixture profiles). `query`/`exec` read it directly, for a
// test that checks the data a model left or plants a change behind the server's back; they take the
// warehouse's turn like every dbt process does (one process at a time holds a DuckDB file).
//
// A BUILT warehouse (buildWarehouse) is built ONCE PER RUN when the run names a fixture cache —
// MCP_TEST_FIXTURE_CACHE, a directory scripts/run-tests.mjs makes for each run and removes after it:
// the first file that asks for a project builds it there (the others asking meanwhile wait for it),
// and every file gets a COPY of its own, since tests write to their warehouse and a DuckDB file is
// held by one process at a time. A file run on its own (no cache) builds its own, as it always did.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { warehouseTurns } from '../../src/dbt/process.js';
import { makeMcpServer } from '../../src/server.js';
// the Python of the environment that carries the DuckDB module (MetricFlow's, see src/dbt/environments.js)
import { DBT_BIN, PY_BIN } from '../helpers/dbt-env.js';

// Runs the statements in one connection and prints the last one's rows as JSON (dates and decimals
// as strings, like the rows dbt hands back).
const RUNNER = `
import duckdb, json, sys
con = duckdb.connect(sys.argv[1])
rows = []
for stmt in json.loads(sys.stdin.read()):
    cur = con.execute(stmt)
    if cur.description:
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
con.close()
print(json.dumps(rows, default=str))
`;

function run(path, statements) {
  return warehouseTurns.run(path, () => new Promise((resolve, reject) => {
    const child = execFile(PY_BIN, ['-c', RUNNER, path], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`duckdb: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      resolve(JSON.parse(stdout || '[]'));
    });
    child.stdin.end(JSON.stringify(statements));
  }));
}

/**
 * A private copy of a fixture dbt project for this test file. dbt writes into its project's
 * target/ (dbt v2 even stages seed data there as parquet), and the test files run side by side:
 * sharing one fixture directory, they overwrite each other's files mid-run.
 */
export function fixtureProject(name) {
  const src = join(process.cwd(), 'test', 'integration', 'fixtures', name);
  const dst = join(mkdtempSync(join(tmpdir(), `fx-${name}-`)), name);
  cpSync(src, dst, { recursive: true, filter: (p) => !/\/(target|logs)(\/|$)/.test(p.slice(src.length)) });
  return dst;
}

/** A fresh database file; DUCKDB_PATH points at it for everything this process starts. */
export async function startWarehouse() {
  const dir = mkdtempSync(join(tmpdir(), 'duckdb-'));
  const path = join(dir, 'warehouse.duckdb');
  process.env.DUCKDB_PATH = path;
  return {
    path,
    env: { DUCKDB_PATH: path },
    /** Rows of a SELECT: { rows: [{ column: value }] }. */
    async query(sql) { return { rows: await run(path, [sql]) }; },
    /** Run statements (separated by `;`) for their effect. */
    async exec(sql) { await run(path, sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)); },
    async stop() { rmSync(dir, { recursive: true, force: true }); },
  };
}

const execFileP = promisify(execFile);

/** The project's seeds loaded and every model run, by `dbtBin`, into the database at `dbPath`. */
async function seedAndRun(project, dbtBin, dbPath) {
  const env = { ...process.env, DBT_PROFILES_DIR: project, DBT_PROJECT_DIR: project, DUCKDB_PATH: dbPath };
  for (const cmd of [['seed', '--full-refresh'], ['run']]) {
    await execFileP(dbtBin, cmd, { cwd: project, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  }
}

/**
 * The fixture warehouse BUILT: a fresh database with the project's seeds loaded and every model run
 * by dbt — the data the tests over a whole project (and the evals, evals/) read. `dbtBin` is the dbt
 * that builds it: the test environment's unless another is named (a file on an environment of its
 * own, like the retentioneering feature's dbt 1.x). In a run with a fixture cache, the copy of the
 * run's one build of this project by this dbt (see the top of this file).
 */
export async function buildWarehouse(base, { dbtBin = DBT_BIN } = {}) {
  const wh = await startWarehouse();
  if (!FIXTURE_CACHE) {
    await seedAndRun(base, dbtBin, wh.path);
    return wh;
  }
  const template = await builtOnce(join(FIXTURE_CACHE, `${basename(base)}-${projectKey(base, dbtBin)}`), async (work) => {
    const project = join(work, 'project');
    cpSync(base, project, { recursive: true, filter: (p) => !DBT_OUTPUT.test(relative(base, p)) });
    await seedAndRun(project, dbtBin, join(work, basename(wh.path)));
  });
  // the database (with its write-ahead log, if dbt left one: it is replayed when the copy is opened),
  // under the same file name — DuckDB names the catalog after it, and dbt writes it into every relation
  for (const f of [basename(wh.path), `${basename(wh.path)}.wal`]) {
    if (existsSync(join(template, f))) copyFileSync(join(template, f), join(dirname(wh.path), f));
  }
  // …and what the seeds left in the project (dbt v2 stages their data under target/data), so the
  // file's project looks to dbt as it would had it been seeded in place; the rest of target/ is the
  // build's paths and parse caches, which the file's first dbt call writes for its own project
  const staged = join(template, 'project', 'target', 'data');
  if (existsSync(staged)) cpSync(staged, join(base, 'target', 'data'), { recursive: true });
  return wh;
}

// ── the fixture cache ─────────────────────────────────────────────────────────────────────────

const FIXTURE_CACHE = process.env.MCP_TEST_FIXTURE_CACHE || '';
/** What dbt writes into a project: not part of what decides its build. */
const DBT_OUTPUT = /(^|\/)(target|logs|dbt_packages|\.user\.yml)(\/|$)/;
const WAIT_MS = 15 * 60 * 1000;

/**
 * What a build of `base` by `dbtBin` holds is decided by the dbt and the project's files (a test
 * that edits its copy before building gets a template of its own): their hash.
 */
function projectKey(base, dbtBin) {
  const hash = createHash('sha256').update(`${dbtBin}\0`);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(base, path);
      if (DBT_OUTPUT.test(rel)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(`${rel}\0`).update(readFileSync(path)).update('\0');
    }
  };
  walk(base);
  return hash.digest('hex').slice(0, 16);
}

/**
 * `dir`, built once by `build(workDir)`: the caller that takes `<dir>.lock` builds in a directory of
 * its own and publishes it by renaming it to `dir` (a reader never sees half a build); the others
 * wait for `dir`, or for `<dir>.error`, which fails them at once with the builder's message. A lock
 * whose builder has died is taken over.
 */
async function builtOnce(dir, build) {
  const lock = `${dir}.lock`;
  const failed = `${dir}.error`;
  const deadline = Date.now() + WAIT_MS;
  mkdirSync(dirname(dir), { recursive: true });
  for (;;) {
    if (existsSync(dir)) return dir;
    if (existsSync(failed)) throw new Error(`the fixture template ${basename(dir)} failed to build in another test file: ${readFileSync(failed, 'utf8')}`);
    if (takeLock(lock)) {
      // it may have been published (or failed) between the look above and the lock
      if (existsSync(dir) || existsSync(failed)) { rmSync(lock, { recursive: true, force: true }); continue; }
      const work = mkdtempSync(`${dir}.build-`);
      try {
        await build(work);
        try { renameSync(work, dir); } catch (e) { if (!existsSync(dir)) throw e; } // a builder that took over a lock thought dead published first
        return dir;
      } catch (e) {
        writeFileSync(failed, `${e?.message || e}${e?.stdout ? `\n${String(e.stdout).slice(-4000)}` : ''}`);
        throw e;
      } finally {
        rmSync(work, { recursive: true, force: true });
        rmSync(lock, { recursive: true, force: true });
      }
    }
    if (lockAbandoned(lock)) { rmSync(lock, { recursive: true, force: true }); continue; }
    if (Date.now() > deadline) throw new Error(`waited ${WAIT_MS / 60000} min for the fixture template ${basename(dir)} another test file is building`);
    await sleep(250);
  }
}

function takeLock(lock) {
  try { mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return true;
}

/** The lock's builder is gone: its process has ended, or it never wrote its pid in a minute. */
function lockAbandoned(lock) {
  let pid;
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch {
    try { return Date.now() - statSync(lock).mtimeMs > 60000; } catch { return false; } // released meanwhile
  }
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/** An MCP client on the other end of an in-memory transport from a server over `engine` — the way a host reaches it. */
export async function connectMcp(engine, name = 'test') {
  const server = makeMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, async close() { await client.close(); await server.close(); } };
}
