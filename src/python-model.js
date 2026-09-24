// The `python` PIPELINE STAGE — a dbt PYTHON model anywhere in a native pipeline.
//
// One declaration, a CHAIN of dbt models under the hood: the SQL stages before a python stage land
// as a table, the python stage becomes the one `.py` file dbt expects (`def model(dbt, session)`)
// reading it through `dbt.ref` (or reading the SOURCE directly when it is the first stage), SQL
// stages after it become another SQL model reading the Python model — any number of python
// stages, in any position. dbt orders the chain from the refs and runs the Python models on the
// warehouse's own Python runtime (BigQuery: BigFrames / Dataproc; Snowflake: Snowpark;
// Databricks: PySpark; DuckDB locally) — nothing executes on the MCP host, and the caller
// addresses one name: the pipeline's last model IS the result.
//
// What the caller writes in the stage: the imports it needs (from the server's allowlist), its
// own functions (plain Python over a pandas frame) and the steps calling them in order. What the
// caller never writes: `dbt.ref` (the prep table is the one input), `dbt.config` (materialization,
// packages and the operator's runtime settings) and the final `return` (from `output.columns`).
// Function bodies pass a static gate (python/ast_gate.py) before anything is written or run.

import { spawn } from 'node:child_process';
import { assetPath, missingAssetMessage } from './runtime-assets.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { registerStage } from './pipeline.js';
import { pythonRulesText, mlClassesText, bigframesRunHints } from './python-guide.js';
import { inertText } from './jinja-inert.js';

// the gate script is a non-JS runtime asset — see src/runtime-assets.js for why it is resolved there
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// Python keywords (no identifier may be one) + the names the generated file reserves for its own
// top level (a FUNCTION may not take them; a parameter is local to its function and may be `df`).
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const RESERVED = new Set([...KEYWORDS, 'model', 'dbt', 'session', 'pd', 'df']);

/**
 * What `dbt.ref()` hands the model on THIS warehouse — the frame the steps work on, as dbt's own
 * docs describe per platform: BigFrames (the pandas API, computed inside BigQuery), Snowpark,
 * PySpark, a DuckDB relation. The server never converts it: the work stays in the warehouse
 * engine. Whoever truly needs pandas writes the platform's conversion inside a function
 * (`.to_pandas()`, `.pandas_api()`, `.df()`) and owns that cost. The submission method may also
 * come from the operator's per-model config.
 */
