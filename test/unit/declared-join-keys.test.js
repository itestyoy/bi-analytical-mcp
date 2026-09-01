// Input-validation guards on the join keys declared in the schema (allowed as a non-data test:
// bad input is rejected at catalog load, before anything can query a silently-broken join).
//
// What a working key actually JOINS, and the numbers it returns, is asserted on real query
// results in test/integration/declared-joins.test.js.

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

test('a composite key is parsed, shared by both sides, and offered to the caller', () => {
  const c = load(EVENTS + CRASH + USERS());
  assert.deepEqual(c.entityKey('events', 'ad_funnel_rewarded'), [{ column: 'tracking_id' }, { column: 'user_id' }]);
  assert.deepEqual(c.entityKey('crashlytics', 'ad_funnel_rewarded'), [{ column: 'rewarded_track' }, { column: 'user_id' }]);
  assert.deepEqual(c.sharedEntities('crashlytics', 'events').map((x) => x.entity).sort(),
    ['ad_funnel_banner', 'ad_funnel_rewarded', 'user']);
  assert.ok(c.joinEntityNames().includes('ad_funnel_rewarded'));
});

// One funnel id spans SEVERAL events, so neither side is unique on it: there is no join target,
// and the relationship must NOT show up as a governed group-by path.
test('a relationship nobody owns is pipeline-only: no target, no group-by path', () => {
  const c = load(EVENTS + CRASH + USERS());
  assert.equal(c.joinTargetFor('ad_funnel_rewarded'), undefined);
  assert.ok(!c.reachableGroupByPaths().some((p) => p.startsWith('ad_funnel')));
  // …while the player key IS owned, so its paths are there
  assert.equal(c.joinTargetFor('user'), 'users');
  assert.ok(c.reachableGroupByPaths().includes('user__country'));
});

test('key VARIANTS expand into one relationship per variant; the plain side answers each', () => {
  const c = load(EVENTS + CRASH + USERS());
  assert.deepEqual(c.entityKey('crashlytics', 'ad_funnel_banner'), [{ column: 'banner_track' }, { column: 'user_id' }]);
  // the side with ONE column answers every variant with it, declared once
  assert.deepEqual(c.entityKey('events', 'ad_funnel_banner'), [{ column: 'tracking_id' }, { column: 'user_id' }]);
  // a variants-only side keeps no base relationship, so it cannot be joined ambiguously
  assert.equal(c.entityKey('crashlytics', 'ad_funnel'), undefined);
  // the base is carried by one model only, so it is not offered as a join
  assert.ok(!c.joinEntityNames().includes('ad_funnel'));
});

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
