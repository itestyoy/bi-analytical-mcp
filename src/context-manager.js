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

  /** Create a fresh context: allocate id + a FULL independent copy of the base project. */
  create() {
    const id = newContextId();
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    if (this.baseProjectDir && existsSync(this.baseProjectDir)) {
      // Copy the reference project ENTIRELY AS-IS, including target/ (parse
      // artifacts). Exclude only runtime logs/ and the .mcp workspace dir — the
      // latter must be skipped to avoid recursively copying other contexts when
      // the workspace lives inside the project tree.
      cpSync(this.baseProjectDir, dir, {
        recursive: true,
        filter: (src) => !/(\/logs(\/|$)|\/\.mcp(\/|$))/.test(src),
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

  /** Scan the overlay's models/ for a `time_spine:` config and for a metricflow_time_spine.sql. */
  _timeSpinePresence(id) {
    const modelsDir = join(this.dir(id), 'models');
    let hasConfig = false; let hasModelFile = false;
    if (!existsSync(modelsDir)) return { hasConfig, hasModelFile };
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (name === 'metricflow_time_spine.sql') hasModelFile = true;
        if (/\.ya?ml$/.test(name)) { try { if (readFileSync(p, 'utf8').includes('time_spine:')) hasConfig = true; } catch { /* unreadable → ignore */ } }
      }
    };
    walk(modelsDir);
    return { hasConfig, hasModelFile };
  }

  /**
   * Ground-truth report of the time-spine state in a context's overlay — attached to a parse
   * error so a "no time spine configured" failure is self-diagnosing (which files actually exist,
   * whether a `time_spine:` config is present, and where). Turns an opaque backend failure into
   * evidence: if the config is present here but dbt still rejects it, the runtime dbt/DSI is too
   * old for the modern `time_spine:` form; if it is absent, the overlay was never generated.
   */
  timeSpineDiagnostics(id) {
    const { hasConfig, hasModelFile } = this._timeSpinePresence(id);
    const modelsDir = join(this.dir(id), 'models');
    const configFiles = [];
    if (existsSync(modelsDir)) {
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) { walk(p); continue; }
          if (/\.ya?ml$/.test(name)) { try { if (readFileSync(p, 'utf8').includes('time_spine:')) configFiles.push(p.slice(this.dir(id).length + 1)); } catch { /* ignore */ } }
        }
      };
      walk(modelsDir);
    }
    // Read the COMPILED semantic manifest dbt/MetricFlow actually consume. This is the smoking
    // gun: `time_spines` here is the exact list MetricFlow checks — populated means dbt registered
    // our config (so a still-failing mf points elsewhere); empty despite the config file present
    // means the runtime dbt-core silently dropped the modern `time_spine:` property (too old).
    let manifest = { present: false };
    try {
      const mf = join(this.dir(id), 'target', 'semantic_manifest.json');
      if (existsSync(mf)) {
        const doc = JSON.parse(readFileSync(mf, 'utf8'));
        const pc = doc.project_configuration || {};
        const spines = pc.time_spines || [];
        const legacy = pc.time_spine_table_configurations || [];
        manifest = {
          present: true,
          mtime: statSync(mf).mtimeMs,
          time_spines_count: spines.length,
          time_spine_relations: spines.map((s) => s.node_relation?.relation_name || s.node_relation?.alias).filter(Boolean),
          legacy_time_spine_count: legacy.length,
          semantic_models: (doc.semantic_models || []).map((s) => s.name),
        };
      }
    } catch { manifest = { present: false, unreadable: true }; }

    // The manifest is the authority: if it has NO time spine but the config file IS present, the
    // runtime dbt did not register it (version too old) — that beats any file-level heuristic.
    const manifestMissesSpine = manifest.present && hasConfig && manifest.time_spines_count === 0 && manifest.legacy_time_spine_count === 0;
    return {
      overlay_dir: this.dir(id),
      generated_files: this.generatedFiles(id),
      time_spine_configured: hasConfig,
      time_spine_model_present: hasModelFile,
      time_spine_config_files: configFiles,
      compiled_manifest: manifest,
      hint: manifestMissesSpine
        ? 'DECISIVE: the config file is in the overlay but the COMPILED semantic_manifest.json has ZERO time spines — the runtime dbt-core did NOT register the modern `time_spine:` property. That property needs dbt-core >= 1.9; an older dbt drops it silently. Check the `runtime` version below and reinstall Python deps (pip --no-cache-dir) so dbt-core matches requirements.'
        : hasConfig
          ? 'A `time_spine:` config IS present in this overlay. If the compiled manifest below shows time_spines populated yet MetricFlow still errors, mf is reading a different/stale manifest; otherwise the runtime dbt is too old to register it (needs dbt >= 1.9).'
          : 'No `time_spine:` config found in this overlay — the spine was not generated for this context. Confirm the running image includes ensureTimeSpine (commits 2356133/9427a02/225f72c) and that models/generated is under model-paths.',
    };
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
    return existsSync(d) ? readdirSync(d).map((f) => join('models', 'generated', f)) : [];
  }
}
