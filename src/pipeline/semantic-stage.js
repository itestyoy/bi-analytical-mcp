// THE SEMANTIC_MODEL STEP — the last step of a build (build_model): the semantic layer over the rows
// the steps before it built, or — the only step — over the build's source. It is no stage of the
// registry: no SQL is written for it; MetricFlow computes what it declares (src/compile.js →
// src/yaml-render.js). Its form is one definition (src/schema/fields.js SEMANTIC_MODEL_STEP), offered by
// the place of a build (src/pipeline/stages.js STAGE_PLACES.build).
//
// Its main model is the build's own. `measures` fold its rows — or, with `source`, the rows of another
// model of the semantic layer, computed on their own and compared beside the main model's on metric_time
// and the group-by (MetricFlow joins no rows for them). `join` names the models whose attributes the
// metrics are grouped and filtered by — each on the join contract it declares, { source, on }, its parts
// checked here against the key MetricFlow joins it on, so what the call says is what the layer does.

import { TIME_PART, onPartsError, describeContract } from '../catalog/joins.js';
import { foldWhere } from './compute.js';

export const SEMANTIC_STAGE = 'semantic_model';

/** Whether a step is the semantic_model step. */
export const isSemanticStep = (st) => st?.stage === SEMANTIC_STAGE;

const fail = (message, field) => { const e = new Error(message); e.field = field; throw e; };

/**
 * The relationship MetricFlow joins `target` onto `main` through, for a join that names `on` — the one
 * whose owner is `target`, whose key on `target` is the contract's key columns, and whose key on
 * `main` is the columns `on` names part by part. Refused, naming what the semantic layer does join on,
 * when there is none.
 */
function joinRelationship(catalog, main, target, contract, on, at) {
  // the target's side of the contract's key, part by part (a part chosen by a word: the column it picks)
  const parts = contract.key.map((k) => ({ part: k.part, column: k.by ? k.columns[on[k.by]] : k.column }));
  const owned = Object.keys(catalog.entitiesOf(target)).filter((r) => catalog.joinTargetFor(r) === target && catalog.entityKey(main, r)?.length);
  if (!owned.length) {
    fail(`${at}: the semantic layer joins '${target}' onto '${main}' through a key '${target}' owns and '${main}' carries — there is none, so MetricFlow reaches none of its attributes from '${main}'. A measure of '${target}' is computed on its own rows beside the main model's: give it source: '${target}'`, 'join');
  }
  for (const r of owned) {
    const theirs = catalog.entityKey(target, r).map((k) => k.column);
    const mine = catalog.entityKey(main, r).map((k) => k.column);
    if (theirs.length !== parts.length || !parts.every((p) => theirs.includes(p.column))) continue;
    const wrong = parts.filter((p) => mine[theirs.indexOf(p.column)] !== on[p.part]);
    if (!wrong.length) return r;
    fail(`${at}: MetricFlow joins '${target}' onto '${main}' by the key '${r}' — ${parts.map((p) => `${p.part}: '${mine[theirs.indexOf(p.column)]}'`).join(', ')} on '${main}' — so on names ${wrong.map((p) => `${p.part}: '${mine[theirs.indexOf(p.column)]}'`).join(', ')}, not ${wrong.map((p) => `'${on[p.part]}'`).join(', ')}`, 'join');
  }
  fail(`${at}: no key of '${target}' that '${main}' carries is the contract's (${describeContract(target, contract)}) — the semantic layer joins it by ${owned.map((r) => `'${r}' (${catalog.entityKey(target, r).map((k) => k.column).join(', ')})`).join(', ')}`, 'join');
}

