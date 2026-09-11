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
const RESERVED = new Set([...KEYWORDS, 'model', 'dbt', 'session', 'pd', '_frame', 'df']);

/**
 * Importable top-level packages → the pip name dbt must install (`packages` config), or null when
 * the runtime ships it (BigFrames / Dataproc / Snowpark runtimes carry pandas, numpy and
 * scikit-learn). The operator extends the list with MCP_PYTHON_PACKAGES: comma-separated
 * `import_name` (preinstalled) or `import_name=pip-name` (installed by dbt).
 */
export function importAllowlist(env = process.env) {
  const allow = new Map([['pandas', null], ['numpy', null], ['sklearn', 'scikit-learn'], ['scipy', 'scipy'], ['statsmodels', 'statsmodels'], ['bigframes', null]]);
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

/** One import declaration → Python source line + the top-level package it needs. */
function importLine(spec, i) {
  const at = `imports[${i}]`;
  if (typeof spec === 'string') {
    if (!MODULE.test(spec)) fail(`${at}: '${spec}' is not a module path`);
    return { line: `import ${spec}`, top: spec.split('.')[0], binds: [spec.split('.')[0]] };
  }
  if (spec && typeof spec === 'object') {
    if (spec.from) {
      if (!MODULE.test(spec.from)) fail(`${at}: '${spec.from}' is not a module path`);
      const names = Array.isArray(spec.names) ? spec.names : [];
      if (!names.length || !names.every((n) => IDENT.test(n))) fail(`${at}: 'from ${spec.from} import …' needs identifiers in \`names\``);
      return { line: `from ${spec.from} import ${names.join(', ')}`, top: spec.from.split('.')[0], binds: names };
    }
    if (spec.module) {
      if (!MODULE.test(spec.module)) fail(`${at}: '${spec.module}' is not a module path`);
      if (spec.as && !IDENT.test(spec.as)) fail(`${at}: alias '${spec.as}' is not an identifier`);
      return { line: `import ${spec.module}${spec.as ? ` as ${spec.as}` : ''}`, top: spec.module.split('.')[0], binds: [spec.as || spec.module.split('.')[0]] };
    }
  }
  return fail(`${at}: an import is "module.path", { module, as } or { from, names }`);
}

/**
 * Compile the python stage into the dbt Python model file + YAML sidecar.
 *   stage — { stage: 'python', imports?, functions, steps, output?, description? }
 *   opts  — { modelName, prepModel, allow (Map), config? (operator's literal dbt.config extras), pipeline? (for the header) }
 * Returns { code, yml, packages, functions (for the gate), outputColumns, config }. Throws on a
 * structural problem (imports, names, arguments) — the static gate over the bodies is separate.
 */
export function compilePythonStage(stage, { modelName, prepModel, allow, config = {}, pipeline = null }) {
  const importLines = ['import pandas as pd'];
  const packages = new Set();
  const bound = new Set(['pd']);
  (stage.imports || []).forEach((spec, i) => {
    const { line, top, binds } = importLine(spec, i);
    if (!allow.has(top)) fail(`imports[${i}]: '${top}' is not an allowed package. Allowed: ${[...allow.keys()].join(', ')} (the operator extends the list with MCP_PYTHON_PACKAGES)`);
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
    if (typeof f.body !== 'string' || !f.body.trim()) fail(`${at}: '${f.name}' has an empty body`);
    byName.set(f.name, { name: f.name, params, body: f.body });
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
  const header = yaml.dump({ pipeline: pipeline?.name || null, source: pipeline?.pipeline?.source || null, python: { imports: stage.imports || [], steps, output: stage.output || null } }, { lineWidth: 100, noRefs: true, skipInvalid: true })
    .split('\n').filter(Boolean).map((l) => `#   ${l}`).join('\n');
  const fnSrc = [...byName.values()].map((f) => `def ${f.name}(${f.params.join(', ')}):\n${f.body.split('\n').map((l) => (l.trim() ? `    ${l}` : '')).join('\n')}\n`);

  const code = [
    '# Generated by bi-analytical-mcp (python stage) from config:',
    header,
    '',
    ...importLines,
    '',
    '',
    'def _frame(rel):',
    '    """Whatever this runtime returns from dbt.ref() → a pandas frame (BigFrames / Snowpark .to_pandas, PySpark .toPandas, DuckDB .df)."""',
    "    for m in ('to_pandas', 'toPandas', 'df', 'to_df'):",
    '        f = getattr(rel, m, None)',
    '        if callable(f):',
    '            return f()',
    '    return rel',
    '',
    '',
    ...fnSrc.map((s) => `${s}\n`),
    'def model(dbt, session):',
    `    dbt.config(${cfgArgs})`,
    `    df = _frame(dbt.ref(${pyLiteral(prepModel)}))`,
    ...stepLines,
    outCols ? `    return df[${pyLiteral(outCols)}]` : '    return df',
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

  return { code, yml, packages: [...packages].sort(), functions: [...byName.values()], outputColumns: outCols, config: cfg };
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

function pythonStageSchema() {
  const ID = '^[A-Za-z_][A-Za-z0-9_]*$';
  return {
    type: 'object', additionalProperties: false, required: ['stage', 'functions', 'steps'],
    description: 'PYTHON stage — must be the LAST stage. Everything before it lands as a table in the warehouse; this stage becomes a dbt PYTHON model that reads that table and runs on the warehouse\'s Python runtime (BigQuery BigFrames/Dataproc, Snowpark, PySpark) — never on the MCP host. For what SQL cannot do: statistics, clustering, scoring, forecasting. Declare imports (allowlisted), your own functions (plain Python over a pandas frame: def f(df, …) → return frame) and the ordered steps calling them; dbt.ref / dbt.config / return are written by the server. Bodies are statically gated first. The pipeline\'s model is the result table — read it with get_query_result as usual.',
    properties: {
      stage: { const: 'python' },
      description: { type: 'string', maxLength: 2000, description: 'What the stage computes (goes to the dbt YAML sidecar).' },
      imports: {
        type: 'array', maxItems: 20,
        items: { oneOf: [
          { type: 'string', description: '"module.path" → import module.path' },
          { type: 'object', additionalProperties: false, required: ['module'], properties: { module: { type: 'string' }, as: { type: 'string', pattern: ID } } },
          { type: 'object', additionalProperties: false, required: ['from', 'names'], properties: { from: { type: 'string' }, names: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID } } } },
        ] },
        description: 'Modules the functions use. Only allowlisted top-level packages (pandas, numpy, sklearn, scipy, statsmodels, bigframes + the operator\'s MCP_PYTHON_PACKAGES); pandas is always imported as pd. Packages the runtime lacks go to dbt\'s `packages` config for dbt to install.',
      },
      functions: {
        type: 'array', minItems: 1, maxItems: 30,
        items: { type: 'object', additionalProperties: false, required: ['name', 'params', 'body'], properties: {
          name: { type: 'string', pattern: ID },
          params: { type: 'array', minItems: 1, items: { type: 'string', pattern: ID }, description: 'The FIRST parameter is the frame the step receives; the rest are named arguments a step passes.' },
          body: { type: 'string', minLength: 1, maxLength: 20000, description: 'The function body (plain Python over pandas/numpy/…; must return the frame). No imports inside (declare them in `imports`), no dbt/session access, no exec/eval/open/dunder access — checked before anything runs.' },
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
  schema: () => pythonStageSchema(),
  terminal: true,
  build: ({ cols }, st) => {
    compilePythonStage(st, { modelName: 'm', prepModel: 'm_prep', allow: importAllowlist(), config: {} });
    return { op: { op: 'python', python: true, stage: st }, cols: pythonStageColumns(cols, st) };
  },
});
