// THE TASK INDEX — what has been asked of this server, by meaning. Every task a tool starts (a build,
// a query) is kept as one line of text that says what it computes — its context's name and
// description, the source, the events, metrics, columns and values it names, its window — with a
// vector of that text. semantic_index({ request: { tasks } }) reads it two ways: the tasks most like
// a phrase, and the themes of a period (the tasks of the window, narrowed to those near a phrase if
// one is given, clustered).
//
// It is a record of the QUESTIONS and of HOW each was computed — never a way to the data: what it
// answers carries no task id, no context id and no table, and nothing it keeps does either — a found
// task's steps are kept without what names stored work and with every id spelled in them blanked
// (`howOf`, `withoutIds`), so a task found here cannot be read back, built on or drawn. Another task's
// rows may not fit the question at hand, and reaching them is not what this is for; its method may help.
//
// The vector is the deployment's embedder's (the one semantic memory search uses — MEMORY_EMBEDDINGS,
// OpenAI) at TASK_DIMS dimensions, computed after the task starts and never in its way, and stored
// with the model that made it: a search reads only the rows of the model it asks with, and the rows
// of another model (a deployment that switched) are re-embedded when the index is read. Without an
// embedder — or while it cannot be reached — the vector is a local one, made when the index is read:
// the text's words weighted by how rare they are among the tasks read (TF-IDF, so what every task says
// weighs nothing) and hashed — coarser where the words differ but the meaning is the same.
//
// What is computed over the rows read (the local vectors, a search's ranking, the clustering of a
// period) runs in a thread of its own (src/task-themes-worker.js), so a long window takes none of the
// server's own thread from every other call.

import { Worker } from 'node:worker_threads';
import { resolveTimeRange, momentMs, isValidTimezone } from './time-range.js';
import { ToolError } from './validate.js';
import { LOCAL_DIMS, normalized } from './task-themes.js';

export { words, localVectors, kmeans, bestKmeans, silhouette } from './task-themes.js';
export { LOCAL_DIMS };

/** The dimensions an OpenAI text-embedding-3 vector is asked at (plenty to tell themes apart, 1 KB a row). */
export const TASK_DIMS = 256;
export const LOCAL_MODEL = `local-words-${LOCAL_DIMS}`;
/** At most this many rows are embedded in one request to the embedder. */
const EMBED_BATCH = 64;
/** How long a computation over the rows read may take in its thread. */
const THREAD_TIMEOUT_MS = 120000;
/** A string of a task's steps longer than this is kept cut (a python stage's function body may run to 40 000). */
const HOW_STRING_MAX = 1000;

// the fields of a tool's input whose strings say WHAT is computed (a name, a source, an event, a
// metric, a column, a value) — not how (a function, a stage, a direction)
const MEANINGFUL = new Set(['source', 'event', 'event_name', 'events', 'metric', 'metrics', 'measure', 'column', 'property', 'dimension', 'entity', 'semantic_model', 'value', 'group_by', 'keep', 'on', 'name', 'description', 'label', 'experiment', 'analysis']);

// what in a tool's input names stored work rather than saying how something is computed — a context,
// a task, a table, a checkpoint and the context it is built in
const LEADS_TO_DATA = new Set(['context_id', 'from_task', 'task_id', 'task_ids', 'table', 'cancel', 'offset', 'from_checkpoint', 'checkpoints', 'owner', 'base', 'building']);

// a context's or a task's id (twelve hex digits, a server-made name may carry one: pipe_<name>_<id>_c2)
const AN_ID = /(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/gi;

/** A text with every id spelled in it blanked: an id is its owner's key, and nothing kept here may hand one on. */
export function withoutIds(text) {
  return String(text).replace(AN_ID, '<id>');
}

/**
 * How a task computed what it did — its input without anything that names stored work (a context, a
 * task, a table, a checkpoint), every id spelled in a string blanked, and a long string kept cut.
 */
export function howOf(input) {
  if (Array.isArray(input)) return input.map(howOf);
  if (typeof input === 'string') {
    const s = withoutIds(input);
    return s.length > HOW_STRING_MAX ? `${s.slice(0, HOW_STRING_MAX)}… (${s.length - HOW_STRING_MAX} more characters)` : s;
  }
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).filter(([k]) => !LEADS_TO_DATA.has(k)).map(([k, v]) => [k, howOf(v)]));
}

/** The name and the note a context says it is for, or nulls. */
function aboutOf(ctx) {
  const state = ctx?.state || {};
  const notes = Object.values(state.task_notes || {});
  return {
    name: state.draft?.name || (Array.isArray(state.tasks) && state.tasks.length ? state.tasks[state.tasks.length - 1] : null),
    description: state.draft?.description || notes[notes.length - 1] || null,
  };
}

/**
 * One line that says what a task computes, from what the server knows of it: its context's name and
 * description, the tool, and the meaningful strings of its input. Nothing of the user's own words —
 * the server never sees them — nothing it would have to guess, and no id.
 */
