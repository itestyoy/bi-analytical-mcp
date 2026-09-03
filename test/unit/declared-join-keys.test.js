// INPUT-VALIDATION GUARDS ONLY — the one kind of non-data test the project rules allow: a bad
// schema is rejected at catalog load, before anything can query a silently-broken join.
//
// Nothing here asserts that a WORKING key parses into some shape. What a key actually joins,
// and the numbers it returns, is proven by running against the warehouse in
// test/integration/declared-joins.test.js — that is the only evidence that counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';

/** Write a catalog YAML and load it. */
function load(models) {
  const file = join(mkdtempSync(join(tmpdir(), 'joinkey-')), 'catalog.yml');
  writeFileSync(file, `version: 2\nmodels:\n${models}`);
  return loadCatalog(file, {});
}

// An events source carrying the ad-funnel key: several rows share one funnel id.
const EVENTS = `  - name: fct_events
    meta:
      mcp:
        role: events
        primary_entity: event
        known_events: [login]
        entities:
          ad_funnel: { type: foreign, key: [tracking_id, user_id] }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: tracking_id, data_type: string }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;

// The crash source records one funnel id PER AD FORMAT — the variants of one relationship.
const CRASH = `  - name: fct_crash
    meta:
      mcp:
        role: crashlytics
        primary_entity: crash
        known_events: [boom]
        entities:
          ad_funnel:
            type: foreign
            variants:
              rewarded: { key: [rewarded_track, user_id] }
              banner:   { key: [banner_track, user_id] }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: rewarded_track, data_type: string }
      - { name: banner_track, data_type: string }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;

/** A plain (non-SCD) install record. `extra` injects further entity declarations. */
const USERS = (extra = '') => `  - name: dim_users
    meta:
      mcp:
        role: users
${extra}    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
`;

/** A SLOWLY-CHANGING install record: one row per player per validity window. */
const USERS_SCD = (extra = '') => `  - name: dim_users
    meta:
      mcp:
        role: users
${extra}    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: track, data_type: string }
      - { name: country, data_type: string }
      - { name: valid_from, data_type: timestamp, meta: { mcp: { dimension: { validity: start } } } }
      - { name: valid_until, data_type: timestamp, meta: { mcp: { dimension: { validity: end } } } }
`;

test('a key naming a column the model does not have is rejected', () => {
  assert.throws(() => load(EVENTS.replace('key: [tracking_id, user_id]', 'key: [nope, user_id]') + USERS()),
    /is not a column of the model/);
});

test('a key with no columns is rejected', () => {
  assert.throws(() => load(EVENTS.replace('key: [tracking_id, user_id]', 'key: []') + USERS()),
    /needs a column name, or a list of them/);
});

test('an unknown entity type is rejected with the allowed set', () => {
  assert.throws(() => load(EVENTS.replace('{ type: foreign, key:', '{ type: sideways, key:') + USERS()),
    /unknown entity type 'sideways'.*primary, unique, foreign, natural/s);
});

test('two models owning the same entity is rejected — a join has one target', () => {
  const claims = USERS('        entities:\n          event: { type: unique, key: [user_id] }\n');
  assert.throws(() => load(EVENTS + claims), /both OWN entity 'event'|both declare primary entity 'event'/);
});

test('the two sides of a key must be built from the same number of parts', () => {
  const lopsided = CRASH.replace('rewarded: { key: [rewarded_track, user_id] }', 'rewarded: { key: [rewarded_track] }');
  assert.throws(() => load(EVENTS + lopsided + USERS()), /1 key part\(s\).*but 2|2 key part\(s\).*but 1/s);
});