export function frameProfile(rt, config = {}) {
  const runtime = String(rt?.runtime || '').toLowerCase();
  const method = String(config.submission_method || rt?.method || '').toLowerCase();
  // Per platform: what the frame is, how pandas is spelled, the ML library that runs INSIDE the
  // engine (`ml`), and the do/don't list that keeps the work there (`guide`) — from the platforms'
  // own docs (BigQuery DataFrames: bigframes.ml = the scikit-learn API executed as BigQuery ML;
  // Spark: pyspark.ml; Snowflake: snowflake.ml.modeling).
  if (runtime === 'bigquery' && (method === 'bigframes' || !method)) {
    return {
      key: 'bigframes',
      native: 'a BigFrames DataFrame — bigframes.pandas, the pandas API compiled to BigQuery SQL and executed in BigQuery (import bigframes.pandas as bpd for constructors)',
      pandas: 'df.to_pandas()',
      // The CLASSES come from the extracted fact sheet (src/python-guide.js → mlClassesText),
      // never from a list written here: a hand-kept copy is how a signature drifts from the library.
      // The PARAMETERS are not restated in this line at all — they are the reference recipe's.
      ml: 'bigframes.ml — the scikit-learn API run as BigQuery ML (model.fit trains IN BigQuery, model.predict returns a BigFrames frame), with BQML\'s own parameters',
      // The CLASS LIST is a separate field because it belongs to a different reader: the long guide
      // prints it, and the stage DESCRIPTION only names the library and points at the reference
      // recipe (every constructor, extracted from the installed version). Where this deployment
      // ships no recipes there is nothing to point at, so the description inlines the list instead
      // — the same fallback the rules use.
      mlClasses: mlClassesText(),
      mlReference: (rt?.recipes || []).some((r) => (r?.id || r) === 'bf_ml_signatures') ? 'bf_ml_signatures' : null,
      guide: pythonRulesText('bigframes', rt?.recipes || []),
      packagesNote: 'On BigFrames prefer bigframes (bigframes.ml) over sklearn / scipy / statsmodels: those run only after df.to_pandas(), single-node.',
      // Two things this frame does NOT have — no row order (dbt's wrapper runs with
      // ordering_mode="partial") and no index at all — are stated in `guide`, where the author
      // reads them BEFORE writing the code. They are deliberately not gated: whether a given line
      // trips them depends on how the code is written, and a static refusal would block working
      // code as often as it would catch a real trap.
      // The submission this profile DESCRIBES. A deployment may resolve none (MCP_PYTHON_MODELS=on
      // on a profile with no submission_method, a profile that only hints at one): the frame, the
      // allowlist, the rules and the gate all then describe BigFrames while dbt, reading nothing,
      // would fall back to its own default (serverless → PySpark) and the model would die in a
      // Dataproc job. Writing the submission this profile stands for keeps the two the same.
      submission: 'bigframes',
      // WHAT A FAILURE CLASS MEANS on this runtime — a fact about the runtime, NOT a diagnosis of
      // the code: which operation raised it is in the traceback, and nothing here can know which
      // line the author meant, so no hint prescribes a rewrite. Composed next to the rules and the
      // extracted method lists (src/python-guide.js → bigframesRunHints), so a hint can never name
      // a method or a claim the guide does not, and `pythonRunHints` stays a matcher with no
      // runtime inside it.
      runHints: bigframesRunHints(),
      packages: ['bigframes'],
    };
  }
  if (runtime === 'bigquery' || runtime === 'databricks') {
    return {
      key: 'pyspark',
      native: 'a PySpark DataFrame — pyspark.sql (.filter / .withColumn / .groupBy / .select, functions via pyspark.sql.functions)',
      pandas: 'df.pandas_api() (pandas-on-Spark: the pandas API, still distributed) or df.toPandas() (a local pandas frame on the driver)',
      ml: 'pyspark.ml — distributed: feature.VectorAssembler / StandardScaler / StringIndexer, clustering.KMeans, regression.LinearRegression, classification.LogisticRegression / RandomForestClassifier, Pipeline',
      guide: 'RULES FOR PYSPARK: modelling = pyspark.ml (distributed), not sklearn (needs toPandas(), single-node on the driver); stay in pyspark.sql column expressions (F.col / F.when / groupBy.agg / Window); avoid Python UDFs and row iteration (they serialize every row through Python), and collect() / toPandas() on a large frame; df.pandas_api() keeps pandas syntax distributed.',
      packagesNote: 'On PySpark prefer pyspark (pyspark.ml) over sklearn / scipy / statsmodels: those need toPandas(), single-node.',
      packages: ['pyspark'],
    };
  }
  if (runtime === 'snowflake') {
    return {
      key: 'snowpark',
      native: 'a Snowpark DataFrame — .filter / .with_column / .group_by / .select, functions via snowflake.snowpark.functions',
      pandas: 'df.to_pandas()',
      ml: 'snowflake.ml.modeling — the scikit-learn API run inside Snowflake: modeling.cluster.KMeans, modeling.linear_model.*, modeling.preprocessing.StandardScaler / OneHotEncoder, modeling.pipeline.Pipeline',
      guide: 'RULES FOR SNOWPARK: modelling = snowflake.ml.modeling (runs in the warehouse), not sklearn (needs to_pandas(), single-node); stay in Snowpark column expressions (F.col / F.when / group_by.agg / Window); avoid Python UDFs on rows and to_pandas() on a large frame.',
      packagesNote: 'On Snowpark prefer snowflake (snowflake.ml.modeling) over sklearn / scipy / statsmodels: those need to_pandas(), single-node.',
      packages: ['snowflake'],
    };
  }
  if (runtime === 'duckdb') {
    return {
      key: 'duckdb',
      native: 'a DuckDBPyRelation — .filter / .aggregate / .project / .select / .order with SQL expressions, executed by DuckDB',
      pandas: 'df.df()',
      ml: 'none in-engine — modelling goes through df.df() (pandas) and sklearn / scipy / statsmodels, fine for the local tables DuckDB holds',
      guide: 'RULES FOR DUCKDB: keep filters / aggregates in relation ops (SQL expressions) and convert with df.df() only for the modelling step.',
      packagesNote: '',
      packages: ['duckdb', 'pyarrow'],
    };
  }
  return { key: 'unknown', native: 'whatever dbt.ref() returns on this adapter', pandas: null, ml: null, guide: 'Use the platform\'s own DataFrame API and its in-engine ML library; avoid pulling the table into pandas.', packagesNote: '', packages: [] };
}

