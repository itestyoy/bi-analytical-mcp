// The environment is read by one parser per kind of setting (src/config.js) — input handling, the
// kind of non-data check the project rules allow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFlag, envNumber, envInt, envString } from '../../src/config.js';

test('a flag is on or off only when it says so; anything else is the default', () => {
  const env = { A: 'on', B: 'FALSE', C: 'maybe', D: '' };
  assert.equal(envFlag('A', false, env), true);
  assert.equal(envFlag('B', true, env), false);
  assert.equal(envFlag('C', true, env), true);
  assert.equal(envFlag('D', false, env), false);
  assert.equal(envFlag('E', undefined, env), undefined);
});

test('an explicit 0 is honoured; unset, empty or not a number is the default', () => {
  const env = { ZERO: '0', N: '2.5', BAD: 'x', EMPTY: '', NEG: '-1' };
  assert.equal(envNumber('ZERO', 3000, {}, env), 0);
  assert.equal(envNumber('N', 1, {}, env), 2.5);
  assert.equal(envNumber('BAD', 7, {}, env), 7);
  assert.equal(envNumber('EMPTY', 7, {}, env), 7);
  assert.equal(envNumber('NEG', 7, {}, env), 7);
  assert.equal(envNumber('ZERO', 600, { min: 1 }, env), 600, 'below the minimum is the default');
  assert.equal(envInt('N', 5, {}, env), 5, 'a fraction is no whole number');
  assert.equal(envString('EMPTY', 'd', env), 'd');
});
