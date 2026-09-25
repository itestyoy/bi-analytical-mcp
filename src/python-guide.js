// The AUTHORING GUIDE for a python stage, per warehouse runtime — and the one place the
// FACT-DERIVED texts about a runtime are composed.
//
// WHERE EACH KIND OF TEXT LIVES (one source per fact; a reader must never be handed two lists that
// can disagree):
//   1. FACTS about the library — versions, signatures, which methods need an ordering or an index:
//      config/bigframes-facts.json, EXTRACTED from the installed library by
//      scripts/bigframes-facts.py. Nothing anywhere restates a fact in prose.
//   2. RULES with their reasoning, and a do / avoid per operation: this file (the cookbook data
//      below), rendered two ways — compact into the stage description (`pythonRulesText`) and in
//      full through semantic_index({ guide: 'python' }) (`pythonAuthoringGuide`).
//   3. FAILURE HINTS — what a class name means on this runtime: `bigframesRunHints()` here, built
//      from the same fact sheet, carried by the frame profile and matched by `pythonRunHints`.
//   4. THE REFERENCE a caller fetches mid-write: `pythonReferenceRecipes()` here — the extracted
//      sheet published as recipes addressable by id (bf_ml_signatures, bf_frame_method_rules).
//   5. RUNTIME MECHANICS — what dbt.ref() returns, how pandas is spelled, which ml library runs
//      in-engine, the import allowlist, the build grace: the frame profile in src/python-model.js.
//      Its one-line `ml` list comes from `mlClassesText()` here, not from a list kept there.
//   6. STAGE MECHANICS in this server — where the stage sits in the chain, what the caller
//      declares, what the server writes, the size limits: the `pythonStageSchema` description in
//      src/python-model.js, which interpolates (2) rather than repeating it.
//   7. WHEN to reach for a python stage at all: one routing trigger in src/guide.js.
//   8. WORKED PAYLOADS per move: config/recipes.json (the bigframes family), each one a compiling
//      payload; the server NUDGES on pipeline shape (src/engine.js) rather than refusing.
//
// The guide itself is served TWICE from this one source, so the two can never drift:
//   - compressed, as the python stage's own DESCRIPTION (`pythonRulesText`), which every caller is
//     handed on every request — so it carries what a caller who never opens the guide must still
//     meet: how the code runs, what belongs in the stage, the five ways pandas code fails here
//     (`bigframesTraps`, its methods drawn from the fact sheet), the checklist to run before
//     declaring the stage, and WHERE THE FULL TEXT IS (the guide, the worked recipes by count,
//     the two generated references, the failure hints). Where a deployment ships no recipes there
//     is nothing to point at, so it carries every rule and the right form per operation instead;
//   - in full, through semantic_index({ guide: 'python' }) (`pythonAuthoringGuide`) — the same
//     rules with the reasoning behind each, each example as do / avoid / why, the five failures
//     with the complete method lists, the checklist, and the index of the worked recipes.
//
// The wording follows the current prompting guidance (Anthropic, OpenAI): plain bullets, a reason
// with every rule, what to do rather than only what to avoid — and no emphatic capitals, which
// newer models read literally and over-apply.
//
// It is DATA, one entry per runtime key (the frame profile's `key`), consumed generically by
// src/guide.js: adding a runtime is a new entry here, never a branch in the guide builder.
//
// The BigFrames entry is checked against the LIBRARY, not against its prose. Written from the
// documentation it was wrong in both directions — it told callers head(n) "returns different rows
// between runs" (it raises), that nlargest "orders by itself" (it needs an ordering unless
// keep='all'), that unique()/drop_duplicates() "do not work" (one does, the other has a keyword
// that makes it work), and it handed them std(ddof=0), a parameter this library does not have. So
// the facts now come from config/bigframes-facts.json, which scripts/bigframes-facts.py extracts
// from bigframes itself (its `requires_index` / `requires_ordering` decorators, its signatures,
// and the join/merge/ml paths with the place in the code that decides each), and
// test/unit/bigframes-facts.test.js holds the text below to it.
//
// Shape of an entry:
//   runs_where  — one sentence on what actually executes the code
//   rules       — the constraints, each with why it exists (what breaks otherwise)
//   examples    — task → do / avoid, in the body form THIS server's python stage takes: the lines
//                 of one declared function over `df`, the frame dbt.ref() returns
//   dbt         — what the generated model carries, so the caller knows what it does NOT write

import { readFileSync } from 'node:fs';
import { assetPath } from './runtime-assets.js';

// The extracted fact sheet (see the header). Absent → the guide renders without the method lists;
// it never guesses them.
function loadFacts() {
  try {
    const path = assetPath('bigframesFacts');
    if (path) return JSON.parse(readFileSync(path, 'utf8'));
  } catch { /* unreadable → treated as absent */ }
  return null;
}
const FACTS = loadFacts();
/** The methods of DataFrame+Series that need one thing or the other, public names only. */
function needs(kind) {
  const per = FACTS?.[kind] || {};
  const names = [...new Set([...(per.DataFrame || []), ...(per.Series || [])])].filter((n) => !n.startsWith('_'));
  return names.sort();
}
const NEEDS_ORDER = needs('requires_ordering');
const NEEDS_INDEX = needs('requires_index');
const BY_ARG = Object.entries(FACTS?.ordering_enforced_by_argument?.Series || {}).map(([name, why]) => `${name} (${why.join(', ')})`);
const VERSION = FACTS?.version ? `bigframes ${FACTS.version}` : 'this runtime';
const list = (xs, n = 99) => xs.slice(0, n).join(', ');

// The CONSTRUCTOR SURFACE of the ml estimators, read from the library. bigframes.ml wears the
// scikit-learn API but wraps BQML: a constructor takes the options its BQML model type has, and an
// sklearn parameter that has no BQML option is a TypeError — observed as
// KMeans(standardize_features=True). So the parameters are listed, not described, and `*` marks
// where keyword-only begins (a positional call past it is the same TypeError).
const mlSig = (mod, cls) => {
  const p = FACTS?.ml?.[mod]?.[cls];
  if (!p) return null;
  const kw = p.keyword_only || [];
  const params = [...(p.positional || []), ...(kw.length ? ['*', ...kw] : [])];
  return `${mod}.${cls.replace(/\(\)$/, '')}(${params.join(', ')})`;
};
/** Every extracted estimator, one signature per entry — the full surface, for the long guide. */
const ML_SIGNATURES = Object.entries(FACTS?.ml || {})
  .flatMap(([mod, entries]) => Object.keys(entries).map((cls) => mlSig(mod, cls)))
  .filter(Boolean);
