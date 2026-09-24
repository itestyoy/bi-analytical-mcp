// Programmatic query backend: keeps a warm Python MetricFlow sidecar
// (python/mf_sidecar.py) and talks to it over stdio — the same contract as the dbt client
// (src/dbt/index.js), so it's a drop-in alternative that avoids `mf` CLI cold-starts and returns
// structured results.
//
// Everything but `query` is the dbt client's (parse writes the semantic manifest the sidecar reads);
// `query` goes through the persistent sidecar — taking the warehouse's turn like any dbt process
// when the warehouse admits one process at a time (DuckDB), and the sidecar lets go of the database
// after each request.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createDbt } from '../dbt/index.js';
import { warehouseTurns } from '../dbt/process.js';
import { currentSignal } from '../request-context.js';
// the sidecar script is a non-JS runtime asset — see src/runtime-assets.js for why it lives there
import { assetPath, missingAssetMessage } from '../runtime-assets.js';

export class MfEngineBackend {
  constructor({ pythonBin = 'python', dbtBin = 'dbt', profilesDir, timeout = 600000, version = 'auto' } = {}) {
    this.pythonBin = pythonBin;
    this.profilesDir = profilesDir;
    this.timeout = timeout;
    this._dbt = createDbt({ version, dbtBin, profilesDir, timeout });
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

  async seed(projectDir) {
    return this._dbt.seed(projectDir);
  }

  async show(projectDir, sql, limit, timeout) {
    return this._dbt.show(projectDir, sql, limit, timeout);
  }

  async validate(projectDir) {
    return this._dbt.validate(projectDir);
  }

  warehouse(projectDir) {
    return this._dbt.warehouse(projectDir);
  }

  get major() { return this._dbt.major; }

  get semanticSpec() { return this._dbt.semanticSpec; }

  pythonModelsOn(adapter) { return this._dbt.pythonModelsOn(adapter); }

  /** One sidecar request, in the warehouse's turn when it takes one process at a time. */
  _request(projectDir, req) {
    const { turn } = this._dbt.warehouse(projectDir);
    if (!turn) return this._send(req);
    return warehouseTurns.run(turn, () => this._send(req), currentSignal()).catch((e) => ({ ok: false, error: e?.message || 'cancelled' }));
  }

  async relationColumns(projectDir, modelName) {
    return this._dbt.relationColumns(projectDir, modelName);
  }

  async query(projectDir, opts) {
    // a cancelled task starts nothing (the sidecar cannot be interrupted once a request is in it)
    if (currentSignal()?.aborted) return { ok: false, cancelled: true, command: 'mf query (sidecar)', columns: [], rows: [], stdout: '', stderr: 'not started — the task was cancelled' };
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
      const r = await this._request(projectDir, { op: 'explain', ...base, plan: !!opts.plan });
      return { ok: !!r.ok, command: 'mf_sidecar.explain', sql: r.sql, plan: r.plan, stderr: r.error };
    }
    const r = await this._request(projectDir, { op: 'query', ...base });
    if (!r.ok) return { ok: false, command: 'mf_sidecar.query', stderr: r.error, columns: [], rows: [] };
    const columns = (r.columns || []).map((name) => ({ name }));
    const rows = (r.rows || []).map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
    return { ok: true, command: 'mf_sidecar.query', columns, rows };
  }

  close() {
    if (this._proc) { this._proc.stdin.end(); this._proc.kill(); this._proc = null; }
  }
}
