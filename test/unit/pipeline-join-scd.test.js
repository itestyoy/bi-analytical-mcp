import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

// Allowed non-data test: this asserts a NUDGE/recommendation (a UX affordance surfaced in the
// pipeline response), not query correctness and not generated SQL text. A key-only join to an
// SCD-2 dimension is silently wrong (fan-out), so the response must flag it so the caller fixes it.
const SCD_CATALOG = `version: 2
models:
  - name: fct_events
    meta: { mcp: { role: events, primary_entity: event, known_events: [first_launch, tutorial] } }
    columns:
      - name: player_id
        data_type: string
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - name: device_time
        data_type: timestamp
        meta: { mcp: { is_time: true } }
      - name: event_name
        data_type: string
        meta: { mcp: { is_event_name: true } }
      - name: event_data
        data_type: jsonb
        meta: { mcp: { is_event_data: true } }
  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - name: player_id
        data_type: string
        meta: { mcp: { entity: { name: user, type: primary } } }
      - name: country
        data_type: string
      - name: install_time_valid_from
        data_type: date
        meta: { mcp: { dimension: { validity: start } } }
      - name: install_time_valid_until
        data_type: date
        meta: { mcp: { dimension: { validity: end } } }
`;

function engine() {
  const dir = mkdtempSync(join(tmpdir(), 'scdjoin-'));
  const path = join(dir, 'catalog.yml');
  writeFileSync(path, SCD_CATALOG);
  const catalog = loadCatalog(path, {});
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'scdjoin-ws-')) }) }));
}

const hasIncompleteJoin = (recs) => (recs || []).some((r) => /INCOMPLETE JOIN/.test(r) && /SCD-2/.test(r));

test('key-only join to an SCD-2 dimension → response warns the join is incomplete (fan-out)', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'jtest', source: 'events' });
  const r = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'join', with: 'users', on: 'player_id', attrs: ['country'] } });
  assert.ok(hasIncompleteJoin(r.recommendations), `expected an incomplete-join warning, got: ${JSON.stringify(r.recommendations)}`);
  // the warning names the exact fix (event time + the validity columns)
  const w = r.recommendations.find((x) => /INCOMPLETE JOIN/.test(x));
  assert.match(w, /between/);
  assert.match(w, /install_time_valid_from/);
  assert.match(w, /install_time_valid_until/);
  assert.match(w, /device_time/);
});

test('SCD-2 join WITH a point-in-time between window → no incomplete-join warning', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'jtest', source: 'events' });
  const r = await e.build_native_model({
    action: 'add_step', draft_id: s.draft_id,
    stage: { stage: 'join', with: 'users', on: 'player_id', attrs: ['country'], between: { value: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' } },
  });
  assert.ok(!hasIncompleteJoin(r.recommendations), `no warning expected once between is present, got: ${JSON.stringify(r.recommendations)}`);
});
