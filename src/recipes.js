// Recipes: ready-to-use "how to build a model for task type X" templates.
// Each recipe carries a valid create_semantic_model payload + example queries,
// so an AI can fetch a recipe and run it (optionally tweaking names/filters).

import { readFileSync } from 'node:fs';

export function loadRecipes(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return new Recipes(raw.recipes || []);
}

export class Recipes {
  constructor(list) {
    this.list = list;
    this.byId = new Map(list.map((r) => [r.id, r]));
  }

  ids() {
    return [...this.byId.keys()];
  }

  /** Ids of the recipes that need a given capability (e.g. 'python_models'). */
  idsRequiring(capability) {
    return this.list.filter((r) => r.requires === capability).map((r) => r.id);
  }

  /** Compact catalog of recipes (no full payloads) for listing. */
  summary() {
    return this.list.map((r) => ({
      id: r.id,
      task_type: r.task_type,
      title: r.title,
      when_to_use: r.when_to_use,
      metric_types: r.metric_types,
      ...(r.requires ? { requires: r.requires } : {}), // e.g. 'python_models' — a deployment without them cannot run it
      hack: r.hack, // the generalizable technique — lets the AI adapt a recipe to novel tasks
    }));
  }

  get(id) {
    const r = this.byId.get(id);
    if (!r) throw new Error(`unknown recipe: ${id}`);
    return r;
  }
}
