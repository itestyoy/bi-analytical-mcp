// Recipes: ready-to-use "how to build a model for task type X" templates — a small payload for a
// real MCP call, plus the technique to generalise it.
//
// TWO LAYERS, merged: the SYSTEM recipes ship with the server (technical and universal — the
// governed-metric shapes, the pipeline shapes, the python-runtime ones), and a DEPLOYMENT may add
// its OWN file with domain recipes (its games, its events, its conventions). Both are offered
// together; on an id collision the deployment's entry wins, which is how an operator overrides a
// system recipe deliberately rather than by accident.
//
// NOT EVERY RECIPE FITS EVERY DEPLOYMENT. An entry may declare what it needs —
//   requires: 'python_models'   → only where dbt can run python models here
//   dialect:  'bigquery' | ['bigquery', 'duckdb']  → only on that warehouse
//   runtime:  'bigframes' | ['snowpark', ...]        → only on that python runtime
// — and everything that LISTS recipes (the overview, the guide, the tool schema's enum) offers
// only the ones this deployment can actually run. Fetching one by id still works and says so.

import { readFileSync, existsSync } from 'node:fs';
import { pythonReferenceRecipes } from './python-guide.js';
import { currentSpelling } from './pipeline/earlier.js';
import { currentOf, currentMetrics, currentQueryInput } from './earlier-spelling.js';
import { propertyTypes } from './pipeline/compute.js';
import { stepOfDeclaration } from './pipeline/semantic-stage.js';

/**
 * A pipeline recipe's payload, as the build_model start request it is. A file written for an
 * earlier version carries `{ name, pipeline: { source, time_range?, stages } }` — the one-call contract
 * no tool takes — or its first steps as `stages`, and stages in an earlier spelling; a deployment's file
 * is not ours to rewrite, so it is read as that request here: its list as `steps`, each stage's own
 * words respelled as a kept draft's are (src/pipeline/earlier.js; with no columns known, an unnest's
 * `source` is read as an event property, the build's first choice), and then the list in the spelling a
 * NEW call takes (src/earlier-spelling.js currentOf — a typed unnest the two steps it is now, which a
 * kept draft's is not; with the `catalog`, a typed read whose type is the source's own the bare read):
 * what the recipe view hands over is always a request the tool accepts as it stands.
 */
