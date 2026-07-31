// Execution contexts: each context is its OWN fully independent dbt project — a
// complete copy of the reference (base) project, taken verbatim (including the
// `target/` parse artifacts: manifest, partial_parse, semantic_manifest) so the
// context behaves exactly like the reference and re-parses incrementally. Each
// has its own --project-dir, so parallel tasks never share a semantic_manifest or
// collide on names. We do NOT carve selected files into a shared base; the whole
// project is duplicated and the generated models are added under models/generated.

import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { sqlConfigHeader } from './sql-header.js';

// A daily time spine is REQUIRED by MetricFlow for metric_time, grains,
// cumulative and conversion metrics. We guarantee the model file is always
// present in every context overlay (predefined model). NOTE: it must also be
// materialized in the warehouse (dbt run --select metricflow_time_spine) — that
// is the base project's responsibility; the server only guarantees the file.
function timeSpineSql(dialect, start, end) {
  const header = sqlConfigHeader('time_spine', { model: 'metricflow_time_spine', dialect, start, end, granularity: 'day' });
  if (dialect === 'bigquery') {
    return `{{ config(materialized='table') }}\n${header}select d as date_day\nfrom unnest(generate_date_array('${start}', '${end}', interval 1 day)) as d\n`;
  }
  // postgres (default)
  return `{{ config(materialized='table') }}\n${header}select d::date as date_day\nfrom generate_series('${start}'::date, '${end}'::date, interval '1 day') as d\n`;
}

