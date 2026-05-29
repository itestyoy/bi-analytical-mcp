// Thin wrapper around dbt Core: `dbt parse` (rebuild semantic manifest) and
// `mf query` (MetricFlow). Each context runs in its own overlay project dir, so
// target/ is naturally isolated. NOT `dbt sl query` (that is dbt platform/remote
// and incompatible with local per-context isolation).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(bin, args, { cwd, env, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', error: err?.message });
    });
  });
}

export class DbtRunner {
  constructor({ dbtBin = 'dbt', mfBin = 'mf', profilesDir, timeout = 180000 } = {}) {
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

  async validate(projectDir) {
    const r = await run(this.mfBin, ['validate-configs'], { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
  }

  buildQueryArgs({ metrics, groupBy = [], where = [], orderBy = [], startTime, endTime, limit, csvFile, explain }) {
    const args = ['query', '--metrics', metrics.join(',')];
    if (groupBy.length) args.push('--group-by', groupBy.join(','));
    for (const w of where) args.push('--where', w);
    if (orderBy.length) args.push('--order', orderBy.join(',')); // mf uses --order (dbt sl uses --order-by)
    if (startTime) args.push('--start-time', startTime);
    if (endTime) args.push('--end-time', endTime);
    if (typeof limit === 'number') args.push('--limit', String(limit));
    if (explain) args.push('--explain');
    else if (csvFile) args.push('--csv', csvFile);
    return args;
  }

  async query(projectDir, opts) {
    if (opts.explain) {
      const args = this.buildQueryArgs({ ...opts, explain: true });
      const r = await run(this.mfBin, args, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
      return { ok: r.ok, command: `mf ${args.join(' ')}`, sql: extractSql(r.stdout), stdout: r.stdout, stderr: r.stderr };
    }
    const csvFile = join(mkdtempSync(join(tmpdir(), 'mfq-')), 'out.csv');
    const args = this.buildQueryArgs({ ...opts, csvFile });
    const r = await run(this.mfBin, args, { cwd: projectDir, env: this._env(projectDir), timeout: this.timeout });
    let columns = [];
    let rows = [];
    if (r.ok && existsSync(csvFile)) ({ columns, rows } = parseCsv(readFileSync(csvFile, 'utf8')));
    return { ok: r.ok, command: `mf ${args.join(' ')}`, columns, rows, stdout: r.stdout, stderr: r.stderr };
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
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim();
  const markers = /(Database Error|Parsing Error|Compilation Error|Runtime Error|Validation Error|Encountered an error|ERROR:)/;
  const m = cleaned.search(markers);
  const msg = m >= 0 ? cleaned.slice(m) : cleaned;
  return msg.slice(0, 8000) || 'unknown dbt error';
}

function extractSql(stdout) {
  // mf --explain prints prose then the SQL; return everything from the first SELECT/WITH.
  const idx = stdout.search(/\b(with|select)\b/i);
  return idx >= 0 ? stdout.slice(idx).trim() : stdout.trim();
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
