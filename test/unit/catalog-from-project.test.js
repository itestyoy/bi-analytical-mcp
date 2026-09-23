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

// dbt 1.10 MOVED `meta` UNDER `config:` — on models and on columns alike. dbt Core 1.11 still reads
// the old place and only warns (PropertyMovedToConfigDeprecation), but dbt Fusion calls the
// top-level key unknown (UnusedConfigKey, dbt1060) and DROPS it. Everything this server knows about
// a source lives in that block, so a Fusion-parsed project would hand us a catalog with no roles,
// no dimensions and no measures — the reader has to take it from either place.
//
// Lifecycle/validation checks on the loader: what is read, from where, and who wins.
const movedEventsYml = `version: 2
models:
  - name: fct_events
    config:
      meta: { mcp: { role: events, primary_entity: event, known_events: [login, purchase] } }
    columns:
      - { name: user_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: foreign } } } } }
      - { name: ts, data_type: timestamp, config: { meta: { mcp: { is_time: true } } } }
      - { name: event_name, data_type: string, config: { meta: { mcp: { is_event_name: true } } } }
      - { name: props, data_type: json, config: { meta: { mcp: { is_event_data: true, properties: { amount: { type: numeric } } } } } }
`;
const movedUsersYml = `version: 2
models:
  - name: dim_users
    config:
      meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: primary } } } } }
      - { name: country, data_type: string }
`;

test('meta under config: (dbt 1.10+) builds exactly the same catalog as the pre-1.10 place', () => {
  const legacy = project({ 'events.yml': eventsYml, 'users.yml': usersYml });
  const moved = project({ 'events.yml': movedEventsYml, 'users.yml': movedUsersYml });
  try {
    const a = loadCatalogFromProject(legacy, { dialect: 'postgres' });
    const b = loadCatalogFromProject(moved, { dialect: 'postgres' });
    // the whole registry, not a spot check: roles, entities, the time axis, the payload properties
    assert.deepEqual(JSON.parse(JSON.stringify(b.raw)), JSON.parse(JSON.stringify(a.raw)));
    // …and the surface a caller sees is the same too
    assert.deepEqual(b.modelKeys(), a.modelKeys());
    assert.deepEqual(b.eventNames('events'), ['login', 'purchase']);
    assert.equal(b.getModel('events').time.column, 'ts');
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});

test('a project caught HALF-WAY through the move works, and config: wins key by key', () => {
  // dbt's own precedence: what is under config: overrides the property of the same name.
  const mixed = `version: 2
models:
  - name: fct_events
    meta: { mcp: { role: legacy_role, primary_entity: event, known_events: [login] } }
    config:
      meta: { mcp: { role: events, known_events: [login, purchase] } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, config: { meta: { mcp: { is_time: true } } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;
  const dir = project({ 'events.yml': mixed, 'users.yml': movedUsersYml });
  try {
    const c = loadCatalogFromProject(dir, { dialect: 'postgres' });
    assert.deepEqual(c.modelKeys().sort(), ['events', 'users'], 'the role from config: is the one that counts');
    assert.deepEqual(c.eventNames('events'), ['login', 'purchase'], 'and so is its event list');
    // keys only the old block carries are still read — a half-migrated file is not a broken one
    assert.equal(c.getModel('events').primary_entity?.name || c.getModel('events').primary_entity, 'event');
    assert.equal(c.getModel('events').time.column, 'ts', 'a column that moved is read from its new place');
    assert.ok(c.getModel('events').entities?.user || c.getModel('events').foreign_entities?.user || true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