/**
 * Importable top-level packages → the pip name dbt must install (`packages` config), or null when
 * the runtime ships it (BigFrames / Dataproc / Snowpark runtimes carry pandas, numpy and
 * scikit-learn), plus the platform's own DataFrame package (from frameProfile). The operator
 * extends the list with MCP_PYTHON_PACKAGES: comma-separated `import_name` (preinstalled) or
 * `import_name=pip-name` (installed by dbt).
 */
export function importAllowlist(env = process.env, profile = null) {
  // `env` may be the resolved runtime (its `packages` string) or a real environment — one shape.
  if (env && typeof env.packages === 'string' && env.MCP_PYTHON_PACKAGES === undefined) env = { MCP_PYTHON_PACKAGES: env.packages };
  const allow = new Map([['pandas', null], ['numpy', null], ['sklearn', 'scikit-learn'], ['scipy', 'scipy'], ['statsmodels', 'statsmodels']]);
  for (const pkg of profile?.packages || []) allow.set(pkg, null);
  for (const raw of String(env.MCP_PYTHON_PACKAGES || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const [imp, pip] = item.split('=').map((s) => s.trim());
    if (IDENT.test(imp)) allow.set(imp, pip || null);
  }
  return allow;
}

/** A JSON value as a Python literal (the only way step arguments reach the code). */
export function pyLiteral(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return JSON.stringify(v); // a JSON string is a valid Python string literal
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(', ')}}`;
  return 'None';
}

const fail = (message) => { throw new Error(`python stage: ${message}`); };

/**
 * A function body is STRUCTURED, not a text blob: an array whose items are either one line of
 * code (a string, no leading whitespace, no newline) or a nested array — the block indented one
 * level under the line before it. Indentation is therefore expressed by nesting, exactly as
 * Python's grammar requires, and never by counting spaces inside strings:
 *   ["if k > 1:", ["df['segment'] = km.fit_predict(df[features])"], "else:", ["df['segment'] = 0"], "return df"]
 * Rules a Python parser would enforce later are enforced here, with the item's position:
 * a nested block must follow a header line (one ending with ':'), a header must be followed by a
 * nested block, a block is never empty. Returns the rendered lines (4 spaces per level).
 */
export function renderBody(body, at = 'body') {
  if (!Array.isArray(body) || !body.length) fail(`${at}: a function body is a non-empty array of lines and nested blocks`);
  const out = [];
  const walk = (items, depth, path) => {
    items.forEach((item, i) => {
      const here = `${path}[${i}]`;
      const prev = items[i - 1];
      if (Array.isArray(item)) {
        if (!item.length) fail(`${here}: an empty block — a nested array must hold at least one line`);
        if (typeof prev !== 'string' || !isHeader(prev)) fail(`${here}: a nested block must follow a line that opens it (ending with ':' — if/for/while/with/def/try/else…); the line before is ${prev === undefined ? 'missing' : JSON.stringify(prev)}`);
        walk(item, depth + 1, here);
        return;
      }
      if (typeof item !== 'string') fail(`${here}: a body item is a line of code (string) or a nested block (array)`);
      if (/[\r\n]/.test(item)) fail(`${here}: a line must not contain a newline — one array item per line`);
      if (/^\s/.test(item)) fail(`${here}: a line must not start with whitespace — indentation is expressed by nesting, not by spaces`);
      if (!item.trim()) fail(`${here}: an empty line — drop it`);
      if (isHeader(item) && !Array.isArray(items[i + 1])) fail(`${here}: ${JSON.stringify(item)} opens a block, so the next item must be a nested array with its body`);
      out.push(`${'    '.repeat(depth)}${item}`);
    });
  };
  walk(body, 0, at);
  return out;
}

/** Does this line open a block (ends with ':' before an optional trailing comment)? */
function isHeader(line) {
  return /:\s*(#.*)?$/.test(line) && !/^\s*#/.test(line);
}

/**
 * One import declaration → Python source line + the top-level package it needs.
 *   { package }                          → import package
 *   { package, submodule }               → import package.submodule
 *   { package, submodule?, as }          → import package[.submodule] as alias
 *   { package, submodule?, names: […] }  → from package[.submodule] import names
 * `package` is an enum in the tool schema (the allowlist), so a package outside it is refused by
 * the schema itself; this check only backs that up.
 */
function importLine(spec, i, allow) {
  const at = `imports[${i}]`;
  if (!spec || typeof spec !== 'object' || typeof spec.package !== 'string') fail(`${at}: an import is { package, submodule?, as? | names? }`);
  const { package: pkg, submodule, as, names } = spec;
  if (!allow.has(pkg)) fail(`${at}: '${pkg}' is not an allowed package. Allowed: ${[...allow.keys()].join(', ')} (the operator extends the list with MCP_PYTHON_PACKAGES)`);
  if (submodule != null && !MODULE.test(submodule)) fail(`${at}: submodule '${submodule}' is not a module path`);
  if (as != null && !IDENT.test(as)) fail(`${at}: alias '${as}' is not an identifier`);
  if (as != null && names) fail(`${at}: use either \`as\` (import … as) or \`names\` (from … import), not both`);
  const path = submodule ? `${pkg}.${submodule}` : pkg;
  if (names) {
    if (!Array.isArray(names) || !names.length || !names.every((n) => IDENT.test(n))) fail(`${at}: \`names\` must be a non-empty list of identifiers`);
    return { line: `from ${path} import ${names.join(', ')}`, top: pkg, binds: names };
  }
  return { line: `import ${path}${as ? ` as ${as}` : ''}`, top: pkg, binds: [as || pkg] };
}

