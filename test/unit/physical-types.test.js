// THE WAREHOUSE'S TYPE DECIDES (Catalog.typeToPhysical, called by the catalog's grounding at start):
// what the warehouse reports a column as replaces the model YAML's declaration everywhere a type is
// read — while a stated role (the time axis, a validity bound) stands. Catalog lifecycle only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.js';

const CATALOG = new URL('../integration/fixtures/catalog.yml', import.meta.url).pathname;

test('the warehouse type replaces the declared one: a column, a property, a dimension read off its data_type — not the time axis or a validity bound', () => {
  const c = loadCatalog(CATALOG, {});
  const retyped = c.typeToPhysical({
    users: new Map([['platform', 'BOOL'], ['os_version', 'TIMESTAMP'], ['install_time_valid_from', 'STRING'], ['country', 'STRING']]),
    events: new Map([['level_id_of_event_data', 'STRING'], ['device_time', 'STRING']]),
  });
  const users = c.getModel('users'); const events = c.getModel('events');
  const col = (m, n) => m.columns.find((x) => x.name === n)?.type;
  assert.equal(col(users, 'platform'), 'boolean', 'a declared string the warehouse holds as BOOL');
  assert.equal(users.dimensions.os_version.type, 'time', 'a dimension read off its data_type follows the warehouse');
  assert.equal(users.dimensions.os_version.granularity, 'day');
  assert.equal(users.data_types.os_version, 'TIMESTAMP', 'the semantic layer reads it by the warehouse type');
  assert.equal(users.dimensions.install_time_valid_from.type, 'time', 'a validity bound stands');
  assert.equal(events.properties.level_id_of_event_data.type, 'string', 'a property follows the warehouse');
  assert.equal(col(events, 'device_time'), 'time', 'the declared time axis stands');
  assert.equal(col(users, 'country'), 'string', 'an agreeing type is left as it is');
  assert.ok(retyped.users.length >= 2 && retyped.events.length >= 1, JSON.stringify(retyped));
});
