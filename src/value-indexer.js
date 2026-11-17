// THE VALUE INDEXER — the background scan that fills the value index (src/value-index.js): on a
// schedule, each source's properties profiled in the warehouse through dbt (their top values, NULL
// coverage per event and per app, distinct counts), exact or incremental since the last run, each run
// and each property's timing recorded. It writes; ValueIndex reads.

import { getDialect } from './dialects/index.js';
import { partitionConditions } from './time-range.js';
import { conditionListSql } from './pipeline/compute.js';
import { keyId, keyPath, READABLE_KEY, QUANTILE_POINTS, structFieldsOfType, mergeNumeric } from './complex-keys.js';

const DAY_MS = 86400000;

// Max (event × bundle) cells stored per property for the triple coverage (busiest kept) —
// bounds prop_bundle_event_coverage on a portfolio with many apps × events.
export const TRIPLE_CELL_CAP = 4000;

// Complex (array/struct) properties: up to N raw EXAMPLE values (shape, not frequency), each
// capped in length so one giant nested value can't blow up the response.
export const COMPLEX_SAMPLE_N = 10;

// Readable "<source>.<property>" for LOG lines and local set lookups. Never a stored key:
// the index keys rows by the (source, property) pair, not by a glued name.
export const label = (t) => `${t.source}.${t.property}`;

export const COMPLEX_SAMPLE_MAXLEN = 300;

/**
 * Non-blocking background indexer. ONE INDEPENDENT SCAN PER SOURCE: for every events source its
 * scalar event properties and marked dimensions, for every other model its categorical
 * attributes — each stored under (source, property) with the top values by frequency,
 * cardinality/total, NULL coverage per event and per app. Which events carry a property and
 * which values it takes are MEASURED here; the schema declares neither. Runs an initial pass
 * fire-and-forget at start() and then on an unref'd interval. Per-property errors are swallowed
 * so one bad property never aborts a run or crashes the server.
 */
/** The dbt selector for the catalog's source models (space-separated union), or null — `select` when given. */
export function sourceModelSelect(catalog, select = null) {
  if (select) return select;
  const names = [...new Set(catalog.modelKeys().map((k) => catalog.getModel(k).dbt_model).filter(Boolean))];
  return names.length ? names.join(' ') : null;
}

/**
 * REBUILD THE CATALOG'S SOURCE MODELS (`dbt run`) in the project at `dir`. The server does it at START,
 * BEFORE the catalog is grounded to the warehouse (src/server.js) — a column a new schema.yml declares
 * exists in the table only once its model is rebuilt, and grounding drops what the table lacks — and
 * every sync of the value index does it again before indexing. Never throws: → { ok, ms, select?, reason? }.
 */
export async function buildSourceModels({ runner, catalog, dir, select = null }) {
  const sel = sourceModelSelect(catalog, select);
  if (!sel || !runner?.run) return { ok: true, ms: 0, select: null };
  const t = Date.now();
  const r = await runner.run(dir, sel);
  const ms = Date.now() - t;
  if (r.ok) return { ok: true, ms, select: sel };
  const reason = [r.error, r.stderr, r.stdout].filter((s) => s && String(s).trim()).join('\n').trim() || 'unknown';
  return { ok: false, ms, select: sel, reason };
}

export class BackgroundIndexer {
  constructor({ catalog, runner, index, baseProjectDir, intervalMs = 21600000, maxValues = 50, windowDays = 0, approxDistinct = true, batchSize = 40, scanTimeout = 0, merge = false, highCardPct = 0, runModels = false, runModelsSelect = null, modelsBuilt = false, logger } = {}) {
    this.catalog = catalog;
    this.runner = runner;
    this.index = index;
    this.baseProjectDir = baseProjectDir;
    this.intervalMs = intervalMs;
    this.maxValues = maxValues;
    // Per-scan dbt timeout (ms) for the index queries ONLY — these are heavy full-fact
    // aggregates and were getting SIGTERM-killed at the runner's default 180s. A larger value
    // here lets them finish without raising the timeout for ordinary user queries. 0/undefined
    // → use the runner's own default (show() falls back to it when timeout is undefined).
    this.scanTimeout = Number(scanTimeout) > 0 ? Math.floor(Number(scanTimeout)) : undefined;
    // INCREMENTAL MERGE (opt-in): an anchor event property already indexed once is re-scanned only
    // for rows NEWER than its stored watermark, and the new counts are ADDED to what is stored
    // (top-values freq, per-event/app/cell coverage, totals). distinct becomes a lower bound
    // (max of prior and delta) — safe for the filter guard, which gates hard-rejects on the top-N
    // cap, not on the exact distinct. Off → each property is a full-window replace (previous behaviour).
    this.merge = !!merge;
    // HIGH-CARDINALITY skip: a field whose distinct values are ≥ highCardPct PERCENT of its
    // (non-null) rows is near-unique / ID-like — its top-N is noise, so once indexed it is SKIPPED
    // on later syncs (indexed once, then left alone), a big cost saver on wide facts. Relative to
    // the field's own size, so it adapts to any table. 0/unset → never auto-skip.
    this.highCardRatio = Number(highCardPct) > 0 ? Math.min(1, Number(highCardPct) / 100) : 0;
    // REBUILD-then-index: when on, each sync first rebuilds the catalog's source models via
    // `dbt run` and only THEN indexes them — so the index (and data_freshness) reflect a freshly
    // computed table, not whatever was last built by external orchestration. runModelsSelect
    // overrides the dbt selector (default = all catalog source models). Off → index as-is.
    this.runModels = !!runModels;
    this.runModelsSelect = runModelsSelect || null;
    // the server rebuilt them at start, before grounding the catalog (buildSourceModels): the first
    // sync, which starts right after, does not rebuild them again
    this._modelsBuilt = !!modelsBuilt;
    // Properties indexed together per combined scan: cardinality + coverage are computed for
    // a whole batch in ONE query each (instead of one scan per property). A batch that errors
    // falls back to per-property, so a single bad column never loses the rest. >=1.
    this.batchSize = Number(batchSize) > 0 ? Math.floor(Number(batchSize)) : 40;
    // Optional: bound the indexing scans to the last N days on the anchor time column — the
    // cost lever on a partitioned fact (a full-history scan every refresh is expensive).
    // 0/undefined → no window (scan all history), the default so behaviour is unchanged.
    this.windowDays = Number(windowDays) > 0 ? Math.floor(Number(windowDays)) : 0;
    // Use the dialect's APPROX distinct-count (HLL) for cardinality — cheaper on a large
    // fact (the project's preferred distinct method), at the price of an approximate
    // distinct_count. DEFAULT ON; only applied where the dialect has a native function
    // (unknown fall back to exact silently), and disableable by the caller.
    this.approxDistinct = approxDistinct !== false;
    // Default to a stderr logger so sync progress/results are ALWAYS visible in the
    // server logs; callers (incl. tests) can pass their own or a no-op to silence it.
    this.logger = logger || ((m) => console.error(`[mcp] ${new Date().toISOString()} value-index ${m}`));
    this._timer = null;
    this._running = false;
  }

