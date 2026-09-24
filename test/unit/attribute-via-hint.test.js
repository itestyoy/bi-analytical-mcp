import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

// Allowed non-data test: the property page's RECOMMENDATION (a UX affordance), not query
// correctness. An attribute of a model that a source reaches through SEVERAL relationships is
// refused by the query resolver without `via`, so the page that tells the caller how to group by
// it must name the choice — the same candidates the resolver would list.
const CATALOG = `version: 2
models:
  - name: fct_events
    meta: { mcp: { role: events, primary_entity: event, known_events: [first_launch] } }
    columns:
      - name: player_id
        data_type: string
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - name: referrer_code
        data_type: string
        meta: { mcp: { entity: { name: referrer, type: foreign } } }
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
      - name: referral_code
        data_type: string
        meta: { mcp: { entity: { name: referrer, type: unique } } }
      - name: country
        data_type: string
`;

function engine() {
  const dir = mkdtempSync(join(tmpdir(), 'viahint-'));
  writeFileSync(join(dir, 'catalog.yml'), CATALOG);
  return settle(new Engine({ catalog: loadCatalog(join(dir, 'catalog.yml'), {}), recipes: loadRecipes(null), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'viahint-ws-')) }) }));
}

test('an attribute reached through several relationships: its page names via and every choice', async () => {
  const e = engine();
  const page = await e.semantic_index({ source: 'users', property: 'country' });
  const rec = page.recommendations.find((r) => r.includes("model: 'users'"));
  assert.ok(rec, JSON.stringify(page.recommendations));
  assert.match(rec, /from 'events' add via: one of 'user', 'referrer'|from 'events' add via: one of 'referrer', 'user'/);
});

test('recipe files are split on commas only: a path with a colon is one path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vol:ro-'));
  const file = join(dir, 'recipes.json');
  writeFileSync(file, JSON.stringify({ recipes: [{ id: 'deploy_only', title: 'x', task_type: 'pipeline' }] }));
  const r = loadRecipes(null, file);
  assert.ok(r.get('deploy_only'), 'the deployment recipe under a colon path is loaded');
});
