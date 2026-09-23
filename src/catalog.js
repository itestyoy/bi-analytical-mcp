// Catalog (registry of dbt models) + derived enum sets and the entity-join
// graph. This is the single source of physical names; everything the AI can
// reference is projected from here into JSON-Schema enums.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { assetPath, missingAssetMessage } from './runtime-assets.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { isNumericType, SUPPORTED_DIALECTS, jsonExtract as jsonExtractSql } from './dialect.js';

export { SUPPORTED_DIALECTS };

// Aggregations a catalog measure may declare — dbt/MetricFlow's set. Any column or model
// measure may use ANY of these; nothing here is specific to a role or a column name.
export const MEASURE_AGGS = new Set(['sum', 'average', 'min', 'max', 'count', 'count_distinct', 'sum_boolean', 'median', 'percentile']);
// The aggregations that compute a NUMBER out of the values — the ones a non-numeric field has to be
// cast for. (count / count_distinct count rows, sum_boolean counts trues: any type will do.)
export const NUMERIC_AGGS = new Set(['sum', 'average', 'median', 'min', 'max', 'percentile']);

/**
 * Normalise one GOVERNED measure — the opt-in case where a declaration also fixes its
 * aggregation for everyone (model-level meta.mcp.measures entry, or a column-level
 * meta.mcp.measure) into the dbt shape. `expr` defaults to the column it is declared on.
 * Validates the aggregation so a typo fails at load with the allowed set, not at dbt parse.
 */
function normalizeMeasure(name, decl, { model, column } = {}) {
  const where = column ? `column '${column}' of model '${model}'` : `measure '${name}' of model '${model}'`;
  const agg = decl.agg;
  if (!MEASURE_AGGS.has(agg)) throw new Error(`${where}: unknown aggregation '${agg}' — use one of: ${[...MEASURE_AGGS].join(', ')}`);
  const expr = decl.expr ?? column;
  if (!expr) throw new Error(`${where}: a model-level measure needs an 'expr' (a SQL expression over the model's columns)`);
  const out = { agg, expr };
  if (agg === 'percentile') {
    const q = decl.percentile;
    if (!(typeof q === 'number' && q > 0 && q < 1)) throw new Error(`${where}: agg 'percentile' needs a 'percentile' between 0 and 1`);
    out.agg_params = { percentile: q, use_discrete_percentile: !!decl.use_discrete_percentile };
  }
  if (decl.label) out.label = decl.label;
  if (decl.description) out.description = decl.description;
  if (decl.unit) out.unit = decl.unit;
  return out;
}

/**
 * Normalise an AGGREGATABLE field: a column (or an expression over columns) the schema marks as
 * an AMOUNT rather than an attribute. It carries NO aggregation — which function to apply is the
 * caller's decision at build time, per question (a sum today, an average or a p90 tomorrow).
 * The schema only says WHAT may be aggregated, and what it means.
 */
function normalizeAggregatable(name, decl, { model, column, type } = {}) {
  const where = column ? `column '${column}' of model '${model}'` : `aggregatable '${name}' of model '${model}'`;
  const expr = decl.expr ?? column;
  if (!expr) throw new Error(`${where}: needs an 'expr' (a SQL expression over the model's columns) when it is not declared on a column`);
  return {
    name, expr, ...(column ? { column } : {}), ...(type ? { type } : {}),
    ...(decl.unit ? { unit: decl.unit } : {}),
    ...(decl.label ? { label: decl.label } : {}),
    ...(decl.description ? { description: decl.description } : {}),
  };
}

// Entity roles a join key may take. `primary`/`unique` make the model the join TARGET for
// that entity; `foreign` points at whichever model owns it; `natural` is the SCD-2 form.
export const ENTITY_TYPES = new Set(['primary', 'unique', 'foreign', 'natural']);

// The grains a key part may be joined on — the ones both dialects can truncate to.
export const KEY_PART_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);

/**
 * Normalise the PARTS of one key: a column name, or a list of them for a composite key. A part may
 * be written as `{ column, grain }` — the grain is the unit the two sides are compared at, and BOTH
 * sides render as the column TRUNCATED to it. That is what makes a per-day join a per-day join: a
 * timestamp on one side and a date on the other otherwise compare raw and match (almost) nothing.
 * A key part carries nothing else, so an unknown field is a mistake, not decoration.
 */
function normalizeKeyParts(raw, { where, columns }) {
  const parts = (Array.isArray(raw) ? raw : [raw]).map((p) => {
    if (typeof p === 'string') return { column: p };
    for (const k of Object.keys(p || {})) {
      if (k !== 'column' && k !== 'grain') throw new Error(`${where}: a key part takes 'column' and optionally 'grain' — '${k}' is not a key-part field`);
    }
    if (p?.grain !== undefined && !KEY_PART_GRAINS.has(p.grain)) {
      throw new Error(`${where}: grain '${p.grain}' is not one of ${[...KEY_PART_GRAINS].join(', ')}`);
    }
    return { column: p?.column, ...(p?.grain ? { grain: p.grain } : {}) };
  });
  if (!parts.length || parts.some((p) => !p.column)) {
    throw new Error(`${where}: 'key' needs a column name, or a list of them for a composite key`);
  }
  if (columns?.size) {
    for (const p of parts) if (!columns.has(p.column)) throw new Error(`${where}: '${p.column}' is not a column of the model`);
  }
  return parts;
}

/**
 * Normalise ONE declared join key into { type, key: [parts], column?, variants? }. `column` is
 * kept for the plain single-column case so everything that already reads it keeps working.
 */
function normalizeEntityKey(name, decl, { model, columns }) {
  const where = `entity '${name}' of model '${model}'`;
  if (!name) throw new Error(`${model}: an entity declaration needs a name`);
  const type = decl.type || 'foreign';
  if (!ENTITY_TYPES.has(type)) throw new Error(`${where}: unknown entity type '${type}' — use one of: ${[...ENTITY_TYPES].join(', ')}`);
  // VARIANTS: the same relationship carried by SEVERAL alternative key columns on this side —
  // e.g. a crash row that reports one tracking id per ad format. Each becomes its own
  // '<relationship>_<variant>' key, and the caller picks which one to join on.
  const variants = {};
  for (const [vName, vDecl] of Object.entries(decl.variants || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(vName)) throw new Error(`${where}: variant name '${vName}' must be lowercase snake_case`);
    if (vName.includes('__')) throw new Error(`${where}: variant name '${vName}' may not contain '__'`);
    const vRaw = Array.isArray(vDecl) || typeof vDecl === 'string' ? vDecl : (vDecl || {}).key ?? (vDecl || {}).column;
    variants[vName] = normalizeKeyParts(vRaw, { where: `${where} variant '${vName}'`, columns });
  }
  const raw = decl.key !== undefined ? decl.key : decl.column;
  if (raw === undefined) {
    if (!Object.keys(variants).length) throw new Error(`${where}: 'key' needs a column name, or a list of them for a composite key`);
    return { type, variants }; // variants only: this side has no single canonical key
  }
  const parts = normalizeKeyParts(raw, { where, columns });
  return { type, key: parts, ...(Object.keys(variants).length ? { variants } : {}) };
}

// Native dbt `data_type`s that map to a MetricFlow time dimension.
const TIME_DATA_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'timestamp_ntz', 'timestamp_tz', 'datetime', 'time']);

/** Logical dimension type derived from the native dbt column `data_type`. */
function dimTypeFromDataType(dataType) {
  return TIME_DATA_TYPES.has(String(dataType || '').toLowerCase()) ? 'time' : 'categorical';
}

/** Coarse pipeline type for a physical column (so native pipelines can reference it). */
function pipelineColumnType(cm, col) {
  if (cm.is_time) return 'time';
  if (cm.is_event_data) return 'json';
  if (cm.array) {
    const enc = cm.array.encoding || (String(col.data_type).toLowerCase() === 'string' ? 'json' : 'native');
    return enc === 'native' ? 'array' : 'string';
  }
  const dt = String(col.data_type || '').toLowerCase();
  if (TIME_DATA_TYPES.has(dt)) return 'time';
  return isNumericType(dt) ? 'numeric' : 'string';
}

/**
 * Reconcile a catalog against the warehouse: introspect each model's physical columns
 * (via the runner, same call semantic_index uses) and PRUNE declared columns/properties/
 * dimensions the table does not have — so the desync ("catalog declares a column the
 * physical table lacks") can never surface anywhere downstream. Best-effort: a model
 * whose relation can't be introspected is left as declared. Returns { pruned }.
 */
// How the adapters word "this relation is not there": Postgres/Redshift/DuckDB `relation … does not
// exist`, BigQuery `Not found: Table …`, Snowflake `… does not exist or not authorized`, Databricks
// `TABLE_OR_VIEW_NOT_FOUND`, dbt's own `… depends on a node named '…' which was not found`.
const RELATION_ABSENT = /does not exist|doesn't exist|not found|no such table|unknown table|could not find|table_or_view_not_found/i;

