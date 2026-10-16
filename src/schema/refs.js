// THE ONE REF — every name of a thing of the catalog or of the semantic layer, in ONE definition every
// tool that names one takes (`$defs.ref`), its forms grouped by what they name:
//   the catalog: a source and what it has — { source }, { source, event }, { source, column, via? },
//                { source, property };
//   the semantic layer — { semantic_model, dimension, grain? }, { entity }, { metric },
//                { time: "metric_time", grain? }.
// A model's column is `column` (users.country is { source: "users", column: "country" }) and an event's
// payload property is `property`, as the expression's leaves name them; the forms that name a VALUE are
// leaves of the one expression too (src/pipeline/compute.js). Every name a source carries is an enum of
// THAT source's form — one closed form per source, as semantic_index's views have always been written —
// so a name is never written without its owner, and a name the source does not carry cannot be written.
//
// What a PLACE takes of them (semantic_index's views, what a memory note is about, a metric query's
// group_by) is one table (REF_PLACES), checked when the value is read (refAt): the refusal names the
// place and what it takes. A tool's `$defs.ref` holds the forms its own places take, and no other.

import { strEnum, form } from '../schema-kit.js';
import { GRAINS } from '../catalog.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Every kind of ref: the fields its form takes, how a refusal says it, the group it is listed under, and
 * whether it names a VALUE (a leaf of the one expression) rather than a thing to look at (a source, an
 * event).
 */
export const REFS = {
  source: { group: 'catalog', fields: ['source'], says: '{ source }' },
  source_event: { group: 'catalog', fields: ['source', 'event'], says: '{ source, event }' },
  source_column: { group: 'catalog', fields: ['source', 'column', 'via'], says: '{ source, column }', value: true },
  source_property: { group: 'catalog', fields: ['source', 'property'], says: '{ source, property }', value: true },
  dimension: { group: 'semantic', fields: ['semantic_model', 'dimension', 'grain'], says: '{ semantic_model, dimension }', value: true },
  entity: { group: 'semantic', fields: ['entity'], says: '{ entity }', value: true },
  metric: { group: 'semantic', fields: ['metric'], says: '{ metric }', value: true },
  time: { group: 'semantic', fields: ['time', 'grain'], says: '{ time: "metric_time" }', value: true },
};

/** The refs that name a value — what an expression reads as a leaf. */
export const VALUE_REFS = Object.keys(REFS).filter((k) => REFS[k].value);

/** What each group of refs is, as its title says it. */
export const REF_GROUPS = {
  catalog: 'the catalog: a source and what it has',
  semantic: 'the semantic layer: a dimension, an entity, a metric, the metric time axis',
};

/** Which ref a value is, by the fields that say it — null when it is none. */
export function refKind(v) {
  if (!isObj(v) || v.fn !== undefined) return null;
  if (v.source !== undefined) return v.event !== undefined ? 'source_event' : v.column !== undefined ? 'source_column' : v.property !== undefined ? 'source_property' : 'source';
  if (v.semantic_model !== undefined) return 'dimension';
  if (v.entity !== undefined) return 'entity';
  if (v.metric !== undefined) return 'metric';
  if (v.time !== undefined) return 'time';
  return null;
}

/** The columns of a model a ref names: its groupable attributes (the dimensions the catalog declares and,
 *  on an events source, its event column). */
export function refColumns(catalog, model) {
  const m = catalog.getModel(model);
  return [...new Set([...Object.keys(m.dimensions || {}), ...catalog.modelDimensionColumns(model)])];
}

/** The relationships that lead to `model`: each entity a model declares whose owner is `model`. */
export function relationshipsTo(catalog, model) {
  return [...new Set(catalog.modelKeys().flatMap((k) => Object.keys(catalog.entitiesOf(k))).filter((e) => catalog.joinTargetFor(e) === model))];
}

/** The semantic models a { semantic_model } may name: the dbt project's own and those a task's context
 *  loads (named after the catalog's models). */
const semanticModelNames = (catalog, project) => [...new Set([...(project?.semantic_models || []).map((m) => m.name), ...(catalog?.semanticModelKeys?.() || [])])].sort();

/** The entities an { entity } may name: the relationships the catalog's models declare, and the dbt
 *  project's own entities. */
const entityNames = (catalog, project) => [...new Set([
  ...(catalog ? catalog.modelKeys().flatMap((k) => Object.keys(catalog.entitiesOf(k))) : []),
  ...(project?.semantic_models || []).flatMap((m) => (m.entities || []).map((e) => e.name)),
])].sort();

