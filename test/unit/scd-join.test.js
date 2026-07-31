import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBaseModel } from '../../src/yaml-render.js';

// Allowed emission-shape check: a slowly-changing (SCD-2) dimension model must be emitted so
// MetricFlow does a POINT-IN-TIME join — the join entity is `natural` (the key is not unique),
// and the two validity-bound time dimensions carry validity_params (is_start / is_end). This is
// the manifest OBJECT the governed path builds; the data-level "no fan-out" proof needs dbt +
// MetricFlow + an SCD fixture (integration).

const scdCatalog = {
  anchor: 'events',
  getModel: () => ({
    dbt_model: 'dim_users',
    primary_entity: { name: 'user', column: 'internal_player_id' },
    scd: true,
    entities: {},
    dimensions: {
      install_time_valid_from: { type: 'time', granularity: 'day', validity: 'start' },
      install_time_valid_until: { type: 'time', granularity: 'day', validity: 'end' },
      country: { type: 'categorical' },
    },
  }),
};

test('SCD-2 with MCP_SCD_VALIDITY_PARAMS on → natural entity + validity_params (opt-in)', () => {
  const prev = process.env.MCP_SCD_VALIDITY_PARAMS;
  process.env.MCP_SCD_VALIDITY_PARAMS = '1';
  try {
    const sm = renderBaseModel(scdCatalog, 'users');
    assert.equal(sm.entities[0].type, 'natural', 'SCD key is natural (not primary — it is not unique)');
    const vf = sm.dimensions.find((d) => d.name === 'install_time_valid_from');
    const vt = sm.dimensions.find((d) => d.name === 'install_time_valid_until');
    assert.deepEqual(vf.validity_params, { is_start: true }, 'window start marked is_start');
    assert.deepEqual(vt.validity_params, { is_end: true }, 'window end marked is_end');
    assert.equal(vf.type, 'time'); assert.equal(vt.type, 'time');
    assert.equal(sm.dimensions.find((d) => d.name === 'country').type, 'categorical');
  } finally { if (prev === undefined) delete process.env.MCP_SCD_VALIDITY_PARAMS; else process.env.MCP_SCD_VALIDITY_PARAMS = prev; }
});

// DEFAULT (flag off): emit a plain primary-key model that older MetricFlow parsers accept —
// NO validity_params (which they reject), NO natural entity. Marking validity columns must not
// break the governed path by itself.
test('SCD-2 with the flag OFF (default) → plain primary entity, no validity_params', () => {
  const prev = process.env.MCP_SCD_VALIDITY_PARAMS;
  delete process.env.MCP_SCD_VALIDITY_PARAMS;
  try {
    const sm = renderBaseModel(scdCatalog, 'users');
    assert.equal(sm.entities[0].type, 'primary', 'default emits a primary entity (parses on any MetricFlow)');
    assert.ok(sm.dimensions.every((d) => !d.validity_params), 'no validity_params emitted by default');
  } finally { if (prev !== undefined) process.env.MCP_SCD_VALIDITY_PARAMS = prev; }
});

test('a non-SCD dimension model keeps a primary entity and no validity_params', () => {
  const plain = {
    anchor: 'events',
    getModel: () => ({
      dbt_model: 'dim_users',
      primary_entity: { name: 'user', column: 'internal_player_id' },
      entities: {},
      dimensions: { country: { type: 'categorical' }, install_date: { type: 'time', granularity: 'day' } },
    }),
  };
  const sm = renderBaseModel(plain, 'users');
  assert.equal(sm.entities[0].type, 'primary', 'unique key stays primary');
  assert.ok(sm.dimensions.every((d) => !d.validity_params), 'no validity_params without SCD markers');
});
