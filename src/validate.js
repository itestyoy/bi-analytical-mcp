// ajv-backed validation of tool inputs against the catalog-derived JSON Schemas.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export function makeValidators(schemas) {
  // discriminator:true → for our `metric` unions, errors come from the SELECTED branch
  // only (not every branch), so messages stay focused and actionable.
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  addFormats(ajv);
  const validators = {};
  for (const [tool, schema] of Object.entries(schemas)) {
    validators[tool] = ajv.compile(schema);
  }
  return validators;
}

/**
 * THE SAME FUNCTION, TWO SPELLINGS — because there are two engines underneath. A governed measure
 * is MetricFlow's vocabulary (`average`, the quantile in `percentile`, `field: '*'` for rows); a
 * pipeline stage is SQL's (`avg`, the quantile in `q`, `count` with no column at all). Neither
 * spelling is wrong; each is right in its own path, and a caller that learned one hits a flat
 * refusal in the other.
 *
 * So: the vocabularies stay as they are, and the REFUSAL says which spelling this path uses. The
 * table is symmetric (a → b and b → a) and is consulted only when the name the caller used has a
 * counterpart that IS allowed here — otherwise nothing is added.
 */
const CROSS_PATH_SPELLING = {
  average: 'avg',
  avg: 'average',
  mean: 'average',
  percentile: 'q',
  q: 'percentile',
  quantile: 'q',
  count_distinct: 'count_distinct',
};

/** What this path calls `used`, when it has a name for it at all. */
function otherSpelling(used, allowed) {
  if (typeof used !== 'string') return null;
  const alt = CROSS_PATH_SPELLING[used];
  if (!alt || alt === used) return null;
  return allowed.includes(alt) ? alt : null;
}

