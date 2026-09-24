// dbt 1.x — the `dbt` CLI (dbt-core) for parse / run / show / seed / run-operation, and MetricFlow's
// `mf` CLI for metric queries (it reads target/semantic_manifest.json, which `dbt parse` writes).
// Each context runs in its own overlay project dir, so target/ is naturally isolated. NOT
// `dbt sl query` (that is dbt platform/remote and incompatible with local per-context isolation).

import { existsSync, readFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inIsolatedTarget } from '../request-context.js';
import { assetPath } from '../runtime-assets.js';
import { runProcess } from './process.js';
import { queryTag } from './query-tag.js';
import { warehouseOf } from './warehouse.js';
import { parseShowJson, parseCsv, extractSql, extractPlan } from './output.js';

export class DbtV1 {
  constructor({ dbtBin, mfBin, profilesDir, timeout = 600000 } = {}) {
    this.dbtBin = dbtBin;
    this.mfBin = mfBin;
    this.profilesDir = profilesDir;
    this.timeout = timeout;
    this.major = 1;
  }

  /** The semantic-layer YAML this dbt reads: 1.x (below 1.12) knows only the legacy spec. */
  get semanticSpec() { return 'legacy'; }

  /** Whether this dbt runs Python models on `adapter` — 1.x leaves that to the adapter (catalog.js decides). */
  pythonModelsOn(_adapter) { return true; }

  _env(projectDir) {
    const env = { DBT_PROJECT_DIR: projectDir };
    if (this.profilesDir) env.DBT_PROFILES_DIR = this.profilesDir;
    return env;
  }

  /** The warehouse the project talks to (its adapter, and the turn a single-writer one takes). */
  warehouse(projectDir) {
    return warehouseOf(projectDir, this.profilesDir);
  }

  /** Whether this dbt's `dbt` is the Python CLI, whose adapter python/query_tag.py can tag (v2's is not). */
  get tagsDbtQueries() { return true; }

  /**
   * How to run `bin args` so every query it sends carries the call's query tag (src/dbt/query-tag.js):
   * a Python CLI of an environment (`dbt` 1.x, `mf`) runs through python/query_tag.py on that
   * environment's Python. Outside a call — or for a binary that is not one — it runs as it is.
   */
  _tagged(bin, args) {
    const tag = queryTag();
    const entry = bin === this.mfBin ? 'mf' : bin === this.dbtBin && this.tagsDbtQueries ? 'dbt' : null;
    const python = entry && join(dirname(bin), 'python');
    const script = entry && assetPath('queryTag');
    if (!tag || !script || !existsSync(python)) return { bin, args, env: tag ? { MCP_QUERY_TAG: tag } : {} };
    return { bin: python, args: [script, entry, ...args], env: { MCP_QUERY_TAG: tag } };
  }

  _proc(bin, projectDir, args, { timeout = this.timeout, env = {} } = {}) {
    const run = this._tagged(bin, args);
    return runProcess(run.bin, run.args, { cwd: projectDir, env: { ...this._env(projectDir), ...env, ...run.env }, timeout, turn: this.warehouse(projectDir).turn, as: { bin, args } });
  }