/** The few a stage reaches for most, for the compact text. */
const ML_KEY_SIGNATURES = [['cluster', 'KMeans'], ['decomposition', 'PCA'], ['linear_model', 'LinearRegression'], ['ensemble', 'RandomForestClassifier'], ['preprocessing', 'StandardScaler'], ['pipeline', 'Pipeline'], ['model_selection', 'train_test_split()']]
  .map(([mod, cls]) => mlSig(mod, cls))
  .filter(Boolean);

// THE FIVE WAYS PANDAS CODE FAILS HERE — what the always-read text carries (the stage description),
// because a caller who never opens the guide still meets these first. Every method it names comes
// from the extracted sheet: a few the caller reaches for most, filtered to the ones the library
// marks, and the count of the rest with the reference that lists them all. `full` puts the whole
// lists in instead — for a deployment with no reference recipe to point at.
const COMMON_ORDER = ['head', 'tail', 'shift', 'diff', 'cumsum', 'rank', 'rolling', 'sample'].filter((m) => NEEDS_ORDER.includes(m));
const COMMON_INDEX = ['loc', 'at', 'idxmax', 'sort_index'].filter((m) => NEEDS_INDEX.includes(m));
function bigframesTraps({ full = false } = {}) {
  const more = (shown, all) => (all.length > shown.length ? ` and ${all.length - shown.length} more (bf_frame_method_rules lists them all)` : '');
  const order = full ? `${list(NEEDS_ORDER)}${BY_ARG.length ? `, and by argument ${list(BY_ARG)}` : ''}` : `${list(COMMON_ORDER)}${more(COMMON_ORDER, NEEDS_ORDER)}`;
  const index = full ? list(NEEDS_INDEX) : `${list(COMMON_INDEX)}${more(COMMON_INDEX, NEEDS_INDEX)}`;
  const kmeans = mlSig('cluster', 'KMeans');
  return [
    `No row order: ${order} raise OrderRequiredError until the frame is sorted — call sort_values (or sort_index) first; nothing else grants an ordering.`,
    `No index: ${index} raise NullIndexError. Two objects combine only while they come from the same frame (a projection, filter or window of it); a lookup, a groupby aggregate or anything computed elsewhere is merged on a key — merge is a SQL join, while Series.map(dict) and .join() align on an index.`,
    'An estimator\'s output is a new frame: model.predict(df) already carries every input column plus the prediction, so return it (and declare its columns in output.columns) rather than assigning its column into df.',
    `bigframes.ml takes BigQuery ML's parameters, not scikit-learn's${kmeans ? ` — ${kmeans}` : ''}: a scikit-learn argument it lacks (standardize_features, n_init, random_state) is a TypeError. Scale with preprocessing.StandardScaler() or in a SQL stage; pipeline.Pipeline takes exactly two steps (transform, estimator).`,
    'No Python per row: a function passed to apply/map runs only if it vectorizes, so write column expressions (np.where for a CASE, arithmetic, bigframes.bigquery functions); to_pandas() leaves BigQuery, so use it only on a small, already-aggregated frame.',
  ];
}

/** What to check before declaring a python stage — the same list in the description and the guide. */
const BIGFRAMES_CHECKLIST = [
  'the table it reads is prepared in SQL stages, at the grain the analysis works on',
  'every ordered method comes after sort_values',
  'no column is assigned from another frame (merge on a key instead)',
  'every estimator argument is in its signature',
  'the last step returns exactly the columns in output.columns',
];

/**
 * Where the full texts are — the pointers every rendering ends with. The worked recipes are named
 * by count and fetched by id; their ids and moves are listed in the guide (recipes.moves) and the
 * overview, not in the stage description every request carries.
 */
function whereTheFullTextIs(index = []) {
  const ids = index.map((r) => r.id);
  const refs = ['bf_frame_method_rules', 'bf_ml_signatures'].filter((id) => ids.includes(id));
  return [
    'semantic_index({ guide: "python" }) — every rule with its reasoning, a works / fails / why example per operation, every ml signature, and the ids of the worked recipes with the move each covers.',
    ...(index.length > refs.length ? [`semantic_index({ recipe: "<id>" }) — ${index.length - refs.length} worked, compiling recipes, one per move (the form that works next to the form that raises); read the ones your question involves, usually several — their ids are in the guide (recipes.moves) and in the semantic_index overview.`] : []),
    ...(refs.length ? [`Generated from the installed library (${VERSION}): ${refs.map((id) => (id === 'bf_frame_method_rules' ? 'semantic_index({ recipe: "bf_frame_method_rules" }) — every method that needs an ordering or an index, and the signatures that surprise' : 'semantic_index({ recipe: "bf_ml_signatures" }) — every bigframes.ml constructor and its parameters')).join('; ')}.`] : []),
    'A failed run comes back with a hint naming the rule it broke and the recipe to read.',
  ];
}

/** What belongs in a python stage — the first rule, and the line every rendering opens with. */
const BELONGS = 'only what SQL cannot say — a statistical test, clustering, scoring, a forecast, a model. The table it reads is prepared in SQL stages before it (scope, payload columns, joins, the aggregation to the analysis grain), so this stage receives a prepared table at that grain rather than the raw source — SQL is exact and cheap where the data lives, and every line here pays this runtime\'s limits.';