export function taskText({ tool, ctx = null, input = null }) {
  const state = ctx?.state || {};
  const { name, description } = aboutOf(ctx);
  const seen = new Set();
  const said = [];
  const walk = (v, key) => {
    if (said.length >= 60) return;
    if (typeof v === 'string') {
      if (MEANINGFUL.has(key) && v.length <= 200 && !seen.has(v)) { seen.add(v); said.push(v); }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      if (key === 'value' && !seen.has(String(v))) { seen.add(String(v)); said.push(String(v)); }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'sql' && k !== 'body' && !LEADS_TO_DATA.has(k)) walk(x, k);
  };
  walk(input, null);
  const window = input?.time_range ? [input.time_range.start, input.time_range.end].filter(Boolean).join('..') : null;
  return withoutIds([
    name ? `${String(name).replace(/_/g, ' ')}${description ? `: ${description}` : ''}` : description,
    `${tool}${state.draft?.source ? ` over ${state.draft.source}` : ''}`,
    said.length ? said.join(', ') : null,
    window ? `window ${window}` : null,
  ].filter(Boolean).join(' — '));
}

/** The window of a time_range as epoch milliseconds { since, until }, read as every time_range is. */
function windowOf(tr) {
  if (tr?.timezone && !isValidTimezone(tr.timezone)) throw new ToolError(`time_range.timezone: unknown timezone '${tr.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
  const b = resolveTimeRange(tr) || {};
  return {
    since: b.start != null ? momentMs(b.start) : null,
    until: b.endExclusive != null ? momentMs(b.endExclusive) - 1 : b.end != null ? momentMs(b.end) : null,
  };
}

/**
 * Compute `op` over the rows read in a thread of its own: their texts and times, and their vectors
 * (where the embedder made them) packed into one buffer handed over rather than copied.
 */
function inThread(op, payload, vectors = null, query = null) {
  let packed = null;
  const transferList = [];
  if (vectors) {
    const dims = vectors[0]?.length || 0;
    const all = new Float32Array(vectors.length * dims);
    vectors.forEach((v, i) => all.set(v, i * dims));
    packed = { buffer: all.buffer, dims, n: vectors.length, ...(query ? { query } : {}) };
    transferList.push(all.buffer);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./task-themes-worker.js', import.meta.url), { workerData: { op, payload, packed }, transferList });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { void worker.terminate(); done(reject, new ToolError(`the task index took longer than ${THREAD_TIMEOUT_MS / 1000}s over this window — ask for a shorter time_range`, { stage: 'tasks' })); }, THREAD_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (m) => done(m.ok ? resolve : reject, m.ok ? m.result : new Error(m.error)));
    worker.once('error', (e) => done(reject, e));
    worker.once('exit', (code) => done(reject, new Error(`the task index thread ended (${code}) without an answer`)));
  });
}

export class TaskIndex {
  /**
   * @param store     the store (its `taskLog` repository)
   * @param embedder  the deployment's embedder, or null (the local vector then)
   * @param toolOf    (the kind a task was started as) → the tool that is said as
   * @param logger    a line for what failed in the background
   */
  constructor({ store, embedder = null, toolOf = (t) => t, logger = () => {} }) {
    this.store = store;
    this.embedder = embedder;
    this.toolOf = toolOf;
    this.logger = logger;
    this.pending = new Set(); // ids waiting for the embedder
    this.flushing = null; // the one embedding run, when one runs
    this.timer = null;
  }

  /** The model a vector is made by on this deployment (the name each row is stored with). */
  get model() {
    return this.embedder ? `${this.embedder.model}@${TASK_DIMS}` : LOCAL_MODEL;
  }

  /** Keep a task that just started. Never throws, never waits: a task does not depend on its record. */
  record({ id, tool, ctx = null, input = null, at = Date.now() }) {
    try {
      const said = this.toolOf(tool) || tool;
      this.store.taskLog.put({ id, at, tool: said, source: ctx?.state?.draft?.source ?? input?.source ?? null, text: taskText({ tool: said, ctx, input }), how: input ? howOf(input) : null });
      if (this.embedder) { this.pending.add(id); this._schedule(); }
    } catch (e) { this.logger(`✗ task ${id} not indexed: ${e?.message || e}`); }
  }

  /**
   * Tasks started before the index existed, kept from the job registry — those whose context still
   * says what they were for: one that does not would be a line of its tool's name alone, the same for
   * every such task, and only crowd the themes.
   */
  backfill(jobs = [], ctxOf = () => null) {
    for (const j of jobs) {
      if (!j?.id || !j.contextId || this.store.taskLog.has(j.id)) continue;
      const ctx = ctxOf(j.contextId);
      const { name, description } = aboutOf(ctx);
      if (!name && !description) continue;
      this.record({ id: j.id, tool: j.tool || 'task', ctx, at: j.startedAt || Date.now() });
    }
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._embedPending().catch((e) => this.logger(`✗ embedding tasks: ${e?.message || e}`)).then(() => { if (this.pending.size) this._schedule(); });
    }, 200);
    this.timer.unref?.();
  }

  /** The one embedding run: joined while it runs, so a row is never sent to the embedder twice at once. */
  _embedPending() {
    if (!this.flushing) this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Embed every row without a vector of this deployment's model (what waits among them), batch by batch. */
  async _flush() {
    if (!this.embedder) return;
    this.pending.clear();
    const rows = this.store.taskLog.missing(this.model, 10000);
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      const vecs = await this.embedder.embed(batch.map((r) => r.text), { dimensions: TASK_DIMS });
      batch.forEach((r, j) => { if (vecs[j]) this.store.taskLog.setVector(r.id, this.model, normalized(vecs[j])); });
    }
  }

  /**
   * The rows of the window, with the embedder's vectors and the vector of each phrase asked — or, where
   * there is no embedder or it cannot be reached now, the rows with no vector (the thread makes local
   * ones) and a note saying so. A row the embedder has not reached yet is counted, never silently left out.
   */
  async _read(timeRange, phrase) {
    const { since, until } = windowOf(timeRange);
    let note = null;
    if (this.embedder) {
      try {
        // what an earlier run is embedding is waited for, then everything still without a vector
        if (this.flushing) await this.flushing.catch(() => {});
        await this._embedPending();
        const q = phrase ? normalized((await this.embedder.embed([phrase], { dimensions: TASK_DIMS }))[0]) : null;
        const rows = this.store.taskLog.range({ since, until, model: this.model });
        const all = this.store.taskLog.count({ since, until });
        return { rows, q, model: this.model, ...(all > rows.length ? { not_embedded: all - rows.length } : {}) };
      } catch (e) {
        this.logger(`✗ the embedder could not be reached: ${e?.message || e}`);
        note = `the embedder could not be reached (${e?.message || e}), so the tasks were compared by their words`;
      }
    }
    return { rows: this.store.taskLog.range({ since, until }), q: null, model: LOCAL_MODEL, ...(note ? { note } : {}) };
  }

  /** What a task is said as here: what it computed, when and (where asked) how — never a way back to it. */
  _shown(r, score, how) {
    return { at: new Date(r.at).toISOString(), tool: r.tool, ...(r.source ? { source: r.source } : {}), task: r.text, ...(score != null ? { similarity: Math.round(score * 1000) / 1000 } : {}), ...(how ? { how } : {}) };
  }

  /** What every answer says of the read: the model, and what it could not compare. */
  _said(read) {
    return { model: read.model, ...(read.not_embedded ? { not_embedded: read.not_embedded } : {}), ...(read.note ? { note: read.note } : {}) };
  }

  /** The tasks most like a phrase, within a window — each with how it was computed. */
  async similar({ search, time_range: timeRange, limit = 10 }) {
    const read = await this._read(timeRange, search);
    const { rows } = read;
    const ranked = rows.length
      ? await inThread('similar', { texts: rows.map((r) => r.text), ats: rows.map((r) => r.at), query: search, limit }, read.model === LOCAL_MODEL ? null : rows.map((r) => r.vector), read.q ? { field: 'queryVector', vector: read.q } : null)
      : [];
    const hows = this.store.taskLog.hows(ranked.map(({ i }) => rows[i].id));
    return { ...this._said(read), searched: rows.length, tasks: ranked.map(({ i, s }) => this._shown(rows[i], s, hows.get(rows[i].id))) };
  }

  /**
   * The themes of a window: its tasks (those at least `min_similarity` like `about`, where it is
   * given) clustered — `clusters` of them, or the number whose clustering separates best — each with
   * its size, its share, its days, the words that set it apart and its most typical tasks.
   */
  async themes({ time_range: timeRange, about = null, min_similarity: minSimilarity = null, clusters = null }) {
    const read = await this._read(timeRange, about);
    const { rows } = read;
    const out = { ...this._said(read), tasks_in_window: rows.length };
    if (!rows.length) return { ...out, ...(about ? { about, tasks_about: 0 } : {}), themes: [] };
    const floor = minSimilarity ?? (read.q ? 0.3 : 0.1);
    const found = await inThread('themes', {
      texts: rows.map((r) => r.text), ats: rows.map((r) => r.at), tools: rows.map((r) => r.tool), sources: rows.map((r) => r.source),
      about, minSimilarity: floor, clusters,
    }, read.model === LOCAL_MODEL ? null : rows.map((r) => r.vector), read.q ? { field: 'aboutVector', vector: read.q } : null);
    return {
      ...out,
      ...(about ? { about, tasks_about: found.tasks_about } : {}),
      themes: found.themes.map(({ examples, ...t }) => ({ ...t, examples: examples.map((i) => this._shown(rows[i])) })),
    };
  }
}