  /**
   * A dbt command other than parse. Run as one of several concurrent tasks on a context (a batch of
   * queries, src/request-context.js isolatedTarget), it writes its artifacts (manifest, run results,
   * the partial-parse cache) to a target directory of its own — seeded with the context's
   * partial-parse cache so it still parses incrementally — and that directory is removed after.
   * The context's own target/ (whose semantic manifest MetricFlow reads) is left untouched.
   */
  async _dbt(projectDir, args, timeout = this.timeout) {
    if (!inIsolatedTarget()) return this._proc(this.dbtBin, projectDir, args, { timeout });
    const target = mkdtempSync(join(tmpdir(), 'dbt-target-'));
    try {
      const cache = join(projectDir, 'target', 'partial_parse.msgpack');
      if (existsSync(cache)) { try { copyFileSync(cache, join(target, 'partial_parse.msgpack')); } catch { /* a full parse then */ } }
      return await this._proc(this.dbtBin, projectDir, args, { timeout, env: { DBT_TARGET_PATH: target } });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  async parse(projectDir) {
    const r = await this._proc(this.dbtBin, projectDir, ['parse']);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, manifest: existsSync(join(projectDir, 'target', 'semantic_manifest.json')) };
  }

  /** Build models (a generated pipeline model, a stored query result) via `dbt run --select`. */
  async run(projectDir, select) {
    const args = ['run'];
    if (select) args.push('--select', select);
    const r = await this._dbt(projectDir, args);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}), ...(r.cancelled ? { cancelled: true } : {}) };
  }

  /** Load the project's seeds (`dbt seed`). */
  async seed(projectDir) {
    const r = await this._dbt(projectDir, ['seed']);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
  }

  /** Real physical columns of a model's relation, via adapter.get_columns_in_relation. */
  async relationColumns(projectDir, modelName) {
    const args = ['run-operation', 'mcp_relation_columns', '--args', JSON.stringify({ model_name: modelName })];
    const r = await this._dbt(projectDir, args);
    // Preserve the process-level facts (killed/signal/error = timeout, spawn failure): the caller
    // has to tell "dbt could not run" from "dbt ran and this relation is not there".
    if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr, error: r.error, killed: r.killed, signal: r.signal };
    const m = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').match(/MCP_COLS:(\[[^\n]*\])/);
    if (!m) return { ok: false, stdout: r.stdout };
    try { return { ok: true, columns: JSON.parse(m[1]) }; } catch { return { ok: false, stdout: r.stdout }; }
  }

  /**
   * Run a SQL (Jinja refs allowed) against the warehouse and return rows (dbt show --output json).
   * `timeout` overrides the default for THIS call — heavy value-index scans pass a larger one so a
   * full-table aggregate isn't killed mid-flight.
   */
  async show(projectDir, sql, limit = 1000, timeout = this.timeout) {
    const args = ['show', '--inline', sql, '--output', 'json', '--limit', String(limit)];
    const r = await this._dbt(projectDir, args, timeout);
    // Preserve r.error (the process-level message: timeout, ENOENT, spawn failure) so callers can
    // log the REAL reason from ANY level — not just dbt's own stderr.
    if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr, error: r.error, ...(r.cancelled ? { cancelled: true } : {}), rows: [], columns: [] };
    const rows = parseShowJson(r.stdout);
    return { ok: true, rows, columns: rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [] };
  }

  async validate(projectDir) {
    const r = await this._proc(this.mfBin, projectDir, ['validate-configs']);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
  }

  buildQueryArgs({ metrics, groupBy = [], where = [], orderBy = [], startTime, endTime, limit, csvFile, explain, plan }) {
    const args = ['query', '--metrics', metrics.join(',')];
    if (groupBy.length) args.push('--group-by', groupBy.join(','));
    for (const w of where) args.push('--where', w);
    if (orderBy.length) args.push('--order', orderBy.join(',')); // mf uses --order (dbt sl uses --order-by)
    if (startTime) args.push('--start-time', startTime);
    if (endTime) args.push('--end-time', endTime);
    if (typeof limit === 'number') args.push('--limit', String(limit));
    if (explain) {
      args.push('--explain');
      if (plan) args.push('--show-dataflow-plan'); // also print the dataflow plan
    } else if (csvFile) args.push('--csv', csvFile);
    return args;
  }

  /** A metric query through MetricFlow (`mf query`), or its compiled SQL/plan with `explain`. */
  async query(projectDir, opts) {
    if (opts.explain) {
      const args = this.buildQueryArgs({ ...opts, explain: true, plan: opts.plan });
      const r = await this._proc(this.mfBin, projectDir, args);
      return { ok: r.ok, command: `mf ${args.join(' ')}`, sql: extractSql(r.stdout), ...(opts.plan ? { plan: extractPlan(r.stdout) } : {}), stdout: r.stdout, stderr: r.stderr };
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'mfq-'));
    const csvFile = join(tmpDir, 'out.csv');
    const args = this.buildQueryArgs({ ...opts, csvFile });
    try {
      const r = await this._proc(this.mfBin, projectDir, args);
      let columns = [];
      let rows = [];
      if (r.ok && existsSync(csvFile)) ({ columns, rows } = parseCsv(readFileSync(csvFile, 'utf8')));
      return { ok: r.ok, command: `mf ${args.join(' ')}`, columns, rows, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true }); // don't leak per-query temp dirs
    }
  }
}