/** One join of the step, checked: the model, its parts, the key MetricFlow joins it on, its time. */
function checkJoin(catalog, main, timeColumn, j, i) {
  const at = `join[${i}] '${j.source}'`;
  const target = j.source;
  const contract = catalog.joinContract(target);
  const servable = catalog.joinableModels().filter((k) => k !== main && catalog.semanticModelKeys().includes(k));
  if (!contract) fail(`${at}: '${target}' declares no join contract, so it is not joinable — ${servable.length ? `the semantic layer joins ${servable.join(', ')}` : 'no model of this catalog is'}`, 'join');
  if (target === main) fail(`${at}: '${target}' is the build's own model — join a DIFFERENT model`, 'join');
  if (!catalog.semanticModelKeys().includes(target)) fail(`${at}: '${target}' has no primary entity, so a semantic layer cannot load it — join it in a step before this one ({ stage: "join", source: "${target}", on, attrs }) and group by the columns it brings`, 'join');
  const wrong = onPartsError(target, contract, j.on);
  if (wrong) fail(`${at}: ${wrong}`, 'join');
  // a value the joined model is filtered to first is a filter MetricFlow has no place for: the rows are
  // narrowed by a join step before this one instead
  const filters = contract.select.filter((s) => s.column);
  if (filters.length) fail(`${at}: a semantic join takes no filter of '${target}' (${filters.map((s) => s.part).join(', ')}) — join it in a step before this one, where its contract filters it, and group by the columns it brings`, 'join');
  for (const s of contract.select.filter((x) => x.values)) {
    if (!s.values.includes(j.on[s.part])) fail(`${at}: on.${s.part} is one of ${s.values.join(', ')}`, 'join');
  }
  if (contract.time) {
    // MetricFlow matches the joined row at the metric's time: the version valid then, the record of its day
    if (!timeColumn) fail(`${at}: '${main}' has no time axis, so '${target}' cannot be matched at a moment`, 'join');
    if (j.on[TIME_PART] !== timeColumn) fail(`${at}: MetricFlow matches '${target}' at the metric's time — on.time is '${timeColumn}', the main model's time axis, not '${j.on[TIME_PART]}'`, 'join');
  }
  return joinRelationship(catalog, main, target, contract, j.on, at);
}

/**
 * The foreign keys a table the steps before the step built carries, read off the step's joins — each the
 * relationship the joined model owns whose key is the contract's, keyed by the table's columns `on` names,
 * in the order the owner's key is written: { <relationship>: [<column>, …] }. `columns`: the table's.
 */
export function joinKeysOf(catalog, joins, columns) {
  const keys = {};
  for (const [i, j] of joins.entries()) {
    const at = `join[${i}] '${j.source}'`;
    const contract = catalog.joinContract(j.source);
    if (!contract) fail(`${at}: '${j.source}' declares no join contract, so it is not joinable`, 'join');
    const wrong = onPartsError(j.source, contract, j.on);
    if (wrong) fail(`${at}: ${wrong}`, 'join');
    for (const sel of contract.select.filter((x) => x.values)) {
      if (!sel.values.includes(j.on[sel.part])) fail(`${at}: on.${sel.part} is one of ${sel.values.join(', ')}`, 'join');
    }
    const parts = contract.key.map((k) => ({ part: k.part, column: k.by ? k.columns[j.on[k.by]] : k.column }));
    for (const p of parts) {
      if (!columns.includes(j.on[p.part])) fail(`${at}: on.${p.part} names '${j.on[p.part]}', which is no column of the table the steps before this one built — its columns: ${columns.join(', ')}`, 'join');
    }
    const theirs = parts.map((p) => p.column);
    const rel = Object.keys(catalog.entitiesOf(j.source)).find((r) => {
      const key = catalog.entityKey(j.source, r)?.map((k) => k.column) || [];
      return catalog.joinTargetFor(r) === j.source && key.length === theirs.length && key.every((c) => theirs.includes(c));
    });
    if (!rel) fail(`${at}: no key '${j.source}' owns is the contract's (${describeContract(j.source, contract)}) — the semantic layer joins onto a key a model owns`, 'join');
    keys[rel] = catalog.entityKey(j.source, rel).map((k) => j.on[parts.find((p) => p.column === k.column).part]);
  }
  return keys;
}

/**
 * The declaration a semantic_model step makes over a catalog source — the build's `source`, with no
 * step before it: { name, description?, semantic_models, metrics }, the shape src/compile.js compiles.
 * The main model's item holds its dimensions and the measures without `source`; each other model a
 * measure names, an item of its measures; each joined model, an item that loads it.
 */
