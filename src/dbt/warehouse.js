// WHICH WAREHOUSE A dbt PROJECT TALKS TO — read from the project's profile, the way dbt picks it:
// dbt_project.yml names the profile, profiles.yml holds its outputs, and the target in use (the
// profile's `target:`, or DBT_TARGET) names the output whose `type` is the adapter. A warehouse that
// takes ONE process at a time (DuckDB: the database is a file only one process may hold open) gets
// a key for its turn (src/dbt/process.js) — the database file when it can be resolved, else the
// profile.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

/** Adapters whose database admits one process at a time. */
const SINGLE_WRITER = new Set(['duckdb']);

/** Resolve dbt's `{{ env_var('X') }}` / `{{ env_var('X', 'default') }}` in a profile value. */
function renderEnv(value, env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*env_var\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?\)\s*\}\}/g, (_m, name, dflt) => env[name] ?? dflt ?? '');
}

/**
 * { adapter, singleWriter, turn } for the project at `projectDir` with profiles in `profilesDir`
 * (falls back to the project dir, as dbt does). Unknown → { adapter: null, singleWriter: false }.
 */
export function warehouseOf(projectDir, profilesDir, env = process.env) {
  try {
    const project = yaml.load(readFileSync(join(projectDir, 'dbt_project.yml'), 'utf8')) || {};
    const profilesPath = join(profilesDir || projectDir, 'profiles.yml');
    if (!existsSync(profilesPath)) return { adapter: null, singleWriter: false, turn: null };
    const profiles = yaml.load(readFileSync(profilesPath, 'utf8')) || {};
    const profile = profiles[project.profile] || Object.values(profiles)[0] || {};
    const target = env.DBT_TARGET || renderEnv(profile.target, env);
    const output = profile.outputs?.[target] || Object.values(profile.outputs || {})[0] || {};
    const adapter = output.type || null;
    const singleWriter = SINGLE_WRITER.has(adapter);
    let turn = null;
    if (singleWriter) {
      const path = renderEnv(output.path, env);
      turn = path && path !== ':memory:' ? resolve(projectDir, path) : `${profilesPath}#${project.profile}`;
    }
    return { adapter, singleWriter, turn };
  } catch {
    return { adapter: null, singleWriter: false, turn: null };
  }
}
