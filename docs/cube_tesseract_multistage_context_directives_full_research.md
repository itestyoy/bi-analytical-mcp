# Tesseract Multi-Stage Context Directives: `filter` and `grain`

## Purpose of this document

This document describes the final feature behavior as documentation, not as a PR summary.

It explains how multi-stage context directives work in Cube/Tesseract, how they affect SQL generation, what business tasks they solve, and how different options change intermediate CTEs, `WHERE`, `GROUP BY`, `PARTITION BY`, join strategy, and result broadcasting.

The document focuses on the final model:

```yaml
filter:
  mode: relative | fixed
  exclude:
  keep_only:
  include:

grain:
  exclude:
  keep_only:
  include:
```

Legacy naming is intentionally not used in the main explanation.

---

# 1. Executive summary

Multi-stage measures are evaluated through one or more intermediate SQL stages, usually rendered as CTEs.

A normal measure is calculated directly at the query grain:

```sql
SELECT
  country,
  category,
  SUM(revenue)
FROM orders
WHERE status = 'completed'
GROUP BY country, category
```

A multi-stage measure can change the context of its inner calculation before producing SQL.

That context has two main parts:

| Context part | Controlled by | SQL affected |
|---|---|---|
| Which rows are visible | `filter` | `WHERE`, filter predicates, segments |
| At what level rows are aggregated | `grain` | `GROUP BY`, `PARTITION BY`, join keys |

The high-level pipeline is:

```text
Parent query state
        ↓
select base filter state: current or root
        ↓
apply filter directives
        ↓
apply grain directives
        ↓
apply time shift / rolling-window transformations
        ↓
build child CTE
        ↓
join / broadcast result back to parent grain
```

This enables metrics such as:

- percent of total;
- percent of parent;
- share of category / country / region;
- benchmark against a broader population;
- ARPU and per-user nested calculations;
- average of per-user values;
- ranking within a selected partition;
- cohort and retention metrics;
- fixed-baseline comparisons;
- calculations that ignore some dashboard filters but keep others.

---

# 2. Core mental model

A user query creates a `QueryProperties`-like state.

Example query:

```sql
SELECT
  country,
  category,
  SUM(revenue)
FROM orders
WHERE
  status = 'completed'
  AND region = 'EU'
GROUP BY
  country,
  category
```

Conceptual state:

```text
State
├── dimensions
│   ├── country
│   └── category
├── time_dimensions
│   └── optional time grain, e.g. created_at.month
├── filters
│   ├── status = completed
│   └── region = EU
└── segments
    └── optional segment filters
```

A multi-stage node does not blindly reuse this state. It receives a parent state, modifies it, and asks the regular query planner to build a CTE from the modified state.

Conceptually:

```python
def plan_multi_stage_node(member, parent_state):
    state = parent_state.copy()

    state = apply_filter_directive(member.filter, state)
    state = apply_grain_directive(member.grain, state)
    state = apply_time_shift(member.time_shift, state)

    return build_cte(member, state)
```

The important part is that every stage can use a different state than the outer query.

---

# 3. Root state vs parent/current state

The planner keeps two different state concepts.

## Root state

The root state is the original query context. It is created once before recursive multi-stage planning starts.

It contains:

- original dimensions;
- original time dimensions;
- original dimension filters;
- original time filters;
- original segments.

For CTE planning, measure filters are intentionally not propagated into the root CTE state.

Conceptually:

```python
root_state = QueryProperties(
    dimensions=query.dimensions,
    time_dimensions=query.time_dimensions,
    dimension_filters=query.dimension_filters,
    time_dimension_filters=query.time_dimension_filters,
    segments=query.segments,
    order_by=[],
)
```

## Parent/current state

The parent state is the state inherited from the stage above the current stage.

If a parent stage already changed grain or filters, the child sees those modifications unless `filter.mode: fixed` is used.

```text
Root query state
      ↓
Stage A modifies filters/grain
      ↓
Stage B receives modified parent state
```

---

# 4. `filter` directive

The `filter` directive controls which rows participate in the stage calculation.

It affects:

- dimension filters;
- time dimension filters;
- measure filters;
- segments.

It does not directly change grouping. Grouping is controlled by `grain`.

## Syntax

```yaml
measures:
  - name: amount_without_status_filter
    type: number
    multi_stage: true
    sql: "{CUBE.total_amount}"

    filter:
      mode: relative
      exclude:
        - orders.status
```

Or with included predicates:

```yaml
filter:
  include:
    - member: orders.status
      operator: equals
      values: [completed]
```

Nested boolean groups are also supported:

```yaml
filter:
  include:
    - or:
        - member: orders.status
          operator: equals
          values: [completed]
        - member: orders.status
          operator: equals
          values: [pending]
```

---

# 5. `filter.mode`

`mode` decides which state is used as the base before applying `exclude`, `keep_only`, and `include`.

## `mode: relative`

This is the default behavior.

The stage starts from the current parent state.

```text
parent_state
    ↓
apply filter.exclude / keep_only / include
    ↓
child_state
```

Pseudo-code:

```python
if filter.mode is None or filter.mode == "relative":
    state = parent_state.copy()
```

Use it when a nested stage should respect modifications made by its parent.

## `mode: fixed`

The stage starts from root query state.

```text
root_state
    ↓
apply filter.exclude / keep_only / include
    ↓
child_state
```

Pseudo-code:

```python
if filter.mode == "fixed":
    state = root_state.copy()
```

Use it when a nested calculation must ignore intermediate parent-stage modifications and return to the original dashboard context.

## Why `fixed` matters

Suppose we have a chain:

```yaml
measures:
  - name: completed_books_amount
    sql: "{CUBE.books_amount}"
    multi_stage: true
    filter:
      include:
        - member: orders.status
          operator: equals
          values: [completed]

  - name: books_amount
    sql: "{CUBE.total_amount}"
    multi_stage: true
    filter:
      mode: relative
      include:
        - member: orders.category
          operator: equals
          values: [books]
```

