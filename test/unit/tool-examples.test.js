// EVERY EXAMPLE CALL A DESCRIPTION WRITES IS A CALL THE TOOL TAKES. Input-validation guard: each of
// EXAMPLES (src/tools/core.js), its `<placeholders>` filled from the catalog, validates against the
// schema its tool publishes — and is what the description shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { CORE_TOOLS, EXAMPLES, callText } from '../../src/tools/core.js';

for (const file of ['config/catalog.yml', 'test/integration/fixtures/catalog.yml']) {
  const catalog = loadCatalog(join(process.cwd(), file));
  const validators = makeValidators(buildSchemas(catalog));
  const fact = catalog.facts[0];
  const fill = (v) => JSON.parse(JSON.stringify(v)
    .replaceAll('<events source>', fact)
    .replaceAll('<event-name column>', catalog.eventNameColumn(fact))
    .replaceAll('<context_id>', 'abcdef123456'));
  for (const [tool, examples] of Object.entries(EXAMPLES)) {
    test(`${file}: the example calls in ${tool}'s description validate`, () => {
      for (const example of [].concat(examples)) {
        const r = validateInput(validators[tool], fill(example));
        assert.ok(r.ok, JSON.stringify(r.errors));
        assert.ok(CORE_TOOLS.find((t) => t.name === tool).description.includes(callText(example)), 'the description shows it');
      }
    });
  }
}