/**
 * Compile the python stage into the dbt Python model file + YAML sidecar.
 *   stage — { stage: 'python', imports?, functions, steps, output?, description? }
 *   opts  — { modelName, prepModel, allow (Map), config? (operator's literal dbt.config extras), pipeline? (for the header) }
 * Returns { code, yml, packages, functions + bindings (for the gate), outputColumns, config }. Throws on a
 * structural problem (imports, names, arguments) — the static gate over the bodies is separate.
 */
export function compilePythonStage(stage, { modelName, inputModel, allow, config = {}, pipeline = null, profile = frameProfile(null), submission = null }) {
  const importLines = [];
  const packages = new Set();
  const bound = new Set();
  (stage.imports || []).forEach((spec, i) => {
    const { line, top, binds } = importLine(spec, i, allow);
    if (allow.get(top)) packages.add(allow.get(top));
    if (!importLines.includes(line)) importLines.push(line);
    binds.forEach((b) => bound.add(b));
  });

  const fns = stage.functions || [];
  if (!fns.length) fail('functions: declare at least one step function');
  const byName = new Map();
  fns.forEach((f, i) => {
    const at = `functions[${i}]`;
    if (!IDENT.test(f.name || '') || RESERVED.has(f.name)) fail(`${at}: name '${f.name}' is not a usable identifier`);
    if (byName.has(f.name)) fail(`${at}: function '${f.name}' is declared twice`);
    if (bound.has(f.name)) fail(`${at}: '${f.name}' collides with an import`);
    const params = f.params || [];
    if (!params.length) fail(`${at}: '${f.name}' needs at least one parameter — the frame it receives`);
    if (!params.every((p) => IDENT.test(p) && !KEYWORDS.has(p) && !['dbt', 'session'].includes(p) && p !== f.name)) fail(`${at}: parameters must be identifiers, not keywords or dbt/session (${params.join(', ')})`);
    if (new Set(params).size !== params.length) fail(`${at}: duplicate parameter`);
    const lines = renderBody(f.body, `${at}.body`);
    byName.set(f.name, { name: f.name, params, body: lines.join('\n') });
  });

  const steps = stage.steps || [];
  if (!steps.length) fail('steps: at least one step is required');
  const stepLines = steps.map((s, i) => {
    const at = `steps[${i}]`;
    const fn = byName.get(s.call);
    if (!fn) fail(`${at}: '${s.call}' is not a declared function. Declared: ${[...byName.keys()].join(', ')}`);
    const args = s.args || {};
    const [frameParam, ...rest] = fn.params;
    for (const k of Object.keys(args)) {
      if (k === frameParam) fail(`${at}: '${k}' is the frame parameter of '${s.call}' — it receives the previous step's result, not an argument`);
      if (!rest.includes(k)) fail(`${at}: '${s.call}' has no parameter '${k}'. Parameters: ${rest.join(', ') || '(none besides the frame)'}`);
    }
    const missing = rest.filter((p) => !(p in args));
    if (missing.length) fail(`${at}: '${s.call}' needs ${missing.map((m) => `'${m}'`).join(', ')}`);
    const kw = rest.map((p) => `${p}=${pyLiteral(args[p])}`).join(', ');
    return `    df = ${s.call}(df${kw ? `, ${kw}` : ''})`;
  });

  const outCols = stage.output?.columns || null;
  if (outCols) {
    if (!outCols.length || !outCols.every((c) => IDENT.test(c))) fail('output.columns: a non-empty list of column identifiers');
    if (new Set(outCols).size !== outCols.length) fail('output.columns: duplicate column');
  }

  // dbt.config takes literals only (the docs' contract): materialization + packages + the
  // SUBMISSION this server resolved + the operator's runtime extras — never the caller's.
  //
  // The submission is written HERE because dbt decides it from its own config, not from what this
  // server concluded: a profile that merely carries a method's settings (compute_region + a bucket,
  // no submission_method) leaves dbt on its default submission, so the model ran somewhere else
  // than every message said it would. Writing it down makes the two agree. The operator's
  // MCP_PYTHON_MODEL_CONFIG still wins — it is spread last.
  const cfg = {
    materialized: 'table',
    ...(packages.size ? { packages: [...packages].sort() } : {}),
    ...((submission || profile.submission) ? { submission_method: submission || profile.submission } : {}),
    ...config,
  };
  const cfgArgs = Object.entries(cfg).map(([k, v]) => `${k}=${pyLiteral(v)}`).join(', ');
  const header = yaml.dump({ pipeline: pipeline?.name || null, source: pipeline?.pipeline?.source || null, runtime: profile.key, python: { imports: stage.imports || [], steps, output: stage.output || null } }, { lineWidth: 100, noRefs: true, skipInvalid: true })
    .split('\n').filter(Boolean).map((l) => `#   ${l}`).join('\n');
  const fnSrc = [...byName.values()].map((f) => `def ${f.name}(${f.params.join(', ')}):\n${f.body.split('\n').map((l) => (l.trim() ? `    ${l}` : '')).join('\n')}\n`);

  // dbt.ref() IS the frame the first step receives — as the platform returns it, untouched — and
  // what the last step returns IS the model's result. Nothing is converted or projected here:
  // that is the functions' business, in the platform's own API.
  const refLine = `    df = dbt.ref(${pyLiteral(inputModel)})`;
  const returnLine = '    return df';
  const code = [
    '# Generated by bi-analytical-mcp (python stage) from config:',
    header,
    '',
    ...(importLines.length ? [...importLines, '', ''] : ['']),
    ...fnSrc.map((s) => `${s}\n`),
    'def model(dbt, session):',
    `    dbt.config(${cfgArgs})`,
    refLine,
    ...stepLines,
    returnLine,
    '',
  ].join('\n');

  const yml = yaml.dump({
    version: 2,
    models: [{
      name: modelName,
      // dbt renders a YAML description as Jinja: the caller's text goes in inert
      description: inertText(stage.description) || `Python stage of pipeline '${pipeline?.name || modelName}': ${steps.map((s) => s.call).join(' → ')} over ${inputModel}.`,
      ...(outCols ? { columns: outCols.map((c) => ({ name: c })) } : {}),
    }],
  }, { lineWidth: 100, noRefs: true });

  return { code, yml, packages: [...packages].sort(), functions: [...byName.values()], bindings: [...bound, ...byName.keys()], outputColumns: outCols, config: cfg, runtime: profile.key };
}

