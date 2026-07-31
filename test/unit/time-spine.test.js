import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../../src/context-manager.js';

// A time spine is "present" only when actually CONFIGURED (`time_spine:` yml), not when a model
// merely named metricflow_time_spine exists — dbt >= 1.9 rejects a name-only model as
// "no time spine configured". ensureTimeSpine must therefore add the config in that case.
function overlayFiles(baseSetup) {
  const base = mkdtempSync(join(tmpdir(), 'ts-base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'dbt_project.yml'), 'name: b\nprofile: b\nversion: "1"\nconfig-version: 2\nmodel-paths: ["models"]\n');
  baseSetup(join(base, 'models'));
  const cm = new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'ts-ws-')), timeSpineDialect: 'postgres' });
  const ctx = cm.create();
  const gen = cm.generatedDir(ctx.id);
  return existsSync(gen) ? readdirSync(gen) : [];
}

test('no time spine in base → overlay writes BOTH the model and the config', () => {
  const f = overlayFiles(() => {});
  assert.ok(f.includes('_mcp_time_spine.yml'), 'config written');
  assert.ok(f.includes('metricflow_time_spine.sql'), 'model written');
});

test('name-only metricflow_time_spine.sql (no config) → overlay adds ONLY the config, no duplicate model', () => {
  const f = overlayFiles((m) => writeFileSync(join(m, 'metricflow_time_spine.sql'), 'select 1 as date_day\n'));
  assert.ok(f.includes('_mcp_time_spine.yml'), 'config added to make the existing model a time spine');
  assert.ok(!f.includes('metricflow_time_spine.sql'), 'no second model file (would duplicate the name)');
});

test('a properly CONFIGURED time spine in base → overlay adds nothing', () => {
  const f = overlayFiles((m) => {
    writeFileSync(join(m, 'ts.sql'), 'select 1 as date_day\n');
    writeFileSync(join(m, 'ts.yml'), 'models:\n  - name: ts\n    time_spine: { standard_granularity_column: date_day }\n    columns: [{ name: date_day, granularity: day }]\n');
  });
  assert.ok(!f.includes('_mcp_time_spine.yml') && !f.includes('metricflow_time_spine.sql'), 'no duplicate time spine');
});
