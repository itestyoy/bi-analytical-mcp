// npm run eval — THE GOLDEN SET PUT TO A MODEL, the way a host puts a question to it: the server's
// instructions as the system prompt, its listed tools as the model's tools, every call made over MCP
// against the fixture warehouse, and the loop run until the model answers. Each case runs in a world
// of its own (evals/harness.mjs), so what one leaves is not there for the next. Each run is graded
// on the data (does the stated answer match the warehouse's truth — evals/grade.mjs) and on the
// tools (the ones a good run calls, the ones it must not, the call budget), and measured (calls,
// failed calls, turns, tokens, wall time). The results file is rewritten after every case, so a run
// that stops part-way keeps what it already paid for.
//
//   npm run eval                                  every case
//   npm run eval -- --case top_product            one case (repeatable), or --kind negative
//   npm run eval -- --model <id> --effort <level> --max-turns <n>   (claude-opus-5-5, high, 25)
//
// Credentials are the SDK's own: ANTHROPIC_API_KEY, or a profile from `ant auth login`.
// Run `npm run eval:check` first: it proves every case against the data without a model.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { CASES } from './cases.js';
import { startEval, callTool, truthOf, valueOf } from './harness.mjs';
import { ANSWER_FORMAT, answerStates, toolsMeet } from './grade.mjs';

const { values: opt } = parseArgs({
  options: {
    case: { type: 'string', multiple: true },
    kind: { type: 'string' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'high' },
    'max-turns': { type: 'string', default: '25' },
  },
});
const MAX_TURNS = Number(opt['max-turns']);
if (!Number.isInteger(MAX_TURNS) || MAX_TURNS < 1) throw new Error(`--max-turns must be a positive whole number, not '${opt['max-turns']}'`);
const cases = CASES.filter((c) => (!opt.case || opt.case.includes(c.id)) && (!opt.kind || c.kind === opt.kind));
if (!cases.length) throw new Error('no case matches the selection');

const anthropic = new Anthropic();
const ZERO = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// the listed tools as the model receives them: the same name, description and input schema a host
// passes on, unchanged. Each schema's root is one closed object with a single field, `request`
// (src/schema/transport.js wireSchema), and the tool's forms sit under it as `anyOf` — the shape the
// Messages API takes, so nothing is left out of what the model sees.
/** One case, start to answer, in its own world: the loop a host runs, every tool call through MCP. */
async function runCase(world, c, trace) {
  const tools = (await world.client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const system = world.client.getInstructions() || '';
  const messages = [{ role: 'user', content: `${c.prompt}\n\n${ANSWER_FORMAT}` }];
  const started = Date.now();
  try {
    while (trace.turns < MAX_TURNS) {
      trace.turns++;
      const response = await anthropic.beta.messages.create({
        model: opt.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: opt.effort },
        // a refused turn is re-run on the fallback model the API picks, so a classifier's decline
        // is not graded as the model's answer
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        system,
        tools,
        messages,
      });
      trace.usage.input += response.usage.input_tokens || 0;
      trace.usage.output += response.usage.output_tokens || 0;
      trace.usage.cache_read += response.usage.cache_read_input_tokens || 0;
      trace.usage.cache_write += response.usage.cache_creation_input_tokens || 0;
      trace.stop = response.stop_reason;
      messages.push({ role: 'assistant', content: response.content });
      trace.final = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (trace.stop === 'pause_turn') continue;
      if (trace.stop !== 'tool_use') break;
      // every call of the turn is answered in ONE user message, in order: the server runs a
      // context's tasks one after another, so they are made one after another too
      const results = [];
      for (const block of response.content.filter((b) => b.type === 'tool_use')) {
        const t0 = Date.now();
        let out;
        try { out = await callTool(world.client, block.name, block.input); } catch (e) { out = { text: `the call failed: ${e.message}`, isError: true }; }
        trace.calls.push({ name: block.name, input: block.input, is_error: out.isError, ms: Date.now() - t0 });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } finally {
    trace.ms = Date.now() - started;
  }
}

const by = (list) => ({
  cases: list.length,
  passed: list.filter((r) => r.pass).length,
  answer_ok: list.filter((r) => r.answer_ok).length,
  tools_ok: list.filter((r) => r.tools_ok).length,
  errored: list.filter((r) => r.error).length,
  mean_calls: list.length ? Number((list.reduce((s, r) => s + r.calls, 0) / list.length).toFixed(2)) : 0,
  failed_calls: list.reduce((s, r) => s + r.failed_calls, 0),
  input_tokens: list.reduce((s, r) => s + r.usage.input, 0),
  output_tokens: list.reduce((s, r) => s + r.usage.output, 0),
  cache_read_tokens: list.reduce((s, r) => s + r.usage.cache_read, 0),
});
const at = new Date().toISOString();
const dir = join(process.cwd(), 'evals', 'results');
const file = join(dir, `${at.replace(/[:.]/g, '-')}.json`);
const results = [];
/** The results so far, written whole — after every case, so a stopped run keeps what it paid for. */
function save() {
  const summary = { model: opt.model, effort: opt.effort, at, selected: cases.length, all: by(results), ...Object.fromEntries(['direct', 'indirect', 'negative'].map((k) => [k, by(results.filter((r) => r.kind === k))])) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ summary, results }, null, 2)}\n`);
  return summary;
}

const evalRun = await startEval();
try {
  for (const c of cases) {
    const trace = { final: '', stop: null, turns: 0, calls: [], usage: ZERO(), ms: 0 };
    let truth = null; let decoy = null; let error = null; let world = null;
    try {
      truth = await truthOf(evalRun.wh, c.answer);
      decoy = c.decoy ? await valueOf(evalRun.wh, c.answer.kind, c.decoy.sql) : null;
      world = await evalRun.caseWorld();
      await runCase(world, c, trace);
    } catch (e) {
      error = e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e?.message || e);
    } finally {
      await world?.close().catch(() => {});
    }
    const toolCheck = toolsMeet(c.expect, trace.calls);
    const answered = !error && trace.stop === 'end_turn' && answerStates(c.answer, truth, trace.final, { decoy });
    const r = {
      id: c.id, kind: c.kind, pass: answered && toolCheck.ok, answer_ok: answered, tools_ok: toolCheck.ok, tool_problems: toolCheck.problems,
      truth, decoy, stop: trace.stop, turns: trace.turns, calls: trace.calls.length, failed_calls: trace.calls.filter((x) => x.is_error).length,
      tools_called: trace.calls.map((x) => x.name), usage: trace.usage, ms: trace.ms, final: trace.final, trace: trace.calls, ...(error ? { error } : {}),
    };
    results.push(r);
    save();
    const why = [error ? `error: ${error}` : !answered ? `stated answer (stop ${r.stop}) is not ${JSON.stringify(truth)}` : '', ...toolCheck.problems].filter(Boolean).join('; ');
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${c.kind.padEnd(8)} ${c.id.padEnd(24)} calls=${r.calls} failed=${r.failed_calls} turns=${r.turns} tokens=${r.usage.input + r.usage.output}${r.pass ? '' : `  ${why}`}`);
  }
} finally {
  await evalRun.close();
}

const summary = save();
console.log(`\n${summary.all.passed}/${summary.all.cases} passed (answers ${summary.all.answer_ok}, tools ${summary.all.tools_ok}, errored ${summary.all.errored}); mean ${summary.all.mean_calls} calls, ${summary.all.failed_calls} failed; ${summary.all.input_tokens} in / ${summary.all.output_tokens} out tokens\n${file}`);
process.exitCode = summary.all.passed === summary.all.cases ? 0 : 1;