const BIGFRAMES = {
  // What belongs in a python stage (the first rule; every rendering opens with it), the five
  // ways pandas code fails here and the checklist — what the compact description carries.
  belongs: BELONGS,
  traps: bigframesTraps,
  checklist: BIGFRAMES_CHECKLIST,
  runs_where: 'dbt runs this model in a Colab Enterprise notebook: the BigFrames library turns your DataFrame operations into BigQuery SQL and BigQuery executes it. Nothing runs row by row in Python, and nothing is transferred out of BigQuery unless you ask for it with to_pandas().',
  rules: [
    {
      rule: 'A python stage computes only what SQL cannot say. Everything else — including preparing the table it reads — is a SQL stage before it.',
      short: `What belongs here: ${BELONGS}`,
      why: 'Three reasons, and none of them is taste. cost AND exactness: a SQL stage runs where the data already lives, reads only the columns it names, and its aggregate is exact; handing the raw table to the python runtime moves the same work to a slower place and pays for the scan. the runtime: this stage is a separate dbt model on the warehouse\'s python runtime — a cold start of minutes, and everything it touches it touches through that runtime\'s limits (here: no index, no row order, deferred execution), so the less it has to do, the fewer of those limits you meet. readability: a SQL stage stays a dbt model the next reader can follow, while a function is followed only by whoever wrote it — so the boundary is also where the pipeline stops being self-explanatory.',
      consequences: [
        'Scope, filter and join in SQL stages; aggregate to the analysis grain in SQL. The python stage then starts from a small table whose every column it actually uses.',
        'A python stage placed first, on the raw source, is the shape to question: the server says so in the response (it can see the pipeline\'s shape, not what your functions do), and it is only right when the analysis really is per source row — a model scoring every event, for instance.',
        'If a step inside a function turns out to be a filter, a join or a group-by, it belongs in a stage before this one — move it and the function gets shorter and cheaper.',
        'The recipes are shaped this way on purpose: every one of them prepares the table in SQL stages and leaves the python stage with the statistics alone.',
      ],
    },
    {
      rule: 'The frame has no index and no row ORDER (dbt\'s wrapper runs with ordering_mode="partial").',
      short: `no index and no row ORDER (ordering_mode="partial"), and the library decides this per method: these raise OrderRequiredError until you sort_values/sort_index first — ${list(NEEDS_ORDER)}${BY_ARG.length ? `, and by argument ${list(BY_ARG)}` : ''}; these raise NullIndexError, full stop — ${list(NEEDS_INDEX)}; reset_index(drop=True) creates no index; alignment between two objects works only when both come from the same frame (a projection/filter/window of it), so a Series from another frame, a groupby aggregate, a cache()d frame or an ml result cannot be assigned into this one — merge on a key instead (merge is a SQL join and needs no index; .join() is the align path and is not the same thing)`,
      why: `Partial ordering mode stops BigFrames from building a total order over all rows — that order is what keeps filters from reducing the bytes scanned, so dropping it is what makes a query over a large partitioned table cheap. The price is positional access and index alignment. Which operations pay it is not a matter of interpretation: they are marked in the library (@requires_index / @requires_ordering), and the lists above are extracted from ${VERSION} rather than described.`,
      consequences: [
        'Ordering: sort_values (or sort_index) is what grants it — after that the whole list above is available, because the sorted node reports itself as explicitly ordered. Without it the op raises; it does not silently return an arbitrary slice.',
        'Alignment: two objects combine implicitly only while they share a root — df and df["x"] > 0 do; df and model.predict(df) do not, because predict re-reads its result as a new query.',
        'A lookup by key is therefore a merge, never Series.map(dict): map builds a local frame, indexes it, and joins — one side indexed, one side not, which always raises here.',
        'groupby provides both an index and an order by its keys, which is why transform() broadcasts inside one frame but an aggregate assigned back does not.',
      ],
    },
    {
      rule: 'Execution is deferred and repeated: the same operations can be re-run by every dependent query.',
      short: 'execution is deferred and repeats per dependent query — cache() an intermediate several results derive from (it stores a temporary BigQuery table you pay for)',
      why: 'BigFrames builds the expression locally and runs it when a result is needed, so an expensive join reached from three places is paid for three times. cache() materializes it once into a temporary BigQuery table (you pay for that table\'s storage).',
    },
    {
      rule: 'Stay in column expressions; a Python function per row is not something BigQuery can run.',
      short: 'stay in column expressions — a function passed to apply/map is tried once as a vectorized expression and otherwise fails ("convert it to a BigFrames BigQuery function"); real per-row Python means bpd.udf / bpd.remote_function, which deploys a Cloud Run service at call time',
      why: 'A plain function handed to apply/map is attempted once as a vectorized expression over the whole column and otherwise fails ("convert it to a BigFrames BigQuery function"). A real per-row function has to be deployed as a bpd.udf / bpd.remote_function, which creates a Cloud Run service at call time — a deliberate choice, not a default.',
    },
    {
      rule: 'to_pandas() leaves BigQuery: it downloads the whole result into the notebook runtime.',
      short: 'to_pandas() leaves BigQuery (whole result into the notebook, single-node) — only on a small, already-aggregated frame',
      why: 'Single-node memory and transfer cost. Use it only on a small, already-aggregated frame — and never to get pandas semantics back for something a column expression can do.',
    },
    {
      rule: 'Types are BigQuery types, surfaced as pandas/PyArrow dtypes.',
      short: 'types are BigQuery types as pandas/PyArrow dtypes (INT64→Int64, NUMERIC→decimal128(38,9), TIMESTAMP→timestamp("us",tz="UTC"), ARRAY→list_, STRUCT→struct, JSON→ArrowDtype); PyArrow semantics win (date+Timedelta→TIMESTAMP); timedelta is INT64 microseconds, so round nanoseconds with .dt.round("us"); INTERVAL/RANGE unsupported',
      why: 'INT64 → Int64Dtype, FLOAT64 → Float64Dtype, STRING → StringDtype(pyarrow), NUMERIC → decimal128(38,9), TIMESTAMP → timestamp("us", tz="UTC"), ARRAY<T> → list_(T), STRUCT → struct(), JSON → ArrowDtype. Where Python and PyArrow disagree, PyArrow wins: date + Timedelta gives a TIMESTAMP, not a date. timedelta has no BigQuery type — it is stored as INT64 microseconds, so nanoseconds must be rounded (s.dt.round("us")) or the operation raises. INTERVAL and RANGE are not supported at all.',
    },
    {
      rule: 'What SQL has and pandas does not is in bigframes.bigquery (bbq).',
      short: 'what SQL has and pandas does not is in bigframes.bigquery (bbq): array_agg / array_length / array_to_string / struct / unix_micros|millis|seconds / sql_scalar — still SQL, still in BigQuery',
      why: 'array_agg / array_length / array_to_string for arrays, struct() to build a STRUCT column, unix_micros / unix_millis / unix_seconds for epochs, and sql_scalar() to inject a single-column SQL expression that the pandas API cannot say. All of it still compiles to SQL and stays in BigQuery.',
    },
    {
      rule: 'Modelling is bigframes.ml — the scikit-learn API executed as BigQuery ML, with BQML\'s parameters.',
      short: `modelling is bigframes.ml — the scikit-learn API run as BigQuery ML: fit trains in BigQuery and predict returns a frame; sklearn/scipy/statsmodels, which need to_pandas(), run single-node in the notebook instead. The parameters are BQML's, not scikit-learn's: an argument scikit-learn has and BQML lacks does not exist here (KMeans(standardize_features=...), n_init, random_state → TypeError: unexpected keyword argument), and everything after \`*\` is keyword-only — ${list(ML_KEY_SIGNATURES)}. Scaling is not a flag on an estimator but a transformer of its own (preprocessing.StandardScaler(), no parameters), alone or as the first of pipeline.Pipeline's exactly two steps (transform, estimator) — or done in SQL before the stage. Every extracted signature is listed in semantic_index({ guide: "python" }), and offered as a reference recipe of its own where this deployment ships recipes`,
      why: `fit() trains inside BigQuery and predict() returns a BigFrames frame, so the data never leaves; sklearn / scipy / statsmodels would first need to_pandas() and then run single-node in the notebook. The trap is the API's resemblance: these classes are wrappers OVER BQML — each constructor maps its parameters to CREATE MODEL options (cluster.py _BQML_PARAMS_MAPPING / _bqml_options), so the surface is BQML's, and a familiar sklearn argument with no BQML option raises TypeError. The signatures below are extracted from ${VERSION}, not remembered, and are also fetchable on their own with semantic_index({ recipe: "bf_ml_signatures" }): ${list(ML_SIGNATURES)}. Pipeline takes exactly two steps, (transform, estimator), and raises NotImplementedError for anything else.`,
      consequences: [
        'Before passing a parameter, check it against the signature list — the resemblance to scikit-learn is where the TypeError comes from, and the list is the whole surface in this version.',
        'Standardizing features is not a flag: preprocessing.StandardScaler() (which takes no parameters at all) either on its own, or as the first of Pipeline\'s two steps. Scaling already done in a SQL stage before this one is just as valid and cheaper.',
        'A transformer and an estimator both return their own re-read frame (see the alignment rule) — feed it to the next step or return it; do not assign its columns back into df.',
      ],
    },
  ],
  examples: [
    {
      task: 'Add a value from a lookup (a dict, a mapping you computed)',
      line: 'lookup: lookup = bpd.DataFrame({"k": [...], "v": [...]}); df = df.merge(lookup, on="k", how="inner") — not df["v"] = df["k"].map(d)',
      do: ['lookup = bpd.DataFrame({"k": list(sizes.keys()), "v": list(sizes.values())})', 'df = df.merge(lookup, on="k", how="inner")', 'return df'],
      avoid: ['df["v"] = df["k"].map(sizes)'],
      why: 'map aligns two objects by index, and this frame has none → NullIndexError. A merge is the join BigQuery runs anyway.',
    },
    {
      task: 'Put a per-group aggregate back on every row',
      line: 'per-group value back on rows: agg = df.groupby("k", as_index=False)["x"].mean(); df = df.merge(agg, on="k") — not df["m"] = df.groupby("k")["x"].mean()',
      do: ['agg = df.groupby("k", as_index=False)["amount"].mean().rename(columns={"amount": "avg_amount"})', 'df = df.merge(agg, on="k", how="left")', 'return df'],
      avoid: ['df["avg_amount"] = df.groupby("k")["amount"].mean()'],
      why: 'The groupby result is a different object with its own index; assigning it as a column needs alignment. Merge it back on the key.',
    },
    {
      task: 'A per-row group statistic that keeps the same number of rows',
      line: 'same-row group stat: df["m"] = df.groupby("k")["x"].transform("mean") (broadcasts within one frame, so it is legal)',
      do: ['df["avg_amount"] = df.groupby("k")["amount"].transform("mean")', 'return df'],
      why: 'transform broadcasts within the same frame — no alignment between two objects, so it is legal here.',
    },
    {
      task: 'Distinct values of a column',
      line: 'distinct: df.drop_duplicates(subset=["k"]) (works as is) or df["k"].unique(keep_order=False) — plain unique() raises, it keeps order',
      do: ['uniq = df.drop_duplicates(subset=["k"])[["k"]]', 'return uniq'],
      avoid: ['uniq = df["k"].unique()'],
      why: 'drop_duplicates needs no ordering (it is a ROW_NUMBER over a partition, so which copy survives is arbitrary — for a distinct list that is exactly what you want). Series.unique() defaults to keep_order=True, which demands an ordering and raises; unique(keep_order=False) is the aggregate form and is fine. A groupby on the key is the third form, and the one to use when you want the counts too.',
    },
    {
      task: 'The top N rows by a column',
      line: 'top N: df.sort_values("x", ascending=False).head(10) — head/tail/iloc/nlargest all raise OrderRequiredError on an unsorted frame',
      do: ['top = df.sort_values("revenue", ascending=False).head(10)', 'return top'],
      avoid: ['top = df.head(10)', 'top = df.nlargest(10, "revenue")'],
      why: 'There is no "first" row until you say what first means, and the library does not guess: head, tail and iat raise, and nlargest/nsmallest raise too unless keep="all" (they have to break ties). sort_values is what makes the frame explicitly ordered — after it, every one of those works.',
    },
    {
      task: 'Look at a few rows (in a notebook, not in a model)',
      line: 'peek: df.peek(5) — an arbitrary sample, no ordering needed, but it returns pandas: for looking, never as the model\'s result',
      do: ['sample = df.peek(5)  # pandas, local — inspect only'],
      avoid: ['return df.peek(5)'],
      why: 'peek(n) executes and brings n arbitrary rows back as a pandas object, so it needs no ordering (unlike head) — and cannot be what the stage returns, because the stage must return a frame this runtime can materialize.',
    },
    {
      task: 'A CASE / conditional column',
      line: 'CASE: df["tier"] = np.where(df["x"] > 100, "high", "low") — not .apply(lambda ...)',
      do: ['import numpy as np  (declare it in `imports`)', 'df["tier"] = np.where(df["revenue"] > 100, "high", "low")', 'return df'],
      avoid: ['df["tier"] = df["revenue"].apply(lambda x: "high" if x > 100 else "low")'],
      why: 'np.where over columns of the same frame compiles to a SQL CASE. A lambda is Python per row, which this runtime cannot execute.',
    },
    {
      task: 'Arithmetic, normalization, a z-score',
      line: 'z-score/arithmetic: df["z"] = (df["x"] - df["x"].mean()) / df["x"].std() — std() takes no ddof here (it is the sample form, N-1)',
      do: ['df["revenue_z"] = (df["revenue"] - df["revenue"].mean()) / df["revenue"].std()', 'return df'],
      avoid: ['df["revenue_z"] = (df["revenue"] - df["revenue"].mean()) / df["revenue"].std(ddof=0)'],
      why: 'Aggregates of the same frame come back as scalars and broadcast over its rows — one SQL statement, no alignment. But std() here is std(self): there is no ddof parameter at all, and passing it is a TypeError. It is the sample deviation (N-1); for the population form write it out — ((s - s.mean()) ** 2).mean() ** 0.5 — and say which one the number is.',
    },
    {
      task: 'Keep only some rows',
      line: 'filter: df = df[(df["x"] > 0) & (df["c"] == "US")] — a mask from the same frame; a Series of another frame must be merged in first',
      do: ['df = df[(df["revenue"] > 0) & (df["country"] == "US")]', 'return df'],
      avoid: ['df = df[other_frame["flag"]]'],
      why: 'A mask built from the same frame is fine. A Series from another frame has to be merged in first — there is no index to align on.',
    },
    {
      task: 'Reuse an expensive intermediate',
      line: 'reuse: joined = df.merge(other, on="k"); joined.cache(); then derive everything from `joined` (objects taken before the cache have a different root)',
      do: ['joined = df.merge(other, on="k", how="inner")', 'joined.cache()', 'top = joined.sort_values("amount", ascending=False).head(10)', 'return top'],
      avoid: ['mask = joined["amount"] > 0', 'joined.cache()', 'top = joined[mask]  # mask predates the cache → different root'],
      why: 'Deferred execution would otherwise recompute the join for every derived result; cache() materializes it into a temporary BigQuery table (which you pay to store). It does that by replacing the object\'s own node with a read of that table and returning self — so anything derived before the call belongs to the old expression, and combining the two raises.',
    },
    {
      task: 'Read a STRUCT field / an ARRAY element out of a payload column',
      line: 'payload: df["m"] = df["p"].struct.field("mode"); df["n"] = df["items"].list.len(); df["first"] = df["items"].list[0]',
      do: ['df["mode"] = df["payload"].struct.field("mode")', 'df["items_n"] = df["items"].list.len()', 'df["first_item"] = df["items"].list[0]', 'return df'],
      why: 'The struct / list accessors are the typed way in; they stay SQL. (In this server a flattened payload column usually needs no accessor at all.)',
    },
    {
      task: 'Aggregate values into an array per group, or build a STRUCT column',
      line: 'array per group: bbq.array_agg(df.groupby("k")["c"]); STRUCT column: bbq.struct(df[["a","b"]])',
      do: ['import bigframes.bigquery as bbq  (declare it in `imports`)', 'per_user = bbq.array_agg(df.groupby("player_id")["event_name"])', 'return per_user.to_frame(name="events")'],
      why: 'array_agg has no pandas equivalent; bbq exposes the BigQuery function. bbq.struct(df[[...]]) builds a STRUCT column the same way.',
    },
    {
      task: 'Something only SQL can express',
      line: 'SQL-only: df["s"] = bbq.sql_scalar("LEAST({0}, {1})", columns=[df["a"], df["b"]])',
      do: ['import bigframes.bigquery as bbq  (declare it in `imports`)', 'df["shortest"] = bbq.sql_scalar("LEAST({0}, {1})", columns=[df["a"], df["b"]])', 'return df'],
      why: 'sql_scalar injects a single-column SQL expression without leaving BigQuery — the escape hatch instead of to_pandas().',
    },
    {
      task: 'Timestamps to epochs, durations',
      line: 'epochs/durations: bbq.unix_micros(df["t"]); bpd.to_timedelta(df["sec"], unit="s")',
      do: ['import bigframes.bigquery as bbq  (declare it in `imports`)', 'df["ts_us"] = bbq.unix_micros(df["event_time"])', 'df["age"] = bpd.to_timedelta(df["seconds"], unit="s")', 'return df'],
      why: 'timedelta is stored as INT64 microseconds; nanosecond input must be rounded with .dt.round("us") first or the operation raises.',
    },
    {
      task: 'Cluster / segment rows (KMeans)',
      line: 'clustering: m = KMeans(n_clusters=4); m.fit(X); out = m.predict(df) → return out (it already carries every input column + CENTROID_ID) — do not assign df["segment"] = m.predict(X)[...]',
      do: ['from bigframes.ml.cluster import KMeans  (declare it in `imports`)', 'model = KMeans(n_clusters=4)  # and only the parameters in the signature: init, init_col, distance_type, max_iter, tol, warm_start', 'model.fit(df[["sessions", "playtime", "revenue"]])', 'out = model.predict(df)', 'return out'],
      avoid: ['df["segment"] = model.predict(df[["sessions", "playtime", "revenue"]])["CENTROID_ID"]', 'model = KMeans(n_clusters=4, standardize_features=True)  # TypeError: no such parameter here'],
      why: 'predict wraps its input in a BigQuery ML table function and re-reads the result as a new query, so the frame it returns has a different root than df — assigning its column into df is a cross-frame alignment and raises NullIndexError. It is also unnecessary: that output already contains every input column with the prediction appended (CENTROID_ID for clustering, predicted_<label> for a supervised model), so return it and declare those columns in output.columns. The same holds for preprocessing transform/fit_transform. The second `avoid` is the other half: the constructor is BQML\'s, so a scikit-learn argument it does not have (standardize_features, n_init, random_state, algorithm) is a TypeError — scale with preprocessing.StandardScaler(), or in a SQL stage before this one.',
    },
    {
      task: 'Scale / encode features before a model',
      line: 'scaling: scaled = StandardScaler().fit_transform(df[[...]]) → a new frame (feed it to fit, or return it); do not assign its columns into df',
      do: ['from bigframes.ml.preprocessing import StandardScaler  (declare it in `imports`)', 'scaled = StandardScaler().fit_transform(df[["sessions", "playtime"]])', 'model.fit(scaled)', 'return model.predict(df)'],
      avoid: ['df["sessions_scaled"] = StandardScaler().fit_transform(df[["sessions"]])["sessions"]'],
      why: 'The preprocessing transformers are BigQuery ML too — same API as scikit-learn, no data movement — and like predict they return their own re-read frame, so use it as the next step\'s input rather than assigning it back. StandardScaler() takes no parameters, and there is no scaling flag on the estimator to use instead. To have BQML do both in one model, pipeline.Pipeline([("scale", StandardScaler()), ("model", KMeans(n_clusters=4))]) — exactly two steps, (transform, estimator); a third raises NotImplementedError.',
    },
    {
      task: 'Train and evaluate with a split',
      line: 'split: from bigframes.ml.model_selection import train_test_split; X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)',
      do: ['from bigframes.ml.model_selection import train_test_split  (declare it in `imports`)', 'X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)', 'model.fit(X_train, y_train)', 'return model.score(X_test, y_test)'],
      why: 'train_test_split / KFold / cross_validate exist in bigframes.ml.model_selection and keep the split in BigQuery.',
    },
    {
      task: 'Bring a small result back to real pandas (last resort)',
      line: 'pandas (last resort): aggregate first, then small.to_pandas()',
      do: ['small = df.groupby("country", as_index=False)["revenue"].sum()', 'pdf = small.to_pandas()'],
      why: 'Only after aggregating: to_pandas() downloads everything it is given into the notebook runtime.',
    },
  ],
  // (The mechanics of declaring a stage in THIS server — imports / functions / steps, what the
  // server writes, output.columns — are the stage description's job, layer 6 of the list at the
  // top of this file, and the guide's `dbt` bullets below say what the generated model carries.)
  dbt: [
    'The server writes the dbt model around your functions: def model(dbt, session), dbt.ref() of the previous model (or the source when your stage is first), dbt.config(...) and the return. You declare imports, functions and the ordered steps — nothing else.',
    'dbt.config carries submission_method="bigframes" (which is what makes dbt run this on BigFrames rather than its default submission), materialized="table", and the packages your imports need.',
    'The frame your first step receives IS dbt.ref() — untouched, in BigFrames form. What the last step returns IS this model\'s table, so declare output.columns for the SQL stages that follow it.',
    'Additional PyPI packages are installed in the execution environment when declared; the import allowlist of this server decides which ones may be named.',
  ],
};

