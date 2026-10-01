// EVERY SETTING THE SERVER READS FROM ITS ENVIRONMENT — one table: each variable's name, its kind (how
// it is read, src/config.js), its default and what it is for. `.env.example` is rendered from it
// (`npm run settings:example`), and test/unit/settings.test.js holds the table to that file and to
// every variable src/ reads — a variable read anywhere is a row here, and a row is read somewhere.
//
//   kind   flag | number | int | string | list (comma-separated) — read by `setting(name)`;
//          raw — the value as it is, for a reader that parses it itself (a JSON object, on/off/unset);
//          compose — read by docker compose on the host, never by the server;
//          profile — read by profiles.yml through env_var(), never by the server
//   example  the line .env.example sets (a value compose passes on); without it the line shows the
//            default, commented out

import { envFlag, envNumber, envInt, envString } from './config.js';

const S = (name, kind, doc, extra = {}) => ({ name, kind, doc, ...extra });

export const SETTING_GROUPS = [
  ['docker compose (host side)', [
    S('PORT', 'int', 'Host port the server is published on.', { default: 3000, min: 1, example: '3000' }),
    S('DBT_PROJECT_DIR', 'compose', 'YOUR dbt project on the host (it must contain profiles.yml), mounted at /dbt_project.', { example: './dbt_project' }),
    S('CONFIG_DIR', 'compose', 'Catalog / recipes on the host, mounted at /config.', { example: './config' }),
  ]],
  ['server and HTTP', [
    S('HOST', 'string', 'Address to listen on. Default 127.0.0.1; the image and compose set 0.0.0.0.', { default: '127.0.0.1', shown: '0.0.0.0' }),
    S('MCP_ALLOWED_ORIGINS', 'list', 'Hostnames of browser pages allowed to call the server, comma-separated (loopback always is).', { default: [] }),
    S('MCP_ALLOWED_HOSTS', 'list', 'Allowed Host header values, comma-separated. Empty: no Host check.', { default: [] }),
    S('MCP_PROGRESS_INTERVAL_MS', 'number', 'How often a long call sends progress to the client (ms). 0: no progress notifications.', { default: 5000 }),
    S('MCP_TASK_AFTER_MS', 'number', 'After how long a waiting call becomes a protocol task (ms; clients with the Tasks extension). 0: at once.', { default: 3000 }),
    S('MCP_TASK_TTL_SECONDS', 'number', 'How long a protocol task is kept (seconds).', { default: 3600, min: 1 }),
    S('MCP_SESSION_IDLE_SECONDS', 'number', 'A 2025 client\'s session unused for this long is closed (seconds); the client then initializes again.', { default: 86400, min: 1 }),
  ]],
  ['dbt project and catalog', [
    S('DBT_BASE_PROJECT', 'string', 'Inside the container: the dbt project and the folder with profiles.yml (set by compose).', { shown: '/dbt_project' }),
    S('DBT_PROFILES_DIR', 'string', null, { shown: '/dbt_project' }),
    S('DBT_TARGET', 'string', 'The profile output to use. Default: the profile\'s own `target:`.'),
    S('CATALOG_PATH', 'string', 'A standalone catalog file. Default: read from the dbt project (meta.mcp.role), else config/catalog.yml.', { shown: '/config/catalog.yml' }),
    S('RECIPES_PATH', 'string', 'Your recipes, comma-separated; added to the shipped ones (yours win an id collision).\nDefault empty; compose sets /config/recipes.json.', { default: '', shown: '/config/recipes.json' }),
    S('WAREHOUSE_DIALECT', 'string', 'duckdb | bigquery. Default: the profile\'s output type, else duckdb.', { example: 'duckdb' }),
    S('SKIP_PROJECT_VALIDATION', 'flag', '1: skip the start-up check that the project has the models / macros the server needs.', { default: false, shown: '' }),
    S('MCP_GROUND_CATALOG', 'flag', 'false: do not check the catalog against the real tables at start.', { default: true }),
    S('MCP_REQUIRE_TIME_RANGE', 'flag', '1: refuse queries without a time window; 0: allow them. Default: the catalog decides\n(meta.mcp.require_time_range).', { shown: '' }),
  ]],
  ['dbt and MetricFlow environments', [
    S('DBT_ENVS_DIR', 'string', 'Where the environments live. Default ./.venvs; the image sets /opt/dbt-envs.', { shown: '/opt/dbt-envs' }),
    S('DBT_ENV', 'string', 'The dbt environment: dbt-v2 | dbt-v1 (dbt-v1 runs the python stage on DuckDB).', { default: 'dbt-v2', example: 'dbt-v2' }),
    S('MF_ENV', 'string', 'The MetricFlow environment.', { default: 'metricflow' }),
    S('DBT_VERSION', 'string', 'Pin dbt\'s major version (1 | 2) instead of reading it from the binary.', { default: 'auto' }),
    S('DBT_TIMEOUT_SECONDS', 'number', 'Timeout of one dbt process (seconds). Retentioneering\'s own default is 3600.', { default: 600, min: 1 }),
    S('QUERY_TIMEOUT_SECONDS', 'raw', 'How long a short warehouse read (column set, freshness) may hold a call (seconds, max 30).\nQueries and builds never hold one: they are tasks.', { default: '20', example: '20' }),
    S('DBT_TIMING_LOG', 'string', 'A file to append one JSON line per dbt process to: how long it waited for its turn, how long it ran.', { shown: '' }),
  ]],
  ['store, contexts, error log', [
    S('MCP_WORKSPACE', 'string', 'The contexts\' working folder. Default ./.mcp/ctx; the image sets /workspace.', { shown: '/workspace' }),
    S('MCP_DB', 'string', 'The SQLite file: tasks, value index, memory, error log. Default <MCP_WORKSPACE>/mcp.sqlite.', { example: '/workspace/mcp.sqlite' }),
    S('MCP_MEMORY_DB', 'string', 'A file of its own for the memory tool. Default: the shared MCP_DB.', { example: '/workspace/memory.sqlite' }),
    S('MCP_DB_BACKEND', 'string', 'sqlite | memory.', { default: 'sqlite' }),
    S('MCP_DB_RESET', 'flag', 'true: wipe the store at start (memory and the error log are kept).', { default: false, example: 'false' }),
    S('CONTEXT_TTL_MS', 'number', 'Drop contexts idle for longer than this (ms). 0: never.', { default: 0, example: '0' }),
    S('MCP_TABLE_EXPIRATION_DAYS', 'int', 'Tables built for tasks on BigQuery expire this many days after they are built. 0: keep them.', { default: 30 }),
    S('MCP_ERROR_RETENTION_DAYS', 'int', 'How long the error log keeps a failure (days), and at most how many it keeps.', { default: 30 }),
    S('MCP_ERROR_MAX_ROWS', 'int', null, { default: 10000 }),
  ]],
  ['value index (background profiling of values)', [
    S('VALUE_INDEX_REFRESH_MS', 'number', 'How often to re-index (ms). 0: one pass at start, no schedule. Default 6 hours.', { default: 21600000 }),
    S('VALUE_INDEX_MAX_VALUES', 'int', 'Top values kept per property.', { default: 50, min: 1 }),
    S('MCP_INDEX_BATCH', 'int', 'Properties scanned per query.', { default: 40, min: 1 }),
    S('MCP_INDEX_WINDOW_DAYS', 'number', 'Scan only the last N days. 0: the whole history.', { default: 0 }),
    S('MCP_INDEX_TIMEOUT_SECONDS', 'number', 'Timeout of one scan (seconds).', { default: 7200, min: 1 }),
    S('MCP_INDEX_MERGE', 'flag', 'Re-scan only rows newer than what is indexed and add them up. Turned off by MCP_INDEX_WINDOW_DAYS.', { default: true }),
    S('MCP_INDEX_APPROX_DISTINCT', 'flag', 'Approximate distinct counts.', { default: true }),
    S('MCP_INDEX_HIGH_CARD_PCT', 'number', 'A field whose distinct values are at least this % of its rows is ID-like: its values are not kept.\n0: no such check.', { default: 90 }),
    S('MCP_INDEX_DBT_RUN', 'flag', '`dbt run` the source models before indexing them. false when an external scheduler builds them.', { default: true }),
    S('MCP_INDEX_DBT_RUN_SELECT', 'string', 'The selector of that dbt run. Default: every catalog source model.', { shown: '' }),
  ]],
  ['python pipeline stage', [
    S('MCP_PYTHON_MODELS', 'raw', 'on: offer the stage, the operator configures its runtime; off: hide it. Default: the profile decides.', { shown: '' }),
    S('MCP_PYTHON_MODEL_CONFIG', 'raw', 'JSON of dbt python-model config (runtime, timeout, …); wins over what is read from the profile.', { shown: '{}' }),
    S('MCP_PYTHON_PACKAGES', 'raw', 'More allowed imports, comma-separated: import_name (preinstalled) or import_name=pip-name.', { shown: '' }),
  ]],
  ['path analysis (retentioneering)', [
    S('MCP_RETENTIONEERING', 'flag', 'on: switch the feature on. Off, none of it exists.', { default: false, shown: 'on' }),
    S('MCP_RETENTIONEERING_ENV', 'string', 'Its environment.', { default: 'retentioneering' }),
    S('MCP_RETENTIONEERING_MODEL_CONFIG', 'raw', 'JSON of extra dbt config for its python model (on BigQuery: the runtime template, a timeout).', { shown: '{"notebook_template_id": "<template id>", "timeout": 3600}' }),
  ]],
  ['memory search by meaning', [
    S('MEMORY_EMBEDDINGS', 'string', 'openai: search memory by meaning. Unset: fuzzy search only.', { shown: 'openai' }),
    S('OPENAI_API_KEY', 'string', 'Required with MEMORY_EMBEDDINGS=openai.', { shown: '' }),
    S('OPENAI_EMBEDDING_MODEL', 'string', 'The embedding model.', { default: 'text-embedding-3-large' }),
    S('OPENAI_BASE_URL', 'string', 'Any OpenAI-compatible endpoint. Default: OpenAI\'s API.', { default: 'https://api.openai.com/v1' }),
  ]],
  ['dbt profile (read by profiles.yml via env_var)', [
    S('DUCKDB_PATH', 'profile', 'The DuckDB database file: path: "{{ env_var(\'DUCKDB_PATH\') }}" (on the warehouse volume).', { example: '/warehouse/analytics.duckdb' }),
  ]],
];

