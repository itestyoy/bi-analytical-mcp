# betti_data — the ONLY data interface in the Betti Python sandbox

When you write Python in the Betti sandbox, use **this library and nothing else** to reach data.
Do **not** open files, build `gs://` / `s3://` paths, configure credentials, or call
`polars` / `pyarrow` readers directly. The host has already run the SQL, exported the
results to Parquet, and told this library where they live. You name a result by its **id** — there
is deliberately no API that takes a raw path, which is what keeps the sandbox safe.

## How it works

- The host runs your analysis' SQL on the warehouse (BigQuery) and `EXPORT`s each result to Parquet.
- It drops a manifest (`BETTI_DATA_MANIFEST`) describing the available result sets.
- This library resolves an `id` → the exported Parquet and reads it **lazily / out-of-core**.
- No warehouse credentials exist in the sandbox. You read exported files, not the live warehouse.

## Why not Spark

A single-process sandbox reading an already-aggregated result set does not want a JVM or a cluster.
`betti_data` uses **polars' lazy engine** — `scan` + streaming `collect` — which gives
column/predicate pushdown and bounded memory with no JVM/cluster. All analysis is native polars
(there is no SQL method); one engine, one isolation story. (DuckDB would only add value for
larger-than-RAM join/sort spill, which pre-aggregated result sets don't need.)

## API

```python
import betti_data as betti

betti.datasets()                      # -> [{id, rows, columns, schema, description}, ...]
ds = betti.dataset("rev_by_country")  # resolve by id (raises, listing ids, if unknown)
ds.schema                             # {column: type}
ds.head(5)                            # peek — does not read the whole result

# LAZY: nothing is read until you collect(); push work down first.
lf = ds.scan(columns=["country", "revenue"])
result = betti.collect(
    lf.group_by("country").agg(total=betti.pl.col("revenue").sum())
)                                     # STREAMING collect, memory-bounded

# or a custom out-of-core loop over Arrow batches:
for batch in ds.arrow_batches(batch_rows=100_000):
    ...
```

## Memory guarantee (critical for big data)

Nothing here loads a whole dataset into memory:

- `scan()` is a polars **LazyFrame** — zero rows read until you `collect()`.
- `betti.collect()` runs the **streaming** engine (bounded memory) and caps the FINAL result
  (`row_cap`), raising with guidance instead of OOMing if you try to pull an unaggregated firehose.
- `arrow_batches()` yields fixed-size Arrow batches for a manual out-of-core loop.

The one thing that CAN blow memory is asking for a huge **result** (e.g. `SELECT *` / no
aggregation): the scan still streams, but the returned frame is what you asked for. So aggregate,
filter, or `head()` first — never materialise raw big data.

## Rules for writing sandbox code

1. Reach data only via `betti.dataset(id)` / `betti.datasets()` — never a path or URL.
2. Aggregate/filter/select in the `LazyFrame` **before** materialising — the sandbox is
   memory-bounded. `betti.collect()` streams and refuses an over-large result (`row_cap`).
3. Use `betti.pl` for polars expressions (`betti.pl.col(...)`), so you don't need your own import.
4. Do not attempt network, filesystem, or credential access — it isn't available and isn't needed.

## Status

The safe core (manifest resolution + guards) is tested with stdlib only. The engine readers
(`scan`/`collect`/`arrow_batches`) require `polars`/`pyarrow` (the `[engines]` extra),
preinstalled in the sandbox image; they are imported lazily so importing the library needs no engine.
GCS reads and the host export are validated against real BigQuery/GCS, not the local test stack.
