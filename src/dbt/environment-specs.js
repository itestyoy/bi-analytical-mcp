// WHAT EACH dbt ENVIRONMENT IS — decided here, by this tool, and nowhere else.
//
// An environment (src/dbt/environments.js) is built ONLY from this list — `npm run dbt:env -- create
// <name>` (scripts/dbt-env.mjs), in the image at `docker build`: its name, what it is for, and the
// EXACT versions of its packages. There is no
// requirements file and no way to hand the tool packages or versions of one's own; the server runs
// only environments built from this list (a spec changed since a build refuses that build).
// Changing a version is a change HERE, reviewed like any other code.

/** The pip every environment is built with, installed first: not whichever pip the Python shipped. */
export const INSTALLER = 'pip==26.2.1';

// Every environment carries the adapters of BOTH warehouses this server speaks (DuckDB and
// BigQuery): one image serves either, and dbt picks the adapter from the project's profile.
export const ENVIRONMENT_SPECS = {
  'dbt-v2': {
    description: 'dbt v2 — the Rust binary. Its warehouse adapters are built in (it fetches their ADBC driver on first use), so there is no adapter package.',
    packages: ['dbt==2.0.6'],
  },
  'dbt-v1': {
    description: 'dbt 1.x — the Python dbt-core with the DuckDB and BigQuery adapters, plus pandas + pyarrow, with which dbt-duckdb runs dbt Python models locally (the python stage; dbt v2 runs none on DuckDB).',
    packages: ['dbt-core==1.11.11', 'dbt-duckdb==1.11.0', 'dbt-bigquery==1.11.3', 'pandas==3.0.6', 'pyarrow==25.0.1'],
  },
  metricflow: {
    description: "MetricFlow's `mf` and the Python dbt-core + the DuckDB and BigQuery adapters it queries the warehouse with. Every dbt environment queries metrics through it (dbt's docs, without the dbt platform: \"install MetricFlow separately\"). dbt-metricflow 0.13.0 pins metricflow 0.211.0 and caps dbt-core below 1.12.",
    packages: ['dbt-metricflow==0.13.0', 'dbt-core==1.11.11', 'dbt-duckdb==1.11.0', 'dbt-bigquery==1.11.3'],
  },
};

/** The exact packages of the environment `name`, or a refusal naming what is defined. */
export function environmentPackages(name) {
  const spec = ENVIRONMENT_SPECS[name];
  if (!spec) throw new Error(`no dbt environment '${name}' is defined (defined: ${Object.keys(ENVIRONMENT_SPECS).join(', ')}) — environments are declared in src/dbt/environment-specs.js`);
  return spec.packages;
}
