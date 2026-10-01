// ONE DEFINITION PER TOOL — everything the server says about a tool, and does with it, in one object:
// what the client lists (name, title, description, annotations), what it
// dispatches (run), which task side it starts and reads (side, reads), whether a read of it waits on a
// task (waits, precheck) and whether it draws a card (view, appsOnly, appCallable, cardField). The core
// tools are defined in src/tools/core.js and a feature's in its own module (src/features.js); the
// engine holds them all in one registry (`engine.tools`), and the surface reads nothing else.
//
//   name         the stable id (snake_case) — the one name it is called by
//   title        what a client shows
//   description  what the model reads: what the tool does, when to use it, what to use instead
//   annotations  MCP ToolAnnotations — readOnlyHint, and for a tool that writes destructiveHint and
//                idempotentHint (openWorldHint is false throughout: the catalog's warehouse is a closed domain)
//   schema       (catalog) → its input JSON Schema; a core tool's is built with the others (src/schema.js)
//   run          (engine, input) → its answer
//   side         the task side it starts ('semantic', 'pipeline', a feature's); `reads` — the side it reads back
//   waits        a read of it ({ task_id }) waits on a task; `precheck(engine, args)` refuses before the wait
//   view         the card it draws: 'result' (the result view) or a feature's view; `cardField` — the
//                argument that asks for it (a tool that draws only when asked)
//   appsOnly     offered to a client that renders MCP Apps only; `appCallable` — the card itself calls it

const NAME = /^[a-z][a-z0-9_]*$/;
const KEYS = new Set(['name', 'title', 'description', 'annotations', 'schema', 'run', 'side', 'reads', 'waits', 'precheck', 'view', 'cardField', 'appsOnly', 'appCallable', 'feature']);

/** A tool definition, checked: a missing or mistyped field is a defect found at start, not in a call. */
export function defineTool(def) {
  const where = `tool '${def?.name}'`;
  for (const k of Object.keys(def)) if (!KEYS.has(k)) throw new Error(`${where}: unknown field '${k}'`);
  if (typeof def.name !== 'string' || !NAME.test(def.name)) throw new Error(`${where}: name must be snake_case`);
  if (typeof def.title !== 'string' || !def.title) throw new Error(`${where}: title is required`);
  if (typeof def.description !== 'string' || !def.description) throw new Error(`${where}: description is required`);
  if (typeof def.run !== 'function') throw new Error(`${where}: run(engine, input) is required`);
  const a = def.annotations;
  if (!a || typeof a.readOnlyHint !== 'boolean') throw new Error(`${where}: annotations.readOnlyHint is required`);
  if (!a.readOnlyHint && (typeof a.destructiveHint !== 'boolean' || typeof a.idempotentHint !== 'boolean')) throw new Error(`${where}: a tool that writes says whether it is destructive and idempotent`);
  if (a.readOnlyHint && a.destructiveHint) throw new Error(`${where}: a read-only tool removes nothing`);
  if (def.schema !== undefined && typeof def.schema !== 'function') throw new Error(`${where}: schema is (catalog) → a JSON Schema`);
  if (def.precheck !== undefined && !def.waits) throw new Error(`${where}: a precheck belongs to a tool whose read waits`);
  if (def.cardField !== undefined && !def.view) throw new Error(`${where}: cardField asks for a card the tool must draw`);
  return Object.freeze({ ...def, annotations: Object.freeze({ ...a }) });
}

/** The registry: name → definition, one name one tool — every tool in it is listed and called by its name. */
export function toolRegistry(definitions) {
  const tools = new Map();
  for (const def of definitions) {
    if (tools.has(def.name)) throw new Error(`tool '${def.name}' is defined twice`);
    tools.set(def.name, def);
  }
  return {
    get: (name) => tools.get(name) || null,
    has: (name) => tools.has(name),
    values: () => [...tools.values()],
    names: () => [...tools.keys()],
  };
}
