#!/usr/bin/env python
"""What each metric can be grouped by, as MetricFlow itself lists it — asked once per start.

The `mf` CLI prints only the names of what a metric can be grouped by; the server needs each item's
semantic model and entity path (src/group-by-items.js). So the dbt client (src/dbt/v1.js groupBys)
runs this script on the MetricFlow environment's Python with one request on stdin, over the same
building blocks the CLI uses (CLIConfiguration -> MetricFlowEngine.list_group_bys).

  request : {"id","op":"group_bys","project_dir","profiles_dir","metrics":[...]}
  response: {"id","ok":true,"group_bys":{"<metric>":[item, ...]}}  # a dimension {kind, name,
            semantic_model, entity_links, type, grain, dunder_name}, or an entity {kind, name,
            semantic_model, entity_links}
            {"id","ok":false,"error":"..."}
"""
import json
import os
import sys
from pathlib import Path


def _build_engine(project_dir, profiles_dir):
    # Import lazily so the process starts fast and errors surface per-request.
    from dbt_metricflow.cli.cli_configuration import CLIConfiguration

    # CLIConfiguration also reads these env vars; set them for good measure.
    os.environ["DBT_PROJECT_DIR"] = project_dir
    if profiles_dir:
        os.environ["DBT_PROFILES_DIR"] = profiles_dir
    cfg = CLIConfiguration()
    cfg.setup(
        dbt_profiles_path=Path(profiles_dir) if profiles_dir else None,
        dbt_project_path=Path(project_dir),
        configure_file_logging=False,
    )
    return cfg


def _release(cfg):
    """Let go of the warehouse after a request. A DuckDB database is a file only ONE process may hold
    open: kept open here, every dbt process on it would fail with a lock error. So the adapter's
    connections are closed, and dbt-duckdb's process-wide environment (which holds the file) too."""
    try:
        cfg.dbt_artifacts.adapter.cleanup_connections()
    except Exception:  # noqa: BLE001
        pass
    try:
        from dbt.adapters.duckdb.connections import DuckDBConnectionManager
    except Exception:  # noqa: BLE001 — not a DuckDB install
        return
    with DuckDBConnectionManager._LOCK:
        env = DuckDBConnectionManager._ENV
        DuckDBConnectionManager._ENV = None
        if env is not None:
            try:
                env.close()
            except Exception:  # noqa: BLE001
                pass


def _handle(req):
    cfg = _build_engine(req["project_dir"], req.get("profiles_dir"))
    try:
        return _answer(cfg, req)
    finally:
        _release(cfg)


def _group_by_item(item):
    """One group-by item MetricFlow offers, as plain data."""
    from metricflow.engine.models import Dimension

    sm = getattr(item, "semantic_model_reference", None)
    links = [e.element_name for e in (getattr(item, "entity_links", None) or ())]
    if isinstance(item, Dimension):
        tp = item.type_params
        grain = getattr(tp, "time_granularity", None) if tp else None
        return {
            "kind": "dimension",
            "name": item.name,
            "dunder_name": item.dunder_name,
            "semantic_model": sm.semantic_model_name if sm else None,
            "entity_links": links,
            "type": str(getattr(item.type, "value", item.type)).lower(),
            "grain": str(getattr(grain, "value", grain)).lower() if grain else None,
        }
    return {
        "kind": "entity",
        "name": item.name,
        "semantic_model": sm.semantic_model_name if sm else None,
        "entity_links": links,
    }


def _answer(cfg, req):
    if req.get("op") != "group_bys":
        return {"ok": False, "error": f"unknown op {req.get('op')!r} (this script answers group_bys)"}
    # asked of MetricFlow itself, one metric at a time: what each can be grouped by
    return {"ok": True, "group_bys": {m: [_group_by_item(i) for i in cfg.mf.list_group_bys(metric_names=[m])] for m in req.get("metrics") or []}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            sys.stdout.write(json.dumps({"id": None, "ok": False, "error": f"bad json: {e}"}) + "\n")
            sys.stdout.flush()
            continue
        rid = req.get("id")
        try:
            out = _handle(req)
            out["id"] = rid
        except Exception as e:  # noqa: BLE001
            out = {"id": rid, "ok": False, "error": _stringify_exc(e)}
        sys.stdout.write(json.dumps(out, default=str) + "\n")
        sys.stdout.flush()


def _stringify_exc(e):
    msg = str(e)
    return msg[:4000] if msg else type(e).__name__


if __name__ == "__main__":
    main()
