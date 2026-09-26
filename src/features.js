// FEATURES — a part of the server that is switched on or off AS A WHOLE, with everything it adds to
// the surface: its tools (schema + engine method), the task side they start and read, the view that
// draws their result, the guide and skill that describe them, one line of the instructions and its
// status in the overview. Off, none of it exists — not listed, not callable, not described — so the
// surface is exactly what it is without the feature, and turning it on is a changed surface the
// server announces like any other (src/surface-change.js).
//
// The core never names a feature: it walks `engine.features` at the few points a tool is defined,
// dispatched, read back, drawn, guided and described. A feature module exports a DEFINITION:
//
//   { id, flag, resolve({ env, catalog, profilesDir, baseProjectDir }) → { feature } | { reason } }
//
// and the resolved `feature` is an object with (every key optional but `id` and `tools`):
//   tools:   { <name>: { schema(catalog) → JSON Schema, run(engine, input) → result,
//                        title, description, behaviour (ToolAnnotations),
//                        side (the task side this tool starts and reads), draws (true for the tool
//                        that draws a card), waits (true for a call that waits on a task),
//                        precheck(engine, args) (what a waiting call would refuse, before waiting) } }
//   sides:   { <side>: <the tool that reads that side's tasks back> }
//   view:    { uri, name, title, description, asset (a RUNTIME_ASSETS key), viewModel(result, args) }
//   guide:   { name (a reserved semantic_index({ guide }) name), build(catalog) → object,
//              triggers: [{ if, do }] (routing triggers added to the analyst guide) }
//   skill(engine) → { path, frontmatter, body, references: [[relPath, text]] }
//   instructions: one line for the core instructions
//   overview(engine) → what semantic_index's overview says about it

import { retentioneeringDefinition } from './retentioneering/index.js';

/** Every feature this server knows. Each is off unless its flag turns it on. */
export const FEATURE_DEFINITIONS = [retentioneeringDefinition];

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;

/** Whether an env flag is on: only an explicit yes turns a feature on — a feature is opt-in. */
export function flagOn(value) {
  const v = String(value ?? '').trim();
  return ON.test(v) && !OFF.test(v);
}

/**
 * The features a deployment runs: each definition whose flag is on, resolved against this catalog
 * and environment. A feature asked for that cannot run here (its dbt environment missing, no python
 * runtime) is left out with its reason — reported in the overview, never half-offered.
 * Returns { features: [resolved feature], status: [{ id, available, reason? }] }.
 */
export function resolveFeatures({ env = process.env, catalog, profilesDir, baseProjectDir, definitions = FEATURE_DEFINITIONS, log = () => {} } = {}) {
  const features = [];
  const status = [];
  for (const def of definitions) {
    if (!flagOn(env[def.flag])) continue;
    let out;
    try { out = def.resolve({ env, catalog, profilesDir, baseProjectDir }); } catch (e) { out = { reason: e?.message || String(e) }; }
    if (out?.feature) {
      features.push(out.feature);
      status.push({ id: def.id, available: true });
      log(`feature '${def.id}' on`);
    } else {
      status.push({ id: def.id, available: false, reason: out?.reason || 'unavailable' });
      log(`feature '${def.id}' asked for (${def.flag}) but unavailable: ${out?.reason || 'unknown reason'}`);
    }
  }
  return { features, status };
}

/** name → { feature, tool } over the resolved features (a name defined twice is a defect). */
export function featureTools(features = []) {
  const map = new Map();
  for (const feature of features) {
    for (const [name, tool] of Object.entries(feature.tools || {})) {
      if (map.has(name)) throw new Error(`tool '${name}' is defined by two features (${map.get(name).feature.id}, ${feature.id})`);
      map.set(name, { feature, tool });
    }
  }
  return map;
}

/** The feature tool `name` of this engine, or null. */
export function featureTool(engine, name) {
  return engine?._featureTools?.get(name) || null;
}
