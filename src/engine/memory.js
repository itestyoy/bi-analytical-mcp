// THE MEMORY TOOL — notes an analyst leaves on the catalog (an event, a property, a metric, a model) and
// finds again: kept in the store (src/memory.js), attached to what semantic_index answers about the
// same thing. A service of its own — `engine.notes` — over the catalog and the memory store; the
// engine's `memory` tool is its `run`.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { targetKey, targetWords } from '../memory.js';
import { memoryView } from './helpers.js';

export class MemoryTool {
  constructor({ catalog, store, validate }) {
    this.catalog = catalog;
    this.store = store;
    this.validate = validate;
  }

  /**
   * Resolve a memory TARGET to a canonical, typed key so a saved finding links to a real
   * semantic_index view. `{ source, name }` names an attribute, payload property or event of that
   * source exactly; `{ source }` alone names the model; `{ term }` is a phrase the catalog has no
   * entity for. There is no bare-name form: the source is always written, so nothing here has to
   * be attributed to an owner, and a name that source does not carry is refused rather than
   * fuzzily re-pointed at something else.
   */
  resolveTarget(t) {
    const c = this.catalog;
    if (t && typeof t === 'object' && t.term !== undefined) return memoryTarget('term', String(t.term).trim());
    const source = String(t?.source ?? '').trim(); const name = t?.name == null ? null : String(t.name).trim();
    if (!c.models[source]) throw new ToolError(`memory target: unknown source '${source}'. Known sources: ${c.modelKeys().join(', ')}${c.unavailableHint(source)}`, { stage: 'validate', field: 'targets' });
    if (!name) return memoryTarget('model', source);
    if (c.attributeKind(source, name)) return memoryTarget('property', source, name);
    if (c.isFact(source) && c.eventNames(source).includes(name)) return memoryTarget('event', source, name);
    // The source is known, so a miss is a misspelling WITHIN it: suggest its own nearest names
    // rather than linking to something the caller did not write.
    const own = [...c.propertyEnumFor(source), ...(c.isFact(source) ? c.eventNames(source) : [])];
    const near = rankFuzzy(name, own, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => `'${m.item}'`);
    throw new ToolError(`memory target: '${name}' is not a property, attribute or event of '${source}'.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} semantic_index({ request: { model: '${source}' } }) lists what it carries.`, { stage: 'validate', field: 'targets' });
  }

  /** Where a resolved target's findings surface in semantic_index (a ready call to copy). */
  surfaceHint({ kind, addressable: target }) {
    if (kind === 'property') return `semantic_index({ request: { source: '${target.source}', property: '${target.name}' } })`;
    if (kind === 'event') return `semantic_index({ request: { source: '${target.source}', event: '${target.name}' } })`;
    if (kind === 'model') return `semantic_index({ request: { model: '${target.source}' } })`;
    return `semantic_index({ request: { search: '${target.term}' } })`;
  }

  /** Compact notes linked to any of these TARGETS, for attaching to a semantic_index view. */
  notesFor(targets) {
    return this.store.forTargets(targets.map(targetKey)).map(memoryView);
  }

  /**
   * Attach saved findings to a semantic_index view COMPACTLY (token-lean): the `cap` most recent,
   * each note truncated. Always leaves an explicit drill so nothing is lost — memory({ request: { action:
   * 'list', target } }) returns EVERY linked finding in full. `drillTarget` is the singular target
   * that view is about — { source, name } for a property/attribute/event, { source } for a model.
   */
  attach(out, targets, drillTarget, { cap = 3 } = {}) {
    const all = this.store.forTargets(targets.map(targetKey));
    if (!all.length) return;
    const shown = all.slice(0, cap).map((e) => memoryCompact(e));
    out.memory = shown.map((s) => s.view);
    const truncatedAny = shown.some((s) => s.truncated);
    const hiddenCount = all.length - shown.length;
    if (hiddenCount > 0) out.memory_more = hiddenCount;
    if (hiddenCount > 0 || truncatedAny) {
      (out.next_actions ||= []).push({
        call: `semantic_index({ request: { notes: true, about: ${JSON.stringify(drillTarget)} } })`,
        why: hiddenCount > 0
          ? `read all ${all.length} saved findings linked here IN FULL (only the ${shown.length} most recent are shown, truncated)`
          : `read the ${all.length} finding(s) above IN FULL (note text is truncated here)`,
      });
    }
  }