export function pipelineStartRequest(payload, catalog = null) {
  if (!payload || typeof payload !== 'object') return payload;
  let request = payload;
  if (payload.pipeline && typeof payload.pipeline === 'object') {
    // context_id and dry_run belonged to the one-call contract: a recipe starts a draft of its own
    const { pipeline, context_id: _ctx, dry_run: _dry, ...rest } = payload;
    request = { action: 'start', ...rest, ...pipeline };
  }
  if (request.steps === undefined && Array.isArray(request.stages)) {
    const { stages, ...rest } = request;
    request = { ...rest, steps: stages };
  }
  if (!Array.isArray(request.steps)) return request;
  const respelled = request.steps.map((st) => currentSpelling(st, { catalog, source: request.source }));
  const steps = currentOf(respelled, { propertyType: propertyTypes(catalog, request.source) });
  return steps.length === request.steps.length && steps.every((st, i) => st === request.steps[i]) ? request : { ...request, steps };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** A semantic model item of an earlier recipe in today's spelling: a dimension's `as_type` dropped (the
 *  catalog's column type says whether it is a time dimension now), a sum_boolean measure as the count
 *  of the rows its where held for (sum_boolean summed the scope as a boolean, whatever field it named:
 *  a count of a case now), and its measures, conditions and dimensions in the one expression grammar
 *  (src/earlier-spelling.js — a `field` is read as the column of that name, which a property the source
 *  stores flat also is; an aggregate's where is the case it folds, a typed read a cast where its type is
 *  not the read's own — the `catalog`'s type for the item's source). */
function currentSemanticModel(sm, catalog = null) {
  if (!isObj(sm)) return sm;
  let out = sm;
  if ((sm.dimensions || []).some((d) => isObj(d) && d.as_type !== undefined)) {
    out = { ...out, dimensions: sm.dimensions.map((d) => (isObj(d) && d.as_type !== undefined ? (({ as_type: _t, ...rest }) => rest)(d) : d)) };
  }
  if ((sm.measures || []).some((m) => m?.agg === 'sum_boolean')) {
    out = { ...out, measures: sm.measures.map((m) => (m?.agg === 'sum_boolean' ? (({ field: _f, cast: _c, percentile: _p, ...rest }) => ({ ...rest, agg: 'count' }))(m) : m)) };
  }
  return currentOf(out, { propertyType: propertyTypes(catalog, sm.source) });
}

/**
 * A semantic recipe's payload, as the declaration it is (read as a build_model start by its semantic_model step: src/pipeline/semantic-stage.js stepOfDeclaration). A file written for an
 * earlier version may load a model for its attributes with `use_base_models`, reference a measure as
 * `{ name }`, write a derived metric as text over its inputs or a ratio of two sides, type a dimension
 * with `as_type`, fold a measure with `sum_boolean`, or write its measures, conditions and dimensions
 * in the earlier grammar, or name an item's model `from`; a deployment's file is not ours to rewrite, so
 * each is read here as what it said: a model loaded is a `{ source }` item of semantic_models.
 */
export function semanticRequest(payload, catalog = null) {
  if (!isObj(payload)) return payload;
  const { use_base_models: base, ...rest } = payload;
  let out = base === undefined ? payload : rest;
  const current = (sm) => currentSemanticModel(sm, catalog);
  if (Array.isArray(out.semantic_models) && out.semantic_models.some((sm) => current(sm) !== sm)) out = { ...out, semantic_models: out.semantic_models.map(current) };
  if (Array.isArray(base) && base.length) {
    const loaded = new Set((out.semantic_models || []).map((sm) => sm?.source));
    out = { ...out, semantic_models: [...(out.semantic_models || []), ...base.filter((k) => !loaded.has(k)).map((source) => ({ source }))] };
  }
  // its metrics as the converter table reads a declaration's (src/earlier-spelling.js): a ratio's side
  // that names a measure through the simple metric over it, as the earlier build read it
  const metrics = currentMetrics(out.metrics);
  if (metrics !== out.metrics) out = { ...out, metrics };
  return out;
}

// The earlier experiment block's flat `<field>_field` keys → where that column goes in `arm` (a path
// into the group as the experiment tool takes it).
const EARLIER_ARM_FIELDS = {
  n_field: ['n'],
  conversions_field: ['conversions'],
  mean_field: ['mean'],
  stddev_field: ['stddev'],
  sumY_field: ['sum'],
  sumY2_field: ['sum_squares'],
  sumX_field: ['covariate', 'sum'],
  sumX2_field: ['covariate', 'sum_squares'],
  sumXY_field: ['sum_products'],
  sumNum_field: ['numerator', 'sum'],
  sumNum2_field: ['numerator', 'sum_squares'],
  sumDen_field: ['denominator', 'sum'],
  sumDen2_field: ['denominator', 'sum_squares'],
  sumNumDen_field: ['sum_products'],
};

/**
 * A recipe's experiment block, as `{ action, metric?, group_field, expected_ratio?, arm }` — `arm` the
 * group as the experiment tool takes it, each value the column that holds it. A file written for an
 * earlier version names each column by a flat `<field>_field` key (`n_field`, `sumY_field`,
 * `sumNum_field` …), the tool's earlier field names; a deployment's file is not ours to rewrite, so it
 * is read as that `arm` here.
 */
export function experimentMap(e) {
  if (!e || typeof e !== 'object' || e.arm || !('n_field' in e)) return e;
  const arm = {};
  const rest = {};
  for (const [k, v] of Object.entries(e)) {
    const path = EARLIER_ARM_FIELDS[k];
    if (!path) { rest[k] = v; continue; }
    let at = arm;
    for (const step of path.slice(0, -1)) at = at[step] ??= {};
    at[path[path.length - 1]] = v;
  }
  return { ...rest, arm };
}

/** What an earlier example query's `{ model, attribute }` named, read off the recipe's own declaration
 *  (src/earlier-spelling.js currentRef): an event property its semantic model declared a dimension, a
 *  dimension it computed there, else a column of that model. */
function refSubject(semantic) {
  const models = (isObj(semantic) && Array.isArray(semantic.semantic_models)) ? semantic.semantic_models : [];
  return (attribute, model) => {
    const d = (models.find((sm) => sm?.source === model)?.dimensions || []).find((x) => x?.property === attribute || x?.name === attribute);
    return d?.property !== undefined ? 'property' : d?.expr !== undefined ? 'dimension' : 'column';
  };
}

/** Load one recipe file (a `{ recipes: [...] }` document). Missing file → no entries. An example query
 *  written for an earlier version (a metric query's `metrics`, `group_by` and `where` beside its steps,
 *  its `order_by`, a read's `stages` / `transform`, a `{ model, attribute }` it groups or filters by) is
 *  read as the query it is now — its steps, a metrics step among them, its refs
 *  (src/earlier-spelling.js currentQueryInput). `catalog` (when given) types what a typed read reads. */
function readFile(path, origin, catalog = null) {
  if (!path || !existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return (raw.recipes || []).map((r) => {
    const semantic = r.semantic_payload ? semanticRequest(r.semantic_payload, catalog) : undefined;
    return {
      ...r,
      ...(r.pipeline_payload ? { pipeline_payload: pipelineStartRequest(r.pipeline_payload, catalog) } : {}),
      ...(semantic ? { semantic_payload: (catalog && stepOfDeclaration(catalog, semantic)) || semantic } : {}),
      ...(Array.isArray(r.example_queries) ? { example_queries: r.example_queries.map((q) => currentQueryInput(q, { subject: refSubject(semantic), propertyType: propertyTypes(catalog) })) } : {}),
      ...(r.experiment ? { experiment: experimentMap(r.experiment) } : {}),
      origin,
    };
  });
}

/**
 * Load the system file and, on top of it, the deployment's own files (in order; a later id wins).
 * `system` and `deployment` are paths; deployment may be a list. `catalog` (when given) is what an
 * earlier typed read in a file is read against.
 */
export function loadRecipes(system, deployment = [], caps = null, catalog = null) {
  // comma-separated, as documented — a colon belongs to paths ('C:\deploy\…', '/mnt/vol:ro/…')
  const paths = Array.isArray(deployment) ? deployment : String(deployment || '').split(',').map((p) => p.trim()).filter(Boolean);
  const merged = new Map();
  // GENERATED first: the reference entries built from the extracted fact sheet (a library's real
  // signatures and method preconditions). They are recipes so they can be FETCHED BY ID mid-write
  // instead of read out of a long guide, and they answer to the same capability rules as the rest.
  // Seeded before the files so a system or deployment entry with the same id overrides them.
  for (const r of pythonReferenceRecipes()) merged.set(r.id, r);
  for (const r of readFile(system, 'system', catalog)) merged.set(r.id, r);
  for (const p of paths) for (const r of readFile(p, 'deployment', catalog)) merged.set(r.id, r);
  return new Recipes([...merged.values()], caps);
}

export class Recipes {
  /** `caps` = { dialect, python: boolean, runtime } — what THIS deployment can run. */
  constructor(list, caps = null) {
    this.list = list;
    this.caps = caps;
    this.byId = new Map(list.map((r) => [r.id, r]));
  }

  /** The same recipes, judged against a deployment's capabilities. */
  withCapabilities(caps) {
    return new Recipes(this.list, caps);
  }

  /** Why this recipe cannot be used here, or null when it can. */
  unavailableReason(r) {
    const c = this.caps;
    if (!c) return null; // capabilities unknown → offer everything (tests, tooling)
    const asList = (v) => (v == null ? null : (Array.isArray(v) ? v : [v]));
    if (r.requires === 'python_models' && !c.python) {
      return 'this deployment runs no dbt python models (the overview reports python_models)';
    }
    const dialects = asList(r.dialect);
    if (dialects && c.dialect && !dialects.includes(c.dialect)) {
      return `written for ${dialects.join(' / ')}; this warehouse is ${c.dialect}`;
    }
    const runtimes = asList(r.runtime);
    if (runtimes && !runtimes.includes(c.runtime)) {
      return `written for the ${runtimes.join(' / ')} python runtime; this deployment submits to ${c.runtime || 'none'}`;
    }
    return null;
  }

  /** The recipes this deployment can actually run. */
  visible() {
    return this.list.filter((r) => !this.unavailableReason(r));
  }

  ids() {
    return this.visible().map((r) => r.id);
  }

  /** Ids of the visible recipes that need a given capability (e.g. 'python_models'). */
  idsRequiring(capability) {
    return this.entriesRequiring(capability).map((r) => r.id);
  }

  /**
   * The same set as `idsRequiring`, but as { id, title } — what a tool DESCRIPTION needs to tell
   * the caller which recipe covers which move, instead of listing bare ids it has to fetch one by
   * one to find out. Title is the recipe's own, so nothing about a recipe lives in src/.
   */
  entriesRequiring(capability) {
    return this.visible().filter((r) => r.requires === capability).map((r) => ({ id: r.id, title: r.title }));
  }

  /** Compact catalog of recipes (no full payloads) for listing — only what fits here. */
  summary() {
    return this.visible().map((r) => ({
      id: r.id,
      task_type: r.task_type,
      title: r.title,
      when_to_use: r.when_to_use,
      metric_types: r.metric_types,
      ...(r.requires ? { requires: r.requires } : {}), // e.g. 'python_models'
      origin: r.origin || 'system', // system (ships with the server) vs deployment (yours)
      hack: r.hack, // the generalizable technique — lets the AI adapt a recipe to novel tasks
    }));
  }

  get(id) {
    const r = this.byId.get(id);
    if (!r) throw new Error(`unknown recipe: ${id}`);
    const why = this.unavailableReason(r);
    return why ? { ...r, unavailable_here: why } : r;
  }
}
