// dbt v2 — the Rust `dbt` binary. The same commands as 1.x (parse / run / show / seed /
// run-operation), so the client is 1.x's with what v2 does differently:
//   * it reads semantic models only in the LATEST YAML spec (a legacy `semantic_models:` file is
//     dropped with a warning, and no semantic_manifest.json is written) — `semanticSpec: 'latest'`
//     tells the renderer (src/semantic-latest.js);
//   * `dbt show --output json` prints a bare array of rows (src/dbt/output.js reads both);
//   * there is no partial-parse cache to seed an isolated target with;
//   * its manifest's percentiles are put back as asked — the same correction dbt 1.12 needs on the
//     latest spec (src/dbt/v1.js restorePercentiles), so it lives in the shared parse;
//   * Python models: not on DuckDB ("Python models are not supported for duckdb adapter").
// Metric queries still go through MetricFlow's `mf` (a Python install of its own), which reads the
// semantic_manifest.json v2 writes.

import { DbtV1 } from './v1.js';

const NO_PYTHON_MODELS = new Set(['duckdb']);

export class DbtV2 extends DbtV1 {
  constructor(opts = {}) {
    super(opts);
    this.major = 2;
  }

  get semanticSpec() { return 'latest'; }

  /** dbt v2 parses every SQL model (static analysis) and does not know BigQuery's pipe syntax: it
   *  warns "mismatched input 'FROM'" on each such model and learns nothing from it. The model says so. */
  unparsedSqlConfig() { return { static_analysis: 'off' }; }

  pythonModelsOn(adapter) { return !NO_PYTHON_MODELS.has(String(adapter || '').toLowerCase()); }
}
