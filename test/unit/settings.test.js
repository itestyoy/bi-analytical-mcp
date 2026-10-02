// EVERY SETTING HAS ONE HOME (src/settings.js): .env.example is rendered from the table, every
// variable src/ reads is a row of it, and every row the server reads is read somewhere — so a setting
// cannot be added, renamed or dropped in one place and forgotten in another.
//
// Checks on the configuration surface; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS, setting, loadSettings, renderEnvExample } from '../../src/settings.js';

const ROOT = new URL('../../', import.meta.url).pathname;

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'dist' || name === 'node_modules' ? [] : sources(p);
    return name.endsWith('.js') ? [p] : [];
  });
}

test('.env.example is the table, rendered', () => {
  assert.equal(readFileSync(join(ROOT, '.env.example'), 'utf8'), renderEnvExample(), 'regenerate it: npm run settings:example');
});

test('every variable src/ reads is a setting, and every setting the server reads is read', () => {
  const READS = [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /\bsetting\('([A-Z][A-Z0-9_]+)'/g,
    /\bS\.([A-Z][A-Z0-9_]+)/g,
    /\benv(?:Flag|Number|Int|String)\('([A-Z][A-Z0-9_]+)'/g,
    /\bflag: '([A-Z][A-Z0-9_]+)'/g,
  ];
  const read = new Map();
  for (const file of sources(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const re of READS) for (const m of text.matchAll(re)) if (!read.has(m[1])) read.set(m[1], file.slice(ROOT.length));
  }
  const unknown = [...read].filter(([name]) => !SETTINGS.has(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(unknown, [], 'a variable read in src/ is a row of src/settings.js');
  const unread = [...SETTINGS.values()].filter((r) => r.kind !== 'compose' && r.kind !== 'profile' && !read.has(r.name)).map((r) => r.name);
  assert.deepEqual(unread, [], 'a setting nothing reads is left over');
});

test('a setting is read as its kind says, with its default', () => {
  const env = { PORT: '8080', HOST: '', MCP_ALLOWED_ORIGINS: 'a.example, b.example ,', MCP_DB_RESET: 'yes', MCP_INDEX_BATCH: '0', MCP_REQUIRE_TIME_RANGE: 'maybe' };
  const s = loadSettings(env);
  assert.equal(s.PORT, 8080);
  assert.equal(s.HOST, '127.0.0.1', 'empty is the default');
  assert.deepEqual(s.MCP_ALLOWED_ORIGINS, ['a.example', 'b.example']);
  assert.equal(s.MCP_DB_RESET, true);
  assert.equal(s.MCP_INDEX_BATCH, 40, 'below its minimum is the default');
  assert.equal(s.MCP_REQUIRE_TIME_RANGE, undefined, 'a flag that says neither leaves it to the catalog');
  assert.equal(setting('DBT_TIMEOUT_SECONDS', { env: {}, fallback: 3600 }), 3600, 'a reader with its own default');
  assert.throws(() => setting('NOT_A_SETTING'), /not a setting/);
  assert.throws(() => setting('DBT_PROJECT_DIR'), /docker compose/);
  assert.ok(Object.isFrozen(s));
});