const COOKBOOKS = { bigframes: BIGFRAMES };

/**
 * The authoring guide for the runtime this deployment actually submits to, or null when that
 * runtime has none written. `profile` is a frame profile (src/python-model.js).
 */
export function pythonAuthoringGuide(profile, recipes = []) {
  if (!profile) return null;
  const index = (recipes || []).map((r) => (typeof r === 'string' ? { id: r } : r)).filter((r) => r?.id);
  const book = COOKBOOKS[profile.key];
  if (!book) {
    // No cookbook for this runtime: the stage description's own rules are still the contract.
    return profile.guide ? { runtime: profile.key, frame: profile.native, rules_text: profile.guide, note: 'No worked examples are written for this runtime yet; the rules above are the contract, and the stage description carries them too.' } : null;
  }
  return {
    runtime: profile.key,
    frame: profile.native,
    note: 'How to write a python stage for this warehouse runtime, in order: what belongs in a python stage at all (only what SQL cannot say — the table it reads is prepared by SQL stages), the five ways pandas code fails here, the rules with the reason each exists, one worked example per operation, and the checklist to run before declaring the stage. `do` / `avoid` are the lines of one declared function over `df` — the frame dbt.ref() returns. This is the long form: the stage description carries the five failures, the checklist and the pointers here.',
    runs_where: book.runs_where,
    belongs: book.belongs,
    common_failures: book.traps({ full: true }),
    rules: book.rules,
    examples: book.examples,
    before_you_submit: book.checklist,
    dbt: book.dbt,
    modelling: profile.ml || undefined,
    // the other places to look (this guide is the one being read)
    elsewhere: whereTheFullTextIs(index).slice(1),
    ...(index.length ? {
      recipes: {
        ids: index.map((r) => r.id),
        moves: index.filter((r) => r.title).map((r) => `${r.id}: ${r.title}`),
        note: 'Read these before writing a function — and not only the nearest one: a real question needs several. They are not per-business-task templates: each is one approach — the correct form of a single move on this runtime (a lookup, a per-group value, a top-N, a threshold, a prediction, a cached intermediate) as a complete compiling payload, with `approach` = the form that works, `instead_of` = the form that raises and why, and `hack` = how to generalise it. `moves` says which id covers which move; they are listed side by side under `tasks` in semantic_index({ guide: true }) too.',
        fetch: `semantic_index({ recipe: '${index[0].id}' })`,
      },
    } : {}),
    read_next: index.length
      ? `Read the recipes before you write: fetch every move your question involves (semantic_index({ recipe: '${index[0].id}' }), … — \`recipes.moves\` above says which id covers which), adapt them, and only then declare the stage with build_pipeline_model({ action: "add_step", stage: { stage: "python", imports, functions, steps, output } }); the stage description lists the allowlisted packages.`
      : 'Declare the stage with build_pipeline_model({ action: "add_step", stage: { stage: "python", imports, functions, steps, output } }); the stage description lists the allowlisted packages.',
  };
}

