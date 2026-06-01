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
    case 'enum': return `${at} must be one of: ${e.params.allowedValues.join(', ')}`;
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
    default: return `${at} ${e.message}`;
  }
}

export function validateInput(validator, input) {
  const ok = validator(input);
  if (ok) return { ok: true };
  // Drop XOR-internal noise ('not'/'if'), render each error as a sentence, de-duplicate.
  const seen = new Set();
  const errors = [];
  for (const e of validator.errors || []) {
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
