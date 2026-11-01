// EXPORT — a finished task's stored table written as CSV files by the warehouse itself, into the
// deployment's export location (EXPORT_URI: a Cloud Storage folder on BigQuery, a folder on this machine
// on DuckDB), and a link to each file. The rows never pass through the conversation: the answer carries
// the links, and a Cloud Storage link opens only after Google sign-in, for an account that may read the
// bucket — it grants nothing itself, so it is shown as it is.
//
// The table is the one a build starting from the task would read (_storedTaskTable): a pipeline build's,
// or a metric query's run with materialize: true. The export is a task of the pipeline side, read back
// with query_model({ task_ids }) like any other.

import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { ToolError } from '../validate.js';
import { formatDbtError } from '../dbt/index.js';
import { getDialect } from '../dialects/index.js';

/** The relation a listing of the written files may be created under, removed after. */
const SCRATCH_PREFIX = 'mcp_export_';

/** A file name made of what a context says it is for — never its id, which a link must not carry. */
const fileName = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 64) || 'result';

export const exportMethods = {
  async export(input) {
    this._validate('export', input);
    if (!this.exportUri) throw new ToolError('export is not configured on this server (EXPORT_URI)', { stage: 'validate' });
    const job = this._storedTaskTable(input.task_id, 'task_id', { use: 'export', starts: 'export', alternative: 'build the rows you need with build_model, then export that build' });
    if (!this.runner?.execute) throw new ToolError('no query engine configured', { stage: 'query' });
    const ctx = this.ctxs.get(job.contextId);
    const name = fileName(input.name || ctx.state.draft?.name || (ctx.state.tasks || []).at(-1));
    const id = this._startTask(ctx, 'export', (taskId) => this._exportWork(ctx, job, name, taskId), { input });
    return this.tasks.started(id);
  },

  /**
   * Write the table under a folder of its own — a random name, so a link says nothing of the work it
   * came from — list the files written with their rows, and answer a link to each.
   */
  async _exportWork(ctx, job, name, taskId) {
    const dialect = getDialect(this.catalog.dialect);
    const dir = this.ctxs.dir(ctx.id);
    const root = /^[a-z][a-z0-9+.-]*:\/\//i.test(this.exportUri) ? this.exportUri.replace(/\/+$/, '') : resolve(this.exportUri);
    const folder = `${root}/${new Date().toISOString().slice(0, 10)}-${randomBytes(8).toString('hex')}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(folder)) mkdirSync(folder, { recursive: true });
    const failed = (r, what) => ({ ok: false, error: { stage: 'export', message: `${what}: ${formatDbtError(r.stdout, r.stderr) || r.error || 'dbt said nothing more'}` } });
    const cols = await this.runner.relationColumns(dir, job.table);
    if (!cols.ok) return failed(cols, 'the columns of the table to export could not be read');
    const { statements, cleanup } = dialect.exportCsv({ folder, name, columns: cols.columns.map((c) => c.name), scratch: `${SCRATCH_PREFIX}${taskId}` });
    const r = await this.runner.execute(dir, job.table, statements);
    // what the listing created goes whether the export stood or not (best effort: it holds no data)
    if (cleanup.length) await this.runner.execute(dir, job.table, cleanup).catch(() => null);
    if (!r.ok) return failed(r, 'the warehouse did not write the files');
    const files = r.rows.map((f) => ({ file: basename(String(f.file)), url: dialect.downloadLink(String(f.file)), rows: Number(f.row_count) }));
    const rows = files.reduce((n, f) => n + f.rows, 0);
    const cloud = folder.startsWith('gs://');
    return {
      ok: true, status: 'done', format: 'csv', exported_rows: rows, files,
      ...(files.length === 1 ? { url: files[0].url } : {}),
      access: cloud
        ? 'Each link opens after Google sign-in, for an account that may read the bucket; the link itself grants nothing, so it can be shared as it is.'
        : 'A file on the server\'s machine.',
      ...(files.length > 1 ? { note: `The warehouse wrote the rows as ${files.length} files — together they are the whole result, each with the header row.` } : {}),
      ...(!files.length ? { note: 'The result has no rows: no file holds any.' } : {}),
      recommendations: ['Give the person the link; the rows are in the file, not in this answer — there is no need to read it back.'],
    };
  },
};
