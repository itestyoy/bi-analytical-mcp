// npm run eval — THE GOLDEN SET PUT TO A MODEL, the way a host puts a question to it: the server's
// instructions as the system prompt, its listed tools as the model's tools, every call made over MCP
// against the fixture warehouse, and the loop run until the model answers. Each run is graded on
// the data (does the answer state the warehouse's truth) and on the tools (the ones a good run
// calls, the ones it must not, the call budget), and measured (calls, failed calls, turns, tokens,
// wall time). Results go to evals/results/<time>.json and a summary to stdout.
//
//   npm run eval                          every case
//   npm run eval -- --case top_product    one case (repeatable), or --kind negative
//   EVAL_MODEL, EVAL_EFFORT, EVAL_MAX_TURNS   the model (claude-opus-5-5), its effort (high), the turn cap (25)
//
// Credentials are the SDK's own: ANTHROPIC_API_KEY, or a profile from `ant auth login`.
// Run `npm run eval:check` first: it proves every case against the data without a model.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { CASES } from './cases.js';
import { startWorld, callTool, truthOf } from './harness.mjs';
import { answerStates, toolsMeet } from './grade.mjs';

const MODEL = process.env.EVAL_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.EVAL_EFFORT || 'high';
const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS || 25);

const { values: opt } = parseArgs({ options: { case: { type: 'string', multiple: true }, kind: { type: 'string' } } });
const cases = CASES.filter((c) => (!opt.case || opt.case.includes(c.id)) && (!opt.kind || c.kind === opt.kind));
if (!cases.length) throw new Error('no case matches the selection');

const anthropic = new Anthropic();

/** One case, start to answer: the loop a host runs, every tool call through MCP. */
async function runCase(world, tools, system, c) {
  const messages = [{ role: 'user', content: c.prompt }];
  const calls = [];
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const started = Date.now();
  let final = '';
  let stop = null;
  let turns = 0;
  while (turns < MAX_TURNS) {
    turns++;
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      // a refused turn is re-run on the fallback model the API picks, so a classifier's decline
      // is not graded as the model's answer
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system,
      tools,
      messages,
    });
    usage.input += response.usage.input_tokens || 0;
    usage.output += response.usage.output_tokens || 0;
    usage.cache_read += response.usage.cache_read_input_tokens || 0;
    usage.cache_write += response.usage.cache_creation_input_tokens || 0;
    stop = response.stop_reason;
    messages.push({ role: 'assistant', content: response.content });
    final = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (stop === 'pause_turn') continue;
    if (stop !== 'tool_use') break;
    // every call of the turn is answered in ONE user message, in order: the server runs a
    // context's tasks one after another, so they are made one after another too
    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      const t0 = Date.now();
      let out;
      try { out = await callTool(world.client, block.name, block.input); } catch (e) { out = { text: `the call failed: ${e.message}`, isError: true }; }
      calls.push({ name: block.name, input: block.input, is_error: out.isError, ms: Date.now() - t0 });
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { final, stop, turns, calls, usage, ms: Date.now() - started };
}

const world = await startWorld();
const results = [];
try {
  const listed = (await world.client.listTools()).tools;
  // the listed tools as the model receives them: the same name, description and input schema a host
  // passes on — less the combinators at the schema's top (anyOf / allOf / oneOf), which the Messages
  // API does not take there. The server still holds every call to the whole schema, and a call that
  // breaks one of them is refused with its reason, which is what the model reads under any host.
  const TOP_COMBINATORS = new Set(['anyOf', 'allOf', 'oneOf', 'discriminator']);
  const forModel = (schema) => Object.fromEntries(Object.entries(schema).filter(([k]) => !TOP_COMBINATORS.has(k)));
  const tools = listed.map((t) => ({ name: t.name, description: t.description, input_schema: forModel(t.inputSchema) }));
  const system = world.client.getInstructions() || '';
  for (const c of cases) {
    const truth = await truthOf(world.wh, c.answer);
    let run;
    try { run = await runCase(world, tools, system, c); } catch (e) {
      run = { final: '', stop: 'harness_error', turns: 0, calls: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ms: 0, error: e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e?.message || e) };
    }
    const toolCheck = toolsMeet(c.expect, run.calls);
    const answered = run.stop === 'end_turn' && answerStates(c.answer, truth, run.final);
    const r = {
      id: c.id, kind: c.kind, pass: answered && toolCheck.ok, answer_ok: answered, tools_ok: toolCheck.ok, tool_problems: toolCheck.problems,
      truth, stop: run.stop, turns: run.turns, calls: run.calls.length, failed_calls: run.calls.filter((x) => x.is_error).length,
      tools_called: run.calls.map((x) => x.name), usage: run.usage, ms: run.ms, final: run.final, trace: run.calls, ...(run.error ? { error: run.error } : {}),
    };
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${c.kind.padEnd(8)} ${c.id.padEnd(26)} calls=${r.calls} failed=${r.failed_calls} turns=${r.turns} tokens=${r.usage.input + r.usage.output}${r.pass ? '' : `  ${[!answered ? `answer (stop ${r.stop}${r.error ? `: ${r.error}` : ''}) does not state ${JSON.stringify(truth)}` : '', ...toolCheck.problems].filter(Boolean).join('; ')}`}`);
  }
} finally {
  await world.close();
}

const by = (list) => ({
  cases: list.length,
  passed: list.filter((r) => r.pass).length,
  answer_ok: list.filter((r) => r.answer_ok).length,
  tools_ok: list.filter((r) => r.tools_ok).length,
  mean_calls: list.length ? Number((list.reduce((s, r) => s + r.calls, 0) / list.length).toFixed(2)) : 0,
  failed_calls: list.reduce((s, r) => s + r.failed_calls, 0),
  input_tokens: list.reduce((s, r) => s + r.usage.input, 0),
  output_tokens: list.reduce((s, r) => s + r.usage.output, 0),
  cache_read_tokens: list.reduce((s, r) => s + r.usage.cache_read, 0),
});
const summary = { model: MODEL, effort: EFFORT, at: new Date().toISOString(), all: by(results), ...Object.fromEntries(['direct', 'indirect', 'negative'].map((k) => [k, by(results.filter((r) => r.kind === k))])) };
const dir = join(process.cwd(), 'evals', 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${summary.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(`\n${summary.all.passed}/${summary.all.cases} passed (answers ${summary.all.answer_ok}, tools ${summary.all.tools_ok}); mean ${summary.all.mean_calls} calls, ${summary.all.failed_calls} failed; ${summary.all.input_tokens} in / ${summary.all.output_tokens} out tokens\n${file}`);
process.exitCode = summary.all.passed === summary.all.cases ? 0 : 1;
