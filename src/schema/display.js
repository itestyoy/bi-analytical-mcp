// THE CARD A RESULT IS DRAWN AS — display_model_result's `display`: closed forms tagged by `kind`,
// naming the result's COLUMNS; what a form needs is said by the schema itself (required fields,
// bounds, enums — and a second form where a field changes what the others may be, as a split by
// `series_column` does). Whether the rows fit it is checked at the call (src/display-check.js).

// HOW A RESULT IS SHOWN — declared by the caller, never guessed: the card display_model_result draws in
// a host that renders MCP Apps follows this when it is given. Every form
// is one closed branch tagged by `kind`, and what a form needs is said by the schema itself —
// required fields, array bounds, enums — not in prose. It names result
// COLUMNS (the names the rows come back with), so a wrong one is refused with the list. The forms are
// an `anyOf` (src/schema-kit.js says why): each closed and told apart by `kind`, exactly one matches.
export const resultColumn = { type: 'string', minLength: 1, description: 'A column of THIS result, exactly as the rows come back: a metric name, <model>_<attribute>, metric_time_<grain>, or a pipeline column.' };

export const cardTitle = { type: 'string', maxLength: 120, description: 'Card title, in the person\'s words (e.g. "Onboarding funnel, Sep 1–23").' };

export const valueColumns = (what) => ({ type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: resultColumn, description: `The value column(s): one ${what} each.` });

export const seriesColumn = (what) => ({ ...resultColumn, description: `Split the ONE y column into a ${what} per value of this column (e.g. users_platform).` });

/**
 * A chart that may be split by a column, as its two forms: value columns side by side, or ONE value
 * column split into a series per value of `series_column` — a split names one value column, and the
 * schema says so by the form, not by a sentence.
 */
export const splittable = (kind, title, description, properties, required) => {
  const { series_column: series, ...rest } = properties;
  return [
    form(kind, title, description, rest, required),
    form(kind, `${title}, split by a column`, `${description} Split: ONE value column, a series per value of series_column.`, { ...rest, y: { ...rest.y, maxItems: 1 }, series_column: series }, [...required, 'series_column']),
  ];
};

export const axis = { ...resultColumn, description: 'The axis column: time is put in time order, any other column keeps the row order.' };

// a chart the person can drill into: the dimensions a clicked point, bar or slice opens into
export const drill = {
  type: 'object', additionalProperties: false, required: ['levels'],
  description: 'Let the person drill down: a click on a bar, slice or point offers these dimensions, and the chart is redrawn filtered to what was clicked and broken down by the one chosen — then again, one level deeper, with the ones left. Reads a stored result (materialize: true, or a pipeline build) whose rows carry these columns too (group the query by them as well); the chart is drawn from it folded over them. Each view re-aggregates with `agg`: sums and counts add up, but a distinct count, an average or a ratio does not (a user in two platforms counts twice) — be careful with non-additive metrics.',
  properties: {
    levels: { type: 'array', minItems: 1, maxItems: 5, description: 'The dimensions offered, in the order the menu lists them.', items: { type: 'object', additionalProperties: false, required: ['column'], properties: { column: resultColumn, label: { type: 'string', maxLength: 40, description: 'How the dimension reads in the menu (default: the column name).' } } } },
    agg: { enum: ['sum', 'count', 'min', 'max', 'avg'], default: 'sum', description: 'How the rows under a view fold into its values.' },
  },
};

export const form = (kind, title, description, properties, required, extra = {}) => ({
  title, description, type: 'object', additionalProperties: false,
  required: ['kind', ...required],
  properties: { kind: { const: kind }, title: cardTitle, ...properties },
  ...extra,
});

// a tile, in two forms: a number or a percent, and a currency value — the one that takes a currency code
const tileFields = {
  column: resultColumn,
  label: { type: 'string', maxLength: 60, description: 'How the number reads to the person (default: the column name).' },
  previous_column: { ...resultColumn, description: 'A column with the value to compare against (the previous period).' },
  good: { enum: ['up', 'down'], description: 'Which direction of change is good — colors the change. Omitted: shown without judgement.' },
};
const kpiTile = {
  type: 'object',
  anyOf: [
    { title: 'a number or a percent', type: 'object', additionalProperties: false, required: ['column'], properties: { ...tileFields, format: { enum: ['number', 'percent'], default: 'number', description: 'percent: the value is a ratio (0.123 → 12.3%).' } } },
    { title: 'a currency value', type: 'object', additionalProperties: false, required: ['column', 'format'], properties: { ...tileFields, format: { const: 'currency', description: 'A money amount, in `currency`.' }, currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'USD', description: 'ISO 4217 code.' } } },
  ],
};

