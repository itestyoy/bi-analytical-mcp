// dbt v2 — the Rust `dbt` binary. The same commands as 1.x (parse / run / show / seed /
// run-operation), so the client is 1.x's with what v2 does differently:
//   * it reads semantic models only in the LATEST YAML spec (a legacy `semantic_models:` file is
//     dropped with a warning, and no semantic_manifest.json is written) — `semanticSpec: 'latest'`
//     tells the renderer (src/semantic-latest.js);
//   * `dbt show --output json` prints a bare array of rows (src/dbt/output.js reads both);
//   * there is no partial-parse cache to seed an isolated target with;
//   * Python models: not on DuckDB ("Python models are not supported for duckdb adapter").
// Metric queries still go through MetricFlow's `mf` (a Python install of its own), which reads the
// semantic_manifest.json v2 writes.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DbtV1 } from './v1.js';

const NO_PYTHON_MODELS = new Set(['duckdb']);

export class DbtV2 extends DbtV1 {
  constructor(opts = {}) {
    super(opts);
    this.major = 2;
  }

  get semanticSpec() { return 'latest'; }

  pythonModelsOn(adapter) { return !NO_PYTHON_MODELS.has(String(adapter || '').toLowerCase()); }

  /**
   * `dbt parse`, then the one correction v2's semantic manifest needs: it writes every percentile
   * as APPROXIMATE with its fraction rounded to float32 (0.9 → 0.8999999761581421), whatever the
   * YAML said. A metric's `config.meta.mcp_percentile` records what was asked (src/semantic-latest.js)
   * and is put back, so a percentile answers the same on either dbt version.
   */
  async parse(projectDir) {
    const r = await super.parse(projectDir);
    const file = join(projectDir, 'target', 'semantic_manifest.json');
    if (r.ok && existsSync(file)) {
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        let changed = false;
        for (const m of manifest.metrics || []) {
          const asked = m.config?.meta?.mcp_percentile;
          const params = m.type_params?.metric_aggregation_params?.agg_params;
          if (!asked || !params) continue;
          Object.assign(params, { percentile: asked.percentile, use_discrete_percentile: !!asked.discrete, use_approximate_percentile: !!asked.approximate });
          changed = true;
        }
        if (changed) writeFileSync(file, JSON.stringify(manifest));
      } catch { /* an unreadable manifest is MetricFlow's to report */ }
    }
    return r;
  }
}
