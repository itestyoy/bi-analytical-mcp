// THE QUERY TAG (src/dbt/query-tag.js): technical facts about where a warehouse query came from,
// carried by the call's async context — from a tool call into the tasks it starts — and made safe
// to sit inside a SQL block comment. (That it reaches the warehouse, without changing a number, is
// test/integration/query-tag.test.js.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQueryTag, queryTag } from '../../src/dbt/query-tag.js';
import { currentTag, withSignal, withTag } from '../../src/request-context.js';

test('a tag is one JSON object naming the app, with every value kept inside the comment it rides in', () => {
  const text = formatQueryTag({ client: 'claude-ai/1.2', ua: 'Mozilla */ DROP TABLE x; /* \n', tool: 'query_semantic_model', task: undefined });
  assert.ok(!text.includes('*/') && !text.includes('/*') && !text.includes('\n'), text);
  const tag = JSON.parse(text);
  assert.equal(tag.app, 'dbt-semantic-mcp');
  assert.equal(tag.client, 'claude-ai/1.2');
  assert.equal(tag.tool, 'query_semantic_model');
  assert.ok(!('task' in tag), 'an absent fact is left out, not written as null');
  assert.equal(formatQueryTag({}), null);
  assert.equal(formatQueryTag(null), null);
  assert.ok(formatQueryTag({ ua: 'x'.repeat(5000) }).length <= 600, 'bounded');
});

test('the tag travels with the call: nested facts merge, a signal keeps them, outside a call there is none', async () => {
  assert.equal(currentTag(), null);
  assert.equal(queryTag(), null);
  const seen = await withTag({ client: 'c/1', tool: 't' }, () => withSignal(new AbortController().signal, () => withTag({ task: 'k1' }, async () => {
    await null;
    return currentTag();
  })));
  assert.deepEqual(seen, { client: 'c/1', tool: 't', task: 'k1' });
});

test('a task started by a call carries the call\'s tag plus its own id and context into its work', async () => {
  const { Engine } = await import('../../src/engine.js');
  const { loadCatalog } = await import('../../src/catalog.js');
  const { ContextManager } = await import('../../src/context-manager.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'config', 'catalog.yml'), {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'tag-')) }) });
  let inside;
  const id = withTag({ client: 'c/1', tool: 'query_pipeline_model' }, () => engine._startTask({ id: 'ctx9' }, 'query_pipeline_model', async () => { inside = currentTag(); return { ok: true }; }));
  await engine._awaitTasks([id], 5);
  assert.deepEqual(inside, { client: 'c/1', tool: 'query_pipeline_model', task: id, context: 'ctx9' });
});
