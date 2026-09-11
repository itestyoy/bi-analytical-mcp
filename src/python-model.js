// The `python` PIPELINE STAGE — a dbt PYTHON model as the last stage of a native pipeline.
//
// One declaration, two dbt models under the hood: every SQL stage before `python` lands as a
// TABLE (`pipe_<name>_<ctx>_prep`), and the python stage becomes the one `.py` file dbt expects
// (`def model(dbt, session)`, `pipe_<name>_<ctx>`) that reads it through `dbt.ref`. dbt then runs
// the Python model on the warehouse's own Python runtime (BigQuery: BigFrames / Dataproc;
// Snowflake: Snowpark; Databricks: PySpark; DuckDB locally) — nothing executes on the MCP host,
// and the caller never sees two names: the pipeline's model IS the Python model's table.
//
// What the caller writes in the stage: the imports it needs (from the server's allowlist), its
// own functions (plain Python over a pandas frame) and the steps calling them in order. What the
// caller never writes: `dbt.ref` (the prep table is the one input), `dbt.config` (materialization,
// packages and the operator's runtime settings) and the final `return` (from `output.columns`).
// Function bodies pass a static gate (python/ast_gate.py) before anything is written or run.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { registerStage } from './pipeline.js';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'ast_gate.py');
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// Python keywords (no identifier may be one) + the names the generated file reserves for its own
// top level (a FUNCTION may not take them; a parameter is local to its function and may be `df`).
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const RESERVED = new Set([...KEYWORDS, 'model', 'dbt', 'session', 'pd', 'df']);

/**
 * What `dbt.ref()` hands the model on THIS warehouse, and how the two frame modes are spelled —
 * exactly as dbt's own docs do per platform. `native` (the default) keeps the platform's
 * DataFrame: BigFrames (the pandas API, computed inside BigQuery), Snowpark, PySpark, a DuckDB
 * relation. `pandas` is the explicit opt-in the docs describe: `.to_pandas()` on Snowpark and
 * BigFrames, pandas-on-Spark (`.pandas_api()`, still distributed) on PySpark, `.df()` on DuckDB.
 * The submission method may also come from the operator's per-model config.
 */
export function frameProfile(rt, config = {}) {
  const runtime = String(rt?.runtime || '').toLowerCase();
  const method = String(config.submission_method || rt?.method || '').toLowerCase();
  if (runtime === 'bigquery' && (method === 'bigframes' || !method)) {
    return { key: 'bigframes', native: 'a BigFrames DataFrame (bigframes.pandas — the pandas API, computed inside BigQuery; import bigframes.pandas as bpd for constructors)', toPandas: '.to_pandas()', pandasNote: 'pulls the table into the notebook runtime as an in-memory pandas frame', select: 'pandas', packages: ['bigframes'] };
  }
  if (runtime === 'bigquery' || runtime === 'databricks') {
    return { key: 'pyspark', native: 'a PySpark DataFrame (pyspark.sql: .filter / .withColumn / .groupBy, functions via pyspark.sql.functions)', toPandas: '.pandas_api()', pandasNote: 'pandas-on-Spark — the pandas API, still distributed', select: 'select', packages: ['pyspark'] };
  }
  if (runtime === 'snowflake') {
    return { key: 'snowpark', native: 'a Snowpark DataFrame (.filter / .with_column / .group_by, functions via snowflake.snowpark.functions)', toPandas: '.to_pandas()', pandasNote: 'pulls the table into the warehouse\'s Python runtime as an in-memory pandas frame', select: 'select', packages: ['snowflake'] };
  }
  if (runtime === 'duckdb') {
    return { key: 'duckdb', native: 'a DuckDBPyRelation (.filter / .aggregate / .project with SQL expressions)', toPandas: '.df()', pandasNote: 'an in-memory pandas frame', select: 'select', packages: ['duckdb', 'pyarrow'] };
  }
  return { key: 'unknown', native: 'whatever dbt.ref() returns on this adapter', toPandas: null, pandasNote: null, select: 'pandas', packages: [] };
}

/**
 * Importable top-level packages → the pip name dbt must install (`packages` config), or null when
 * the runtime ships it (BigFrames / Dataproc / Snowpark runtimes carry pandas, numpy and
 * scikit-learn), plus the platform's own DataFrame package (from frameProfile). The operator
 * extends the list with MCP_PYTHON_PACKAGES: comma-separated `import_name` (preinstalled) or
 * `import_name=pip-name` (installed by dbt).
 */
