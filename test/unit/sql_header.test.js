import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlConfigHeader } from '../../src/sql-header.js';

test('sqlConfigHeader wraps the source config as a YAML /* */ banner', () => {
  const h = sqlConfigHeader('native_model', { name: 'activation', sequence: { partition_by: 'user', steps: [{ name: 'launch' }] } });
  assert.ok(h.startsWith('/*'));
  assert.ok(h.trimEnd().endsWith('*/'));
  assert.ok(h.includes('native_model'));
  assert.ok(h.includes('name: activation')); // the config rendered as YAML
  assert.ok(h.includes('partition_by: user'));
});

test('sqlConfigHeader never throws on odd input', () => {
  assert.ok(sqlConfigHeader('x').startsWith('/*'));
  assert.ok(sqlConfigHeader('x', { a: undefined, b: 1 }).includes('/*'));
});