test('a primary entity may not be split into variants', () => {
  const bad = USERS('        entities:\n          alt: { type: primary, variants: { a: { key: [user_id] } } }\n');
  assert.throws(() => load(EVENTS + bad), /primary entity is the model's single identity and cannot have variants/);
});

test('a model may not declare two primary entities', () => {
  const two = USERS('        entities:\n          other: { type: primary, key: [country] }\n');
  assert.throws(() => load(EVENTS + two), /declares two primary entities/);
});

// MetricFlow refuses a manifest where a model with validity params also has a primary/unique
// entity, so catch it at load — where we can say what to do instead.
test('a slowly-changing model may not own a second join key', () => {
  const bad = USERS_SCD('        entities:\n          tracked: { type: unique, key: [track, user_id] }\n');
  assert.throws(() => load(EVENTS + bad),
    /declares a validity window .* and also owns join key\(s\) 'tracked' as primary\/unique/s);
});

test('a slowly-changing model with only its natural key loads fine', () => {
  const c = load(EVENTS + USERS_SCD());
  assert.equal(c.getModel('users').scd, true);
  assert.deepEqual(Object.keys(c.entitiesOf('users')), ['user']);
});

// ── DECLARATIONS THAT USED TO BE SILENTLY DROPPED ───────────────────────────────────────
// Each of these once loaded and produced a model built from ONE of the two declarations, with
// nothing said about the other. Which one survived came down to the order of keys in the file.

test('two columns claiming the identity is rejected, with the composite form named', () => {
  const bad = USERS().replace('- { name: country, data_type: string }',
    '- { name: country, data_type: string, meta: { mcp: { entity: { name: place, type: primary } } } }');
  assert.throws(() => load(EVENTS + bad),
    /columns 'user_id' and 'country' both declare a PRIMARY entity.*composite key/s);
});

test('a column claiming a different identity than the model declares is rejected', () => {
  const bad = USERS('        primary_entity: household\n');
  assert.throws(() => load(EVENTS + bad), /declares meta\.mcp\.primary_entity 'household', but column 'user_id' declares primary entity 'user'/);
});

test('one relationship declared on two columns is rejected', () => {
  const bad = CRASH.replace('- { name: banner_track, data_type: string }',
    '- { name: banner_track, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }');
  assert.throws(() => load(bad + EVENTS + USERS()),
    /entity 'user' is declared on two columns \('user_id' and 'banner_track'\)/);
});

test('the same relationship at column level and model level is rejected', () => {
  const bad = EVENTS.replace('          ad_funnel: { type: foreign, key: [tracking_id, user_id] }',
    '          ad_funnel: { type: foreign, key: [tracking_id, user_id] }\n          user: { type: foreign, key: [tracking_id] }');
  assert.throws(() => load(bad + USERS()),
    /entity 'user' is declared both on column 'user_id' \(meta\.mcp\.entity\) and in meta\.mcp\.entities/);
});

test("a relationship named after the model's own identity is rejected", () => {
  const bad = EVENTS.replace('          ad_funnel: { type: foreign, key: [tracking_id, user_id] }',
    '          event: { type: unique, key: [tracking_id] }');
  assert.throws(() => load(bad + USERS()), /already the model's PRIMARY entity/);
});

// `natural` is what a model with a validity window GETS; declared by hand it reaches dbt as a
// natural entity with no window and fails there, quoting a window the author never wrote.
test('type: natural is rejected, pointing at the validity window instead', () => {
  const bad = EVENTS.replace('{ type: foreign, key: [tracking_id, user_id] }', '{ type: natural, key: [tracking_id, user_id] }');
  assert.throws(() => load(bad + USERS()), /as type: natural.*meta\.mcp\.dimension\.validity/s);
});

// A window says a ROW HAS VERSIONS. An events source has one row per event, MetricFlow forbids
// measures alongside validity params, and the fact renderer has no window to apply — so this
// declaration used to be read, believed, and then ignored.
test('a validity window on an events source is rejected', () => {
  const bad = EVENTS.replace('      - { name: tracking_id, data_type: string }',
    `      - { name: tracking_id, data_type: string }
      - { name: valid_from, data_type: timestamp, meta: { mcp: { dimension: { validity: start } } } }
      - { name: valid_until, data_type: timestamp, meta: { mcp: { dimension: { validity: end } } } }`);
  assert.throws(() => load(bad + USERS()),
    /events source 'events' declares a validity window .*'valid_from \(start\)', 'valid_until \(end\)'/s);
});

test('a validity mark on a column that is not a dimension is rejected', () => {
  const onKey = USERS_SCD().replace('{ name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }',
    '{ name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary }, dimension: { validity: start } } } }');
  assert.throws(() => load(EVENTS + onKey), /is a join key \(meta\.mcp\.entity\), so it never becomes a groupable time dimension/);

  const onAxis = USERS_SCD().replace('{ name: country, data_type: string }',
    '{ name: seen_at, data_type: timestamp, meta: { mcp: { is_time: true, dimension: { validity: end } } } }');
  assert.throws(() => load(EVENTS + onAxis), /is the model's time axis \(meta\.mcp\.is_time\), so it never becomes a groupable time dimension/);
});

// THE SOURCE IS ALWAYS A SEPARATE ARGUMENT. With several events sources an accessor asked without
// one has nothing to fall back to — there is no "default" fact — so it refuses instead of silently
// answering for another source. With exactly one source the argument may be omitted.
test('event accessors refuse an omitted source when the catalog has several', () => {
  const two = load(EVENTS + CRASH + USERS());
  assert.equal(two.facts.length, 2);
  assert.throws(() => two.eventNames(), /a source is required: this catalog has 2 events sources/);
  assert.throws(() => two.scalarEventProps(), /a source is required/);
  assert.throws(() => two.bundleColumn(), /a source is required/);
  assert.throws(() => two.eventNames('users'), /'users' is not an events source/);
  assert.deepEqual(two.eventNames('crashlytics'), ['boom']);

  const one = load(EVENTS + USERS());
  assert.equal(one.facts.length, 1);
  assert.deepEqual(one.eventNames(), ['login'], 'a single source resolves without being named');
});

// ── THE SCHEMA MARKS A PROPERTY; THE INDEX MEASURES THE REST ───────────────────────────────
// Which events carry a property and which values it takes are observed by the value index, per
// source. The former meta.mcp.events / meta.mcp.values lists only went stale in silence, so they
// are refused with the replacement; a scalar payload column is marked meta.mcp.property: true.
const withCol = (base, colLine) => base.replace('      - { name: tracking_id, data_type: string }', `      - { name: tracking_id, data_type: string }\n${colLine}`);

test('meta.mcp.property marks a flat column as an event property; the index measures its events', () => {
  const c = load(withCol(EVENTS, '      - { name: price_usd, data_type: numeric, meta: { mcp: { property: true, unit: usd } } }') + USERS());
  assert.ok(c.eventProps('events').includes('price_usd'));
  assert.equal(c.eventPropertySpec('price_usd', 'events').type, 'numeric');
  assert.equal(c.eventPropertySpec('price_usd', 'events').events, undefined, 'no declared event list exists any more');
  // an unmarked column of a fact is a plain column, not a property
  assert.ok(!c.eventProps('events').includes('tracking_id'));
});

test('meta.mcp.events is refused, naming the property marker', () => {
  assert.throws(() => load(withCol(EVENTS, '      - { name: price_usd, data_type: numeric, meta: { mcp: { events: [login] } } }') + USERS()),
    /meta\.mcp\.events is no longer a schema key.*measured by the value index.*meta\.mcp\.property: true/s);
});

test('meta.mcp.values is refused on a property and on an attribute', () => {
  assert.throws(() => load(withCol(EVENTS, '      - { name: result, data_type: string, meta: { mcp: { property: true, values: [win, lose] } } }') + USERS()),
    /meta\.mcp\.values is no longer a schema key.*semantic_index\(\{ property \}\)/s);
  const dimVals = USERS().replace('- { name: country, data_type: string }', '- { name: country, data_type: string, meta: { mcp: { values: [US, GB] } } }');
  assert.throws(() => load(EVENTS + dimVals), /meta\.mcp\.values is no longer a schema key/);
  const blobVals = EVENTS.replace('      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }',
    "      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }\n      - { name: payload, data_type: jsonb, meta: { mcp: { is_event_data: true, properties: { mode: { type: string, values: [a, b] } } } } }");
  assert.throws(() => load(blobVals + USERS()), /'values' \/ 'events' are no longer schema keys/);
});

test('meta.mcp.property on a dimension model is refused (every attribute is already groupable there)', () => {
  const bad = USERS().replace('- { name: country, data_type: string }', '- { name: country, data_type: string, meta: { mcp: { property: true } } }');
  assert.throws(() => load(EVENTS + bad), /marks an EVENT-PAYLOAD property, which only an events source has/);
});

test('meta.mcp.anchor is refused: there is no default source', () => {
  const bad = EVENTS.replace('        role: events\n', '        role: events\n        anchor: true\n');
  assert.throws(() => load(bad + USERS()), /meta\.mcp\.anchor is no longer a schema key.*no default source/s);
});

// A column that is BOTH an amount and an attribute keeps both roles — the measure marking used
// to be dropped in silence when `dimension` was present as well.
test('a column marked measure AND dimension is aggregatable and groupable', () => {
  const both = USERS().replace('- { name: country, data_type: string }',
    '- { name: country, data_type: string }\n      - { name: level, data_type: integer, meta: { mcp: { measure: { unit: level }, dimension: {} } } }');
  const c = load(EVENTS + both);
  assert.ok(c.aggregatableFields('users').some((a) => a.name === 'level'), 'aggregatable');
  assert.ok(Object.keys(c.getModel('users').dimensions).includes('level'), 'and a groupable attribute');
});

// No join key is singled out by NAME as a groupable column of a fact: the general mechanism
// (meta.mcp.dimension) is the only way a key becomes an attribute.
test('a session-named key is not a fact attribute unless marked dimension like any column', () => {
  const withSession = EVENTS.replace('      - { name: tracking_id, data_type: string }',
    '      - { name: tracking_id, data_type: string }\n      - { name: sess, data_type: integer, meta: { mcp: { entity: { name: session, type: foreign } } } }');
  const c = load(withSession + USERS());
  assert.ok(!c.modelDimensionColumns('events').includes('sess'));
});