  start() {
    // Fire-and-forget the initial pass — startup MUST NOT block on the warehouse.
    this.refresh().catch(() => {});
    if (this.intervalMs > 0) {
      this._timer = setInterval(() => { this.refresh().catch(() => {}); }, this.intervalMs);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Value SQL expression for a property — the catalog's one rule (flat column or JSON extract). */
  _valueExpr(name, fact) {
    return this.catalog.propertyExpr(fact, name, this.catalog.dialect);
  }

  /**
   * Write one per-property diagnostics row for a run. Diagnostics never abort indexing, but a
   * failure to write them is not silent either: the FIRST failure per run lands in the run's
   * notes (once — 200 identical notes would bury the real events), so an empty per-property
   * breakdown next to a non-zero properties_indexed has a visible cause.
   */
  _recordTiming(runId, fields) {
    try { this.index.recordPropertyTiming?.(runId, fields); } catch (e) {
      if (this._timingFailedRun !== runId) {
        this._timingFailedRun = runId;
        try { this.index.recordRunNote?.(runId, `per-property timing could not be recorded (first at [${fields?.property}]): ${e?.message || e}`); } catch { /* nothing left to report to */ }
        this.logger?.(`sync #${runId} per-property timing could not be recorded: ${e?.message || e}`);
      }
    }
  }

  /**
   * Boolean SQL: a COMPLEX (array / array<struct>) property is "present" on a row = the array
   * exists AND is non-empty. Encoding decides the shape: a native REPEATED column is never NULL —
   * only its LENGTH tells presence; an `encoding: json` column holds a whole JSON array and is
   * measured by the dialect's JSON-array length, which accepts a STRING with JSON text AND a native
   * JSON / jsonb column alike (data_type: json) — never by comparing the column to a string literal,
   * an operator BigQuery does not define for JSON; a blob key uses the keyed JSON-array length.
   * Used for per-event applicability coverage, so COUNT(CASE WHEN <this> THEN 1 END) never runs
   * COUNT() over an ARRAY (which BigQuery rejects). NULL → NULL → not counted, on every path.
   */
  _complexPresence(name, spec, fact) {
    const d = getDialect(this.catalog.dialect);
    if (spec.column) {
      if (spec.encoding === 'native') return `${d.arrayLength(spec.column)} > 0`;
      return `${d.jsonColumnArrayLength(spec.column)} > 0`; // JSON array in a STRING or a JSON-typed column
    }
    return `${d.jsonArrayLength(this.catalog.eventDataColumn(fact), name)} > 0`; // inside the event_data blob
  }

  /**
   * THE COMPLEX PROPERTIES OF ONE SOURCE (arrays / structs), and THE KEYS OF THEIR ELEMENTS — read off the
   * data, nothing declared (src/complex-keys.js). For a complex property: its presence coverage per event
   * and per app, and a few raw EXAMPLES of its shape; for every key of its elements (a JSON element's keys
   * as the data holds them, a native struct's fields as the warehouse types them; its scalar elements as
   * the key '') what a scalar property gets — its top values with frequencies (an element each), distinct
   * count, the rows that carry it per event and per app — and a number's count, min, max and quantiles.
   *
   * BATCHED PER SOURCE, as the scalar pass is: one query finds the keys, one counts every property's and
   * every key's coverage, one counts every key's values, one takes every property's examples — whatever
   * the number of properties (a dbt call costs seconds whatever it scans).
   *
   * INCREMENTAL like the scalar path: with merge on and a stored watermark, only rows newer than it are
   * scanned and the counts are ADDED to what is stored; a key first seen in that delta is counted once over
   * the whole history (the window) on its own, then kept up as the others are. Otherwise a full (windowed)
   * scan replaces.
   */
  async _indexComplexCoverage(runId, fact) {
    const c = this.catalog;
    const d = getDialect(c.dialect);
    const names = c.complexEventProps(fact);
    if (!names.length) return { props: 0, values: 0 };
    const bundleCol = c.bundleColumn(fact);
    const ref = `{{ ref('${c.getModel(fact).dbt_model}') }}`;
    const evCol = c.eventNameColumn(fact);
    const timeCol = c.getModel(fact).time?.column;
    const windowCond = this._winClauses(evCol, timeCol, fact).whereWin.replace(/^ WHERE /, '');
    const timing = (fields) => this._recordTiming(runId, fields);
    const props = names.map((name, i) => {
      const spec = c.eventPropertySpec(name, fact);
      const st = c.complexStorage(name, fact);
      if (!spec || !st) return null;
      const native = st.encoding === 'native';
      return { i, name, spec, st, native, presence: this._complexPresence(name, spec, fact), expr: this._valueExpr(name, fact), elems: d.complexElements(st), fields: native ? structFieldsOfType(st.dtype) : null };
    }).filter(Boolean);
    const stored = (p) => this.index.stats?.(fact, p.name);
    const fresh = this.merge && timeCol ? props.filter((p) => stored(p)?.dataWatermark != null) : [];
    const newbies = props.filter((p) => !fresh.includes(p));
    const groups = [];
    if (fresh.length) {
      const since = this._sinceClause(Math.min(...fresh.map((p) => stored(p).dataWatermark)), timeCol, fact);
      groups.push({ props: fresh, cond: since || windowCond, delta: !!since });
    }
    if (newbies.length) groups.push({ props: newbies, cond: windowCond, delta: false });
    let done = 0; let written = 0;
    for (const g of groups) {
      const t0 = Date.now();
      try {
        const out = await this._complexGroup(runId, fact, g, { d, ref, evCol, bundleCol, timeCol, windowCond });
        done += out.props; written += out.values;
        for (const p of g.props) timing({ source: fact, property: p.name, ms: Math.round((Date.now() - t0) / g.props.length), valuesWritten: out.valuesOf.get(p.name) || 0, totalCount: this.index.stats?.(fact, p.name)?.totalCount ?? null, status: 'ok' });
      } catch (e) {
        const why = e?.message || String(e);
        for (const p of g.props) timing({ source: fact, property: p.name, ms: Math.round((Date.now() - t0) / g.props.length), status: 'error', error: why });
        this.index.recordRunNote?.(runId, `complex-coverage scan of '${fact}' failed [${g.props.map((p) => p.name).join(', ')}]: ${why}`);
        this.logger?.(`sync #${runId} complex-coverage '${fact}' [${g.props.map((p) => p.name).join(', ')}] FAILED: ${why}`);
      }
    }
    return { props: done, values: written };
  }

  /** Run a dbt show; its rows, or throw with what dbt said. */
  async _rows(sql, limit) {
    const r = await this.runner.show(this.baseProjectDir, sql, limit, this.scanTimeout);
    if (!r.ok) throw new Error([r.error, r.stderr, r.stdout].filter((x) => x && String(x).trim()).join('\n').trim() || 'not ok');
    return r.rows || [];
  }

  /**
   * One group of a source's complex properties scanned over one WHERE (`g.cond`: a delta, or the window):
   * their keys found, their and their keys' coverage, their keys' values, their examples — and written.
   */
  async _complexGroup(runId, fact, g, { d, ref, evCol, bundleCol, timeCol, windowCond }) {
    const now = Date.now();
    const where = (cond) => (cond ? ` WHERE ${cond}` : '');
    const valuesOf = new Map();

    // 1) THE KEYS the data holds: a JSON element's own keys, a native struct's fields (its type), '' for a
    //    scalar element. A key no JSON path reads as it is (a space, a dot) is left out, and said.
    const found = new Map(g.props.map((p) => [p.name, new Set()]));
    const jsonProps = g.props.filter((p) => !p.native);
    for (const p of g.props.filter((x) => x.native)) {
      const scalarFields = p.fields.filter((f) => f.scalar).map((f) => f.name);
      for (const k of p.fields.length ? scalarFields : ['']) found.get(p.name).add(k);
    }
    if (jsonProps.length) {
      const branches = jsonProps.map((p) => {
        const e = d.unnestJoin(p.elems, 'e');
        const k = d.unnestJoin(d.elementKeys(e.el, p.st), 'k');
        return `SELECT ${p.i} AS p, ${k.el} AS k FROM ${ref} ${e.join} ${k.join}${where(g.cond)}`;
      });
      const rows = await this._rows(`SELECT p, k, COUNT(*) AS n FROM (${branches.join(' UNION ALL ')}) AS keyrows GROUP BY p, k`, 100000);
      const skipped = [];
      for (const r of rows) {
        const prop = jsonProps.find((x) => x.i === Number(r.p));
        const k = r.k == null ? null : String(r.k);
        if (!prop || k == null) continue;
        if (k === '' || READABLE_KEY.test(k)) found.get(prop.name).add(k); else skipped.push(`${prop.name}: '${k}'`);
      }
      if (skipped.length) this.index.recordRunNote?.(runId, `complex keys not read as fields (not a plain name): ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ', …' : ''}`);
    }
    const known = (p) => new Set(this.index.keys(fact, p.name).map((k) => k.field));
    // the keys counted here: those found, and — on a delta — every key already kept (its rows without it
    // add to its NULLs); a key first seen in a delta is counted over the whole history on its own, after
    const keysOf = new Map(); const freshKeys = new Map();
    for (const p of g.props) {
      const was = known(p);
      const now_ = found.get(p.name);
      keysOf.set(p.name, [...new Set([...now_, ...(g.delta ? was : [])])].filter((k) => !g.delta || was.has(k)).sort());
      freshKeys.set(p.name, g.delta ? [...now_].filter((k) => !was.has(k)).sort() : []);
    }

    // 2)–4) count the properties and their keys over this group's rows
    const counted = await this._complexCounts(fact, g.props, keysOf, g.cond, { d, ref, evCol, bundleCol, timeCol, withExamples: true });
    for (const p of g.props) {
      const cov = counted.coverage.get(p.name);
      if (g.delta && counted.maxTime == null) { this.logger?.(`sync #${runId} complex-coverage '${fact}.${p.name}': no new rows since watermark — kept stored`); continue; }
      const prior = this.index.stats?.(fact, p.name);
      const examples = counted.examples.get(p.name) || [];
      if (g.delta) {
        const before = this._readStored(fact, p.name);
        const merged = this._mergeStats({ ...before, values: [] }, { values: [], ...cov, distinct: null });
        const keep = examples.length ? examples : before.values;
        this.index.upsertProperty(fact, p.name, { values: keep, distinctCount: null, totalCount: merged.total, nullCount: merged.nullCount, coverage: merged.coverage, bundleCoverage: merged.bundleCoverage, cellCoverage: merged.cellCoverage, dataWatermark: Math.max(prior?.dataWatermark || 0, counted.maxTime ?? prior?.dataWatermark ?? 0) });
        valuesOf.set(p.name, keep.length);
      } else {
        this.index.upsertProperty(fact, p.name, { values: examples, distinctCount: null, totalCount: cov.total, nullCount: cov.rowsTotal - cov.total, coverage: cov.coverage, bundleCoverage: cov.bundleCoverage, cellCoverage: cov.cellCoverage, ...(counted.maxTime != null ? { dataWatermark: counted.maxTime } : {}) });
        valuesOf.set(p.name, examples.length);
      }
      for (const k of keysOf.get(p.name)) valuesOf.set(p.name, valuesOf.get(p.name) + this._writeKey(fact, p, k, counted.keys.get(`${p.name}\u0000${k}`), { merge: g.delta, seen: found.get(p.name).has(k) ? now : null }));
      this.logger?.(`sync #${runId} complex-coverage '${fact}.${p.name}': ${cov.coverage.filter((e) => e.nonNull > 0).length} event(s) carry it, ${keysOf.get(p.name).length} key(s)${g.delta ? ' (merged delta)' : ''}`);
    }

    // 5) a key first seen in a delta: counted once over the whole history (the window), on its own
    const late = g.props.filter((p) => freshKeys.get(p.name).length);
    if (late.length) {
      const full = await this._complexCounts(fact, late, freshKeys, windowCond, { d, ref, evCol, bundleCol, timeCol, withExamples: false });
      for (const p of late) {
        for (const k of freshKeys.get(p.name)) valuesOf.set(p.name, (valuesOf.get(p.name) || 0) + this._writeKey(fact, p, k, full.keys.get(`${p.name}\u0000${k}`), { merge: false, seen: now }));
        this.logger?.(`sync #${runId} complex-coverage '${fact}.${p.name}': new key(s) ${freshKeys.get(p.name).map((k) => keyPath(p.name, k)).join(', ')} — counted over the whole history`);
      }
    }
    return { props: g.props.length, values: [...valuesOf.values()].reduce((a, b) => a + b, 0), valuesOf };
  }

  /**
   * The counts of `props` and of their keys (`keysOf`: property → keys) over the rows `cond` keeps: each
   * property's and each key's coverage per event and per app (one query), each key's values (one query —
   * a second for its top values where the warehouse has no approximate top-K), and each property's
   * examples (one query, when asked). → { coverage: Map(prop → roll), keys: Map(`prop\0key` → stats),
   * examples: Map(prop → [{ value }]), maxTime }.
   */
  async _complexCounts(fact, props, keysOf, cond, { d, ref, evCol, bundleCol, timeCol, withExamples }) {
    const where = cond ? ` WHERE ${cond}` : '';
    const keyRead = (p, k, x) => (k ? d.elementField(x, k, p.st) : d.elementText(x, p.st));
    // coverage: one row per event[/app] — its rows, each property's present on them, each key's
    const sel = [`${evCol} AS ev`];
    if (bundleCol) sel.push(`${bundleCol} AS app`);
    sel.push('COUNT(*) AS row_count');
    if (timeCol) sel.push(`MAX(${timeCol}) AS wm`);
    const keyCols = [];
    for (const p of props) {
      sel.push(`COUNT(CASE WHEN ${p.presence} THEN 1 END) AS c${p.i}`);
      keysOf.get(p.name).forEach((k, j) => {
        sel.push(`COUNT(CASE WHEN ${d.anyElement(p.elems, (x) => `${keyRead(p, k, x)} IS NOT NULL`)} THEN 1 END) AS c${p.i}_${j}`);
        keyCols.push({ p, k, col: `c${p.i}_${j}` });
      });
    }
    const covRows = await this._rows(`SELECT ${sel.join(', ')} FROM ${ref}${where} GROUP BY ${bundleCol ? `${evCol}, ${bundleCol}` : evCol}`, 5000);
    const wm = covRows.reduce((mx, r) => { const v = r.wm == null ? null : (Number.isFinite(Number(r.wm)) ? Number(r.wm) : Date.parse(r.wm)); return (v != null && (mx == null || v > mx)) ? v : mx; }, null);
    const roll = (col, name) => {
      const r = this._coverageFromRows(covRows, col, name, null);
      const total = r.coverage.reduce((s, e) => s + (e.nonNull || 0), 0);
      const rowsTotal = r.coverage.reduce((s, e) => s + (e.rowCount || 0), 0);
      return { ...r, total, rowsTotal };
    };
    const coverage = new Map(props.map((p) => [p.name, roll(`c${p.i}`, p.name)]));
    const keys = new Map(keyCols.map(({ p, k, col }) => [`${p.name}\u0000${k}`, { cov: roll(col, keyPath(p.name, k)) }]));

    // values: one row per (property, key) over its elements — the key's value as a text
    const withKeys = props.filter((p) => keysOf.get(p.name).length);
    if (withKeys.length) {
      const branches = withKeys.map((p) => {
        const e = d.unnestJoin(p.elems, 'e');
        const kv = d.unnestJoin(d.keyValueList(keysOf.get(p.name).map((k) => [k, keyRead(p, k, e.el)])), 'kv');
        return `SELECT ${p.i} AS p, ${d.structOf(kv.el, 'k')} AS k, ${d.structOf(kv.el, 'v')} AS v FROM ${ref} ${e.join} ${kv.join}${where}`;
      });
      const kvRows = `(${branches.join(' UNION ALL ')}) AS kvrows`;
      const num = d.fromText('v', 'float');
      const top = d.approxTopK('v', this.maxValues);
      const statRows = await this._rows(`SELECT p, k, ${top ? `${top} AS top, ` : ''}${d.approxCountDistinct('v')} AS dc, COUNT(v) AS nn, COUNT(${num}) AS num_n, MIN(${num}) AS num_min, MAX(${num}) AS num_max, ${d.quantilesJson(num, QUANTILE_POINTS)} AS q FROM ${kvRows} GROUP BY p, k`, 100000);
      const tops = new Map();
      if (!top) {
        const exact = await this._rows(`SELECT p, k, v, n FROM (SELECT p, k, v, COUNT(*) AS n FROM ${kvRows} WHERE v IS NOT NULL GROUP BY p, k, v) AS counted QUALIFY ROW_NUMBER() OVER (PARTITION BY p, k ORDER BY n DESC, v) <= ${this.maxValues}`, 1000000);
        for (const r of exact) { const id = `${r.p}\u0000${r.k}`; if (!tops.has(id)) tops.set(id, []); tops.get(id).push({ value: String(r.v), freq: Number(r.n) }); }
      }
      for (const r of statRows) {
        const p = withKeys.find((x) => x.i === Number(r.p));
        if (!p) continue;
        const k = r.k == null ? '' : String(r.k);
        const entry = keys.get(`${p.name}\u0000${k}`);
        if (!entry) continue;
        const parseQ = (q) => { let a = q; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } } return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : null; };
        entry.values = (top ? d.parseTopK(r.top) : tops.get(`${r.p}\u0000${r.k}`) || []).map((v) => ({ value: String(v.value), freq: v.freq }));
        entry.distinct = r.dc == null ? null : Number(r.dc);
        entry.elements = Number(r.nn) || 0;
        const n = Number(r.num_n) || 0;
        entry.numeric = n ? { count: n, min: Number(r.num_min), max: Number(r.num_max), quantiles: parseQ(r.q) } : null;
      }
    }

    // examples: a few raw values of each property, the shape of what it holds
    const examples = new Map();
    if (withExamples) {
      const exRow = (await this._rows(`SELECT ${props.map((p) => `${d.sampleList(d.complexText(p.expr, p.st), p.presence, COMPLEX_SAMPLE_N)} AS s${p.i}`).join(', ')} FROM ${ref}${where}`, 1))[0] || {};
      for (const p of props) {
        let list = exRow[`s${p.i}`];
        if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
        const seen = new Set();
        examples.set(p.name, (Array.isArray(list) ? list : []).filter((v) => v != null).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, COMPLEX_SAMPLE_MAXLEN))
          .filter((v) => (seen.has(v) ? false : (seen.add(v), true))).map((v) => ({ value: v, freq: null })));
      }
    }
    return { coverage, keys, examples, maxTime: wm };
  }

  /**
   * Write one key's counts under its id (src/complex-keys.js keyId) — merged into what is stored when
   * `merge` (a delta), else replacing it — and its registry row: when it was last seen in the data, how
   * many of its values were counted, a number's summary.
   */
  _writeKey(fact, p, k, counted, { merge, seen }) {
    if (!counted) return 0;
    const id = keyId(p.name, k);
    const cov = counted.cov;
    const delta = { values: counted.values || [], coverage: cov.coverage, bundleCoverage: cov.bundleCoverage, cellCoverage: cov.cellCoverage, total: cov.total, rowsTotal: cov.rowsTotal, distinct: counted.distinct ?? null };
    const prior = merge ? this.index.keys(fact, p.name).find((x) => x.field === k) : null;
    const r = merge && prior ? this._mergeStats(this._readStored(fact, id), delta) : { ...delta, nullCount: cov.rowsTotal - cov.total };
    this.index.upsertProperty(fact, id, { values: r.values, distinctCount: r.distinct, totalCount: r.total, nullCount: r.nullCount, coverage: r.coverage, bundleCoverage: r.bundleCoverage, cellCoverage: r.cellCoverage });
    this.index.putKey(fact, p.name, k, {
      lastSeen: seen ?? prior?.lastSeen ?? null,
      elements: (merge && prior ? (prior.elements || 0) : 0) + (counted.elements || 0),
      numeric: merge && prior ? mergeNumeric(prior.numeric, counted.numeric) : counted.numeric || null,
    });
    return r.values.length;
  }

  /**
   * Indexing worklist: EVERY fact's scalar event properties (with per-event_name coverage)
   * PLUS the categorical dimension columns of every model. Every target names its SOURCE
   * separately from the property, so each source owns its own index space and two events facts
   * may carry the same property name without sharing a row.
   * Each target carries the table-specific bits (ref / event-name column / time column /
   * app column), so a scan never borrows another fact's columns.
   */
  _targets() {
    const c = this.catalog;
    const targets = [];
    for (const fact of c.facts) {
      const m = c.getModel(fact);
      const ref = `{{ ref('${m.dbt_model}') }}`;
      const evCol = c.eventNameColumn(fact);
      const timeCol = m.time?.column || null;
      const bundleCol = c.bundleColumn(fact);
      for (const name of c.scalarEventProps(fact)) {
        const spec = c.eventPropertySpec(name, fact);
        if (spec) targets.push({ source: fact, property: name, ref, expr: this._valueExpr(name, fact), eventCol: evCol, timeCol, bundleCol });
      }
      // Fact categorical DIMENSIONS — the envelope/app columns (media_source, platform,
      // bundle_id, …) physically on every event. Index their REAL values under the (source, column)
      // key, so a filter literal can be verified against THIS source's own
      // values (casing can differ from the per-user dim_users copy). Skip the event_name
      // column (already enum-validated) and time dimensions (not an enumerable value set).
      for (const [col, spec] of Object.entries(m.dimensions || {})) {
        if (col === evCol) continue;
        if (spec?.index === false) continue; // opted out of value indexing (an id / free text)
        if (String(spec?.type || '').toLowerCase() === 'time') continue;
        targets.push({ source: fact, property: col, ref, expr: col, eventCol: evCol, timeCol, bundleCol });
      }
    }
    for (const key of c.modelKeys()) {
      if (c.isFact(key)) continue;
      const m = c.getModel(key);
      const ref = `{{ ref('${m.dbt_model}') }}`;
      for (const [col, spec] of Object.entries(m.dimensions || {})) {
        if (spec?.index === false) continue; // opted out of value indexing (an id / free text)
        if (String(spec?.type || '').toLowerCase() === 'time') continue; // dates aren't enumerable value sets
        targets.push({ source: key, property: col, ref, expr: col, eventCol: null, timeCol: null, bundleCol: null });
      }
    }
    return targets;
  }

  /** Per-property recency window predicate (fact scans only), bounded on THAT fact's own
   *  time column, or '' when there is no window / no time axis. */
  _winClauses(eventCol, timeCol, source) {
    const recent = (eventCol && this.windowDays > 0 && timeCol) ? getDialect(this.catalog.dialect).recentSince(timeCol, this.windowDays) : null;
    // the window is the warehouse's clock; its partitions are bounded by this one, a day earlier so a
    // clock that runs ahead of the warehouse's never cuts off a day the window still reads
    const win = recent ? [recent, this._partitionSince(source, Date.now() - (this.windowDays + 1) * DAY_MS)].filter(Boolean).join(' AND ') : null;
    return { andWin: win ? ` AND ${win}` : '', whereWin: win ? ` WHERE ${win}` : '' };
  }

  /**
   * The partition column's bound for the rows at or after `ms` (epoch) of a source partitioned by
   * another column than its time axis — '' when it has none. A bound on the time axis alone reads every
   * partition of the table; this is the same rule a query's time_range applies (partitionConditions:
   * an event lies in its own day's partition, or a later one), so a scan prunes as a query does.
   */
  _partitionSince(source, ms) {
    if (!source) throw new Error('value index: a bounded scan needs the source it reads, for its partitions');
    const conditions = partitionConditions(this.catalog.getModel(source), { start: new Date(ms).toISOString().slice(0, 10) });
    return conditions.length ? conditionListSql(getDialect(this.catalog.dialect), null, conditions, 'partition').join(' AND ') : '';
  }

  /** Top-N values for ONE property via an exact GROUP BY (the per-property fallback path). */
  async _topValuesExact(ref, expr, andWin = '') {
    const top = await this.runner.show(this.baseProjectDir, `SELECT ${expr} AS v, COUNT(*) AS n FROM ${ref} WHERE ${expr} IS NOT NULL${andWin} GROUP BY 1 ORDER BY n DESC`, this.maxValues, this.scanTimeout);
    if (!top.ok) return null;
    return (top.rows || []).filter((r) => r.v != null).map((r) => ({ value: r.v, freq: Number(r.n) }));
  }

  /** Roll grouped coverage rows into per-event / per-bundle marginals + the (event×bundle)
   *  triple cells (capped), reading each row's non-null from `nnKey`. */
  _coverageFromRows(rows, nnKey, name, runId) {
    const evMap = new Map(); const apMap = new Map();
    const add = (m, k) => { const v = m.get(k) || { rowCount: 0, nonNull: 0 }; m.set(k, v); return v; };
    let cells = [];
    for (const r of rows || []) {
      const rc = Number(r.row_count) || 0; const nn = Number(r[nnKey]) || 0;
      if (r.ev != null) { const v = add(evMap, r.ev); v.rowCount += rc; v.nonNull += nn; }
      if (r.app != null) { const v = add(apMap, r.app); v.rowCount += rc; v.nonNull += nn; }
      if (r.ev != null && r.app != null) cells.push({ bundle: r.app, event: r.ev, rowCount: rc, nonNull: nn });
    }
    if (cells.length > TRIPLE_CELL_CAP) {
      cells = cells.sort((a, b) => b.rowCount - a.rowCount).slice(0, TRIPLE_CELL_CAP);
      this.logger?.(`sync #${runId} '${name}': (event×app) cells truncated to ${TRIPLE_CELL_CAP} (busiest kept)`);
    }
    return {
      coverage: [...evMap].map(([event, v]) => ({ event, rowCount: v.rowCount, nonNull: v.nonNull })),
      bundleCoverage: [...apMap].map(([bundle, v]) => ({ bundle, rowCount: v.rowCount, nonNull: v.nonNull })),
      cellCoverage: cells,
    };
  }

  /** One property's full stats via per-property scans (fallback when a batch query fails). */
  async _indexOneExact(t, bundleCol, runId) {
    const c = this.catalog;
    const { andWin, whereWin } = this._winClauses(t.eventCol, t.timeCol, t.source);
    const values = (await this._topValuesExact(t.ref, t.expr, andWin)) || [];
    const distinctExpr = (this.approxDistinct && getDialect(c.dialect).approxCountDistinct(t.expr)) || `COUNT(DISTINCT ${t.expr})`;
    const card = await this.runner.show(this.baseProjectDir, `SELECT ${distinctExpr} AS d, COUNT(${t.expr}) AS t, COUNT(*) AS rows_total FROM ${t.ref}${whereWin}`, 1, this.scanTimeout);
    const stat = card.ok && card.rows?.[0] ? card.rows[0] : {};
    const distinct = stat.d != null ? Number(stat.d) : null;
    const total = stat.t != null ? Number(stat.t) : null;
    const rowsTotal = stat.rows_total != null ? Number(stat.rows_total) : null;
    let cov = { coverage: [], bundleCoverage: [], cellCoverage: [] };
    if (t.eventCol) {
      const sel = bundleCol
        ? `${t.eventCol} AS ev, ${bundleCol} AS app, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`
        : `${t.eventCol} AS ev, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`;
      const grp = bundleCol ? `${t.eventCol}, ${bundleCol}` : `${t.eventCol}`;
      const r = await this.runner.show(this.baseProjectDir, `SELECT ${sel} FROM ${t.ref}${whereWin} GROUP BY ${grp}`, bundleCol ? 5000 : 500, this.scanTimeout);
      if (r.ok) cov = this._coverageFromRows(r.rows, 'non_null', label(t), runId);
    }
    return { values, distinct, total, rowsTotal, nullCount: (rowsTotal != null && total != null) ? rowsTotal - total : null, ...cov };
  }

  /**
   * Index a BATCH of properties (same source) with the FEWEST scans the dialect allows:
   *   • ONE combined cardinality scan (distinct + non-null for every property),
   *   • ONE combined coverage scan (per event×app, every property's non-null) when anchored,
   *   • top-values via ONE combined APPROX_TOP_COUNT scan where supported (BigQuery/Snowflake),
   *     else a per-property GROUP BY (the best DuckDB/Redshift have).
   * `where` overrides the scan predicate (null → the windowDays window; '' → whole table; a
   * string → e.g. a delta "time > watermark"). `withWm` also selects MAX(time) so the caller
   * gets the batch's new watermark. Returns { results: Map<property, stats>, maxTime }. Throws
   * if a combined scan fails → caller falls back per-property.
   */
  async _indexBatch(ref, batch, bundleCol, runId, { where = null, withWm = false } = {}) {
    const c = this.catalog;
    const eventCol = batch[0].eventCol;
    const { andWin, whereWin } = where != null
      ? { andWin: where ? ` AND ${where}` : '', whereWin: where ? ` WHERE ${where}` : '' }
      : this._winClauses(eventCol, batch[0].timeCol, batch[0].source);
    const timeCol = (withWm && eventCol) ? batch[0].timeCol : null;
    // Return the FULL raw cause verbatim (process-level error + stderr + stdout), no
    // reformatting, no truncation — so the actual reason is visible from ANY level: a
    // process-level failure (timeout/ENOENT/spawn) lives in r.error, a warehouse/dbt failure
    // in stderr/stdout. This feeds the stderr LOGS only (not surfaced through the tools).
    const why = (r) => [r.error, r.stderr, r.stdout].filter((s) => s && String(s).trim()).join('\n').trim() || 'query returned not-ok (no stdout/stderr)';

    // 1) combined cardinality (one row: rows_total + d{j}/t{j} per property, + MAX(time) for merge)
    const cardSel = ['COUNT(*) AS rows_total'];
    batch.forEach((t, j) => {
      const de = (this.approxDistinct && getDialect(c.dialect).approxCountDistinct(t.expr)) || `COUNT(DISTINCT ${t.expr})`;
      cardSel.push(`${de} AS d${j}`, `COUNT(${t.expr}) AS t${j}`);
    });
    if (timeCol) cardSel.push(`MAX(${timeCol}) AS wm`);
    const card = await this.runner.show(this.baseProjectDir, `SELECT ${cardSel.join(', ')} FROM ${ref}${whereWin}`, 1, this.scanTimeout);
    if (!card.ok) throw new Error(`cardinality scan failed: ${why(card)}`);
    const crow = card.rows?.[0] || {};
    const maxTime = crow.wm != null ? (Number.isFinite(Number(crow.wm)) ? Number(crow.wm) : Date.parse(crow.wm)) : null;

    // 2) combined coverage (anchor only)
    let covRows = null;
    if (eventCol) {
      const covSel = [`${eventCol} AS ev`];
      if (bundleCol) covSel.push(`${bundleCol} AS app`);
      covSel.push('COUNT(*) AS row_count');
      batch.forEach((t, j) => covSel.push(`COUNT(${t.expr}) AS nn${j}`));
      const grp = bundleCol ? `${eventCol}, ${bundleCol}` : `${eventCol}`;
      const cov = await this.runner.show(this.baseProjectDir, `SELECT ${covSel.join(', ')} FROM ${ref}${whereWin} GROUP BY ${grp}`, 5000, this.scanTimeout);
      if (!cov.ok) throw new Error(`coverage scan failed: ${why(cov)}`);
      covRows = cov.rows || [];
    }

    // 3) top values — combined approx-top-k where the dialect supports counts, else per-property.
    // The top-k scan is the fragile part (40 array aggregates in one query → can hit type/
    // resource limits on BigQuery). If it fails, DON'T discard the batch — keep the combined
    // cardinality+coverage that already succeeded and degrade ONLY top-values to per-property.
    let combineTopK = !!getDialect(c.dialect).approxTopK('x', this.maxValues);
    let topRow = null;
    if (combineTopK) {
      const topSel = batch.map((t, j) => `${getDialect(c.dialect).approxTopK(t.expr, this.maxValues)} AS v${j}`);
      const tk = await this.runner.show(this.baseProjectDir, `SELECT ${topSel.join(', ')} FROM ${ref}${whereWin}`, 1, this.scanTimeout);
      if (tk.ok) { topRow = tk.rows?.[0] || {}; }
      else {
        combineTopK = false; // per-property top-values below; cardinality+coverage stay combined
        const note = `combined top-k scan of ${batch.length} from ${ref} [${batch[0].property}…${batch[batch.length - 1].property}] FAILED → top-values per-property (cardinality+coverage kept combined): ${why(tk)}`;
        this.logger?.(`sync #${runId} ${note}`);
        this.index.recordRunNote?.(runId, note);
      }
    }

    const out = new Map();
    const exact = []; // the properties whose combined top-k read nothing though they have values
    for (let j = 0; j < batch.length; j += 1) {
      const t = batch[j];
      const distinct = crow[`d${j}`] != null ? Number(crow[`d${j}`]) : null;
      const total = crow[`t${j}`] != null ? Number(crow[`t${j}`]) : null;
      const rowsTotal = crow.rows_total != null ? Number(crow.rows_total) : null;
      let values = combineTopK ? getDialect(c.dialect).parseTopK(topRow[`v${j}`]) : ((await this._topValuesExact(ref, t.expr, andWin)) || []);
      // if combined top-k yielded nothing but the column has data, take the exact path — and say so,
      // once for the batch: a cell the dialect cannot read turns it into one exact scan per property
      if (combineTopK && !values.length && total) {
        values = (await this._topValuesExact(ref, t.expr, andWin)) || [];
        exact.push({ t, cell: topRow[`v${j}`] });
      }
      const cov = covRows ? this._coverageFromRows(covRows, `nn${j}`, label(t), runId) : { coverage: [], bundleCoverage: [], cellCoverage: [] };
      out.set(t, { values, distinct, total, rowsTotal, nullCount: (rowsTotal != null && total != null) ? rowsTotal - total : null, ...cov });
    }
    if (exact.length) {
      const note = `combined top-k of ${exact.length} of ${batch.length} from ${ref} read no values though they have them → counted exactly: ${exact.map((x) => label(x.t)).join(', ')} (first cell: ${String(JSON.stringify(exact[0].cell)).slice(0, 120)})`;
      this.logger?.(`sync #${runId} ${note}`);
      this.index.recordRunNote?.(runId, note);
    }
    return { results: out, maxTime };
  }

  // ── incremental merge (opt-in) ───────────────────────────────────────────────
  /** Delta predicate keeping only rows newer than an epoch-ms watermark, or null if the dialect
   *  has no safe expression (→ caller does a full re-scan instead of an unbounded merge). */
  _sinceClause(watermarkMs, timeCol, source) {
    // The delta predicate is bounded on the TARGET's own time column, passed in by every caller.
    // There is deliberately no default: falling back to another source's time axis would build
    // `WHERE <other fact's column> > …` against this table and fail on every sync.
    if (!timeCol) throw new Error('value index: a delta scan needs the source\'s own time column');
    const since = Number.isFinite(Number(watermarkMs)) ? getDialect(this.catalog.dialect).sinceTimestampMs(timeCol, watermarkMs) : null;
    // …and on its partitions: rows newer than the watermark lie in its day's partition or a later one
    return since ? [since, this._partitionSince(source, Number(watermarkMs))].filter(Boolean).join(' AND ') : null;
  }

  /** Read the CURRENTLY-STORED stats for a property back into the merge shape. */
  _readStored(source, property) {
    const st = this.index.stats(source, property) || {};
    const rowsTotal = (st.totalCount != null && st.nullCount != null) ? st.totalCount + st.nullCount : null;
    return {
      values: this.index.sampleValues(source, property, this.maxValues).map((v) => ({ value: v.value, freq: v.freq })),
      coverage: this.index.coverage(source, property).map((c) => ({ event: c.event_name, rowCount: c.row_count, nonNull: c.non_null })),
      bundleCoverage: this.index.bundleCoverage(source, property).map((c) => ({ bundle: c.bundle, rowCount: c.row_count, nonNull: c.non_null })),
      cellCoverage: this.index.allCells(source, property),
      distinct: st.distinctCount ?? null, total: st.totalCount ?? null, rowsTotal,
    };
  }

  /** Add a delta's counts to the prior stored stats (pure). freq/coverage/totals are additive;
   *  distinct becomes a lower bound (max) — the exact figure needs a full scan, but the filter
   *  guard gates hard-rejects on the top-N cap, not on distinct, so a lower bound is safe. */
  _mergeStats(prior, delta) {
    const N = this.maxValues;
    const vmap = new Map();
    for (const v of [...(prior.values || []), ...(delta.values || [])]) vmap.set(String(v.value), (vmap.get(String(v.value)) || 0) + (Number(v.freq) || 0));
    const values = [...vmap].map(([value, freq]) => ({ value, freq })).sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)).slice(0, N);
    const addBy = (arr, keyFn) => {
      const m = new Map();
      for (const e of arr) { const k = keyFn(e); const v = m.get(k) || { e, rowCount: 0, nonNull: 0 }; v.rowCount += Number(e.rowCount) || 0; v.nonNull += Number(e.nonNull) || 0; m.set(k, v); }
      return m;
    };
    const cov = addBy([...(prior.coverage || []), ...(delta.coverage || [])], (e) => e.event);
    const bun = addBy([...(prior.bundleCoverage || []), ...(delta.bundleCoverage || [])], (e) => e.bundle);
    const cells = addBy([...(prior.cellCoverage || []), ...(delta.cellCoverage || [])], (e) => `${e.bundle}\u0000${e.event}`);
    const total = (prior.total || 0) + (delta.total || 0);
    const rowsTotal = (prior.rowsTotal || 0) + (delta.rowsTotal || 0);
    const distinct = (prior.distinct == null && delta.distinct == null) ? null : Math.max(prior.distinct || 0, delta.distinct || 0);
    return {
      values,
      coverage: [...cov.values()].map((x) => ({ event: x.e.event, rowCount: x.rowCount, nonNull: x.nonNull })),
      bundleCoverage: [...bun.values()].map((x) => ({ bundle: x.e.bundle, rowCount: x.rowCount, nonNull: x.nonNull })),
      cellCoverage: [...cells.values()].map((x) => ({ bundle: x.e.bundle, event: x.e.event, rowCount: x.rowCount, nonNull: x.nonNull })),
      distinct, total, rowsTotal, nullCount: rowsTotal - total,
    };
  }

  /** Full per-property scan for merge mode over an explicit WHERE (`''` = whole table, or a
   *  delta predicate). Same stats as _indexOneExact PLUS maxTime (epoch ms) for the watermark. */
  async _scanProperty(t, bundleCol, runId, where = '') {
    const c = this.catalog;
    const timeCol = t.eventCol ? t.timeCol : null;
    const w = where ? ` WHERE ${where}` : '';
    const andW = where ? ` AND ${where}` : '';
    const values = (await this._topValuesExact(t.ref, t.expr, andW)) || [];
    const distinctExpr = (this.approxDistinct && getDialect(c.dialect).approxCountDistinct(t.expr)) || `COUNT(DISTINCT ${t.expr})`;
    const wmSel = timeCol ? `, MAX(${timeCol}) AS wm` : '';
    const card = await this.runner.show(this.baseProjectDir, `SELECT ${distinctExpr} AS d, COUNT(${t.expr}) AS t, COUNT(*) AS rows_total${wmSel} FROM ${t.ref}${w}`, 1, this.scanTimeout);
    const stat = card.ok && card.rows?.[0] ? card.rows[0] : {};
    const distinct = stat.d != null ? Number(stat.d) : null;
    const total = stat.t != null ? Number(stat.t) : null;
    const rowsTotal = stat.rows_total != null ? Number(stat.rows_total) : null;
    const maxTime = stat.wm != null ? (Number.isFinite(Number(stat.wm)) ? Number(stat.wm) : Date.parse(stat.wm)) : null;
    let cov = { coverage: [], bundleCoverage: [], cellCoverage: [] };
    if (t.eventCol) {
      const sel = bundleCol
        ? `${t.eventCol} AS ev, ${bundleCol} AS app, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`
        : `${t.eventCol} AS ev, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`;
      const grp = bundleCol ? `${t.eventCol}, ${bundleCol}` : `${t.eventCol}`;
      const r = await this.runner.show(this.baseProjectDir, `SELECT ${sel} FROM ${t.ref}${w} GROUP BY ${grp}`, bundleCol ? 5000 : 500, this.scanTimeout);
      if (r.ok) cov = this._coverageFromRows(r.rows, 'non_null', label(t), runId);
    }
    return { values, distinct, total, rowsTotal, nullCount: (rowsTotal != null && total != null) ? rowsTotal - total : null, ...cov, maxTime };
  }

  /** Index one anchor property incrementally: scan only rows since its watermark and MERGE into
   *  the stored stats. Returns { r, watermark } (r=null when there are no new rows → keep stored). */
  async _indexIncremental(t, bundleCol, runId, prior, since) {
    const delta = await this._scanProperty(t, bundleCol, runId, since);
    if (delta.maxTime == null) return { r: null, watermark: prior.dataWatermark }; // no new rows
    const merged = this._mergeStats(this._readStored(t.source, t.property), delta);
    return { r: merged, watermark: Math.max(prior.dataWatermark, delta.maxTime) };
  }

  /** Rebuild the catalog's source models (dbt run) BEFORE indexing, so the index reflects a
   *  freshly computed table. Best-effort: a failed build is logged + noted, and indexing still
   *  proceeds over whatever data currently exists. No-op unless runModels is on, and on the first
   *  sync after the server rebuilt them at start. */
  async _dbtRunModels(runId) {
    if (!this.runModels || !this.runner?.run) return;
    if (this._modelsBuilt) {
      this._modelsBuilt = false;
      this.logger?.(`sync #${runId} source models were rebuilt at start — indexing them as built`);
      return;
    }
    const select = sourceModelSelect(this.catalog, this.runModelsSelect);
    if (!select) return;
    this.logger?.(`sync #${runId} rebuilding source models before indexing: dbt run --select ${select}`);
    const r = await buildSourceModels({ runner: this.runner, catalog: this.catalog, dir: this.baseProjectDir, select });
    if (r.ok) { this.logger?.(`sync #${runId} dbt run ok (${r.ms}ms) — indexing the rebuilt models`); return; }
    this.logger?.(`sync #${runId} dbt run FAILED (${r.ms}ms) — indexing existing (possibly stale) data: ${r.reason}`);
    this.index.recordRunNote?.(runId, `dbt run of source models failed before indexing: ${r.reason}`);
  }

  /** One resilient pass over the indexable properties/attributes. Skips if already running. */
  async refresh() {
    if (this._running) return;
    if (!this.runner || !this.baseProjectDir) return;
    this._running = true;
    const runId = this.index.startRun?.(); // log the sync run (state for semantic_index)
    const startedAt = Date.now();
    await this._dbtRunModels(runId); // rebuild the models first (opt-in), then index them below
    let props = 0; let values = 0; let errors = 0; let lastError = null;
    const c = this.catalog;
    const allTargets = this._targets();
    // Reconcile the index with the live schema: DROP stored properties whose column is gone
    // (no longer a target) so a removed field does not linger. New fields (a target with nothing
    // stored) are picked up by the scan below and indexed on their own — no full reindex either
    // way. Prune against the FULL target set (not the high-card-filtered one) so a skipped
    // high-cardinality field is kept, not mistaken for a removed column.
    const desired = new Set(allTargets.map(label));
    // complex props are coverage-only targets (indexed by their own pass) — never prune them, nor the keys
    // of their elements the data showed (src/complex-keys.js); the keys of a property no longer complex go
    for (const f of c.facts) {
      const complex = new Set(c.complexEventProps(f));
      for (const prop of complex) desired.add(label({ source: f, property: prop }));
      for (const k of this.index.keys?.(f) || []) {
        if (complex.has(k.property)) desired.add(label({ source: f, property: keyId(k.property, k.field) }));
        else this.index.removeKey?.(f, k.property, k.field);
      }
    }
    const orphans = (this.index.properties?.() || []).filter((k) => !desired.has(label(k)));
    for (const k of orphans) this.index.removeProperty?.(k.source, k.property);
    if (orphans.length) this.logger?.(`sync #${runId} pruned ${orphans.length} field(s) no longer in the schema: ${orphans.slice(0, 8).map(label).join(', ')}${orphans.length > 8 ? ', …' : ''}`);
    let targets = allTargets;
    // High-cardinality skip: a field already seen to be near-unique (its top-N is noise) is left
    // alone on subsequent syncs — it was indexed once and re-scanning it will not help.
    if (this.highCardRatio > 0) {
      const before = targets.length;
      targets = targets.filter((t) => !(this.index.stats?.(t.source, t.property)?.highCardinality));
      const skipped = before - targets.length;
      if (skipped) this.logger?.(`sync #${runId} skipping ${skipped} high-cardinality field(s) already indexed (distinct ≥ ${Math.round(this.highCardRatio * 100)}% of rows; top-N is noise there)`);
    }
    const nEvent = targets.filter((t) => t.eventCol).length;
    this.logger?.(`sync #${runId} started: indexing ${nEvent} scalar event properties from ${c.facts.map((f) => c.getModel(f).dbt_model).join(' + ')} + ${targets.length - nEvent} dimension attributes`);
    // ONE INDEPENDENT SCAN PER SOURCE. Every events source (and every dimension model) is its own
    // table with its own time axis, event column, app column and watermarks, so the pass is
    // grouped by source and each group is scanned on its own: its batches never mix with another
    // source's, its delta predicates are bound to its own time column, and an error that escapes
    // one source's pass is recorded against that source and the next source still runs.
    const groups = new Map();
    for (const t of targets) { if (!groups.has(t.source)) groups.set(t.source, []); groups.get(t.source).push(t); }
    const timing = (fields) => this._recordTiming(runId, fields);
    try {
      let i = 0;
      for (const [source, groupTargets] of groups) {
        const ref = groupTargets[0].ref;
        const srcStart = Date.now(); const srcProps0 = props; const srcErrors0 = errors;
        try {
        for (let off = 0; off < groupTargets.length; off += this.batchSize) {
          const batch = groupTargets.slice(off, off + this.batchSize);
          const eventCol = batch[0].eventCol;
          const bundleCol = batch[0].bundleCol || null; // the app column OF THIS batch's table
          // Merge (anchor only): scan with ONE combined query bounded to rows since the watermark.
          // The batch is SPLIT so a newly-added field is indexed on its own (full scan) WITHOUT
          // forcing a full re-scan of the already-indexed ones (which only need a cheap delta):
          //   • fresh (have a watermark) → delta scan `time > oldest watermark`, merged;
          //   • newbies (nothing stored) → full scan, replaced.
          // Dimensions and non-merge use the plain windowed batch.
          const merging = this.merge && eventCol;
          const batchResults = new Map(); const deltaProps = new Set();
          let deltaMaxTime = null; let fullMaxTime = null; let batchFailed = false;
          const scanInto = async (subset, whereClause, asDelta) => {
            if (!subset.length) return;
            const res = await this._indexBatch(ref, subset, bundleCol, runId, { where: whereClause, withWm: merging });
            for (const [k, v] of res.results) { batchResults.set(k, v); if (asDelta) deltaProps.add(k); }
            if (asDelta) deltaMaxTime = res.maxTime; else fullMaxTime = res.maxTime;
          };
          try {
            if (merging) {
              const fresh = batch.filter((t) => this.index.stats?.(t.source, t.property)?.dataWatermark != null);
              const newbies = batch.filter((t) => this.index.stats?.(t.source, t.property)?.dataWatermark == null);
              const since = fresh.length ? this._sinceClause(Math.min(...fresh.map((t) => this.index.stats(t.source, t.property).dataWatermark)), batch[0].timeCol, batch[0].source) : null;
              if (fresh.length) await scanInto(fresh, since || '', !!since); // delta if the dialect supports it, else full
              if (newbies.length) await scanInto(newbies, '', false);         // NEW fields: full scan, on their own
            } else {
              await scanInto(batch, null, false); // dimensions / non-merge: plain windowed batch
            }
          } catch (e) {
            batchFailed = true;
            const note = `combined batch scan of ${batch.length} propert${batch.length === 1 ? 'y' : 'ies'} from ${ref} [${label(batch[0])}…${label(batch[batch.length - 1])}] FAILED → fell back to per-property: ${e?.message || e}`;
            this.logger?.(`sync #${runId} ${note}`);
            this.index.recordRunNote?.(runId, note); // logged AND surfaced via semantic_index({ request: { status } })/({ run }).fallbacks
          }
          for (const t of batch) {
            i += 1;
            const tProp = Date.now();
            try {
              let r; let watermark; let mergedNoNew = false;
              const base = !batchFailed ? batchResults.get(t) : null;
              if (merging && !batchFailed && deltaProps.has(t)) {
                // delta merged into what is stored (no new rows → keep stored, just count the pass)
                if (deltaMaxTime == null) { mergedNoNew = true; watermark = this.index.stats?.(t.source, t.property)?.dataWatermark; }
                else { r = this._mergeStats(this._readStored(t.source, t.property), base); watermark = Math.max(this.index.stats?.(t.source, t.property)?.dataWatermark ?? 0, deltaMaxTime); }
              } else if (merging && !batchFailed) {
                r = base; watermark = fullMaxTime; // full scan (newbie or no since-clause) → records the watermark
              } else if (!batchFailed) {
                r = base; watermark = undefined; // dimensions / non-merge: plain replace, no watermark
              } else if (merging) {
                // batch failed → per-property merge fallback (delta if a watermark exists, else full)
                const prior = this.index.stats?.(t.source, t.property);
                const since = (prior?.dataWatermark != null && t.timeCol) ? this._sinceClause(prior.dataWatermark, t.timeCol, t.source) : null;
                if (since) { const inc = await this._indexIncremental(t, t.bundleCol || null, runId, prior, since); r = inc.r; watermark = inc.watermark; mergedNoNew = inc.r === null; }
                else { r = await this._scanProperty(t, t.bundleCol || null, runId, ''); watermark = r.maxTime; }
              } else {
                r = await this._indexOneExact(t, t.bundleCol || null, runId); watermark = undefined; // non-merge fallback
              }
              const ms = Date.now() - tProp;
              if (mergedNoNew) { // delta had no new rows → keep what is stored, just count the pass
                props += 1;
                timing({ source: t.source, property: t.property, ms, valuesWritten: 0, status: 'ok' });
                this.logger?.(`sync #${runId} [${i}/${targets.length}] '${label(t)}': no new rows since watermark — kept stored values (${ms}ms)`);
              } else {
                const highCardinality = this.highCardRatio > 0 && r.total != null && r.total > 0 && r.distinct != null && (r.distinct / r.total) >= this.highCardRatio;
                this.index.upsertProperty(t.source, t.property, { distinctCount: r.distinct, totalCount: r.total, nullCount: r.nullCount, values: r.values, coverage: r.coverage, bundleCoverage: r.bundleCoverage, cellCoverage: r.cellCoverage, highCardinality, ...(watermark !== undefined ? { dataWatermark: watermark } : {}) });
                props += 1; values += r.values.length;
                timing({ source: t.source, property: t.property, ms, valuesWritten: r.values.length, distinctCount: r.distinct, totalCount: r.total, status: 'ok' });
                this.logger?.(`sync #${runId} [${i}/${targets.length}] '${label(t)}': ${r.values.length} values stored, ${r.distinct ?? '?'} distinct / ${r.total ?? '?'} non-null / ${r.nullCount ?? '?'} null of ${r.rowsTotal ?? '?'} rows, ${r.coverage.length} events${r.bundleCoverage.length ? ` / ${r.bundleCoverage.length} apps` : ''} covered${deltaProps.has(t) ? ' (merged delta)' : ''}${highCardinality ? ' [high-cardinality → skipped next sync]' : ''} (${ms}ms)`);
              }
            } catch (e) {
              errors += 1; lastError = e?.message || String(e);
              timing({ source: t.source, property: t.property, ms: Date.now() - tProp, status: 'error', error: lastError });
              this.logger?.(`sync #${runId} [${i}/${targets.length}] '${label(t)}': FAILED — ${lastError}`);
            }
          }
        }
        } catch (e) {
          // Something escaped the per-batch and per-property guards for THIS source. It is that
          // source's failure alone: record it and move on to the next source's scan.
          errors += 1; lastError = e?.message || String(e);
          const note = `scan of source '${source}' (${ref}) aborted: ${lastError}`;
          this.logger?.(`sync #${runId} ${note}`);
          try { this.index.recordRunNote?.(runId, note); } catch { /* diagnostics never abort indexing */ }
        }
        this.logger?.(`sync #${runId} source '${source}': ${props - srcProps0} field(s) indexed, ${errors - srcErrors0} error(s), ${Date.now() - srcStart}ms`);
      }
      // COMPLEX props: per-event coverage only (so applicability is data-derived for them too).
      // Per source, in its own guard — one fact's complex pass failing must not skip another's.
      for (const fact of c.facts) {
        try { const cx = await this._indexComplexCoverage(runId, fact); props += cx.props; values += cx.values; }
        catch (e) { errors += 1; lastError = e?.message || String(e); this.logger?.(`sync #${runId} complex-coverage pass for '${fact}' FAILED — ${lastError}`); }
      }
    } finally {
      this._running = false;
      const status = errors ? (props ? 'partial' : 'error') : 'ok';
      const ms = Date.now() - startedAt;
      try { this.index.finishRun?.(runId, { status, propertiesIndexed: props, valuesWritten: values, errors, error: lastError }); } catch { /* never let logging break the indexer */ }
      this.logger?.(`sync #${runId} done: status=${status}, properties=${props}/${targets.length}, values=${values}, errors=${errors}, duration=${ms}ms`);
    }
  }
}
