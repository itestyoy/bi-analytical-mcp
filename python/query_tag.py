"""Run the dbt or MetricFlow CLI with the call's QUERY TAG in front of every query it sends.

    <env>/bin/python query_tag.py dbt|mf <args...>

MCP_QUERY_TAG (src/dbt/query-tag.js — technical facts about where the call came from: the client
application, the tool, the task) becomes a leading `/* ... */` comment on every statement the dbt
adapter executes: dbt's own query comment is set only by the dbt CLI's runtime, and `mf` never sets
one, so the one place every query of both passes — the adapter's `_add_query_comment` — carries it.
The CLI itself runs in this process, as its own console script would, with the same arguments.
"""

import os
import sys


def _tag_queries(tag):
    from dbt.adapters.base.connections import BaseConnectionManager

    add = BaseConnectionManager._add_query_comment

    def _add_query_comment(self, sql):
        return f"/* {tag} */\n{add(self, sql)}"

    BaseConnectionManager._add_query_comment = _add_query_comment


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("dbt", "mf"):
        sys.stderr.write("usage: query_tag.py dbt|mf <args...>\n")
        return 2
    entry = sys.argv.pop(1)
    sys.argv[0] = entry
    tag = os.environ.get("MCP_QUERY_TAG")
    if tag:
        _tag_queries(tag.replace("*/", "* /"))
    if entry == "dbt":
        from dbt.cli.main import cli
    else:
        from dbt_metricflow.cli.main import cli
    return cli()


if __name__ == "__main__":
    sys.exit(main())
