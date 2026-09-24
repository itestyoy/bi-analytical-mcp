// The integration tests' warehouse: a DuckDB database in a file of its own per test file (dbt reads
// its path from DUCKDB_PATH — see the fixture profiles). `query`/`exec` read it directly, for a
// test that checks the data a model left or plants a change behind the server's back; they take the
// warehouse's turn like every dbt process does (one process at a time holds a DuckDB file).

import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warehouseTurns } from '../../src/dbt/process.js';
import { dbtEnv } from '../helpers/dbt-env.js';
import { DEFAULT_ENV } from '../../src/dbt/environments.js';

// the Python of the environment that carries the DuckDB module (MetricFlow's, see src/dbt/environments.js)
const PY_BIN = process.env.PYTHON_BIN || dbtEnv(process.env.DBT_ENV || DEFAULT_ENV)?.pythonBin || 'python3';

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