const TIME_SPINE_YML = `models:
  - name: metricflow_time_spine
    time_spine:
      standard_granularity_column: date_day
    columns:
      - name: date_day
        granularity: day
`;

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
  constructor({ baseProjectDir, workspaceRoot, registryPath, timeSpineDialect = 'postgres', timeSpineStart = '2020-01-01', timeSpineEnd = '2035-12-31' } = {}) {
    this.baseProjectDir = baseProjectDir;
    this.workspaceRoot = workspaceRoot || join(process.cwd(), '.mcp', 'ctx');
    this.registryPath = registryPath || join(this.workspaceRoot, 'registry.json');
    this.timeSpineDialect = timeSpineDialect;
    this.timeSpineStart = timeSpineStart;
    this.timeSpineEnd = timeSpineEnd;
    // The base project's model-paths decide which directories dbt actually scans. We MUST write
    // generated models/YAML under a scanned path — otherwise dbt never sees them and the compiled
    // semantic_manifest has zero semantic models + zero time spines ("none were found"). A project
    // with a custom model-paths (e.g. ["marts"]) does NOT include the default "models".
    this.modelPaths = this._readModelPaths();
    this.contexts = new Map(); // id -> { id, createdAt, lastUsedAt, state }
    this.leases = new Map(); // id -> count of in-flight ops
    mkdirSync(this.workspaceRoot, { recursive: true });
    this._load();
  }

  /** Read model-paths from the base dbt_project.yml (dbt default is ["models"]). */
  _readModelPaths() {
    try {
      const f = this.baseProjectDir && join(this.baseProjectDir, 'dbt_project.yml');
      if (f && existsSync(f)) {
        const doc = yaml.load(readFileSync(f, 'utf8')) || {};
        const mp = doc['model-paths'] || doc.model_paths || doc.source_paths; // source-paths: pre-1.0 alias
        if (Array.isArray(mp) && mp.length) return mp.map(String);
      }
    } catch { /* fall through to default */ }
    return ['models'];
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

  // Generated files go under the FIRST base model-path (a directory dbt is guaranteed to scan),
  // in a `generated/` subdir. For a default project this is models/generated (unchanged); for a
  // custom model-paths like ["marts"] it becomes marts/generated — visible to `dbt parse`.
  generatedDir(id) {
    return join(this.dir(id), this.modelPaths[0] || 'models', 'generated');
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

  /** Create a fresh context: allocate id + a FULL independent copy of the base project. */
  create() {
    const id = newContextId();
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    if (this.baseProjectDir && existsSync(this.baseProjectDir)) {
      // Copy the reference project. Exclude logs/ and the .mcp workspace dir (the latter to avoid
      // recursively copying other contexts when the workspace lives inside the project tree).
      //
      // ALSO exclude the base's partial-parse cache and its compiled semantic_manifest.json. We
      // INJECT new files (context.yml + the time spine) into the overlay after copying; parsing
      // incrementally from a base cache that predates those files is fragile (dbt itself warns
      // "run with --no-partial-parse as some deprecations are only encountered during parsing").
      // Worse, a parse that FAILS validation does not rewrite semantic_manifest.json, so a copied
      // stale one (semantic_models: []) is what MetricFlow then reads → "no time spine". Dropping
      // both forces the first parse to be a clean FULL parse that builds the manifest from the
      // overlay's ACTUAL files; dbt rebuilds its own cache for subsequent (fast) re-parses.
      cpSync(this.baseProjectDir, dir, {
        recursive: true,
        filter: (src) => !/(\/logs(\/|$)|\/\.mcp(\/|$)|\/target\/partial_parse\.msgpack$|\/target\/semantic_manifest\.json$)/.test(src),
      });
    }
    mkdirSync(this.generatedDir(id), { recursive: true });
    this.ensureTimeSpine(id);
    const ctx = { id, createdAt: Date.now(), lastUsedAt: Date.now(), state: { tasks: [], additions: {}, metrics: [], usedModels: [] } };
    this.contexts.set(id, ctx);
    this._persist();
    return ctx;
  }

  /**
   * Guarantee a time spine is CONFIGURED in the overlay (MetricFlow needs one for metric_time,
   * grains, cumulative/conversion metrics AND SCD validity_params joins). What matters is the
   * modern `time_spine:` CONFIG, not merely a model file named metricflow_time_spine — dbt >= 1.9
   * rejects a name-only model as "no time spine configured". So:
   *   - a `time_spine:` config already present anywhere → nothing to do;
   *   - a metricflow_time_spine.sql present but NOT configured → write ONLY the config yml (it
   *     attaches to that existing model; writing a second .sql would duplicate the model name);
   *   - neither → write both the model and the config.
   */
  ensureTimeSpine(id) {
    const { hasConfig, hasModelFile } = this._timeSpinePresence(id);
    if (hasConfig) return false;
    const dir = this.generatedDir(id);
    mkdirSync(dir, { recursive: true });
    if (!hasModelFile) writeFileSync(join(dir, 'metricflow_time_spine.sql'), timeSpineSql(this.timeSpineDialect, this.timeSpineStart, this.timeSpineEnd));
    writeFileSync(join(dir, '_mcp_time_spine.yml'), TIME_SPINE_YML);
    return true;
  }

  /** Back-compat: a time spine is present only when actually CONFIGURED (not just a name match). */
  hasTimeSpine(id) { return this._timeSpinePresence(id).hasConfig; }

  /** True when WE generated the time-spine MODEL in this overlay (so its table is NOT yet built
   *  in the warehouse and needs a `dbt run --select metricflow_time_spine`). A base-provided
   *  spine model is already materialized by the base project, so this returns false for it. */
  generatedTimeSpine(id) { return existsSync(join(this.generatedDir(id), 'metricflow_time_spine.sql')); }

  /** Directories dbt scans for this context (the base model-paths, resolved under the overlay). */
  _modelDirs(id) {
    return this.modelPaths.map((mp) => join(this.dir(id), mp));
  }

  /** Scan every scanned model-path for a `time_spine:` config and for a metricflow_time_spine.sql. */
  _timeSpinePresence(id) {
    let hasConfig = false; let hasModelFile = false;
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (name === 'metricflow_time_spine.sql') hasModelFile = true;
        if (/\.ya?ml$/.test(name)) { try { if (readFileSync(p, 'utf8').includes('time_spine:')) hasConfig = true; } catch { /* unreadable → ignore */ } }
      }
    };
    for (const d of this._modelDirs(id)) walk(d);
    return { hasConfig, hasModelFile };
  }

  /** Write the generated YAML for a context into its overlay. */
  writeYaml(id, yamlText) {
    const file = join(this.generatedDir(id), 'context.yml');
    mkdirSync(this.generatedDir(id), { recursive: true });
    writeFileSync(file, yamlText);
    return file;
  }

  /** Write a generated dbt model (.sql) into the context overlay. */
  writeModel(id, name, sql) {
    mkdirSync(this.generatedDir(id), { recursive: true });
    const file = join(this.generatedDir(id), `${name}.sql`);
    writeFileSync(file, sql);
    return file;
  }

  /** Remove a generated file (model or yaml) from the context overlay. */
  removeGeneratedFile(id, filename) {
    const file = join(this.generatedDir(id), filename);
    if (existsSync(file)) rmSync(file, { force: true });
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

  /**
   * Reclaim contexts idle longer than maxIdleMs that have NO in-flight leases.
   * Bounds workspace growth under sustained use. Returns the dropped ids.
   */
  gc(maxIdleMs) {
    if (!(maxIdleMs > 0)) return [];
    const now = Date.now();
    const dropped = [];
    for (const c of [...this.contexts.values()]) {
      if (this.leases.get(c.id)) continue; // never reclaim a context with a live build
      if (now - (c.lastUsedAt || c.createdAt) > maxIdleMs) {
        try { this.drop(c.id); dropped.push(c.id); } catch { /* in-flight; skip */ }
      }
    }
    return dropped;
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
    const rel = d.slice(this.dir(id).length + 1);
    return existsSync(d) ? readdirSync(d).map((f) => join(rel, f)) : [];
  }
}
