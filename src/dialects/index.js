// Dialect factory. Exactly two supported warehouses: bigquery (production) and duckdb (local work
// and the tests).

import { DuckDBDialect } from './duckdb.js';
import { BigQueryDialect } from './bigquery.js';

export const SUPPORTED_DIALECTS = new Set(['duckdb', 'bigquery']);

const INSTANCES = { duckdb: new DuckDBDialect(), bigquery: new BigQueryDialect() };

/** Get the singleton Dialect for a name (throws on unsupported). */
export function getDialect(name) {
  const d = INSTANCES[name];
  if (!d) throw new Error(`unsupported warehouse dialect '${name}' (supported: duckdb, bigquery)`);
  return d;
}