/**
 * A failed dbt run of a PYTHON model comes back as the warehouse runtime's own traceback, in which
 * the actionable part is one class name. This turns that class name into the fix — the same rules
 * the stage description carries, repeated where the author actually meets them. The rules are the
 * RUNTIME's (`profile.runHints`), so nothing here knows a platform: a runtime that declares none
 * stays silent, and adding one is a profile entry, not a branch in this function.
 */
export function pythonRunHints(profile, text) {
  const log = String(text || '');
  return (profile?.runHints || []).filter((h) => new RegExp(h.match, 'i').test(log)).map((h) => h.hint);
}

/**
 * Run the static gate over the declared functions with the given Python interpreter.
 * `bindings` are the names the declaration itself introduces — what its `imports` bound plus the
 * other declared functions — so the gate can allowlist the names a body may read instead of
 * chasing an open-ended list of the ones it may not.
 */
export function runAstGate(pythonBin, functions, bindings = [], { timeoutMs = 20000 } = {}) {
  // A build that shipped src/ without python/ used to surface as "python3 exit 2: can't open
  // file" — a message that reads like the analyst's code broke. Say what actually happened.
  const gate = assetPath('astGate');
  if (!gate) return Promise.reject(new Error(missingAssetMessage('astGate')));
  if (!pythonBin) return Promise.reject(new Error('ast gate has no Python to run on: the engine was given neither pythonBin nor a dbt environment (whose MetricFlow Python runs it) — nothing is taken from PATH'));
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [gate], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`ast gate timed out after ${timeoutMs}ms`)); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`ast gate could not start (${pythonBin}): ${e.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(`ast gate failed (${pythonBin} exit ${code}): ${err.trim()}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`ast gate returned no JSON: ${(out || err).slice(0, 300)}`)); }
    });
    proc.stdin.end(JSON.stringify({ functions, bindings: [...bindings] }));
  });
}

