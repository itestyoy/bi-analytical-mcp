// Execution contexts: isolated, per-context dbt overlay projects + a persistent
// registry. Each context gets its own --project-dir / --target-path so parallel
// tasks never share a semantic_manifest or collide on names.

import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function newContextId() {
  return randomBytes(6).toString('hex'); // 12 hex chars
}

/** Merge a freshly compiled declaration into the accumulated context state. */
export function mergeCompiled(state, compiled) {
  state.additions ||= {};
  state.metrics ||= [];
  state.usedModels ||= [];
  state.tasks ||= [];

  for (const [modelKey, add] of Object.entries(compiled.additions || {})) {
    const cur = (state.additions[modelKey] ||= { measures: [], dimensions: [] });
    cur.dimensions.push(...(add.dimensions || []));
    cur.measures.push(...(add.measures || []));
  }
  const seen = new Set(state.metrics.map((m) => m.name));
  for (const m of compiled.metrics || []) {
    if (!seen.has(m.name)) {
      state.metrics.push(m);
      seen.add(m.name);
    }
  }
  for (const k of compiled.usedModels || []) if (!state.usedModels.includes(k)) state.usedModels.push(k);
  if (compiled.task && !state.tasks.includes(compiled.task)) state.tasks.push(compiled.task);
  return state;
}

export class ContextManager {
  constructor({ baseProjectDir, workspaceRoot, registryPath } = {}) {
    this.baseProjectDir = baseProjectDir;
    this.workspaceRoot = workspaceRoot || join(process.cwd(), '.mcp', 'ctx');
    this.registryPath = registryPath || join(this.workspaceRoot, 'registry.json');
    this.contexts = new Map(); // id -> { id, createdAt, lastUsedAt, state }
    this.leases = new Map(); // id -> count of in-flight ops
    mkdirSync(this.workspaceRoot, { recursive: true });
    this._load();
  }

  _load() {
    if (!existsSync(this.registryPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      for (const c of data.contexts || []) {
        // reconcile: keep only contexts whose workspace still exists on disk
        if (existsSync(this.dir(c.id))) this.contexts.set(c.id, c);
      }
    } catch {
      /* corrupt registry -> start clean */
    }
  }

  _persist() {
    const data = { contexts: [...this.contexts.values()] };
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
  }

  dir(id) {
    return join(this.workspaceRoot, id);
  }

  targetPath(id) {
    return join('target', 'ctx', id);
  }

  generatedDir(id) {
    return join(this.dir(id), 'models', 'generated');
  }

  has(id) {
    return this.contexts.has(id);
  }

  get(id) {
    const c = this.contexts.get(id);
    if (!c) throw new Error(`unknown context_id: ${id}`);
    return c;
  }

  list() {
    const now = Date.now();
    return [...this.contexts.values()].map((c) => ({
      context_id: c.id,
      tasks: c.state.tasks || [],
      semantic_models: Object.keys(c.state.additions || {}),
      metrics: (c.state.metrics || []).map((m) => m.name),
      age_ms: now - c.createdAt,
    }));
  }

  /** Create a fresh context: allocate id + overlay project copied from base. */
  create() {
    const id = newContextId();
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    if (this.baseProjectDir && existsSync(this.baseProjectDir)) {
      cpSync(this.baseProjectDir, dir, {
        recursive: true,
        filter: (src) => !/(\/target(\/|$)|\/logs(\/|$)|\/\.mcp(\/|$))/.test(src),
      });
    }
    mkdirSync(this.generatedDir(id), { recursive: true });
    const ctx = { id, createdAt: Date.now(), lastUsedAt: Date.now(), state: { tasks: [], additions: {}, metrics: [], usedModels: [] } };
    this.contexts.set(id, ctx);
    this._persist();
    return ctx;
  }

  /** Write the generated YAML for a context into its overlay. */
  writeYaml(id, yamlText) {
    const file = join(this.generatedDir(id), 'context.yml');
    mkdirSync(this.generatedDir(id), { recursive: true });
    writeFileSync(file, yamlText);
    return file;
  }

  touch(id) {
    const c = this.get(id);
    c.lastUsedAt = Date.now();
    this._persist();
  }

  acquire(id) {
    this.leases.set(id, (this.leases.get(id) || 0) + 1);
  }

  release(id) {
    const n = (this.leases.get(id) || 1) - 1;
    if (n <= 0) this.leases.delete(id);
    else this.leases.set(id, n);
  }

  /** Tear down a whole context (waits on no in-flight leases). */
  drop(id) {
    if (!this.contexts.has(id)) return { removed: false };
    if (this.leases.get(id)) throw new Error(`context ${id} has in-flight operations`);
    const dir = this.dir(id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.contexts.delete(id);
    this._persist();
    return { removed: true };
  }

  /** List generated YAML files in a context overlay (debug/inspection). */
  generatedFiles(id) {
    const d = this.generatedDir(id);
    return existsSync(d) ? readdirSync(d).map((f) => join('models', 'generated', f)) : [];
  }
}
