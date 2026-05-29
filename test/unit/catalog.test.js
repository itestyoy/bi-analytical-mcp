import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog, Catalog } from '../../src/catalog.js';

const CATALOG = join(process.cwd(), 'config', 'catalog.json');

test('loads catalog and derives basic enums', () => {
  const c = loadCatalog(CATALOG);
  assert.equal(c.dialect, 'postgres');
  assert.deepEqual(c.modelKeys().sort(), ['campaigns', 'events', 'users']);
  assert.ok(c.eventNames().includes('iap_purchase_completed'));
  assert.ok(c.eventProps().includes('level_id'));
  assert.ok(c.eventNumericProps().includes('price_in_usd'));
  assert.ok(!c.eventNumericProps().includes('currency'));
});

test('reachable group-by paths include 1-hop and 2-hop, plus metric_time', () => {
  const c = loadCatalog(CATALOG);
  const paths = c.reachableGroupByPaths();
  assert.ok(paths.includes('metric_time'));
  assert.ok(paths.includes('user__country'));
  assert.ok(paths.includes('user__campaign__channel'), '2-hop path expected');
});

test('prunes dangling foreign entities (m3)', () => {
  const raw = {
    warehouse_dialect: 'postgres',
    anchor_model: 'events',
    models: {
      events: { dbt_model: 'e', role: 'fact', primary_entity: 'event', entities: { ghost: { column: 'ghost_id', type: 'foreign' } }, time: { column: 'ts', granularity: 'day' }, event_name: { column: 'event_name' }, known_events: ['x'], properties: {} },
    },
  };
  const c = new Catalog(raw);
  // ghost foreign has no matching primary model -> no ghost__* paths
  assert.deepEqual(c.reachableGroupByPaths(), ['metric_time']);
});

test('entity key columns and joinable models', () => {
  const c = loadCatalog(CATALOG);
  assert.deepEqual(c.entityKeyColumns('events').sort(), ['appsflyer_id', 'session_number']);
  assert.deepEqual(c.joinableModelKeys().sort(), ['campaigns', 'users']);
});