export async function groundCatalogToPhysical(catalog, runner, baseProjectDir, log = () => {}) {
  if (!runner || !baseProjectDir || typeof runner.relationColumns !== 'function') return { pruned: {} };
  const phys = {};
  const transient = [];
  const keys = catalog.modelKeys();
  for (const key of keys) {
    try {
      const r = await runner.relationColumns(baseProjectDir, catalog.getModel(key).dbt_model);
      if (r && r.ok && Array.isArray(r.columns)) { phys[key] = new Set(r.columns.map((c) => String(c.name).toLowerCase())); continue; }
      // dbt never got to ASK the warehouse (its own timeout, a signal, a spawn failure). That says
      // nothing about the table, so it is not evidence of an absent one. Told apart by OUTPUT, not
      // by stream: dbt ran means dbt printed — and it prints its diagnostics to STDOUT, leaving
      // stderr empty, so "error and no stderr" would have called every missing relation transient.
      if (r?.killed || r?.signal || (r?.error && !r?.stdout && !r?.stderr)) { transient.push([key, r.error || `dbt was killed by ${r.signal}`]); continue; }
      const said = String(r?.stderr || r?.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      // dbt ran and REPORTED the relation absent (not built, dropped, renamed, not a node of the
      // project): the model is UNAVAILABLE — declared, but nothing in the warehouse backs it, and
      // working on as declared would only move the failure to the first query. Anything else dbt
      // printed — a quota, an expired credential, a rate limit, a network blip — is the warehouse
      // being unwell, not evidence about this table, so it must not exclude the model for the
      // process lifetime: it stays as declared, like a dbt that never ran.
      if (!RELATION_ABSENT.test(said)) { transient.push([key, said || r?.error || 'introspection failed']); continue; }
      phys[key] = { unavailable: said || 'relation not found' };
    } catch (e) { transient.push([key, e?.message || 'introspection failed']); }
  }
  // When NOT ONE model could be introspected, the thing that is unavailable is the warehouse (or
  // dbt), not every table at once — a transient state a restart of the server cannot fix and must
  // not be frozen into the catalog for its lifetime. Keep the catalog as declared and say so.
  const failed = transient.length + Object.values(phys).filter((p) => p && p.unavailable).length;
  if (keys.length && failed === keys.length) {
    log(`catalog grounding SKIPPED: not one of the ${keys.length} models could be introspected — dbt or the warehouse is unreachable, so the catalog is served AS DECLARED and nothing is marked unavailable. First reason: ${transient[0]?.[1] || Object.values(phys)[0]?.unavailable}`);
    return { pruned: {} };
  }
  for (const [key, why] of transient) log(`catalog grounding: '${key}' was NOT checked (dbt could not run: ${why}) — it stays as declared`);
  return catalog.groundToPhysical(phys);
}

export function loadCatalog(path, opts = {}) {
  // A directory => a dbt project: discover the MCP-tagged models from its own
  // schema YAMLs (no separate catalog file needed).
  if (existsSync(path) && statSync(path).isDirectory()) return loadCatalogFromProject(path, opts);
  const text = readFileSync(path, 'utf8');
  let raw;
  if (/\.ya?ml$/i.test(path)) {
    const doc = yaml.load(text);
    // dbt model-schema notation (models: [ {name, columns, meta} ]) -> registry.
    // A plain registry object (models: {events:{..}}) is also accepted as-is.
    raw = Array.isArray(doc?.models) ? dbtSchemaToCatalog(doc) : doc;
  } else {
    raw = JSON.parse(text);
  }
  // The warehouse dialect is runtime config, NOT catalog data: resolve it from
  // the environment / the dbt profile dbt actually runs with — never the YAML.
  raw.warehouse_dialect = resolveDialect({ dialect: opts.dialect, profilesDir: opts.profilesDir, projectDir: opts.projectDir, fallback: raw.warehouse_dialect, report: (r) => { raw.dialect_fallback = r; } });
  raw.python_runtime = resolvePythonRuntime({ profilesDir: opts.profilesDir, projectDir: opts.projectDir });
  if (opts.requireTimeRange != null) raw.require_time_range = !!opts.requireTimeRange; // runtime override (e.g. MCP_REQUIRE_TIME_RANGE)
  return new Catalog(raw);
}

/**
 * Build the catalog directly from a dbt project's OWN model-schema YAMLs — no
 * separate catalog file. We scan the project's model-paths, collect every model
 * entry, and keep the ones tagged with `meta.mcp.role`. Each role must be carried
 * by EXACTLY ONE model (more than one per role is a config error).
 */
export function loadCatalogFromProject(projectDir, opts = {}) {
  const models = [];
  for (const mp of readModelPaths(projectDir)) collectSchemaModels(join(projectDir, mp), models);
  // `meta` may sit at the top level (dbt ≤ 1.9) or under `config:` (dbt 1.10+, and the only place
  // Fusion reads) — mcpMetaOf takes it from either.
  const mcpModels = models.filter((m) => { const mcp = mcpMetaOf(m); return mcp && (mcp.role || mcp.key); });
  if (!mcpModels.length) throw new Error(`no MCP-tagged models found under ${projectDir} (tag a dbt model with config.meta.mcp.role + role's key; the pre-1.10 top-level meta.mcp is read too)`);
  const byRole = new Map();
  for (const m of mcpModels) {
    const declared = mcpMetaOf(m);
    const role = declared.role || declared.key;
    if (byRole.has(role)) throw new Error(`config error: more than one model declares role '${role}' (${byRole.get(role)} and ${m.name}); exactly one model per role`);
    byRole.set(role, m.name);
  }
  const raw = dbtSchemaToCatalog({ models: mcpModels });
  raw.warehouse_dialect = resolveDialect({ dialect: opts.dialect, profilesDir: opts.profilesDir || projectDir, projectDir, fallback: raw.warehouse_dialect, report: (r) => { raw.dialect_fallback = r; } });
  raw.python_runtime = resolvePythonRuntime({ profilesDir: opts.profilesDir || projectDir, projectDir });
  if (opts.requireTimeRange != null) raw.require_time_range = !!opts.requireTimeRange; // runtime override (e.g. MCP_REQUIRE_TIME_RANGE)
  return new Catalog(raw);
}

/** A configured path list from dbt_project.yml (e.g. model-paths), with a default. */
function readPaths(projectDir, key, dflt) {
  try {
    const dp = yaml.load(readFileSync(join(projectDir, 'dbt_project.yml'), 'utf8')) || {};
    const v = dp[key] ?? dflt;
    return Array.isArray(v) ? v : [v];
  } catch {
    return dflt;
  }
}
function readModelPaths(projectDir) {
  return readPaths(projectDir, 'model-paths', readPaths(projectDir, 'source-paths', ['models']));
}

/** Basenames (without extension) of files matching `extRe` under the given dirs. */
function collectBasenames(projectDir, paths, extRe, acc = new Set()) {
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extRe.test(e.name)) acc.add(e.name.replace(extRe, ''));
    }
  };
  for (const mp of paths) walk(join(projectDir, mp));
  return acc;
}

/** Concatenated text of every .sql under the given dirs (for macro scanning). */
function readAllSql(projectDir, paths) {
  let text = '';
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.sql$/i.test(e.name)) { try { text += `\n${readFileSync(p, 'utf8')}`; } catch { /* skip */ } }
    }
  };
  for (const mp of paths) walk(join(projectDir, mp));
  return text;
}

// dbt macros the server shells out to (run-operation) and therefore REQUIRES.
const REQUIRED_MACROS = ['mcp_relation_columns'];

/**
 * Validate that a dbt project implements the components the server needs:
 *   - dbt_project.yml present
 *   - the required macro(s) defined (column introspection)
 *   - each catalog role's dbt node exists as a model (.sql) or seed (.csv)
 * Throws a single, actionable error listing everything missing.
 */
