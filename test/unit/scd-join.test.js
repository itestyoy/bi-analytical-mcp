import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBaseModel, renderContext } from '../../src/yaml-render.js';

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

// DEFAULT (markers present, flag unset): natural entity + validity_params NESTED UNDER type_params
// — the exact shape dbt-semantic-interfaces expects (verified via `dbt parse`, exit 0).
test('SCD-2 by default → natural entity + validity_params nested under type_params', () => {
  const prev = process.env.MCP_SCD_VALIDITY_PARAMS;
  delete process.env.MCP_SCD_VALIDITY_PARAMS;
  try {
    const sm = renderBaseModel(scdCatalog, 'users');
    assert.equal(sm.entities[0].type, 'natural', 'SCD key is natural (not primary — it is not unique)');
    // dbt requires a model-level primary_entity when the model has dimensions (verified via
    // dbt parse + mf query: this is what makes the point-in-time join validate and run).
    assert.equal(sm.primary_entity, 'user', 'SCD model also declares a model-level primary_entity');
    const vf = sm.dimensions.find((d) => d.name === 'install_time_valid_from');
    const vt = sm.dimensions.find((d) => d.name === 'install_time_valid_until');
    // validity_params must live INSIDE type_params (not a top-level sibling — dbt rejects that).
    assert.deepEqual(vf.type_params.validity_params, { is_start: true }, 'is_start nested in type_params');
    assert.deepEqual(vt.type_params.validity_params, { is_end: true }, 'is_end nested in type_params');
    assert.ok(!('validity_params' in vf) && !('validity_params' in vt), 'NOT emitted at the dimension top level');
    assert.equal(vf.type, 'time'); assert.equal(vt.type, 'time');
    assert.equal(sm.dimensions.find((d) => d.name === 'country').type, 'categorical');
  } finally { if (prev !== undefined) process.env.MCP_SCD_VALIDITY_PARAMS = prev; }
});

// ESCAPE HATCH MCP_SCD_VALIDITY_PARAMS=false → plain primary-key model (for older DSI that rejects
// validity_params). No natural entity, no validity_params anywhere.
test('SCD-2 with MCP_SCD_VALIDITY_PARAMS=false → plain primary entity, no validity_params', () => {
  const prev = process.env.MCP_SCD_VALIDITY_PARAMS;
  process.env.MCP_SCD_VALIDITY_PARAMS = 'false';
  try {
    const sm = renderBaseModel(scdCatalog, 'users');
    assert.equal(sm.entities[0].type, 'primary', 'disabled → primary entity (parses on any MetricFlow)');
    assert.equal(sm.primary_entity, undefined, 'no extra model-level primary_entity when disabled');
    assert.ok(sm.dimensions.every((d) => !d.type_params?.validity_params && !d.validity_params), 'no validity_params when disabled');
  } finally { if (prev === undefined) delete process.env.MCP_SCD_VALIDITY_PARAMS; else process.env.MCP_SCD_VALIDITY_PARAMS = prev; }
});

// MetricFlow HARD CONSTRAINT: a model with validity_params may NOT also have measures
// ("Semantic model users has both measures and validity param dimensions defined. This is not
// currently supported!"). The renderer must emit an SCD model dimension-only.
test('SCD model with a catalog measure → measure is NOT emitted (dimension-only)', () => {
  const prev = process.env.MCP_SCD_VALIDITY_PARAMS;
  delete process.env.MCP_SCD_VALIDITY_PARAMS;
  try {
    const cat = {
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
        measures: { users_count: { agg: 'count', expr: '1' } },
      }),
    };
    const sm = renderBaseModel(cat, 'users');
    assert.ok(!sm.measures || sm.measures.length === 0, 'no measures on an SCD model');
    assert.ok(sm.dimensions.some((d) => d.type_params?.validity_params?.is_start), 'validity_params kept');
  } finally { if (prev !== undefined) process.env.MCP_SCD_VALIDITY_PARAMS = prev; }
});

test('renderContext drops a task measure + its metric on an SCD model, with a warning', () => {
  const prev = process.env.MCP_SCD_VALIDITY_PARAMS;
  delete process.env.MCP_SCD_VALIDITY_PARAMS;
  try {
    const cat = {
      anchor: 'events',
      getModel: (k) => (k === 'users' ? {
        dbt_model: 'dim_users',
        primary_entity: { name: 'user', column: 'internal_player_id' },
        scd: true,
        entities: {},
        dimensions: { install_time_valid_from: { type: 'time', granularity: 'day', validity: 'start' }, install_time_valid_until: { type: 'time', granularity: 'day', validity: 'end' }, country: { type: 'categorical' } },
      } : { dbt_model: 'fct', primary_entity: 'event', entities: {}, time: { column: 'device_time', granularity: 'day' }, dimensions: {}, measures: {} }),
    };
    const state = {
      usedModels: ['events', 'users'],
      additions: { users: { measures: [{ name: 'users_count', agg: 'count', expr: '1' }], dimensions: [] } },
      metrics: [{ name: 'users_count', label: 'users_count', type: 'simple', type_params: { measure: 'users_count' } }],
    };
    const r = renderContext(cat, state);
    const users = /name: users[\s\S]*?(?=\nsemantic_models:|\nmetrics:|$)/;
    assert.ok(!/users_count/.test(r.yaml), 'the SCD measure and its metric are gone from the YAML');
    assert.equal(r.metricNames.includes('users_count'), false, 'dependent metric dropped');
    assert.ok(r.warnings.some((w) => /join-only/i.test(w) && /users_count/.test(w)), 'warns about the drop');
    void users;
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
