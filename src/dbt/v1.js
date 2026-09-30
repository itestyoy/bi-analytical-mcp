// dbt 1.x — the `dbt` CLI (dbt-core) for parse / run / show / seed / run-operation, and MetricFlow's
// `mf` CLI for metric queries (it reads target/semantic_manifest.json, which `dbt parse` writes).
// Each context runs in its own overlay project dir, so target/ is naturally isolated. NOT
// `dbt sl query` (that is dbt platform/remote and incompatible with local per-context isolation).

import { existsSync, readFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inIsolatedTarget } from '../request-context.js';
import { runProcess, runWithInput } from './process.js';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { warehouseOf } from './warehouse.js';
import { parseShowJson, parseCsv, extractSql, extractPlan, stripAnsi, SEMANTIC_MANIFEST } from './output.js';

export class DbtV1 {
  constructor({ dbtBin, mfBin, pythonBin, profilesDir, timeout = 600000 } = {}) {
    this.dbtBin = dbtBin;
    this.mfBin = mfBin;
    this.pythonBin = pythonBin;
    this.profilesDir = profilesDir;
    this.timeout = timeout;
    this.major = 1;
  }

  /** The semantic-layer YAML this dbt reads: 1.x (below 1.12) knows only the legacy spec. */
  get semanticSpec() { return 'legacy'; }

  /** The config a SQL model needs when its SQL is written in a syntax dbt's own parser does not read
   *  (BigQuery's pipe syntax) — dbt 1.x parses no SQL, so none. */
  unparsedSqlConfig() { return {}; }

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

  _proc(bin, projectDir, args, { timeout = this.timeout, env = {} } = {}) {
    return runProcess(bin, args, { cwd: projectDir, env: { ...this._env(projectDir), ...env }, timeout, turn: this.warehouse(projectDir).turn });
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
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, manifest: existsSync(join(projectDir, ...SEMANTIC_MANIFEST)) };
  }

  /** The semantic manifest the last parse of `projectDir` wrote (what MetricFlow reads), or null. */
  semanticManifest(projectDir) {
    const file = join(projectDir, ...SEMANTIC_MANIFEST);
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  }

  /**
   * The dbt model each semantic model reads, as dbt recorded it when it parsed `projectDir`
   * (target/manifest.json: a semantic model's depends_on) → { <semantic model>: <dbt model> }; {}
   * when the manifest cannot be read.
   */
  semanticModelSources(projectDir) {
    const file = join(projectDir, 'target', 'manifest.json');
    if (!existsSync(file)) return {};
    try {
      const m = JSON.parse(readFileSync(file, 'utf8'));
      const out = {};
      for (const sm of Object.values(m.semantic_models || {})) {
        const model = (sm.depends_on?.nodes || []).map((id) => m.nodes?.[id]).find((n) => n?.resource_type === 'model');
        if (sm.name && model?.name) out[sm.name] = model.name;
      }
      return out;
    } catch { return {}; }
  }

  /**
   * What each of `metrics` can be grouped by, as MetricFlow itself lists it over `projectDir`'s parsed
   * semantic manifest (its `list_group_bys`: each dimension with its semantic model and entity path,
   * each entity, metric_time with its grain) — asked of MetricFlow's Python once, through
   * python/mf_group_bys.py, in the MetricFlow environment. The `mf` CLI prints only names.
   * → { ok, group_bys: { <metric>: [item] } } | { ok: false, error }
   */
  async groupBys(projectDir, metrics) {
    const python = this.pythonBin || this.environment?.pythonBin;
    if (!python) return { ok: false, error: 'no MetricFlow Python to ask: the dbt environment names no MetricFlow environment (MF_ENV)' };
    const script = assetPath('mfGroupBys');
    if (!script) return { ok: false, error: missingAssetMessage('mfGroupBys') };
    const request = { id: 'group_bys', op: 'group_bys', project_dir: projectDir, profiles_dir: this.profilesDir, metrics };
    const r = await runWithInput(python, [script], `${JSON.stringify(request)}\n`, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout, turn: this.warehouse(projectDir).turn });
    const line = (r.stdout || '').split('\n').find((l) => l.trim().startsWith('{'));
    let out = null;
    try { out = line ? JSON.parse(line) : null; } catch { /* said below */ }
    if (out?.ok) return { ok: true, group_bys: out.group_bys || {} };
    return { ok: false, error: out?.error || r.error || (r.stderr || '').trim().split('\n').slice(-3).join(' ') || 'MetricFlow could not list the group-by items' };
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
    const m = stripAnsi(r.stdout).match(/MCP_COLS:(\[[^\n]*\])/);
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
      // a CSV carries no types: a metric's column is a number, as the warehouse computed it (a
      // dimension's values stay as written — "1.0.0" or "007" is not a number)
      const metricCols = new Set(opts.metrics || []);
      for (const row of rows) {
        for (const c of metricCols) if (typeof row[c] === 'string' && row[c].trim() !== '' && Number.isFinite(Number(row[c]))) row[c] = Number(row[c]);
      }
      return { ok: r.ok, command: `mf ${args.join(' ')}`, columns, rows, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true }); // don't leak per-query temp dirs
    }
  }
}