With `relative`, the inner `books_amount` sees the parent `status = completed` filter and adds `category = books`.

Result:

```sql
WHERE status = 'completed'
  AND category = 'books'
```

If the inner measure uses `mode: fixed`:

```yaml
filter:
  mode: fixed
  include:
    - member: orders.category
      operator: equals
      values: [books]
```

Then it starts again from the root query state, not the parent state.

If the root query did not have `status = completed`, the inner stage will only apply:

```sql
WHERE category = 'books'
```

This is why a fixed nested stage can diverge from a relative nested stage.

---

# 6. `filter.exclude`

`filter.exclude` removes filters that target the listed members.

Example:

```yaml
filter:
  exclude:
    - orders.status
```

Outer query:

```sql
WHERE
  status = 'completed'
  AND region = 'EU'
```

Stage state after `exclude`:

```sql
WHERE
  region = 'EU'
```

The stage now sees all statuses, but still respects region.

## SQL effect

Before:

```sql
WITH stage AS (
  SELECT
    category,
    SUM(amount) AS amount
  FROM orders
  WHERE status = 'completed'
    AND region = 'EU'
  GROUP BY category
)
```

After `filter.exclude: [orders.status]`:

```sql
WITH stage AS (
  SELECT
    category,
    SUM(amount) AS amount
  FROM orders
  WHERE region = 'EU'
  GROUP BY category
)
```

## Business tasks solved

### 1. Selected status vs all statuses

Dashboard filter:

```text
status = completed
```

Need to show:

```text
completed revenue
all-status revenue
completed / all-status share
```

Model:

```yaml
measures:
  - name: all_status_revenue
    type: number
    multi_stage: true
    sql: "{CUBE.revenue}"

    filter:
      exclude:
        - orders.status
```

### 2. Funnel denominator

Dashboard is filtered to a specific funnel step.

You need:

```text
users at selected step / all users
```

The denominator excludes the step filter.

### 3. Ignore one dashboard slicer but keep all others

User selects:

```text
country = PL
device = iOS
status = completed
```

Metric excludes only `status`, so it still remains country/device-specific.

---

# 7. `filter.keep_only`

`filter.keep_only` keeps only filters that target the listed members. All other filters and segments are removed.

Example:

```yaml
filter:
  keep_only:
    - orders.country
```

Outer query:

```sql
WHERE
  country = 'PL'
  AND category = 'Books'
  AND status = 'completed'
  AND platform = 'ios'
```

Stage state:

```sql
WHERE
  country = 'PL'
```

## SQL effect

Before:

```sql
WITH stage AS (
  SELECT
    country,
    category,
    SUM(amount) AS amount
  FROM orders
  WHERE country = 'PL'
    AND category = 'Books'
    AND status = 'completed'
    AND platform = 'ios'
  GROUP BY country, category
)
```

After:

```sql
WITH stage AS (
  SELECT
    country,
    SUM(amount) AS amount
  FROM orders
  WHERE country = 'PL'
  GROUP BY country
)
```

The exact grouping also depends on `grain`; the important filter effect is that only the country filter remains.

## Business tasks solved

### 1. Country benchmark

Dashboard is drilled down by product/category/status, but you need a country-level benchmark:

```text
current cell revenue / total revenue in country
```

`filter.keep_only: [country]` ensures that the denominator is not affected by category/status/product filters.

### 2. Market size baseline

Keep only market-defining filters:

```yaml
filter:
  keep_only:
    - orders.country
    - orders.region
```

Remove tactical filters such as campaign, category, status, platform.

### 3. Stable denominator for percent-of-total

If dashboards add many slicers, `keep_only` defines explicitly which filters are allowed to affect the denominator.

---

# 8. `filter.include`

`filter.include` adds predicates to the stage.

Example:

```yaml
filter:
  include:
    - member: orders.status
      operator: equals
      values: [completed]
```

If the user query has no status filter, the stage still gets:

```sql
WHERE status = 'completed'
```

If the user query already has other filters, included filters are AND-combined with them unless `mode: fixed` or `exclude`/`keep_only` changes the base first.

## SQL effect

Outer query:

```sql
WHERE region = 'EU'
```

Directive:

```yaml
filter:
  include:
    - member: orders.status
      operator: equals
      values: [completed]
```

Stage SQL:

```sql
WHERE region = 'EU'
  AND status = 'completed'
```

## Boolean groups

The include list can contain `or` / `and` groups.

Example:

```yaml
filter:
  include:
    - or:
        - member: orders.status
          operator: equals
          values: [completed]
        - member: orders.status
          operator: equals
          values: [pending]
```

Conceptual SQL:

```sql
WHERE (status = 'completed' OR status = 'pending')
```

## Business tasks solved

### 1. Canonical KPI

A metric should always mean "completed orders revenue":

```yaml
filter:
  include:
    - member: orders.status
      operator: equals
      values: [completed]
```

### 2. Region-specific metric

A global dashboard can include a measure that is always EU-only:

```yaml
filter:
  include:
    - member: orders.region
      operator: equals
      values: [EU]
```

### 3. Replace a user filter

You can combine `exclude` and `include`:

```yaml
filter:
  exclude:
    - orders.status
  include:
    - member: orders.status
      operator: equals
      values: [pending]
```

If user selected `status = completed`, the stage removes it and injects `status = pending`.

Conceptually:

```sql
-- User query
WHERE status = 'completed'

-- Stage query
WHERE status = 'pending'
```

---

# 9. `grain` directive

The `grain` directive controls aggregation level.

It affects:

- which dimensions are present in child stage state;
- `GROUP BY` in leaf CTEs;
- `PARTITION BY` in window-path calculations;
- join keys used by `FullKeyAggregate`;
- whether results are broadcast back to a finer grain.

Important distinction:

```text
filter changes rows
grain changes grouping
```

---

# 10. Query grain and stage grain

A query grouped by country and category has query grain:

```text
(country, category)
```

If a stage uses the same grain, it calculates one value per country/category.

