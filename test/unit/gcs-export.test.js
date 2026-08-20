import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcsExport } from '../../src/gcs-export.js';

// Input-validation + config-lifecycle checks only (allowed): EXPORT DATA / GCS / STS are
// BigQuery/GCP-only and cannot run on the local stack, so this asserts the GUARDS — the scaffold
// is inert until configured, rejects injection, and never issues a grant without a real minter.
// (We do NOT assert query correctness via generated SQL — only the safety guards around it.)

const bqCfg = (over = {}) => ({ bucket: 'betti-sandbox', dialect: 'bigquery', runner: {}, baseProjectDir: '/x', ...over });

test('inert until configured: non-bigquery, no bucket, or no runner → configured() false', () => {
  assert.equal(new GcsExport({ dialect: 'postgres', bucket: 'b', runner: {} }).configured(), false, 'postgres → off');
  assert.equal(new GcsExport({ dialect: 'bigquery', runner: {} }).configured(), false, 'no bucket → off');
  assert.equal(new GcsExport({ dialect: 'bigquery', bucket: 'b' }).configured(), false, 'no runner → off');
  assert.equal(new GcsExport(bqCfg()).configured(), true, 'bigquery + bucket + runner → on');
});

test('bucket must be a bare name (no gs:// / slashes)', () => {
  assert.throws(() => new GcsExport({ bucket: 'gs://b/x' }), /invalid bucket/);
  assert.throws(() => new GcsExport({ bucket: 'b/sub' }), /invalid bucket/);
});

test('export() throws (not silently no-ops) when unconfigured', async () => {
  await assert.rejects(() => new GcsExport({ dialect: 'postgres', bucket: 'b', runner: {} }).export({ id: 'r1', relation: 't' }), /not configured/);
});

test('per-request prefix + uri are safe and scoped; unsafe id rejected', () => {
  const g = new GcsExport(bqCfg({ prefix: 'exp' }));
  assert.equal(g.objectPrefix('req_1'), 'exp/req_1');
  assert.equal(g.uriGlob('req_1'), "gs://betti-sandbox/exp/req_1/part-*.parquet");
  assert.throws(() => g.objectPrefix('../etc'), /unsafe request id/);
  assert.throws(() => g.objectPrefix('a/b'), /unsafe request id/);
});

test('buildExportSql rejects an injecting relation and requires bigquery', () => {
  const g = new GcsExport(bqCfg());
  assert.throws(() => g.buildExportSql("t; DROP TABLE x; --", g.uriGlob('r1')), /unsafe relation/);
  assert.throws(() => g.buildExportSql('a.b.c.d.e', g.uriGlob('r1')), /unsafe relation/); // too many parts
  // a plain relation, a fully-qualified one, and a dbt ref are accepted (no throw).
  for (const rel of ['qr_abc', 'proj.ds.qr_abc', "{{ ref('qr_abc') }}"]) g.buildExportSql(rel, g.uriGlob('r1'));
  assert.throws(() => new GcsExport(bqCfg({ dialect: 'postgres' })).buildExportSql('t', 'gs://b/x'), /BigQuery-only/);
});

test('no grant is issued without an injected token minter (fails safe)', async () => {
  const runner = { exportData: async () => ({ ok: true }) };
  const g = new GcsExport(bqCfg({ runner }));
  await assert.rejects(() => g.export({ id: 'r1', relation: 'qr_abc' }), /no token minter configured/);
});

test('with a runner that cannot export yet → returns the PLAN (executed:false), no grant', async () => {
  const g = new GcsExport(bqCfg({ runner: {} })); // runner has no exportData()
  const r = await g.export({ id: 'r1', relation: 'qr_abc' });
  assert.equal(r.executed, false);
  assert.equal(r.format, 'parquet');
  assert.equal(r.uri, 'gs://betti-sandbox/betti-exports/r1/part-*.parquet');
  assert.ok(r.plan_sql && /EXPORT DATA/.test(r.plan_sql), 'plan carries the export statement');
  assert.equal(r.access, undefined, 'no access grant when nothing was exported');
});

test('executed export mints a read-only, prefix-scoped, expiring grant', async () => {
  const calls = [];
  const tokenMinter = { readOnlyPrefix: async (a) => { calls.push(a); return { kind: 'downscoped_token', token: 'REDACTED', scope: `${a.bucket}/${a.prefix}` }; } };
  const runner = { exportData: async () => ({ ok: true }) };
  const g = new GcsExport(bqCfg({ runner, tokenMinter, ttlSeconds: 600, now: () => 1_000_000 }));
  const r = await g.export({ id: 'req9', relation: 'qr_abc' });
  assert.equal(r.executed, true);
  assert.deepEqual(calls, [{ bucket: 'betti-sandbox', prefix: 'betti-exports/req9', ttlSeconds: 600 }], 'grant scoped to THIS request prefix, read-only, with the TTL');
  assert.equal(r.access.kind, 'downscoped_token');
  assert.equal(r.access.scope, 'betti-sandbox/betti-exports/req9');
  assert.equal(r.access.expires_at, new Date(1_000_000 + 600_000).toISOString(), 'expiry = now + ttl');
});

test('a failed export surfaces the error and issues NO grant', async () => {
  let minted = false;
  const tokenMinter = { readOnlyPrefix: async () => { minted = true; return {}; } };
  const runner = { exportData: async () => ({ ok: false, error: 'bq: quota exceeded' }) };
  const g = new GcsExport(bqCfg({ runner, tokenMinter }));
  const r = await g.export({ id: 'r1', relation: 'qr_abc' });
  assert.equal(r.executed, false);
  assert.match(r.error, /quota exceeded/);
  assert.equal(minted, false, 'no read grant is minted for a failed export');
});
