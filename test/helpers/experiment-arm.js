// A recipe's experiment block says how one row of its pipeline becomes a group of the experiment tool:
// `group_field` is the column that names the group, and `arm` is the group as the tool takes it, each
// value the column that holds it (nested where the tool nests — a ratio's numerator, a CUPED covariate).

/** The `arm` template filled from one row: every column it names read as a number. */
function fill(template, row) {
  return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, typeof v === 'string' ? Number(row[v]) : fill(v, row)]));
}

/** One row of a recipe's per-group table → the experiment tool's group: its label and its arm's fields. */
export function armFrom(map, row) {
  return { label: String(row[map.group_field]), ...fill(map.arm, row) };
}
