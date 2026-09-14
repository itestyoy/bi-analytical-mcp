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

/** Human path: '/control/conversions' → '`control.conversions`'; '' → 'input'. */
function fieldRef(instancePath) {
  if (!instancePath) return 'input';
  return `\`${instancePath.replace(/^\//, '').replace(/\//g, '.')}\``;
}

/** Turn one Ajv error into a plain-English sentence. */
function describe(e) {
  const at = fieldRef(e.instancePath);
  switch (e.keyword) {
    case 'required': return `${at} is missing required property '${e.params.missingProperty}'`;
    case 'additionalProperties': return `${at} has an unexpected property '${e.params.additionalProperty}'`;
    case 'enum': {
      // A long enum is the schema being exact; a long MESSAGE is just noise — name enough to act on.
      const vals = e.params.allowedValues;
      return `${at} must be one of: ${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`;
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
    case 'oneOf': return `${at} must match exactly one of the allowed configurations (provide the fields for exactly one mode)`;
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
  const unions = raw.filter((e) => e.keyword === 'oneOf');
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
  for (const e of narrowUnions(validator.schema, validator.errors || [])) {
    if (e.keyword === 'not' || e.keyword === 'if') continue;
    const msg = describe(e);
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
