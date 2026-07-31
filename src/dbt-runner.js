// Thin wrapper around dbt Core: `dbt parse` (rebuild semantic manifest) and
// `mf query` (MetricFlow). Each context runs in its own overlay project dir, so
// target/ is naturally isolated. NOT `dbt sl query` (that is dbt platform/remote
// and incompatible with local per-context isolation).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(bin, args, { cwd, env, timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // The useful failure fact JS gives us is killed/signal/code — NOT err.message/err.stack,
      // which is just the "Command failed: <whole command>" + node-internal-stack wrapper.
      // A killed/SIGTERM exit means the runner timeout fired (the query never finished); a
      // non-zero exit means dbt itself failed and printed the real reason to stdout/stderr.
      let error;
      if (err) {
        error = (err.killed || err.signal)
          ? `dbt killed by ${err.signal || 'signal'} — hit the ${timeout}ms runner timeout (query did not finish)`
          : `dbt exited with code ${err.code}`;
      }
      resolve({ ok: !err, code: err?.code ?? 0, killed: !!err?.killed, signal: err?.signal ?? null, stdout: stdout || '', stderr: stderr || '', error });
    });
  });
}

export class DbtRunner {
  constructor({ dbtBin = 'dbt', mfBin = 'mf', profilesDir, timeout = 600000 } = {}) {
    this.dbtBin = dbtBin;
    this.mfBin = mfBin;
    this.profilesDir = profilesDir;
    this.timeout = timeout;
  }

  _env(projectDir) {
    const env = { DBT_PROJECT_DIR: projectDir };
    if (this.profilesDir) env.DBT_PROFILES_DIR = this.profilesDir;
    return env;
  }