/**
 * The COMPACT rendering of a runtime's cookbook — what the python stage DESCRIPTION carries.
 *
 * With recipes it is an INDEX: why this runtime bites (`headline`), then each recipe id with the
 * move it covers, an instruction to study them, and the stage form. Without them (a deployment
 * shipping none) there is nothing to point at, so it falls back to every rule's `short` and every
 * example's `line` — built from the same data as the full guide, so the two cannot drift.
 */
export function pythonRulesText(key, recipes = []) {
  const book = COOKBOOKS[key];
  if (!book) return '';
  // Recipes may arrive as { id, title } (what a deployment's recipe file gives) or as bare ids.
  const index = (recipes || []).map((r) => (typeof r === 'string' ? { id: r } : r)).filter((r) => r?.id);
  const bullets = (xs) => xs.map((x) => `- ${x}`).join('\n');
  // WITH recipes, the forms per move are in them and the reasoning is in the guide: the description
  // carries the five ways pandas code fails here, the checklist and where the rest is. WITHOUT them
  // there is nothing to point at, so every rule and the right form per operation come along
  // instead — from the same data as the guide, so the two cannot drift.
  const body = index.length
    ? [`This frame is not pandas — code that reads correctly in pandas fails here in five ways:\n${bullets(book.traps({ full: !index.some((r) => r.id === 'bf_frame_method_rules') }))}`]
    : [
      `The rules:\n${bullets(book.rules.slice(1).map((r) => r.short).filter(Boolean))}`,
      `The right form per operation:\n${bullets(book.examples.map((e) => e.line).filter(Boolean))}`,
    ];
  return [
    `Rules for ${key} (${VERSION}). How it runs: ${book.runs_where}`,
    book.rules[0].short,
    ...body,
    `Before you declare the stage, check that: ${book.checklist.join('; ')}.`,
    `Where the full text is:\n${bullets(whereTheFullTextIs(index))}`,
    'How to declare the stage here — imports, functions, steps, output.columns — follows.',
  ].join('\n');
}

