# MCP server (Node) + the dbt/MetricFlow CLIs it shells out to (Python).
FROM node:20-slim

# Python + build basics for dbt/metricflow.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dbt + MetricFlow into an isolated venv; expose `dbt`/`mf` on PATH.
# Pick the warehouse adapter at build time: requirements.txt (Postgres, default)
# or requirements-bigquery.txt (BigQuery) — see docker-compose.bigquery.yml.
ARG DBT_REQUIREMENTS=requirements.txt
ENV VENV=/opt/dbtvenv
COPY requirements*.txt ./
RUN python3 -m venv "$VENV" \
  && "$VENV/bin/pip" install --no-cache-dir --upgrade pip \
  && "$VENV/bin/pip" install --no-cache-dir -r "$DBT_REQUIREMENTS"
ENV PATH="$VENV/bin:$PATH"

# Node deps (production only — devDeps are the test harness).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source + default config (override config/dbt project via volumes).
COPY src ./src
COPY config ./config

# Everything below is configurable via env (see docker-compose.yml / .env.example).
ENV HOST=0.0.0.0 \
    PORT=3000 \
    CATALOG_PATH=/app/config/catalog.yml \
    RECIPES_PATH=/app/config/recipes.json \
    MCP_WORKSPACE=/workspace \
    DBT_BIN=dbt \
    MF_BIN=mf

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