export function declarationOf(catalog, { name, description, source }, st) {
  const main = catalog.getModel(source);
  if (!catalog.semanticModelKeys().includes(source)) fail(`'${source}' has no primary entity, so a semantic layer cannot be built over it — a semantic layer is built over ${catalog.semanticModelKeys().join(', ')}`, 'source');
  const timeColumn = main.time?.column || null;
  if (st.time !== undefined && st.time !== timeColumn) fail(`time: '${source}' is read on its own time axis, '${timeColumn}' — leave time out (it names the axis of a table the steps before this one built)`, 'time');
  const items = new Map([[source, { source }]]);
  const item = (k) => { if (!items.has(k)) items.set(k, { source: k }); return items.get(k); };
  if (st.dimensions?.length) items.get(source).dimensions = st.dimensions;
  for (const [i, m] of (st.measures || []).entries()) {
    const { source: of, ...measure } = m;
    if (of === source) fail(`measures[${i}] '${m.name}': '${source}' is the main model — leave source out`, 'measures');
    if (of !== undefined && !catalog.semanticModelKeys().includes(of)) fail(`measures[${i}] '${m.name}': '${of}' has no primary entity, so a semantic layer cannot load it — the semantic layer loads ${catalog.semanticModelKeys().join(', ')}`, 'measures');
    (item(of ?? source).measures ||= []).push(measure);
  }
  const seen = new Set();
  for (const [i, j] of (st.join || []).entries()) {
    if (seen.has(j.source)) fail(`join[${i}]: '${j.source}' is joined twice`, 'join');
    seen.add(j.source);
    checkJoin(catalog, source, timeColumn, j, i);
    item(j.source);
  }
  return { name, ...(description ? { description } : {}), semantic_models: [...items.values()], metrics: st.metrics };
}

/**
 * A declaration ({ name, semantic_models, metrics }) as the semantic_model step that makes it, over its
 * first item's model: what a recipe written as a declaration is read as. An item's `where` is folded
 * into each of its measures (an aggregate over a case that holds where the where does: foldWhere), a
 * model loaded for its columns is joined on its contract — its key the main model's, its time the main
 * model's axis — and every other item's measures name their model.
 */
export function stepOfDeclaration(catalog, decl) {
  const [first, ...rest] = decl.semantic_models || [];
  if (!first) return null;
  const source = first.source;
  const fold = (sm) => (sm.measures || []).map((m) => (sm.where?.length ? { ...m, expr: foldWhere(m.expr, sm.where) } : m));
  const measures = [...fold(first), ...rest.flatMap((sm) => fold(sm).map((m) => ({ ...m, source: sm.source })))];
  const join = [];
  for (const sm of rest) {
    if (sm.measures?.length) continue;
    const contract = catalog.joinContract(sm.source);
    const rel = Object.keys(catalog.entitiesOf(sm.source)).find((r) => catalog.joinTargetFor(r) === sm.source && catalog.entityKey(source, r)?.length);
    if (!contract || !rel) continue;
    const theirs = catalog.entityKey(sm.source, rel).map((k) => k.column);
    const mine = catalog.entityKey(source, rel).map((k) => k.column);
    const on = {};
    for (const k of contract.key) {
      // a part chosen by a word: the word whose column is the key's, then that column's counterpart
      const word = k.by ? Object.keys(k.columns).find((w) => theirs.includes(k.columns[w])) : null;
      if (k.by && !word) continue;
      if (word) on[k.by] = word;
      on[k.part] = mine[theirs.indexOf(word ? k.columns[word] : k.column)];
    }
    if (contract.time) on[TIME_PART] = catalog.getModel(source).time?.column;
    join.push({ source: sm.source, on });
  }
  const step = {
    stage: SEMANTIC_STAGE,
    ...(first.dimensions?.length ? { dimensions: first.dimensions } : {}),
    ...(join.length ? { join } : {}),
    ...(measures.length ? { measures } : {}),
    metrics: decl.metrics,
  };
  return { action: 'start', name: decl.name, source, ...(decl.description ? { description: decl.description } : {}), steps: [step], materialize: true };
}