export const SETTINGS = new Map(SETTING_GROUPS.flatMap(([, rows]) => rows).map((row) => [row.name, row]));

/**
 * One setting's value from `env` (process.env unless given), read as its kind says, with its default —
 * or, where the caller has a default of its own (a feature's longer timeout), `fallback`.
 */
export function setting(name, { env = process.env, fallback } = {}) {
  const row = SETTINGS.get(name);
  if (!row) throw new Error(`'${name}' is not a setting (src/settings.js lists every one)`);
  const dflt = fallback !== undefined ? fallback : row.default;
  switch (row.kind) {
    case 'flag': return envFlag(name, dflt, env);
    case 'number': return envNumber(name, dflt, { min: row.min ?? 0 }, env);
    case 'int': return envInt(name, dflt, { min: row.min ?? 0 }, env);
    case 'list': { const v = envString(name, undefined, env); return v === undefined ? dflt : String(v).split(',').map((x) => x.trim()).filter(Boolean); }
    case 'string': case 'raw': return envString(name, dflt, env);
    default: throw new Error(`'${name}' is read by ${row.kind === 'compose' ? 'docker compose' : 'the dbt profile'}, not by the server`);
  }
}

/** Every setting the server reads, by name, from `env`. */
export function loadSettings(env = process.env) {
  return Object.freeze(Object.fromEntries([...SETTINGS.values()].filter((r) => r.kind !== 'compose' && r.kind !== 'profile').map((r) => [r.name, setting(r.name, { env })])));
}

