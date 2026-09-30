// PREVIEW_SEMANTIC_MODEL — the semantic side's inspector: a context's parsed layer (semantic models,
// each metric's definition and what it can be grouped by, the declaration's own mistakes) answered in
// the call, or with `validate` a task that compiles and runs each metric to name what fails. Methods
// of the Engine (src/engine/helpers.js — mixin).

import { ToolError } from '../validate.js';
import { manifestLayer } from '../semantic-manifest.js';
import { refOf, tokenOf, columnOf, timeItem } from '../group-by-items.js';
import { formatDbtError } from '../dbt/index.js';
import { resolveTimeRange, isValidTimezone } from '../time-range.js';
import { currentSignal } from '../request-context.js';
import { uniqueRefs } from './helpers.js';

export const semanticPreviewMethods = {
  /**
   * A context's SEMANTIC LAYER AS dbt PARSED IT — one of the project's own semantic models (which has
   * no build step to report it) or one a task built — read from its semantic manifest (src/semantic-manifest.js):
   * each semantic model with its entities and dimensions, each metric with its definition (in one shape
   * for both YAML specs) and what it can be cut by, in the form a query of that context names it, and
   * what the declaration itself gets wrong. Answered in the call: nothing runs. With `validate` it
   * STARTS a task instead (the call returns { task_id }): MetricFlow compiles every metric shown, and
   * with a time_range each metric, and each semantic model's dimensions, is run in the warehouse over it.
   */
  async preview_semantic_model(input) {
    this._validate('preview_semantic_model', input);
    const ctx = this._ctx(input.context_id);
    if (ctx.state.engine === 'pipeline') throw new ToolError(`context ${ctx.id} holds a pipeline model (${ctx.state.model}), which has no semantic layer — context({ request: { action: 'describe', context_id: '${ctx.id}' } }) lists its columns`, { stage: 'validate', field: 'context_id' });
    if (input.time_range && !input.validate) throw new ToolError('time_range is the window validate runs the metrics over — pass validate: true with it', { stage: 'validate', field: 'time_range' });
    if (input.time_range?.timezone && !isValidTimezone(input.time_range.timezone)) throw new ToolError(`unknown timezone '${input.time_range.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
    const project = ctx.state.engine === 'project';
    // the names asked for are checked in the call, against what the context declares
    const declared = this._previewLayer(ctx);
    const scope = this._previewScope(ctx, declared.layer, input);
    if (input.validate) {
      if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
      const work = (id) => this._previewValidateWork(ctx, input, id);
      return this._taskStarted(this._startTask(ctx, 'preview_semantic_model', work, { input, ...(project ? { batch: { before: null } } : {}) }), { context_id: ctx.id });
    }
    // whether a build is running is read now, before MetricFlow is asked (the build may end meanwhile)
    const building = this._building(ctx);
    return this._previewAnswer(ctx, declared, scope, input, { ...(await this._listedGroupBys(ctx, declared.parsed ? scope.metrics.map((m) => m.name) : [])), building });
  },

  /**
   * What each of `metrics` can be grouped by, as MetricFlow lists it over the context: the project's
   * layer read it at start; a task's context is asked now (a local listing — nothing is read in the
   * warehouse). → { groupBys } | { groupBys: null, error }
   */
  async _listedGroupBys(ctx, metrics) {
    if (ctx.state.engine === 'project' && this.project) return { groupBys: this.project.layer.groupBys };
    if (!metrics.length) return { groupBys: {} };
    if (!this.runner?.groupBys) return { groupBys: null, error: 'the query engine cannot list them' };
    const r = await this.runner.groupBys(this.ctxs.dir(ctx.id), metrics);
    return r.ok ? { groupBys: r.group_bys } : { groupBys: null, error: r.error };
  },

  /** Whether a BUILD of this context is running (a query queued on it is not one — it changes no manifest). */
  _building(ctx) {
    return this.jobs.list().some((j) => j.context_id === ctx.id && j.status === 'running' && SEMANTIC_BUILDS.has(j.tool) && this.jobs.isLive(j.task_id));
  },

  /** The layer a context's last parse left (its manifest), and what its state declares on top. */
  _previewLayer(ctx) {
    const project = ctx.state.engine === 'project';
    if (project && this.project) return { layer: this.project.layer, parsed: true };
    const manifest = this.runner?.semanticManifest ? this.runner.semanticManifest(this.ctxs.dir(ctx.id)) : null;
    return { layer: manifestLayer(manifest), parsed: !!manifest };
  },

  /** The metrics and semantic models a preview is about: all, one semantic model's, or one metric
   *  with the metrics it is made of. Names that are not there are refused, naming what is. */
  _previewScope(ctx, layer, input) {
    // a context of the project's layer is ONE semantic model: its metrics, and the models they read
    const project = ctx.state.engine === 'project';
    const base = project ? this._projectMetricsOf(ctx) : layer.metrics;
    const baseModels = project ? new Set([ctx.state.semantic_model, ...base.flatMap((m) => m.semantic_models)]) : null;
    const metricNames = new Set([...base.map((m) => m.name), ...(project ? [] : (ctx.state.metrics || []).map((m) => m.name))]);
    const smNames = project ? baseModels : new Set([...layer.semantic_models.map((m) => m.name), ...Object.keys(ctx.state.additions || {})]);
    const list = (set) => [...set].sort().join(', ') || '(none)';
    if (input.metric && !metricNames.has(input.metric)) throw new ToolError(`'${input.metric}' is not a metric of context '${ctx.id}'. It has: ${list(metricNames)}`, { stage: 'validate', field: 'metric' });
    if (input.semantic_model && !smNames.has(input.semantic_model)) throw new ToolError(`'${input.semantic_model}' is not a semantic model of context '${ctx.id}'. It has: ${list(smNames)}`, { stage: 'validate', field: 'semantic_model' });
    const byName = new Map(layer.metrics.map((m) => [m.name, m]));
    let metrics = base;
    if (input.metric) {
      // the metric and what it is made of, so the whole computation is on the page
      const want = new Set();
      const walk = (n) => {
        if (want.has(n)) return;
        want.add(n);
        const d = layer.definition(n) || {};
        for (const i of [d.numerator, d.denominator, ...(d.inputs || []), d.input, d.base, d.conversion]) if (i?.metric) walk(i.metric);
      };
      walk(input.metric);
      metrics = layer.metrics.filter((m) => want.has(m.name));
    } else if (input.semantic_model) metrics = base.filter((m) => m.semantic_models.includes(input.semantic_model));
    const reads = new Set(metrics.flatMap((m) => m.semantic_models));
    const semanticModels = layer.semantic_models.filter((sm) => (input.semantic_model ? sm.name === input.semantic_model : input.metric ? reads.has(sm.name) : project ? baseModels.has(sm.name) : true));
    return { metrics: metrics.filter((m) => byName.has(m.name)), semanticModels, metricNames };
  },

  /** The preview answered in the call: definitions, cuts, and the checks that need nothing run. */
  _previewAnswer(ctx, { layer, parsed }, scope, input, listed = { groupBys: null }) {
    const project = ctx.state.engine === 'project';
    const issues = parsed ? layer.issues() : [];
    const inScope = (i) => (i.metric ? scope.metrics.some((m) => m.name === i.metric) : scope.semanticModels.some((sm) => sm.name === i.semantic_model));
    const shown = issues.filter(inScope);
    // a join of the project's that no reference could name is not served: said as an error of the
    // declaration, with how to declare it (src/group-by-items.js servable)
    if (project) {
      for (const b of layer.blocked || []) {
        if (!b.metrics.some((m) => scope.metrics.some((x) => x.name === m))) continue;
        shown.push({ severity: 'error', ...(typeof b.semantic_model === 'string' ? { semantic_model: b.semantic_model } : {}), message: `${b.message}: ${b.dimensions.length ? `its dimensions that way (${b.dimensions.join(', ')}) are` : 'it is'} not served. To serve it, ${b.fix}.` });
      }
    }
    // a task's metric that its last parse did not take: the build failed, or is still running
    const running = listed.building ?? this._building(ctx);
    const inManifest = new Set(layer.metrics.map((m) => m.name));
    if (!project) {
      for (const m of ctx.state.metrics || []) {
        if (!inManifest.has(m.name) && (!input.metric || input.metric === m.name)) shown.push({ severity: 'error', metric: m.name, message: `declared in this context but not in its parsed manifest — ${running ? 'its build is still running: preview again once it is done' : 'its last parse did not take it: read the build task (query_semantic_model({ request: { task_id } })) for the parse error'}` });
      }
    }
    if (!parsed) shown.unshift({ severity: 'error', message: running ? 'the context has not been parsed yet — its build is running' : 'the context has no parsed semantic manifest — its build did not parse' });
    const groupable = project ? null : this._groupableSplit(ctx).now;
    const own = ctx.state.semantic_model;
    // what each metric can be grouped by is MetricFlow's list (src/group-by-items.js), never worked out here
    const { groupBys } = listed;
    if (parsed && !groupBys) shown.push({ severity: 'note', message: `MetricFlow did not list what the metrics can be grouped by${listed.error ? `: ${listed.error}` : ''} — group_by below is left out` });
    const metrics = scope.metrics.map((m) => {
      const def = layer.definition(m.name) || {};
      const items = groupBys?.[m.name] || [];
      const t = timeItem(items);
      const time = t ? { metric_time: { grain: t.grain || 'day' } } : {};
      let cut;
      if (project) {
        const refs = items.filter((i) => i !== t).map((i) => ({ item: i, ref: refOf(i) }));
        const dims = refs.filter((r) => r.item.kind === 'dimension');
        const ents = uniqueRefs(refs.filter((r) => r.item.kind === 'entity').map((r) => r.ref));
        cut = input.metric
          // one metric: every item, spelled exactly as the query takes it
          ? { dimensions: dims.map((r) => r.ref), entities: ents, ...time }
          : { dimensions_from: [...new Set(dims.map((r) => r.item.semantic_model))], entities: ents, ...time };
        if (groupBys && !dims.length && !ents.length && (def.numerator || def.inputs || def.input || def.base)) shown.push({ severity: 'note', metric: m.name, message: 'its inputs share no dimension or entity: it can be grouped by metric_time only' });
      } else {
        // a task's context: its attributes are the context's (one list, under groupable), named in full
        // for one metric
        cut = { ...(input.metric ? { attributes: groupable } : {}), ...time };
      }
      // what this metric's query takes in group_by (and where / order_by), spelled as it takes it
      return { ...m, definition: def, group_by: cut };
    });
    const first = scope.metrics[0];
    const firstItem = first && project ? (groupBys?.[first.name] || []).find((i) => i.name !== 'metric_time') : null;
    const firstCut = first && (project ? (firstItem ? refOf(firstItem) : null) : groupable?.[0] || null);
    const errors = shown.filter((i) => i.severity === 'error').length;
    return {
      context_id: ctx.id,
      layer: project ? 'project' : 'task',
      status: {
        parsed,
        valid: parsed && !errors,
        ...(running ? { building: true } : {}),
        issues: shown,
        note: 'valid says what the declaration and its parse show; validate: true (with a time_range) compiles every metric in MetricFlow and runs it, and each semantic model\'s dimensions, in the warehouse.',
      },
      semantic_models: scope.semanticModels.map(({ measures, ...sm }) => ({ ...sm, ...(measures?.length ? { measures } : {}) })),
      metrics,
      // what a query of THIS context names a cut by
      ...(project ? {} : { groupable }),
      ...(first ? { query_with: `query_semantic_model(${JSON.stringify({ request: { context_id: ctx.id, metrics: [first.name], group_by: [...(firstCut ? [firstCut] : []), { time: 'metric_time', grain: 'day' }], time_range: { start: '<date>', end: '<date>' } } })})` } : {}),
      validate_with: `preview_semantic_model(${JSON.stringify({ request: { context_id: ctx.id, ...(input.metric ? { metric: input.metric } : input.semantic_model ? { semantic_model: input.semantic_model } : {}), validate: true, time_range: { start: '<date>', end: '<date>' } } })})`,
    };
  },

  /**
   * The validation a preview's `validate` starts, as a task: MetricFlow compiles every metric in scope
   * (all at once; one by one to name the ones that fail), and with a time_range the warehouse runs
   * them over it (a value each) and runs each semantic model's dimensions and entities — grouped by
   * all of them through one of its own metrics, one by one again to name a column that fails. What
   * the context declares is read when the task runs, after any build queued before it.
   */
  async _previewValidateWork(ctx, input, id) {
    const dir = this.ctxs.dir(ctx.id);
    const { layer, parsed } = this._previewLayer(ctx);
    if (!parsed) return { ok: false, error: { stage: 'parse', message: 'the context has no parsed semantic manifest — its build did not parse' } };
    const scope = this._previewScope(ctx, layer, input);
    const names = scope.metrics.map((m) => m.name);
    const bounds = input.time_range ? resolveTimeRange(input.time_range) || {} : null;
    const window = bounds ? { startTime: bounds.start ?? undefined, endTime: bounds.end ?? undefined } : {};
    // what each metric in view can be grouped by, as MetricFlow lists it — the cuts the dimension check
    // runs, and the tokens a message may quote, in the caller's spelling (see _callerSpelling)
    const listed = await this._listedGroupBys(ctx, names);
    const groupBys = listed.groupBys || {};
    const spelled = new Map();
    for (const items of Object.values(groupBys)) for (const item of items) spelled.set(tokenOf(item), columnOf(item));
    for (const m of names) spelled.set(`__${m}`, m); // MetricFlow's alias for a metric's own column
    const speak = this._callerSpelling(spelled);
    const message = (r) => speak(formatDbtError(r.stdout, r.stderr) || r.error || 'failed');
    const signalled = () => currentSignal()?.aborted;
    /** Run `opts` for a list at once; when that fails, one by one, to name each that fails. */
    const eachOrAll = async (items, opts) => {
      if (!items.length) return [];
      const all = await this.runner.query(dir, opts(items));
      if (all.ok) return items.map((it) => ({ item: it, ok: true, raw: all }));
      if (items.length === 1) return [{ item: items[0], ok: false, error: message(all) }];
      const out = [];
      for (const it of items) {
        if (signalled()) break;
        const r = await this.runner.query(dir, opts([it]));
        out.push(r.ok ? { item: it, ok: true, raw: r } : { item: it, ok: false, error: message(r) });
      }
      return out;
    };
    const compiled = await eachOrAll(names, (ms) => ({ metrics: ms, explain: true }));
    const result = {
      ok: true, context_id: ctx.id, layer: ctx.state.engine === 'project' ? 'project' : 'task',
      compiled: compiled.map((c) => ({ metric: c.item, ok: c.ok, ...(c.ok ? {} : { error: c.error }) })),
    };
    if (bounds) {
      await this._ensureTimeSpineBuilt(ctx.id);
      const good = compiled.filter((c) => c.ok).map((c) => c.item);
      const ran = await eachOrAll(good, (ms) => ({ metrics: ms, ...window, limit: 1 }));
      const valueOf = (c) => (c.raw?.rows?.[0] ? c.raw.rows[0][c.item] ?? null : null);
      const dims = [];
      for (const sm of scope.semanticModels) {
        if (signalled()) break;
        // one of its own metrics that ran carries the cut (so a failure is the cut's); a model no
        // such metric reads directly is not run
        const via = ran.filter((c) => c.ok).map((c) => c.item).find((n) => layer.definition(n)?.semantic_model === sm.name);
        // its dimensions and entities as MetricFlow lists them for that metric — each by its own token
        const listedFor = via ? groupBys[via] || [] : [];
        const own = listedFor.filter((i) => i.kind === 'dimension' && i.semantic_model === sm.name).map((i) => ({ name: i.name, token: tokenOf(i) }));
        const keys = listedFor.filter((i) => i.kind === 'entity' && i.semantic_model === sm.name).map((i) => ({ name: i.name, token: tokenOf(i), entity: true }));
        const cuts = [...own, ...keys];
        if (!via) { dims.push({ semantic_model: sm.name, checked: false, reason: 'no metric of it in view ran over the window — nothing to cut its rows with' }); continue; }
        if (!listed.groupBys) { dims.push({ semantic_model: sm.name, checked: false, reason: `MetricFlow did not list what ${via} can be grouped by${listed.error ? `: ${listed.error}` : ''}` }); continue; }
        if (!cuts.length) { dims.push({ semantic_model: sm.name, checked: false, reason: 'no dimension or entity to cut by' }); continue; }
        const r = await eachOrAll(cuts, (cs) => ({ metrics: [via], groupBy: cs.map((c) => c.token), ...window, limit: 1 }));
        const failed = r.filter((x) => !x.ok).map((x) => ({ [x.item.entity ? 'entity' : 'dimension']: x.item.name, error: x.error }));
        dims.push({ semantic_model: sm.name, checked: true, through: via, ok: !failed.length, dimensions: own.map((c) => c.name), entities: keys.map((c) => c.name), ...(failed.length ? { failed } : {}) });
      }
      result.window = input.time_range;
      result.ran = {
        metrics: ran.map((c) => ({ metric: c.item, ok: c.ok, ...(c.ok ? { value: valueOf(c) } : { error: c.error }) })),
        semantic_models: dims,
      };
    }
    const failures = [...result.compiled, ...(result.ran?.metrics || []), ...(result.ran?.semantic_models || [])].filter((x) => x.ok === false).length;
    result.valid = !failures;
    result.summary = `${result.compiled.filter((c) => c.ok).length}/${names.length} metric(s) compile${result.ran ? `; ${result.ran.metrics.filter((c) => c.ok).length}/${result.ran.metrics.length} run over the window; ${result.ran.semantic_models.filter((d) => d.ok).length}/${result.ran.semantic_models.filter((d) => d.checked).length} semantic model(s) whose dimensions all run` : ' (no time_range: nothing was run in the warehouse)'}`;
    return result;
  },
};

// the tasks that change a context's semantic manifest (a parse follows them)
const SEMANTIC_BUILDS = new Set(['build_semantic_model', 'update_semantic_model']);