  /**
   * THE analyst memory tool. Save a FINDING the AI made (a vague phrasing tracked down to a
   * real field, a non-obvious gotcha, an associated source/link) and LINK it to the catalog
   * entities it concerns, so it surfaces back THROUGH semantic_index (the linked { model }/
   * { source, event }/{ source, property } views and { search }) next time the same word/field comes up.
   *   action:'record' → save a note (+ targets it is about, + aliases the user used, + links)
   *   action:'forget' → delete one note by id
   * (the notes are read with semantic_index: { search }, { notes, about? } — see list() below)
   */
  async run(input = {}) {
    this.validate('memory', input);
    const action = input.action;

    if (action === 'record') {
      const note = String(input.note ?? '').trim();
      if (!note) throw new ToolError('note is required and must be a non-empty finding', { stage: 'validate', field: 'note' });
      const question = input.question ? String(input.question).trim() : null;
      const resolved = (input.targets || []).map((t) => this.resolveTarget(t));
      const aliases = [...new Set((input.aliases || []).map((a) => String(a).trim()).filter(Boolean))];
      const links = (input.links || []).map((l) => (typeof l === 'string' ? { url: l } : { url: String(l.url), ...(l.title ? { title: String(l.title) } : {}) }));
      const entry = this.store.record({ note, question, targets: resolved.map((r) => r.target), aliases, links });
      return {
        saved: true,
        id: entry.id,
        note: entry.note,
        ...(question ? { question } : {}),
        linked_to: resolved.map((r) => ({ kind: r.kind, target: r.addressable, surfaces_in: this.surfaceHint(r) })),
        ...(resolved.some((r) => r.kind === 'term') ? { unresolved_terms: resolved.filter((r) => r.kind === 'term').map((r) => r.addressable.term) } : {}),
        aliases, links,
        next: 'Saved. This finding now surfaces in semantic_index on the linked entities, via semantic_index({ request: { search } }) — including the aliases/words above — and in semantic_index({ request: { notes: true } }).',
      };
    }

    if (action === 'forget') {
      if (!this.store.forget(input.id)) throw new ToolError(`no memory note with id '${input.id}'`, { stage: 'validate', field: 'id' });
      return { forgotten: true, id: input.id };
    }

    throw new ToolError(`unknown action '${action}'`, { stage: 'validate', field: 'action' });
  }

  /** The notes, newest first — every one, or those about one entity: semantic_index({ request: { notes: true, about? } }). */
  list({ limit = 50, about } = {}) {
    if (about !== undefined) {
      const r = this.resolveTarget(about);
      return { about: r.addressable, kind: r.kind, notes: this.store.forTargets([targetKey(r.target)]).slice(0, limit).map(memoryView) };
    }
    return { total: this.store.counts().notes, notes: this.store.all({ limit }).map(memoryView) };
  }
}


/**
 * A resolved memory target: `target` is what gets STORED (the kind and its parts), `addressable` is
 * the same thing as the tool speaks it back
 * — and `label` is its words, for fuzzy matching and messages. Nothing here is ever re-parsed.
 */
function memoryTarget(kind, source, name = null) {
  const addressable = kind === 'term' ? { term: source } : (name == null ? { source } : { source, name });
  return { kind, target: { kind, ...addressable }, addressable, label: targetWords({ kind, ...addressable }) };
}

// Compact form of a saved finding for ATTACHING to a semantic_index view: id + a truncated note +
// the date. The full text + question + about[] + aliases[] + links[] are fetched on demand via
// semantic_index({ request: { notes: true, about } }) — so the view stays light without losing the finding.
function memoryCompact(e, maxLen = 220) {
  const note = String(e.note || '');
  const truncated = note.length > maxLen;
  // Keep the semantically useful, usually-short parts inline (note/question/about); drop the long
  // search-metadata (aliases/links). The full untruncated note + aliases/links is one drill away
  // via semantic_index({ request: { notes: true, about } }).
  const targets = [...(e.targets || [])];
  return {
    view: {
      id: e.id,
      note: truncated ? `${note.slice(0, maxLen)}…` : note,
      ...(e.question ? { question: e.question } : {}),
      ...(targets.length ? { about: targets } : {}),
      ...(e.created_at ? { recorded_at: new Date(e.created_at).toISOString().slice(0, 10) } : {}),
    },
    truncated,
  };
}
