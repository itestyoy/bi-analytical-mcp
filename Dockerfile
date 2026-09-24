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

# dbt runs in named ENVIRONMENTS — one virtualenv each under DBT_ENVS_DIR (src/dbt/environments.js);
# the server uses DBT_ENV (else `default`) and reads its dbt version from the binary.
#   default    — dbt v2 (requirements-dbt2.txt). INSTALL_DBT_V2=0 makes `default` the dbt1 environment.
#   dbt1       — dbt 1.x + the warehouse adapter: DBT_REQUIREMENTS, requirements.txt (DuckDB, with
#                pandas for Python models) or requirements-bigquery.txt (BigQuery).
#   metricflow — MetricFlow's `mf` + the Python dbt-core and adapter it queries with: MF_REQUIREMENTS,
#                requirements-metricflow.txt or requirements-metricflow-bigquery.txt. Every dbt
#                environment queries metrics through it (MF_ENV names another).
ARG DBT_REQUIREMENTS=requirements.txt
ARG MF_REQUIREMENTS=requirements-metricflow.txt
ARG INSTALL_DBT_V2=1
ENV DBT_ENVS_DIR=/opt/dbt-envs
COPY requirements*.txt ./
RUN set -e; \
    mkenv() { python3 -m venv "$DBT_ENVS_DIR/$1" \
      && "$DBT_ENVS_DIR/$1/bin/pip" install --no-cache-dir --upgrade pip \
      && "$DBT_ENVS_DIR/$1/bin/pip" install --no-cache-dir -r "$2"; }; \
    mkenv metricflow "$MF_REQUIREMENTS"; \
    mkenv dbt1 "$DBT_REQUIREMENTS"; \
    if [ "$INSTALL_DBT_V2" = "1" ]; then mkenv default requirements-dbt2.txt; \
    else ln -s dbt1 "$DBT_ENVS_DIR/default"; fi
# (for a shell in the container: mf on PATH)
ENV PATH="$DBT_ENVS_DIR/metricflow/bin:$PATH"

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
    DBT_ENV=default

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