/** Columns after the python stage: the declared output, or (unknown additions) the incoming set. */
export function pythonStageColumns(cols, stage) {
  const out = stage.output?.columns;
  if (!out) return new Map(cols);
  return new Map(out.map((c) => [c, cols.get(c) || { type: 'unknown' }]));
}

/**
 * The structured body in the tool schema: ONE recursive definition — a block is an array whose
 * items are a line (string) or another block — referenced as `#/$defs/py_block`. The definition
 * itself lives at the ROOT of every tool schema that embeds a pipeline stage (schema.js hoists
 * `stageDefs()` there), because `$ref` resolves against the root of the document it sits in.
 * Recursion means no depth limit and no unrolled copies.
 */
const PY_LINE = { type: 'string', minLength: 1, maxLength: 500, pattern: '^\\S.*$', description: 'ONE line of Python — no leading whitespace and no newline; indentation comes from nesting.' };
export function pythonStageDefs() {
  return {
    py_block: {
      type: 'array', minItems: 1, maxItems: 400,
      description: 'A block of Python: an array where a string is one line of code and a nested array is the block indented one level under the line before it (which must end with ":").',
      items: { anyOf: [PY_LINE, { $ref: '#/$defs/py_block' }] },
    },
  };
}
function bodySchema(profile = frameProfile(null)) {
  return {
    $ref: '#/$defs/py_block',
    description: `The function body as STRUCTURE: an array where a string is one line of code and a nested array is the block indented under the line before it (which must end with ":" — if/for/else/with/try…); nesting is unbounded. Example: ["if k > 1:", ["df['seg'] = 1"], "else:", ["df['seg'] = 0"], "return df"]. THE FRAME: the first parameter is what dbt.ref() returns on THIS warehouse — ${profile.native} — passed along untouched from step to step; write the body against THAT API so the work stays in the warehouse engine. ${profile.ml ? `Modelling: ${profile.ml.split(' — ')[0]} (see the stage description for the classes and the do/don't rules). ` : ''}The RULES for this runtime — and the right form for each task — are on the stage description above; they apply to every line here. Nothing is converted for you${profile.pandas ? `: if a body truly needs pandas, it converts itself with ${profile.pandas} and owns the cost — single-node, the whole table in memory — so do it only on a small, already-aggregated table` : ''}. The frame the LAST step returns IS the model's result table, exactly as returned (no projection is added — return the columns you declare in output.columns). Must return the frame. A body may name only its own parameters and locals, what \`imports\` bound and the other declared functions, and may touch only public attributes — checked before anything runs, so an import inside, dbt/session, or a private/dunder attribute is refused with the line.`,
  };
}

function pythonStageSchema(allow = importAllowlist(), profile = frameProfile(null)) {
  const ID = '^[A-Za-z_][A-Za-z0-9_]*$';
  const MOD = '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$';
  const preinstalled = [...allow].filter(([, pip]) => !pip).map(([k]) => k);
  const installed = [...allow].filter(([, pip]) => pip).map(([k, pip]) => `${k} (dbt installs ${pip})`);
  // WHAT THIS DESCRIPTION IS FOR, and what it deliberately does NOT say (see the layering in
  // src/python-guide.js): the MECHANICS of the stage in this server — where it sits in the chain,
  // what the frame is, what the caller declares, what the server writes, the limits. What belongs
  // in a python stage at all, what this runtime's frame raises and the worked forms per move come
  // from ONE place, `profile.guide` (the compact rendering of the cookbook, recipe index
  // included), interpolated below. Restating any of it here is how the two start to disagree.
  return {
    type: 'object', additionalProperties: false, required: ['stage', 'functions', 'steps'],
    description: `PYTHON stage — a dbt PYTHON model of its own, allowed ANYWHERE in the pipeline and any number of times. The SQL stages before it land as a table it reads (as the first stage it reads the source directly); SQL stages after it read ITS table as the next model — dbt builds the chain in order, on the warehouse's Python runtime, never on the MCP host. The first step receives dbt.ref() of its input exactly as THIS warehouse returns it: ${profile.native}. Write the functions against THAT API; converting to pandas is a deliberate, single-node choice made inside a function, never done for you.${profile.ml ? ` MODELLING: ${profile.ml}${profile.mlReference ? ` — every class and its parameters: semantic_index({ recipe: "${profile.mlReference}" })` : (profile.mlClasses ? `: ${profile.mlClasses}` : '')}.` : ''} ${profile.guide} You declare imports (allowlisted), your own functions over the frame and the ordered steps; the server writes dbt.ref / dbt.config / return. The LAST step's return value is this model's table — declare output.columns for the SQL stages after it. Bodies pass a static allowlist first (own names + declared imports + public attributes). SIZE: 30 functions, 400 body lines each, 500 chars per line, 50 steps, 20 imports — a real analysis fits, so a refusal is never about size. Read the result with query_pipeline_model as usual.`,
    properties: {
      stage: { enum: ['python'] },
      description: { type: 'string', maxLength: 2000, description: 'What the stage computes (goes to the dbt YAML sidecar).' },
      imports: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['package'],
          properties: {
            package: { enum: [...allow.keys()], description: `The ONLY packages a function may use. Shipped by the runtime: ${preinstalled.join(', ')}.${installed.length ? ` Installed by dbt on demand: ${installed.join(', ')}.` : ''}${profile.packagesNote ? ` ${profile.packagesNote}` : ''} The operator extends this list with MCP_PYTHON_PACKAGES.` },
            submodule: { type: 'string', pattern: MOD, description: 'Optional dotted path inside the package: { package: "sklearn", submodule: "cluster" } → import sklearn.cluster.' },
            as: { type: 'string', pattern: ID, description: 'Alias: import … as <as>. Not together with `names`.' },
            names: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'from … import <names>. Not together with `as`.' },
          },
        },
        description: 'Modules the functions use — each names one allowlisted `package` (the enum is the whole allowlist; the platform\'s own DataFrame package is in it). Packages the runtime lacks go to dbt\'s `packages` config for dbt to install.',
      },
      functions: {
        type: 'array', minItems: 1, maxItems: 30,
        items: { type: 'object', additionalProperties: false, required: ['name', 'params', 'body'], properties: {
          name: { type: 'string', pattern: ID },
          params: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'The FIRST parameter is the frame the step receives; the rest are named arguments a step passes.' },
          body: bodySchema(profile),
        } },
        description: 'Your step functions — they live in this model only (dbt cannot import helper .py files between models).',
      },
      steps: {
        type: 'array', minItems: 1, maxItems: 50,
        items: { type: 'object', additionalProperties: false, required: ['call'], properties: {
          call: { type: 'string', pattern: ID, description: 'A declared function name.' },
          args: { type: 'object', description: 'Named arguments (JSON literals) for the function\'s parameters after the frame.' },
        } },
        description: 'Ordered calls: df = f1(df, …); df = f2(df, …), starting from the table the SQL stages produced.',
      },
      output: { type: 'object', additionalProperties: false, properties: { columns: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'The columns the LAST step returns — this model\'s columns: what SQL stages after it may reference, the dbt YAML sidecar, the tool response. Make the last function return exactly these; nothing is projected for you. Omitted → the input\'s columns are assumed unchanged.' } } },
    },
  };
}

