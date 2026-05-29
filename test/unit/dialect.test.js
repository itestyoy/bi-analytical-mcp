import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonExtract, sqlLiteral, isNumericType } from '../../src/dialect.js';

test('jsonExtract postgres: numeric cast and string', () => {
  assert.equal(jsonExtract('postgres', 'event_properties', 'level', 'int'), "(event_properties->>'level')::int");
  assert.equal(jsonExtract('postgres', 'event_properties', 'revenue', 'numeric'), "(event_properties->>'revenue')::numeric");
  assert.equal(jsonExtract('postgres', 'event_properties', 'currency', 'string'), "(event_properties->>'currency')");
});

test('jsonExtract bigquery and snowflake', () => {
  assert.equal(jsonExtract('bigquery', 'event_properties', 'level', 'int'), "CAST(JSON_VALUE(event_properties, '$.level') AS INT64)");
  assert.equal(jsonExtract('snowflake', 'event_properties', 'revenue', 'numeric'), 'event_properties:revenue::NUMBER');
});

test('jsonExtract rejects unsafe keys', () => {
  assert.throws(() => jsonExtract('postgres', 'event_properties', "x'); drop table--", 'string'));
});

test('sqlLiteral escapes single quotes and types', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral(5), '5');
  assert.equal(sqlLiteral(true), 'TRUE');
  assert.equal(sqlLiteral(null), 'NULL');
});

test('isNumericType', () => {
  assert.equal(isNumericType('int'), true);
  assert.equal(isNumericType('numeric'), true);
  assert.equal(isNumericType('string'), false);
});