If a stage changes the grain to:

```text
(category)
```

then it calculates one value per category and later broadcasts it to every country/category row.

If a stage changes the grain to:

```text
(country, category, user_id)
```

then it calculates at a more detailed user-level grain and later aggregates back.

---

# 11. `grain.exclude`

`grain.exclude` removes dimensions from the inherited grain.

Example:

```yaml
grain:
  exclude:
    - orders.country
```

Parent grain:

```text
(country, category)
```

Stage grain:

```text
(category)
```

## SQL effect: JOIN path

Conceptual leaf CTE:

```sql
WITH revenue_by_category AS (
  SELECT
    category,
    SUM(revenue) AS revenue
  FROM orders
  GROUP BY category
)
```

Then the result is joined/broadcast back to the parent grain:

```text
PL Books  -> Books total
DE Books  -> Books total
FR Books  -> Books total
```

## SQL effect: window path

For eligible simple additive aggregates, the planner may render the same logical effect as a window function instead of a join-based CTE.

Conceptual SQL:

```sql
SUM(SUM(revenue)) OVER (PARTITION BY category)
```

The important detail is that `country` is removed from `PARTITION BY`.

## Business example: category total inside country/category table

Report:

```text
country | category | revenue | category_total
```

Data:

```text
PL | Books | 100
DE | Books | 200
FR | Books | 300
```

Metric:

```yaml
category_total:
  multi_stage: true
  sql: "{CUBE.revenue}"
  type: sum
  grain:
    exclude:
      - orders.country
```

Result:

```text
PL | Books | 100 | 600
DE | Books | 200 | 600
FR | Books | 300 | 600
```

`category_total` ignores country as a grouping key, not as a row filter.

---

# 12. `grain.keep_only`

`grain.keep_only` intersects the current grain with the listed dimensions.

Example:

```yaml
grain:
  keep_only:
    - orders.country
```

Parent grain:

```text
(country, category, month)
```

Stage grain:

```text
(country)
```

## SQL effect

```sql
WITH country_revenue AS (
  SELECT
    country,
    SUM(revenue) AS revenue
  FROM orders
  GROUP BY country
)
```

Then this value is broadcast back to every category/month row inside the same country.

## Important edge case: listed dimension absent from query grain

If the query grain is:

```text
(category)
```

and the directive is:

```yaml
grain:
  keep_only:
    - orders.status
```

then the intersection is empty:

```text
()
```

That means the stage calculates a grand total.

Conceptual SQL:

```sql
SELECT SUM(revenue) AS revenue
FROM orders
```

The value is then repeated for every category row.

This is intentional: `keep_only` keeps only dimensions that are both listed and present in the current inherited grain.

## Business example: global denominator

Report:

```text
category | category_revenue | global_revenue | share
```

Metric:

```yaml
global_revenue:
  multi_stage: true
  sql: "{CUBE.revenue}"
  type: sum
  grain:
    keep_only: []
```

Or if the listed dimensions are absent from query grain, it effectively becomes grand total.

Result:

```text
Books       250   525   47.6%
Electronics 275   525   52.4%
```

## Difference from `exclude`

Given parent grain:

```text
(country, category, month)
```

`exclude: [category]` gives:

```text
(country, month)
```

`keep_only: [country]` gives:

```text
(country)
```

So:

- `exclude` is subtractive;
- `keep_only` is declarative and restrictive.

---

# 13. `grain.include`

`grain.include` adds dimensions to the child/leaf grain.

Example:

```yaml
grain:
  include:
    - users.id
```

Parent grain:

```text
(category)
```

Stage grain:

```text
(category, user_id)
```

## SQL effect

The child CTE becomes more detailed than the final report:

```sql
WITH user_revenue AS (
  SELECT
    category,
    user_id,
    SUM(revenue) AS user_revenue
  FROM orders
  GROUP BY category, user_id
)
SELECT
  category,
  AVG(user_revenue) AS avg_user_revenue
FROM user_revenue
GROUP BY category
```

## Business tasks solved

### 1. ARPU / average revenue per user

You often need to compute revenue at user grain first, then average users:

```yaml
avg_user_revenue:
  type: avg
  multi_stage: true
  sql: "{CUBE.user_revenue}"
  grain:
    include:
      - users.id
```

Conceptually:

```sql
-- Stage 1
SELECT category, user_id, SUM(revenue) AS user_revenue
GROUP BY category, user_id

-- Stage 2
SELECT category, AVG(user_revenue)
GROUP BY category
```

### 2. Cohort retention

First calculate a per-user retention flag, then aggregate by cohort:

```text
(cohort_month, user_id) -> retention flag
(cohort_month)          -> retention rate
```

`grain.include: [user_id]` forces the user-level stage.

### 3. LTV

First calculate lifetime revenue per user, then summarize by campaign/country:

```text
(campaign, user_id) -> user_ltv
(campaign)          -> avg_ltv / p50_ltv / sum_ltv
```

### 4. Nested aggregate

Any metric of the shape:

```text
AGG_OUTER(AGG_INNER(raw rows grouped by extra dimension))
```

needs a lower-grain stage.

---

# 14. Combining `grain.keep_only` and `grain.include`

This is important because operations are ordered.

The planner applies:

```text
1. grain.exclude / grain.keep_only shrink inherited grain
2. grain.include extends leaf grain
```

Example:

```yaml
grain:
  keep_only:
    - orders.status
  include:
    - orders.id
```

Parent grain:

```text
(status, category)
```

After `keep_only`:

```text
(status)
```

After `include`:

```text
(status, id)
```

The child CTE is computed at `(status, id)`, while the parent query may be `(status, category)`.

When results are re-aggregated back, the value can become "per-status total broadcast across categories".

Test data example:

```text
completed + books       = 170
completed + electronics = 200
completed total         = 370
```

Output:

```text
completed | books       | 370
completed | electronics | 370
```

Meaning:

```text
value calculated by status, not by category
```

but internally it may still include `id` to support correct child-level calculation.