export function importAllowlist(env = process.env, profile = null) {
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
 * Returns { code, yml, packages, functions (for the gate), outputColumns, config }. Throws on a
 * structural problem (imports, names, arguments) — the static gate over the bodies is separate.
 */
export function compilePythonStage(stage, { modelName, prepModel, allow, config = {}, pipeline = null, profile = frameProfile(null) }) {
  // The frame the steps work on: the platform's native DataFrame (default) or, on explicit
  // request, pandas — spelled per platform as dbt's docs do (frameProfile).
  const frame = stage.frame || 'native';
  if (frame === 'pandas' && !profile.toPandas) fail(`frame: 'pandas' is not available — the runtime is unknown here, so the conversion cannot be written. Configure the dbt profile (or use frame: 'native').`);
  const importLines = frame === 'pandas' ? ['import pandas as pd'] : [];
  const packages = new Set();
  const bound = new Set(frame === 'pandas' ? ['pd'] : []);
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
  // operator's runtime extras (submission method etc.) — never the caller's.
  const cfg = { materialized: 'table', ...(packages.size ? { packages: [...packages].sort() } : {}), ...config };
  const cfgArgs = Object.entries(cfg).map(([k, v]) => `${k}=${pyLiteral(v)}`).join(', ');
  const header = yaml.dump({ pipeline: pipeline?.name || null, source: pipeline?.pipeline?.source || null, runtime: profile.key, python: { frame, imports: stage.imports || [], steps, output: stage.output || null } }, { lineWidth: 100, noRefs: true, skipInvalid: true })
    .split('\n').filter(Boolean).map((l) => `#   ${l}`).join('\n');
  const fnSrc = [...byName.values()].map((f) => `def ${f.name}(${f.params.join(', ')}):\n${f.body.split('\n').map((l) => (l.trim() ? `    ${l}` : '')).join('\n')}\n`);

  // dbt.ref() IS the frame: native stays as the platform returns it; pandas converts as the
  // platform's docs spell it. The final projection follows the frame's API.
  const refLine = `    df = dbt.ref(${pyLiteral(prepModel)})${frame === 'pandas' ? profile.toPandas : ''}`;
  const pandasStyle = frame === 'pandas' || profile.select === 'pandas';
  const returnLine = !outCols ? '    return df' : (pandasStyle ? `    return df[${pyLiteral(outCols)}]` : `    return df.select(${outCols.map(pyLiteral).join(', ')})`);
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
      description: stage.description || `Python stage of pipeline '${pipeline?.name || modelName}': ${steps.map((s) => s.call).join(' → ')} over ${prepModel}.`,
      ...(outCols ? { columns: outCols.map((c) => ({ name: c })) } : {}),
    }],
  }, { lineWidth: 100, noRefs: true });

  return { code, yml, packages: [...packages].sort(), functions: [...byName.values()], outputColumns: outCols, config: cfg, frame, runtime: profile.key };
}

/** The operator's literal dbt.config extras (MCP_PYTHON_MODEL_CONFIG) — also decide the frame profile. */
export function pythonModelConfigFromEnv(env = process.env) {
  try { return JSON.parse(env.MCP_PYTHON_MODEL_CONFIG || '{}'); } catch { return {}; }
}

