// EXPORT — a finished task's stored table written as ONE file by the warehouse itself, into the
// deployment's export location (EXPORT_URI: a Cloud Storage folder on BigQuery, a folder on this machine
// on DuckDB), and a link to it. The rows never pass through the conversation: the answer carries the
// link, and a Cloud Storage link opens only after Google sign-in, for an account that may read the
// bucket — it grants nothing itself, so it is shown as it is.
//
// The table is the one a build starting from the task would read (_storedTaskTable): a pipeline build's,
// or a metric query's run with materialize: true. On BigQuery it is written by an extract job (the dbt
// client's extractCsv — SQL's EXPORT DATA names every file with a number and decides how many there
// are), and only up to the deployment's limit (EXPORT_MAX_MB, at most the 1 GB BigQuery writes as one
// file), read off the table's own size before anything is written: a bigger one is refused, saying to
// narrow it. On DuckDB COPY writes it. The export is a task of the pipeline side, read back with
// query_model({ task_ids }) like any other.

import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { ToolError } from '../validate.js';
import { formatDbtError } from '../dbt/index.js';
import { getDialect } from '../dialects/index.js';
import { EXPORT_FORMATS } from '../schema.js';

/** A file name made of what a context says it is for — never its id, which a link must not carry. */
const fileName = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 64) || 'result';

export const exportMethods = {
  async export_result(input) {
    this._validate('export_result', input);
    const format = input.format || EXPORT_FORMATS[0];
    if (!this.exportUri) throw new ToolError('export is not configured on this server (EXPORT_URI)', { stage: 'validate' });
    const job = this._storedTaskTable(input.task_id, 'task_id', { use: 'export', starts: 'export', alternative: 'build the rows you need with build_model, then export that build' });
    if (!this.runner?.execute) throw new ToolError('no query engine configured', { stage: 'query' });
    const ctx = this.ctxs.get(job.contextId);
    const name = fileName(input.name || ctx.state.draft?.name || (ctx.state.tasks || []).at(-1));
    const id = this._startTask(ctx, 'export_result', () => this._exportWork(ctx, job, name, format), { input });
    return this.tasks.started(id);
  },

  /**
   * Write the table under a folder of its own — a random name, so a link says nothing of the work it
   * came from — and answer a link to the file, with its rows.
   */
  async _exportWork(ctx, job, name, format) {
    const dialect = getDialect(this.catalog.dialect);
    const dir = this.ctxs.dir(ctx.id);
    const root = /^[a-z][a-z0-9+.-]*:\/\//i.test(this.exportUri) ? this.exportUri.replace(/\/+$/, '') : resolve(this.exportUri);
    const folder = `${root}/${new Date().toISOString().slice(0, 10)}-${randomBytes(8).toString('hex')}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(folder)) mkdirSync(folder, { recursive: true });
    const target = `${folder}/${name}.${format}`;
    const failed = (r, what) => ({ ok: false, error: { stage: 'export', message: `${what}: ${formatDbtError(r.stdout, r.stderr) || r.error || 'dbt said nothing more'}` } });
    let written; // { file, rows }
    if (dialect.oneFileJob) {
      const r = await this.runner.extractCsv(dir, job.table, target, this.exportMaxBytes);
      if (r.too_big) {
        const mb = (bytes) => Math.ceil(bytes / 1e6).toLocaleString('en-US');
        return { ok: false, error: { stage: 'validate', field: 'task_id', message: `the result is ${mb(r.bytes)} MB, more than the ${mb(this.exportMaxBytes)} MB an export may be on this server (EXPORT_MAX_MB) — narrow it first: a shorter window, fewer columns, or rows aggregated to the grain the person needs, built with build_model and exported from that build` } };
      }
      if (!r.ok) return failed(r, 'the warehouse did not write the file');
      written = { file: r.file, rows: r.rows };
    } else {
      const r = await this.runner.execute(dir, job.table, dialect.exportCsv({ file: target }));
      if (!r.ok) return failed(r, 'the warehouse did not write the file');
      written = { file: target, rows: Number(r.rows[0]?.row_count ?? 0) };
    }
    return {
      ok: true, status: 'done', format, exported_rows: written.rows,
      file: basename(written.file), url: dialect.downloadLink(written.file),
      access: folder.startsWith('gs://')
        ? 'The link opens after Google sign-in, for an account that may read the bucket; the link itself grants nothing, so it can be shared as it is.'
        : 'A file on the server\'s machine.',
      ...(!written.rows ? { note: 'The result has no rows: the file holds only the header.' } : {}),
      recommendations: ['Give the person the link; the rows are in the file, not in this answer — there is no need to read it back.'],
    };
  },
};
