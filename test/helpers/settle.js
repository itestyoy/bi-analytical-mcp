// A call that STARTS work (create_semantic_model, query_semantic_model, register_native_model,
// build_native_model materialize) returns only { task_id, … }; what it produced is read with
// get_task_result. Most tests are about what the work produced, so they run their engine through
// `settle(engine)`: the same engine, where a call that started a task returns that task's result
// (read with get_task_result, waiting until it is done). The raw engine stays reachable as
// `engine.raw`, for a test about the task itself.

const STARTED_KEYS = new Set(['task_id', 'context_id', 'draft_id', 'model', 'next']);

/** Whether a tool's answer is a started task (and nothing else). */
export function isStartedTask(out) {
  return !!out && typeof out === 'object' && !Array.isArray(out) && typeof out.task_id === 'string'
    && Object.keys(out).every((k) => STARTED_KEYS.has(k)) && 'next' in out;
}

/** Wait for a task and return what get_task_result says once it is no longer running. */
export async function taskResult(engine, taskId) {
  for (;;) {
    const r = await engine.get_task_result({ task_id: taskId, wait_seconds: 30 });
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

const TASK_TOOLS = new Set(['create_semantic_model', 'update_semantic_model', 'query_semantic_model', 'register_native_model', 'build_native_model']);

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