/** Read the value the error is about out of the input (ajv reports the path, not the value). */
function valueAt(input, instancePath) {
  let node = input;
  for (const seg of String(instancePath || '').split('/').filter(Boolean)) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/** Human path: '/control/conversions' → '`control.conversions`'; '' → 'input'. */
function fieldRef(instancePath) {
  if (!instancePath) return 'input';
  return `\`${instancePath.replace(/^\//, '').replace(/\//g, '.')}\``;
}

/** Turn one Ajv error into a plain-English sentence. `ctx` = { input, schema } for the hints. */
function describe(e, ctx = {}) {
  const at = fieldRef(e.instancePath);
  switch (e.keyword) {
    case 'required': return `${at} is missing required property '${e.params.missingProperty}'`;
    case 'additionalProperties': {
      const used = e.params.additionalProperty;
      // A field this path spells differently: say its name here rather than only that it is unknown.
      const node = ctx.schema ? atPointer(ctx.schema, e.schemaPath.replace(/\/additionalProperties$/, '')) : null;
      const alt = otherSpelling(used, Object.keys(node?.properties || {}));
      return `${at} has an unexpected property '${used}'${alt ? ` — here that field is called '${alt}' (${used} is the other path's spelling)` : ''}`;
    }
    case 'enum': {
      // A long enum is the schema being exact; a long MESSAGE is just noise — name enough to act on.
      const vals = e.params.allowedValues;
      // A ONE-value enum is a pinned value (a discriminator: which stage, which action, which
      // source). "must be one of: python" reads like a list that lost its other items.
      if (vals.length === 1) return `${at} must be ${JSON.stringify(vals[0])}`;
      const used = valueAt(ctx.input, e.instancePath);
      const alt = otherSpelling(used, vals);
      return `${at} must be one of: ${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`
        + (alt ? `. Here '${used}' is spelled '${alt}' — '${used}' is the other path's spelling of the same function` : '');
    }
    case 'const': return `${at} must be ${JSON.stringify(e.params.allowedValue)}`;
    case 'type': return `${at} must be ${Array.isArray(e.params.type) ? e.params.type.join(' or ') : e.params.type}`;
    case 'minimum': return `${at} must be >= ${e.params.limit}`;
    case 'maximum': return `${at} must be <= ${e.params.limit}`;
    case 'exclusiveMinimum': return `${at} must be > ${e.params.limit}`;
    case 'exclusiveMaximum': return `${at} must be < ${e.params.limit}`;
    case 'minItems': return `${at} must have at least ${e.params.limit} item${e.params.limit === 1 ? '' : 's'}`;
    case 'maxItems': return `${at} must have at most ${e.params.limit} item${e.params.limit === 1 ? '' : 's'}`;
    case 'discriminator':
      // 'mapping' = the tag has an unrecognized value; 'tag' missing is already
      // reported by the sibling `required` error, so drop it as a duplicate.
      return e.params?.error === 'mapping'
        ? `\`${e.params.tag}\` value ${JSON.stringify(e.params.tagValue)} is not a recognized ${e.params.tag}`
        : null;
    case 'oneOf':
    case 'anyOf': return `${at} must match exactly one of the allowed configurations (provide the fields for exactly one mode)`;
    case 'oneOfNamed': return `${at} must be exactly one of: ${e.params.names.join(' | ')}`;
    default: return `${at} ${e.message}`;
  }
}

/** Resolve a `#/a/b` schema pointer against the compiled schema. */
function atPointer(schema, pointer) {
  let node = schema;
  for (const seg of String(pointer).replace(/^#\/?/, '').split('/').filter(Boolean)) {
    node = node?.[seg];
    if (node === undefined) return undefined;
  }
  return node;
}

/** What a branch of a union is CALLED, for "expected one of: …". */
function branchTitle(branch, i) {
  return branch?.title || String(branch?.description || `option ${i + 1}`).split(/[:.]/)[0].trim();
}

/**
 * A union reports every branch's complaints at once, which reads as noise: with a dozen modes the
 * caller gets a dozen "missing required property" lines for modes they never meant. Keep the
 * branch the input came CLOSEST to — the one it satisfied the most of — and say which modes exist.
 */
function narrowUnions(schema, raw) {
  // `oneOf` and `anyOf` are the same thing to a caller: a set of named modes, one of which the
  // input was meant to be. (Every union in these schemas has CLOSED branches, so the two keywords
  // also reject the same inputs — see semanticIndexSchema.)
  const unions = raw.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf');
  if (!unions.length) return raw;
  let kept = raw;
  for (const u of unions) {
    const base = `${u.schemaPath}/`;
    const inBranch = kept.filter((e) => e.schemaPath.startsWith(base));
    if (!inBranch.length) continue;
    const byBranch = new Map();
    for (const e of inBranch) {
      const i = Number(e.schemaPath.slice(base.length).split('/')[0]);
      if (!Number.isInteger(i)) continue;
      (byBranch.get(i) || byBranch.set(i, []).get(i)).push(e);
    }
    if (!byBranch.size) continue;
    // Closest = the branch the input most nearly IS. A missing required field means the caller did
    // not name this mode at all; a field the branch does not know means the same, slightly weaker;
    // a bad enum/const value means they DID name it and got the value wrong — that is the message
    // worth showing, so it costs least.
    // `type` is the same signal as a missing required field: the input is not even shaped like
    // this branch, so it is not the branch the caller meant.
    const weight = (e) => ({ required: 10, type: 6, additionalProperties: 6 }[e.keyword] ?? 1);
    const score = (es) => es.reduce((n, e) => n + weight(e), 0);
    const best = [...byBranch.entries()].sort((a, b) => score(a[1]) - score(b[1]))[0];
    const branches = atPointer(schema, u.schemaPath) || [];
    const names = [...new Set(branches.map(branchTitle).filter(Boolean))];
    const label = { ...u, keyword: 'oneOfNamed', params: { names } };
    kept = [...kept.filter((e) => !e.schemaPath.startsWith(base) && e !== u), label, ...best[1]];
  }
  return kept;
}

export function validateInput(validator, input) {
  const ok = validator(input);
  if (ok) return { ok: true };
  // Drop XOR-internal noise ('not'/'if'), render each error as a sentence, de-duplicate.
  const seen = new Set();
  const errors = [];
  const ctx = { input, schema: validator.schema };
  for (const e of narrowUnions(validator.schema, validator.errors || [])) {
    if (e.keyword === 'not' || e.keyword === 'if') continue;
    const msg = describe(e, ctx);
    if (msg && !seen.has(msg)) { seen.add(msg); errors.push(msg); }
  }
  if (errors.length === 0) errors.push('input did not match the expected shape');
  return { ok: false, errors };
}

export class ToolError extends Error {
  constructor(message, { stage = 'validate', field } = {}) {
    super(message);
    this.name = 'ToolError';
    this.stage = stage;
    this.field = field;
  }
}