export const display = {
  description: 'How the card draws the rows. Pick the `kind` whose description matches the question; the card draws exactly that, in the declared order. It names result columns and changes no numbers. Omitted: the card follows the rows\' shape.',
  anyOf: [
    ...splittable('line', 'line — a trend', 'A TREND over an ordered axis (usually time): one line, or several to compare series.', {
      x: axis, y: valueColumns('line'), series_column: seriesColumn('line'), drill,
    }, ['x', 'y']),
    ...splittable('area', 'area — a total split into parts over time', 'A composition OVER time: series that add up to one total, stacked (DAU by platform). Series that do not add up → line.', {
      x: axis, y: valueColumns('band'), series_column: seriesColumn('band'), drill,
    }, ['x', 'y']),
    ...splittable('bar', 'bar — a comparison across categories', 'A COMPARISON across categories, in row order: a bar per category, several per category (grouped), or stacked into one (part-to-whole per category).', {
      x: { ...resultColumn, description: 'The category column.' },
      y: valueColumns('bar per category'),
      series_column: seriesColumn('bar within each category'),
      stacked: { type: 'boolean', default: false, description: 'Stack the bars of a category into one instead of grouping them side by side.' },
      horizontal: { type: 'boolean', description: 'Lay the bars flat. Omitted: flat past 8 categories.' },
      drill,
    }, ['x', 'y']),
    form('pie', 'pie — shares of one total', 'A PART-TO-WHOLE at a glance, drawn as a donut: a slice per row. For a few clearly different shares — close values read better as bars. Past 6 slices the smallest fold into "Other".', {
      label_column: { ...resultColumn, description: 'The column naming each slice.' },
      value_column: { ...resultColumn, description: 'The column with each slice\'s amount (non-negative).' },
      drill,
    }, ['label_column', 'value_column']),
    form('funnel', 'funnel — ordered steps', 'ORDERED STEPS and how many reach each, with the conversion between them — a straight funnel, one with OUTCOMES (a step split into what became of it: a successful and a failed load, both of the attempts; each step a share of its parent), and one funnel per segment side by side (series_column).', {
      steps: {
        description: 'The steps, in order — as COLUMNS of a one-row result, or as ROWS (one per step).',
        anyOf: [
          { title: 'steps are columns of one row', type: 'array', minItems: 2, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['column'], properties: { column: resultColumn, label: { type: 'string', maxLength: 60, description: 'How the step reads to the person (default: the column name).' }, parent: { ...resultColumn, description: 'The step (the column of one listed before it) this step is a share of — its outcome: loads_ok and loads_failed both with parent attempts, shows with parent loads_ok. Omitted: the step before it.' } } } },
          { title: 'one row per step', type: 'object', additionalProperties: false, required: ['label_column', 'value_column'], properties: { label_column: { ...resultColumn, description: 'The column naming each step.' }, value_column: { ...resultColumn, description: 'The column with each step\'s count.' }, parent_column: { ...resultColumn, description: 'The column naming each row\'s parent step (a label of a row before it; empty: the step before it) — for a funnel with outcomes.' } } },
        ],
      },
      series_column: { ...resultColumn, description: 'One funnel per value of this column, side by side (a funnel per ad format). Steps as columns: a row per value, all on the same steps. Steps as rows: each value\'s funnel is its own rows, so one may have steps another lacks (a banner with no load step) — no zeros are drawn for them.' },
    }, ['steps']),
    form('kpi', 'kpi — headline numbers', 'HEADLINE NUMBERS as stat tiles: a big value, its change against a previous value. One row, or with x a series whose last row is shown with its trend. A single number beats any chart.', {
      x: { ...axis, description: 'The axis of a multi-row result: each tile shows the LAST row, its change from the row before, and the trend as a sparkline.' },
      values: {
        type: 'array', minItems: 1, maxItems: 4, description: 'The tiles, in order.',
        items: kpiTile,
      },
    }, ['values']),
    form('pivot', 'pivot — a table to drill into', 'A table to drill into, level by level: the card shows the top level, and each row expands into the next level ON demand — read from the stored result, filtered to that row — so the detail is never loaded all at once. Reads a stored result (a query run with materialize: true, or a pipeline build). Each level re-aggregates the rows under it with the value\'s agg: sum, count, min and max fold honestly, but a distinct count, an average or a ratio does not add up across levels (a user present in two children counts twice) — be careful with non-additive metrics: prefer additive columns (counts, sums, the numerator and denominator of a ratio) as the values.', {
      levels: {
        type: 'array', minItems: 1, maxItems: 5, description: 'The dimension columns, from the top level down.',
        items: { type: 'object', additionalProperties: false, required: ['column'], properties: { column: resultColumn, label: { type: 'string', maxLength: 40, description: 'How the level reads to the person — short, it names a column and each opened row (default: the column name).' } } },
      },
      values: {
        type: 'array', minItems: 1, maxItems: 6, description: 'The value columns, each re-aggregated per level.',
        items: {
          type: 'object', additionalProperties: false, required: ['column'],
          properties: {
            column: resultColumn,
            agg: { enum: ['sum', 'count', 'min', 'max', 'avg'], default: 'sum', description: 'How the rows under a level fold into its value.' },
            label: { type: 'string', maxLength: 60, description: 'How the value reads to the person (default: the column name).' },
            format: { enum: ['number', 'percent', 'currency'], default: 'number' },
            currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'USD' },
          },
        },
      },
    }, ['levels', 'values']),
    form('sankey', 'sankey — flows between stages', 'FLOWS between stages: a row per link, source → target with an amount (installs from channel to platform). Links chain — a target can be the next source — and never loop back.', {
      source_column: { ...resultColumn, description: 'The column naming where a flow starts.' },
      target_column: { ...resultColumn, description: 'The column naming where it goes.' },
      value_column: { ...resultColumn, description: 'The column with the amount that flows (positive).' },
    }, ['source_column', 'target_column', 'value_column']),
  ],
};
