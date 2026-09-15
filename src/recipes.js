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
//   dialect:  'bigquery' | ['bigquery', 'postgres']  → only on that warehouse
//   runtime:  'bigframes' | ['snowpark', ...]        → only on that python runtime
// — and everything that LISTS recipes (the overview, the guide, the tool schema's enum) offers
// only the ones this deployment can actually run. Fetching one by id still works and says so.

import { readFileSync, existsSync } from 'node:fs';

/** Load one recipe file (a `{ recipes: [...] }` document). Missing file → no entries. */
function readFile(path, origin) {
  if (!path || !existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return (raw.recipes || []).map((r) => ({ ...r, origin }));
}

/**
 * Load the system file and, on top of it, the deployment's own files (in order; a later id wins).
 * `system` and `deployment` are paths; deployment may be a list.
 */
export function loadRecipes(system, deployment = [], caps = null) {
  const paths = Array.isArray(deployment) ? deployment : String(deployment || '').split(/[,:]/).filter(Boolean);
  const merged = new Map();
  for (const r of readFile(system, 'system')) merged.set(r.id, r);
  for (const p of paths) for (const r of readFile(p, 'deployment')) merged.set(r.id, r);
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