export function validateDbtProject(projectDir, catalog) {
  const problems = [];
  if (!existsSync(join(projectDir, 'dbt_project.yml'))) problems.push('dbt_project.yml not found (is this a dbt project?)');

  const macroText = readAllSql(projectDir, readPaths(projectDir, 'macro-paths', ['macros']));
  for (const name of REQUIRED_MACROS) {
    if (!new RegExp(`macro\\s+${name}\\s*\\(`).test(macroText)) {
      problems.push(`required macro '${name}' is not defined (needed for warehouse column introspection)`);
    }
  }

  const nodes = collectBasenames(projectDir, readModelPaths(projectDir), /\.sql$/i);
  collectBasenames(projectDir, readPaths(projectDir, 'seed-paths', ['seeds']), /\.csv$/i, nodes);
  for (const key of catalog.modelKeys()) {
    const name = catalog.getModel(key).dbt_model;
    if (name && !nodes.has(name)) problems.push(`role '${key}' references dbt node '${name}', which is not a model (.sql) or seed (.csv) in the project`);
  }

  if (problems.length) {
    throw new Error(`dbt project at ${projectDir} is missing required components:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Recursively collect `models:` entries from every *.yml/*.yaml under dir. */
function collectSchemaModels(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { collectSchemaModels(p, acc); continue; }
    if (!/\.ya?ml$/i.test(e.name)) continue;
    try {
      const doc = yaml.load(readFileSync(p, 'utf8'));
      if (Array.isArray(doc?.models)) for (const m of doc.models) if (m && m.name) acc.push(m);
    } catch { /* skip unparseable YAML */ }
  }
}

/**
 * Resolve the warehouse dialect (runtime config). Precedence:
 *   1. explicit `dialect` argument
 *   2. WAREHOUSE_DIALECT env var
 *   3. the active dbt profile's output `type` (what dbt actually connects with)
 *   4. `fallback` (legacy catalogs) / 'postgres'
 */
export function resolveDialect({ dialect, profilesDir, projectDir, fallback, report } = {}) {
  const fromProfile = dialectFromProfile(profilesDir, projectDir);
  const d = dialect || process.env.WAREHOUSE_DIALECT || fromProfile || fallback || 'postgres';
  if (!SUPPORTED_DIALECTS.has(d)) {
    throw new Error(`unsupported warehouse dialect '${d}' (supported: ${[...SUPPORTED_DIALECTS].join(', ')}). Set WAREHOUSE_DIALECT or fix the dbt profile output type.`);
  }
  // dbt connects with an adapter this server writes no SQL for (duckdb, snowflake…), and nothing
  // said otherwise: the SQL is then written in `d`'s dialect against that engine. It may well work
  // — but it is a fact about this deployment, not a detail, so it is reported rather than assumed.
  const profileType = String(profileOutput(profilesDir, projectDir)?.type || '').toLowerCase();
  if (report && profileType && !fromProfile) report({ profile_type: profileType, rendering_as: d, explicit: !!(dialect || process.env.WAREHOUSE_DIALECT) });
  return d;
}

/** The ACTIVE output of the dbt profile (the connection dbt runs with), or undefined. */
export function profileOutput(profilesDir, projectDir) {
  try {
    let profileName;
    if (projectDir) {
      const pj = join(projectDir, 'dbt_project.yml');
      if (existsSync(pj)) profileName = yaml.load(readFileSync(pj, 'utf8'))?.profile;
    }
    const dir = profilesDir || process.env.DBT_PROFILES_DIR || join(homedir(), '.dbt');
    const pp = join(dir, 'profiles.yml');
    if (!existsSync(pp)) return undefined;
    const profiles = yaml.load(readFileSync(pp, 'utf8')) || {};
    const prof = (profileName && profiles[profileName]) || profiles[Object.keys(profiles).filter((k) => k !== 'config')[0]];
    if (!prof) return undefined;
    const target = process.env.DBT_TARGET || prof.target || Object.keys(prof.outputs || {})[0];
    return prof.outputs?.[target] || undefined;
  } catch {
    return undefined; // best-effort
  }
}

/**
 * The python submission the PROJECT configures. `submission_method` is a MODEL config, not a
 * profile setting — dbt's bigquery macro reads it with `config.get("submission_method",
 * "serverless")` and nothing else. So the profile's compute_region / gcs_bucket say who may submit
 * a job, never how: a project with those settings and no submission config runs on the DEFAULT
 * submission, which is how a BigFrames-shaped model ended up as a Dataproc job (a Colab notebook
 * holding PySpark code, or a 403 on dataproc.batches.create when that path is not granted).
 *
 * dbt_project.yml is therefore the authoritative place, and it nests: `models: <project>: <dir>:
 * +submission_method`. The value is taken from anywhere in that tree — the deepest one wins, since
 * a more specific path overrides a broader one in dbt, and this server writes the SAME value into
 * every python model it generates.
 */
export function submissionFromProject(projectDir) {
  if (!projectDir) return undefined;
  try {
    const pj = join(projectDir, 'dbt_project.yml');
    if (!existsSync(pj)) return undefined;
    const doc = yaml.load(readFileSync(pj, 'utf8')) || {};
    let found;
    const walk = (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      if (typeof node['+submission_method'] === 'string') found = node['+submission_method'];
      else if (typeof node.submission_method === 'string') found = node.submission_method;
      for (const v of Object.values(node)) walk(v);
    };
    walk(doc.models);
    return found;
  } catch {
    return undefined; // best-effort, like every other read of the operator's files
  }
}

/** Read the adapter `type` from the dbt profile (the dialect dbt runs with). */
function dialectFromProfile(profilesDir, projectDir) {
  const type = profileOutput(profilesDir, projectDir)?.type;
  return type && SUPPORTED_DIALECTS.has(type) ? type : undefined;
}

/**
 * Can dbt run PYTHON models on this profile? Decided the way dbt itself would decide — from the
 * adapter and its settings in the active profile output — so the `python` pipeline stage is
 * offered only where it can actually run:
 *   - duckdb / snowflake / databricks: the adapter runs Python models as such;
 *   - bigquery: only with a submission set up — `submission_method`, or a Dataproc/BigFrames region
 *     (`dataproc_region` / `compute_region`) or cluster (`dataproc_cluster_name`);
 *   - postgres and everything else: no Python models at all.
 * MCP_PYTHON_MODELS=on|off overrides (on: the operator sets the submission per model via
 * MCP_PYTHON_MODEL_CONFIG; off: hide the stage regardless). Returns { available, runtime?, reason? }.
 */
export function resolvePythonRuntime({ profilesDir, projectDir, env = process.env } = {}) {
  // The operator's settings are read ONCE, here, and travel on the runtime: the tool schema, the
  // stage's own validation and the compiled model then describe and do the same thing. (An embedder
  // may override `config` on the catalog before the schemas are built — see Engine.)
  let config = {};
  try { config = JSON.parse(env.MCP_PYTHON_MODEL_CONFIG || '{}'); } catch { /* an unparseable pin is no pin */ }
  const packages = String(env.MCP_PYTHON_PACKAGES || '');
  const decided = (r) => ({ ...r, config, packages });
  const force = String(env.MCP_PYTHON_MODELS || '').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(force)) return decided({ available: false, reason: 'disabled by MCP_PYTHON_MODELS=off' });
  // No gate script in this build — no python stage. Every body must pass the static gate before a
  // model is submitted, so without it the stage cannot be admitted at all: say that HERE, where it
  // takes the stage out of the tool schema, instead of letting a caller write one and fail on the
  // spawn. An operator's MCP_PYTHON_MODELS=on cannot override a file that is not there.
  if (!assetPath('astGate')) return decided({ available: false, reason: missingAssetMessage('astGate') });
  const out = profileOutput(profilesDir, projectDir);
  const type = String(out?.type || '').toLowerCase();
  if (/^(on|1|true|yes)$/.test(force)) return decided({ available: true, runtime: type || 'unknown', forced: true });
  if (!out) return decided({ available: false, reason: 'no dbt profile found — dbt Python models need an adapter that runs them (BigQuery with a submission set up, Snowflake, Databricks, DuckDB)' });
  if (['duckdb', 'snowflake', 'databricks'].includes(type)) return decided({ available: true, runtime: type });
  if (type === 'bigquery') {
    // Where the submission comes from, most authoritative first:
    //   project  — dbt_project.yml `+submission_method`: a MODEL config, which is the only thing
    //              dbt's macro actually reads (config.get("submission_method", "serverless"));
    //   profile  — `submission_method` written in the profile output: not read by the macro, but
    //              an unambiguous statement of intent by the operator;
    //   inferred — only that method's SETTINGS are present (compute_region → bigframes,
    //              dataproc_region → serverless, a cluster name → cluster). A guess.
    // Whatever the source, the value is written into every generated model's dbt.config, so the
    // frame API the code is written against and the runtime it lands on cannot disagree — that
    // mismatch is what produced a Colab notebook full of PySpark, and a 403 on Dataproc.
    const fromProject = submissionFromProject(projectDir);
    const fromProfile = out.submission_method || null;
    const inferred = out.dataproc_cluster_name ? 'cluster' : (out.dataproc_region ? 'serverless' : (out.compute_region ? 'bigframes' : null));
    const method = fromProject || fromProfile || inferred;
    const method_source = fromProject ? 'dbt_project.yml' : (fromProfile ? 'profile' : (inferred ? 'inferred from the profile\'s settings' : null));
    if (method) return decided({ available: true, runtime: 'bigquery', method, method_source, method_declared: !!(fromProject || fromProfile) });
    return decided({ available: false, reason: 'the BigQuery profile has no Python submission set up: add submission_method (bigframes | serverless | cluster) with gcs_bucket and dataproc_region / compute_region to the profile output' });
  }
  return decided({ available: false, reason: `the '${type || 'unknown'}' adapter runs no dbt Python models` });
}

/**
 * WHERE `meta` LIVES IN A dbt SCHEMA FILE — both places, because dbt moved it.
 *
 * Up to dbt 1.9 a model or a column carried `meta:` as a property of its own. dbt 1.10 moved it
 * under `config:`; 1.11 still reads the old place and only warns (PropertyMovedToConfigDeprecation),
 * but dbt Fusion treats the top-level key as unknown (UnusedConfigKey, dbt1060) and DROPS it. A
 * catalog read from a Fusion-parsed project would then have no roles, no dimensions and no
 * measures at all — the whole MCP surface is in that block.
 *
 * So this reader takes it from either place, with `config.meta` winning key by key (dbt's own
 * precedence) for a project caught half-way through the move. Everything downstream keeps reading
 * `meta.mcp`, because this is the only door the two shapes come through.
 */
export function mcpMetaOf(node) {
  const legacy = node?.meta?.mcp;
  const moved = node?.config?.meta?.mcp;
  if (!legacy) return moved;
  if (!moved) return legacy;
  return { ...legacy, ...moved };
}

/** The same node with its MCP block in ONE place, so the rest of this file reads `meta.mcp`. */
function withNormalizedMeta(node) {
  const mcp = mcpMetaOf(node);
  if (!mcp || node.meta?.mcp === mcp) return node;
  return { ...node, meta: { ...(node.meta || {}), mcp } };
}

/**
 * Transform a dbt model-schema document into the internal catalog registry.
 * MCP semantics are read from `meta.mcp` at the model level (key/role/
 * primary_entity/known_events/measures) and the column level (entity/is_time/
 * is_event_name/is_event_data+properties/dimension).
 */
export function dbtSchemaToCatalog(doc) {
  // warehouse_dialect is intentionally NOT read from the catalog here; loadCatalog
  // resolves it from env/profile. `fallback` carries any legacy value if present.
  const out = { warehouse_dialect: doc.warehouse_dialect, models: {} };
  for (const raw of doc.models || []) {
    // dbt 1.10 moved `meta` under `config:` — on the model and on every column. Both shapes are
    // folded into one here (see mcpMetaOf), so nothing below has to know which file it came from.
    const model = { ...withNormalizedMeta(raw), ...(raw.columns ? { columns: raw.columns.map(withNormalizedMeta) } : {}) };
    const mcp = model.meta?.mcp || {};
    // The ROLE is the logical name — the dbt model can be named anything. (`key`
    // is still accepted as a legacy alias.) Nothing is hardcoded to a specific name.
    const key = mcp.role || mcp.key;
    if (!key) throw new Error(`catalog model '${model.name}' is missing config.meta.mcp.role (dbt 1.10+ keeps meta under config:; the pre-1.10 top-level meta.mcp is still read)`);
    const m = { dbt_model: model.name };
    if (model.description) m.description = model.description;
    if (mcp.role) m.role = mcp.role;
    if (mcp.primary_entity !== undefined) m.primary_entity = mcp.primary_entity;
    if (mcp.known_events) m.known_events = mcp.known_events;
    // Model-level declarations. An entry WITHOUT `agg` is an aggregatable EXPRESSION — the
    // caller picks the function; an entry WITH `agg` is additionally a governed measure whose
    // function is fixed (a standard KPI everyone must compute the same way).
    for (const [name, raw] of Object.entries(mcp.measures || {})) {
      const decl = raw || {};
      (m.aggregatable ||= {})[name] = normalizeAggregatable(name, decl, { model: model.name });
      if (decl.agg) (m.measures ||= {})[name] = normalizeMeasure(name, decl, { model: model.name });
    }
    // Business meaning of key events (e.g. acquisition_event: first_launch) — lets an
    // AI pick the right base events for retention/conversion without guessing.
    if (mcp.event_semantics) m.event_semantics = mcp.event_semantics;
    // The physical partition column (cost hint): queries should constrain it (or the
    // time column) to prune the scan. Surfaced statically — no live runner needed.
    if (mcp.partition_column) m.partition_column = mcp.partition_column;
    // Cost guardrail: when the anchor declares require_time_range, unbounded queries
    // (no time window) are rejected instead of full-scanning the warehouse.
    if (mcp.require_time_range != null) m.require_time_range = !!mcp.require_time_range;

    // A FACT (events source) is DETECTED structurally: a model declaring an
    // event_name / event_data column. SEVERAL facts may coexist — e.g. an analytics
    // events source and a Crashlytics one — and they are INDEPENDENT AND EQUAL: each
    // owns its event vocabulary (known_events + event-scoped properties) and its own
    // space in the value index, and the SOURCE is always a separate argument. A model
    // with neither column is not a fact even if it declares a time axis (a measures
    // source such as acquisition). There is NO default or "anchor" source: a source may
    // be omitted only when the catalog has exactly one.
    if (mcp.anchor !== undefined) {
      throw new Error(`model '${model.name}': meta.mcp.anchor is no longer a schema key — there is no default source. Every events source is addressed by name (semantic_index({ source }), build_native_model({ source }), semantic_models[].from); a source may be omitted only when the catalog has exactly one.`);
    }
    const isFact = (model.columns || []).some((c) => { const cm = c.meta?.mcp || {}; return cm.is_event_name || cm.is_event_data; });
    if (isFact) (out.facts ||= []).push(key);

    const entities = {};
    let primaryFromColumn = null; // the column that claimed this model's identity, if any
    const dimensions = {};
    const flatProps = {}; // fact-only: flattened event_data__* payload columns
    const columnDescriptions = {};
    const allColumns = []; // EVERY physical column (name + pipeline type) — referenceable in native pipelines
    for (const col of model.columns || []) {
      const cm = col.meta?.mcp || {};
      // A VALIDITY MARK only means something on a groupable time dimension — that is the only
      // place it can become validity_params. On a column that is a join key, a measure, the
      // model's time axis or an opted-out dimension, the branches below take the column first
      // and the mark would never be read: reject it here rather than let the author believe the
      // window is in effect.
      {
        const v = cm.dimension && typeof cm.dimension === 'object' ? cm.dimension.validity : undefined;
        const taken = cm.entity ? 'a join key (meta.mcp.entity)'
          : cm.is_time ? "the model's time axis (meta.mcp.is_time)"
            : (cm.measure && !cm.dimension) ? 'a measure (meta.mcp.measure)'
              : cm.is_event_name ? 'the event-name column' : cm.is_event_data ? 'the event-data payload' : null;
        if (v && taken) {
          throw new Error(`column '${col.name}' of model '${model.name}' is marked meta.mcp.dimension.validity: ${v}, but that column is ${taken}, so it never becomes a groupable time dimension and the window would be ignored. A validity window is a PAIR of separate time columns (start and end) on a slowly-changing dimension model.`);
        }
      }
      // Expose every REAL column to native pipelines — except the raw is_event_data
      // payload marker, which may not exist as a physical column once flattened.
      if (!cm.is_event_data) allColumns.push({ name: col.name, type: pipelineColumnType(cm, col) });
      if (col.description) columnDescriptions[col.name] = col.description; // dbt column doc
      if (cm.entity) {
        // A column-level entity is the single-column case of the same declaration.
        const ent = normalizeEntityKey(cm.entity.name, { type: cm.entity.type, key: col.name }, { model: model.name });
        // Two declarations of the SAME thing must not silently pick a winner: whichever the
        // loop happened to see last would decide the model's identity — or its join key — and
        // the author would never learn which of the two the manifest was built from.
        if (ent.type === 'primary') {
          // The model may already NAME its identity (meta.mcp.primary_entity: acquisition) — this
          // column then supplies its key, which is the normal pairing. What must not pass is a
          // SECOND column claiming the identity, or a column claiming a different name than the
          // model declared: either way one of the two declarations would be dropped in silence.
          const declaredName = primaryEntityName(m);
          if (primaryFromColumn) {
            throw new Error(`model '${model.name}': columns '${primaryFromColumn.column}' and '${col.name}' both declare a PRIMARY entity ('${primaryFromColumn.name}' and '${cm.entity.name}'). A model has exactly one identity — for a key that spans BOTH columns declare it once in meta.mcp.entities with a composite key; for a second join key use type: unique (still a join target) or foreign.`);
          }
          if (declaredName && declaredName !== cm.entity.name) {
            throw new Error(`model '${model.name}' declares meta.mcp.primary_entity '${declaredName}', but column '${col.name}' declares primary entity '${cm.entity.name}'. One of the two would be dropped — name the identity once.`);
          }
          primaryFromColumn = { name: cm.entity.name, column: col.name };
          m.primary_entity = { name: cm.entity.name, key: ent.key };
        } else {
          if (entities[cm.entity.name]) {
            throw new Error(`model '${model.name}': entity '${cm.entity.name}' is declared on two columns ('${(entities[cm.entity.name].key || []).map((p) => p.column).join(', ')}' and '${col.name}'). One relationship has one key here — use meta.mcp.entities with a composite key if it spans both columns, or 'variants' if they are alternative keys for it.`);
          }
          entities[cm.entity.name] = ent;
        }
        continue; // entity key columns are not dimensions
      }
      if (cm.is_time) {
        m.time = { column: col.name, granularity: cm.granularity || 'day' };
        // On an events source the time axis is the event time, surfaced as the fact's own
        // time dimension. On any OTHER source (an install record, a daily spend table) the
        // axis is equally a groupable attribute — "installs by install day" — so it stays in
        // the dimension list and everything reading dimensions keeps seeing it. Unless the
        // author opts out with meta.mcp.dimension: false, which means here exactly what it
        // means on any other column: a real column that is not an attribute to group by.
        if (!isFact && cm.dimension !== false) dimensions[col.name] = { type: 'time', granularity: m.time.granularity };
        continue;
      }
      // A column declared a MEASURE becomes an aggregatable amount of this model (any aggregation
      // from MEASURE_AGGS, on any column — nothing is special-cased). An amount is not a groupable
      // attribute, so on its own it is neither a dimension nor a value-index target; marked
      // meta.mcp.dimension AS WELL it is both (registered here, then it falls through to the
      // dimension branch below) — a numeric code people group by and occasionally sum.
      if (cm.measure) {
        // `measure: true` (or a bare object) MARKS the column as an amount: aggregatable with
        // ANY function, chosen per question at build time — the schema never fixes one. An
        // amount is not a groupable attribute, so it is neither a dimension nor a value-index
        // target. An optional `agg` ADDITIONALLY declares a governed measure with that fixed
        // function, under `name` — the free choice over the raw column stays either way.
        if (cm.measure !== true && (typeof cm.measure !== 'object' || Array.isArray(cm.measure))) {
          throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.measure must be true, or an object with unit/label/description (and optionally agg to also fix a governed measure)`);
        }
        const decl = cm.measure === true ? {} : cm.measure;
        m.aggregatable = m.aggregatable || {};
        m.aggregatable[col.name] = normalizeAggregatable(col.name, { ...decl, unit: decl.unit ?? cm.unit }, {
          model: model.name, column: col.name, type: pipelineColumnType(cm, col),
        });
        if (decl.agg) {
          const name = decl.name || col.name;
          (m.measures ||= {})[name] = normalizeMeasure(name, { ...decl, unit: decl.unit ?? cm.unit }, { model: model.name, column: col.name });
        }
        if (!cm.dimension) continue; // an amount alone is not an attribute
      }
      if (cm.is_event_name) { m.event_name = { column: col.name }; continue; }
      if (cm.is_event_data) {
        m.event_data_column = col.name;
        if (cm.properties) {
          for (const [pn, ps] of Object.entries(cm.properties)) {
            if (ps && (ps.values !== undefined || ps.events !== undefined)) throw new Error(`property '${pn}' of model '${model.name}' (meta.mcp.properties): 'values' / 'events' are no longer schema keys — both are measured by the value index. Keep type / items / fields / description.`);
          }
          m.properties = cm.properties;
        }
        continue;
      }
      // WHICH EVENTS CARRY A PROPERTY AND WHICH VALUES IT TAKES ARE MEASURED, NOT DECLARED. The
      // value index observes both per source and serves them everywhere (the { event },
      // { source, property } and { search } views, the filter-value guard, the event-scope warnings). A
      // declared list would only go stale in silence, so the schema no longer carries one: the
      // former meta.mcp.events / meta.mcp.values keys are refused with the replacement.
      if (cm.events !== undefined) {
        throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.events is no longer a schema key — which events carry a property is measured by the value index. To mark the column as an event-payload PROPERTY use meta.mcp.property: true (an array column needs only meta.mcp.array).`);
      }
      if (cm.values !== undefined || (cm.dimension && typeof cm.dimension === 'object' && cm.dimension.values !== undefined)) {
        throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.values is no longer a schema key — a column's real values and their frequencies come from the value index (semantic_index({ source, property })). Remove it; put the MEANING of special values in the description instead.`);
      }
      // Flattened event payload: on a FACT, a column marked meta.mcp.property (scalar) or
      // meta.mcp.array (array / array<struct>) is a per-event PROPERTY. These are REAL physical
      // columns — recorded with `column` so SQL references them directly (no JSON extract).
      if (isFact && !cm.dimension && cm.array) {
        // A flattened ARRAY/array<struct> payload column. `meta.mcp.array` declares how
        // to read it: encoding 'native' (a real ARRAY/REPEATED column) or 'json' (a STRING
        // holding a JSON array → parse before unnest). items = scalar element type;
        // fields = struct shape. The physical `column` is referenced directly.
        const a = cm.array;
        flatProps[col.name] = {
          type: a.fields ? 'array<struct>' : 'array',
          column: col.name,
          encoding: a.encoding || (String(col.data_type).toLowerCase() === 'string' ? 'json' : 'native'),
          ...(a.items ? { items: a.items } : {}),
          ...(a.fields ? { fields: a.fields } : {}),
          ...(cm.unit ? { unit: cm.unit } : {}),
          ...(col.description ? { description: col.description } : {}),
        };
        continue;
      }
      if (cm.property === true && !isFact) {
        throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.property marks an EVENT-PAYLOAD property, which only an events source has. On a dimension or measures source every unmarked column is already a groupable attribute.`);
      }
      if (isFact && !cm.dimension && cm.property === true) {
        // A flattened scalar event-payload property: a real column, populated on whichever
        // events carry it — the index finds out which. The column is named directly (no `__`,
        // which MetricFlow reserves), so it is used as-is for both the key and the expr. `unit`
        // (meta.mcp.unit, e.g. 'seconds', 'usd_cents') is machine-readable so values in different
        // units are never blindly mixed/summed.
        flatProps[col.name] = {
          type: isNumericType(col.data_type) ? 'numeric' : 'string',
          column: col.name,
          ...(cm.unit ? { unit: cm.unit } : {}),
          ...(col.description ? { description: col.description } : {}),
        };
        continue;
      }
      // Dimensions: on a non-fact (dimension) model, every remaining column is
      // a groupable dimension. Its TYPE comes from the native dbt `data_type`
      // (date/timestamp -> time, else categorical) — not from meta. Only the bits
      // dbt has no native field for stay in meta: time `granularity` (non-day)
      // and categorical `values` hints. `meta.mcp.dimension` is still honored.
      // meta.mcp.dimension: false takes a column OUT of the group-by surface (it stays a real
      // column a pipeline can reference) — the opt-out for anything that is not an attribute.
      if (cm.dimension === false) continue;
      if (cm.dimension || !isFact) {
        const explicit = cm.dimension || {};
        // A validity-window bound (meta.mcp.dimension.validity: start|end) marks the SCD-2 pair
        // MetricFlow uses for a point-in-time join — force it to a TIME dimension regardless of
        // the guessed type, and flag the model as slowly-changing.
        const validity = explicit.validity === 'start' || explicit.validity === 'end' ? explicit.validity : null;
        const type = validity ? 'time' : (explicit.type || dimTypeFromDataType(col.data_type));
        const d = { type };
        if (type === 'time') d.granularity = explicit.granularity || cm.granularity || 'day';
        if (validity) { d.validity = validity; m.scd = true; }
        // meta.mcp.index: false keeps a column out of the VALUE index (an id or a free-text
        // column has no enumerable value set worth scanning) while staying groupable.
        if (cm.index === false || explicit.index === false) d.index = false;
        dimensions[col.name] = d;
        // A dimension explicitly marked the BUNDLE/app identifier on an events source lets the
        // value index break coverage down per app (which properties are empty for which app).
        if (isFact && explicit.bundle) m.bundle_column = col.name;
      }
    }
    if (Object.keys(flatProps).length) m.properties = { ...(m.properties || {}), ...flatProps };
    m.columns = allColumns;
    // Model-level `meta.mcp.entities`: a join key that spans SEVERAL columns, or one relationship
    // carried by several ALTERNATIVE columns (`variants`). It lives on the MODEL because it
    // belongs to no single column. The same entity NAME on two models is the join between them, and the key is
    // declared once here rather than passed in at every call site.
    {
      const known = new Set(allColumns.map((c) => c.name));
      for (const [name, decl] of Object.entries(mcp.entities || {})) {
        const ent = normalizeEntityKey(name, decl || {}, { model: model.name, columns: known });
        if (ent.type === 'primary') {
          if (ent.variants) throw new Error(`entity '${name}' of model '${model.name}': a primary entity is the model's single identity and cannot have variants; declare the alternatives as type: unique or foreign.`);
          const prev = primaryEntityName(m);
          if (prev && prev !== name) throw new Error(`model '${model.name}' declares two primary entities ('${prev}' and '${name}'). A model has exactly one identity; declare the other key as type: unique (still a join target) or foreign.`);
          m.primary_entity = { name, key: ent.key };
        } else {
          // The same name declared BOTH on a column and here: the model-level entry would win
          // by position in the file. Say so instead — the author has two keys for one
          // relationship and must state which it is.
          if (entities[name]) {
            throw new Error(`model '${model.name}': entity '${name}' is declared both on column '${(entities[name].key || []).map((p) => p.column).join(', ')}' (meta.mcp.entity) and in meta.mcp.entities. Declare it in ONE place — meta.mcp.entities is the form that can carry a composite key or variants.`);
          }
          const peName = primaryEntityName(m);
          if (peName === name) {
            throw new Error(`model '${model.name}': '${name}' is already the model's PRIMARY entity, so it cannot also be declared in meta.mcp.entities — the semantic model would carry two entities of that name. Drop the duplicate, or give this key its own relationship name.`);
          }
          entities[name] = ent;
        }
      }
    }
    if (Object.keys(entities).length) m.entities = entities;
    if (Object.keys(dimensions).length) m.dimensions = dimensions;
    if (Object.keys(columnDescriptions).length) m.column_descriptions = columnDescriptions;
    // The role IS the source's identity, so two models cannot share one: the second used to
    // silently REPLACE the first, and everything downstream — the tool enums, the value index,
    // every join path — then described a table nobody meant. Several events sources are fine;
    // each carries its own role name.
    if (out.models[key]) {
      throw new Error(`catalog models '${out.models[key].dbt_model}' and '${model.name}' both declare meta.mcp.role: '${key}' — the role is the source's IDENTITY, so exactly one model may carry it. Give one of them its own role name (several sources of the same kind are fine: events, crashlytics, …).`);
    }
    out.models[key] = m;
  }
  if (!(out.facts || []).length) throw new Error('no events source: at least one model must declare an event_name (meta.mcp.is_event_name) or event_data (meta.mcp.is_event_data) column');

  // Every fact needs the two columns the event machinery is built on.
  for (const key of out.facts || []) {
    const m = out.models[key];
    if (!m.event_name) throw new Error(`fact model '${key}' declares no event_name column: add meta.mcp.is_event_name to the column carrying the event type.`);
    if (!m.time) throw new Error(`fact model '${key}' declares no time column: add meta.mcp.is_time to the column carrying the event time.`);
  }

  // One NAME per source: a payload property and a groupable column of the same source live in the
  // same (source, property) space — it is how the value index files values, how semantic_index
  // addresses a field and how a filter literal is verified. A name carried by both is a field
  // nobody can address: the index writes one over the other and the views describe one while
  // reporting the other's numbers. Refused here, where it is a one-line rename.
  for (const key of Object.keys(out.models)) {
    const m = out.models[key];
    const clash = Object.keys(m.properties || {}).filter((name) => (m.dimensions || {})[name]);
    if (clash.length) {
      throw new Error(`model '${m.dbt_model}' (role '${key}') carries ${clash.map((n) => `'${n}'`).join(', ')} BOTH as an event_data property and as a groupable column — one source addresses a field by ONE name, so these cannot coexist. Rename the payload entry, or give it its own name with an explicit column: mapping.`);
    }
  }

  // A PRIMARY entity must be owned by exactly ONE model: it is both the MetricFlow
  // identity of the semantic model and the join TARGET for that entity, so a second
  // claimant would silently hijack the join (e.g. a new fact stealing `user` from the
  // users dimension) and MetricFlow would reject the duplicate identity anyway.
  // THE entity -> owning model map, built once here from the primary entities and extended below
  // with the `unique` ones (after variant expansion, so an expanded name is checked too).
  const ownerOf = new Map();
  for (const [key, m] of Object.entries(out.models)) {
    // A primary entity is written EITHER as a bare name (meta.mcp.primary_entity: event, the
    // events-source form) or as an object with a key — both make the model the owner, so it is
    // read through one accessor.
    const pe = primaryEntityName(m);
    if (!pe) continue;
    if (ownerOf.has(pe)) {
      throw new Error(`models '${ownerOf.get(pe)}' and '${key}' both declare primary entity '${pe}'. A primary entity has exactly one owner (it is the join target for that entity) — give each model its own meta.mcp.primary_entity, e.g. 'event' for the analytics fact and 'crash' for a crash fact.`);
    }
    ownerOf.set(pe, key);
  }
  // EXPAND KEY VARIANTS. A relationship may be carried by several alternative key columns on one
  // side (a crash row reporting one tracking id per ad format). Each variant becomes its own
  // '<relationship>_<variant>' key so the caller can pick which one to join on. A side that
  // declares a PLAIN key for the same relationship mirrors it to every variant — the install
  // record has one tracking column and it is the counterpart of all of them.
  {
    const variantsOf = new Map(); // relationship -> Set(variant name)
    for (const m of Object.values(out.models)) {
      for (const [rel, e] of Object.entries(m.entities || {})) {
        for (const v of Object.keys(e.variants || {})) {
          if (!variantsOf.has(rel)) variantsOf.set(rel, new Set());
          variantsOf.get(rel).add(v);
        }
      }
    }
    for (const m of Object.values(out.models)) {
      for (const [rel, e] of Object.entries({ ...(m.entities || {}) })) {
        const vs = variantsOf.get(rel);
        if (!vs) continue;
        for (const v of vs) {
          const name = `${rel}_${v}`;
          if (m.entities[name]) continue; // an explicit declaration wins over the expansion
          const parts = e.variants?.[v] || e.key;
          if (!parts) continue; // this side carries neither that variant nor a plain key
          m.entities[name] = { type: e.type, key: parts, variant_of: rel };
        }
        // A side declared ONLY as variants has no canonical key of its own.
        if (!e.key) delete m.entities[rel];
        else delete m.entities[rel].variants;
      }
    }
  }

  // A join key is only a join if BOTH sides agree on it: exactly one owner (primary or unique),
  // and every side of the same entity built from the same NUMBER of key parts — two sides with
  // different arity would compare a one-part key against a two-part one and silently match
  // nothing. Checked at load so a mistyped key fails here, not as an empty result set.
  for (const [key, m] of Object.entries(out.models)) {
    for (const [name, e] of Object.entries(m.entities || {})) {
      if (e.type !== 'unique') continue;
      if (ownerOf.has(name) && ownerOf.get(name) !== key) {
        throw new Error(`models '${ownerOf.get(name)}' and '${key}' both OWN entity '${name}' (as primary/unique). An entity has exactly one join target — make one of them type: foreign.`);
      }
      ownerOf.set(name, key);
    }
  }
  // The SHAPE of a key is its parts in order, each with the grain it is compared at. Both the
  // number of parts and the grain of each must agree across the sides: a grain declared on one
  // side only truncates that side, so a day-truncated value is compared against a raw timestamp
  // and the join matches (almost) nothing — silently, with a plausible-looking query.
  const shapeOf = new Map();
  const grainsOf = (parts) => parts.map((p) => p.grain || '-');
  for (const [key, m] of Object.entries(out.models)) {
    const all = [];
    const pe = m.primary_entity;
    if (pe && typeof pe === 'object' && pe.key) all.push([pe.name, pe.key]);
    // variants are already expanded into their own '<relationship>_<variant>' entities above, each
    // with its own key — so every side of every relationship is in this list exactly once.
    for (const [name, e] of Object.entries(m.entities || {})) if (e.key) all.push([name, e.key]);
    for (const [name, parts] of all) {
      const prev = shapeOf.get(name);
      if (prev && prev.n !== parts.length) {
        throw new Error(`entity '${name}' is declared with ${prev.n} key part(s) on '${prev.model}' but ${parts.length} on '${key}'. Both sides of a join must be built from the same number of parts, in the same order.`);
      }
      const grains = grainsOf(parts);
      if (prev && String(prev.grains) !== String(grains)) {
        const show = (g) => g.map((x, i) => `part ${i + 1}: ${x === '-' ? 'no grain' : x}`).join(', ');
        throw new Error(`entity '${name}' is joined at a different grain on each side: ${show(prev.grains)} on '${prev.model}', but ${show(grains)} on '${key}'. A grain truncates the side that declares it, so declaring it on one side only compares a truncated value against a raw one and matches nothing — declare the same grain on both sides.`);
      }
      if (!prev) shapeOf.set(name, { n: parts.length, grains, model: key });
    }
  }

  // `natural` IS NOT DECLARED — it is derived. The renderer emits it for the primary key of a
  // model that has a validity window, because that is the only place MetricFlow accepts one
  // ("The use of `natural` entities is currently supported only in conjunction with a validity
  // window", dbt_semantic_interfaces/validations/entities.py). Declared by hand it passes
  // straight into the manifest and dbt fails with that sentence, about a window the author never
  // mentioned. Refuse it here, where the fix can be named.
  for (const [key, m] of Object.entries(out.models)) {
    const nat = Object.entries(m.entities || {}).filter(([, e]) => e.type === 'natural').map(([n]) => n);
    if (nat.length) {
      throw new Error(`model '${key}' declares entit${nat.length === 1 ? 'y' : 'ies'} ${nat.map((n) => `'${n}'`).join(', ')} as type: natural. That type is not declared by hand — it is what a model with a VALIDITY WINDOW gets automatically for its own key: mark the window columns meta.mcp.dimension.validity (start/end) and make the key the model's meta.mcp.primary_entity. For an ordinary join key use 'unique' (this model owns it) or 'foreign' (it points at the owner).`);
    }
  }

  // A VALIDITY WINDOW belongs to a dimension, never to an events source. An events source is one
  // row per event: there is no version of a row to be valid between two instants, MetricFlow
  // forbids measures on a model with validity params (and an events source exists to carry
  // measures), and the fact renderer has no window to apply — so a window declared here would be
  // silently ignored, which is the one outcome worse than an error.
  for (const key of out.facts || []) {
    const m = out.models[key];
    if (!m?.scd) continue;
    // The time axis of a fact is a dimension too, so both marks are found here; a mark on a
    // column that is not a dimension at all cannot reach this code (scd is set from one).
    const cols = Object.entries(m.dimensions || {}).filter(([, d]) => d.validity).map(([n, d]) => `${n} (${d.validity})`);
    throw new Error(`events source '${key}' declares a validity window (meta.mcp.dimension.validity on ${cols.map((n) => `'${n}'`).join(', ')}). A window describes VERSIONS of a row, so it belongs to a dimension model (one row per key per period), not to a source with one row per event. Move the window to the dimension this source joins to, or drop the validity marks and keep the columns as ordinary time dimensions.`);
  }

  // A SLOWLY-CHANGING model (validity window) may expose only ONE join key, and only as its
  // natural key: MetricFlow rejects a manifest where a model with validity params also carries a
  // `primary` or `unique` entity ("we do not currently process joins against these key types for
  // semantic models with validity windows"). Catch it here, where we can say what to do, instead
  // of letting `dbt parse` fail with that sentence and no context.
  for (const [key, m] of Object.entries(out.models)) {
    if (!m.scd) continue;
    const extra = Object.entries(m.entities || {}).filter(([, e]) => e.type === 'primary' || e.type === 'unique').map(([n]) => n);
    if (extra.length) {
      throw new Error(`model '${key}' declares a validity window (meta.mcp.dimension.validity) and also owns join key(s) ${extra.map((n) => `'${n}'`).join(', ')} as primary/unique. A slowly-changing model can only be joined on its natural key, so MetricFlow rejects the others — declare them 'foreign' (they stay usable as a pipeline join) or drop them.`);
    }
  }

  // Schema validation: names that become MetricFlow identifiers (event-property keys
  // and dimension columns) MUST NOT contain '__' — MetricFlow reserves it as the
  // entity/dimension separator. Fail loudly at load so the dbt schema is corrected at
  // the source (with proper names) instead of silently rewritten in code.
  for (const [key, m] of Object.entries(out.models)) {
    const bad = [];
    for (const p of Object.keys(m.properties || {})) if (p.includes('__')) bad.push(`event property '${p}'`);
    for (const d of Object.keys(m.dimensions || {})) if (d.includes('__')) bad.push(`dimension column '${d}'`);
    if (bad.length) {
      throw new Error(`catalog schema invalid in model '${key}': ${bad.join(', ')} contain '__', which MetricFlow reserves as the entity/dimension separator. Give the column(s) correct names in your dbt model — e.g. an inverted '_of_' form: event_data__price_in_usd -> price_in_usd_of_event_data.`);
    }
  }
  return out;
}

