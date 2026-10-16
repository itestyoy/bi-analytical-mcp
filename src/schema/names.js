// THE NAME PATTERNS A REFUSAL SAYS IN WORDS — kept apart from the schema pieces (src/schema/fields.js) so
// the validator (src/validate.js) reads them without importing the schema it checks.

/** A name the semantic layer stores as it is written — a metric's, a measure's, a computed dimension's:
 *  MetricFlow's rule (a lowercase letter first, at least two characters, no `__`, no `_` at the end). */
export const SEMANTIC_NAME = '^[a-z](_?[a-z0-9]){1,39}$';

/** What a pattern asks for, in the words a refusal uses instead of the expression itself. */
export const PATTERN_SAYS = {
  [SEMANTIC_NAME]: 'a name the semantic layer takes: lowercase letters, digits and single underscores, a letter first, at least 2 characters, no "__" and no "_" at the end (e.g. "revenue_per_payer")',
};