/**
 * THE ML LIBRARY'S CLASSES, grouped by module, from the extracted sheet — for the one line a frame
 * profile needs ("modelling is this library, and these are its classes"). The PARAMETERS are not
 * repeated there: they are in the reference recipe and in the guide's own rule, so a reader is
 * never offered two lists that can disagree.
 */
export function mlClassesText() {
  const per = FACTS?.ml || {};
  const mods = Object.entries(per).map(([mod, entries]) => {
    const names = Object.keys(entries).map((c) => c.replace(/\(\)$/, '()'));
    return `${mod}.${names.join(' / ')}`;
  });
  return mods.length ? mods.join('; ') : null;
}

/**
 * WHAT A FAILURE CLASS MEANS on this runtime — the hints a failed run is annotated with
 * (`pythonRunHints` matches them; the frame profile carries them). They live HERE, next to the
 * rules, because they state the same facts: the method lists come from the extracted sheet and the
 * claims from its `rules`, so a hint can never name a method the guide does not, or the other way
 * round. The hint says what the class name means and which forms do not hit it; HOW to write the
 * code is the guide's job, and the signatures are the reference recipe's.
 */
export function bigframesRunHints() {
  const claim = (id) => (FACTS?.rules || []).find((r) => r.id === id)?.claim || '';
  return [
    {
      match: 'NullIndexError|Cannot implicitly align',
      hint: 'About this runtime: the frame dbt.ref() returns carries no index, so two objects can only be combined while they share a root — the same frame, narrowed by a projection, a filter or a window. Anything re-read as its own query is a different root: a locally built frame, a groupby aggregate, a cache()d frame, and the output of bigframes.ml predict/transform. '
        + `${claim('align_needs_common_root')} The traceback says which operation it was; the forms that do not need alignment are a merge on a key (a SQL join), a value computed from the same frame, and — for an estimator — returning its frame instead of assigning its column back (that output already carries the input columns). Worked forms: semantic_index({ recipe: "bf_lookup_via_merge" }) / ({ recipe: "bf_ml_predict_as_column" }).`,
    },
    {
      match: 'OrderRequiredError',
      hint: `About this runtime: it carries no row order (the dbt wrapper runs with ordering_mode="partial"), and the operations that need one are marked in the library — ${list(NEEDS_ORDER)}${BY_ARG.length ? `, and by argument ${list(BY_ARG)}` : ''}. sort_values (or sort_index) before the operation is what grants the ordering — nothing else does. The full list with the index-only ones: semantic_index({ recipe: "bf_frame_method_rules" }).`,
    },
    {
      match: 'unexpected keyword argument|__init__\\(\\) got an unexpected',
      hint: `About this runtime: ${claim('ml_is_bqml_not_sklearn')} Fetch the signature instead of guessing: semantic_index({ recipe: "bf_ml_signatures" }). Scaling is not a flag either — ${claim('ml_scaling_is_a_transformer')}`,
    },
    {
      // The library's own words for it, so the matcher cannot fire on the word "pipeline" in
      // our own build log: pipeline.py raises "Currently only two step (transform, estimator)
      // pipelines are supported."
      match: 'only two step|two step \\(transform',
      hint: 'About this runtime: pipeline.Pipeline takes exactly two steps, (transform, estimator), and raises NotImplementedError for anything else — several transformers go inside one compose.ColumnTransformer as that single transform step (semantic_index({ recipe: "bf_ml_categoricals_into_a_model" })). Feature work that is not a transformer belongs in a SQL stage before this one.',
    },
    {
      // The runtime's own way of running out of room, which is a different failure from the
      // warehouse killing a SQL query (that one is answered by sqlRunHints in src/pipeline.js).
      match: 'MemoryError|out of memory|Resources exceeded|killed',
      hint: 'About this runtime: the BigFrames frame itself does not hold rows — BigQuery does — so running out of memory here almost always means something left BigQuery: to_pandas(), a locally built bpd.DataFrame from a large list, or a library (sklearn / scipy / statsmodels) that needs a pandas frame first. All of those are single-node in the notebook. Aggregate to the grain the analysis works on before converting — and better, in a SQL stage before this one.',
    },
    {
      match: 'convert it to a BigFrames BigQuery function|remote_function',
      hint: 'About this runtime: it runs no Python per row — a plain function passed to apply/map is attempted once as a vectorized expression over the whole column, and fails this way when it cannot be one. A CASE over columns (np.where) or a merge against a small frame is the form that compiles.',
    },
  ];
}