/** Logical name of a model's primary entity. */
export function primaryEntityName(model) {
  const pe = model.primary_entity;
  return typeof pe === 'string' ? pe : pe?.name;
}

export class Catalog {
  constructor(raw) {
    this.raw = raw;
    this.dialect = raw.warehouse_dialect;
    // Whether dbt can run PYTHON models on the active profile (resolvePythonRuntime): the `python`
    // pipeline stage exists in the tool schemas only when it can. A plain registry object without
    // a profile is treated as "no runtime" unless it says otherwise.
    this.pythonRuntime = raw.python_runtime || { available: false, reason: 'no dbt profile — Python models unavailable' };
    // Set when dbt's adapter is one this server writes no SQL for, so the SQL is rendered in
    // another dialect's syntax against it: { profile_type, rendering_as, explicit }.
    this.dialectFallback = raw.dialect_fallback || null;
    this.models = raw.models || {};
    // `facts` = every events source; they are equal, each is addressed by name, and none is a
    // default. Declared by the schema converter, or derived here for a plain registry object:
    // a model with an event_name column is an events source.
    this.facts = (Array.isArray(raw.facts) && raw.facts.length ? raw.facts : Object.keys(this.models).filter((k) => this.models[k]?.event_name || this.models[k]?.event_data_column)).filter((k) => this.models[k]);
    if (!this.facts.length) throw new Error('no events source in the catalog: at least one model must declare an event_name column');
    // Cost guardrail per SOURCE: a catalog-wide override, else that source's own
    // meta.mcp.require_time_range. A partitioned source can demand a bounded window even when
    // another source does not (see requireTimeRangeFor).
    this._requireTimeRangeAll = raw.require_time_range;
    // Models the warehouse cannot back (a STRUCTURAL column or the table itself is missing):
    // removed from `models` by grounding, kept here with the reason so the overview can say why.
    this.unavailable = {};
    this._indexOwners();
  }

