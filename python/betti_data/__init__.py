"""betti_data — the ONLY data-access interface inside the Betti Python sandbox.

Write analysis code against THIS library exclusively. Do not open files, construct GCS/S3 paths,
set up credentials, or call polars/duckdb/pyarrow readers directly — the host has already exported
the query results to Parquet and told this library where they are. You reference a result by its
`id` (from `datasets()`); there is no way to name a raw path, which is what keeps the sandbox safe.

Typical use (memory-bounded — push work down, materialise last):

    import betti_data as betti

    betti.datasets()                       # what's available: [{id, rows, schema, description}, ...]
    ds = betti.dataset("rev_by_country")   # resolve one (raises listing ids if unknown)
    ds.head(5)                             # peek without loading everything

    lf = ds.scan(columns=["country", "revenue"])   # LAZY polars frame — nothing read yet
    out = betti.collect(                            # STREAMING collect (bounded memory)
        lf.group_by("country").agg(total=betti.pl.col("revenue").sum())
    )

    ds.sql("SELECT country, sum(revenue) total FROM data GROUP BY 1 ORDER BY 2 DESC")  # SQL, out-of-core

Everything is lazy/streaming so a large export is never pulled into memory at once — aggregate or
filter in the LazyFrame / SQL, then materialise the small result.
"""
from __future__ import annotations

from typing import Any

from . import _reader
from ._manifest import Dataset, ManifestError, load_manifest, resolve

__all__ = ["datasets", "dataset", "collect", "ManifestError", "pl"]


class _DatasetHandle:
    """A resolved result set. Reference data ONLY through here — it accepts no raw path."""

    def __init__(self, ds: Dataset):
        self._ds = ds

    @property
    def id(self) -> str:
        return self._ds.id

    @property
    def schema(self) -> dict[str, str]:
        """Declared columns -> type (from the manifest)."""
        return self._ds.schema

    @property
    def rows(self) -> int | None:
        return self._ds.rows

    @property
    def description(self) -> str:
        return self._ds.description

    def scan(self, columns: list[str] | None = None, filters: Any | None = None):
        """A LAZY polars LazyFrame over this result. Nothing is read until collect(); push down
        `columns` and a `filters` predicate so only what you need is scanned."""
        return _reader.scan(self._ds, columns=columns, filters=filters)

    def head(self, n: int = 10):
        """First n rows as a polars DataFrame, without reading the whole result."""
        return _reader.head(self._ds, n=n)

    def sql(self, query: str):
        """Read-only DuckDB SQL over this result (table name `data`), out-of-core and sandboxed to
        this dataset only. Returns a polars DataFrame."""
        return _reader.sql(self._ds, query)

    def arrow_batches(self, batch_rows: int = 100_000):
        """Stream Arrow RecordBatches for a custom out-of-core loop."""
        return _reader.arrow_batches(self._ds, batch_rows=batch_rows)

    def __repr__(self) -> str:
        return f"<betti_data.Dataset id={self._ds.id!r} rows={self._ds.rows} cols={len(self._ds.columns)}>"


def datasets() -> list[dict]:
    """List the result sets the host has made available (id, rows, schema, description)."""
    m = load_manifest()
    return [
        {"id": d.id, "rows": d.rows, "columns": len(d.columns), "schema": d.schema, "description": d.description}
        for d in m.values()
    ]


def dataset(dataset_id: str) -> _DatasetHandle:
    """Resolve a result set by id (raises, listing known ids, if unknown)."""
    return _DatasetHandle(resolve(dataset_id))


def collect(lazyframe, row_cap: int | None = 5_000_000):
    """Materialise a polars LazyFrame with the STREAMING engine (bounded memory). Raises if the
    result exceeds `row_cap` — aggregate/filter first rather than pulling everything in."""
    return _reader.collect(lazyframe, row_cap=row_cap)


class _LazyPolars:
    """`betti_data.pl` -> polars, imported on first use (so importing this lib needs no engine)."""

    def __getattr__(self, name):
        import polars as _pl  # noqa
        return getattr(_pl, name)


pl = _LazyPolars()
