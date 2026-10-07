// WHAT A TOOL ANSWERS, WHERE THE ANSWER HAS ONE SHAPE — the tool's `outputSchema` (MCP: a tool that
// declares one carries its answer as `structuredContent` too, conforming to it). Declared only for the
// tools whose answer is the same few fields every time and that draw nothing: a timer, the contexts,
// the memory, the error log, and a build that only starts a task. A tool that answers with the rows of
// a result (the query tools, a pipeline build) declares none: the rows would be carried twice — once in
// the text the model reads, once in structuredContent — and their columns are the query's own. A tool
// with a card (display_model_result, experiment, drill_result) declares none either: a host draws a
// card for every answer that carries structuredContent (src/mcp-surface.js toCallToolResult).
//
// Each schema is ONE object — no union, so it is in the portable subset every host reads (no anyOf at
// its root, which OpenAI's strict mode refuses): it names what every answer of the tool has
// (`required`), types every field an answer may carry, and says in its description which fields a mode
// answers with. A field added to an answer later is allowed (the schemas are not closed), so an answer
// is never refused for saying more.

const str = { type: 'string' };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const obj = { type: 'object' };
const list = (items = {}) => ({ type: 'array', items });
const shape = (description, required, properties) => ({ type: 'object', description, required, properties });

/** A call that starts a task answers with its id and where to read it — nothing else. */
const started = shape('The task the call started, and the query tool that reads it back.', ['task_id', 'read_with', 'next'], {
  task_id: str,
  context_id: str,
  read_with: str,
  next: { type: 'string', description: 'The call that reads the task back.' },
});

export const OUTPUTS = {
  time: shape('How long the timer waited.', ['ok', 'waited_seconds', 'requested_seconds', 'cap_seconds', 'clamped', 'started_at', 'finished_at'], {
    ok: { const: true },
    waited_seconds: num,
    requested_seconds: num,
    cap_seconds: num,
    clamped: bool,
    cancelled: bool,
    started_at: str,
    finished_at: str,
    reason: str,
  }),

  // list: { contexts }; describe: one context in depth — one object, no union: what each mode answers is optional
  context: shape('A page of the contexts (list: `contexts`, `total`, `next_offset`), or one in depth (describe: `context_id` and what it holds).', [], {
    contexts: list(obj),
    total: num,
    offset: num,
    next_offset: num,
    description: str,
    eventstreams: list(obj),
    continue_with: str,
    context_id: str,
    engine: str,
    tasks: list(),
    draft: obj,
    semantic_models: list(),
    measures: list(),
    metrics: list(),
    groupable: list(),
    files: list(str),
  }),

  delete_context: shape('What was removed.', ['removed'], {
    removed: bool,
    context_id: str,
    reason: str,
    model: str,
    semantic_model: str,
    metrics: list(),
    removed_files: list(),
    consumers_recomputing: list(),
    parse: obj,
    note: str,
  }),

  // record: saved + notes (each with its id); forget: forgotten + id
  memory: shape('The notes saved (record: `saved`, `notes`, each with its `id`), or the note removed (forget: `forgotten`, `id`).', [], {
    saved: bool,
    notes: list(obj),
    forgotten: bool,
    id: str,
    next: str,
  }),

  // a page of failures, or one in full
  explore_errors: shape('A page of the failures kept, newest first (`errors`), or one in full ({ id }: `error`).', ['ok'], {
    ok: bool,
    total: int,
    shown: int,
    offset: int,
    errors: list(obj),
    by_source: list(obj),
    note: str,
    error: obj,
  }),

  build_semantic_model: started,
};