---

# 15. Operation order

The effective order inside a multi-stage node is:

```text
1. Resolve member and static filters
2. Select filter base state:
   - root state for filter.mode = fixed
   - parent state for relative/default
3. Apply filter.exclude
4. Apply filter.keep_only
5. Apply filter.include
6. Apply grain.exclude / grain.keep_only to dimensions and time_dimensions
7. Apply grain.include by adding dimensions
8. Apply time_shift
9. Remove filters on the member being calculated
10. Build child descriptions
11. Build keys_input if parent grain must be restored
12. Render logical CTE
13. Render physical SQL
```

Pseudo-code:

```python
def build_stage(member, parent_state):
    member = resolve_reference_chain(member)
    member = apply_static_filters_to_symbol(member, parent_state.dimension_filters)

    filter = member.multi_stage.filter
    grain = member.multi_stage.grain

    if filter and filter.mode == "fixed":
        state = root_state.copy()
    else:
        state = parent_state.copy()

    if filter:
        if filter.exclude:
            state.remove_filters_for_members(filter.exclude)

        if filter.keep_only:
            state.keep_only_filters_for_members(filter.keep_only)

        if filter.include:
            state.add_filters(filter.include)

    if should_use_join_model(member):
        state.dimensions = apply_grain_shrink(state.dimensions, grain)
        state.time_dimensions = apply_grain_shrink(state.time_dimensions, grain)

    if grain.include:
        state.add_dimensions(grain.include)

    if member.time_shift:
        state.add_time_shifts(member.time_shift)

    state.remove_filter_for_member(member.name)

    child_inputs = build_child_descriptions(member.dependencies, state)

    if join_model and parent_state_has_dimensions_missing_from_state:
        keys_input = build_child_descriptions(member.dependencies, parent_state)
    else:
        keys_input = None

    return MultiStageQueryDescription(
        member=member,
        state=parent_state,
        input=child_inputs,
        keys_input=keys_input
    )
```

---

# 16. Broadcast mechanics

Broadcast is the mechanism that lets a value calculated at a coarser grain appear in a finer-grained result.

Example:

Parent/query grain:

```text
(country, category)
```

Stage grain:

```text
(category)
```

Stage result:

```text
Books = 1000
Games = 500
```

After joining back:

```text
PL | Books | 1000
DE | Books | 1000
FR | Books | 1000
PL | Games | 500
DE | Games | 500
FR | Games | 500
```

This is not duplication error. It is the intended analytical behavior.

## How planner detects broadcast need

The planner compares parent state dimensions/time_dimensions with the new child state.

If any parent dimension is missing from the child state, then the stage shrank the grain.

Conceptually:

```python
any_missing = any(
    dim not in child_state.dimensions + child_state.time_dimensions
    for dim in parent_state.dimensions + parent_state.time_dimensions
)

if any_missing:
    keys_input = build_keys_from_parent_state()
```

`keys_input` preserves the full parent grain so the final `FullKeyAggregate` can join coarse values back to the full key grid.

---

# 17. `FullKeyAggregate` and `keys_input`

`FullKeyAggregate` stitches together multi-stage CTEs.

There are two major shapes.

## Without explicit `keys_input`

When measure-side refs already contain full key coverage, the planner can derive keys from measure refs themselves.

```text
measure CTE has country, category
final output needs country, category
```

No extra keys side is needed.

## With explicit `keys_input`

When a measure was calculated at a coarser grain, such as:

```text
category
```

but final output needs:

```text
country, category
```

the planner builds a keys side:

```text
keys_input = full parent grain rows
measure_input = coarser measure rows
```

Then the physical strategy:

1. Builds a distinct keys projection.
2. Left joins measure-side CTEs onto keys.
3. Joins only on dimensions present in the measure-side schema.

Conceptual SQL:

```sql
WITH
keys AS (
  SELECT DISTINCT country, category
  FROM parent_key_source
),

category_revenue AS (
  SELECT category, SUM(revenue) AS revenue
  FROM orders
  GROUP BY category
)

SELECT
  keys.country,
  keys.category,
  category_revenue.revenue
FROM keys
LEFT JOIN category_revenue
  ON keys.category = category_revenue.category
```

This is the SQL reason why coarse-grain metrics are broadcast to finer-grain rows.

---

# 18. Window Path vs Join Path

The planner has two rendering strategies for aggregate multi-stage nodes.

## Window Path

For a narrow set of safe additive cases, the planner avoids extra join-based CTE assembly and renders a SQL window expression.

The optimization applies when:

- the multi-stage node is an aggregate;
- the measure has exactly one dependency;
- the outer aggregation is `sum`;
- the inner aggregation rolls up safely as `sum` or `count`;
- `grain.include` is not present;
- partition grain is a strict subset of all dimensions.

Conceptual SQL:

```sql
SUM(SUM(amount)) OVER (PARTITION BY category)
```

This handles cases where grain is reduced by `exclude` or `keep_only`.

### Why `grain.exclude` can use window path

If query grain is:

```text
(status, category)
```

and `grain.exclude: [status]`, the calculation can be expressed as:

```sql
SUM(SUM(amount)) OVER (PARTITION BY category)
```

The base query still groups by status/category, and the window expression rolls up across status.

### Why `grain.include` disables window path

`include` adds dimensions to the leaf grain.

Example:

```text
category -> category, user_id
```

A window function cannot invent a lower-level rowset that was not in the source grouping.

The planner must build a join-model CTE:

```sql
WITH user_revenue AS (
  SELECT category, user_id, SUM(amount)
  FROM orders
  GROUP BY category, user_id
)
...
```

So `include` requires join-based planning.

## Join Path

Join path uses explicit CTEs and `FullKeyAggregate`.

It is required when:

- `grain.include` is present;
- multiple child CTEs must be stitched together;
- the planner needs explicit keys-side broadcast;
- the calculation cannot be faithfully represented as a window function.

---

# 19. Rank calculations

Rank measures are rendered as window functions.

