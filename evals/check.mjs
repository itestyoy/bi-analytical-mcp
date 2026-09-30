// npm run eval:check — THE GOLDEN SET HELD TO THE DATA, with no model and no API key.
//
// For every case:
//   * its truth is read from the fixture warehouse by its own SQL — an empty result or a NULL is a
//     broken case, never a zero;
//   * its decoy (the answer of the obvious wrong reading) is read the same way and must DIFFER from
//     the truth — every indirect case has one;
//   * its reference path is run through the MCP tools, in a world of its own like a paid run's, and
//     must reach the truth — so the case is answerable with the tools as they are;
//   * every tool it names is one the server lists;
//   * the grader accepts an answer line stating the truth and refuses one stating the decoy (and, for
//     a number, one that mentions the truth on the way but states something else).
// A failure here is a broken case or a broken tool, found before a paid run would blame the model.

import { CASES } from './cases.js';
import { startEval, runReference, truthOf, valueOf, referenceAnswer } from './harness.mjs';
import { sameAnswer, answerStates } from './grade.mjs';

/** An answer line stating `value`, the way the prompt asks for it. */
const stating = (value) => `Answer: ${typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}=${v}`).join(', ') : value}`;

async function problemsOf(evalRun, listed, c) {
  const problems = [];
  for (const name of [...(c.expect.any || []), ...(Array.isArray(c.expect.forbid) ? c.expect.forbid : [])]) {
    if (!listed.has(name)) problems.push(`names '${name}', which the server does not list`);
  }
  if (c.kind === 'negative') {
    if (c.answer.kind !== 'none') problems.push('a negative case states no answer');
    if (!answerStates(c.answer, null, 'Answer: none')) problems.push('the grader refuses "Answer: none"');
    if (answerStates(c.answer, null, 'Answer: 42')) problems.push('the grader accepts a number stated for a question with no answer');
    return { problems, truth: null };
  }
  if (!c.ref) problems.push('a positive case needs a reference path');
  if (c.kind === 'indirect' && !c.decoy) problems.push('an indirect case needs a decoy — choosing the metric is what it tests');
  const truth = await truthOf(evalRun.wh, c.answer);
  const decoy = c.decoy ? await valueOf(evalRun.wh, c.answer.kind, c.decoy.sql) : null;
  if (decoy !== null && sameAnswer(c.answer, truth, decoy)) problems.push(`the decoy gives the truth too (${JSON.stringify(decoy)}) — the case cannot tell the right metric from the wrong one`);
  if (!answerStates(c.answer, truth, stating(truth), { decoy })) problems.push('the grader refuses the truth');
  if (decoy !== null && answerStates(c.answer, truth, stating(decoy), { decoy })) problems.push('the grader accepts the decoy');
  if (c.answer.kind === 'number' && answerStates(c.answer, truth, `${truth} of them were counted first.\n${stating(truth + 1)}`)) problems.push('the grader accepts the truth mentioned on the way to another stated answer');
  if (c.ref) {
    const world = await evalRun.caseWorld();
    try {
      const got = referenceAnswer(c.answer, await runReference(world.client, c.ref));
      if (!sameAnswer(c.answer, truth, got)) problems.push(`the reference path gives ${JSON.stringify(got)}, the warehouse ${JSON.stringify(truth)}`);
    } finally {
      await world.close();
    }
  }
  return { problems, truth, decoy };
}

const evalRun = await startEval();
let failures = 0;
try {
  const probe = await evalRun.caseWorld();
  let listed;
  try { listed = new Set((await probe.client.listTools()).tools.map((t) => t.name)); } finally { await probe.close(); }
  const ids = new Set();
  for (const c of CASES) {
    let r;
    try { r = await problemsOf(evalRun, listed, c); } catch (e) { r = { problems: [e.message], truth: null }; }
    if (ids.has(c.id)) r.problems.push('duplicate id');
    ids.add(c.id);
    failures += r.problems.length ? 1 : 0;
    const shown = r.truth == null ? '' : `truth ${JSON.stringify(r.truth)}${r.decoy != null ? `, decoy ${JSON.stringify(r.decoy)}` : ''}`;
    console.log(`${r.problems.length ? 'FAIL' : 'ok  '} ${c.kind.padEnd(8)} ${c.id.padEnd(24)} ${r.problems.length ? r.problems.join('; ') : shown}`);
  }
  for (const kind of ['direct', 'indirect', 'negative']) {
    if (!CASES.some((c) => c.kind === kind)) { failures++; console.log(`FAIL the set has no ${kind} case`); }
  }
} finally {
  await evalRun.close();
}
console.log(failures ? `\n${failures} problem(s) in the golden set` : `\nall ${CASES.length} cases hold`);
process.exitCode = failures ? 1 : 0;