/**
 * REFERENCE ENTRIES — the extracted facts offered as fetchable recipes.
 *
 * The long guide carries these lists inside its reasoning, which is the wrong place to look
 * something up mid-write: a caller about to pass a parameter wants the signature, not the essay.
 * So the same fact sheet is also published as two REFERENCE recipes, addressable by id
 * (semantic_index({ recipe: 'bf_ml_signatures' })) and filtered by the ordinary capability rules —
 * they are offered only where this deployment submits to BigFrames.
 *
 * They are GENERATED from config/bigframes-facts.json, never hand-written: the version they name is
 * the version they were read from, and a library upgrade regenerates both the sheet and these.
 * An operator can still override either id in their own recipe file (a later id wins in
 * loadRecipes), which is why these carry origin 'generated' rather than 'system'.
 */
export function pythonReferenceRecipes() {
  if (!FACTS?.ml && !FACTS?.requires_ordering) return [];
  const version = FACTS?.version ? `bigframes ${FACTS.version}` : 'the installed bigframes';
  const out = [];
  if (FACTS?.ml) {
    out.push({
      id: 'bf_ml_signatures',
      task_type: 'bigframes',
      requires: 'python_models',
      runtime: 'bigframes',
      title: `Reference: every bigframes.ml constructor and its parameters (${version})`,
      when_to_use: 'Before passing any parameter to an estimator or a transformer — and the moment a run fails with "TypeError: __init__() got an unexpected keyword argument".',
      approach: 'Read the signature of the class you are about to build and pass only what is in it. `positional` may be given positionally or by name; everything in `keyword_only` must be named. A parameter that is not in either list does not exist in this version — no matter what scikit-learn accepts.',
      instead_of: 'Passing a scikit-learn parameter by analogy: KMeans(standardize_features=True), n_init, random_state, algorithm. bigframes.ml wraps BigQuery ML, so a constructor takes the options its BQML model type has and nothing else.',
      reference: { library: 'bigframes', version: FACTS.version || null, of: 'ml constructors', signatures: FACTS.ml },
      notes: 'Extracted from the library itself (scripts/bigframes-facts.py → config/bigframes-facts.json), so this is that version\'s surface rather than a memory of the docs — the constructors. What the methods return is not a parameter list and is written per capability in the worked recipes: a prediction per row (bf_ml_predict_as_column, bf_ml_supervised_fit_predict), an output that replaces the frame (bf_ml_reduce_dimensions, bf_ml_output_replaces_frame), an evaluation (bf_ml_evaluate_with_split), categorical features (bf_ml_categoricals_into_a_model), parameters and scaling (bf_ml_estimator_params). Two facts that are not parameters either: a transformer/estimator returns its own re-read frame (assigning its column back raises NullIndexError), and pipeline.Pipeline takes exactly two steps, (transform, estimator). KMeans, PCA and ARIMAPlus also carry detect_anomalies(X, *, contamination) — its output columns are BigQuery ML\'s, so read them off the first run rather than assuming them.',
      hack: 'Scaling, splitting and encoding are steps of their own, not flags on the estimator — anything the signature lacks is either another object (a transformer) or work for a SQL stage before the python one.',
      origin: 'generated',
    });
  }
  if (FACTS?.requires_ordering || FACTS?.requires_index) {
    out.push({
      id: 'bf_frame_method_rules',
      task_type: 'bigframes',
      requires: 'python_models',
      runtime: 'bigframes',
      title: `Reference: which DataFrame/Series methods need an ordering or an index, and the signatures that surprise (${version})`,
      when_to_use: 'Before using a positional / ordered / index-based method on the frame dbt.ref() returns, and when a run fails with OrderRequiredError or NullIndexError.',
      approach: 'Look the method up in the lists below. `requires_ordering` raises OrderRequiredError until the frame is explicitly ordered — sort_values (or sort_index) is what grants that, nothing else. `requires_index` raises NullIndexError here, full stop: this frame has no index at all. `ordering_enforced_by_argument` is the middle case — the method is allowed once the named argument is set (unique(keep_order=False), nlargest(keep="all")).',
      instead_of: 'Trying the pandas form and reading the traceback: head/tail/nlargest on an unsorted frame, loc/at/idxmax on an indexless one, Series.map(dict) for a lookup (use merge), std(ddof=0) (this version\'s std takes no parameters).',
      reference: {
        library: 'bigframes',
        version: FACTS.version || null,
        of: 'frame method preconditions',
        requires_ordering: FACTS.requires_ordering || {},
        requires_index: FACTS.requires_index || {},
        ordering_enforced_by_argument: FACTS.ordering_enforced_by_argument || {},
        signatures: FACTS.signatures || {},
        rules: (FACTS.rules || []).map((r) => ({ id: r.id, claim: r.claim })),
      },
      notes: 'The lists come from the library\'s own decorators (@validations.requires_index / @requires_ordering) and the signatures from its source, so they are exact for this version. The reasoning behind each, with a do / avoid per operation, is semantic_index({ guide: "python" }).',
      hack: 'Two questions before every line: does this need a row ORDER (then sort first), and does it combine two objects (then they must share a root, or be merged on a key).',
      origin: 'generated',
    });
  }
  return out;
}

/** The runtime keys a written cookbook exists for (for tests and for the guide's own listing). */
export function pythonGuideRuntimes() {
  return Object.keys(COOKBOOKS);
}
