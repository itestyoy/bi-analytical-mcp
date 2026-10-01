import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, loadCatalogFromProject } from '../../src/catalog.js';

// Build a throwaway dbt project: dbt_project.yml + schema YAML(s) under models/.
function project(schemaFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  writeFileSync(join(dir, 'dbt_project.yml'), 'name: test\nprofile: test\nmodel-paths: ["models"]\n');
  const mdir = join(dir, 'models');
  mkdirSync(mdir, { recursive: true });
  for (const [name, body] of Object.entries(schemaFiles)) writeFileSync(join(mdir, name), body);
  return dir;
}

const eventsYml = `version: 2
models:
  - name: fct_events
    config: { meta: { mcp: { role: events, primary_entity: event, known_events: [login, purchase] } } }
    columns:
      - { name: user_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: foreign } } } } }
      - { name: ts, data_type: timestamp, config: { meta: { mcp: { is_time: true } } } }
      - { name: event_name, data_type: string, config: { meta: { mcp: { is_event_name: true } } } }
      - { name: props, data_type: json, config: { meta: { mcp: { is_event_data: true, properties: { amount: { type: numeric } } } } } }
`;
const usersYml = `version: 2
models:
  - name: dim_users
    config: { meta: { mcp: { role: users } } }
    columns:
      - { name: user_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: primary } } } } }
      - { name: country, data_type: string }
`;

test('loadCatalogFromProject: discovers MCP models from the dbt project schema YAMLs', () => {
  const dir = project({ 'events.yml': eventsYml, 'users.yml': usersYml });
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'duckdb' });
    assert.deepEqual(c.facts, ['events']);
    assert.equal(c.getModel('events').dbt_model, 'fct_events');
    assert.equal(c.getModel('users').dbt_model, 'dim_users');
    assert.deepEqual(c.eventNames('events').sort(), ['login', 'purchase']);
    assert.ok(c.eventProps('events').includes('amount'));
    assert.ok(c.modelDimensionColumns('users').includes('country'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadCatalog(dir) delegates to project discovery; schema split across files + nested dirs works', () => {
  const dir = project({ 'events.yml': eventsYml });
  mkdirSync(join(dir, 'models', 'dims'), { recursive: true });
  writeFileSync(join(dir, 'models', 'dims', 'users.yml'), usersYml);
  try {
    const c = loadCatalog(dir, { dialect: 'duckdb' });
    assert.equal(c.getModel('users').dbt_model, 'dim_users'); // found in a nested dir
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config error: more than one model declares the same role', () => {
  const dupe = eventsYml.replace('fct_events', 'fct_events_2');
  const dir = project({ 'events.yml': eventsYml, 'events2.yml': dupe });
  try {
    assert.throws(() => loadCatalogFromProject(dir, { dialect: 'duckdb' }), /more than one model declares role 'events'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('error when no MCP-tagged models are present', () => {
  const plain = 'version: 2\nmodels:\n  - name: some_model\n    columns: [{ name: x, data_type: string }]\n';
  const dir = project({ 'm.yml': plain });
  try {
    assert.throws(() => loadCatalogFromProject(dir, { dialect: 'duckdb' }), /no MCP-tagged models/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a meta.mcp block at the top level is refused, naming the model or column it sits on', () => {
  const modelTop = usersYml.replace('config: { meta: { mcp: { role: users } } }', 'meta: { mcp: { role: users } }');
  const columnTop = eventsYml.replace("config: { meta: { mcp: { is_time: true } } }", 'meta: { mcp: { is_time: true } }');
  for (const [files, where] of [[{ 'users.yml': modelTop, 'events.yml': eventsYml }, /model 'dim_users'/], [{ 'events.yml': columnTop, 'users.yml': usersYml }, /column 'fct_events\.ts'/]]) {
    const dir = project(files);
    try {
      assert.throws(() => loadCatalogFromProject(dir, { dialect: 'duckdb' }), where);
      assert.throws(() => loadCatalog(join(dir, 'models', Object.keys(files)[0]), { dialect: 'duckdb' }), /config\.meta\.mcp/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a key the loader does not read is refused at load, on a model and on a column, with the keys it takes', () => {
  const onModel = usersYml.replace('mcp: { role: users }', 'mcp: { role: users, anchor: true }');
  const onColumn = eventsYml.replace('mcp: { is_time: true }', 'mcp: { is_time: true, values: [a] }');
  const mistypedRole = usersYml.replace('mcp: { role: users }', 'mcp: { rol: users }');
  const columnOnly = usersYml.replace('config: { meta: { mcp: { role: users } } }', 'description: users');
  for (const [files, where] of [[{ 'users.yml': onModel, 'events.yml': eventsYml }, /model 'dim_users': config\.meta\.mcp has no key 'anchor' — it takes role,/], [{ 'events.yml': onColumn, 'users.yml': usersYml }, /column 'fct_events\.ts': config\.meta\.mcp has no key 'values' — it takes entity,/],
    [{ 'users.yml': mistypedRole, 'events.yml': eventsYml }, /model 'dim_users': config\.meta\.mcp has no key 'rol'/], [{ 'users.yml': columnOnly, 'events.yml': eventsYml }, /catalog model 'dim_users' is missing config\.meta\.mcp\.role/]]) {
    const dir = project(files);
    try { assert.throws(() => loadCatalogFromProject(dir, { dialect: 'duckdb' }), where); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a catalog file that is not a dbt model-schema YAML is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cat-'));
  try {
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ models: { events: { dbt_model: 'fct_events' } } }));
    writeFileSync(join(dir, 'registry.yml'), 'models:\n  events: { dbt_model: fct_events }\n');
    for (const f of ['catalog.json', 'registry.yml']) assert.throws(() => loadCatalog(join(dir, f), { dialect: 'duckdb' }), /dbt model-schema YAML/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('primary_entity: null is no primary entity — the model loads and its keys are its entities\' own', () => {
  const nulled = usersYml.replace('config: { meta: { mcp: { role: users } } }', 'config: { meta: { mcp: { role: users, primary_entity: null } } }');
  const dir = project({ 'events.yml': eventsYml, 'users.yml': nulled });
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'duckdb' });
    assert.deepEqual(c.entityKeyColumns('users'), ['user_id']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('model-paths: [] is refused — dbt parses no model then, so none this server reads would be seen', () => {
  const dir = project({ 'events.yml': eventsYml, 'users.yml': usersYml });
  try {
    writeFileSync(join(dir, 'dbt_project.yml'), 'name: test\nprofile: test\nmodel-paths: []\n');
    assert.throws(() => loadCatalogFromProject(dir, { dialect: 'duckdb' }), /model-paths is empty, so dbt parses no model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
