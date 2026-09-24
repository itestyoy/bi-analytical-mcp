// TELLING A CLIENT THAT THE SURFACE CHANGED — the three mechanisms of src/surface-change.js:
// a short cache lifetime on the cacheable results, list_changed on an open subscriptions/listen
// stream after a start that changed the surface, and the surface's fingerprint in
// serverInfo.version. Protocol and lifecycle checks (the persisted fingerprint); no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { surfaceChange, SurfaceChangeBus, LIST_TTL_MS, CHANGE_WINDOW_MS } from '../../src/surface-change.js';
import { startServer, V } from '../helpers/mcp-http.js';

test('the fingerprint is kept across starts: a change is a change, the same surface is not', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'surface-')), 'mcp.sqlite');
  const open = () => openStore({ dbPath });
  let s = open();
  assert.equal(surfaceChange(s, 'aaa').changed, true, 'a first start: nothing is known to be cached');
  s.close();
  s = open();
  assert.deepEqual([surfaceChange(s, 'aaa').changed, surfaceChange(s, 'aaa').previous], [false, 'aaa'], 'restarted with the same surface');
  s.close();
  s = open();
  const moved = surfaceChange(s, 'bbb');
  assert.deepEqual([moved.changed, moved.previous], [true, 'aaa'], 'a deploy that changed it');
  s.close();
});

test('a changed start announces itself to each new subscriber within the window — and only then', () => {
  let t = 1000;
  const heard = (bus) => { const got = []; bus.subscribe((e) => got.push(e.kind)); return got; };
  const changed = new SurfaceChangeBus({ changed: true, since: 1000 }, { now: () => t });
  assert.deepEqual(heard(changed), ['tools_list_changed', 'resources_list_changed']);
  t = 1000 + CHANGE_WINDOW_MS + 1;
  assert.deepEqual(heard(changed), [], 'past the window every cache from before has expired');
  assert.deepEqual(heard(new SurfaceChangeBus({ changed: false, since: 1000 }, { now: () => 1000 })), [], 'an unchanged start says nothing');
  // publishing still reaches every subscriber (the SDK's own bus underneath)
  const bus = new SurfaceChangeBus({ changed: false, since: 0 });
  const got = heard(bus);
  bus.publish({ kind: 'tools_list_changed' });
  assert.deepEqual(got, ['tools_list_changed']);
});

test('over HTTP: short cache lifetimes, listChanged declared, the fingerprint in the version, and the change on a listen stream', async () => {
  const s = await startServer();
  try {
    const discover = (await s.modern('server/discover')).body.result;
    assert.equal(discover.capabilities.tools.listChanged, true);
    assert.equal(discover.capabilities.resources.listChanged, true);
    // (in 2026-07-28 the server's identity rides in the result's _meta)
    assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].version, `0.1.0+${s.services.surface.fingerprint}`);
    assert.deepEqual([discover.ttlMs, discover.cacheScope], [LIST_TTL_MS, 'private'], 'server/discover: the version is re-read within a minute');
    for (const method of ['tools/list', 'resources/list']) {
      const r = (await s.modern(method)).body.result;
      assert.deepEqual([r.ttlMs, r.cacheScope], [LIST_TTL_MS, 'private'], `${method}: a change reaches a client within a minute`);
    }

    // a fresh server's store has no fingerprint on record: this start counts as a change, and a
    // subscription opened now hears it right after its acknowledgement
    const ctl = new AbortController();
    const res = await fetch(s.url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': V, 'mcp-method': 'subscriptions/listen' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true, resourcesListChanged: true }, _meta: { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' } } } }),
    });
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(text.includes('notifications/tools/list_changed') && text.includes('notifications/resources/list_changed'))) {
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => { setTimeout(() => r({ done: false }), 200); })]);
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    ctl.abort();
    const methods = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)).method);
    assert.deepEqual(methods.slice(0, 3), ['notifications/subscriptions/acknowledged', 'notifications/tools/list_changed', 'notifications/resources/list_changed']);
  } finally { await s.stop(); }
});
