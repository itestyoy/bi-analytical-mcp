// SKILLS OVER MCP (extension `io.modelcontextprotocol/skills`, SEP-2640) — the analyst procedure,
// the recipes and the python-stage guide served as Agent Skills.
//
// None of this is new text. The same objects the tools already serve are rendered as a skill
// directory: `semantic_index({ guide })` is buildGuide(), `semantic_index({ recipe })` is the
// recipe set, `semantic_index({ guide: "python" })` is pythonAuthoringGuide(). A skill is those
// objects written as Markdown, generated once at startup from the same calls — so the skill and
// the tool can never say two different things. The tools stay; the skill is the form a host that
// understands skills loads progressively (name + description up front, SKILL.md on activation, a
// reference file when it is read).
//
// What the extension fixes and this module follows:
//   * a skill is a directory with SKILL.md whose YAML frontmatter has `name` and `description`;
//     every file is a resource at skill://<skill-path>/<file-path>, and the last <skill-path>
//     segment IS the name;
//   * skills/list and skills/get return, per skill, the frontmatter verbatim and EVERY file with
//     its sha256 digest and byte size (the host verifies each read against them);
//   * files are read with resources/read; supporting references are relative links in SKILL.md.

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { buildGuide } from './guide.js';
import { pythonAuthoringGuide } from './python-guide.js';
import { frameProfile } from './python-model.js';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
const MARKDOWN = 'text/markdown';

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

// ── Markdown from the guide objects (generic: strings, lists, nested objects) ────────────────
const titleCase = (k) => String(k).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
function mdValue(v, depth = 3) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        // { if, do } / { task, line } / { rule, why } — one line: the first field bold, the rest after it
        const [[k0, v0], ...rest] = entries;
        const head = typeof v0 === 'string' ? `**${v0}**` : `**${k0}:** ${JSON.stringify(v0)}`;
        const tail = rest.map(([k, x]) => (typeof x === 'string' ? `${k === 'do' ? '→' : `${k}:`} ${x}` : `${k}: \`${JSON.stringify(x)}\``)).join(' ');
        return `- ${head}${tail ? ` ${tail}` : ''}`;
      }
      return `- ${mdValue(item, depth)}`;
    }).join('\n');
  }
  return Object.entries(v).map(([k, x]) => `${'#'.repeat(Math.min(depth, 6))} ${titleCase(k)}\n\n${mdValue(x, depth + 1)}`).join('\n\n');
}

function withFrontmatter(frontmatter, body) {
  return `---\n${yaml.dump(frontmatter, { lineWidth: -1 })}---\n\n${body.trim()}\n`;
}

