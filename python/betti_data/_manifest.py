"""Dataset discovery/resolution — the SAFE core.

The host (Betti) drops a manifest into the sandbox describing exactly which datasets the AI may
read (the Parquet result sets it EXPORTed to GCS / staged locally). Callers reference a dataset by
its `id` ONLY — never a raw path or URI — so code written against this library cannot point the
reader at arbitrary files. Unknown id -> a clear error listing the known ids.

Pure stdlib (no polars/duckdb here) so resolution is unit-testable without the data engines.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any


MANIFEST_ENV = "BETTI_DATA_MANIFEST"   # path to the manifest JSON
DATA_DIR_ENV = "BETTI_DATA_DIR"        # dir containing a conventional _manifest.json (fallback)


@dataclass(frozen=True)
class Dataset:
    id: str
    uri: str                       # file:///... or gs://...  (resolved by the host; never caller-supplied)
    fmt: str = "parquet"
    rows: int | None = None
    columns: list[dict] = field(default_factory=list)
    description: str = ""
    storage_options: dict[str, Any] = field(default_factory=dict)

    @property
    def is_gcs(self) -> bool:
        return self.uri.startswith("gs://")

    @property
    def schema(self) -> dict[str, str]:
        return {c["name"]: c.get("type", "unknown") for c in self.columns if isinstance(c, dict) and "name" in c}


class ManifestError(RuntimeError):
    pass


def _manifest_path() -> str:
    p = os.environ.get(MANIFEST_ENV)
    if p:
        return p
    d = os.environ.get(DATA_DIR_ENV)
    if d:
        return os.path.join(d, "_manifest.json")
    raise ManifestError(
        f"no data manifest: set {MANIFEST_ENV} (path to the manifest JSON) or {DATA_DIR_ENV}. "
        "The host provides this — you do not create it."
    )


def load_manifest(path: str | None = None) -> dict[str, Dataset]:
    """Parse the host manifest into {id: Dataset}. Rejects a malformed/empty manifest loudly."""
    path = path or _manifest_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError as e:
        raise ManifestError(f"data manifest not found at {path} (the host must stage it first)") from e
    except json.JSONDecodeError as e:
        raise ManifestError(f"data manifest at {path} is not valid JSON: {e}") from e

    entries = raw.get("datasets") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        raise ManifestError("data manifest must be an object with a 'datasets' array")

    out: dict[str, Dataset] = {}
    for e in entries:
        if not isinstance(e, dict) or "id" not in e or "uri" not in e:
            raise ManifestError(f"malformed dataset entry (need id + uri): {e!r}")
        ds = Dataset(
            id=str(e["id"]),
            uri=str(e["uri"]),
            fmt=str(e.get("format", "parquet")),
            rows=e.get("rows"),
            columns=e.get("columns") or [],
            description=str(e.get("description", "")),
            storage_options=e.get("storage_options") or {},
        )
        if ds.fmt != "parquet":
            raise ManifestError(f"dataset '{ds.id}': only parquet is supported (got {ds.fmt!r})")
        out[ds.id] = ds
    if not out:
        raise ManifestError("data manifest has no datasets")
    return out


def resolve(dataset_id: str, manifest: dict[str, Dataset] | None = None) -> Dataset:
    """Resolve an id to its Dataset, or raise listing the known ids. This is the ONLY way to name
    data — there is no API that accepts a raw path, so caller code cannot escape the manifest."""
    manifest = manifest if manifest is not None else load_manifest()
    ds = manifest.get(str(dataset_id))
    if ds is None:
        known = ", ".join(sorted(manifest)) or "(none)"
        raise ManifestError(f"unknown dataset '{dataset_id}'. Available: {known}. Use betti_data.datasets() to list them.")
    return ds
