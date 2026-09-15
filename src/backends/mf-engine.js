// Programmatic query backend: keeps a warm Python MetricFlow sidecar
// (python/mf_sidecar.py) and talks to it over stdio — same parse()/query()
// contract as DbtRunner, so it's a drop-in alternative that avoids `mf` CLI
// cold-starts and returns structured results.
//
// `parse` still uses `dbt parse` (writes the semantic manifest the engine reads);
// `query` goes through the persistent sidecar.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DbtRunner } from '../dbt-runner.js';
// the sidecar script is a non-JS runtime asset — see src/runtime-assets.js for why it lives there
import { assetPath, missingAssetMessage } from '../runtime-assets.js';

export class MfEngineBackend {
  constructor({ pythonBin = 'python', dbtBin = 'dbt', profilesDir, timeout = 600000 } = {}) {
    this.pythonBin = pythonBin;
    this.profilesDir = profilesDir;
    this.timeout = timeout;
    this._dbt = new DbtRunner({ dbtBin, profilesDir, timeout });
    this._proc = null;
    this._pending = new Map();
    this._seq = 0;
  }

  _ensureProc() {
    if (this._proc) return;
    // A build without python/ cannot start the sidecar at all; say so as a packaging defect
    // rather than letting the spawn fail with a bare "exit 2".
    const sidecar = assetPath('mfSidecar');
    if (!sidecar) throw new Error(missingAssetMessage('mfSidecar'));
    const proc = spawn(this.pythonBin, [sidecar], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr.on('data', () => {}); // sidecar diagnostics; ignore
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = this._pending.get(msg.id);
      if (p) { this._pending.delete(msg.id); p(msg); }
    });
    proc.on('exit', () => {
      this._proc = null;
      for (const [, p] of this._pending) p({ ok: false, error: 'sidecar exited' });
      this._pending.clear();
    });
    this._proc = proc;
  }

  _send(req) {
    this._ensureProc();
    const id = `r${++this._seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) resolve({ ok: false, error: 'sidecar timeout' });
      }, this.timeout);
      this._pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this._proc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  async parse(projectDir) {
    return this._dbt.parse(projectDir);
  }

  async run(projectDir, select) {
    return this._dbt.run(projectDir, select);
  }

  async show(projectDir, sql, limit) {
    return this._dbt.show(projectDir, sql, limit);
  }

  async relationColumns(projectDir, modelName) {
    return this._dbt.relationColumns(projectDir, modelName);
  }

  async query(projectDir, opts) {
    const base = {
      project_dir: projectDir,
      profiles_dir: this.profilesDir,
      metrics: opts.metrics,
      group_by: opts.groupBy,
      where: opts.where,
      order: opts.orderBy,
      limit: opts.limit,
      start: opts.startTime,
      end: opts.endTime,
    };
    if (opts.explain) {
      const r = await this._send({ op: 'explain', ...base, plan: !!opts.plan });
      return { ok: !!r.ok, command: 'mf_sidecar.explain', sql: r.sql, plan: r.plan, stderr: r.error };
    }
    const r = await this._send({ op: 'query', ...base });
    if (!r.ok) return { ok: false, command: 'mf_sidecar.query', stderr: r.error, columns: [], rows: [] };
    const columns = (r.columns || []).map((name) => ({ name }));
    const rows = (r.rows || []).map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
    return { ok: true, command: 'mf_sidecar.query', columns, rows };
  }

  close() {
    if (this._proc) { this._proc.stdin.end(); this._proc.kill(); this._proc = null; }
  }
}
