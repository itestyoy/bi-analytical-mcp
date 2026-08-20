// DATA-SIDE SCAFFOLD for the future Python-executor: export a MATERIALISED query result to
// Parquet in a GCS bucket (BigQuery `EXPORT DATA`) and hand back a READ-ONLY, prefix-scoped,
// short-lived access grant. The Python sandbox never holds warehouse credentials — the trusted
// host (this process, the dbt account) runs the export; the sandbox only reads the exported
// object(s). See the design thread: host-stages / sandbox-no-network is the default; a downscoped
// read-only token (or signed URL) is for the "sandbox reads GCS directly" variant.
//
// NOT YET LIVE-VALIDATED: EXPORT DATA + GCS + STS downscoping are BigQuery/GCP-only and cannot run
// on the local PGlite test stack. Everything here is GUARDED and CONFIG-GATED: with nothing wired
// it is inert (configured() === false) and every path throws a clear, safe error rather than doing
// anything half-configured. The security-critical token minter is an INJECTED interface — there is
// deliberately no built-in default, so no unreviewed credential code can ship by accident.

// A dbt/BigQuery relation or table alias we will SELECT from — locked to a safe identifier so it
// can never inject into the EXPORT statement. (Fully-qualified `a.b.c` and `{{ ref('x') }}` allowed.)
const SAFE_RELATION = /^(\{\{\s*ref\('[a-zA-Z0-9_]+'\)\s*\}\}|[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,2}|`[^`]+`)$/;
// A per-request id used in the object prefix — url/path-safe only.
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class GcsExport {
  /**
   * @param bucket        GCS bucket name (no gs:// prefix, no slashes).
   * @param prefix        base object prefix (default 'betti-exports'); the per-request prefix is
   *                      `${prefix}/${id}`.
   * @param location      BigQuery/GCS location (e.g. 'US') — informational, passed through.
   * @param ttlSeconds    lifetime of the read-only access grant (default 900 = 15 min).
   * @param dialect       warehouse dialect; export is BigQuery-only.
   * @param runner        the dbt runner; must expose exportData(projectDir, sql) to EXECUTE (else
   *                      export() returns the PLAN with executed:false).
   * @param baseProjectDir dbt project dir passed to the runner.
   * @param tokenMinter   INJECTED read-only grant issuer: readOnlyPrefix({ bucket, prefix, ttlSeconds })
   *                      -> Promise<{ kind, expires_at, ... }>. No default (security-critical).
   * @param now           clock (ms) for expiry, injectable for tests.
   */
  constructor({ bucket = null, prefix = 'betti-exports', location = null, ttlSeconds = 900, dialect = null, runner = null, baseProjectDir = null, tokenMinter = null, now = () => Date.now() } = {}) {
    this.bucket = bucket && String(bucket).trim() ? String(bucket).trim() : null;
    this.prefix = String(prefix || 'betti-exports').replace(/^\/+|\/+$/g, '');
    this.location = location || null;
    this.ttlSeconds = Number(ttlSeconds) > 0 ? Math.floor(Number(ttlSeconds)) : 900;
    this.dialect = dialect;
    this.runner = runner;
    this.baseProjectDir = baseProjectDir;
    this.tokenMinter = tokenMinter;
    this._now = now;
    if (this.bucket && /[/\s]/.test(this.bucket)) throw new Error(`GcsExport: invalid bucket '${this.bucket}' (a bare bucket name, no gs:// or slashes)`);
  }

  /** True only when a real export could be issued: BigQuery + a configured bucket + a runner. */
  configured() {
    return !!(this.bucket && this.dialect === 'bigquery' && this.runner);
  }

  /** The per-request object prefix, e.g. betti-exports/<id>. */
  objectPrefix(id) {
    if (!SAFE_ID.test(String(id || ''))) throw new Error(`GcsExport: unsafe request id '${id}' (allowed: [A-Za-z0-9_-], 1-64 chars)`);
    return `${this.prefix}/${id}`;
  }

  /** The gs:// URI glob the export writes to (sharded parquet). */
  uriGlob(id) {
    return `gs://${this.bucket}/${this.objectPrefix(id)}/part-*.parquet`;
  }

  /** BigQuery EXPORT DATA statement writing `relation` to Parquet at `uriGlob`. `relation` is
   *  validated against SAFE_RELATION so it cannot inject; the URI is built from our own config. */
  buildExportSql(relation, uriGlob) {
    if (this.dialect !== 'bigquery') throw new Error(`GcsExport: EXPORT DATA is BigQuery-only (dialect is '${this.dialect}')`);
    if (!SAFE_RELATION.test(String(relation || ''))) throw new Error(`GcsExport: unsafe relation '${relation}'`);
    return `EXPORT DATA OPTIONS (uri = '${uriGlob}', format = 'PARQUET', overwrite = true) AS SELECT * FROM ${relation}`;
  }

  /** Mint a READ-ONLY, prefix-scoped, short-lived grant for the exported objects. Requires an
   *  injected tokenMinter — there is no default (a wrong credential scope is a security bug). */
  async _grant(objectPrefix) {
    if (!this.tokenMinter || typeof this.tokenMinter.readOnlyPrefix !== 'function') {
      throw new Error('GcsExport: no token minter configured — inject a reviewed read-only GCS grant issuer (downscoped STS token or signed URL) before issuing access');
    }
    const grant = await this.tokenMinter.readOnlyPrefix({ bucket: this.bucket, prefix: objectPrefix, ttlSeconds: this.ttlSeconds });
    return { expires_at: new Date(this._now() + this.ttlSeconds * 1000).toISOString(), ...grant };
  }

  /**
   * Export a materialised result to Parquet and return where it landed + the read-only grant.
   * If the runner cannot execute EXPORT yet (no exportData), returns the PLAN with executed:false
   * so the data-side contract is usable/inspectable before the BigQuery execution is wired.
   */
  async export({ id, relation, withGrant = true }) {
    if (!this.configured()) throw new Error(`GcsExport: not configured (need dialect=bigquery, MCP_EXPORT_BUCKET, and a runner). dialect='${this.dialect}', bucket=${this.bucket ? "'set'" : 'unset'}`);
    const objectPrefix = this.objectPrefix(id);
    const uriGlob = this.uriGlob(id);
    const sql = this.buildExportSql(relation, uriGlob);
    const out = { format: 'parquet', bucket: this.bucket, ...(this.location ? { location: this.location } : {}), object_prefix: objectPrefix, uri: uriGlob };
    if (typeof this.runner.exportData === 'function') {
      const r = await this.runner.exportData(this.baseProjectDir, sql);
      if (!r?.ok) { out.executed = false; out.error = r?.error || r?.stderr || 'export failed'; return out; }
      out.executed = true;
    } else {
      out.executed = false;
      out.note = 'runner cannot execute EXPORT DATA yet (no exportData()); returning the export PLAN only';
      out.plan_sql = sql;
    }
    if (withGrant && out.executed) out.access = await this._grant(objectPrefix);
    return out;
  }
}
