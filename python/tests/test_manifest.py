"""Safe-core tests (stdlib only): manifest parsing, id resolution, and the guards that keep code
from escaping the manifest. No polars/duckdb needed — importing betti_data must not require them."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # the package dir

import betti_data as betti
from betti_data._manifest import ManifestError, load_manifest, resolve


def _write(tmp, obj):
    p = os.path.join(tmp, "_manifest.json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
    return p


VALID = {
    "datasets": [
        {"id": "rev_by_country", "uri": "file:///data/rev/part-*.parquet", "format": "parquet",
         "rows": 240, "columns": [{"name": "country", "type": "string"}, {"name": "revenue", "type": "double"}],
         "description": "revenue by country"},
        {"id": "big_events", "uri": "gs://betti-sandbox/exports/req9/part-*.parquet", "rows": 1000000},
    ]
}


class ManifestCore(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_parse_and_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = load_manifest(_write(tmp, VALID))
            self.assertEqual(set(m), {"rev_by_country", "big_events"})
            self.assertFalse(m["rev_by_country"].is_gcs)
            self.assertTrue(m["big_events"].is_gcs)
            self.assertEqual(m["rev_by_country"].schema, {"country": "string", "revenue": "double"})
            self.assertEqual(resolve("rev_by_country", m).rows, 240)

    def test_unknown_id_lists_known(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = load_manifest(_write(tmp, VALID))
            with self.assertRaises(ManifestError) as cm:
                resolve("nope", m)
            self.assertIn("big_events", str(cm.exception))
            self.assertIn("rev_by_country", str(cm.exception))

    def test_no_env_is_a_clear_error(self):
        os.environ.pop("BETTI_DATA_MANIFEST", None)
        os.environ.pop("BETTI_DATA_DIR", None)
        with self.assertRaises(ManifestError):
            load_manifest()

    def test_malformed_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ManifestError):
                load_manifest(_write(tmp, {"nope": []}))
            with self.assertRaises(ManifestError):
                load_manifest(_write(tmp, {"datasets": [{"id": "x"}]}))  # missing uri
            with self.assertRaises(ManifestError):
                load_manifest(_write(tmp, {"datasets": [{"id": "x", "uri": "file:///y", "format": "csv"}]}))

    def test_public_api_via_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BETTI_DATA_MANIFEST"] = _write(tmp, VALID)
            ids = {d["id"] for d in betti.datasets()}
            self.assertEqual(ids, {"rev_by_country", "big_events"})
            ds = betti.dataset("rev_by_country")
            self.assertEqual(ds.schema["revenue"], "double")
            self.assertEqual(ds.rows, 240)
            with self.assertRaises(ManifestError):
                betti.dataset("does_not_exist")

    def test_importing_lib_needs_no_engine(self):
        # betti_data must import with NO polars/duckdb present (engines load lazily on first read).
        self.assertNotIn("polars", sys.modules)
        self.assertNotIn("duckdb", sys.modules)


if __name__ == "__main__":
    unittest.main()
