# MCP server (Node) + the dbt/MetricFlow CLIs it shells out to (Python).
# Node 22: the value index / job registry / memory persist via the built-in `node:sqlite`
# (DatabaseSync), available only on Node >= 22.5 — on older Node the store silently falls back
# to IN-MEMORY (nothing survives a restart; semantic_index reports persisted:false).
FROM node:22-slim

# Python + build basics for dbt/metricflow.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dbt + MetricFlow into an isolated venv; expose `dbt`/`mf` on PATH.
# Pick the warehouse adapter at build time: requirements.txt (DuckDB, default)
# or requirements-bigquery.txt (BigQuery) — see docker-compose.bigquery.yml.
ARG DBT_REQUIREMENTS=requirements.txt
ENV VENV=/opt/dbtvenv
COPY requirements*.txt ./
RUN python3 -m venv "$VENV" \
  && "$VENV/bin/pip" install --no-cache-dir --upgrade pip \
  && "$VENV/bin/pip" install --no-cache-dir -r "$DBT_REQUIREMENTS"
ENV PATH="$VENV/bin:$PATH"

# dbt v2 (the Rust binary) in a venv of its own — it and dbt-core both install a `dbt` command.
# The server uses whichever DBT_BIN names (its client reads the version): docker-compose.yml points
# it here; the BigQuery setup stays on 1.x until the python stage is proven on v2 there.
# INSTALL_DBT_V2=0 skips it.
ARG INSTALL_DBT_V2=1
RUN if [ "$INSTALL_DBT_V2" = "1" ]; then \
      python3 -m venv /opt/dbt2venv \
      && /opt/dbt2venv/bin/pip install --no-cache-dir --upgrade pip \
      && /opt/dbt2venv/bin/pip install --no-cache-dir -r requirements-dbt2.txt; \
    fi

# Node deps (production only — devDeps are the test harness).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source ONLY. The image is generic: NO catalog, recipes, dbt project, or any
# project-specific data is baked in — all of that is supplied at runtime via
# volumes + env in docker-compose. Only infra defaults live here.
#
# `python/` is SERVER CODE, not project data: the static gate the python pipeline stage runs
# before submitting a model (python/ast_gate.py) and the warm MetricFlow sidecar
# (python/mf_sidecar.py). Nothing imports them, so an image built from src/ alone looks fine and
# then fails at the first call that shells out to one. src/runtime-assets.js declares the set and
# test/unit/runtime-assets.test.js checks that this COPY covers it.
COPY src ./src
COPY python ./python
# …and config/, which carries the SYSTEM recipes (a deployment's own RECIPES_PATH is merged on top,
# not instead) plus the sample catalog.
COPY config ./config

ENV HOST=0.0.0.0 \
    PORT=3000 \
    MCP_WORKSPACE=/workspace \
    DBT_BIN=dbt \
    MF_BIN=mf

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