/** `.env.example`, rendered from the table. */
export function renderEnvExample() {
  const shownOf = (r) => {
    if (r.shown !== undefined) return r.shown;
    if (Array.isArray(r.default)) return r.default.join(',');
    return r.default === undefined ? '' : String(r.default);
  };
  const out = [
    '# Every setting the server reads, with its default (src/config.js reads them: a flag is on|off/1|0/',
    '# true|false/yes|no, anything else its default; a number below its minimum is its default). Copy to .env and edit:',
    '#   cp .env.example .env && docker compose up --build',
    '# (BigQuery: .env.bigquery.example + docker-compose.bigquery.yml.)',
    '#',
    '# docker compose passes this whole file into the container (env_file), and the values its own',
    '# `environment:` block sets win over it — those are marked "(set by compose)". A commented line',
    '# shows the default the server uses when the variable is not set.',
    '#',
    '# Rendered from src/settings.js (npm run settings:example) — edit the table there, not this file.',
  ];
  for (const [title, rows] of SETTING_GROUPS) {
    out.push('', `# ───────────────────────── ${title} ─────────────────────────`);
    for (const r of rows) {
      if (r.doc) for (const line of r.doc.split('\n')) out.push(`# ${line}`);
      out.push(r.example !== undefined ? `${r.name}=${r.example}` : `# ${r.name}=${shownOf(r)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