/**
 * Every form of the ref, by kind — the catalog's own vocabulary closed per source (a source with no name
 * of a kind has no form of it). `project`: the dbt project's own semantic layer, whose semantic models and
 * entities the semantic forms name too. A catalog-less build (null) has the semantic forms alone. `via`:
 * whether a column's form offers the relationship it is reached through (false where no place reads one).
 */
export function refForms(catalog, { project = null, via: offerVia = true } = {}) {
  const grains = catalog?.timeGranularities ? catalog.timeGranularities() : [...GRAINS];
  const models = catalog ? catalog.modelKeys() : [];
  const facts = catalog ? catalog.facts : [];
  const unavailable = Object.keys(catalog?.unavailableModels?.() || {});
  const grain = { enum: grains, description: 'The time bucket, for a time dimension (default: its own granularity).' };
  const entities = entityNames(catalog, project);
  return {
    source: models.length ? [form({ title: '{ source }', required: ['source'], properties: { source: { enum: [...models, ...unavailable], description: 'A model of the catalog — an events source, the users model, the experiments, a measures source.' } } })] : [],
    source_event: facts.map((f) => form({
      title: `{ source: "${f}", event }`, required: ['source', 'event'],
      properties: { source: { const: f, description: `The events source '${f}'.` }, event: strEnum(catalog.eventNames(f), `An event '${f}' declares.`) },
    })),
    source_column: models.flatMap((k) => {
      const columns = refColumns(catalog, k);
      if (!columns.length) return [];
      const vias = offerVia ? relationshipsTo(catalog, k) : [];
      return [form({
        title: `{ source: "${k}", column }`, required: ['source', 'column'],
        properties: {
          source: { const: k, description: `The model '${k}'.` },
          column: strEnum(columns, `A column of '${k}', as semantic_index({ request: { source: "${k}" } }) lists it.`),
          ...(vias.length > 1 ? { via: { enum: vias, description: `The relationship '${k}' is reached through — several lead to it.` } } : {}),
        },
      })];
    }),
    source_property: facts.flatMap((f) => {
      const props = catalog.eventProps(f);
      // the enum carries no sentence of its own, so the transport folds it with the { property } leaf's
      // where the two lists are one (a catalog of one events source)
      return props.length ? [form({ title: `{ source: "${f}", property }`, description: `An event property of '${f}', read where it is stored.`, required: ['source', 'property'], properties: { source: { const: f, description: `The events source '${f}'.` }, property: strEnum(props) } })] : [];
    }),
    dimension: [form({
      title: '{ semantic_model, dimension }', required: ['semantic_model', 'dimension'],
      description: 'A dimension of a semantic model, named by where it lives: semantic_model is the chain of semantic models it is reached through — ["<the context\'s own>"] for its own, ["X"] for one of X joined to directly, ["A", "X"] for one of X reached through A — and MetricFlow makes the joins. A dimension a task computed ({ name, expr }) is named so too.',
      properties: {
        // (a build's own table is a semantic model of its context under the build's name — no name of the catalog)
        semantic_model: { type: 'array', minItems: 1, items: { anyOf: [strEnum(semanticModelNames(catalog, project)), { type: 'string', pattern: '^[a-z][a-z0-9_]{2,40}$', description: 'A build\'s own table, named as the build: the semantic model its semantic_model step stands on.' }] }, description: 'The chain of semantic models the dimension is reached through, in order, ending with the one that carries it.' },
        dimension: { type: 'string', minLength: 1, description: 'The dimension\'s name, as its semantic model declares it.' },
        grain,
      },
    })],
    entity: entities.length ? [form({ title: '{ entity }', required: ['entity'], description: 'An entity — a key a semantic model declares (a relationship of the catalog, an entity of the project) — by name: grouped by, one row per key value.', properties: { entity: { enum: entities, description: 'The entity\'s name.' } } })] : [],
    metric: [form({ title: '{ metric }', required: ['metric'], properties: { metric: { type: 'string', minLength: 1, description: 'A metric, by its name.' } } })],
    time: [form({ title: '{ time: "metric_time" }', required: ['time'], properties: { time: { const: 'metric_time', description: 'The metric time axis.' }, grain } })],
  };
}

/** The forms that name a VALUE, in order — the leaves the one expression adds to the rows' own: those of
 *  `kinds` (default: every one). */