Conceptually:

```sql
rank() OVER (
  PARTITION BY <partition_by from grain>
  ORDER BY <measure order by>
)
```

`grain` changes the partition.

Example:

```yaml
ranking_within_category:
  type: rank
  multi_stage: true
  order_by:
    - sql: "{CUBE.revenue}"
      dir: desc
  grain:
    keep_only:
      - orders.category
```

If the report contains:

```text
category, product
```

then rank is calculated within each category:

```sql
rank() OVER (
  PARTITION BY category
  ORDER BY revenue DESC
)
```

Business task:

```text
Rank products by revenue inside each category.
```

If `grain.keep_only` is empty or resolves to no partition dimensions, ranking becomes global.

---

# 20. Filter + grain together

Most useful metrics combine both.

## Example: share of selected category inside country

Report:

```text
country, category
```

Need:

```text
category revenue / country revenue
```

Numerator:

```yaml
revenue:
  type: sum
```

Denominator:

```yaml
country_revenue:
  type: sum
  multi_stage: true
  sql: "{CUBE.revenue}"
  grain:
    keep_only:
      - orders.country
```

Generated concept:

```sql
WITH country_revenue AS (
  SELECT country, SUM(revenue) AS revenue
  FROM orders
  GROUP BY country
)
SELECT
  country,
  category,
  category_revenue,
  country_revenue,
  category_revenue / country_revenue AS share
```

## Example: share of completed orders in all orders

User query has:

```sql
WHERE status = 'completed'
```

Need denominator ignoring status:

```yaml
all_status_revenue:
  type: sum
  multi_stage: true
  sql: "{CUBE.revenue}"
  filter:
    exclude:
      - orders.status
```

If grouped by category:

```sql
WITH all_status_revenue AS (
  SELECT category, SUM(revenue)
  FROM orders
  GROUP BY category
)
```

Final:

```text
completed_revenue / all_status_revenue
```

## Example: category share inside country, ignoring status

Need denominator:

```text
all-status country revenue
```

```yaml
country_all_status_revenue:
  type: sum
  multi_stage: true
  sql: "{CUBE.revenue}"

  filter:
    exclude:
      - orders.status

  grain:
    keep_only:
      - orders.country
```

Effect:

- remove `status` filter from rows;
- group only by `country`;
- broadcast to country/category/status report rows.

---

# 21. Detailed business recipes

## Recipe A: Percent of total

Task:

```text
For every category, show its share of total revenue.
```

Report grain:

```text
category
```

Metric definitions:

```yaml
measures:
  - name: revenue
    sql: revenue
    type: sum

  - name: total_revenue
    sql: "{CUBE.revenue}"
    type: sum
    multi_stage: true
    grain:
      keep_only: []

  - name: revenue_share
    sql: "{CUBE.revenue} / NULLIF({CUBE.total_revenue}, 0)"
    type: number
```

Conceptual SQL:

```sql
WITH total_revenue AS (
  SELECT SUM(revenue) AS total_revenue
  FROM orders
),

category_revenue AS (
  SELECT category, SUM(revenue) AS revenue
  FROM orders
  GROUP BY category
)

SELECT
  category,
  revenue,
  total_revenue,
  revenue / NULLIF(total_revenue, 0) AS revenue_share
FROM category_revenue
CROSS JOIN total_revenue
```

If implemented through keys/broadcast, the same total is repeated for each category.

---

## Recipe B: Percent of parent

Task:

```text
For each category in each country, show category share of country revenue.
```

Report grain:

```text
country, category
```

Denominator:

```yaml
country_revenue:
  sql: "{CUBE.revenue}"
  type: sum
  multi_stage: true
  grain:
    keep_only:
      - orders.country
```

SQL shape:

```sql
WITH country_revenue AS (
  SELECT country, SUM(revenue) AS country_revenue
  FROM orders
  GROUP BY country
),

category_revenue AS (
  SELECT country, category, SUM(revenue) AS category_revenue
  FROM orders
  GROUP BY country, category
)

SELECT
  category_revenue.country,
  category_revenue.category,
  category_revenue.category_revenue,
  country_revenue.country_revenue,
  category_revenue.category_revenue
    / NULLIF(country_revenue.country_revenue, 0) AS share_of_country
FROM category_revenue
LEFT JOIN country_revenue
  ON category_revenue.country = country_revenue.country
```

---

## Recipe C: Benchmark against country while keeping dashboard region

Dashboard filters:

```text
region = EU
country = PL
category = Books
```

Task:

```text
Compare selected category against the whole selected country, but keep region.
```

Metric:

```yaml
country_benchmark_revenue:
  sql: "{CUBE.revenue}"
  type: sum
  multi_stage: true
  filter:
    keep_only:
      - orders.region
      - orders.country
  grain:
    keep_only:
      - orders.country
```

Effect:

- rows keep only `region` and `country` filters;
- category filter is removed;
- grouping is only by country;
- result is broadcast to category rows.

---

## Recipe D: Replace user filter with canonical filter

Task:

```text
Even if user selects any status, calculate pending revenue.
```

```yaml
pending_revenue:
  sql: "{CUBE.revenue}"
  type: sum
  multi_stage: true
  filter:
    exclude:
      - orders.status
    include:
      - member: orders.status
        operator: equals
        values: [pending]
```

Conceptual SQL:

```sql
-- user selected completed, but stage sees pending
WHERE status = 'pending'
```

---

## Recipe E: ARPU

Task:

```text
Average revenue per user by country.
```

Need two stages:

1. calculate user revenue at `(country, user_id)`;
2. average user revenue by country.

```yaml
measures:
  - name: revenue
    sql: revenue
    type: sum

  - name: user_revenue
    sql: "{CUBE.revenue}"
    type: sum
    multi_stage: true
    grain:
      include:
        - users.id

  - name: avg_user_revenue
    sql: "{CUBE.user_revenue}"
    type: avg
    multi_stage: true
```

Conceptual SQL:

