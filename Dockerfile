# MCP server (Node) + the dbt/MetricFlow CLIs it shells out to (Python).
# Node 22: the value index / job registry / memory persist via the built-in `node:sqlite`
# (DatabaseSync), available only on Node >= 22.5 — on older Node the store silently falls back
# to IN-MEMORY (nothing survives a restart; semantic_index reports persisted:false).
FROM node:22-slim

# Python for the dbt/MetricFlow environments (Debian bookworm's 3.11 — the Python the locks are for).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dbt runs in named ENVIRONMENTS — one virtualenv each under DBT_ENVS_DIR (src/dbt/environments.js);
# the server uses DBT_ENV (else `dbt-v2`) and reads its dbt version from the binary. WHAT goes into
# each is decided by this tool, not the build: src/dbt/environment-specs.js names the exact packages,
# config/dbt-environments/*.lock.txt locks every file of every dependency by SHA-256, and
# scripts/dbt-env.mjs installs exactly that (--require-hashes, wheels only, a locked pip) and checks
# the result. There is no requirements file to hand in — only which warehouse to build for:
#   WAREHOUSE_ADAPTER — duckdb (default) or bigquery: the adapter of dbt-v1 and metricflow;
#   INSTALL_DBT_V2=0  — skip dbt-v2 (then set DBT_ENV=dbt-v1).
#   dbt-v2     — dbt v2 (its adapters are built in; it fetches the ADBC driver on first use)
#   dbt-v1     — dbt 1.x + the adapter (on DuckDB with pandas/pyarrow, for dbt Python models)
#   metricflow — MetricFlow's `mf` + the Python dbt-core and adapter it queries with; every dbt
#                environment queries metrics through it
ARG WAREHOUSE_ADAPTER=duckdb
ARG INSTALL_DBT_V2=1
ENV DBT_ENVS_DIR=/opt/dbt-envs
COPY scripts/dbt-env.mjs ./scripts/
COPY src/dbt/environments.js src/dbt/environment-specs.js ./src/dbt/
COPY config/dbt-environments ./config/dbt-environments
RUN set -e; \
    node scripts/dbt-env.mjs create metricflow --adapter "$WAREHOUSE_ADAPTER"; \
    node scripts/dbt-env.mjs create dbt-v1 --adapter "$WAREHOUSE_ADAPTER"; \
    if [ "$INSTALL_DBT_V2" = "1" ]; then node scripts/dbt-env.mjs create dbt-v2; fi
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
    DBT_ENV=dbt-v2

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
