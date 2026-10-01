// WHAT A TOOL ANSWERS, WHERE THE ANSWER HAS ONE SHAPE — the tool's `outputSchema` (MCP: a tool that
// declares one carries its answer as `structuredContent` too, conforming to it). Declared only for the
// tools whose answer is the same few fields every time and that draw nothing: a timer, the contexts,
// the memory, the error log, and a build that only starts a task. A tool that answers with the rows of
// a result (the query tools, a pipeline build) declares none: the rows would be carried twice — once in
// the text the model reads, once in structuredContent — and their columns are the query's own. A tool
// with a card (display_model_result, experiment, drill_result) declares none either: a host draws a
// card for every answer that carries structuredContent (src/mcp-surface.js toCallToolResult).
//
// Each schema names what the answer always has (`required`) and types every field it may carry; a field
// added to an answer later is allowed (the schemas are not closed), so an answer is never refused for
// saying more.

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

  // list: { contexts }; describe: one context in depth
  context: {
    type: 'object',
    description: 'The contexts (list), or one in depth (describe).',
    anyOf: [
      { type: 'object', required: ['contexts'], properties: { contexts: list(obj) } },
      { type: 'object', required: ['context_id'], properties: { context_id: str, engine: str, tasks: list(), draft: obj, semantic_models: list(), measures: list(), metrics: list(), groupable: list(), files: list(str) } },
    ],
  },

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

  // record: saved + id; list / search: notes; forget: forgotten + id
  memory: {
    type: 'object',
    description: 'The note saved (record), the notes found (list, search), or the note removed (forget).',
    anyOf: [
      { type: 'object', required: ['saved', 'id'], properties: { saved: bool, id: str, note: str, linked_to: list(obj), unresolved_terms: list(str), aliases: list(str), links: list(), next: str } },
      { type: 'object', required: ['notes'], properties: { total: int, query: str, semantic: bool, notes: list(obj) } },
      { type: 'object', required: ['forgotten', 'id'], properties: { forgotten: bool, id: str } },
    ],
  },

  // a page of failures, or one in full
  explore_errors: {
    type: 'object',
    description: 'A page of the failures kept (newest first), or one in full ({ id }).',
    anyOf: [
      { type: 'object', required: ['total', 'errors'], properties: { ok: bool, total: int, shown: int, offset: int, errors: list(obj), by_source: list(obj), note: str } },
      { type: 'object', required: ['error'], properties: { ok: bool, error: obj } },
    ],
  },

  build_semantic_model: started,
};
