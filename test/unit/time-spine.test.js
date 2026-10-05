import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'duckdb' });
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

test('custom model-paths: generated dir lands under the FIRST base model-path (dbt scans it)', () => {
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'marts'), { recursive: true });
  // base uses a CUSTOM model-paths that does NOT include the default "models"
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["marts"]\n');
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'duckdb' });
  assert.deepEqual(cm.modelPaths, ['marts'], 'reads custom model-paths from the base');
  const ctx = cm.create();
  const gen = cm.generatedDir(ctx.id);
  assert.ok(gen.endsWith(join('marts', 'generated')), `generated dir under the scanned path, got ${gen}`);
  assert.ok(readdirSync(gen).includes('_mcp_time_spine.yml'), 'spine config written into the scanned path');
  assert.equal(cm.hasTimeSpine(ctx.id), true, 'the spine config is discoverable under the custom model-path');
});

test('a properly CONFIGURED time spine in base → overlay adds nothing', () => {
  const { files, generatedSpine } = overlay((m) => {
    writeFileSync(join(m, 'ts.sql'), 'select 1 as date_day\n');
    writeFileSync(join(m, 'ts.yml'), 'models:\n  - name: ts\n    time_spine: { standard_granularity_column: date_day }\n    columns: [{ name: date_day, granularity: day }]\n');
  });
  assert.ok(!files.includes('_mcp_time_spine.yml') && !files.includes('metricflow_time_spine.sql'), 'no duplicate time spine');
  assert.equal(generatedSpine, false, 'nothing generated → nothing to build');
});

test('the warehouse is read through a copy of the project of its own: a time spine there, the project\'s semantic layer left out, the project itself untouched', async () => {
  const { readFileSync } = await import('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["models"]\n');
  // a project with a semantic layer and no time spine: dbt 1.12 does not parse it as it is
  writeFileSync(join(base, 'models', 'metrics.yml'), 'metrics:\n  - name: m\n    type: simple\n');
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'duckdb' });
  const dir = cm.warehouseDir();
  assert.notEqual(dir, base, 'not the project itself');
  assert.equal(cm.warehouseDir(), dir, 'one copy per start');
  assert.ok(readdirSync(join(dir, 'models', 'generated')).includes('_mcp_time_spine.yml'), 'a time spine in the copy');
  assert.equal(readFileSync(join(dir, 'models', 'metrics.yml'), 'utf8').trim(), '', 'the project\'s semantic layer left out of the copy');
  assert.deepEqual(readdirSync(join(base, 'models')).sort(), ['metrics.yml'], 'nothing written into the project');
  assert.ok(!cm.list().some((c) => c.context_id === '_warehouse'), 'internal: not listed');
});