/** Run the static gate over the declared functions with the given Python interpreter. */
export function runAstGate(pythonBin, functions, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [GATE], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    proc.stdin.end(JSON.stringify({ functions }));
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
function bodySchema() {
  return {
    $ref: '#/$defs/py_block',
    description: 'The function body as STRUCTURE: an array where a string is one line of code and a nested array is the block indented under the line before it (which must end with ":" — if/for/else/with/try…); nesting is unbounded. Example: ["if k > 1:", ["df[\'seg\'] = 1"], "else:", ["df[\'seg\'] = 0"], "return df"]. Plain Python over pandas/numpy/… on the frame the first parameter receives; must return the frame. No imports inside (declare them in `imports`), no dbt/session access, no exec/eval/open/dunder access — checked before anything runs.',
  };
}

function pythonStageSchema(allow = importAllowlist(), profile = frameProfile(null)) {
  const ID = '^[A-Za-z_][A-Za-z0-9_]*$';
  const MOD = '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$';
  const preinstalled = [...allow].filter(([, pip]) => !pip).map(([k]) => k);
  const installed = [...allow].filter(([, pip]) => pip).map(([k, pip]) => `${k} (dbt installs ${pip})`);
  return {
    type: 'object', additionalProperties: false, required: ['stage', 'functions', 'steps'],
    description: 'PYTHON stage — must be the LAST stage. Everything before it lands as a table in the warehouse; this stage becomes a dbt PYTHON model that reads that table and runs on the warehouse\'s Python runtime (BigQuery BigFrames/Dataproc, Snowpark, PySpark) — never on the MCP host. For what SQL cannot do: statistics, clustering, scoring, forecasting. Declare imports (allowlisted), your own functions (plain Python over a pandas frame: def f(df, …) → return frame) and the ordered steps calling them; dbt.ref / dbt.config / return are written by the server. Bodies are statically gated first. The pipeline\'s model is the result table — read it with get_query_result as usual.',
    properties: {
      stage: { const: 'python' },
      description: { type: 'string', maxLength: 2000, description: 'What the stage computes (goes to the dbt YAML sidecar).' },
      frame: {
        enum: profile.toPandas ? ['native', 'pandas'] : ['native'], default: 'native',
        description: `What the first step receives. native (default): dbt.ref() as this warehouse returns it — ${profile.native}; write the functions against THAT API, the work stays in the warehouse engine. pandas: the explicit opt-in dbt's docs describe — the server appends ${profile.toPandas || '(unavailable here)'} to dbt.ref()${profile.pandasNote ? ` (${profile.pandasNote})` : ''}; use it for scikit-learn / scipy / statsmodels over an already-aggregated table, and mind that it is single-node.`,
      },
      imports: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['package'],
          properties: {
            package: { enum: [...allow.keys()], description: `The ONLY packages a function may use. Shipped by the runtime: ${preinstalled.join(', ')}.${installed.length ? ` Installed by dbt on demand: ${installed.join(', ')}.` : ''} The operator extends this list with MCP_PYTHON_PACKAGES.` },
            submodule: { type: 'string', pattern: MOD, description: 'Optional dotted path inside the package: { package: "sklearn", submodule: "cluster" } → import sklearn.cluster.' },
            as: { type: 'string', pattern: ID, description: 'Alias: import … as <as>. Not together with `names`.' },
            names: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'from … import <names>. Not together with `as`.' },
          },
        },
        description: 'Modules the functions use — each names one allowlisted `package` (the enum is the whole allowlist). With frame: pandas, pandas is imported as pd for you. Packages the runtime lacks go to dbt\'s `packages` config for dbt to install.',
      },
      functions: {
        type: 'array', minItems: 1, maxItems: 30,
        items: { type: 'object', additionalProperties: false, required: ['name', 'params', 'body'], properties: {
          name: { type: 'string', pattern: ID },
          params: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'The FIRST parameter is the frame the step receives; the rest are named arguments a step passes.' },
          body: bodySchema(),
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
      output: { type: 'object', additionalProperties: false, properties: { columns: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'Columns the model returns (the result table\'s columns); omitted → whatever the last step produced.' } } },
    },
  };
}

// Registered like every other stage, so it is valid in build_native_model (add_step) and
// register_native_model alike; the engine splits the pipeline at it. `terminal` = nothing may
// follow. `build` validates the structure (imports / names / arguments) against a placeholder
// ref; the body gate and the real names are the engine's part.
registerStage('python', {
  schema: (catalog) => { const pr = frameProfile(catalog?.pythonRuntime, pythonModelConfigFromEnv()); return pythonStageSchema(importAllowlist(process.env, pr), pr); },
  defs: () => pythonStageDefs(), // hoisted to the root of every tool schema embedding stages
  // Offered only where dbt can run Python models (the profile's adapter + its submission settings,
  // see resolvePythonRuntime); elsewhere the stage is absent from the schemas and refused here.
  available: (catalog) => catalog?.pythonRuntime?.available !== false,
  unavailableReason: (catalog) => `the python stage is not available: ${catalog?.pythonRuntime?.reason || 'dbt cannot run Python models on this profile'}. Fix the dbt profile (or set MCP_PYTHON_MODELS=on when the submission is configured per model) and restart the server.`,
  terminal: true,
  build: ({ cols, catalog }, st) => {
    const pr = frameProfile(catalog?.pythonRuntime, pythonModelConfigFromEnv());
    compilePythonStage(st, { modelName: 'm', prepModel: 'm_prep', allow: importAllowlist(process.env, pr), config: {}, profile: pr });
    return { op: { op: 'python', python: true, stage: st }, cols: pythonStageColumns(cols, st) };
  },
});
