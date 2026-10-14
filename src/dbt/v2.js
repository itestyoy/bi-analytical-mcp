// dbt v2 — the Rust `dbt` binary. The same commands as 1.x (parse / run / show / seed /
// run-operation), so the client is 1.x's with what v2 does differently:
//   * it reads semantic models only in the LATEST YAML spec (a legacy `semantic_models:` file is
//     dropped with a warning, and no semantic_manifest.json is written) — `semanticSpec: 'latest'`
//     tells the renderer (src/semantic-latest.js);
//   * `dbt show --output json` prints a bare array of rows (src/dbt/output.js reads both);
//   * there is no partial-parse cache to seed an isolated target with;
//   * `dbt show --inline` leaves three files of its own in target/ on every call, so a show runs in
//     a target directory of its own (below);
//   * its manifest's percentiles are put back as asked — the same correction dbt 1.12 needs on the
//     latest spec (src/dbt/v1.js restorePercentiles), so it lives in the shared parse;
//   * Python models: not on DuckDB ("Python models are not supported for duckdb adapter").
// Metric queries still go through MetricFlow's `mf` (a Python install of its own), which reads the
// semantic_manifest.json v2 writes.

import { DbtV1 } from './v1.js';
import { isolatedTarget } from '../request-context.js';

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

  /**
   * Every `dbt show --inline` writes the query under a fresh id — target/inline_<id>.sql, and its
   * compiled SQL and macro spans under target/compiled/ — that no later command removes, so a
   * context read again and again would grow without bound; and it rewrites
   * target/semantic_manifest.json without the percentiles parse() put back (restorePercentiles).
   * So a show runs in a target directory of its own, removed after (src/dbt/v1.js _dbt): the
   * context's target/ stays as its parse and runs left it. v2 keeps no partial-parse cache, so a
   * show parses the project in full either way — on DuckDB it takes as long as before.
   */
  show(projectDir, sql, limit, timeout) {
    return isolatedTarget(() => super.show(projectDir, sql, limit, timeout));
  }
}