const RECIPE_PROSE = ['when_to_use', 'approach', 'instead_of', 'read_first', 'notes', 'hack', 'naming_note', 'building_block'];
function recipeMarkdown(r) {
  const out = [`# ${r.title || r.id}`, '', `Recipe \`${r.id}\` · family \`${r.task_type || 'other'}\`${r.requires ? ` · requires ${r.requires}` : ''}. The same entry the tool returns: \`semantic_index({ recipe: "${r.id}" })\`.`];
  for (const k of RECIPE_PROSE) if (r[k]) out.push('', `## ${titleCase(k)}`, '', String(r[k]));
  const skip = new Set(['id', 'title', 'task_type', 'requires', 'origin', 'runtime', 'unavailable_here', ...RECIPE_PROSE]);
  for (const [k, v] of Object.entries(r)) {
    if (skip.has(k) || v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    out.push('', `## ${titleCase(k)}`, '', '```json', JSON.stringify(v, null, 2), '```');
  }
  return out.join('\n');
}

/**
 * The skill catalog of this deployment: { skills: [entry], files: Map(uri → { text, mimeType,
 * size, digest }) }, where an entry is exactly what skills/list returns for it.
 */
export function buildSkills(engine) {
  const { catalog, recipes } = engine;
  const files = new Map();
  const skills = [];

  const addSkill = (path, frontmatter, body, references) => {
    const base = `skill://${path}`;
    const own = [[`${base}/SKILL.md`, withFrontmatter(frontmatter, body)], ...references.map(([rel, text]) => [`${base}/${rel}`, text])];
    const resources = own.map(([uri, text]) => {
      const buf = Buffer.from(text, 'utf8');
      const file = { uri, text, mimeType: MARKDOWN, size: buf.length, digest: sha256(buf) };
      files.set(uri, file);
      return { uri, digest: file.digest, size: file.size };
    });
    skills.push({ uri: `${base}/SKILL.md`, frontmatter, resources });
  };

  // Each recipe as the TOOL returns it (engine.get_recipe fits a pipeline payload to this catalog —
  // a point-in-time window on a slowly-changing join), never the raw file entry: the skill must say
  // exactly what semantic_index({ recipe }) says.
  const visible = recipes ? recipes.ids().filter((id) => !recipes.get(id).unavailable_here).map((id) => engine.get_recipe({ id })) : [];
  const recipeFile = (r) => [`recipes/${r.id}.md`, recipeMarkdown(r)];

  // ── the analyst procedure ──
  const python = catalog.pythonRuntime?.available
    ? pythonAuthoringGuide(frameProfile(catalog.pythonRuntime, engine.pythonModelConfig), recipes?.entriesRequiring('python_models') || [])
    : null;
  const guide = buildGuide(catalog, recipes, { python });
  const byFamily = new Map();
  for (const r of visible) { const f = r.task_type || 'other'; if (!byFamily.has(f)) byFamily.set(f, []); byFamily.get(f).push(r); }
  const recipeIndex = [...byFamily.entries()].map(([fam, list]) => `### ${fam}\n\n${list.map((r) => `- [${r.title || r.id}](recipes/${r.id}.md) — ${r.when_to_use || ''}`.trim()).join('\n')}`).join('\n\n');
  const body = [
    '# Product analytics with this semantic layer',
    '',
    guide.note,
    '',
    '## Workflow',
    '',
    guide.workflow.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    '## Routing (IF → DO)',
    '',
    mdValue(guide.routing_triggers),
    ...(guide.event_semantics ? ['', '## Event semantics', '', mdValue(Object.entries(guide.event_semantics).map(([k, v]) => ({ meaning: k, event: v })))] : []),
    ...(guide.events_sources ? ['', '## Events sources', '', guide.events_sources.note] : []),
    ...(recipeIndex ? ['', '## Recipes by family', '', 'Each links to the full entry (payload, example queries, the reusable technique). A real question combines two or three.', '', recipeIndex] : []),
    ...(python ? ['', '## Python stages', '', 'Writing a python stage? Load the `python-stage` skill of this server — the authoring guide for this warehouse\'s python runtime.'] : []),
    '',
    '## Report with provenance',
    '',
    mdValue(guide.provenance_footer),
  ].join('\n');
  addSkill('betti/analytics', {
    name: 'analytics',
    description: 'How to answer a product-analytics question with this server\'s tools: discover the catalog with semantic_index, prefer a governed metric (create_semantic_model + query_semantic_model) over a one-off pipeline (build_native_model), bound and review the query, report with provenance. Includes the IF/DO routing and every recipe by family. Use for any question that needs this data.',
  }, body, visible.map(recipeFile));

  // ── the python-stage authoring guide (only where python models run) ──
  if (python) {
    const pyRecipes = visible.filter((r) => r.requires === 'python_models');
    const pyBody = [
      '# Writing a python stage for this warehouse',
      '',
      python.headline || '',
      '',
      mdValue(Object.fromEntries(Object.entries(python).filter(([k]) => !['headline', 'recipes', 'read_next'].includes(k)))),
      ...(pyRecipes.length ? ['', '## Worked recipes', '', 'Study every move your question involves before writing a function:', '', pyRecipes.map((r) => `- [${r.title || r.id}](recipes/${r.id}.md)`).join('\n')] : []),
    ].join('\n');
    addSkill('betti/python-stage', {
      name: 'python-stage',
      description: 'Authoring guide for a python stage in a build_native_model pipeline on this warehouse\'s python runtime: what belongs in python (only what SQL cannot say, on a table prepared by SQL stages), the frame\'s rules and the forms that raise, the in-engine ML library, and worked recipes per move. Use before writing any python stage.',
    }, pyBody, pyRecipes.map(recipeFile));
  }

  return {
    skills,
    files,
    list: () => skills,
    get: (uri) => skills.find((s) => s.uri === uri) || null,
    read: (uri) => files.get(uri) || null,
  };
}