export function valueRefForms(catalog, { project = null, kinds = VALUE_REFS } = {}) {
  const forms = refForms(catalog, { project });
  return VALUE_REFS.filter((k) => kinds.includes(k)).flatMap((k) => forms[k]);
}

/** What the groups are called, and each kind of ref, in the ref's description. */
const GROUP_SAID = { catalog: 'the catalog', semantic: 'the semantic layer' };
const REF_SAID = {
  source: 'a source ({ source })',
  source_event: 'one of its events ({ source, event })',
  source_column: 'a column of a model ({ source, column } — users.country is { source: "users", column: "country" })',
  source_property: 'an event property ({ source, property })',
  dimension: 'a dimension of a semantic model ({ semantic_model, dimension })',
  entity: 'an entity',
  metric: 'a metric',
  time: 'the metric time axis ({ time: "metric_time", grain })',
};

/** Places by their REF_PLACES names (or places of that shape, as a feature passes) — null for none named. */
function refPlacesOf(places) {
  if (!places?.length) return null;
  return places.map((p) => {
    const place = typeof p === 'string' ? REF_PLACES[p] : p;
    if (!place) throw new Error(`refSchema: no ref place '${p}'`);
    return place;
  });
}

/**
 * THE REF — `$defs.ref` of a tool that names things of the catalog or the semantic layer: the forms its
 * PLACES take (REF_PLACES names, or places of that shape; none named — every form), grouped by what they
 * name (a titled union per group; a group none of them takes is left out). A column's `via` is offered
 * where a place reads one. Places that take different refs share the definition, each checked when the
 * value is read (refAt).
 */
export function refSchema(catalog, { project = null, places = null } = {}) {
  const at = refPlacesOf(places);
  const forms = refForms(catalog, { project, via: !at || at.some((p) => p.via) });
  const kinds = Object.keys(REFS).filter((k) => (!at || at.some((p) => p.takes.includes(k))) && forms[k].length);
  const byGroup = Object.keys(REF_GROUPS).map((group) => [group, kinds.filter((k) => REFS[k].group === group)]).filter(([, ks]) => ks.length);
  const several = !at || new Set(at.map((p) => p.takes.join())).size > 1;
  return {
    description: `A thing of ${byGroup.map(([g]) => GROUP_SAID[g]).join(' or ')}, named by where it lives: ${byGroup.map(([, ks]) => ks.map((k) => REF_SAID[k]).join(', ')).join('; ')}.${several ? ' Each place takes some of them.' : ''}`,
    anyOf: byGroup.map(([group, ks]) => ({ title: REF_GROUPS[group], anyOf: ks.flatMap((k) => forms[k]) })),
  };
}

/**
 * WHO TAKES WHICH REF — one table: the places that take a ref as such (not inside an expression — those
 * are the expression's places, src/pipeline/compute.js PLACES), what each is called in a refusal and the
 * kinds it takes. `via`: whether the place reads a relationship chosen for a column.
 */
export const REF_PLACES = {
  index_view: { what: 'a semantic_index view', takes: ['source', 'source_event', 'source_column', 'source_property'] },
  about: { what: "a memory note's about", takes: ['source', 'source_event', 'source_column', 'source_property'] },
  group_by: { what: 'a metric query\'s group_by', takes: ['source_column', 'source_property', 'dimension', 'entity', 'time'], via: true },
};

/**
 * A ref read at a place (a REF_PLACES name, or a place of the same shape a feature passes): its kind,
 * or a refusal naming the place and what it takes — a value that is no ref, a field its form does not
 * take, a kind the place does not take, a `via` where no relationship is chosen. `at` names it.
 */
export function refAt(place, v, at = 'ref') {
  const p = typeof place === 'string' ? REF_PLACES[place] : place;
  const takes = () => p.takes.map((k) => REFS[k].says).join(', ');
  const kind = refKind(v);
  if (!kind) throw new Error(`${at}: ${p.what} takes ${takes()} — ${JSON.stringify(v)} is none of them`);
  const stray = Object.keys(v).filter((k) => !REFS[kind].fields.includes(k));
  if (stray.length) throw new Error(`${at}: ${REFS[kind].says} takes ${REFS[kind].fields.join(', ')}, not ${stray.join(', ')}`);
  if (!p.takes.includes(kind)) throw new Error(`${at}: ${REFS[kind].says} is not what ${p.what} takes — it takes ${takes()}`);
  if (v.via !== undefined && !p.via) throw new Error(`${at}: ${p.what} reads a column where it is, through no relationship — leave out via`);
  return kind;
}
