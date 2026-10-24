// A JOIN CONTRACT (meta.mcp.join, src/catalog/joins.js): only a model that declares one is joinable onto
// a pipeline's rows, its key declared unique, and a join names exactly its parts. Input-validation and
// catalog-load guards only — the rows a contract joins are proven on the warehouse in
// test/integration/declared-joins.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';
import { tempDir } from '../helpers/temp-dir.js';

const EVENTS = `  - name: fct_events
    config: { meta: { mcp: { role: events, primary_entity: event, known_events: [first_launch, tutorial] } } }
    columns:
      - name: player_id
        data_type: string
        config: { meta: { mcp: { entity: { name: user, type: foreign } } } }
      - name: device_time
        data_type: timestamp
        config: { meta: { mcp: { is_time: true } } }
      - name: event_name
        data_type: string
        config: { meta: { mcp: { is_event_name: true } } }
      - name: event_data
        data_type: jsonb
        config: { meta: { mcp: { is_event_data: true } } }
`;
const USERS = (join = '{ unique: true, key: { user: player_id }, time: { within: [valid_from, valid_until] } }') => `  - name: dim_users
    config: { meta: { mcp: { role: users${join ? `, join: ${join}` : ''} } } }
    columns:
      - name: player_id
        data_type: string
        config: { meta: { mcp: { entity: { name: user, type: primary } } } }
      - name: country
        data_type: string
      - name: valid_from
        data_type: date
        config: { meta: { mcp: { dimension: { validity: start } } } }
      - name: valid_until
        data_type: date
        config: { meta: { mcp: { dimension: { validity: end } } } }
`;

function catalogOf(models) {
  const path = join(tempDir('joincontract'), 'catalog.yml');
  writeFileSync(path, `version: 2\nmodels:\n${models}`);
  return loadCatalog(path, {});
}

const engineOf = (catalog) => settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('joincontract-ws') }) }));

test('a contract is loaded as declared, and every mistake in it is refused at load, naming the model', () => {
  const c = catalogOf(EVENTS + USERS());
  assert.deepEqual(c.joinableModels(), ['users']);
  assert.deepEqual(c.joinContract('users'), { key: [{ part: 'user', column: 'player_id' }], time: { within: ['valid_from', 'valid_until'] }, select: [] });
  assert.equal(c.joinContract('events'), null, 'an events source declares none');
  const refused = (contract, said) => assert.throws(() => catalogOf(EVENTS + USERS(contract)), said);
  refused('{ key: { user: player_id } }', /model 'dim_users'.*unique: true/);
  refused('{ unique: true, key: { user: no_such } }', /'no_such' is not a column of the model/);
  refused('{ unique: true, key: {} }', /key names at least one part/);
  refused('{ unique: true, key: { user: player_id }, time: { within: [valid_from] } }', /time\.within: \[<from column>, <to column>\]/);
  refused('{ unique: true, key: { user: player_id }, on: x }', /has no field 'on'/);
  refused('{ unique: true, key: { time: player_id } }', /'time' is the time part's own name/);
  refused('{ unique: true, key: { user: player_id, funnel: { by: format, columns: { a: country } } } }', /by 'format' names no select part/);
});

test('a join names exactly its contract\'s parts — a model without one is not joinable', async () => {
  const e = engineOf(catalogOf(EVENTS + USERS()));
  const s = await e.build_model({ action: 'start', name: 'jtest', source: 'events' });
  const add = (stage) => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [stage] });
  await assert.rejects(() => add({ stage: 'join', source: 'users', on: { user: 'player_id' }, attrs: [{ column: 'country' }] }), /missing required property 'time'/);
  await assert.rejects(() => add({ stage: 'join', source: 'users', on: { user: 'player_id', time: 'device_time', extra: 'x' }, attrs: [{ column: 'country' }] }), /unexpected property 'extra'/);
  const ok = await add({ stage: 'join', source: 'users', on: { user: 'player_id', time: 'device_time' }, attrs: [{ column: 'country' }] });
  assert.ok(ok.context_id);
  // without a contract nothing is joinable: the stage has no form at all
  const bare = engineOf(catalogOf(EVENTS + USERS(null)));
  const b = await bare.build_model({ action: 'start', name: 'jtest', source: 'events' });
  await assert.rejects(() => bare.build_model({ action: 'add_steps', context_id: b.context_id, steps: [{ stage: 'join', source: 'users', on: { user: 'player_id', time: 'device_time' }, attrs: [{ column: 'country' }] }] }), /invalid input/);
});
