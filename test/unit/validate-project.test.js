import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalogFromProject, validateDbtProject } from '../../src/catalog.js';

const SCHEMA = `version: 2
models:
  - name: fct_events
    meta: { mcp: { role: events, primary_entity: event, known_events: [login] } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
      - { name: props, data_type: json, meta: { mcp: { is_event_data: true, properties: {} } } }
  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
`;
const MACRO = '{% macro mcp_relation_columns(model_name) %}{% endmacro %}\n';

// A complete-ish project; `opts` lets each test omit a required component.
function project({ macro = true, factSql = true, usersSeed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vproj-'));
  writeFileSync(join(dir, 'dbt_project.yml'), 'name: t\nprofile: t\nmodel-paths: ["models"]\nseed-paths: ["seeds"]\nmacro-paths: ["macros"]\n');
  mkdirSync(join(dir, 'models'), { recursive: true });
  writeFileSync(join(dir, 'models', 'schema.yml'), SCHEMA);
  if (factSql) writeFileSync(join(dir, 'models', 'fct_events.sql'), 'select 1');
  if (usersSeed) { mkdirSync(join(dir, 'seeds'), { recursive: true }); writeFileSync(join(dir, 'seeds', 'dim_users.csv'), 'user_id,country\n'); }
  if (macro) { mkdirSync(join(dir, 'macros'), { recursive: true }); writeFileSync(join(dir, 'macros', 'mcp.sql'), MACRO); }
  return dir;
}

test('validateDbtProject: passes when macro + model + seed nodes are present', () => {
  const dir = project();
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'postgres' });
    assert.doesNotThrow(() => validateDbtProject(dir, c));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateDbtProject: errors when the required macro is missing', () => {
  const dir = project({ macro: false });
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'postgres' });
    assert.throws(() => validateDbtProject(dir, c), /required macro 'mcp_relation_columns' is not defined/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateDbtProject: errors when a role references a missing model/seed node', () => {
  const dir = project({ usersSeed: false }); // dim_users node absent
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'postgres' });
    assert.throws(() => validateDbtProject(dir, c), /role 'users' references dbt node 'dim_users'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateDbtProject: collects multiple problems in one error', () => {
  const dir = project({ macro: false, factSql: false });
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'postgres' });
    assert.throws(() => validateDbtProject(dir, c), (e) => /mcp_relation_columns/.test(e.message) && /fct_events/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
