// ajv-backed validation of tool inputs against the catalog-derived JSON Schemas.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export function makeValidators(schemas) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = {};
  for (const [tool, schema] of Object.entries(schemas)) {
    validators[tool] = ajv.compile(schema);
  }
  return validators;
}

export function validateInput(validator, input) {
  const ok = validator(input);
  if (ok) return { ok: true };
  const errors = (validator.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
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