  /**
   * (Re)build the map: entity name -> model key that OWNS it (the join target). A model's primary
   * entity is its identity; a `unique` entity is a second key that is also unique per row, so it
   * is an equally valid target. Rebuilt after grounding, because a key whose column turns out not
   * to exist is dropped there and must stop being advertised as a target.
   */
  _indexOwners() {
    this.primaryByEntity = {};
    for (const [key, m] of Object.entries(this.models)) {
      const name = primaryEntityName(m);
      if (name) this.primaryByEntity[name] = key;
    }
    for (const [key, m] of Object.entries(this.models)) {
      for (const [name, e] of Object.entries(m.entities || {})) {
        if (e.type === 'unique' && !this.primaryByEntity[name]) this.primaryByEntity[name] = key;
      }
    }
  }

  /**
   * Reconcile the DECLARED catalog against PHYSICAL truth. Given each model's real
   * column names, PRUNE every declared column / event-payload property / dimension the
   * table does not actually have — so nothing that isn't physically present is EVER
   * surfaced anywhere (the tool schemas, semantic_index, and the value indexer all
   * derive from these maps). Models absent from `physByModel` (introspection
   * unavailable / relation not built) are left untouched. Returns { pruned } for logs.
   * Call BEFORE building schemas (so the enums reflect physical reality).
   */
  groundToPhysical(physByModel) {
    const get = (k) => (physByModel instanceof Map ? physByModel.get(k) : physByModel?.[k]);
    const pruned = {};
    const unavailable = {};
    // Who owned each relationship BEFORE anything is removed: a foreign key pointing at an owner
    // that turns out to be unavailable has to go with it (the join has no target any more).
    this._indexOwners();
    const ownerBefore = { ...this.primaryByEntity };
    for (const [key, m] of Object.entries(this.models)) {
      const raw = get(key);
      if (!raw) continue; // unknown physical shape → keep declared as-is
      if (raw && !(raw instanceof Set) && !Array.isArray(raw) && typeof raw === 'object' && 'unavailable' in raw) {
        unavailable[key] = { reason: `the table cannot be introspected: ${raw.unavailable}`, missing: [] };
        continue;
      }
      const phys = raw instanceof Set ? raw : new Set([...raw].map((n) => String(n).toLowerCase()));
      const has = (n) => phys.has(String(n).toLowerCase());
      const gone = new Set();
      const isFact = this.facts.includes(key);

      // ── STRUCTURAL columns: the ones the whole machinery of the model rests on. Missing one of
      // them there is no useful degraded model — an events source without its event_name column
      // has no scopes, funnels or coverage scan; a model without its identity key cannot be a
      // join target. Such a model is not pruned but marked UNAVAILABLE with the reason, exactly
      // like a contradictory declaration is refused at load: nothing downstream may see it.
      const missing = [];
      if (isFact) {
        if (m.event_name?.column && !has(m.event_name.column)) missing.push(`${m.event_name.column} (meta.mcp.is_event_name — the event name)`);
        if (m.time?.column && !has(m.time.column)) missing.push(`${m.time.column} (meta.mcp.is_time — the event time axis)`);
        if (m.event_data_column && !has(m.event_data_column)) {
          // The raw payload blob is structural only while properties are READ from it; otherwise it
          // is just a column the pipeline offered, and can be dropped like any other.
          const inBlob = Object.keys(m.properties || {}).filter((n) => !m.properties[n].column);
          if (inBlob.length) missing.push(`${m.event_data_column} (meta.mcp.is_event_data — ${inBlob.length} payload propert${inBlob.length === 1 ? 'y' : 'ies'} live in it: ${inBlob.slice(0, 5).join(', ')})`);
          else { delete m.event_data_column; gone.add('(event_data column)'); }
        }
      } else if (m.time?.column && !has(m.time.column)) {
        // A dimension / measures source is still groupable without its time axis — just not
        // over time. Rendered as agg_time_dimension, a missing column would break the manifest.
        delete m.time; gone.add('(time axis)');
      }
      const pe = m.primary_entity;
      if (pe && typeof pe === 'object') {
        const parts = pe.key || [];
        for (const part of parts) if (!has(part.column)) missing.push(`${part.column} (key of the primary entity '${pe.name}')`);
      }
      if (missing.length) { unavailable[key] = { reason: `the table lacks structural column(s): ${missing.join('; ')}`, missing: missing.map((x) => x.split(' ')[0]) }; continue; }

      // ── Ordinary declarations: each one is a single capability, dropped on its own.
      // Physical columns referenceable in a pipeline.
      if (Array.isArray(m.columns)) m.columns = m.columns.filter((c) => { if (has(c.name)) return true; gone.add(c.name); return false; });
      // Event-payload properties: a flattened property is pruned by its physical column.
      if (m.properties) for (const [name, spec] of Object.entries(m.properties)) {
        if (spec.column && !has(spec.column)) { delete m.properties[name]; gone.add(name); }
      }
      // Groupable dimensions (semantic-layer group-by + schema enums).
      if (m.dimensions) for (const name of Object.keys(m.dimensions)) if (!has(name)) { delete m.dimensions[name]; gone.add(name); }
      // The designated app/bundle column: drop it if it is not physically present, so the
      // indexer never groups by a missing column (per-app coverage is simply unavailable).
      if (m.bundle_column && !has(m.bundle_column)) { delete m.bundle_column; gone.add('(bundle column)'); }
      if (m.column_descriptions) for (const name of Object.keys(m.column_descriptions)) if (!has(name)) delete m.column_descriptions[name];
      // AMOUNTS and GOVERNED MEASURES declared on a column the table lacks: offered, they would be
      // accepted by the tool schema and compiled into SQL that fails in the warehouse. A column-
      // level declaration names its column; a model-level one whose `expr` is a bare column name
      // is checked the same way. A genuine expression (`cost / nullif(clicks, 0)`) is kept — its
      // columns cannot be told apart from SQL here.
      const bareColumn = (d) => d.column || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(d.expr || '')) ? d.expr : null);
      if (m.aggregatable) for (const [name, a] of Object.entries(m.aggregatable)) { const col = bareColumn(a); if (col && !has(col)) { delete m.aggregatable[name]; gone.add(`amount:${name}`); } }
      if (m.measures) for (const [name, mm] of Object.entries(m.measures)) { const col = bareColumn(mm); if (col && !has(col)) { delete m.measures[name]; gone.add(`measure:${name}`); } }
      // A DECLARED JOIN KEY whose column is not physically there cannot be executed, so it must
      // stop being offered: `via` would otherwise build SQL against a missing column and fail in
      // the warehouse instead of here. A relationship is one capability among several, so it is
      // dropped alone (unlike the primary key above, which is the model's identity).
      if (m.entities) for (const [name, e] of Object.entries(m.entities)) {
        const parts = e.key || [];
        if (parts.some((p) => !has(p.column))) { delete m.entities[name]; gone.add(`entity:${name}`); }
      }
      // A model is SLOWLY-CHANGING only while it still HAS its window. If the validity columns
      // did not survive, the table has no windows to join on, so the flag has to go with them:
      // left set, the model would render a `natural` entity with no validity_params, which
      // MetricFlow rejects outright — an error about columns that are no longer even visible.
      // Cleared, it renders as an ordinary primary-key dimension, which is what such a table is.
      if (m.scd) {
        const v = Object.values(m.dimensions || {}).filter((d) => d.validity);
        if (v.filter((d) => d.validity === 'start').length !== 1 || v.filter((d) => d.validity === 'end').length !== 1) {
          delete m.scd;
          gone.add('(validity window — no longer treated as slowly-changing)');
        }
      }
      if (gone.size) pruned[key] = [...gone];
    }

    // ── Remove the unavailable models from the live catalog. Everything downstream (tool enums,
    // facts, the indexer worklist, reachable attributes) derives from `models`, so they vanish
    // from every surface at once; the reason stays in `unavailable` for the overview.
    for (const [key, info] of Object.entries(unavailable)) {
      const m = this.models[key];
      this.unavailable[key] = { role: m.role, dbt_model: m.dbt_model, ...info };
      delete this.models[key];
    }
    this.facts = this.facts.filter((k) => this.models[k]);
    if (!this.facts.length) {
      const why = Object.entries(this.unavailable).map(([k, u]) => `'${k}': ${u.reason}`).join('; ');
      throw new Error(`no events source is available: ${why}`);
    }
    // Relationships whose OWNER became unavailable have no join target any more.
    for (const [key, m] of Object.entries(this.models)) {
      for (const name of Object.keys(m.entities || {})) {
        const owner = ownerBefore[name];
        if (owner && owner !== key && unavailable[owner]) { delete m.entities[name]; (pruned[key] ||= []).push(`entity:${name} (owner '${owner}' unavailable)`); }
      }
    }
    // Grounding may have dropped a key that OWNED a relationship — re-index so nothing points at
    // a target that no longer declares it.
    this._indexOwners();
    return { pruned, unavailable: Object.fromEntries(Object.keys(unavailable).map((k) => [k, this.unavailable[k]])) };
  }

  modelKeys() {
    return Object.keys(this.models);
  }

  getModel(key) {
    const m = this.models[key];
    if (!m) throw new Error(`Unknown model: ${key}${this.unavailableHint(key)}`);
    return m;
  }

  /** Models grounding found the warehouse cannot back: { <key>: { role, dbt_model, reason, missing } }. */
  unavailableModels() {
    return this.unavailable || {};
  }

  /** For an "unknown model" message: the reason when the name IS declared but unavailable, else ''. */
  unavailableHint(key) {
    const u = this.unavailable?.[key];
    return u ? ` — '${key}' is declared in the catalog but UNAVAILABLE: ${u.reason}. Fix the warehouse table or the schema and restart the server.` : '';
  }

  primaryEntityName(key) {
    return primaryEntityName(this.getModel(key));
  }

  /** True when queries over `source` must carry a time window (partition-pruning guardrail). */
  requireTimeRangeFor(source) {
    return !!(this._requireTimeRangeAll ?? this.models[source]?.require_time_range);
  }

  /**
   * Resolve the SOURCE an event accessor is asked about. The source is ALWAYS a separate argument
   * and is always passed: there is no "default" fact to fall back to, in any catalog, and silently
   * reading one source's vocabulary for another is exactly the mix-up the per-source design exists
   * to prevent. An omitted source is a programming error, refused here at the accessor.
   */
  _fact(fact) {
    if (!fact) throw new Error(`a source is required: sources are never mixed, so name the one you mean (${this.facts.join(', ')})`);
    if (!this.facts.includes(fact)) throw new Error(`'${fact}' is not an events source. Events sources: ${this.facts.join(', ')}`);
    return fact;
  }

  /**
   * The relationship `source` declares toward a model with the given ROLE — the structural way to
   * ask "which key means per-user here", instead of assuming a relationship is literally named
   * 'user'. Roles are the catalog's own vocabulary; relationship names are the author's.
   */
  entityTowardRole(source, role) {
    const m = this.models[source];
    if (!m) return undefined;
    for (const name of Object.keys(m.entities || {})) {
      const target = this.joinTargetFor(name);
      if (target && this.models[target]?.role === role) return name;
    }
    return undefined;
  }

  /** True when `key` is an events fact (has its own event vocabulary). */
  isFact(key) {
    return this.facts.includes(key);
  }

  /**
   * The event `name` as seen from `fact`. Every source names its own events, so the name is
   * always bare here; it THROWS when this source does not declare it — naming which source
   * does, when one exists — so a cross-source mistake never degrades into a filter that
   * silently matches nothing. `hint` appends the caller's fix.
   */
  eventNameFor(fact, name, { hint } = {}) {
    if (this.eventNames(fact).includes(name)) return name;
    const other = this.facts.find((f) => f !== fact && this.eventNames(f).includes(name));
    if (other) throw new Error(`event '${name}' belongs to the '${other}' source, not '${fact}'${hint ? ` — ${hint}` : ''}`);
    throw new Error(`unknown event '${name}' on '${fact}'. See semantic_index({ model: '${fact}' })`);
  }

  /**
   * THE SQL expression that reads one event property of `fact`, for `dialect` (a dialect name).
   * A flattened property is its physical column; a blob property is a JSON extract from the
   * source's event_data column, cast to `type` (the property's declared type by default).
   * `qualifier` prefixes both forms (an alias such as `S1`), so joined/pattern queries can use it.
   * The single place this rule lives — the governed compiler, the pipeline, the funnel matcher
   * and the value indexer all read a property through here, so they can never disagree.
   */
  propertyExpr(fact, name, dialect, { type, qualifier } = {}) {
    fact = this._fact(fact);
    const spec = (this.models[fact].properties || {})[name];
    if (!spec) throw new Error(`unknown event property '${name}' on '${fact}'`);
    const col = this.propertyBackingColumn(fact, name); // the ONE rule for which column this reads
    const q = qualifier ? `${qualifier}.${col}` : col;
    return spec.column ? q : jsonExtractSql(dialect, q, name, type || spec.type);
  }

  /**
   * The PHYSICAL column a property is read from: its own flattened column, or the source's payload
   * blob. Whoever reads a property needs that column to still be there, so the same rule that
   * builds the expression also answers "which column does this depend on".
   */
  propertyBackingColumn(fact, name) {
    fact = this._fact(fact);
    const spec = (this.models[fact].properties || {})[name];
    if (!spec) throw new Error(`unknown event property '${name}' on '${fact}'`);
    return spec.column || this.eventDataColumn(fact);
  }

  /**
   * One event PROPERTY as seen from `fact`: { name, spec }, or null when this source simply has
   * no such property. THROWS when another source declares it (reading another source's payload
   * is never what was meant).
   */
  propertyFor(fact, name, { hint } = {}) {
    const props = this.models[fact]?.properties || {};
    if (props[name]) return { name, spec: props[name] };
    const other = this.facts.find((f) => f !== fact && this.eventProps(f).includes(name));
    if (other) throw new Error(`'${name}' is a property of the '${other}' source, not of '${fact}'${hint ? ` — ${hint}` : ''}`);
    return null;
  }

  /**
   * Enums for a schema whose SOURCE is not fixed when the schema is built — the pipeline
   * stages, where the source is chosen per draft, and the model-agnostic update payloads.
   * They are the union of every source's own (bare) names; the caller still resolves the name
   * against the actual source via eventNameFor / propertyFor, which reports a cross-source
   * mistake with the fix.
   */
  eventNameEnum() {
    return [...new Set(this.facts.flatMap((f) => this.eventNames(f)))];
  }

  /** Every name a source can be asked about in the { source, property } view: its payload
   *  properties and its groupable attributes. The schema enumerates these PER SOURCE, so a name
   *  that source does not carry is not expressible. */
  propertyEnumFor(key) {
    const m = this.getModel(key);
    return [...new Set([...(this.facts.includes(key) ? this.eventProps(key) : []), ...Object.keys(m.dimensions || {})])];
  }

  eventPropEnum() {
    return [...new Set(this.facts.flatMap((f) => this.eventProps(f)))];
  }

  scalarEventPropEnum() {
    return [...new Set(this.facts.flatMap((f) => this.scalarEventProps(f)))];
  }

  /** dbt column descriptions for a model: { columnName: description }. */
  columnDescriptions(key) {
    return this.getModel(key).column_descriptions || {};
  }

  /** event_data property descriptions (if declared): { property: description }. */
  eventPropertyDescriptions(fact) {
    fact = this._fact(fact);
    const props = this.models[fact]?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props)) if (v && v.description) out[k] = v.description;
    return out;
  }


  /** Physical JSON column holding event-specific properties on the events model. */
  eventDataColumn(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.event_data_column || 'event_properties';
  }

  /** Physical column of `fact` that carries the event type, or null. */
  eventNameColumn(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.event_name?.column || null;
  }

  /** Anchor column identifying the app/bundle (meta.mcp.dimension:{bundle:true}), or null.
   *  When set, the value index breaks per-property coverage down by it (per-app emptiness). */
  bundleColumn(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.bundle_column || null;
  }

  /** event_name values enum. */
  eventNames(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.known_events || [];
  }

  /** event_properties keys (all, including complex array/struct ones). */
  eventProps(fact) {
    fact = this._fact(fact);
    return Object.keys(this.models[fact]?.properties || {});
  }

  /**
   * What `name` is on `source`: 'property' for an events source's payload property, 'dimension'
   * for a groupable attribute of any model, null when the source does not carry it. THE one place
   * that answers "does this source have this attribute" — every resolver in the engine (value-index
   * keys, the { source, property } view, memory targets) asks here, so a dimension is never asked for
   * payload properties and no caller re-implements the rule.
   */
  attributeKind(source, name) {
    const m = this.models[source];
    if (!m || !name) return null;
    // `has` on the OWN keys only: a plain-object lookup also answers for Object.prototype, so
    // 'toString' / 'constructor' / 'valueOf' resolved as real fields and were then addressed
    // as one (the memory tool's target `name` is free text, which is how they get in here).
    const has = (bag, key) => !!bag && Object.prototype.hasOwnProperty.call(bag, key);
    if (this.facts.includes(source) && has(m.properties, name)) return 'property';
    return has(m.dimensions, name) ? 'dimension' : null;
  }

  /** Full spec for one event_data property ({ type, items?, fields?, values?, description? }). */
  eventPropertySpec(name, fact) {
    fact = this._fact(fact);
    return (this.models[fact]?.properties || {})[name];
  }

  /** True if a property is a complex (array / struct / array-of-struct) type. */
  isComplexEventProp(name, fact) {
    fact = this._fact(fact);
    const t = String(this.eventPropertySpec(name, fact)?.type || '').toLowerCase();
    return t === 'array' || t === 'struct' || t === 'array<struct>';
  }

  /** SCALAR event_property keys — usable directly as categorical dims / scalar filters. */
  scalarEventProps(fact) {
    fact = this._fact(fact);
    return this.eventProps(fact).filter((k) => !this.isComplexEventProp(k, fact));
  }

  /** COMPLEX (array/struct) event_property keys — only usable via prepare stages. */
  complexEventProps(fact) {
    fact = this._fact(fact);
    return this.eventProps(fact).filter((k) => this.isComplexEventProp(k, fact));
  }

  /** Numeric event_properties keys (valid for sum/avg/median/percentile). */
  eventNumericProps(fact) {
    fact = this._fact(fact);
    const props = this.models[fact]?.properties || {};
    return Object.keys(props).filter((k) => isNumericType(props[k].type));
  }

  /** Every physical column of a model as { name, type } — referenceable in native pipelines. */
  modelColumns(key) {
    return this.getModel(key).columns || [];
  }

  /** Plain (non-JSON) physical columns of a model usable as categorical dims. */
  modelDimensionColumns(key) {
    const m = this.getModel(key);
    if (this.isFact(key)) {
      // events: event_name plus every column explicitly marked meta.mcp.dimension (e.g. the app
      // column — present on every event, so it can segment without a join). A join KEY that should
      // also be groupable is marked meta.mcp.dimension like any other column; no key is singled
      // out by name.
      const cols = [];
      if (m.event_name?.column) cols.push(m.event_name.column);
      cols.push(...Object.keys(m.dimensions || {}));
      return [...new Set(cols)];
    }
    return Object.keys(m.dimensions || {});
  }

  /** Entity key columns of a model (for count_distinct field choices). */
  entityKeyColumns(key) {
    const m = this.getModel(key);
    const cols = [];
    const pe = m.primary_entity;
    if (typeof pe === 'object') for (const p of pe.key || []) cols.push(p.column);
    for (const e of Object.values(m.entities || {})) {
      for (const p of e.key || []) cols.push(p.column);
    }
    return [...new Set(cols)];
  }

  /** Every join key `key` declares, by entity name: { <entity>: { type, key: [parts] } }. */
  entitiesOf(key) {
    const m = this.getModel(key);
    const out = {};
    const pe = m.primary_entity;
    if (pe && typeof pe === 'object' && pe.name) out[pe.name] = { type: 'primary', key: pe.key || [] };
    for (const [name, e] of Object.entries(m.entities || {})) out[name] = { type: e.type, key: e.key || [] };
    return out;
  }

  /** The parts of `entity`'s key ON `modelKey`, or undefined when it declares no such key. */
  entityKey(modelKey, entity) {
    return this.entitiesOf(modelKey)[entity]?.key;
  }

  /** The model that OWNS `entity` (declares it primary/unique) — the join target. */
  joinTargetFor(entity) {
    return this.primaryByEntity[entity];
  }

  /**
   * Entity names declared on BOTH models — the join(s) the schema sanctions between them.
   * Each carries the key parts on either side, so a caller never restates the columns.
   */
  sharedEntities(a, b) {
    const ea = this.entitiesOf(a); const eb = this.entitiesOf(b);
    return Object.keys(ea).filter((n) => eb[n]).map((n) => ({ entity: n, left: ea[n], right: eb[n] }));
  }

  /**
   * Group-by / filter paths reachable from every events source via the entity graph,
   * up to `maxHops` (default 2 hops / 3 tables). Foreign entities with no
   * matching primary target are pruned (m3). Includes `metric_time`.
   */
  reachableGroupByPaths(maxHops = 2) {
    const out = new Set(['metric_time']);

    // local categorical columns of a source are added per-task; here we expose
    // only join-reachable dimensions + metric_time (task dims added at runtime).
    const visit = (modelKey, prefix, hop) => {
      if (hop > maxHops) return;
      const model = this.models[modelKey];
      for (const [entName, ent] of Object.entries(model.entities || {})) {
        if (ent.type !== 'foreign') continue;
        const targetKey = this.primaryByEntity[entName];
        if (!targetKey) continue; // pruned: dangling foreign (m3)
        const target = this.models[targetKey];
        const newPrefix = prefix ? `${prefix}__${entName}` : entName;
        for (const dim of Object.keys(target.dimensions || {})) out.add(`${newPrefix}__${dim}`);
        visit(targetKey, newPrefix, hop + 1);
      }
    };
    for (const fact of this.facts) visit(fact, '', 1);
    // A source's OWN attributes are groupable under its primary entity — that is how a base
    // measure declared on a non-events source (acquisition spend, say) is sliced by its own
    // channel/campaign columns, without a join and without declaring a task dimension.
    for (const key of this.modelKeys()) {
      const ent = primaryEntityName(this.models[key]);
      if (!ent) continue;
      for (const dim of Object.keys(this.models[key].dimensions || {})) out.add(`${ent}__${dim}`);
    }
    return [...out];
  }

  /**
   * Every attribute a metric query can group or filter by, addressed by WHERE IT LIVES — the
   * only form the query tools accept: { model, attribute, via? }. `via` names the relationship
   * when the attribute is reached through a join whose name differs from the model's identity
   * (an owned key such as ad_funnel), and is omitted when the relationship IS the identity
   * (user → users) or the attribute is the source's own. One hop only — that is what a
   * structured reference can say.
   */
  reachableAttributes() {
    const out = []; const seen = new Set();
    const push = (model, attribute, via) => { const k = `${model}\u0000${attribute}\u0000${via || ''}`; if (!seen.has(k)) { seen.add(k); out.push({ model, attribute, ...(via ? { via } : {}) }); } };
    for (const fact of this.facts) {
      const m = this.models[fact];
      for (const [ent, e] of Object.entries(m.entities || {})) {
        if (e.type !== 'foreign') continue;
        const target = this.primaryByEntity[ent];
        if (!target) continue;
        const identity = primaryEntityName(this.models[target]);
        for (const dim of Object.keys(this.models[target].dimensions || {})) push(target, dim, ent === identity ? undefined : ent);
      }
    }
    for (const key of this.modelKeys()) {
      if (!primaryEntityName(this.models[key])) continue;
      for (const dim of Object.keys(this.models[key].dimensions || {})) push(key, dim, undefined);
    }
    return out;
  }

  /**
   * Fields of `key` the schema marks as AGGREGATABLE amounts. Each is { name, expr, column?,
   * type?, unit?, label?, description? } and carries NO aggregation — a task measure names one
   * as its `field` and chooses the function itself.
   */
  aggregatableFields(key) {
    return Object.values(this.getModel(key).aggregatable || {});
  }

  /** One aggregatable field of `key` by name, or undefined. */
  aggregatableField(key, name) {
    return this.getModel(key).aggregatable?.[name];
  }

  /** Aggregatable field names across every model (for the model-agnostic update schema). */
  aggregatableFieldNames() {
    return [...new Set(this.modelKeys().flatMap((k) => Object.keys(this.models[k].aggregatable || {})))];
  }

  /** The model that declares a base measure (meta.mcp.measures), or undefined. */
  modelOwningMeasure(ref) {
    return this.modelKeys().find((k) => (this.models[k].measures || {})[ref]);
  }

  /** Base measure reference names available across the registry. */
  baseMeasureRefs() {
    const refs = [];
    for (const m of Object.values(this.models)) {
      for (const name of Object.keys(m.measures || {})) refs.push(name);
    }
    return refs;
  }

  /** Models that may be JOINED to the source a task is built from — every source is equal here,
   *  so the list is every model; joining a source to ITSELF is what gets rejected, at build. */
  joinableModelKeys() {
    return this.modelKeys();
  }

  /** Relationships carried by VARIANTS (one relationship, several alternative key columns on a
   *  side): { <relationship>: [<expanded entity name>, …] }. Empty when no model declares any. */
  variantRelationships() {
    const out = {};
    for (const m of Object.values(this.models)) for (const [name, e] of Object.entries(m.entities || {})) if (e.variant_of) (out[e.variant_of] ||= new Set()).add(name);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
  }

  /** Entity names that appear on at least TWO models — the joins the schema sanctions. */
  joinEntityNames() {
    const seen = new Map();
    for (const k of this.modelKeys()) for (const name of Object.keys(this.entitiesOf(k))) seen.set(name, (seen.get(name) || 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort();
  }

  timeGranularities() {
    return ['day', 'week', 'month', 'quarter', 'year'];
  }
}
