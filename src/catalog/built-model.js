// THE MODEL A BUILD'S SEMANTIC LAYER STANDS ON — the table the steps before a build's semantic_model step
// built (src/pipeline/semantic-stage.js), as a model of its context's own catalog: a measures source of the
// catalog's shape (src/catalog/from-dbt-schema.js), whose rows are the table's, whose time axis is the
// column the step names, and whose foreign keys are the ones its joins name — each the relationship the
// joined model owns, keyed by the table's columns `on` names. It is the context's alone: the catalog every
// other context reads does not hold it, and the context's catalog is that one with it beside the others.

/**
 * The model, from what the build knows of its table: its dbt model, its columns ({ name, type }), its time
 * axis, its foreign keys ({ <relationship>: [<column>, …] }, in the order the owner's key is written) and
 * the source its build read (`from`). It
 * has no key of its own (a built table holds whatever rows its steps left): its semantic model names its
 * identity alone, so its columns are reached under it and nothing joins onto it.
 */
export function builtModel({ key, dbtModel, columns, time, keys = {}, description, from = null }) {
  const dimensions = {};
  for (const c of columns) {
    // (a sketch is merged, never grouped by)
    if (c.type === 'json' || c.type === 'sketch' || /^array/.test(String(c.type))) continue;
    dimensions[c.name] = c.type === 'time' ? { type: 'time', granularity: 'day' } : { type: 'categorical' };
  }
  return {
    dbt_model: dbtModel,
    role: key,
    built: true,
    // the source the build read: its data is as recent as that source's
    ...(from ? { built_from: from } : {}),
    ...(description ? { description } : {}),
    primary_entity: { name: key },
    time: { column: time, granularity: 'day' },
    columns: columns.map((c) => ({ name: c.name, type: c.type || 'unknown' })),
    data_types: {},
    entities: Object.fromEntries(Object.entries(keys).map(([rel, cols]) => [rel, { type: 'foreign', key: cols.map((column) => ({ column })) }])),
    dimensions,
  };
}

/** `catalog` with `model` beside its own models, under `key` — a context's catalog. */
export function catalogWith(catalog, key, model) {
  const c = Object.create(Object.getPrototypeOf(catalog));
  Object.assign(c, catalog);
  c.models = { ...catalog.models, [key]: model };
  c._indexOwners();
  return c;
}
