// THE ERROR LOG — every failure the server meets, kept in the store so it can be looked at later
// (explore_errors): a tool call refused or failed (its arguments with it), a task that ended in an
// error (what dbt / the warehouse said), and what start could not serve (the project's semantic layer,
// a join it leaves out). A debugging aid: recording never fails the call it records, and what is kept
// is bounded — by age (MCP_ERROR_RETENTION_DAYS, default 30) and by count (MCP_ERROR_MAX_ROWS,
// default 10000) — so a loop of refusals cannot grow the store without end.
//
// The log is NOT wiped by MCP_DB_RESET: a server that fails on every start is exactly what it is for.

const MESSAGE_MAX = 20000;
const ARGS_MAX = 20000;

/** A text cut to `max` characters, saying how long it was. */
const cut = (text, max) => (text == null ? null : text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text);

function jsonOf(value) {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return '(unserializable)'; }
}

const envInt = (name, fallback) => {
  const v = process.env[name];
  const n = v == null || v === '' ? fallback : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const ERROR_SOURCES = ['tool', 'task', 'startup'];

export class ErrorLog {
  constructor({ store, retentionDays = envInt('MCP_ERROR_RETENTION_DAYS', 30), maxRows = envInt('MCP_ERROR_MAX_ROWS', 10000) } = {}) {
    this.repo = store?.errors || null;
    this.retentionMs = retentionDays * 86400000;
    this.maxRows = maxRows;
    this._added = 0;
    this.prune();
  }

  /**
   * Keep one failure: { source: tool|task|startup, severity?: error|warning, tool?, stage?, field?,
   * code?, context_id?, task_id?, message, args?, detail? } → its id, or null when it could not be kept.
   */
  record(e) {
    if (!this.repo) return null;
    try {
      const id = this.repo.add({
        at: Date.now(),
        source: e.source,
        severity: e.severity || 'error',
        tool: e.tool ?? null,
        stage: e.stage ?? null,
        field: e.field ?? null,
        code: e.code ?? null,
        context_id: e.context_id ?? null,
        task_id: e.task_id ?? null,
        message: cut(String(e.message ?? ''), MESSAGE_MAX),
        args: cut(jsonOf(e.args), ARGS_MAX),
        detail: cut(typeof e.detail === 'string' ? e.detail : jsonOf(e.detail), MESSAGE_MAX),
      });
      // trimmed now and then, not on every write
      if (++this._added % 200 === 0) this.prune();
      return id;
    } catch (err) {
      console.error(`[mcp] ${new Date().toISOString()} error log: could not record a failure (${err?.message || err})`);
      return null;
    }
  }

  prune() {
    if (!this.repo) return 0;
    try {
      return this.repo.prune({ ...(this.retentionMs ? { before: Date.now() - this.retentionMs } : {}), ...(this.maxRows ? { keep: this.maxRows } : {}) });
    } catch { return 0; }
  }

  list(filter) { return this.repo ? this.repo.list(filter) : { total: 0, rows: [] }; }
  get(id) { return this.repo ? this.repo.get(id) : null; }
  summary(filter) { return this.repo ? this.repo.summary(filter) : []; }
}
