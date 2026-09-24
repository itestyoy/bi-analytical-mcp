// THE MIGRATION SCRIPT (scripts/meta-to-config.py) moves `meta:` under `config:` — where dbt 1.10
// put it, and the only place dbt Fusion reads. A schema file is written by people, so the rewrite is
// line-based: comments, blank lines and quoting survive, and only the `meta:` line and the block
// under it move. What must never happen is a rewrite that means something else — 260 blocks in one
// file is not something anyone re-reads by hand.
//
// So this test runs the script for real and checks the only thing that matters: the catalog built
// from the rewritten file is IDENTICAL to the catalog built from the original, and the file is
// still the file its author wrote (comments in place, nothing else moved).
//
// Lifecycle checks on a tool of this repo; nothing here asserts on generated SQL or YAML we emit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/meta-to-config.py', import.meta.url));
const PY = ['python3', join(process.cwd(), '.venvs', 'dbt1', 'bin', 'python')].find((p) => p === 'python3' || existsSync(p));

const LEGACY = `version: 2

# A hand-written schema file: the comments and the blank lines below are the point.
models:
  - name: fct_events
    description: "Events fact."
    meta:
      mcp:
        role: events            # the logical name the tools use
        primary_entity: event
        known_events: [login, purchase]

    columns:
      # the grain
      - name: user_id
        data_type: string
        meta:
          mcp:
            entity: { name: user, type: foreign }

      - name: ts
        data_type: timestamp
        description: "Event time."
        meta: { mcp: { is_time: true } }

      - name: event_name
        data_type: string
        meta:
          mcp:
            is_event_name: true

      - name: amount_of_event_data
        data_type: numeric
        meta:
          mcp:
            property: true
            measure: { unit: usd }

  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - name: user_id
        data_type: string
        meta:
          mcp:
            entity: { name: user, type: primary }
      - name: country
        data_type: string
`;

const run = (args) => execFileSync(PY, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the migrated file builds the SAME catalog, and keeps the file a human wrote', (t) => {
  if (!PY) return t.skip('no python3');
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  const file = join(dir, 'schema.yml');
  writeFileSync(file, LEGACY);
  const before = loadCatalog(file, { dialect: 'duckdb' });

  const out = run(['--write', file]);
  assert.match(out, /5 meta block\(s\)|meta block\(s\)/);

  const migrated = readFileSync(file, 'utf8');
  const after = loadCatalog(file, { dialect: 'duckdb' });
  assert.deepEqual(JSON.parse(JSON.stringify(after.raw)), JSON.parse(JSON.stringify(before.raw)), 'the catalog is unchanged');

  // the shape dbt 1.10+ (and Fusion) wants, on the model and on the column alike
  assert.match(migrated, /^ {4}config:\n {6}meta:\n {8}mcp:\n {10}role: events/m);
  assert.match(migrated, /^ {8}config:\n {10}meta:\n {12}mcp:\n {14}entity: \{ name: user, type: foreign \}/m);
  assert.match(migrated, /^ {8}config:\n {10}meta: \{ mcp: \{ is_time: true \} \}/m, 'an inline meta moves as it is');
  assert.ok(!/^ {4}meta:/m.test(migrated) && !/^ {8}meta:/m.test(migrated), 'nothing is left in the old place');

  // the author's file is still the author's file
  assert.match(migrated, /# A hand-written schema file/);
  assert.match(migrated, /role: events {12}# the logical name the tools use/);
  assert.match(migrated, /# the grain/);
  assert.match(migrated, /description: "Event time\."/);
});

test('--check reports without touching anything, and an already-migrated file is a no-op', (t) => {
  if (!PY) return t.skip('no python3');
  const dir = mkdtempSync(join(tmpdir(), 'migrate2-'));
  const file = join(dir, 'schema.yml');
  writeFileSync(file, LEGACY);

  // --check: says what it would do, exits 1 (so it can gate a build), changes nothing
  let code = 0;
  try { run(['--check', file]); } catch (e) { code = e.status; }
  assert.equal(code, 1, '--check exits 1 while something is still in the old place');
  assert.equal(readFileSync(file, 'utf8'), LEGACY, '--check writes nothing');

  run(['--write', file]);
  const once = readFileSync(file, 'utf8');
  run(['--write', file]);
  assert.equal(readFileSync(file, 'utf8'), once, 'running it again changes nothing');
  assert.equal(run(['--check', file]).trim().endsWith('0 skipped'), true, 'and --check is clean afterwards');
});

test('it refuses to guess: a block that already has its own config: is reported, not merged', (t) => {
  if (!PY) return t.skip('no python3');
  const dir = mkdtempSync(join(tmpdir(), 'migrate3-'));
  const file = join(dir, 'schema.yml');
  writeFileSync(file, `version: 2
models:
  - name: fct_events
    config:
      materialized: table
    meta:
      mcp:
        role: events
    columns:
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
`);
  let stderr = '';
  try { run(['--check', file]); } catch (e) { stderr = String(e.stderr || ''); }
  assert.match(stderr, /sibling `config:`/, 'the caller is told which block needs a human');
  assert.match(readFileSync(file, 'utf8'), /^ {4}meta:$/m, 'and that block is left exactly as it was');
});

// The catalogs this repo ships are the template a deployment copies into its own dbt project, so
// they must already be in the place dbt 1.10+ reads.
test('the catalogs shipped with this server are already migrated', (t) => {
  if (!PY) return t.skip('no python3');
  const out = run(['--check', 'config/catalog.yml', 'test/integration/fixtures/catalog.yml']);
  assert.match(out, /0 meta block\(s\) in 0 file\(s\)/, `still carrying pre-1.10 meta: ${out}`);
});