```sql
WITH user_revenue AS (
  SELECT
    country,
    user_id,
    SUM(revenue) AS user_revenue
  FROM orders
  GROUP BY country, user_id
)

SELECT
  country,
  AVG(user_revenue) AS avg_user_revenue
FROM user_revenue
GROUP BY country
```

`grain.include` is essential because the first stage must materialize the user-level grain.

---

## Recipe F: Retention rate

Task:

```text
For each cohort month, calculate the share of users active on day 7.
```

Simplified model:

```yaml
user_day7_active:
  sql: "CASE WHEN {activity.day_number} = 7 THEN 1 ELSE 0 END"
  type: max
  multi_stage: true
  grain:
    include:
      - users.id

retention_day7:
  sql: "{CUBE.user_day7_active}"
  type: avg
  multi_stage: true
  grain:
    keep_only:
      - users.cohort_month
```

Conceptual SQL:

```sql
WITH user_retention AS (
  SELECT
    cohort_month,
    user_id,
    MAX(CASE WHEN day_number = 7 THEN 1 ELSE 0 END) AS active_day7
  FROM activity
  GROUP BY cohort_month, user_id
)

SELECT
  cohort_month,
  AVG(active_day7) AS retention_day7
FROM user_retention
GROUP BY cohort_month
```

---

## Recipe G: Ranking within category

Task:

```text
Rank products by revenue inside each category.
```

```yaml
product_rank_in_category:
  type: rank
  multi_stage: true
  order_by:
    - sql: "{CUBE.revenue}"
      dir: desc
  grain:
    keep_only:
      - products.category
```

Conceptual SQL:

```sql
rank() OVER (
  PARTITION BY category
  ORDER BY SUM(revenue) DESC
)
```

If `grain.keep_only` is removed, ranking would be at a different partition, possibly global or query-grain-dependent.

---

# 22. Behavior matrix

| Directive | Changes rows? | Changes grouping? | Affects `WHERE` | Affects `GROUP BY` | Affects `PARTITION BY` | Can broadcast? |
|---|---:|---:|---:|---:|---:|---:|
| `filter.exclude` | Yes | No | Yes | No | No | Indirectly |
| `filter.keep_only` | Yes | No | Yes | No | No | Indirectly |
| `filter.include` | Yes | No | Yes | No | No | Indirectly |
| `grain.exclude` | No | Yes | No | Yes | Yes | Yes |
| `grain.keep_only` | No | Yes | No | Yes | Yes | Yes |
| `grain.include` | No | Yes | No | Yes | Usually no window path | Re-aggregates back |

---

# 23. Option-by-option SQL behavior

## `filter.exclude`

Before:

```sql
WHERE country = 'PL'
  AND status = 'completed'
```

After:

```sql
WHERE country = 'PL'
```

## `filter.keep_only`

Before:

```sql
WHERE country = 'PL'
  AND status = 'completed'
  AND category = 'Books'
```

After:

```sql
WHERE country = 'PL'
```

## `filter.include`

Before:

```sql
WHERE country = 'PL'
```

After:

```sql
WHERE country = 'PL'
  AND status = 'completed'
```

## `grain.exclude`

Before:

```sql
GROUP BY country, category
```

After:

```sql
GROUP BY category
```

or window path:

```sql
SUM(SUM(amount)) OVER (PARTITION BY category)
```

## `grain.keep_only`

Before:

```sql
GROUP BY country, category, month
```

After:

```sql
GROUP BY country
```

## `grain.include`

Before:

```sql
GROUP BY category
```

After:

```sql
GROUP BY category, user_id
```

---

# 24. Interaction with time dimensions

`grain.exclude` and `grain.keep_only` are applied to both:

- dimensions;
- time_dimensions.

This means a directive can change time grouping as well.

Example:

Parent grain:

```text
country, created_at.month
```

Directive:

```yaml
grain:
  exclude:
    - orders.created_at.month
```

Stage grain:

```text
country
```

Result:

```text
country-level total across months
```

If the query displays months, the country total is broadcast to every month row.

---

# 25. Interaction with time shift

Time shift is applied after filter and grain transformations.

Order:

```text
filter transform
grain transform
grain include
time shift
```

This means the shifted measure is calculated on the already transformed grain/filter state.

Example:

```yaml
prior_year_country_revenue:
  sql: "{CUBE.revenue}"
  type: sum
  multi_stage: true
  grain:
    keep_only:
      - orders.country
  time_shift:
    - time_dimension: orders.created_at
      interval: 1 year
      type: prior
```

Effect:

1. keep only country grain;
2. shift time context by prior year;
3. calculate prior-year country revenue;
4. broadcast to the report grain.

---

# 26. Interaction with rolling windows

Rolling windows create special time-series and measure-input CTEs.

The rolling-window planner may:

- compute or reuse date range;
- build a time series CTE;
- change the time dimension granularity in the base state;
- replace date range filters for trailing/leading windows.

Important caveat from implementation comments:

`filter.mode: fixed` inside nested chains can reset to root state and therefore drop rolling-window-specific state mutations such as extended date ranges or changed time-dimension granularity.

Practical guidance:

- use `mode: fixed` carefully inside rolling-window dependencies;
- prefer `relative` when the child must inherit rolling-window base-state changes.

---

# 27. Interaction with segments

Segments are part of the filter-like state.

`filter.exclude` and `filter.keep_only` can remove or preserve segment filters because the state mutators operate on segments as well as dimension/time/measure filters.

Example:

Query:

```yaml
segments:
  - orders.completed_orders
```

Metric:

```yaml
filter:
  exclude:
    - orders.completed_orders
```

Effect:

```text
segment is removed from the stage
```

This allows all-segment denominators while the outer query remains segment-filtered.

---

# 28. Static filters and CASE-SWITCH caveat

Before the directive-specific state rewrite, the planner applies static dimension filters to the member symbol.

This matters for CASE-SWITCH calculations.

Implementation notes indicate a caveat:

If inherited filters prune a CASE branch before a nested `mode: fixed` reset happens, the fixed reset cannot un-prune that branch later.

