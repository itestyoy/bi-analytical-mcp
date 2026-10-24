// FEATURES — a part of the server that is switched on or off AS A WHOLE, with everything it adds to
// the surface: its tools (schema + engine method), the task side they start and read, the view that
// draws their result, the guide and skill that describe them, one line of the instructions and its
// status in the overview. Off, none of it exists — not listed, not callable, not described — so the
// surface is exactly what it is without the feature, and turning it on is a changed surface the
// server announces like any other (src/surface-change.js).
//
// The core never names a feature: it walks `engine.features` at the few points a tool is defined,
// dispatched, read back, drawn, guided, described and removed. A feature is written against the engine's
// public surface — engine.tasks (src/task-runner.js), engine.host, engine.ctxs, engine.catalog,
// engine.jobs — never its private `_` members. A feature module exports a DEFINITION:
//
//   { id, flag, resolve({ env, catalog, profilesDir, baseProjectDir }) → { feature } | { reason } }
//
// and the resolved `feature` is an object with (every key optional but `id` and `tools`):
//   tools:   { <name>: { schema(catalog, { project }) → JSON Schema (project: the dbt project's own
//                        semantic layer, or null — what the one $defs.expr names beside the catalog),
//                        run(engine, input) → result,
//                        title, description, annotations (ToolAnnotations),
//                        side (the task side this tool starts), reads (the side its read returns —
//                        the tool that reads that side's tasks back), draws (true for the tool that
//                        draws a card, into the feature's view), waits (true for a call that waits on
//                        a task), precheck(engine, args) (what a waiting call would refuse, before
//                        waiting) } } — each becomes a tool definition like a core tool's
//                        (src/tools/define.js), in the one registry the engine holds
//   view:    { uri, name, title, description, asset (a RUNTIME_ASSETS key), viewModel(result, args),
//              forModel(result, args) — what the model reads of a drawn card (the card keeps the whole result) }
//   guide:   { name (a reserved semantic_index({ request: { guide } }) name), build(catalog) → object,
//              triggers: [{ if, do }] (routing triggers added to the analyst guide) }
//   skill(engine) → { path, frontmatter, body, references: [[relPath, text]] }
//   instructions: one line for the core instructions
//   overview(engine) → what semantic_index's overview says about it
//   describeContext(engine, ctx) → what a context of this feature holds, for context({ action: describe }),
//              with `brief` for its line in the listing — null for a context that is not the feature's
//   deletes: { <what>: { form(catalog) → the closed form a context delete takes for it, `what` pinned to
//              <what> (src/schema-kit.js form, tag ['what', <what>]), run(engine, input) → what was removed,
//              answered as a context delete answers ({ removed, … }), `input` the form's fields without
//              `what` } } — a kind of build a context of the feature holds, removed by a context delete
//              as the core's are: one form of its union each, there only while the feature is on

import { retentioneeringDefinition } from './retentioneering/index.js';
import { defineTool } from './tools/define.js';

/** Every feature this server knows. Each is off unless its flag turns it on. */
export const FEATURE_DEFINITIONS = [retentioneeringDefinition];

const ON = /^(1|true|yes|on)$/i;

/** Whether an env flag is on: only an explicit yes turns a feature on — a feature is opt-in. */
export function flagOn(value) {
  return ON.test(String(value ?? '').trim());
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

/**
 * What the resolved features add to the context delete — each a kind of build a feature's context holds:
 * { what, form, run }, `form` one closed form of the context delete union with `what` pinned to its key
 * (checked here: a form that does not say which it is would overlap another, a defect found at start).
 */
export function featureDeletes(features = [], catalog = null) {
  return features.flatMap((feature) => Object.entries(feature.deletes || {}).map(([what, d]) => {
    const form = d.form(catalog);
    if (form?.properties?.what?.const !== what || !(form.required || []).includes('what') || form.additionalProperties !== false) {
      throw new Error(`feature '${feature.id}': its context delete form '${what}' must be a closed form that requires what: "${what}"`);
    }
    if (typeof d.run !== 'function') throw new Error(`feature '${feature.id}': its context delete form '${what}' has no run(engine, input)`);
    return { what, form, run: d.run };
  }));
}

/** The tool definitions the resolved features add (src/tools/define.js) — each like a core tool's. */
export function featureToolDefinitions(features = []) {
  return features.flatMap((feature) => Object.entries(feature.tools || {}).map(([name, { draws, ...tool }]) => defineTool({
    name,
    ...tool,
    // the tool that draws draws into the feature's own view, for a client that renders MCP Apps
    ...(draws ? { view: feature.view, appsOnly: true } : {}),
    feature,
  })));
}
