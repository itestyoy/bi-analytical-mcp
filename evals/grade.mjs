// GRADING A RUN — pure functions over what a run produced: whether a reference path reached the
// truth, whether a final answer written in words states it, and whether the tools called meet the
// case's expectation. No warehouse, no model: test/unit/eval-grade.test.js holds them.

export function sameAnswer(answer, truth, got, tolerance = answer.tolerance ?? 1e-6) {
  if (answer.kind === 'number') return Number.isFinite(got) && Math.abs(got - truth) <= tolerance;
  if (answer.kind === 'label') return String(got) === String(truth);
  if (answer.kind === 'map') {
    const keys = Object.keys(truth);
    return keys.length === Object.keys(got || {}).length && keys.every((k) => Math.abs((got[k] ?? NaN) - truth[k]) <= tolerance);
  }
  return true;
}

// ── grading a final answer written in words ────────────────────────────────────────────────────

/** Every number written in a text (1,234.50 and $85 alike). */
export function numbersIn(text) {
  return [...String(text).matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

const mentions = (text, word) => new RegExp(`(^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`, 'i').test(text);

/** Whether a final answer states the truth: the number, the label, or every key with its value. */
export function answerStates(answer, truth, text, tolerance = Math.max(answer.tolerance ?? 0, 0.005)) {
  if (answer.kind === 'none') return true;
  const nums = numbersIn(text);
  const hasNumber = (x) => nums.some((n) => Math.abs(n - x) <= tolerance);
  if (answer.kind === 'number') return hasNumber(truth);
  if (answer.kind === 'label') return mentions(text, truth);
  if (answer.kind === 'map') return Object.entries(truth).every(([k, v]) => mentions(text, k) && hasNumber(v));
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
