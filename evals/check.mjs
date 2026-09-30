// npm run eval:check — THE GOLDEN SET HELD TO THE DATA, with no model and no API key.
//
// For every case: its truth is read from the fixture warehouse by its own SQL; a positive case's
// reference path is run through the MCP tools and must reach the same answer (so the case is
// answerable with the tools as they are, and its truth is not a number someone typed); every
// tool the case names must be one the server lists; and the grader must accept a sentence stating
// the truth and refuse one stating something else. A failure here is a broken case or a broken
// tool, found before a paid run would blame the model for it.

import { CASES } from './cases.js';
import { startWorld, runReference, truthOf, referenceAnswer } from './harness.mjs';
import { sameAnswer, answerStates } from './grade.mjs';

const say = (truth) => (typeof truth === 'object' ? Object.entries(truth).map(([k, v]) => `${k}: ${v}`).join(', ') : `The answer is ${truth}.`);
const wrong = (truth) => (typeof truth === 'number' ? `The answer is ${truth + 1000}.` : typeof truth === 'string' ? 'The answer is nothing_like_it.' : 'none: 0');

const world = await startWorld();
let failures = 0;
try {
  const listed = new Set((await world.client.listTools()).tools.map((t) => t.name));
  const seen = new Set();
  for (const c of CASES) {
    const problems = [];
    if (seen.has(c.id)) problems.push('duplicate id');
    seen.add(c.id);
    for (const name of [...(c.expect.any || []), ...(Array.isArray(c.expect.forbid) ? c.expect.forbid : [])]) {
      if (!listed.has(name)) problems.push(`names '${name}', which the server does not list`);
    }
    if (c.kind === 'negative' ? c.answer.kind !== 'none' : !c.ref) problems.push(c.kind === 'negative' ? 'a negative case states no answer' : 'a positive case needs a reference path');
    let truth = null;
    try { truth = await truthOf(world.wh, c.answer); } catch (e) { problems.push(`truth SQL failed: ${e.message}`); }
    if (c.answer.kind !== 'none' && truth != null) {
      if (c.answer.kind === 'number' && !Number.isFinite(truth)) problems.push(`truth is not a number: ${truth}`);
      if (!answerStates(c.answer, truth, say(truth))) problems.push('the grader refuses a sentence stating the truth');
      if (answerStates(c.answer, truth, wrong(truth))) problems.push('the grader accepts a sentence stating something else');
      try {
        const got = referenceAnswer(c.answer, await runReference(world.client, c.ref));
        if (!sameAnswer(c.answer, truth, got)) problems.push(`the reference path gives ${JSON.stringify(got)}, the warehouse ${JSON.stringify(truth)}`);
      } catch (e) { problems.push(`the reference path failed: ${e.message}`); }
    }
    failures += problems.length ? 1 : 0;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.kind.padEnd(8)} ${c.id.padEnd(26)} ${problems.length ? problems.join('; ') : truth == null ? '' : `truth ${JSON.stringify(truth)}`}`);
  }
} finally {
  await world.close();
}
console.log(failures ? `\n${failures} of ${CASES.length} case(s) broken` : `\nall ${CASES.length} cases hold`);
process.exitCode = failures ? 1 : 0;
