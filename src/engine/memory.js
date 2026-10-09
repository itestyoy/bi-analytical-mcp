// THE MEMORY TOOL — notes an analyst leaves on the catalog (an event, a property, a metric, a model) and
// finds again: kept in the store (src/memory.js), attached to what semantic_index answers about the
// same thing. A service of its own — `engine.notes` — over the catalog and the memory store; the
// engine's `memory` tool is its `run`.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { targetKey, targetWords, aboutOf } from '../memory.js';
import { memoryView } from './helpers.js';

export class MemoryTool {
  constructor({ catalog, store, validate }) {
    this.catalog = catalog;
    this.store = store;
    this.validate = validate;
  }

  /**
   * Resolve what a note is ABOUT — written as semantic_index's views address it — to the target the
   * store keeps. { source, property } a column or payload property of that source, { source, event }
   * an event of an events source, { source } the model, { term } a phrase the catalog has no entity
   * for. The key says which it is, so nothing is looked up to tell a property from an event; the
   * schema's enums make an unknown name unwritable, and a source whose vocabulary is empty (an open
   * string there) is refused here with its own nearest names.
   */
  resolveTarget(t) {
    const c = this.catalog;
    if (t.term !== undefined) return memoryTarget('term', String(t.term).trim());
    const source = t.source;
    if (!c.models[source]) throw new ToolError(`memory about: unknown source '${source}'. Known sources: ${c.modelKeys().join(', ')}${c.unavailableHint(source)}`, { stage: 'validate', field: 'about' });
    const miss = (kind, name, own) => {
      const near = rankFuzzy(name, own, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => `'${m.item}'`);
      return new ToolError(`memory about: '${name}' is not ${kind === 'event' ? 'an event' : 'a column or payload property'} of '${source}'.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} semantic_index({ request: { source: '${source}' } }) lists what it carries.`, { stage: 'validate', field: `about.${kind}` });
    };
    if (t.event !== undefined) {
      const event = String(t.event).trim();
      if (!c.isFact(source) || !c.eventNames(source).includes(event)) throw miss('event', event, c.isFact(source) ? c.eventNames(source) : []);
      return memoryTarget('event', source, event);
    }
    if (t.property !== undefined) {
      const property = String(t.property).trim();
      if (!c.attributeKind(source, property)) throw miss('property', property, c.propertyEnumFor(source));
      return memoryTarget('property', source, property);
    }
    return memoryTarget('model', source);
  }

  /** Where a resolved target's findings surface in semantic_index (a ready call to copy): the view its `about` names. */
  surfaceHint({ about }) {
    if (about.term !== undefined) return `semantic_index({ request: { search: ${JSON.stringify(about.term)} } })`;
    return `semantic_index({ request: { ${Object.entries(about).map(([k, v]) => `${k}: '${v}'`).join(', ')} } })`;
  }

  /** Compact notes linked to any of these TARGETS, for attaching to a semantic_index view. */
  notesFor(targets) {
    return this.store.forTargets(targets.map(targetKey)).map(memoryView);
  }

  /**
   * Attach saved findings to a semantic_index view COMPACTLY (token-lean): the `cap` most recent,
   * each note truncated. Always leaves an explicit drill so nothing is lost —
   * semantic_index({ request: { notes: true, about } }) returns EVERY linked finding in full, `about`
   * being the entity this view is about, written as the filter takes it ({ source, property },
   * { source, event }, { source }).
   */
  attach(out, target, { cap = 3 } = {}) {
    const all = this.store.forTargets([targetKey(target)]);
    if (!all.length) return;
    const shown = all.slice(0, cap).map((e) => memoryCompact(e));
    out.memory = shown.map((s) => s.view);
    const truncatedAny = shown.some((s) => s.truncated);
    const hiddenCount = all.length - shown.length;
    if (hiddenCount > 0) out.memory_more = hiddenCount;
    if (hiddenCount > 0 || truncatedAny) {
      (out.next_actions ||= []).push({
        call: `semantic_index({ request: { notes: true, about: ${JSON.stringify(aboutOf(target))} } })`,
        why: hiddenCount > 0
          ? `read all ${all.length} saved findings linked here IN FULL (only the ${shown.length} most recent are shown, truncated)`
          : `read the ${all.length} finding(s) above IN FULL (note text is truncated here)`,
      });
    }
  }

