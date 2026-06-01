// Dialect factory. Exactly two supported warehouses: postgres and bigquery.

import { PostgresDialect } from './postgres.js';
import { BigQueryDialect } from './bigquery.js';

export const SUPPORTED_DIALECTS = new Set(['postgres', 'bigquery']);

const INSTANCES = { postgres: new PostgresDialect(), bigquery: new BigQueryDialect() };

/** Get the singleton Dialect for a name (throws on unsupported). */
export function getDialect(name) {
  const d = INSTANCES[name];
  if (!d) throw new Error(`unsupported warehouse dialect '${name}' (supported: postgres, bigquery)`);
  return d;
}
