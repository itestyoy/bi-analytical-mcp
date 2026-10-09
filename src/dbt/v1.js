// dbt 1.x — the `dbt` CLI (dbt-core) for parse / run / show / seed / run-operation, and MetricFlow's
// `mf` CLI for metric queries (it reads target/semantic_manifest.json, which `dbt parse` writes).
// Each context runs in its own overlay project dir, so target/ is naturally isolated. NOT
// `dbt sl query` (that is dbt platform/remote and incompatible with local per-context isolation).

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inIsolatedTarget } from '../request-context.js';
import { runProcess, runWithInput } from './process.js';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { warehouseOf } from './warehouse.js';
import { knownDbtVersion } from './version.js';
import { parseShowJson, parseCsv, extractSql, extractPlan, stripAnsi, SEMANTIC_MANIFEST } from './output.js';
import yaml from 'js-yaml';

const CUMULATIVE_FLAG = 'require_nested_cumulative_type_params';

/**
 * dbt_project.yml's text with `flags.require_nested_cumulative_type_params` set to false, and nothing
 * else changed: the value of the key's line replaced, the key put first into the top-level `flags:`
 * mapping (block or flow), or a `flags:` block appended. The TEXT is edited, never re-dumped — dbt
 * reads the file as YAML 1.1 (yes/no are booleans, a date stays a date) and a YAML 1.2 dump would
 * change those values. The edit is held to the text it came from: loaded, the two must be the same
 * document but for that flag being false, or the text is returned as it was. Idempotent.
 */
