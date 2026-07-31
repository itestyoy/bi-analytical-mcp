import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../../src/context-manager.js';

// A time spine is "present" only when actually CONFIGURED (`time_spine:` yml), not when a model
// merely named metricflow_time_spine exists — dbt >= 1.9 rejects a name-only model as
// "no time spine configured". And `generatedTimeSpine` tells the engine whether WE created the
// spine model (so its table must be `dbt run`) vs the base project provides it (already built).
function overlay(baseSetup) {
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["models"]\n');
  baseSetup(join(base, 'models'));
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'postgres' });
  const ctx = cm.create();
  const gen = cm.generatedDir(ctx.id);
  return { files: existsSync(gen) ? readdirSync(gen) : [], generatedSpine: cm.generatedTimeSpine(ctx.id) };
}

test('no time spine in base → overlay writes BOTH the model and config, and marks it to build', () => {
  const { files, generatedSpine } = overlay(() => {});
  assert.ok(files.includes('_mcp_time_spine.yml') && files.includes('metricflow_time_spine.sql'), 'model + config written');
  assert.equal(generatedSpine, true, 'we generated the spine → engine must dbt run it');
});

test('name-only metricflow_time_spine.sql (no config) → add ONLY the config, do not rebuild', () => {
  const { files, generatedSpine } = overlay((m) => writeFileSync(join(m, 'metricflow_time_spine.sql'), 'select 1 as date_day\n'));
  assert.ok(files.includes('_mcp_time_spine.yml') && !files.includes('metricflow_time_spine.sql'), 'config only, no duplicate model');
  assert.equal(generatedSpine, false, 'base provides the model → base built its table');
});

test('self-heal: a context missing its spine (stale/reused) re-generates it idempotently', () => {
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["models"]\n');
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'postgres' });
  const ctx = cm.create();
  const gen = cm.generatedDir(ctx.id);
  // Simulate a context persisted from BEFORE spine generation existed: strip the spine files.
  rmSync(join(gen, '_mcp_time_spine.yml'), { force: true });
  rmSync(join(gen, 'metricflow_time_spine.sql'), { force: true });
  assert.equal(cm.hasTimeSpine(ctx.id), false, 'precondition: spine is gone');
  // The engine calls ensureTimeSpine before parse/query — it must bring the spine back.
  cm.ensureTimeSpine(ctx.id);
  const files = readdirSync(gen);
  assert.ok(files.includes('_mcp_time_spine.yml') && files.includes('metricflow_time_spine.sql'), 're-generated');
  assert.equal(cm.hasTimeSpine(ctx.id), true, 'configured again');
  // Idempotent: a second call changes nothing (returns false = nothing to do).
  assert.equal(cm.ensureTimeSpine(ctx.id), false, 'second call is a no-op');
});

test('timeSpineDiagnostics reports overlay ground truth (configured vs missing)', () => {
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["models"]\n');
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'postgres' });
  const ctx = cm.create();
  const ok = cm.timeSpineDiagnostics(ctx.id);
  assert.equal(ok.time_spine_configured, true, 'freshly created context reports configured');
  assert.ok(ok.time_spine_config_files.some((f) => f.endsWith('_mcp_time_spine.yml')), 'names the config file');
  assert.equal(ok.compiled_manifest.present, false, 'no compiled manifest in this bare overlay (not parsed)');
  assert.match(ok.hint, /config IS present/);
  // strip the config → diagnostics must flip and point at the missing overlay
  rmSync(join(cm.generatedDir(ctx.id), '_mcp_time_spine.yml'), { force: true });
  rmSync(join(cm.generatedDir(ctx.id), 'metricflow_time_spine.sql'), { force: true });
  const gone = cm.timeSpineDiagnostics(ctx.id);
  assert.equal(gone.time_spine_configured, false, 'reports not configured after strip');
  assert.match(gone.hint, /was not generated/);
});

test('timeSpineDiagnostics: config present but compiled manifest has ZERO spines → decisive version hint', () => {
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["models"]\n');
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'postgres' });
  const ctx = cm.create(); // writes the time_spine: config into the overlay
  // Simulate what an OLD dbt-core (<1.9) produces: a compiled manifest that DROPPED the spine.
  mkdirSync(join(cm.dir(ctx.id), 'target'), { recursive: true });
  writeFileSync(join(cm.dir(ctx.id), 'target', 'semantic_manifest.json'),
    JSON.stringify({ semantic_models: [{ name: 'events' }], project_configuration: { time_spines: [], time_spine_table_configurations: [] } }));
  const d = cm.timeSpineDiagnostics(ctx.id);
  assert.equal(d.time_spine_configured, true, 'config file IS present in overlay');
  assert.equal(d.compiled_manifest.present, true);
  assert.equal(d.compiled_manifest.time_spines_count, 0, 'but the manifest registered none');
  assert.match(d.hint, /DECISIVE/, 'hint pins the runtime-too-old cause');
});

test('a properly CONFIGURED time spine in base → overlay adds nothing', () => {
  const { files, generatedSpine } = overlay((m) => {
    writeFileSync(join(m, 'ts.sql'), 'select 1 as date_day\n');
    writeFileSync(join(m, 'ts.yml'), 'models:\n  - name: ts\n    time_spine: { standard_granularity_column: date_day }\n    columns: [{ name: date_day, granularity: day }]\n');
  });
  assert.ok(!files.includes('_mcp_time_spine.yml') && !files.includes('metricflow_time_spine.sql'), 'no duplicate time spine');
  assert.equal(generatedSpine, false, 'nothing generated → nothing to build');
});
