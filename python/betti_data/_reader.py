"""The out-of-core readers. The engine (polars) is imported LAZILY so the safe manifest core
stays importable without it.

Why not Spark: a single-process sandbox reading an already-aggregated Parquet result set does not
want a JVM/cluster. Polars' lazy engine (`scan_parquet` + streaming collect) gives proper
column/predicate pushdown and bounded memory with no JVM; all analysis is native polars.
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


def _collect_streaming(lf):
    """Collect a LazyFrame with the STREAMING (out-of-core) engine, across polars versions.
    polars runs the query in bounded memory rather than loading the whole scan at once."""
    try:
        return lf.collect(engine="streaming")   # polars >= ~1.23
    except TypeError:
        return lf.collect(streaming=True)        # older polars


def collect(lazyframe, row_cap: int | None = 5_000_000):
    """Materialise a LazyFrame with the STREAMING engine (bounded memory). NEVER loads the whole
    scan into memory — polars streams it. `row_cap` bounds the FINAL result: we take head(cap+1)
    (which prunes the pipeline) and raise if it is exceeded, so a `select *`-style pull of a huge
    dataset fails fast with guidance instead of OOMing. Aggregate/filter in the LazyFrame first."""
    lf = lazyframe if row_cap is None else lazyframe.head(row_cap + 1)
    df = _collect_streaming(lf)
    if row_cap is not None and df.height > row_cap:
        raise RuntimeError(
            f"result exceeds row_cap={row_cap:,}: aggregate/filter in the LazyFrame (or pass a higher row_cap) "
            "instead of materialising the whole thing — the sandbox is memory-bounded."
        )
    return df


def head(ds: Dataset, n: int = 10):
    """Peek at the first n rows without reading the whole dataset (streamed, stops after n)."""
    return _collect_streaming(scan(ds).head(n))


def arrow_batches(ds: Dataset, batch_rows: int = 100_000) -> Iterator:
    """Stream the dataset as Arrow RecordBatches — for a truly out-of-core custom loop."""
    import pyarrow.dataset as pads  # lazy; pyarrow ships with polars
    dset = pads.dataset(ds.uri.replace("file://", ""), format="parquet")
    for batch in dset.to_batches(batch_size=batch_rows):
        yield batch
