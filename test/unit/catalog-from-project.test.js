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
    meta: { mcp: { role: events, primary_entity: event, known_events: [login, purchase] } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
      - { name: props, data_type: json, meta: { mcp: { is_event_data: true, properties: { amount: { type: numeric } } } } }
`;
const usersYml = `version: 2
models:
  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
`;

test('loadCatalogFromProject: discovers MCP models from the dbt project schema YAMLs', () => {
  const dir = project({ 'events.yml': eventsYml, 'users.yml': usersYml });
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'postgres' });
    assert.deepEqual(c.facts, ['events']);
    assert.equal(c.getModel('events').dbt_model, 'fct_events');
    assert.equal(c.getModel('users').dbt_model, 'dim_users');
    assert.deepEqual(c.eventNames().sort(), ['login', 'purchase']);
    assert.ok(c.eventProps().includes('amount'));
    assert.ok(c.modelDimensionColumns('users').includes('country'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadCatalog(dir) delegates to project discovery; schema split across files + nested dirs works', () => {
  const dir = project({ 'events.yml': eventsYml });
  mkdirSync(join(dir, 'models', 'dims'), { recursive: true });
  writeFileSync(join(dir, 'models', 'dims', 'users.yml'), usersYml);
  try {
    const c = loadCatalog(dir, { dialect: 'postgres' });
    assert.equal(c.getModel('users').dbt_model, 'dim_users'); // found in a nested dir
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config error: more than one model declares the same role', () => {
  const dupe = eventsYml.replace('fct_events', 'fct_events_2');
  const dir = project({ 'events.yml': eventsYml, 'events2.yml': dupe });
  try {
    assert.throws(() => loadCatalogFromProject(dir, { dialect: 'postgres' }), /more than one model declares role 'events'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('error when no MCP-tagged models are present', () => {
  const plain = 'version: 2\nmodels:\n  - name: some_model\n    columns: [{ name: x, data_type: string }]\n';
  const dir = project({ 'm.yml': plain });
  try {
    assert.throws(() => loadCatalogFromProject(dir, { dialect: 'postgres' }), /no MCP-tagged models/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
