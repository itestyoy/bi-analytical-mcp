// GROUNDING — the catalog checked against the warehouse at start: each model's real columns and their
// types, read through dbt; a model whose relation is not there is left out with the reason.

/**
 * Reconcile a catalog against the warehouse: introspect each model's physical columns
 * (via the runner, same call semantic_index uses) and PRUNE declared columns/properties/
 * dimensions the table does not have — so the desync ("catalog declares a column the
 * physical table lacks") can never surface anywhere downstream. Best-effort: a model
 * whose relation can't be introspected is left as declared. Returns { pruned }.
 */
// How the adapters word "this relation is not there": DuckDB/Redshift `relation … does not
// exist`, BigQuery `Not found: Table …`, Snowflake `… does not exist or not authorized`, Databricks
// `TABLE_OR_VIEW_NOT_FOUND`, dbt's own `… depends on a node named '…' which was not found`.
export const RELATION_ABSENT = /does not exist|doesn't exist|not found|no such table|unknown table|could not find|table_or_view_not_found/i;

export async function groundCatalogToPhysical(catalog, runner, baseProjectDir, log = () => {}) {
  if (!runner || !baseProjectDir || typeof runner.relationColumns !== 'function') return { pruned: {} };
  const phys = {};
  const types = {};
  const transient = [];
  const keys = catalog.modelKeys();
  for (const key of keys) {
    try {
      const r = await runner.relationColumns(baseProjectDir, catalog.getModel(key).dbt_model);
      if (r && r.ok && Array.isArray(r.columns)) {
        phys[key] = new Set(r.columns.map((c) => String(c.name).toLowerCase()));
        types[key] = new Map(r.columns.map((c) => [String(c.name).toLowerCase(), c.dtype]));
        continue;
      }
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
  const out = catalog.groundToPhysical(phys);
  // the warehouse's type decides over the declared one: say which declarations it overruled
  for (const [k, changes] of Object.entries(catalog.typeToPhysical(types))) log(`catalog grounding: '${k}' — typed as the warehouse has them, not as declared: ${changes.slice(0, 12).join('; ')}${changes.length > 12 ? '; …' : ''}`);
  return out;
}
