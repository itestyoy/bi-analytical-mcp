// DISPLAY_RETENTIONEERING_RESULT — one analysis of a finished task drawn as its card, at most once; an
// analysis whose kind has no card is refused with where its numbers are.

import { ToolError, RESULT_GONE } from '../validate.js';
import { MAX_WAIT_SECONDS } from '../schema.js';
import { retentioneeringFacts } from './schema.js';
import { truncatedTables } from './results.js';
import { retentioneeringViewModel, hasCard, diffForm, DIFF_CARD_KINDS } from './view-model.js';
import { SIDE, QUERY, DISPLAY } from './names.js';
import { readResult, resultOrigin, taskOutput } from './query.js';

/** Whether this analysis of the task is drawn — or being drawn right now (held in memory only, so a
 *  draw that does not happen leaves nothing behind, not even across a restart). */
export function drawnAlready(engine, feature, taskId, analysis) {
  if (feature.drawing?.has(`${taskId}\u0000${analysis}`)) return true;
  const job = engine.jobs.get(taskId);
  if (!job?.contextId || !engine.ctxs.has(job.contextId)) return false;
  return !!engine.ctxs.get(job.contextId).state.retentioneering?.drawn?.[taskId]?.includes(analysis);
}

export async function display(engine, feature, input) {
  engine.host.validate(DISPLAY, input);
  const job = engine.tasks.forSide(input.task_id, SIDE);
  if (job.tool !== QUERY) throw new ToolError(`task ${input.task_id} built an eventstream — draw an analysis of a ${QUERY} task`, { stage: 'validate', field: 'task_id' });
  if (!job.contextId || !engine.ctxs.has(job.contextId)) throw new ToolError(`task ${input.task_id} has no result to draw: its context is gone (dropped, or expired) — run the analyses again`, { stage: 'validate', field: 'task_id', code: RESULT_GONE });
  if (drawnAlready(engine, feature, input.task_id, input.analysis)) throw new ToolError(`analysis '${input.analysis}' of task ${input.task_id} is shown already — its card is in the conversation above`, { stage: 'validate', field: 'analysis' });
  // taken before anything is awaited, so a second call for the same analysis — a retry, or one made
  // alongside — is refused rather than drawn twice; recorded with the task only once it is drawn
  const key = `${input.task_id}\u0000${input.analysis}`;
  const drawing = (feature.drawing ||= new Set());
  drawing.add(key);
  try {
    const ctx = engine.ctxs.get(job.contextId);
    const drawn = await drawOne(engine, feature, ctx, input);
    if (drawn.drawn) {
      const marks = (ctx.state.retentioneering.drawn ||= {});
      (marks[input.task_id] ||= []).push(input.analysis);
      engine.ctxs.touch(ctx.id);
    }
    return drawn;
  } finally {
    drawing.delete(key);
  }
}

export async function drawOne(engine, feature, ctx, input) {
  await engine.tasks.await([input.task_id], MAX_WAIT_SECONDS);
  const now = engine.jobs.get(input.task_id);
  if (now.status === 'running') throw new ToolError(`task ${input.task_id} is still running — read it with ${QUERY}({ request: { task_id } }) until it is done, then draw it`, { stage: 'validate', field: 'task_id' });
  const state = ctx.state.retentioneering;
  const origin = resultOrigin(state, now.table);
  // a card draws every record of its analysis: held in memory, and cut there, it is read whole — that
  // analysis alone; not held, it is read whole at once
  const held = engine.tasks.held(now.id);
  const out = held || await taskOutput(engine, feature, now, { rows: Infinity, analysis: input.analysis });
  if (!out || out.ok === false) throw new ToolError(`task ${input.task_id} has no result to draw${out?.error?.message ? ` (${out.error.message})` : ''}`, { stage: 'validate', field: 'task_id' });
  let result = out.analyses[input.analysis];
  const names = held ? Object.keys(out.analyses) : origin.analyses || Object.keys(out.analyses);
  if (!result) throw new ToolError(`task ${input.task_id} has no analysis '${input.analysis}' (it has ${names.join(', ')})`, { stage: 'validate', field: 'analysis' });
  if (result.error) throw new ToolError(`'${input.analysis}' did not compute — the library said ${result.error.type}: ${result.error.message} — so there is nothing to draw; the call's other analyses have their results`, { stage: 'validate', field: 'analysis' });
  if (!hasCard(result.kind, diffForm(result))) {
    // a diff of a kind that has its card, stored in the form an earlier version wrote, is drawn by running the query again
    const earlier = result.diff && DIFF_CARD_KINDS.includes(result.kind);
    throw new ToolError(earlier
      ? `'${input.analysis}' is a diff of ${result.kind} stored before its card existed: run the same query again to draw it, or answer in words from the numbers query_retentioneering_model({ request: { task_id } }) returned`
      : `'${input.analysis}' is ${result.diff ? `a diff of ${result.kind}` : `a ${result.kind}`}, which has no card: answer it in words from the numbers query_retentioneering_model({ request: { task_id } }) returned`, { stage: 'validate', field: 'analysis' });
  }
  if (held && truncatedTables(result)) {
    const whole = await readResult(engine, feature, engine.ctxs.dir(ctx.id), now.table, { context_id: out.context_id, eventstream: out.eventstream, order: [input.analysis], rows: Infinity, analysis: input.analysis });
    if (whole?.ok && whole.analyses[input.analysis]) result = whole.analyses[input.analysis];
  }
  // what the numbers are about — who, when, how much of it — from the table the analyses read, shown on
  // the card with them (whatever the eventstream became after)
  const sm = (origin.table && state.tables?.[origin.table]?.summary) || state.eventstreams?.[out.eventstream]?.summary || null;
  const scope = sm ? {
    users: sm.users, events: sm.events, ...(sm.sessions != null ? { sessions: sm.sessions } : {}),
    period: sm.period,
    ...(sm.path ? { path: sm.path } : {}),
    ...(sm.sample?.share != null ? { sample: sm.sample.share } : {}),
    ...(sm.sample?.events ? { sampled_events: sm.sample.events } : {}),
  } : null;
  // which events are the library's own (a path's start and end), for the card — the page carries no facts sheet
  const drawn = { ok: true, task_id: input.task_id, analysis: input.analysis, eventstream: out.eventstream, ...(scope ? { scope } : {}), ...(input.edge_weight ? { edge_weight: input.edge_weight } : {}), synthetic_events: retentioneeringFacts().synthetic_events, result };
  const vm = retentioneeringViewModel(drawn, input);
  if (vm.kind === 'none') return { ...drawn, drawn: false, note: 'this analysis has nothing to draw (no transitions, steps, groups or rows)' };
  return { ...drawn, drawn: true };
}
