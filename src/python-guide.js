// The AUTHORING GUIDE for a python stage, per warehouse runtime. It is served TWICE from this one
// source, so the two can never drift:
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
// The BigFrames entry follows Google's own documentation for BigQuery DataFrames — the dbt
// integration, partial ordering mode and its two named failure modes, the type system, the
// bigframes.bigquery SQL functions and bigframes.ml. Every "do" form below is the form those pages
// show; the "avoid" forms are the ones they call out as unsupported, non-deterministic or costly.
//
// Shape of an entry:
//   runs_where  — one sentence on what actually executes the code
//   rules       — the constraints, each with why it exists (what breaks otherwise)
//   examples    — task → do / avoid, in the body form THIS server's python stage takes: the lines
//                 of one declared function over `df`, the frame dbt.ref() returns
//   dbt         — what the generated model carries, so the caller knows what it does NOT write

const BIGFRAMES = {
  // The one paragraph that STAYS in the stage description when the worked recipes carry the forms:
  // what is different about this frame and what it costs to ignore. Everything specific — the form
  // per move, the reasoning per rule — is behind the recipe index and the full guide.
  headline: 'What makes it different, and what ignoring it costs: the frame dbt.ref() hands you has NO INDEX and NO ROW ORDER (dbt runs with ordering_mode="partial"), so pandas code that reads correctly either raises (NullIndexError, OrderRequiredError) or silently answers a different question — a lookup with map, a groupby result assigned back, a head() without a sort, a Series taken from another frame; execution is DEFERRED and re-runs per dependent result; a per-row Python function is not something BigQuery can execute; and to_pandas() leaves BigQuery for a single node. None of it is refused before the run: nothing here can know which line you meant, so the cost of guessing is a failed build or a wrong number.',
  runs_where: 'dbt runs this model in a Colab Enterprise notebook: the BigFrames library turns your DataFrame operations into BigQuery SQL and BigQuery executes it. Nothing runs row by row in Python, and nothing is transferred out of BigQuery unless you ask for it with to_pandas().',
  rules: [
    {
      rule: 'The frame has NO INDEX and NO ROW ORDER (dbt\'s wrapper runs with ordering_mode="partial").',
      short: 'NO INDEX and NO ROW ORDER (ordering_mode="partial"): objects from different table expressions never combine implicitly (merge them), an op needing an index raises NullIndexError (set_index), one needing an order raises OrderRequiredError (sort_values/sort_index; groupby gives both by its keys), unique()/drop_duplicates() do not work, head(n) varies between runs, and reset_index(drop=True) creates NO index',
      why: 'Partial ordering mode stops BigFrames from building a total order over all rows — that order is what makes filters unable to reduce the bytes scanned, so dropping it is what makes a query over a large partitioned table cheap. The price is that positional access and index alignment are gone.',
      consequences: [
        'Two objects that come from DIFFERENT table expressions are never combined implicitly — join them with an explicit merge.',
        'An operation that needs an index (unstack, interpolate) raises NullIndexError ("Set an index using set_index"); groupby() provides an index by itself, unless as_index=False.',
        'An operation that needs an order (iloc, head in some contexts) raises OrderRequiredError ("Use .sort_values or .sort_index to provide an ordering"); groupby() provides a total ordering by its keys.',
        'Series.unique() and Series.drop_duplicates() do not work in this mode.',
        'head(n) may return different rows on different runs; reset_index(drop=True) does NOT create an index.',
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
      rule: 'Modelling is bigframes.ml — the scikit-learn API executed as BigQuery ML.',
      short: 'modelling is bigframes.ml (the scikit-learn API run as BigQuery ML: fit trains IN BigQuery, predict returns a frame) — NEVER sklearn/scipy/statsmodels, which need to_pandas() and run single-node: preprocessing.StandardScaler|MinMaxScaler|MaxAbsScaler|KBinsDiscretizer|LabelEncoder|OneHotEncoder, compose.ColumnTransformer, cluster.KMeans, decomposition.PCA, ensemble.XGB*|RandomForest*, linear_model.*, forecasting.ARIMAPlus, llm.GeminiTextGenerator, model_selection.train_test_split|KFold|cross_validate, metrics, pipeline.Pipeline',
      why: 'fit() trains inside BigQuery and predict() returns a BigFrames frame, so the data never leaves. sklearn / scipy / statsmodels would first need to_pandas() and then run single-node in the notebook. Available: preprocessing (StandardScaler, MinMaxScaler, MaxAbsScaler, KBinsDiscretizer, LabelEncoder, OneHotEncoder), compose.ColumnTransformer, cluster.KMeans, decomposition.PCA, ensemble (XGB*, RandomForest*), linear_model (LinearRegression, LogisticRegression), forecasting.ARIMAPlus, llm.GeminiTextGenerator, model_selection (train_test_split, KFold, cross_validate), metrics, pipeline.Pipeline.',
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
      line: 'distinct: df.groupby(["k"], as_index=False).size().drop(columns="size") — NOT unique()/drop_duplicates()',
      do: ['uniq = df.groupby(["k"], as_index=False).size().drop(columns="size")', 'return uniq'],
      avoid: ['uniq = df["k"].unique()', 'df = df.drop_duplicates(subset=["k"])'],
      why: 'unique() and drop_duplicates() are unsupported in partial ordering mode; groupby is the documented replacement.',
    },
    {
      task: 'The top N rows by a column',
      line: 'top N: df.sort_values("x", ascending=False).head(10) or df.nlargest(10, "x") — NOT df.head(10)/df.iloc[:10]',
      do: ['top = df.sort_values("revenue", ascending=False).head(10)', 'return top'],
      avoid: ['top = df.head(10)', 'top = df.iloc[:10]'],
      why: 'Without an explicit order there is no "first" row: head() may differ between runs and iloc raises OrderRequiredError. nlargest("revenue", 10) also orders by itself.',
    },
    {
      task: 'Look at a few rows while developing',
      line: 'peek at data: df.peek(5) (arbitrary sample, cheap) — head() only when the ORDER is the point',
      do: ['sample = df.peek(5)'],
      avoid: ['sample = df.head(5)'],
      why: 'peek() returns an arbitrary small sample and is the cheaper call; head() is for when the ORDER is the point.',
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
      line: 'z-score/arithmetic: df["z"] = (df["x"] - df["x"].mean()) / df["x"].std(ddof=0) (aggregates of the same frame broadcast)',
      do: ['df["revenue_z"] = (df["revenue"] - df["revenue"].mean()) / df["revenue"].std(ddof=0)', 'return df'],
      why: 'Aggregates of the same frame broadcast as scalars — one SQL statement, no alignment.',
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
      line: 'reuse: joined = df.merge(other, on="k"); joined.cache(); then derive from `joined`',
      do: ['joined = df.merge(other, on="k", how="inner")', 'joined.cache()', 'top = joined.sort_values("amount", ascending=False).head(10)', 'return top'],
      why: 'Deferred execution would otherwise recompute the join for every derived result; cache() stores it in a temporary BigQuery table.',
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
      line: 'clustering: from bigframes.ml.cluster import KMeans; m = KMeans(n_clusters=4); m.fit(X); df["segment"] = m.predict(X)["CENTROID_ID"]',
      do: ['from bigframes.ml.cluster import KMeans  (declare it in `imports`)', 'features = df[["sessions", "playtime", "revenue"]]', 'model = KMeans(n_clusters=4)', 'model.fit(features)', 'df["segment"] = model.predict(features)["CENTROID_ID"]', 'return df'],
      avoid: ['from sklearn.cluster import KMeans', 'pdf = df.to_pandas()'],
      why: 'bigframes.ml trains and predicts INSIDE BigQuery as BigQuery ML; sklearn would need the whole table in the notebook.',
    },
    {
      task: 'Scale / encode features before a model',
      line: 'scaling: from bigframes.ml.preprocessing import StandardScaler; StandardScaler().fit_transform(df[[...]])',
      do: ['from bigframes.ml.preprocessing import StandardScaler  (declare it in `imports`)', 'scaler = StandardScaler()', 'scaled = scaler.fit_transform(df[["sessions", "playtime"]])', 'return scaled'],
      why: 'The preprocessing transformers are BigQuery ML too — same API as scikit-learn, no data movement.',
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
  stage_form: 'IN THIS SERVER you do not write the model: you declare `imports` ({ package: "bigframes", submodule: "pandas", as: "bpd" } / { package: "bigframes", submodule: "ml.cluster", names: ["KMeans"] } / { package: "bigframes", submodule: "bigquery", as: "bbq" } / { package: "numpy", as: "np" }), your own `functions` over `df` — the frame dbt.ref() returns, untouched — and the ordered `steps`; the server writes def model(dbt, session), dbt.ref(), dbt.config(submission_method="bigframes", materialized=…, packages=[…]) and the return. What the LAST step returns is this model\'s table, so declare output.columns for the SQL stages after it.',
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
    note: 'How to write a python stage for THIS warehouse runtime: the constraints and why they exist, then one worked example per OPERATION. `do` / `avoid` are the lines of ONE declared function over `df` — the frame dbt.ref() returns. This is the LONG form: the stage description itself carries the framing and an index of the worked recipes, and sends you here for the reasoning.',
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
      ? `STUDY THE RECIPES BEFORE YOU WRITE: fetch EVERY move your question involves (semantic_index({ recipe: '${index[0].id}' }), … — \`recipes.moves\` above says which id covers which), adapt them, and only then declare the stage with build_native_model({ action: "add_step", stage: { stage: "python", imports, functions, steps, output } }); the stage description lists the allowlisted packages.`
      : 'Declare the stage with build_native_model({ action: "add_step", stage: { stage: "python", imports, functions, steps, output } }); the stage description lists the allowlisted packages.',
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
      + `SO: DO NOT WRITE A FUNCTION FROM MEMORY — STUDY THE RECIPES FIRST. `
      + `This deployment ships one worked, COMPILING payload PER MOVE (not per business task), each showing the form that works next to the form that raises and the technique to generalise it: `
      + `${index.map((r) => `${r.id}${r.title ? `: ${r.title}` : ''}`).join('; ')}. `
      + `Fetch each with semantic_index({ recipe: "<id>" }) and adapt it. A real question needs SEVERAL of them (a feature table, a threshold, a prediction, a cached intermediate), so read every move yours involves before writing — one glance at the nearest id is not reading it. They are also listed together under \`tasks\` in semantic_index({ guide: true }). `
      + `EVERY RULE with the reasoning behind it, and a do / avoid / why for each operation: semantic_index({ guide: "python" }) — read it before your first python stage. `
      + `${book.stage_form || ''}`;
  }

  // WITHOUT recipes (a deployment that ships none) there is nothing to point at, so the description
  // carries the rules and the right form per operation itself — built from the same data.
  const rules = book.rules.map((r) => r.short).filter(Boolean);
  const lines = book.examples.map((e) => e.line).filter(Boolean);
  return `RULES FOR ${key.toUpperCase()} — ${book.runs_where} `
    + `${rules.map((r, i) => `(${i + 1}) ${r}`).join('; ')}. `
    + `THE RIGHT FORM PER OPERATION — ${lines.join('; ')}. `
    + `${book.stage_form || ''} `
    + `The same guide with the reasoning behind each rule and the full examples: semantic_index({ guide: "python" }).`;
}

/** The runtime keys a written cookbook exists for (for tests and for the guide's own listing). */
export function pythonGuideRuntimes() {
  return Object.keys(COOKBOOKS);
}
