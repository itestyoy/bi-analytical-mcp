# Переход на dbt v2: проба и план

Проба проведена 2026-09-24 на `dbt 2.0.6` (`pip install dbt`, один бинарь на Rust) против фикстуры
`test/integration/fixtures/dbt_project`. Дальше описано, что работает как есть, что ломается и что нужно
поменять в сервере.

## 1. Итог в двух словах

- Вызовы dbt, которые делает сервер (`parse`, `run --select`, `show --inline`, `run-operation`, `seed`),
  работают на v2. Одно исключение — формат вывода `show`, он уже поддержан (раздел 3).
- **Главный блокер — формат семантических моделей.** v2 не читает legacy-YAML (`semantic_models:` на
  верхнем уровне, `measures:`). Он пишет предупреждение `SemanticModelDeprecated (dbt1157)`, выкидывает
  модели и метрики и **не создаёт `target/semantic_manifest.json`**. MetricFlow тогда не видит ни одной
  метрики. Значит, `src/yaml-render.js` должен генерировать новую спецификацию.
- С YAML в новой спецификации цепочка работает: v2 `parse` → `semantic_manifest.json` → `mf query`
  (dbt-metricflow 0.13 / metricflow 0.211). Числа сходятся с SEED_DATA: выручка 85; US 35, BR 25, GB 25;
  ARPPU 17.5 / 12.5 / 8.33. SCD-соединение (validity window) отрабатывает.
- Адаптера **Postgres в v2 нет**: поддерживаются BigQuery, Snowflake, Databricks, Redshift, DuckDB (CLI) и
  Spark (beta). Тестовый стек PGlite работать на v2 не может.
- Python-модели на DuckDB в v2 не поддерживаются: `Python models are not supported for duckdb adapter`.
  На BigQuery (BigFrames) проверить нельзя без склада, и документация v2 о них молчит.

## 2. Что проверено и как

| Шаг | Результат на v2 |
|---|---|
| `dbt parse` базового проекта | ок, пишет `manifest.json` и `semantic_manifest.json` (только time spine) |
| `dbt parse` контекста с legacy-YAML, как его генерирует сервер сейчас | ок, но semantic models и metrics выброшены, `semantic_manifest.json` нет |
| `dbt-autofix deprecations --semantic-layer` на том же контексте | переводит в новую спецификацию, но **теряет** `primary_entity` и `validity_params` и переименовывает semantic models в имена моделей. После ручной правки всё работает |
| `dbt parse` нового YAML | ок, `semantic_manifest.json` есть |
| `mf validate-configs` / `mf query` (dbt-metricflow 0.13) по манифесту от v2 | ок, числа верные (выше) |
| `dbt seed` | ок; тип `jsonb` в конфиге сидов специфичен для Postgres (на DuckDB — `json`) |
| `dbt run` | ок; SQL time spine фикстуры написан под Postgres (`generate_series`), на DuckDB падает — это свойство фикстуры, не v2 |
| `dbt show --inline … --output json --limit` | ок, но вывод — голый массив `[{…}]` вместо `{"show": [...]}` |
| `dbt run-operation mcp_relation_columns --args '{…}'` | ок, строка `MCP_COLS:` на месте |
| `DBT_TARGET_PATH` (изоляция процессов пакета) | учитывается |
| Python-модель | на DuckDB не поддерживается |

Важно: в `semantic_manifest.json` v2 записывает имена таблиц того профиля, с которым шёл `parse`.
Манифест, собранный под DuckDB, указывал на `"probe"."main"…`. В проде `parse` и `mf` работают с одним
профилем BigQuery, так что это не проблема. Но собрать манифест под одним складом и выполнять на другом
нельзя.

## 3. Уже сделано в этом коммите

- `parseShowJson` (`src/dbt-runner.js`) читает оба формата вывода `dbt show`: объект 1.x и массив v2.
  Юнит-тест — в `test/unit/dbt-error-format.test.js`.

## 4. Что нужно для миграции