export function withCumulativeWindowFlag(text) {
  // duplicate keys are taken as dbt's loader takes them: the last one wins
  const load = (t) => yaml.load(t, { json: true });
  let before;
  try { before = load(text); } catch { return text; }
  if (before == null) before = {};
  if (typeof before !== 'object' || Array.isArray(before)) return text;
  if (before.flags != null && (typeof before.flags !== 'object' || Array.isArray(before.flags))) return text;
  if (before.flags?.[CUMULATIVE_FLAG] === false) return text;
  const has = !!before.flags && Object.hasOwn(before.flags, CUMULATIVE_FLAG);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n');
  const top = lines.findIndex((l) => /^(["']?)flags\1[ \t]*:(?=[ \t\r]|$)/.test(l));
  let next = null;
  if (top < 0) {
    if (before.flags !== undefined) return text;
    next = `${text}${text === '' || text.endsWith('\n') ? '' : eol}flags:${eol}  ${CUMULATIVE_FLAG}: false${eol}`;
  } else {
    const rest = lines[top].slice(lines[top].indexOf(':') + 1).replace(/\r$/, '');
    const value = rest.replace(/(^|[ \t])#.*$/, '').trim();
    if (value.startsWith('{')) {
      // a flow mapping, on this line or over the next: the key's value replaced, or the key put first
      const at = lines.slice(0, top).join('\n').length + (top ? 1 : 0) + lines[top].indexOf('{');
      const head = text.slice(0, at + 1);
      const tail = text.slice(at + 1);
      if (has) next = head + tail.replace(new RegExp(`((["']?)${CUMULATIVE_FLAG}\\2[ \\t]*:[ \\t]*)[^,}\\s#]+`), '$1false');
      else next = /^\s*}/.test(tail) ? `${head} ${CUMULATIVE_FLAG}: false ${tail.trimStart()}` : `${head} ${CUMULATIVE_FLAG}: false,${tail}`;
    } else if (value === '') {
      // a block mapping: its lines run to the next line at the left margin that is not a comment
      let end = top + 1;
      while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
      const child = lines.slice(top + 1, end).find((l) => /^[ \t]+[^\s#]/.test(l));
      const indent = child ? child.match(/^[ \t]+/)[0] : '  ';
      const cr = lines[top].endsWith('\r') ? '\r' : '';
      const keyLine = new RegExp(`^(${indent}(["']?)${CUMULATIVE_FLAG}\\2[ \\t]*:)([ \\t]*)([^#\\r]*?)([ \\t]*(?:#.*)?\\r?)$`);
      const out = [...lines];
      if (has) {
        const i = out.findIndex((l, k) => k > top && k < end && keyLine.test(l));
        if (i < 0) return text;
        out[i] = out[i].replace(keyLine, (_, key, _q, sp, _v, tail) => `${key}${sp || ' '}false${tail}`);
      } else out.splice(top + 1, 0, `${indent}${CUMULATIVE_FLAG}: false${cr}`);
      next = out.join('\n');
    } else if (/^(?:~|null|Null|NULL)$/.test(value)) {
      // `flags: ~` — an empty mapping written as null: the null taken off, the key the block's one line
      const out = [...lines];
      const cr = lines[top].endsWith('\r') ? '\r' : '';
      out[top] = lines[top].replace(/:([ \t]*)(?:~|null|Null|NULL)/, ':$1');
      out.splice(top + 1, 0, `  ${CUMULATIVE_FLAG}: false${cr}`);
      next = out.join('\n');
    } else return text;
  }
  try {
    const after = load(next);
    const want = { ...before, flags: { ...(before.flags || {}), [CUMULATIVE_FLAG]: false } };
    return isDeepStrictEqual(after, want) ? next : text;
  } catch { return text; }
}

/**
 * dbt 1.12's parse of the LATEST spec writes a cumulative metric's window twice — into its
 * cumulative_type_params and into the deprecated type_params.window — and its own validation then
 * refuses the metric for the deprecated one (the `require_nested_cumulative_type_params` behavior
 * flag, on by default): no cumulative metric with a window parses. The flag is read from
 * dbt_project.yml alone, so the copy a context parses carries it off — whatever the project set,
 * since the semantic YAML that copy parses is the server's (off, the deprecated field is a warning).
 * Written only into the directory the parse runs in — a context's own copy of the project.
 */
function allowLatestCumulativeWindow(projectDir) {
  const file = join(projectDir, 'dbt_project.yml');
  try {
    const text = readFileSync(file, 'utf8');
    const next = withCumulativeWindowFlag(text);
    if (next !== text) writeFileSync(file, next);
  } catch { /* a project dbt cannot read is the parse's to report */ }
}

/**
 * The one correction a semantic manifest parsed from the LATEST spec needs: a percentile is written
 * as approximate, its fraction rounded to float32 (0.9 → 0.8999999761581421), whatever the YAML said.
 * A metric's `config.meta.mcp_percentile` records what was asked (src/semantic-latest.js) and is put
 * back, so a percentile answers the same whichever dbt parsed it. Nothing to do without that meta.
 */
function restorePercentiles(file) {
  if (!existsSync(file)) return;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    let changed = false;
    for (const m of manifest.metrics || []) {
      const asked = m.config?.meta?.mcp_percentile;
      const params = m.type_params?.metric_aggregation_params?.agg_params;
      if (!asked || !params) continue;
      Object.assign(params, { percentile: asked.percentile, use_discrete_percentile: !!asked.discrete, use_approximate_percentile: !!asked.approximate });
      changed = true;
    }
    if (changed) writeFileSync(file, JSON.stringify(manifest));
  } catch { /* an unreadable manifest is MetricFlow's to report */ }
}

export class DbtV1 {
  constructor({ dbtBin, mfBin, pythonBin, profilesDir, timeout = 600000 } = {}) {
    this.dbtBin = dbtBin;
    this.mfBin = mfBin;
    this.pythonBin = pythonBin;
    this.profilesDir = profilesDir;
    this.timeout = timeout;
    this.major = 1;
  }

  /** The semantic-layer YAML this server writes for this dbt: the latest spec from dbt 1.12, which reads it
   *  (one rendering with dbt v2's); the legacy spec before it, which is all an older 1.x knows. */
  get semanticSpec() {
    const [major, minor] = String(knownDbtVersion(this.dbtBin) || '').split('.').map(Number);
    return major === 1 && minor >= 12 ? 'latest' : 'legacy';
  }

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
    if (this.semanticSpec === 'latest') allowLatestCumulativeWindow(projectDir);
    const r = await this._proc(this.dbtBin, projectDir, ['parse']);
    const file = join(projectDir, ...SEMANTIC_MANIFEST);
    if (r.ok && this.semanticSpec === 'latest') restorePercentiles(file);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, manifest: existsSync(file) };
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
  /** `dbt run` of `select`; `{ empty: true }` runs it with every ref and source limited to zero rows
   *  (`--empty`): the SQL is compiled and run by the warehouse, which reads no data. */
  async run(projectDir, select, { empty = false } = {}) {
    const args = ['run'];
    if (select) args.push('--select', select);
    if (empty) args.push('--empty');
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
