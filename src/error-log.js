// THE ERROR LOG — every failure the server meets, kept in the store so it can be looked at later
// (explore_errors): a tool call refused or failed (its arguments with it), a task that ended in an
// error (what dbt / the warehouse said), and what start could not serve (the project's semantic layer,
// a join it leaves out). Each carries what REPRODUCES it: the call's arguments or the task's input, the
// state of the context it worked on (a semantic declaration, a pipeline draft with its steps, an
// eventstream with its steps — as it was when it failed), the code of each generated model the error
// names (as written and as dbt compiled it: the line:column a warehouse error points at is in that
// one), and the runtime (server version and surface, dbt, dialect). A debugging aid: recording never
// fails the call it records, and what is kept
// is bounded — by age (MCP_ERROR_RETENTION_DAYS, default 30) and by count (MCP_ERROR_MAX_ROWS,
// default 10000) — so a loop of refusals cannot grow the store without end.
//
// The log is NOT wiped by MCP_DB_RESET: a server that fails on every start is exactly what it is for.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setting } from './settings.js';
import { ToolError } from './validate.js';
import { resolveTimeRange, momentMs, isValidTimezone } from './time-range.js';

const MESSAGE_MAX = 20000;
const ARGS_MAX = 20000;
const CONTEXT_MAX = 40000;
const FILE_MAX = 40000;

/** A text cut to `max` characters, saying how long it was. */
const cut = (text, max) => (text == null ? null : text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text);

function jsonOf(value) {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return '(unserializable)'; }
}


export const ERROR_SOURCES = ['tool', 'task', 'startup'];

export class ErrorLog {
  constructor({ store, retentionDays = setting('MCP_ERROR_RETENTION_DAYS'), maxRows = setting('MCP_ERROR_MAX_ROWS') } = {}) {
    this.repo = store?.errors || null;
    // set by the engine: the runtime every record carries, and how a context's reproduction is read
    this.runtime = {};
    this.contextOf = null;
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
      // the context as it is now — for a refused call it is what the call was made against, for a
      // failed task what it ran on — and the generated code the message names
      let repro = {};
      if (e.context_id && this.contextOf) { try { repro = this.contextOf(e.context_id, `${e.message ?? ''}\n${typeof e.detail === 'string' ? e.detail : ''}`, { files: e.source === 'task' }) || {}; } catch { /* no reproduction, still the error */ } }
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
        context: cut(jsonOf(repro.context), CONTEXT_MAX),
        files: repro.files && Object.keys(repro.files).length ? jsonOf(Object.fromEntries(Object.entries(repro.files).map(([k, v]) => [k, cut(v, FILE_MAX)]))) : null,
        runtime: jsonOf(this.runtime),
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

  /**
   * What explore_errors answers (its input already validated against the tool's schema): one kept
   * failure in full by `id` — everything that reproduces it — or a page of them, newest first, each
   * cut to its message, with a count per source.
   */
  explore(input = {}) {
    const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
    const parsed = (text) => { if (text == null) return null; try { return JSON.parse(text); } catch { return text; } };
    const shown = (r, full) => ({
      id: Number(r.id), at: iso(r.at), source: r.source, severity: r.severity,
      ...Object.fromEntries(['tool', 'stage', 'field', 'code', 'context_id', 'task_id'].filter((k) => r[k] != null).map((k) => [k, r[k]])),
      message: full || !r.message || r.message.length <= 600 ? r.message : `${r.message.slice(0, 600)}… (explore_errors({ request: { id: ${Number(r.id)} } }) for all of it)`,
      ...(full ? Object.fromEntries(['args', 'detail', 'context', 'files', 'runtime'].filter((k) => r[k] != null).map((k) => [k, parsed(r[k])])) : {}),
    });
    if (input.id != null) {
      const row = this.get(input.id);
      if (!row) throw new ToolError(`no error with id ${input.id} is kept (they are kept ${this.retentionMs / 86400000} days, the newest ${this.maxRows})`, { stage: 'validate', field: 'id' });
      return { ok: true, error: shown(row, true) };
    }
    // the window as every time_range is read (src/time-range.js): a date-only end is the whole of that
    // day, and a timezone reads both bounds as wall-clock time there
    if (input.time_range?.timezone && !isValidTimezone(input.time_range.timezone)) throw new ToolError(`time_range.timezone: unknown timezone '${input.time_range.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
    const bounds = resolveTimeRange(input.time_range) || {};
    const filter = {
      since: bounds.start != null ? momentMs(bounds.start) : null,
      until: bounds.endExclusive != null ? momentMs(bounds.endExclusive) - 1 : bounds.end != null ? momentMs(bounds.end) : null,
      ...Object.fromEntries(['source', 'severity', 'tool', 'stage', 'context_id', 'task_id', 'search'].filter((k) => input[k] != null).map((k) => [k, input[k]])),
    };
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    const { total, rows } = this.list({ ...filter, limit, offset });
    return {
      ok: true,
      total,
      shown: rows.length,
      ...(offset + rows.length < total ? { next_offset: offset + rows.length } : {}),
      errors: rows.map((r) => shown(r, input.detail === 'full')),
      by_source: this.summary(filter).map((g) => ({ ...g, last_at: iso(g.last_at) })),
      note: `Newest first. explore_errors({ request: { id } }) gives one in full — what reproduces it: the call's arguments (a task's input), the state of the context it worked on, the code of each generated model the error names (as written and as dbt compiled it), the runtime, and everything the warehouse said. Kept ${this.retentionMs / 86400000} days, the newest ${this.maxRows}.`,
    };
  }

  list(filter) { return this.repo ? this.repo.list(filter) : { total: 0, rows: [] }; }
  get(id) { return this.repo ? this.repo.get(id) : null; }
  summary(filter) { return this.repo ? this.repo.summary(filter) : []; }
}

/** The first file called `name` under `dir`, at most `depth` levels down, or null. */
function findFile(dir, name, depth) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) if (e.isDirectory()) { const hit = findFile(join(dir, e.name), name, depth - 1); if (hit) return hit; }
  return null;
}

/**
 * The code of each generated model `names` (file names a dbt message cites) in a context's project:
 * as written (generated/) and as dbt last ran it (target/run, else target/compiled) — where a
 * warehouse error's line:column points. → { "<where>/<name>": text }
 */
export function readGenerated(projectDir, generatedDir, names) {
  const read = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
  const found = {};
  for (const name of names) {
    const src = read(join(generatedDir, name));
    if (src != null) found[`generated/${name}`] = src;
    for (const kind of ['run', 'compiled']) {
      const hit = findFile(join(projectDir, 'target', kind), name, 6);
      const text = hit ? read(hit) : null;
      if (text != null) { found[`target/${kind}/${name}`] = text; break; }
    }
  }
  return found;
}
