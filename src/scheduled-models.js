// WHEN SCHEDULED MODELS ARE COMPUTED AGAIN (src/engine/scheduled.js is what a scheduled model is and
// what its refresh does; this service only says when).
//
// A scheduled model is DAILY, and it follows the warehouse: each sync of the value index — which first
// `dbt run`s the catalog's source models (MCP_INDEX_DBT_RUN), at start and then on its own schedule
// (VALUE_INDEX_CRON / VALUE_INDEX_REFRESH_MS) — is followed by a refresh of every scheduled model not yet
// refreshed that UTC day. So a model reads the source models as that sync left them, and is computed at
// most once a day however often the index syncs.
//
//   * models refresh base first: one that starts from another scheduled model's table waits for that
//     one's refresh;
//   * a model nobody has QUERIED for `idleMs` is put to sleep instead of refreshed: its table stays as it
//     is, and the next query of it wakes it (engine._scheduledTouch), answering from the table it has.
//
// The service keeps nothing of its own: what a model is, when it last ran and whether it sleeps are its
// context's (ctx.state.scheduled), persisted with it.

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

export class ScheduledModels {
  /**
   * @param {object} deps
   * @param {object} deps.ctxs — the context manager (the scheduled contexts are read from it)
   * @param {(id: string, reason: string) => string|null} deps.refresh — start a refresh; its task id
   * @param {(ids: string[]) => Promise} deps.awaitTasks — wait for tasks to settle
   * @param {number} [deps.idleMs] — put a model unqueried this long to sleep (0: never)
   * @param {(m: string) => void} [deps.logger]
   */
  constructor({ ctxs, refresh, awaitTasks, idleMs = 7 * 86400000, logger = null }) {
    this.ctxs = ctxs;
    this.refresh = refresh;
    this.awaitTasks = awaitTasks;
    this.idleMs = Number(idleMs) > 0 ? Number(idleMs) : 0;
    this.logger = logger || ((m) => console.error(`[mcp] ${new Date().toISOString()} scheduled ${m}`));
    this._round = null;
  }

  /** The ids of the scheduled contexts. */
  _ids() {
    return this.ctxs.list().map((c) => c.context_id).filter((id) => this.ctxs.get(id)?.state?.scheduled);
  }

  /**
   * The value index finished a sync (the source models built before it): refresh every scheduled model
   * not refreshed today, base first. One round at a time — a sync that ends while a round runs adds
   * nothing to it. → the round's promise.
   */
  afterSync() {
    if (this._round) return this._round;
    this._round = this._run(Date.now())
      .catch((e) => this.logger(`a round of refreshes failed: ${e?.message || e}`))
      .finally(() => { this._round = null; });
    return this._round;
  }

  async _run(now) {
    const ids = this._ids();
    const started = new Map(); // id → its refresh's task id, or null (asleep, refreshed today already)
    const run = async (id, seen = new Set()) => {
      if (started.has(id)) return started.get(id);
      if (seen.has(id)) return null; // a cycle cannot be built; guarded all the same
      seen.add(id);
      const base = this.ctxs.get(id)?.state?.scheduled?.base?.context_id;
      if (base && ids.includes(base)) {
        const baseTask = await run(base, seen);
        if (baseTask) await this.awaitTasks([baseTask]);
      }
      const task = this.refreshDue(id, now);
      started.set(id, task);
      return task;
    };
    for (const id of ids) await run(id);
    const n = [...started.values()].filter(Boolean).length;
    if (n) this.logger(`after the value index's sync: ${n} model(s) refreshing`);
  }

  /**
   * One model, after a sync: refreshed when it was not today — or, unqueried for idleMs, put to sleep.
   * → the refresh's task id, or null. (The context records either.)
   */
  refreshDue(id, now = Date.now()) {
    const ctx = this.ctxs.has(id) ? this.ctxs.get(id) : null;
    const spec = ctx?.state?.scheduled;
    if (!spec || spec.suspended) return null; // a model asleep is woken by a query, not by a sync
    // once a UTC day: a refresh that failed is tried again after the next sync
    if (spec.refreshed_at && utcDay(spec.refreshed_at) === utcDay(now)) return null;
    const used = Date.parse(spec.last_queried_at || spec.created_at || 0);
    if (this.idleMs && now - used > this.idleMs) {
      spec.suspended = { at: new Date(now).toISOString(), reason: 'unused', idle_days: Math.round((this.idleMs / 86400000) * 10) / 10, last_queried_at: spec.last_queried_at || null };
      this.ctxs.touch(id);
      this.logger(`${id}: not queried since ${spec.last_queried_at || spec.created_at} — put to sleep; the next query wakes it`);
      return null;
    }
    return this.refresh(id, 'daily');
  }
}