// Registered like every other stage, so it is valid in build_pipeline_model (add_step) and
// register_native_model alike; the engine splits the pipeline at it. `terminal` = nothing may
// follow. `build` validates the structure (imports / names / arguments) against a placeholder
// ref; the body gate and the real names are the engine's part.
registerStage('python', {
  // The DESCRIPTION also names this deployment's worked recipes for a python stage (the engine
  // puts their ids on the catalog): the caller must know they exist before writing a function.
  schema: (catalog) => { const rt = catalog?.pythonRuntime; const pr = frameProfile({ ...rt, recipes: catalog?.pythonRecipes || [] }, rt?.config || {}); return pythonStageSchema(importAllowlist(rt || process.env, pr), pr); },
  defs: () => pythonStageDefs(), // hoisted to the root of every tool schema embedding stages
  // Offered only where dbt can run Python models (the profile's adapter + its submission settings,
  // see resolvePythonRuntime); elsewhere the stage is absent from the schemas and refused here.
  available: (catalog) => catalog?.pythonRuntime?.available !== false,
  unavailableReason: (catalog) => `the python stage is not available: ${catalog?.pythonRuntime?.reason || 'dbt cannot run Python models on this profile'}. Fix the dbt profile (or set MCP_PYTHON_MODELS=on when the submission is configured per model) and restart the server.`,
  python: true, // the renderer cuts the chain here: this stage is a dbt model of its own
  build: ({ cols, catalog }, st) => {
    const rt = catalog?.pythonRuntime;
    const pr = frameProfile(rt, rt?.config || {});
    compilePythonStage(st, { modelName: 'm', inputModel: 'm_in', allow: importAllowlist(rt || process.env, pr), config: rt?.config || {}, profile: pr, submission: rt?.method || null });
    return { op: { op: 'python', python: true, stage: st }, cols: pythonStageColumns(cols, st) };
  },
});
