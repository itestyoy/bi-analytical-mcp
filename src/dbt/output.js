// WHAT dbt AND MetricFlow PRINT, READ BACK — the version-neutral parsers the dbt clients share:
// an error message worth showing, the rows of `dbt show --output json` (dbt 1.x prints an object,
// v2 a bare array — both are read), `mf query --csv` output, and the SQL/plan `mf --explain` prints.

/**
 * Turn raw dbt/mf stdout+stderr into a clean, complete error message:
 * strips ANSI colors and dbt log timestamps, and surfaces the meaningful part
 * (from the first Error/Database Error/Parsing Error marker onward).
 */
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
  return msg.slice(0, 8000) || 'unknown dbt error';
}

export function extractSql(stdout) {
  // mf --explain prints prose then the SQL; return everything from the first SELECT/WITH.
  const idx = stdout.search(/\b(with|select)\b/i);
  return idx >= 0 ? stdout.slice(idx).trim() : stdout.trim();
}

export function extractPlan(stdout) {
  // With --show-dataflow-plan the plan is printed BEFORE the SQL; return the
  // cleaned text preceding the first SELECT/WITH (ANSI/timestamps stripped).
  const cleaned = (stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const idx = cleaned.search(/\b(with|select)\b/i);
  const planText = (idx >= 0 ? cleaned.slice(0, idx) : cleaned).trim();
  return planText ? { dataflow_plan: planText.slice(0, 20000) } : undefined;
}

/**
 * Parse `dbt show --output json` stdout: log lines, then the rows. dbt 1.x prints them as
 * { "show": [ {col:val}, ... ] }; dbt v2 prints the bare array [ {col:val}, ... ]. Both are read.
 */
export function parseShowJson(stdout) {
  const cleaned = (stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
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
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  if (!records.length) return { columns: [], rows: [] };
  const header = records[0];
  const columns = header.map((name) => ({ name }));
  const rows = records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  return { columns, rows };
}
