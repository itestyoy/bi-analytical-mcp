// A call that STARTS work (build_semantic_model, query_semantic_model, build_pipeline_model
// materialize, query_pipeline_model, register_native_model) returns only { task_id, … }; what it
// produced is read back with the query tool of its side ({ task_id }). Most tests are about what the work produced, so they run their engine through
// `settle(engine)`: the same engine, where a call that started a task returns that task's result
// (read with its side's query tool, waiting until it is done). The raw engine stays reachable as
// `engine.raw`, for a test about the task itself.

const STARTED_KEYS = new Set(['task_id', 'context_id', 'draft_id', 'model', 'read_with', 'next']);

/** Whether a tool's answer is a started task (and nothing else). */
export function isStartedTask(out) {
  return !!out && typeof out === 'object' && !Array.isArray(out) && typeof out.task_id === 'string'
    && Object.keys(out).every((k) => STARTED_KEYS.has(k)) && 'next' in out;
}

/** The public read of a task: the query tool of its side (the engine's own mapping), with { task_id }. */
export function readTask(engine, taskId, extra = {}) {
  const raw = engine.raw || engine;
  const tool = raw._taskSide(raw.jobs.get(taskId)) === 'pipeline' ? 'query_pipeline_model' : 'query_semantic_model';
  return raw[tool]({ task_id: taskId, ...extra });
}

/** Wait for a task and return what its query tool says once it is no longer running. */
export async function taskResult(engine, taskId) {
  for (;;) {
    const r = await readTask(engine, taskId, { wait_seconds: 30 });
    if (r.status !== 'running') return r;
  }
}

/**
 * A task that ended in a REFUSAL of its input (a stage that does not render, a gate that rejects a
 * python body) — validation that runs inside the work, not in the call — is thrown here, as the
 * refusal it is, so a test of it reads the same whichever side of the call it happens on.
 */
function refusal(r) {
  if (r?.status !== 'error' || !['validate', 'compile'].includes(r.error?.stage)) return null;
  return Object.assign(new Error(r.error.message), { stage: r.error.stage, field: r.error.field, code: r.error.code });
}

const TASK_TOOLS = new Set(['build_semantic_model', 'update_semantic_model', 'query_semantic_model', 'register_native_model', 'build_pipeline_model', 'query_pipeline_model']);

/** The engine, with every started task settled into its result. */
export function settle(engine) {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'raw') return target;
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (!TASK_TOOLS.has(prop)) return v.bind(target);
      return async (input) => {
        const out = await v.call(target, input);
        if (!isStartedTask(out)) return out;
        const r = await taskResult(target, out.task_id);
        const refused = refusal(r);
        if (refused) throw refused;
        return r;
      };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

/**
 * Read a table a pipeline or a materialized query built — an intermediate model of a chain
 * included — for a test's check of the data. The same read a card's drill-down makes (with an
 * optional transform); no tool offers a table by name.
 */
export function readTable(engine, contextId, table, { transform, limit = 1000 } = {}) {
  const raw = engine.raw || engine;
  return raw._readTable(raw.ctxs.dir(contextId), table, limit, transform);
}
