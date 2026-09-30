// WHAT dbt AND MetricFlow PRINT, READ BACK — the version-neutral parsers the dbt clients share:
// an error message worth showing, the rows of `dbt show --output json` (dbt 1.x prints an object,
// v2 a bare array — both are read), `mf query --csv` output, and the SQL/plan `mf --explain` prints.

/**
 * Turn raw dbt/mf stdout+stderr into a clean, complete error message:
 * strips ANSI colors and dbt log timestamps, and surfaces the meaningful part
 * (from the first Error/Database Error/Parsing Error marker onward).
 */
/** A dbt output line without its terminal colours. */
export const stripAnsi = (text) => String(text || '').replace(/\x1b\[[0-9;]*m/g, '');

/** Where `dbt parse` writes the semantic manifest MetricFlow reads, in a project. */
export const SEMANTIC_MANIFEST = ['target', 'semantic_manifest.json'];

export function formatDbtError(stdout = '', stderr = '') {
  const raw = `${stderr || ''}\n${stdout || ''}`;
  const cleaned = raw
    .replace(/\[[0-9;]*m/g, '') // ANSI color codes
    .split('\n')
    .map((l) => l.replace(/^\s*\d{2}:\d{2}:\d{2}(\.\d+)?\s+/, '').replace(/\s+$/, '')) // dbt log timestamps
    .filter((l) => l.trim() !== '')
    // dbt v2 appends a Rust backtrace to an internal error: frames, not a reason
    .filter((l) => !/^\s+\d+: [\w:<>{}_ .]+$|^\s+at \.\/|^\s+at \/rustc\//.test(l));
  const lines = cleaned;
  // dbt boilerplate we never want in the surfaced message.
  const noise = /^(Running with dbt|Registered adapter|Unable to do partial parsing|Starting full parse|Performance info|Found \d|Concurrency:|Sending event|Flushing usage|Update available|Your version of dbt|You can find instructions|Core:|Plugins:|- installed:|- latest:|Installed:)/i;
  // (dbt v2 prefixes its errors with `[error]`)
  const markers = /(Database Error|Parsing Error|Compilation Error|Runtime Error|Validation Error|Encountered an error|ERROR:|\[error\])/;
  const mi = lines.findIndex((l) => markers.test(l));
  let start = 0;
  if (mi >= 0) {
    // CRUCIAL: dbt prints the SPECIFIC rule (e.g. "The semantic model `users` ... is invalid") on
    // the line(s) just BEFORE "Encountered an error" / "Semantic Manifest validation failed".
    // Slicing only from the marker throws that detail away — walk back over the detail lines,
    // stopping at the first boilerplate line, and keep them.
    start = mi;
    while (start > 0 && !noise.test(lines[start - 1])) start--;
  } else {
    while (start < lines.length && noise.test(lines[start])) start++; // no marker → drop leading boilerplate
  }
  // Trim the trailing deprecation summary that otherwise buries the real message (the live case had
  // "PropertyMovedToConfigDeprecation: 184 occurrences" appended after the validation failure).
  let end = lines.length;
  const di = lines.findIndex((l, i) => i >= start && /\[WARNING\]\[DeprecationsSummary\]|Summary of encountered deprecations/i.test(l));
  if (di > start) end = di;
  const msg = lines.slice(start, end).join('\n').trim();
  return keepEnds(msg, 8000) || 'unknown dbt error';
}

/**
 * A long message cut to `budget` characters: its opening (which says what failed) and its END —
 * a traceback, a python runtime's last output, pip's reason — which is where the cause is written.
 * Cutting from the end threw exactly that away.
 */
function keepEnds(msg, budget) {
  if (msg.length <= budget) return msg;
  const head = msg.slice(0, Math.floor(budget * 0.2));
  const tail = msg.slice(msg.length - Math.floor(budget * 0.8));
  const cut = msg.length - head.length - tail.length;
  return `${head.slice(0, head.lastIndexOf('\n') > 0 ? head.lastIndexOf('\n') : head.length)}\n… ${cut} characters of the log left out …\n${tail.slice(tail.indexOf('\n') + 1 || 0)}`;
}

// Where the SQL of `mf query --explain` begins: the first LINE that is a SELECT or WITH — not a word
// inside the prose or the commented dataflow plan printed before it (whose nodes say "Select: …").
const SQL_START = /^[ \t]*(with|select)\b/im;

export function extractSql(stdout) {
  const text = stripAnsi(stdout);
  const idx = text.search(SQL_START);
  return idx >= 0 ? text.slice(idx).trim() : text.trim();
}

/** With --show-dataflow-plan, MetricFlow's dataflow plan: printed BEFORE the SQL, as commented lines
 *  from its "Metric Dataflow Plan" header on (the CLI's banners and spinner before it left out). */
export function extractPlan(stdout) {
  const text = stripAnsi(stdout);
  const end = text.search(SQL_START);
  const before = end >= 0 ? text.slice(0, end) : text;
  const header = before.search(/^[ \t]*--[ \t]*Metric Dataflow Plan/im);
  const planText = (header >= 0 ? before.slice(header) : before).trim();
  return planText ? { dataflow_plan: planText.slice(0, 20000) } : undefined;
}

/**
 * Parse `dbt show --output json` stdout: log lines, then the rows. dbt 1.x prints them as
 * { "show": [ {col:val}, ... ] }; dbt v2 prints the bare array [ {col:val}, ... ]. Both are read.
 */
export function parseShowJson(stdout) {
  const cleaned = stripAnsi(stdout);
  const tryParse = (from, to) => { try { return JSON.parse(cleaned.slice(from, to + 1)); } catch { return undefined; } };
  const obj = cleaned.indexOf('{"show"') >= 0 ? tryParse(cleaned.indexOf('{"show"'), cleaned.lastIndexOf('}')) : undefined;
  if (Array.isArray(obj?.show)) return obj.show;
  // a JSON array of rows on a line of its own (v2), or the 1.x object spread over several lines
  for (const line of cleaned.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) { const rows = tryParse(cleaned.indexOf(t), cleaned.indexOf(t) + t.length - 1); if (Array.isArray(rows)) return rows; }
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) return [];
  const parsed = tryParse(start, end);
  return Array.isArray(parsed?.show) ? parsed.show : [];
}

/** Minimal CSV parser (handles quoted fields with commas/quotes/newlines). */
export function parseCsv(text) {
  // MetricFlow writes a NULL as an empty, unquoted field: that is null here, as the warehouse said
  // (a string that is really empty is written quoted, "")
  const records = [];
  let field = '';
  let quoted = false;
  let record = [];
  let inQuotes = false;
  const push = () => { record.push(field === '' && !quoted ? null : field); field = ''; quoted = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') { inQuotes = true; quoted = true; }
    else if (ch === ',') push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      push();
      if (record.length > 1 || record[0] != null) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || quoted || record.length) { push(); records.push(record); }
  if (!records.length) return { columns: [], rows: [] };
  const header = records[0].map((h) => h ?? '');
  const columns = header.map((name) => ({ name }));
  const rows = records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
  return { columns, rows };
}