  /**
   * THE analyst memory tool. Save a FINDING the AI made (a vague phrasing tracked down to a
   * real field, a non-obvious gotcha, an associated source/link) and LINK it to the catalog
   * entities it concerns, so it surfaces back THROUGH semantic_index (the linked { source }/
   * { source, event }/{ source, property } views and { search }) next time the same word/field comes up.
   *   action:'record' → save notes, one or several (each + what it is `about`, + aliases the user used, + links)
   *   action:'forget' → delete one note by id
   * (the notes are read with semantic_index: { search }, { notes, about? } — see list() below)
   */
  async run(input = {}) {
    this.validate('memory', input);
    const action = input.action;

    if (action === 'record') {
      const next = 'Saved. A finding surfaces in semantic_index on the entities it is linked to, via semantic_index({ request: { search } }) — including its aliases — and in semantic_index({ request: { notes: true } }).';
      // every note is checked before any is saved: the notes are saved all or none
      const findings = (input.notes || []).map((n, i) => this._finding(n, input.notes.length > 1 ? `notes[${i}]` : null));
      return { saved: true, notes: findings.map((f) => this._save(f)), next };
    }

    if (action === 'forget') {
      if (!this.store.forget(input.id)) throw new ToolError(`no memory note with id '${input.id}'`, { stage: 'validate', field: 'id' });
      return { forgotten: true, id: input.id };
    }

    throw new ToolError(`unknown action '${action}'`, { stage: 'validate', field: 'action' });
  }

  /** A finding as given, its targets resolved — refused before anything is saved. */
  _finding(n, at = null) {
    const note = String(n.note ?? '').trim();
    if (!note) throw new ToolError(`${at ? `${at}: ` : ''}note is required and must be a non-empty finding`, { stage: 'validate', field: at ? `${at}.note` : 'note' });
    const resolved = (n.about || []).map((t) => {
      try { return this.resolveTarget(t); } catch (e) { throw at ? new ToolError(`${at}: ${e.message}`, { stage: 'validate', field: `${at}.${e.field || 'about'}` }) : e; }
    });
    return {
      note, question: n.question ? String(n.question).trim() : null, resolved,
      aliases: [...new Set((n.aliases || []).map((a) => String(a).trim()).filter(Boolean))],
      links: (n.links || []).map((l) => ({ url: String(l.url), ...(l.title ? { title: String(l.title) } : {}) })),
    };
  }

  /** Store one checked finding; what the answer says about it. */
  _save({ note, question, resolved, aliases, links }) {
    const entry = this.store.record({ note, question, targets: resolved.map((r) => r.target), aliases, links });
    const terms = resolved.filter((r) => r.kind === 'term').map((r) => r.about.term);
    return {
      id: entry.id,
      note: entry.note,
      ...(question ? { question } : {}),
      // what the note is about, each written as the { notes, about } filter takes it, and — in the
      // same order — the view each one surfaces in
      ...(resolved.length ? { about: resolved.map((r) => r.about), surfaces_in: resolved.map((r) => this.surfaceHint(r)) } : {}),
      ...(terms.length ? { unresolved_terms: terms } : {}),
      aliases, links,
    };
  }

  /**
   * The notes, newest first — every one, or those about one entity, a page at a time:
   * semantic_index({ request: { notes: true, about?, limit?, offset? } }). `about` is answered as it was
   * asked, with how many notes are about it.
   */
  list({ limit = 50, offset = 0, about } = {}) {
    const page = (total, notes) => ({ total, notes: notes.map(memoryView), ...(offset + notes.length < total ? { next_offset: offset + notes.length } : {}) });
    if (about !== undefined) {
      const r = this.resolveTarget(about);
      const all = this.store.forTargets([targetKey(r.target)]);
      return { about: r.about, ...page(all.length, all.slice(offset, offset + limit)) };
    }
    return page(this.store.counts().notes, this.store.all({ limit, offset }));
  }
}


/**
 * A resolved memory target: `target` is what gets STORED (the kind and its parts), `about` is the
 * same thing as the tools write it ({ source, property } / { source, event } / { source } / { term })
 * — and `label` is its words, for fuzzy matching and messages. Nothing here is ever re-parsed.
 */
function memoryTarget(kind, source, name = null) {
  const target = kind === 'term' ? { kind, term: source } : (name == null ? { kind, source } : { kind, source, name });
  return { kind, target, about: aboutOf(target), label: targetWords(target) };
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
  const about = (e.targets || []).map(aboutOf);
  return {
    view: {
      id: e.id,
      note: truncated ? `${note.slice(0, maxLen)}…` : note,
      ...(e.question ? { question: e.question } : {}),
      ...(about.length ? { about } : {}),
      ...(e.created_at ? { recorded_at: new Date(e.created_at).toISOString().slice(0, 10) } : {}),
    },
    truncated,
  };
}
