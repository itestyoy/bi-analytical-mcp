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
//   - compressed, as the python stage's own DESCRIPTION (`pythonRulesText`) — why this runtime
//     bites, an INDEX of the worked recipes (which one covers which move) with an instruction to
//     study them, and how a stage is declared here; where a deployment ships no recipes there is
//     nothing to point at, so the description falls back to every rule and the right form per
//     operation;
//   - in full, through semantic_index({ guide: 'python' }) (`pythonAuthoringGuide`) — the same
//     rules WITH the reasoning behind each, and each example as do / avoid / why.
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

const BIGFRAMES = {
  // The one paragraph that STAYS in the stage description when the worked recipes carry the forms:
  // what is different about this frame and what it costs to ignore. Everything specific — the form
  // per move, the reasoning per rule — is behind the recipe index and the full guide.
  // THE COMPACT FORM, and deliberately so: this string goes into the stage DESCRIPTION, which every
  // caller is handed on every request whether or not it will write python. It names what belongs
  // here and what this frame is, and sends the reader to the guide for the reasoning and to the
  // recipes for the code. The long version of the same rule is rules[0] below.
  headline: 'WHAT BELONGS HERE: only what SQL cannot say — a statistical test, clustering, scoring, a forecast, a model. Everything else, INCLUDING preparing the table this analysis reads (scope, payload columns, joins, the aggregation to the analysis grain), is a SQL stage BEFORE this one: this stage receives a PREPARED table at that grain, never the raw source.',
  runs_where: 'dbt runs this model in a Colab Enterprise notebook: the BigFrames library turns your DataFrame operations into BigQuery SQL and BigQuery executes it. Nothing runs row by row in Python, and nothing is transferred out of BigQuery unless you ask for it with to_pandas().',
  rules: [
    {
      rule: 'A python stage computes ONLY what SQL cannot say. Everything else — including preparing the table it reads — is a SQL stage before it.',
      short: 'WHAT BELONGS HERE: only what SQL cannot say — a statistical test, clustering, scoring, a forecast, a model. Everything else is a SQL stage BEFORE this one, and that INCLUDES the preparation of the table this analysis reads: scope to the events and the time window, extract the payload columns, join the attributes, aggregate to the grain the analysis works on. This stage receives a PREPARED table at that grain, never the raw source',
      why: 'Three reasons, and none of them is taste. COST AND EXACTNESS: a SQL stage runs where the data already lives, reads only the columns it names, and its aggregate is exact; handing the raw table to the python runtime moves the same work to a slower place and pays for the scan. THE RUNTIME: this stage is a separate dbt model on the warehouse\'s python runtime — a cold start of minutes, and everything it touches it touches through that runtime\'s limits (here: no index, no row order, deferred execution), so the less it has to do, the fewer of those limits you meet. READABILITY: a SQL stage stays a dbt model the next reader can follow, while a function is followed only by whoever wrote it — so the boundary is also where the pipeline stops being self-explanatory.',
      consequences: [
        'Scope, filter and join in SQL stages; aggregate to the analysis grain in SQL. The python stage then starts from a small table whose every column it actually uses.',
        'A python stage placed FIRST, on the raw source, is the shape to question: the server says so in the response (it can see the pipeline\'s shape, not what your functions do), and it is only right when the analysis really is per source row — a model scoring every event, for instance.',
        'If a step inside a function turns out to be a filter, a join or a group-by, it belongs in a stage before this one — move it and the function gets shorter and cheaper.',
        'The recipes are shaped this way on purpose: every one of them prepares the table in SQL stages and leaves the python stage with the statistics alone.',
      ],
    },
    {
      rule: 'The frame has NO INDEX and NO ROW ORDER (dbt\'s wrapper runs with ordering_mode="partial").',
      short: `NO INDEX and NO ROW ORDER (ordering_mode="partial"), and the library decides this per METHOD: these RAISE OrderRequiredError until you sort_values/sort_index first — ${list(NEEDS_ORDER)}${BY_ARG.length ? `, and by argument ${list(BY_ARG)}` : ''}; these RAISE NullIndexError, full stop — ${list(NEEDS_INDEX)}; reset_index(drop=True) creates NO index; ALIGNMENT between two objects works only when both come from the SAME frame (a projection/filter/window of it), so a Series from another frame, a groupby aggregate, a cache()d frame or an ml result cannot be assigned into this one — merge on a key instead (merge is a SQL join and needs no index; .join() is the align path and is not the same thing)`,
      why: `Partial ordering mode stops BigFrames from building a total order over all rows — that order is what keeps filters from reducing the bytes scanned, so dropping it is what makes a query over a large partitioned table cheap. The price is positional access and index alignment. Which operations pay it is not a matter of interpretation: they are marked in the library (@requires_index / @requires_ordering), and the lists above are extracted from ${VERSION} rather than described.`,
      consequences: [
        'Ordering: sort_values (or sort_index) is what grants it — after that the whole list above is available, because the sorted node reports itself as explicitly ordered. Without it the op raises; it does not silently return an arbitrary slice.',
        'Alignment: two objects combine implicitly only while they share a root — df and df["x"] > 0 do; df and model.predict(df) do not, because predict re-reads its result as a new query.',
        'A lookup by key is therefore a merge, never Series.map(dict): map builds a local frame, indexes it, and joins — one side indexed, one side not, which always raises here.',
        'groupby provides both an index and an order by its keys, which is why transform() broadcasts inside one frame but an aggregate assigned back does not.',
      ],
    },
    {
      rule: 'Execution is DEFERRED and repeated: the same operations can be re-run by every dependent query.',
      short: 'execution is DEFERRED and repeats per dependent query — cache() an intermediate several results derive from (it stores a temporary BigQuery table you pay for)',
      why: 'BigFrames builds the expression locally and runs it when a result is needed, so an expensive join reached from three places is paid for three times. cache() materializes it once into a temporary BigQuery table (you pay for that table\'s storage).',
    },
    {
      rule: 'Stay in column expressions; a Python function per row is not something BigQuery can run.',
      short: 'stay in COLUMN EXPRESSIONS — a function passed to apply/map is tried once as a vectorized expression and otherwise fails ("convert it to a BigFrames BigQuery function"); real per-row Python means bpd.udf / bpd.remote_function, which deploys a Cloud Run service at call time',
      why: 'A plain function handed to apply/map is attempted once as a vectorized expression over the whole column and otherwise fails ("convert it to a BigFrames BigQuery function"). A real per-row function has to be deployed as a bpd.udf / bpd.remote_function, which creates a Cloud Run service at call time — a deliberate choice, not a default.',
    },
    {
      rule: 'to_pandas() leaves BigQuery: it downloads the whole result into the notebook runtime.',
      short: 'to_pandas() LEAVES BigQuery (whole result into the notebook, single-node) — only on a small, already-aggregated frame',
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
      rule: 'Modelling is bigframes.ml — the scikit-learn API executed as BigQuery ML, with BQML\'s PARAMETERS.',
      short: `modelling is bigframes.ml (the scikit-learn API run as BigQuery ML: fit trains IN BigQuery, predict returns a frame) — NEVER sklearn/scipy/statsmodels, which need to_pandas() and run single-node. BUT THE PARAMETERS ARE BQML'S, NOT SKLEARN'S: an argument sklearn has and BQML does not simply does not exist (KMeans(standardize_features=...), n_init, random_state → TypeError: unexpected keyword argument), and everything after \`*\` is KEYWORD-ONLY — ${list(ML_KEY_SIGNATURES)}; there is no scaling flag on an estimator: scaling is a transformer of its own (preprocessing.StandardScaler(), no parameters), alone or as the FIRST of pipeline.Pipeline's EXACTLY TWO steps (transform, estimator) — or done in SQL before the stage. Every extracted signature is listed in semantic_index({ guide: "python" }), and offered as a reference recipe of its own where this deployment ships recipes`,
      why: `fit() trains inside BigQuery and predict() returns a BigFrames frame, so the data never leaves; sklearn / scipy / statsmodels would first need to_pandas() and then run single-node in the notebook. The trap is the API's resemblance: these classes are WRAPPERS OVER BQML — each constructor maps its parameters to CREATE MODEL options (cluster.py _BQML_PARAMS_MAPPING / _bqml_options), so the surface is BQML's, and a familiar sklearn argument with no BQML option raises TypeError. The signatures below are extracted from ${VERSION}, not remembered, and are also fetchable on their own with semantic_index({ recipe: "bf_ml_signatures" }): ${list(ML_SIGNATURES)}. Pipeline takes exactly two steps, (transform, estimator), and raises NotImplementedError for anything else.`,
      consequences: [
        'Before passing a parameter, check it against the signature list — the resemblance to scikit-learn is where the TypeError comes from, and the list is the whole surface in this version.',
        'Standardizing features is not a flag: preprocessing.StandardScaler() (which takes no parameters at all) either on its own, or as the first of Pipeline\'s two steps. Scaling already done in a SQL stage before this one is just as valid and cheaper.',
        'A transformer and an estimator both RETURN their own re-read frame (see the alignment rule) — feed it to the next step or return it; do not assign its columns back into df.',
      ],
    },
  ],
  examples: [
    {
      task: 'Add a value from a lookup (a dict, a mapping you computed)',
      line: 'lookup: lookup = bpd.DataFrame({"k": [...], "v": [...]}); df = df.merge(lookup, on="k", how="inner") — NOT df["v"] = df["k"].map(d)',
      do: ['lookup = bpd.DataFrame({"k": list(sizes.keys()), "v": list(sizes.values())})', 'df = df.merge(lookup, on="k", how="inner")', 'return df'],
      avoid: ['df["v"] = df["k"].map(sizes)'],
      why: 'map aligns two objects by index, and this frame has none → NullIndexError. A merge is the join BigQuery runs anyway.',
    },
    {
      task: 'Put a per-group aggregate back on every row',
      line: 'per-group value back on rows: agg = df.groupby("k", as_index=False)["x"].mean(); df = df.merge(agg, on="k") — NOT df["m"] = df.groupby("k")["x"].mean()',
      do: ['agg = df.groupby("k", as_index=False)["amount"].mean().rename(columns={"amount": "avg_amount"})', 'df = df.merge(agg, on="k", how="left")', 'return df'],
      avoid: ['df["avg_amount"] = df.groupby("k")["amount"].mean()'],
      why: 'The groupby result is a different object with its own index; assigning it as a column needs alignment. Merge it back on the key.',
    },
    {
      task: 'A per-row group statistic that keeps the same number of rows',
      line: 'same-row group stat: df["m"] = df.groupby("k")["x"].transform("mean") (broadcasts within ONE frame, so it is legal)',
      do: ['df["avg_amount"] = df.groupby("k")["amount"].transform("mean")', 'return df'],
      why: 'transform broadcasts within the SAME frame — no alignment between two objects, so it is legal here.',
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
      line: 'top N: df.sort_values("x", ascending=False).head(10) — head/tail/iloc/nlargest all RAISE OrderRequiredError on an unsorted frame',
      do: ['top = df.sort_values("revenue", ascending=False).head(10)', 'return top'],
      avoid: ['top = df.head(10)', 'top = df.nlargest(10, "revenue")'],
      why: 'There is no "first" row until you say what first means, and the library does not guess: head, tail and iat raise, and nlargest/nsmallest raise too unless keep="all" (they have to break ties). sort_values is what makes the frame explicitly ordered — after it, every one of those works.',
    },
    {
      task: 'Look at a few rows (in a notebook, not in a model)',
      line: 'peek: df.peek(5) — an arbitrary sample, no ordering needed, but it returns PANDAS: for looking, never as the model\'s result',
      do: ['sample = df.peek(5)  # pandas, local — inspect only'],
      avoid: ['return df.peek(5)'],
      why: 'peek(n) executes and brings n arbitrary rows back as a pandas object, so it needs no ordering (unlike head) — and cannot be what the stage returns, because the stage must return a frame this runtime can materialize.',
    },
    {
      task: 'A CASE / conditional column',
      line: 'CASE: df["tier"] = np.where(df["x"] > 100, "high", "low") — NOT .apply(lambda ...)',
      do: ['import numpy as np  (declare it in `imports`)', 'df["tier"] = np.where(df["revenue"] > 100, "high", "low")', 'return df'],
      avoid: ['df["tier"] = df["revenue"].apply(lambda x: "high" if x > 100 else "low")'],
      why: 'np.where over columns of the same frame compiles to a SQL CASE. A lambda is Python per row, which this runtime cannot execute.',
    },
    {
      task: 'Arithmetic, normalization, a z-score',
      line: 'z-score/arithmetic: df["z"] = (df["x"] - df["x"].mean()) / df["x"].std() — std() takes NO ddof here (it is the sample form, N-1)',
      do: ['df["revenue_z"] = (df["revenue"] - df["revenue"].mean()) / df["revenue"].std()', 'return df'],
      avoid: ['df["revenue_z"] = (df["revenue"] - df["revenue"].mean()) / df["revenue"].std(ddof=0)'],
      why: 'Aggregates of the same frame come back as scalars and broadcast over its rows — one SQL statement, no alignment. But std() here is std(self): there is no ddof parameter at all, and passing it is a TypeError. It is the SAMPLE deviation (N-1); for the population form write it out — ((s - s.mean()) ** 2).mean() ** 0.5 — and say which one the number is.',
    },
    {
      task: 'Keep only some rows',
      line: 'filter: df = df[(df["x"] > 0) & (df["c"] == "US")] — a mask from the SAME frame; a Series of ANOTHER frame must be merged in first',
      do: ['df = df[(df["revenue"] > 0) & (df["country"] == "US")]', 'return df'],
      avoid: ['df = df[other_frame["flag"]]'],
      why: 'A mask built from the SAME frame is fine. A Series from another frame has to be merged in first — there is no index to align on.',
    },
    {
      task: 'Reuse an expensive intermediate',
      line: 'reuse: joined = df.merge(other, on="k"); joined.cache(); then derive EVERYTHING from `joined` (objects taken before the cache have a different root)',
      do: ['joined = df.merge(other, on="k", how="inner")', 'joined.cache()', 'top = joined.sort_values("amount", ascending=False).head(10)', 'return top'],
      avoid: ['mask = joined["amount"] > 0', 'joined.cache()', 'top = joined[mask]  # mask predates the cache → different root'],
      why: 'Deferred execution would otherwise recompute the join for every derived result; cache() materializes it into a temporary BigQuery table (which you pay to store). It does that by REPLACING the object\'s own node with a read of that table and returning self — so anything derived before the call belongs to the old expression, and combining the two raises.',
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
      line: 'clustering: m = KMeans(n_clusters=4); m.fit(X); out = m.predict(df) → RETURN out (it already carries every input column + CENTROID_ID) — do NOT assign df["segment"] = m.predict(X)[...]',
      do: ['from bigframes.ml.cluster import KMeans  (declare it in `imports`)', 'model = KMeans(n_clusters=4)  # and only the parameters in the signature: init, init_col, distance_type, max_iter, tol, warm_start', 'model.fit(df[["sessions", "playtime", "revenue"]])', 'out = model.predict(df)', 'return out'],
      avoid: ['df["segment"] = model.predict(df[["sessions", "playtime", "revenue"]])["CENTROID_ID"]', 'model = KMeans(n_clusters=4, standardize_features=True)  # TypeError: no such parameter here'],
      why: 'predict wraps its input in a BigQuery ML table function and RE-READS the result as a new query, so the frame it returns has a different root than df — assigning its column into df is a cross-frame alignment and raises NullIndexError. It is also unnecessary: that output already contains every input column with the prediction appended (CENTROID_ID for clustering, predicted_<label> for a supervised model), so return it and declare those columns in output.columns. The same holds for preprocessing transform/fit_transform. The second `avoid` is the other half: the constructor is BQML\'s, so a scikit-learn argument it does not have (standardize_features, n_init, random_state, algorithm) is a TypeError — scale with preprocessing.StandardScaler(), or in a SQL stage before this one.',
    },
    {
      task: 'Scale / encode features before a model',
      line: 'scaling: scaled = StandardScaler().fit_transform(df[[...]]) → a NEW frame (feed it to fit, or return it); do not assign its columns into df',
      do: ['from bigframes.ml.preprocessing import StandardScaler  (declare it in `imports`)', 'scaled = StandardScaler().fit_transform(df[["sessions", "playtime"]])', 'model.fit(scaled)', 'return model.predict(df)'],
      avoid: ['df["sessions_scaled"] = StandardScaler().fit_transform(df[["sessions"]])["sessions"]'],
      why: 'The preprocessing transformers are BigQuery ML too — same API as scikit-learn, no data movement — and like predict they return their own re-read frame, so use it as the next step\'s input rather than assigning it back. StandardScaler() takes NO parameters, and there is no scaling flag on the estimator to use instead. To have BQML do both in one model, pipeline.Pipeline([("scale", StandardScaler()), ("model", KMeans(n_clusters=4))]) — EXACTLY two steps, (transform, estimator); a third raises NotImplementedError.',
    },
    {
      task: 'Train and evaluate with a split',
      line: 'split: from bigframes.ml.model_selection import train_test_split; X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)',
      do: ['from bigframes.ml.model_selection import train_test_split  (declare it in `imports`)', 'X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)', 'model.fit(X_train, y_train)', 'return model.score(X_test, y_test)'],
      why: 'train_test_split / KFold / cross_validate exist in bigframes.ml.model_selection and keep the split in BigQuery.',
    },
    {
      task: 'Bring a small result back to real pandas (last resort)',
      line: 'pandas (last resort): aggregate FIRST, then small.to_pandas()',
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
    note: 'How to write a python stage for THIS warehouse runtime: FIRST what belongs in a python stage at all (only what SQL cannot say — the table it reads is prepared by SQL stages), then the constraints and why they exist, then one worked example per OPERATION. `do` / `avoid` are the lines of ONE declared function over `df` — the frame dbt.ref() returns. This is the LONG form: the stage description itself carries the framing and an index of the worked recipes, and sends you here for the reasoning.',
    ...book,
    modelling: profile.ml || undefined,
    ...(index.length ? {
      recipes: {
        ids: index.map((r) => r.id),
        moves: index.filter((r) => r.title).map((r) => `${r.id}: ${r.title}`),
        note: 'STUDY THESE BEFORE WRITING A FUNCTION — and not only the nearest one: a real question needs several. They are not per-business-task templates: each is ONE APPROACH — the correct form of a single move on this runtime (a lookup, a per-group value, a top-N, a threshold, a prediction, a cached intermediate) as a COMPLETE compiling payload, with `approach` = the form that works, `instead_of` = the form that raises and why, and `hack` = how to generalise it. `moves` says which id covers which move; they are listed side by side under `tasks` in semantic_index({ guide: true }) too.',
        fetch: `semantic_index({ recipe: '${index[0].id}' })`,
      },
    } : {}),
    read_next: index.length
      ? `STUDY THE RECIPES BEFORE YOU WRITE: fetch EVERY move your question involves (semantic_index({ recipe: '${index[0].id}' }), … — \`recipes.moves\` above says which id covers which), adapt them, and only then declare the stage with build_pipeline_model({ action: "add_step", stage: { stage: "python", imports, functions, steps, output } }); the stage description lists the allowlisted packages.`
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

  // WITH recipes: the description is an INDEX, not a manual. Each move has a worked, compiling
  // payload that shows the right form next to the one that raises, so repeating those forms here
  // only makes the description longer and lets the two drift. What stays is why the runtime bites,
  // the index itself with an insistence on reading it, and how to declare the stage in this server.
  if (index.length) {
    return `RULES FOR ${key.toUpperCase()} — ${book.runs_where} ${book.headline || ''} `
      + `THIS FRAME IS NOT PANDAS: no index, no row order and deferred execution, so pandas code that reads correctly either raises (NullIndexError, OrderRequiredError) or answers a different question — and the modelling library wears scikit-learn's API over BigQuery ML, with BQML's parameters. `
      + `SO DO NOT WRITE A FUNCTION FROM MEMORY. semantic_index({ guide: "python" }) carries every rule with the reasoning and a do / avoid per operation, and it indexes ${index.length} worked, COMPILING recipes — one per move (a lookup, a per-group value, a top-N, a threshold, a prediction, an estimator's parameters, a cached intermediate), each showing the form that works next to the form that raises. Fetch the ones your question needs with semantic_index({ recipe: "<id>" }); their ids are in that guide and in the overview. A real question needs several. `
      + 'The mechanics of declaring the stage here — imports, functions, steps, output.columns — are on the stage description above.';
  }

  // WITHOUT recipes (a deployment that ships none) there is nothing to point at, so the description
  // carries the rules and the right form per operation itself — built from the same data.
  const rules = book.rules.map((r) => r.short).filter(Boolean);
  const lines = book.examples.map((e) => e.line).filter(Boolean);
  return `RULES FOR ${key.toUpperCase()} — ${book.runs_where} `
    + `${rules.map((r, i) => `(${i + 1}) ${r}`).join('; ')}. `
    + `THE RIGHT FORM PER OPERATION — ${lines.join('; ')}. `
    + `The same guide with the reasoning behind each rule and the full examples: semantic_index({ guide: "python" }).`;
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
      hint: 'About this runtime: the frame dbt.ref() returns carries NO INDEX, so two objects can only be combined while they share a root — the same frame, narrowed by a projection, a filter or a window. Anything re-read as its own query is a different root: a locally built frame, a groupby aggregate, a cache()d frame, and the output of bigframes.ml predict/transform. '
        + `${claim('align_needs_common_root')} The traceback says which operation it was; the forms that do not need alignment are a merge on a key (a SQL join), a value computed from the SAME frame, and — for an estimator — returning ITS frame instead of assigning its column back (that output already carries the input columns). Worked forms: semantic_index({ recipe: "bf_lookup_via_merge" }) / ({ recipe: "bf_ml_predict_as_column" }).`,
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
      hint: 'About this runtime: pipeline.Pipeline takes EXACTLY TWO steps, (transform, estimator), and raises NotImplementedError for anything else — several transformers go inside ONE compose.ColumnTransformer as that single transform step (semantic_index({ recipe: "bf_ml_categoricals_into_a_model" })). Feature work that is not a transformer belongs in a SQL stage before this one.',
    },
    {
      // The runtime's own way of running out of room, which is a different failure from the
      // warehouse killing a SQL query (that one is answered by sqlRunHints in src/pipeline.js).
      match: 'MemoryError|out of memory|Resources exceeded|killed',
      hint: 'About this runtime: the BigFrames frame itself does not hold rows — BigQuery does — so running out of memory here almost always means something LEFT BigQuery: to_pandas(), a locally built bpd.DataFrame from a large list, or a library (sklearn / scipy / statsmodels) that needs a pandas frame first. All of those are single-node in the notebook. Aggregate to the grain the analysis works on BEFORE converting — and better, in a SQL stage before this one.',
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
      title: `REFERENCE: every bigframes.ml constructor and its parameters (${version})`,
      when_to_use: 'Before passing ANY parameter to an estimator or a transformer — and the moment a run fails with "TypeError: __init__() got an unexpected keyword argument".',
      approach: 'Read the signature of the class you are about to build and pass only what is in it. `positional` may be given positionally or by name; everything in `keyword_only` must be named. A parameter that is not in either list does not exist in this version — no matter what scikit-learn accepts.',
      instead_of: 'Passing a scikit-learn parameter by analogy: KMeans(standardize_features=True), n_init, random_state, algorithm. bigframes.ml wraps BigQuery ML, so a constructor takes the options its BQML model type has and nothing else.',
      reference: { library: 'bigframes', version: FACTS.version || null, of: 'ml constructors', signatures: FACTS.ml },
      notes: 'Extracted from the library itself (scripts/bigframes-facts.py → config/bigframes-facts.json), so this is that version\'s surface rather than a memory of the docs — the CONSTRUCTORS. What the methods return is not a parameter list and is written per capability in the worked recipes: a prediction per row (bf_ml_predict_as_column, bf_ml_supervised_fit_predict), an output that replaces the frame (bf_ml_reduce_dimensions, bf_ml_output_replaces_frame), an evaluation (bf_ml_evaluate_with_split), categorical features (bf_ml_categoricals_into_a_model), parameters and scaling (bf_ml_estimator_params). Two facts that are not parameters either: a transformer/estimator RETURNS its own re-read frame (assigning its column back raises NullIndexError), and pipeline.Pipeline takes EXACTLY TWO steps, (transform, estimator). KMeans, PCA and ARIMAPlus also carry detect_anomalies(X, *, contamination) — its output columns are BigQuery ML\'s, so read them off the first run rather than assuming them.',
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
      title: `REFERENCE: which DataFrame/Series methods need an ordering or an index, and the signatures that surprise (${version})`,
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
      hack: 'Two questions before every line: does this need a ROW ORDER (then sort first), and does it combine TWO objects (then they must share a root, or be merged on a key).',
      origin: 'generated',
    });
  }
  return out;
}

/** The runtime keys a written cookbook exists for (for tests and for the guide's own listing). */
export function pythonGuideRuntimes() {
  return Object.keys(COOKBOOKS);
}