Practical guidance:

- avoid relying on `mode: fixed` to resurrect CASE branches already pruned by inherited filters;
- model fixed baseline measures outside such a chain if exact branch preservation is required.

---

# 29. Validation and schema behavior

The schema validator allows `filter` on multi-stage measures and dimensions.

`filter` supports:

```yaml
mode: relative | fixed
exclude: function returning references
keep_only: function returning references
include: array of filter predicates or boolean groups
```

`exclude` and `keep_only` are mutually exclusive.

The schema validator allows `grain` on multi-stage measures.

`grain` supports:

```yaml
exclude: function returning references
keep_only: function returning references
include: function returning references
```

`exclude` and `keep_only` are mutually exclusive.

The evaluator resolves function references into reference arrays that are consumed by the Rust/native bridge.

---

# 30. Practical modeling guidance

## Use `filter.exclude` when

You want to ignore one slicer but keep others.

Examples:

- ignore status;
- ignore category;
- ignore campaign;
- ignore selected funnel step.

## Use `filter.keep_only` when

You want a controlled denominator and do not want arbitrary dashboard filters to affect it.

Examples:

- country denominator;
- market denominator;
- region benchmark;
- global baseline with only selected tenant/account filters.

## Use `filter.include` when

The measure definition itself must enforce a condition.

Examples:

- completed orders only;
- paid accounts only;
- EU revenue only;
- active users only.

## Use `filter.mode: fixed` when

Nested parent stages modify context but a child must go back to original query context.

Examples:

- original-query benchmark inside a modified chain;
- stable baseline independent from parent stage transformations.

## Use `grain.exclude` when

You want to remove specific grouping keys from the inherited query grain.

Examples:

- category total regardless of country;
- status total regardless of category;
- month total regardless of day.

## Use `grain.keep_only` when

You want to define the exact grouping level of the stage.

Examples:

- country total;
- region total;
- cohort total;
- global total.

## Use `grain.include` when

You need to calculate at a lower, more detailed grain before aggregating back.

Examples:

- per-user metrics;
- per-session metrics;
- per-order metrics;
- per-install retention flags;
- nested aggregates.

---

# 31. Common mistakes

## Mistake 1: using `filter.exclude` when you need `grain.exclude`

If you want to calculate category total across countries, use grain:

```yaml
grain:
  exclude:
    - orders.country
```

Do not use filter unless you want to remove a `WHERE country = ...` condition.

## Mistake 2: using `grain.exclude` when you need to ignore a dashboard filter

If dashboard has:

```sql
WHERE status = 'completed'
```

and denominator should include all statuses, use:

```yaml
filter:
  exclude:
    - orders.status
```

`grain.exclude` would not bring back rows filtered out by `WHERE`.

## Mistake 3: forgetting that `keep_only` intersects with current grain

If the query does not contain the listed dimension, `grain.keep_only` may collapse to grand total.

This can be useful, but should be intentional.

## Mistake 4: expecting `include` to filter rows

`grain.include` does not add a `WHERE` condition.

It adds grouping detail.

Use `filter.include` for row predicates.

---

# 32. End-to-end example

## Business question

For each product category in the selected country, show:

1. selected category revenue;
2. country revenue ignoring category and status filters;
3. category share of country;
4. average revenue per user in the category;
5. product rank within category.

## Query context

Dashboard filters:

```text
country = PL
status = completed
```

Report dimensions:

```text
category, product
```

## Measures

```yaml
measures:
  - name: revenue
    sql: revenue
    type: sum

  - name: country_all_status_revenue
    sql: "{CUBE.revenue}"
    type: sum
    multi_stage: true
    filter:
      exclude:
        - orders.status
    grain:
      keep_only:
        - orders.country

  - name: category_share_of_country
    sql: "{CUBE.revenue} / NULLIF({CUBE.country_all_status_revenue}, 0)"
    type: number

  - name: user_revenue
    sql: "{CUBE.revenue}"
    type: sum
    multi_stage: true
    grain:
      include:
        - users.id

  - name: avg_user_revenue
    sql: "{CUBE.user_revenue}"
    type: avg
    multi_stage: true

  - name: product_rank_in_category
    type: rank
    multi_stage: true
    order_by:
      - sql: "{CUBE.revenue}"
        dir: desc
    grain:
      keep_only:
        - products.category
```

## Conceptual SQL shape

```sql
WITH
base_category_product AS (
  SELECT
    category,
    product,
    SUM(revenue) AS revenue
  FROM orders
  WHERE country = 'PL'
    AND status = 'completed'
  GROUP BY category, product
),

country_all_status_revenue AS (
  SELECT
    country,
    SUM(revenue) AS country_revenue
  FROM orders
  WHERE country = 'PL'
  GROUP BY country
),

user_revenue AS (
  SELECT
    category,
    product,
    user_id,
    SUM(revenue) AS user_revenue
  FROM orders
  WHERE country = 'PL'
    AND status = 'completed'
  GROUP BY category, product, user_id
),

avg_user_revenue AS (
  SELECT
    category,
    product,
    AVG(user_revenue) AS avg_user_revenue
  FROM user_revenue
  GROUP BY category, product
),

final AS (
  SELECT
    b.category,
    b.product,
    b.revenue,
    c.country_revenue,
    b.revenue / NULLIF(c.country_revenue, 0) AS category_share_of_country,
    a.avg_user_revenue,
    rank() OVER (
      PARTITION BY b.category
      ORDER BY b.revenue DESC
    ) AS product_rank_in_category
  FROM base_category_product b
  LEFT JOIN country_all_status_revenue c
    ON TRUE -- simplified; actual join uses available keys
  LEFT JOIN avg_user_revenue a
    ON b.category = a.category
   AND b.product = a.product
)
SELECT * FROM final
```

The actual generated SQL may use more CTEs and `FullKeyAggregate`, but the semantics are equivalent.

---

# 33. Internal implementation map

This section maps behavior to implementation concepts.

