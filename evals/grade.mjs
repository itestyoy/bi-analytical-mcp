// GRADING A RUN — pure functions over what a run produced: whether a reference path reached the
// truth, whether the final answer states it, and whether the tools called meet the case's
// expectation. They are proven against the warehouse's own values by `npm run eval:check` (each
// case's truth accepted, its decoy refused).
//
// WHAT IS GRADED IS THE STATED ANSWER, NOT EVERY NUMBER IN THE REPLY. Each question asks the model to
// end with one `Answer:` line (ANSWER_FORMAT, appended to every prompt alike), and only that line is
// read: a reply that mentions the truth on the way ("12 players started a level; 9 completed one")
// but states something else is wrong. A map is read as pairs (`control=6, variant_b=1`), so a value
// is held to its own key, never to whichever key happens to be near it.

export const ANSWER_FORMAT = 'End your reply with one line that starts with "Answer:" and states the result alone — a number, a name, or for several groups "Answer: <group>=<value>, <group>=<value>". If the data cannot answer the question, write "Answer: none".';

/** The stated answer: what follows the last `Answer:` line of a reply (bold or code marks allowed), or null. */
export function answerLine(text) {
  const lines = [...String(text).matchAll(/^[\s>*#-]*answer[\s*]*:[\s*]*(.*)$/gim)];
  // bold and code marks go; an underscore stays — it is part of a name (variant_b)
  return lines.length ? lines[lines.length - 1][1].replace(/[*`]+/g, '').trim() : null;
}

// a number stands on its own: not a digit of a name (p3, step_1) or the tail of a date (2026-01-01)
const NUMBER = /(?<![\w.-])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w-])/g;

/** Every number written in a text: 1,234.50 and $85 alike, not the 3 of p3 or the 01 of a date. */
export function numbersIn(text) {
  return [...String(text).matchAll(NUMBER)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, word) => new RegExp(`(^|[^A-Za-z0-9_])${escape(word)}($|[^A-Za-z0-9_])`, 'i').test(text);

/** The `<key>=<value>` (or `<key>: <value>`) pairs of an answer line. */
export function pairsIn(line) {
  return Object.fromEntries([...String(line).matchAll(/([A-Za-z_][\w.-]*)\s*[=:]\s*\$?(-?\d[\d,]*(?:\.\d+)?)/g)].map((m) => [m[1].toLowerCase(), Number(m[2].replace(/,/g, ''))]));
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

/** Whether two values of an answer's kind are the same answer. */
export function sameAnswer(answer, a, b, tolerance = answer.tolerance ?? 1e-6) {
  if (answer.kind === 'number') return Number.isFinite(b) && near(a, b, tolerance);
  if (answer.kind === 'label') return String(a) === String(b);
  if (answer.kind === 'map') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b || {}).length && keys.every((k) => near(b[k] ?? NaN, a[k], tolerance));
  }
  return true;
}

/**
 * Whether a reply's stated answer is the truth: its first number (number), the label named and no
 * other the case knows to be wrong (label), exactly the truth's pairs (map). A case with nothing to
 * state passes when no number is stated.
 */
export function answerStates(answer, truth, text, { decoy = null, tolerance = Math.max(answer.tolerance ?? 0, 0.005) } = {}) {
  const line = answerLine(text);
  if (answer.kind === 'none') return line === null || !numbersIn(line).length;
  if (line === null) return false;
  if (answer.kind === 'number') {
    const [first] = numbersIn(line);
    return first !== undefined && near(first, truth, tolerance);
  }
  if (answer.kind === 'label') return mentions(line, truth) && !(decoy != null && decoy !== truth && mentions(line, decoy));
  if (answer.kind === 'map') {
    const got = pairsIn(line);
    const want = Object.fromEntries(Object.entries(truth).map(([k, v]) => [k.toLowerCase(), v]));
    return sameAnswer({ kind: 'map' }, want, got, tolerance);
  }
  return false;
}

/** Whether the tools a run called meet the case's expectation. */
export function toolsMeet(expect, calls) {
  const names = calls.map((c) => c.name);
  const problems = [];
  if (expect.forbid === '*' && names.length) problems.push(`no tool expected, called ${[...new Set(names)].join(', ')}`);
  if (Array.isArray(expect.forbid)) {
    const bad = [...new Set(names.filter((n) => expect.forbid.includes(n)))];
    if (bad.length) problems.push(`called ${bad.join(', ')}`);
  }
  if (expect.any && !names.some((n) => expect.any.includes(n))) problems.push(`none of ${expect.any.join(', ')} was called`);
  if (expect.max_calls && names.length > expect.max_calls) problems.push(`${names.length} calls, over the budget of ${expect.max_calls}`);
  return { ok: !problems.length, problems };
}
