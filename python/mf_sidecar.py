#!/usr/bin/env python
"""Long-lived MetricFlow sidecar: programmatic local queries (dbt Core).

Instead of spawning the `mf` CLI per query (which re-imports MetricFlow and pays
a cold-start each time), the JS server keeps this process warm and sends one JSON
request per line on stdin; one JSON response per line is written to stdout.

This is the local-dbt-Core analogue of dbt-mcp's client.py — which uses the
hosted dbtsl SDK (dbt platform). Here we use the same building blocks the `mf`
CLI uses: CLIConfiguration -> MetricFlowEngine -> query()/explain().

Protocol (newline-delimited JSON):
  request : {"id","op":"query"|"explain","project_dir","profiles_dir",
             "metrics":[...],"group_by":[...],"where":[...],"order":[...],
             "limit":int,"start":"YYYY-MM-DD","end":"YYYY-MM-DD","plan":bool}
  response: {"id","ok":true,"columns":[...],"rows":[[...]]}        # query
            {"id","ok":true,"sql":"...","plan":{...}?}            # explain (plan if requested)
            {"id","ok":false,"error":"..."}
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path


def _dt(s):
    return datetime.fromisoformat(s) if s else None


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


def _handle(req):
    from metricflow.engine.metricflow_engine import MetricFlowQueryRequest

    cfg = _build_engine(req["project_dir"], req.get("profiles_dir"))
    mf_request = MetricFlowQueryRequest.create(
        metric_names=req.get("metrics") or None,
        group_by_names=req.get("group_by") or None,
        where_constraints=req.get("where") or None,
        order_by_names=req.get("order") or None,
        limit=req.get("limit"),
        time_constraint_start=_dt(req.get("start")),
        time_constraint_end=_dt(req.get("end")),
    )
    if req.get("op") == "explain":
        res = cfg.mf.explain(mf_request=mf_request)
        out = {"ok": True, "sql": res.sql_statement.sql}
        if req.get("plan"):
            # MetricFlow query plan: the logical dataflow plan and the physical
            # execution plan, each rendered as a text DAG (like `mf query
            # --explain --show-dataflow-plan`).
            plan = {}
            try:
                plan["dataflow_plan"] = res.dataflow_plan.structure_text()
            except Exception as e:  # noqa: BLE001
                plan["dataflow_plan_error"] = str(e)[:1000]
            try:
                plan["execution_plan"] = res.execution_plan.structure_text()
            except Exception as e:  # noqa: BLE001
                plan["execution_plan_error"] = str(e)[:1000]
            out["plan"] = plan
        return out
    res = cfg.mf.query(mf_request=mf_request)
    df = res.result_df
    return {
        "ok": True,
        "columns": list(df.column_names),
        "rows": [list(r) for r in df.rows],
    }


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