1. **Генератор семантики → новая спецификация** (`src/yaml-render.js`, основная работа):
   - semantic model вкладывается в `models: - name: <модель>` с `semantic_model: { enabled: true, name: <наш
     alias> }`. Имя semantic model оставляем своим (`users`, `events`), чтобы не поменялись пути group_by;
   - `primary_entity:` на уровне модели; сущности — `columns[].entity: { type, name }`, а выражения и
     составные ключи — в `derived_semantics.entities` (`expr`);
   - измерения — `columns[].dimension: { type, name?, validity_params? }` и `granularity` на колонке,
     вычисляемые — в `derived_semantics.dimensions`;
   - `agg_time_dimension` на уровне модели (вместо `defaults:`);
   - measures исчезают. Каждая «мера» превращается в простую метрику модели (`type: simple`, `agg`, `expr`,
     `percentile`/`percentile_type`, `non_additive_dimension`, `agg_time_dimension`, `filter`);
   - ratio / derived / cumulative / conversion: `input_metrics` вместо `type_params.metrics`,
     `input_metric` вместо `measure`, `base_metric` / `conversion_metric` вместо measures;
   - `event_scope`, который сейчас идёт в `filter`/`expr` меры, autofix разворачивает в
     `CASE WHEN event_name = … THEN … END` в `expr` метрики. Поведение (числа) нужно подтвердить тестами
     на данных;
   - ограничение новой спецификации: в semantic model с SCD-измерениями нельзя объявлять простые метрики.
     У нас это уже так: меры на SCD-модели отбрасываются с предупреждением;
   - time spine — `time_spine:` на модели (`standard_granularity_column`) вместо отдельного YAML.
2. **MetricFlow**: legacy-спецификацию читает 0.13; для новой нужен dbt-metricflow ≥ 0.14 (разрешает
   dbt-core 1.12; сейчас 0.15.0 / metricflow 0.213). `mf` — это Python и ему нужен Python-адаптер, поэтому
   в образе живут **две установки**: бинарь dbt v2 (`DBT_BIN`) и venv с `dbt-metricflow` + `dbt-core
   1.12` + `dbt-bigquery` (`MF_BIN`). Пакет `dbt` (v2) и `dbt-core` в одном venv конфликтуют за
   команду `dbt`.
3. **Тестовый склад**: Postgres на v2 нет. Варианты:
   (а) оставить интеграционные тесты на dbt 1.12 + PGlite (1.12 понимает новую спецификацию) и отдельно
   прогонять v2-набор на DuckDB;
   (б) перевести интеграцию на DuckDB целиком. Для этого нужны DuckDB-варианты фикстур (`jsonb` → `json`,
   time spine) и диалект DuckDB в генераторе SQL (сейчас `postgres` и `bigquery`).
4. **Python-стадия**: на v2 её нужно проверить на BigQuery до переключения прода. Пока вопрос не закрыт,
   python-стадия остаётся на 1.x.
5. **Мелочи v2**:
   - строгий парсинг: неизвестные ключи YAML и конфигов — ошибка. Генерируемый YAML не должен нести
     лишних ключей;
   - `config.get()` больше не читает `meta` (у нас `meta.mcp` читает свой загрузчик, не Jinja — не
     затрагивает);
   - `--partial-parse` устарел, `partial_parse.msgpack` не используется. Копирование кэша в изолированный
     target (`DbtRunner._dbt`) на v2 просто ничего не даёт;
   - `SQL comprehension` / статический анализ v2 может отвергать SQL, который не понимает. Выключается
     `DBT_STATIC_ANALYSIS=off`, если понадобится для сгенерированных моделей;
   - при первом запуске v2 скачивает драйверы ADBC с CDN dbt Labs — в закрытом окружении нужен доступ
     или предзагрузка в образ.

## 5. Рекомендуемый порядок

1. dbt-core 1.12 + dbt-metricflow 0.15 (обе спецификации читаются) — на тестах PGlite без изменений.
2. Переписать `yaml-render.js` на новую спецификацию. Весь интеграционный набор на 1.12 должен дать те же
   числа.
3. `dbt parse --use-v2-parser` на проде (1.12) — проверка, что v2-парсер принимает проект и контексты.
4. Добавить v2-прогон на DuckDB (параллельно основному), затем переключить прод `DBT_BIN` на v2, оставив
   `MF_BIN` в venv с dbt-core 1.12.