## Schema layer

The JS schema compiler accepts `filter` and `grain`, validates shape, and resolves function references into reference arrays.

Important objects:

```text
MultiStageFilterDirective
MultiStageGrainDirective
CubeValidator.MultiStageFilter
CubeValidator.MultiStageGrain
CubeEvaluator.evaluateMultiStageReferences
```

## Rust bridge layer

Native bridge structs deserialize resolved references:

```text
MultiStageFilterReferences
MultiStageGrainReferences
```

## Symbol layer

Resolved directives become:

```rust
MultiStageProperties {
    grain: MultiStageGrain,
    filter: Option<MultiStageFilter>,
    time_shift: Option<MeasureTimeShifts>,
}
```

`MultiStageGrain` is a set operation object:

```rust
exclude
keep_only
include
```

`MultiStageFilter` contains:

```rust
mode
exclude
keep_only
include_dimension
include_time_dimension
include_measure
```

## Recursive planner layer

`MultiStageQueryPlanner`:

1. finds multi-stage members used in the query;
2. builds root state;
3. recursively builds descriptions for members and dependencies;
4. applies filter and grain transformations;
5. detects when keys_input is needed;
6. emits `MultiStageQueryDescription` nodes.

## Logical render layer

`MultiStageMemberQueryPlanner` converts descriptions into logical nodes:

- `MultiStageMeasureCalculation`;
- `MultiStageDimensionCalculation`;
- `MultiStageRollingWindow`;
- `MultiStageLeafMeasure`;
- `FullKeyAggregate` source.

## Physical SQL layer

Physical processors render:

- CTE leaf queries through regular `QueryPlanner`;
- measure calculations through `MultiStageMeasureCalculationProcessor`;
- window path through `MultiStageWindowNode`;
- rank path through `MultiStageRankNode`;
- join/broadcast path through `FullKeyAggregate` strategies.

---

# 34. Research basis

This document was based on reviewing:

- changed files in PR #10957: multi-stage `grain` directive;
- changed files in PR #10827: multi-stage `filter` directives;
- code search results for `multi_stage`, `MultiStageQueryPlanner`, `FullKeyAggregate`, `use_window_path`, `multiStageFilter`, `multiStageGrain`;
- key implementation files opened in detail.

Key files reviewed in detail:

```text
packages/cubejs-schema-compiler/src/compiler/CubeValidator.ts
packages/cubejs-schema-compiler/src/compiler/CubeEvaluator.ts
packages/cubejs-schema-compiler/test/integration/postgres/multi-stage-grain.test.ts
packages/cubejs-schema-compiler/test/integration/postgres/multi-stage-filter.test.ts

rust/cube/cubesqlplanner/cubesqlplanner/src/planner/symbols/common/multi_stage.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/planners/multi_stage/multi_stage_query_planner.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/planners/multi_stage/member.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/planners/multi_stage/member_query_planner.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/planners/multi_stage/query_description.rs

rust/cube/cubesqlplanner/cubesqlplanner/src/planner/query_properties.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/logical_plan/full_key_aggregate.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/logical_plan/multistage/calculation.rs

rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan_builder/processors/full_key_aggregate/mod.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan_builder/processors/full_key_aggregate/keys_aggregate_strategy.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan_builder/processors/multi_stage_measure_calculation.rs

rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan/sql_nodes/factory.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan/sql_nodes/multi_stage_window.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan/sql_nodes/multi_stage_rank.rs

rust/cube/cubesqlplanner/cubesqlplanner/src/tests/integration/multi_stage/filter_directive.rs
docs/content/product/data-modeling/concepts/multi-stage-calculations.mdx
```

Additional files reviewed at index / changed-file level:

```text
packages/cubejs-backend-native/src/bridge_test_exports.rs
packages/cubejs-backend-native/test/bridge/bridge-fixtures.ts
packages/cubejs-backend-native/test/bridge/object-bridges-coverage.test.ts
packages/cubejs-schema-compiler/src/compiler/transpilers/CubePropContextTranspiler.ts
packages/cubejs-schema-compiler/test/unit/cube-validator.test.ts
packages/cubejs-schema-compiler/test/unit/yaml-schema.test.ts

rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/dimension_definition.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/measure_definition.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/multi_stage_filter.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/multi_stage_grain.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/logical_plan/multistage/dimension.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/compiler.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/filter/compiler.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/filter/tree_ops.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/planners/query_planner.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/query_tools.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/symbols/dimension_symbol.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/planner/symbols/measure_symbol.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/test_fixtures/cube_bridge/yaml/measure.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/test_fixtures/cube_bridge/yaml/dimension.rs
rust/cube/cubesqlplanner/cubesqlplanner/src/test_fixtures/schemas/yaml_files/common/integration_multi_stage.yaml
rust/cube/cubesqlplanner/cubesqlplanner/src/test_fixtures/schemas/yaml_files/common/multi_stage_filter.yaml
rust/cube/cubesqlplanner/cubesqlplanner/src/test_fixtures/schemas/yaml_files/common/multi_stage_filter_invalid.yaml
```

---

# 35. Final takeaway

`filter` and `grain` are not simple configuration flags.

They are a declarative context transformation language for multi-stage SQL planning.

- `filter` decides which rows are visible to a stage.
- `grain` decides at what aggregation level those rows are calculated.
- `mode: fixed` controls whether a stage inherits parent context or resets to the original query context.
- `grain.exclude` and `grain.keep_only` shrink grain and can use either window or join path.
- `grain.include` creates lower-grain CTEs and requires join-based planning.
- `keys_input` and `FullKeyAggregate` restore parent grain and broadcast coarse results back to finer report rows.
- Window path is a performance optimization for safe additive cases where reduced grain can be expressed as `PARTITION BY`.
- Join path is the general mechanism for explicit CTE assembly, nested grain changes, and lower-grain calculations.

This model gives Cube schema authors a precise way to build reusable analytical metrics whose calculation context is independent from the dashboard query shape.
