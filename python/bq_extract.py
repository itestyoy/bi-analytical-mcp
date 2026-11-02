#!/usr/bin/env python
"""A BigQuery table written to Cloud Storage as ONE CSV file, by an extract job.

SQL's EXPORT DATA takes only a wildcard URI and writes as many files as BigQuery decides, each named
with a number; an extract job (what `bq extract` runs) to a URI without a wildcard writes exactly one
file under the name asked for — for a table of up to 1 GB of logical data, the limit BigQuery puts on
one file. The table's size is read first, off its own metadata: one bigger than `max_bytes` (the
deployment's export limit, at most that 1 GB) is not extracted, and the answer says how big it is.

The client is dbt-bigquery's own, built from the dbt profile's output (env_var already rendered by the
server), so it authenticates exactly as dbt does there — oauth, a key file, a key in the profile,
impersonation — and runs its job in the profile's location.

Protocol: one JSON object on stdin — {"output": <the profile's output>, "table": "<project>.<dataset>.
<table>", "uri": "gs://…/<name>.csv", "max_bytes": <int>} — one JSON object on stdout:
{"ok": true, "file", "rows", "bytes"} | {"ok": false, "too_big": true, "bytes"} | {"ok": false, "error"}.
"""
import json
import sys


def main():
    req = json.load(sys.stdin)
    from dbt.adapters.bigquery.credentials import BigQueryCredentials
    from dbt.adapters.bigquery.clients import create_bigquery_client
    from google.cloud import bigquery

    output = {k: v for k, v in req["output"].items() if k not in ("type", "threads")}
    data = BigQueryCredentials.translate_aliases(output)
    BigQueryCredentials.validate(data)
    creds = BigQueryCredentials.from_dict(data)
    client = create_bigquery_client(creds)

    table = client.get_table(req["table"])
    size = int(table.num_bytes or 0)
    if size > int(req["max_bytes"]):
        return {"ok": False, "too_big": True, "bytes": size}
    config = bigquery.ExtractJobConfig(destination_format=bigquery.DestinationFormat.CSV, print_header=True)
    job = client.extract_table(table.reference, req["uri"], job_config=config, location=table.location)
    job.result()
    return {"ok": True, "file": req["uri"], "rows": int(table.num_rows or 0), "bytes": size}


if __name__ == "__main__":
    try:
        out = main()
    except Exception as e:  # the job's or the client's own message, for the answer
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out))
