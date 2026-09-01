// Input-validation guards on the join keys declared in the schema (allowed as a non-data test:
// bad input is rejected at catalog load, before anything can query a silently-broken join).
//
// The behaviour of a working key — what it actually joins and what it returns — is asserted on
// real query results in test/integration/declared-joins.test.js.

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

const EVENTS = `  - name: fct_events
    meta:
      mcp:
        role: events
        primary_entity: event
        known_events: [login]
        entities:
          player_day: { type: foreign, key: [user_id, { column: ts, granularity: day }] }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;

const SPEND = (extra = '') => `  - name: fct_spend
    meta:
      mcp:
        role: acquisition
        primary_entity: spend
        entities:
          player_day: { type: unique, key: [user_id, { column: day, granularity: day }] }
${extra}    columns:
      - { name: spend_id, data_type: string, meta: { mcp: { entity: { name: spend, type: primary } } } }
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: day, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: cost, data_type: numeric, meta: { mcp: { measure: { agg: sum } } } }
`;

test('a composite key is parsed with its parts, its grain and its owner', () => {
  const c = load(EVENTS + SPEND());
  assert.deepEqual(c.entityKey('events', 'player_day'), [{ column: 'user_id' }, { column: 'ts', granularity: 'day' }]);
  assert.deepEqual(c.entityKey('acquisition', 'player_day'), [{ column: 'user_id' }, { column: 'day', granularity: 'day' }]);
  // the UNIQUE side is the join target, even though the model's identity is its own surrogate key
  assert.equal(c.joinTargetFor('player_day'), 'acquisition');
  assert.equal(c.joinTargetFor('spend'), 'acquisition');
  // both models declare it, so it is a relationship a `via` join can name
  assert.deepEqual(c.sharedEntities('events', 'acquisition').map((x) => x.entity).sort(), ['player_day', 'user']);
  assert.ok(c.joinEntityNames().includes('player_day'));
  // …and the target's attributes become reachable group-by paths through it
  assert.ok(c.reachableGroupByPaths().includes('player_day__day'));
});

test('a key naming a column the model does not have is rejected', () => {
  assert.throws(() => load(EVENTS.replace('key: [user_id, { column: ts, granularity: day }]', 'key: [user_id, nope]')),
    /is not a column of the model/);
});

test('a key with no columns is rejected', () => {
  assert.throws(() => load(EVENTS.replace('key: [user_id, { column: ts, granularity: day }]', 'key: []')),
    /needs a column name, or a list of them/);
});

test('an unknown entity type is rejected with the allowed set', () => {
  assert.throws(() => load(EVENTS.replace('{ type: foreign, key:', '{ type: sideways, key:')),
    /unknown entity type 'sideways'.*primary, unique, foreign, natural/s);
});

test('two models owning the same entity is rejected — a join has one target', () => {
  // make the events side claim the key as unique too
  const both = EVENTS.replace('player_day: { type: foreign,', 'player_day: { type: unique,');
  assert.throws(() => load(both + SPEND()), /both OWN entity 'player_day'/);
});

test('the two sides of a key must be built from the same number of parts', () => {
  // drop the day part on the spend side: a one-part key would never equal a two-part one
  const lopsided = SPEND().replace('key: [user_id, { column: day, granularity: day }]', 'key: [user_id]');
  assert.throws(() => load(EVENTS + lopsided), /1 key part\(s\).*but 2|2 key part\(s\).*but 1/s);
});

test('key VARIANTS expand into one relationship per variant, mirrored on the owning side', () => {
  const crash = `  - name: fct_crash
    meta:
      mcp:
        role: crashlytics
        primary_entity: crash
        known_events: [boom]
        entities:
          tracked_ad:
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
  const users = `  - name: dim_users
    meta:
      mcp:
        role: users
        entities:
          tracked_ad: { type: unique, key: [track, user_id] }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: track, data_type: string }
      - { name: country, data_type: string }
`;
  const c = load(EVENTS + crash + users);
  // one relationship per variant, on the declaring side…
  assert.deepEqual(c.entityKey('crashlytics', 'tracked_ad_rewarded'), [{ column: 'rewarded_track' }, { column: 'user_id' }]);
  assert.deepEqual(c.entityKey('crashlytics', 'tracked_ad_banner'), [{ column: 'banner_track' }, { column: 'user_id' }]);
  // …and the OWNING side's single key answers for every one of them, declared once
  assert.deepEqual(c.entityKey('users', 'tracked_ad_rewarded'), [{ column: 'track' }, { column: 'user_id' }]);
  assert.deepEqual(c.entityKey('users', 'tracked_ad_banner'), [{ column: 'track' }, { column: 'user_id' }]);
  assert.equal(c.joinTargetFor('tracked_ad_rewarded'), 'users');
  // a variants-only side keeps no base relationship, so it cannot be joined ambiguously
  assert.equal(c.entityKey('crashlytics', 'tracked_ad'), undefined);
  // both variants are offered to the caller; the base is not (only one model carries it)
  assert.ok(c.joinEntityNames().includes('tracked_ad_rewarded'));
  assert.ok(c.joinEntityNames().includes('tracked_ad_banner'));
  assert.ok(!c.joinEntityNames().includes('tracked_ad'));
  // …and each variant reaches the owner's attributes as its own group-by path
  assert.ok(c.reachableGroupByPaths().includes('tracked_ad_rewarded__country'));
  assert.ok(c.reachableGroupByPaths().includes('tracked_ad_banner__country'));
});

test('a primary entity may not be split into variants', () => {
  const withAlt = SPEND('        entities2_placeholder\n').replace(
    '        entities2_placeholder\n',
    '          alt: { type: primary, variants: { a: { key: [user_id] } } }\n',
  );
  assert.throws(() => load(EVENTS + withAlt), /primary entity is the model's single identity and cannot have variants/);
});

test('a model may not declare two primary entities', () => {
  const two = SPEND().replace('          player_day: { type: unique,', '          other: { type: primary, key: [user_id] }\n          player_day: { type: unique,');
  assert.throws(() => load(EVENTS + two), /declares two primary entities/);
});