  async parse(projectDir) {
    const r = await run(this.dbtBin, ['parse'], { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, manifest: existsSync(join(projectDir, 'target', 'semantic_manifest.json')) };
  }

  /**
   * Report the installed dbt-core + MetricFlow versions (cached). Used to diagnose the
   * "no time spine configured" failure: the modern `time_spine:` model property only registers
   * on dbt-core >= 1.9, so an older runtime silently drops the config even when the files exist.
   */
  async version() {
    if (this._version) return this._version;
    const clean = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
    let dbt = null; let mf = null;
    try { const r = await run(this.dbtBin, ['--version'], { timeout: 30000 }); dbt = clean(r.stdout || r.stderr).trim() || null; } catch { /* ignore */ }
    try { const r = await run(this.mfBin, ['--version'], { timeout: 30000 }); mf = clean(r.stdout || r.stderr).trim() || null; } catch { /* ignore */ }
    return (this._version = { dbt, mf });
  }

  /** Build a model (e.g. a generated MATCH_RECOGNIZE view) via `dbt run --select`. */
  async run(projectDir, select) {
    const args = ['run'];
    if (select) args.push('--select', select);
    const r = await run(this.dbtBin, args, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
  }

  /** Real physical columns of a model's relation, via adapter.get_columns_in_relation. */
  async relationColumns(projectDir, modelName) {
    const args = ['run-operation', 'mcp_relation_columns', '--args', JSON.stringify({ model_name: modelName })];
    const r = await run(this.dbtBin, args, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
    if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr };
    const m = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').match(/MCP_COLS:(\[[^\n]*\])/);
    if (!m) return { ok: false, stdout: r.stdout };
    try { return { ok: true, columns: JSON.parse(m[1]) }; } catch { return { ok: false, stdout: r.stdout }; }
  }

  /**
   * Run a simple SQL against the warehouse and return rows (dbt show --output json).
   * `timeout` overrides the runner default for THIS call — heavy value-index scans pass a
   * larger one so a full-table aggregate isn't killed mid-flight (the SIGTERM-timeout case).
   */
  async show(projectDir, sql, limit = 1000, timeout = this.timeout) {
    const args = ['show', '--inline', sql, '--output', 'json', '--limit', String(limit)];
    const r = await run(this.dbtBin, args, { cwd: projectDir, env: this._env(projectDir), timeout });
    // Preserve r.error (the process-level message from execFile: timeout, ENOENT, spawn
    // failure) so callers can log the REAL reason from ANY level — not just dbt's own stderr.
    if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr, error: r.error, rows: [], columns: [] };
    const rows = parseShowJson(r.stdout);
    return { ok: true, rows, columns: rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [] };
  }

  async validate(projectDir) {
    const r = await run(this.mfBin, ['validate-configs'], { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
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

  async query(projectDir, opts) {
    if (opts.explain) {
      const args = this.buildQueryArgs({ ...opts, explain: true, plan: opts.plan });
      const r = await run(this.mfBin, args, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
      return { ok: r.ok, command: `mf ${args.join(' ')}`, sql: extractSql(r.stdout), ...(opts.plan ? { plan: extractPlan(r.stdout) } : {}), stdout: r.stdout, stderr: r.stderr };
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'mfq-'));
    const csvFile = join(tmpDir, 'out.csv');
    const args = this.buildQueryArgs({ ...opts, csvFile });
    try {
      const r = await run(this.mfBin, args, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
      let columns = [];
      let rows = [];
      if (r.ok && existsSync(csvFile)) ({ columns, rows } = parseCsv(readFileSync(csvFile, 'utf8')));
      return { ok: r.ok, command: `mf ${args.join(' ')}`, columns, rows, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true }); // don't leak per-query temp dirs
    }
  }
}

/**
 * Turn raw dbt/mf stdout+stderr into a clean, complete error message:
 * strips ANSI colors and dbt log timestamps, and surfaces the meaningful part
 * (from the first Error/Database Error/Parsing Error marker onward).
 */
export function formatDbtError(stdout = '', stderr = '') {
  const raw = `${stderr || ''}\n${stdout || ''}`;
  const cleaned = raw
    .replace(/\[[0-9;]*m/g, '') // ANSI color codes
    .split('\n')
    .map((l) => l.replace(/^\s*\d{2}:\d{2}:\d{2}(\.\d+)?\s+/, '').replace(/\s+$/, '')) // dbt log timestamps
    .filter((l) => l.trim() !== '');
  const lines = cleaned;
  // dbt boilerplate we never want in the surfaced message.
  const noise = /^(Running with dbt|Registered adapter|Unable to do partial parsing|Starting full parse|Performance info|Found \d|Concurrency:|Sending event|Flushing usage|Update available|Your version of dbt|You can find instructions|Core:|Plugins:|- installed:|- latest:|Installed:)/i;
  const markers = /(Database Error|Parsing Error|Compilation Error|Runtime Error|Validation Error|Encountered an error|ERROR:)/;
  const mi = lines.findIndex((l) => markers.test(l));
  let start = 0;
  if (mi >= 0) {
    // CRUCIAL: dbt prints the SPECIFIC rule (e.g. "The semantic model `users` ... is invalid") on
    // the line(s) just BEFORE "Encountered an error" / "Semantic Manifest validation failed".
    // Slicing only from the marker throws that detail away — walk back over the detail lines,
    // stopping at the first boilerplate line, and keep them.
    start = mi;
    while (start > 0 && !noise.test(lines[start - 1])) start--;
  } else {
    while (start < lines.length && noise.test(lines[start])) start++; // no marker → drop leading boilerplate
  }
  // Trim the trailing deprecation summary that otherwise buries the real message (the live case had
  // "PropertyMovedToConfigDeprecation: 184 occurrences" appended after the validation failure).
  let end = lines.length;
  const di = lines.findIndex((l, i) => i >= start && /\[WARNING\]\[DeprecationsSummary\]|Summary of encountered deprecations/i.test(l));
  if (di > start) end = di;
  const msg = lines.slice(start, end).join('\n').trim();
  return msg.slice(0, 8000) || 'unknown dbt error';
}

function extractSql(stdout) {
  // mf --explain prints prose then the SQL; return everything from the first SELECT/WITH.
  const idx = stdout.search(/\b(with|select)\b/i);
  return idx >= 0 ? stdout.slice(idx).trim() : stdout.trim();
}

function extractPlan(stdout) {
  // With --show-dataflow-plan the plan is printed BEFORE the SQL; return the
  // cleaned text preceding the first SELECT/WITH (ANSI/timestamps stripped).
  const cleaned = (stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const idx = cleaned.search(/\b(with|select)\b/i);
  const planText = (idx >= 0 ? cleaned.slice(0, idx) : cleaned).trim();
  return planText ? { dataflow_plan: planText.slice(0, 20000) } : undefined;
}

/** Parse `dbt show --output json` stdout: logs then { "show": [ {col:val}, ... ] }. */
export function parseShowJson(stdout) {
  const cleaned = (stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) return [];
  try {
    return JSON.parse(cleaned.slice(start, end + 1)).show || [];
  } catch {
    return [];
  }
}

/** Minimal CSV parser (handles quoted fields with commas/quotes/newlines). */
export function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  if (!records.length) return { columns: [], rows: [] };
  const header = records[0];
  const columns = header.map((name) => ({ name }));
  const rows = records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  return { columns, rows };
}
