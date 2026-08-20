"""The out-of-core readers. Engines (polars / duckdb) are imported LAZILY so the safe manifest
core stays importable without them, and so a sandbox that only needs one engine pays for one.

Why not Spark: a single-process sandbox reading an already-aggregated Parquet result set does not
want a JVM/cluster. Polars' lazy engine (`scan_parquet` + streaming collect) and DuckDB (SQL over
Parquet, out-of-core) give proper column/predicate pushdown and bounded memory with no JVM.
"""
from __future__ import annotations

from typing import Any, Iterator

from ._manifest import Dataset


def _polars():
    try:
        import polars as pl  # noqa
        return pl
    except ImportError as e:  # pragma: no cover - env-dependent
        raise RuntimeError("polars is required for scan()/head()/collect(); it is not installed in this sandbox") from e


def _duckdb():
    try:
        import duckdb  # noqa
        return duckdb
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("duckdb is required for sql(); it is not installed in this sandbox") from e


def scan(ds: Dataset, columns: list[str] | None = None, filters: Any | None = None):
    """A LAZY polars frame over the dataset — nothing is read until you collect(). Push down
    `columns` (projection) and `filters` (a polars predicate expr) so only what you need is read."""
    pl = _polars()
    lf = pl.scan_parquet(ds.uri, storage_options=(ds.storage_options or None))
    if filters is not None:
        lf = lf.filter(filters)
    if columns:
        lf = lf.select(columns)
    return lf


def collect(lazyframe, row_cap: int | None = 5_000_000):
    """Materialise a LazyFrame with the STREAMING engine (bounded memory). `row_cap` guards against
    accidentally pulling an unbounded result into the sandbox — raise/aggregate first if you hit it."""
    lf = lazyframe if row_cap is None else lazyframe.head(row_cap + 1)
    df = lf.collect(streaming=True)
    if row_cap is not None and df.height > row_cap:
        raise RuntimeError(
            f"result exceeds row_cap={row_cap:,}: aggregate/filter in the LazyFrame (or pass a higher row_cap) "
            "instead of materialising the whole thing — the sandbox is memory-bounded."
        )
    return df


def head(ds: Dataset, n: int = 10):
    """Peek at the first n rows without reading the whole dataset."""
    return scan(ds).head(n).collect(streaming=True)


def arrow_batches(ds: Dataset, batch_rows: int = 100_000) -> Iterator:
    """Stream the dataset as Arrow RecordBatches — for a truly out-of-core custom loop."""
    import pyarrow.parquet as pq  # lazy; pyarrow ships with polars
    import pyarrow.dataset as pads
    dset = pads.dataset(ds.uri.replace("file://", ""), format="parquet")
    for batch in dset.to_batches(batch_size=batch_rows):
        yield batch


def sql(ds: Dataset, query: str):
    """Run a read-only SQL query over the dataset with DuckDB. The dataset is bound to the table
    name `data` — write `... FROM data`. The dataset's Parquet is read ONCE into a local table, then
    external file/URL access is DISABLED, so the query can touch ONLY `data` (it cannot
    read_parquet('/etc/...') or hit a URL). Best for locally-staged result sets; a gs:// dataset
    needs DuckDB's httpfs extension + creds, so prefer scan() for GCS.

    NB: this loads the dataset into DuckDB — fine for an already-aggregated RESULT set. For a large
    dataset use scan() (lazy/streaming), which never accepts a raw path so it is equally safe."""
    duckdb = _duckdb()
    con = duckdb.connect()
    try:
        # ds.uri comes from the trusted host manifest (never the caller); escape quotes defensively.
        uri = str(ds.uri).replace("'", "''")
        con.execute(f"CREATE TABLE data AS SELECT * FROM read_parquet('{uri}')")  # the one allowed external read
        try:
            con.execute("SET enable_external_access=false")  # from here the query can reach nothing outside `data`
        except Exception:  # noqa: BLE001 - older duckdb may lack the knob; the table is already local
            pass
        return con.execute(query).pl()  # -> polars DataFrame
    finally:
        con.close()
