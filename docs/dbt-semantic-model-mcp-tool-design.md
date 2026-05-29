# MCP-тул: декларативное создание dbt semantic model «на лету» + запрос

> Дизайн тулов, реализующих подход **«AI декларирует — dbt пишет SQL»**.
> AI не генерирует SQL и не угадывает имена колонок. Он заполняет
> **полностью схематизированный** объект: каждое поле, где ожидается колонка или
> свойство, — это `enum` из реального каталога двух базовых dbt-моделей. Тул
> материализует это в корректный YAML semantic model + metrics, выполняет
> `dbt parse` и затем `dbt sl query`.
>
> Спецификация semantic model, на которую опирается дизайн:
> [`dbt-semantic-layer-spec.md`](./dbt-semantic-layer-spec.md).

---

## 1. Идея и принципы

```
        ┌──────────────────────────── MCP server ────────────────────────────┐
 AI ──► │  create_semantic_model(декларация, enum-constrained)                │
        │      │  рендер YAML (events SM + metrics, namespaced)               │
        │      ▼                                                              │
        │  .mcp/ctx/<context_id>/…/<task>.yml  ──►  dbt parse  ──►  manifest   │
        │                                                                     │
 AI ──► │  query_semantic_model(metrics, group_by, where — всё enum)          │
        │      │  рендер `dbt sl query ...`  ──►  выполнение  ──►  rows        │
        └──────┴──────────────────────────────────────────────────────────────┘
```

1. **Декларативность вместо генерации.** Тул принимает *описание* модели, а не
   SQL/YAML-текст. AI выбирает из перечислений; «свободного текста» в местах
   имён нет в принципе.
2. **Схема = каталог.** `enum`-значения для имён колонок, свойств событий, имён
   событий и атрибутов юзера **генерируются сервером из каталога** двух
   базовых моделей. Невалидное имя нельзя даже передать — оно не пройдёт
   JSON-Schema валидацию на входе.
3. **dbt — источник SQL.** Join событий и атрибутов, окна, гранулярности,
   диалект склада — всё на MetricFlow.
4. **Виртуальные модели под задачу.** Каждая модель именуется по задаче и
   неймспейсится (префикс), чтобы соблюсти глобальную уникальность имён dbt и не
   мешать другим задачам. Модели эфемерны: их можно удалять (`drop_semantic_model`).
5. **Детерминизм и прозрачность.** Одинаковая декларация → одинаковый YAML и
   SQL. Тул всегда может вернуть сгенерированный YAML/SQL без выполнения
   (`dry_run` / `--compile`).
6. **Изоляция по контексту.** Создание виртуальных моделей и выполнение dbt
   происходят **в рамках `context_id`** — изолированного рабочего пространства
   (свои файлы, свой dbt `target-path`, свой неймспейс имён). Параллельные задачи
   не видят моделей друг друга и не конфликтуют по глобально-уникальным именам
   dbt. Контексты эфемерны и управляемы (создать/обновить/удалить).

---

## 2. Каталог: реестр dbt-моделей и базовые semantic models

Каталог — единственное место, где «зашиты» физические имена и выражения. Из
него сервер **проецирует enum'ы в JSON-Schema тула** и **рендерит `expr`** в YAML.

> **Принцип организации многих dbt-моделей (из спецификации §3.3):**
> *один semantic model = одна dbt-модель*. Поэтому каталог — это **реестр
> dbt-моделей**; для каждой сервер держит **базовый (стабильный) semantic model**
> с его entities/dimensions и небольшой библиотекой measures. MetricFlow
> **сам соединяет** эти модели по совпадающим `entities` (join не пишется руками).

### 2.1 Реестр базовых моделей
| Ключ модели | dbt-модель | Зерно | `primary` entity | Роль в графе |
|---|---|---|---|---|
| `events` | `ref('fct_analytics_events')` | 1 строка = 1 событие | `event` (синтетич.) | **fct** — носитель measures, `foreign`-ключи `user`, `session` |
| `users` | `ref('dim_users')` | 1 строка = 1 игрок | `user` | **dim** — атрибуты юзера; цель join по `user` |
| `campaigns` | `ref('dim_campaigns')` | 1 строка = 1 кампания | `campaign` | **dim** (опц.) — пример 2-hop: `user → campaign` |

Граф соединений (рёбра — по `entities`):
```
   events ──(foreign user)──►  users ──(foreign campaign)──►  campaigns
          ──(foreign session)─► (опц. sessions-модель)
```
- `events.user (foreign) → users.user (primary)` — валидный left join (см.
  матрицу §3.3 спецификации). Атрибуты юзера доступны метрикам событий как
  `user__<attr>`.
- 2-hop: если у `users` есть `foreign campaign` → `campaigns.campaign (primary)`,
  то в запросе доступно `user__campaign__channel` (до 2 переходов / 3 таблиц).

> Реестр **расширяемый**: чтобы подключить новую dbt-модель (напр. `dim_levels`,
> `dim_ab_experiments`), достаточно добавить её в каталог с описанием entities/
> dimensions — сервер сгенерирует для неё базовый SM и расширит enum'ы. Тул также
> умеет объявлять semantic model для модели из реестра **на лету** под конкретную
> задачу (§3, поле `semantic_models[].from`).

### 2.2 Базовые semantic models (стабильные фикстуры)
Для каждой записи реестра сервер один раз деплоит стабильный SM в
`models/semantic/_base/` — он живёт постоянно и переиспользуется всеми задачами.
Это даёт: (а) цель для join (`primary`/`unique` ключ), (б) общий словарь
измерений, (в) базовые measures (напр. `users__count`). Пример для `users`:
```yaml
semantic_models:
  - name: users
    model: ref('dim_users')
    entities:
      - { name: user, type: primary, expr: user_id }
      - { name: campaign, type: foreign, expr: campaign }   # ребро к dim_campaigns
    dimensions:
      - { name: install_date, type: time, type_params: { time_granularity: day } }
      - { name: country, type: categorical }
      - { name: platform, type: categorical }
      - { name: media_source, type: categorical }
      - { name: acquisition_type, type: categorical }
      # … остальные атрибуты
    measures:
      - { name: users__count, agg: count, expr: "1" }
```

### 2.3 Формат каталога (реестр моделей)
```jsonc
{
  "warehouse_dialect": "bigquery",        // как распаковывать JSON в expr
  "models": {

    "events": {
      "dbt_model": "fct_analytics_events",
      "role": "fact",
      "primary_entity": "event",          // синтетический PK события
      "entities": {                        // join-ключи (foreign → другие модели)
        "user":    { "column": "user_id",    "type": "foreign" },
        "session": { "column": "session_id", "type": "foreign" }
      },
      "time": { "column": "event_timestamp", "granularity": "second" },
      "event_name": { "column": "event_name" },
      "known_events": [
        "session_start","session_end","level_start","level_complete",
        "level_fail","purchase","ad_impression","ad_click","tutorial_step","item_acquired"
      ],
      "properties": {                       // ключи JSON event_properties + типы
        "level":      { "type": "int" },    "score":   { "type": "int" },
        "attempt":    { "type": "int" },    "moves":   { "type": "int" },
        "revenue":    { "type": "numeric" },"currency":{ "type": "string" },
        "result":     { "type": "string", "values": ["win","lose"] },
        "item_id":    { "type": "string" }, "product_id": { "type": "string" },
        "ad_network": { "type": "string" }, "step_id":    { "type": "string" }
      }
    },

    "users": {
      "dbt_model": "dim_users",
      "role": "dimension",
      "primary_entity": { "name": "user", "column": "user_id" },
      "entities": { "campaign": { "column": "campaign", "type": "foreign" } },
      "dimensions": {
        "install_date":    { "type": "time", "granularity": "day" },
        "platform":        { "type": "string" }, "os_version":   { "type": "string" },
        "device_model":    { "type": "string" }, "country":      { "type": "string" },
        "region":          { "type": "string" }, "language":     { "type": "string" },
        "media_source":    { "type": "string" }, "campaign":     { "type": "string" },
        "ad_group":        { "type": "string" }, "creative":     { "type": "string" },
        "acquisition_type":{ "type": "string", "values": ["organic","paid"] },
        "app_version":     { "type": "string" }
      },
      "measures": { "users__count": { "agg": "count", "expr": "1" } }
    },

    "campaigns": {                          // опц. третья модель (пример 2-hop)
      "dbt_model": "dim_campaigns",
      "role": "dimension",
      "primary_entity": { "name": "campaign", "column": "campaign_id" },
      "dimensions": {
        "channel":  { "type": "string" }, "network": { "type": "string" },
        "cost_model": { "type": "string" }
      }
    }
  }
}
```

### 2.4 Производные перечисления (как сервер строит enum'ы)
Из реестра сервер вычисляет именованные множества и подставляет их в `enum`
JSON-Schema тулов. Множества имён колонок **квалифицируются ключом модели**, что
позволяет схеме держать корректный enum для каждой выбранной dbt-модели:

| Имя множества | Из чего собирается | Где используется |
|---|---|---|
| `MODEL_KEY` | ключи `models` (`events`, `users`, `campaigns`, …) | `semantic_models[].from`, `use_base_models[]` |
| `EVENT_NAME` | `models.events.known_events` | `event_scope`, измерение `event_name`, фильтры |
| `EVENT_PROP` | ключи `models.events.properties` | измерения/фильтры по свойству события |
| `EVENT_PROP_NUMERIC` | свойства с `type ∈ {int,numeric}` | `field` для `sum/avg/median/percentile` |
| `DIM_<MODEL>` | `dimensions` конкретной модели | измерения/`group_by`/`where` этой модели |
| `GROUPABLE_PATH` | все достижимые `entity__dim` / `entity__entity__dim` (≤2 hop) | `group_by`, `where.field`, `order_by` |
| `MEASURE_REF` | measures всех вовлечённых моделей (base + task) | ссылки в метриках |
| `DIM_TIME_GRAIN` | из §8 спецификации | грейн time-измерений |
| `AGG` / `METRIC_TYPE` / … | фикс. enum из спецификации | агрегации, типы метрик |

> Каждое значение enum снабжается описанием (тип, примеры значений,
> кардинальность из `describe_catalog`), чтобы у AI был «grounding» прямо в схеме.
> `GROUPABLE_PATH` сервер вычисляет обходом графа entity на ≤2 перехода — в него
> попадают и `metric_time`, и `user__country`, и `user__campaign__channel`.

---

## 3. Архитектура нескольких semantic models под задачу

Из спецификации §3.3: **один semantic model = одна dbt-модель**, а join'ы между
ними MetricFlow строит сам по `entities`. Поэтому тул работает на двух уровнях:

| Уровень | Что это | Жизненный цикл |
|---|---|---|
| **Базовые SM** | по одному стабильному SM на каждую dbt-модель реестра (`events`, `users`, `campaigns`…), деплоятся один раз в `models/semantic/_base/`. Дают цель join (`primary`/`unique`), общий словарь измерений и базовые measures. | постоянные |
| **Task SM** | один или несколько SM, объявленных под конкретную задачу (поле `semantic_models[]`), с task-специфичными measures/dimensions; неймспейсятся префиксом `<task>`. | эфемерные |

**Как тул задействует несколько dbt-моделей:**
1. **Ссылка** на базовые SM — `use_base_models: ["users","campaigns"]`. Их
   измерения сразу доступны для `group_by`/`where`/фильтров метрик через join по
   entity (`user__country`, `user__campaign__channel`) — ничего переобъявлять не
   нужно.
2. **Объявление** новых SM на лету — `semantic_models[]`, каждый со своим `from`
   (dbt-модель из реестра) и собственными measures/dimensions. Так можно поднять
   и несколько fct-моделей (MetricFlow соединит их full-outer по общим entity).
3. **Метрики** (`metrics[]`) ссылаются на measures из любых вовлечённых SM (task
   или base); join разруливается автоматически.

> Итог: «виртуальная модель под задачу» = (опц.) ссылки на базовые SM + (опц.)
> новые task-SM + метрики. Это и есть «несколько semantic models под задачу».

### Контексты выполнения и изоляция (`context_id`)

Всё создание/обновление/запрос виртуальных моделей идёт **внутри контекста** —
изолированного рабочего пространства. Это исключает три класса проблем:
коллизии глобально-уникальных имён dbt (measures/metrics), смешивание
`semantic_manifest.json` между параллельными задачами и гонки при `dbt parse`/
`dbt sl query`.

**Что изолирует контекст:**
| Ресурс | Изоляция |
|---|---|
| Файлы YAML | свой каталог `<<project>>/.mcp/ctx/<context_id>/models/` |
| Артефакты dbt | свой `--target-path target/ctx/<context_id>` (свой `semantic_manifest.json`) |
| Имена объектов | префикс `ctx_<context_id>__<task>__…` поверх неймспейса задачи |
| Видимость | контекст видит только свои task-SM + общие base-SM (read-only) |

**Поток `context_id` (правило для AI):**
```
create_semantic_model({ ... })                  // БЕЗ context_id
   → сервер аллоцирует НОВЫЙ context_id, поднимает workspace, возвращает его
create_semantic_model({ context_id, ... })      // С context_id из прошлого ответа
   → добавляет SM/метрики в ТОТ ЖЕ контекст (наращиваем модель задачи)
query/update/delete_*({ context_id, ... })       // всегда в рамках контекста
```
- **Та же задача / продолжение** → AI передаёт `context_id` из предыдущего ответа.
- **Новая задача** → `context_id` не передаётся, создаётся свежий изолированный
  контекст.

**Реализация изоляции (рекомендация).** Базовый dbt-проект (base-модели +
base-SM) — общий и read-only. Для контекста сервер делает лёгкий **оверлей-проект**
(`--project-dir` = workspace контекста: симлинк на base `models/` + собственный
подкаталог сгенерированных semantic YAML), запускает dbt с персональным
`--target-path`. Параллельные контексты → независимые манифесты и параллельный
безопасный parse/query. Альтернатива (общий проект): файлы в
`models/semantic/ctx/<id>/` + неймспейс `ctx_<id>__` + персональный `--target-path`.

**Жизненный цикл.** Контексты эфемерны: TTL/GC по неактивности + явный
`drop_context`. `list_contexts`/`describe_context` показывают активные контексты.

## 3a. Тул `create_semantic_model`

**Назначение.** Декларативно описать одну/несколько semantic models под задачу и
метрики к ним. Тул материализует YAML, проставляет `primary_entity`,
`foreign`-ключи и `metric_time` из реестра, неймспейсит имена, делает `dbt parse`.

### 3.1 JSON Schema — конверт (вход)
> `enum`-списки `« {NAME} »` сервер подставляет из реестра (§2.4). Так
> гарантируется, что **никаких неразрешённых имён** в инструмент не попадёт.

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "metrics"],
  "properties": {
    "context_id": {
      "type": "string", "pattern": "^[a-z0-9]{8,32}$",
      "description": "Изолированный контекст. НЕ передавать для новой задачи (сервер создаст новый контекст и вернёт его id). Передавать id из предыдущего ответа, чтобы добавить модели/метрики в ТОТ ЖЕ контекст."
    },
    "name": {
      "type": "string", "pattern": "^[a-z][a-z0-9_]{2,40}$",
      "description": "Имя задачи. Namespace-префикс для генерируемых SM/measures/metrics внутри контекста (глобальная уникальность dbt обеспечивается префиксом ctx_<context_id>__<name>)."
    },
    "description": { "type": "string" },

    "use_base_models": {
      "type": "array",
      "items": { "type": "string", "enum": ["« MODEL_KEY »"] },
      "description": "Базовые dbt-модели, чьи измерения/measures сделать доступными через автоджойн (без переобъявления). Напр. ['users','campaigns']."
    },

    "semantic_models": {
      "type": "array",
      "description": "Новые semantic models, объявляемые под задачу (по одному на dbt-модель). Обычно достаточно одного — по событиям.",
      "items": { "$ref": "#/$defs/semanticModel" }
    },

    "metrics": {
      "type": "array", "minItems": 1,
      "description": "Метрики поверх measures из task-SM и/или базовых SM. Имена неймспейсятся префиксом name.",
      "items": { "$ref": "#/$defs/metric" }
    },

    "dry_run": {
      "type": "boolean", "default": false,
      "description": "true — вернуть сгенерированный YAML без записи и dbt parse."
    }
  },

  "$defs": {

    "semanticModel": {
      "type": "object",
      "additionalProperties": false,
      "required": ["from"],
      "properties": {
        "from": { "type": "string", "enum": ["« MODEL_KEY »"],
                  "description": "dbt-модель из реестра. Определяет entities, time и допустимые enum колонок/свойств для этого SM." },
        "alias": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,30}$",
                   "description": "Опц. суффикс имени SM, если под задачу нужно несколько SM по одной dbt-модели." },

        "event_scope": {
          "description": "Только для from=events. Ограничение классом событий — транслируется в filter measures/metrics, а не в WHERE по таблице.",
          "type": "object", "additionalProperties": false,
          "properties": {
            "event_name": {
              "type": "array", "minItems": 1,
              "items": { "type": "string", "enum": ["« EVENT_NAME »"] },
              "description": "Имена событий (только из реестра)."
            }
          }
        },

        "dimensions": {
          "description": "Дополнительные оси этого SM. Колонки/свойства — enum, зависящий от from. Измерения присоединяемых базовых моделей переобъявлять НЕ нужно.",
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false, "required": ["source"],
            "oneOf": [
              { "title": "model_column",
                "properties": {
                  "source": { "const": "model_column" },
                  "column": { "type": "string", "enum": ["« DIM_<from> »"],
                              "description": "Колонка выбранной dbt-модели (enum по from)." },
                  "as_type":{ "enum": ["categorical","time"], "default": "categorical" },
                  "grain":  { "enum": ["« DIM_TIME_GRAIN »"], "description": "Только для as_type=time." },
                  "label":  { "type": "string" } },
                "required": ["source","column"] },
              { "title": "event_property",
                "description": "Только для from=events: измерение из JSON event_properties (expr рендерит сервер под диалект).",
                "properties": {
                  "source":   { "const": "event_property" },
                  "property": { "type": "string", "enum": ["« EVENT_PROP »"] },
                  "as_type":  { "enum": ["categorical","time"], "default": "categorical" },
                  "label":    { "type": "string" } },
                "required": ["source","property"] }
            ]
          }
        },

        "measures": {
          "description": "Агрегаты этого SM. Имена неймспейсятся префиксом задачи.",
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false, "required": ["name","agg"],
            "properties": {
              "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,40}$" },
              "agg":  { "enum": ["count","count_distinct","sum","average","median","min","max","percentile","sum_boolean"],
                        "description": "Тип агрегации (спецификация §5.1)." },
              "field": {
                "description": "ЧТО агрегируем. Зависит от agg и from.",
                "oneOf": [
                  { "title": "rows",            "const": "*",
                    "description": "Для agg=count — считаем строки/события." },
                  { "title": "entity_key",      "type": "string", "enum": ["« ENTITY_KEY_<from> »"],
                    "description": "Для count_distinct — уникальные значения ключа (user_id, session_id…)." },
                  { "title": "model_numeric",   "type": "string", "enum": ["« NUMERIC_COL_<from> »"],
                    "description": "Числовая колонка модели — для sum/average/median/min/max/percentile." },
                  { "title": "event_property",  "type": "string", "enum": ["« EVENT_PROP_NUMERIC »"],
                    "description": "Только from=events: числовое свойство события." }
                ]
              },
              "percentile": { "type": "number", "minimum": 0, "exclusiveMaximum": 1,
                              "description": "Только для agg=percentile." },
              "filter": { "$ref": "#/$defs/predicateGroup" },
              "label":  { "type": "string" }
            },
            "allOf": [
              { "if": { "properties": { "agg": { "const": "percentile" } } },
                "then": { "required": ["percentile"] } },
              { "if": { "properties": { "agg": { "enum": ["sum","average","median","min","max","percentile"] } } },
                "then": { "properties": { "field": { "not": { "const": "*" } } } } }
            ]
          }
        }
      }
    },

    "fieldRef": {
      "description": "Ссылка на поле для фильтров — строго из реестра. Для измерений используется путь entity (multi-hop ≤2), для свойств события — ключ JSON.",
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "oneOf": [
        { "title": "dimension_path",
          "properties": { "kind": { "const": "dimension" },
                          "path": { "type": "string", "enum": ["« GROUPABLE_PATH »"],
                                    "description": "Напр. event_name, user__country, user__campaign__channel." } },
          "required": ["kind","path"] },
        { "title": "event_property",
          "properties": { "kind": { "const": "event_property" },
                          "name": { "type": "string", "enum": ["« EVENT_PROP »"] } },
          "required": ["kind","name"] },
        { "title": "metric_time",
          "properties": { "kind": { "const": "metric_time" },
                          "grain": { "enum": ["« DIM_TIME_GRAIN »"] } },
          "required": ["kind"] }
      ]
    },

    "predicate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["field", "op"],
      "properties": {
        "field": { "$ref": "#/$defs/fieldRef" },
        "op":    { "enum": ["eq","neq","gt","gte","lt","lte","in","not_in","between","is_null","is_not_null"] },
        "value": { "description": "Скаляр / список (in/not_in) / пара (between). Для enum-полей валидируется по значениям из каталога." }
      }
    },
    "predicateGroup": {
      "type": "object",
      "additionalProperties": false,
      "required": ["op", "conditions"],
      "properties": {
        "op":         { "enum": ["and", "or"] },
        "conditions": { "type": "array", "minItems": 1,
                        "items": { "oneOf": [ { "$ref": "#/$defs/predicate" },
                                              { "$ref": "#/$defs/predicateGroup" } ] } }
      }
    },

    "measureRef": {
      "type": "object", "additionalProperties": false, "required": ["name"],
      "properties": {
        "name":   { "type": "string", "enum": ["« MEASURE_REF »"],
                    "description": "Имя measure из task-SM (без префикса) или базовой модели (напр. users__count). MetricFlow присоединит нужную модель по графу entity." },
        "filter": { "$ref": "#/$defs/predicateGroup" }
      }
    },

    "metric": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "type"],
      "properties": {
        "name":  { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,40}$" },
        "label": { "type": "string" },
        "type":  { "enum": ["simple","ratio","cumulative","derived","conversion"] },
        "filter":{ "$ref": "#/$defs/predicateGroup" }
      },
      "allOf": [
        { "if": { "properties": { "type": { "const": "simple" } } },
          "then": { "properties": {
            "measure": { "$ref": "#/$defs/measureRef" },
            "fill_nulls_with": { "type": "number" } },
            "required": ["measure"] } },

        { "if": { "properties": { "type": { "const": "ratio" } } },
          "then": { "properties": {
            "numerator":   { "$ref": "#/$defs/measureRef" },
            "denominator": { "$ref": "#/$defs/measureRef" } },
            "required": ["numerator","denominator"] } },

        { "if": { "properties": { "type": { "const": "cumulative" } } },
          "then": { "properties": {
            "measure":      { "$ref": "#/$defs/measureRef" },
            "window":       { "type": "string", "pattern": "^[0-9]+ (second|minute|hour|day|week|month|quarter|year)s?$",
                              "description": "Скользящее окно, напр. '7 days'." },
            "grain_to_date":{ "enum": ["day","week","month","quarter","year"] },
            "period_agg":   { "enum": ["first","last","average"] } },
            "required": ["measure"] } },

        { "if": { "properties": { "type": { "const": "derived" } } },
          "then": { "properties": {
            "expr":    { "type": "string", "description": "Формула из alias'ов input-метрик, напр. 'revenue / nullif(dau,0)'." },
            "metrics": { "type": "array", "minItems": 1, "items": {
              "type": "object", "additionalProperties": false, "required": ["name"],
              "properties": { "name": { "type": "string" }, "alias": { "type": "string" } } } } },
            "required": ["expr","metrics"] } },

        { "if": { "properties": { "type": { "const": "conversion" } } },
          "then": { "properties": {
            "base_measure":       { "$ref": "#/$defs/measureRef" },
            "conversion_measure": { "$ref": "#/$defs/measureRef" },
            "entity":             { "enum": ["user","session"], "default": "user" },
            "window":             { "type": "string", "pattern": "^[0-9]+ (second|minute|hour|day|week|month|quarter|year)s?$" },
            "calculation":        { "enum": ["conversion_rate","conversion"], "default": "conversion_rate" },
            "constant_properties":{ "type": "array", "items": { "type": "string", "enum": ["« EVENT_PROP »"] } } },
            "required": ["base_measure","conversion_measure","entity","window"] } }
      ]
    }
  }
}
```

> Замечания по жёсткости схемы:
> - `additionalProperties: false` везде — лишние ключи запрещены.
> - Имена колонок/свойств/событий/атрибутов **только** `enum` из каталога.
> - `if/then` связывает `agg` ↔ допустимый `field`, `type` метрики ↔ её
>   `type_params`. AI физически не может собрать «percentile без percentile» или
>   «sum по строковому полю».
> - Фильтры — структурные (`predicateGroup`), а не строки. В YAML/`--where` их
>   рендерит сервер через jinja-обёртки (`Dimension/TimeDimension/...`).

### 3.2 Что генерирует тул (маппинг → YAML)
Для `name: lvl_econ`, диалект BigQuery, декларация ниже. Задача: экономика
покупок по продуктам, с разбивкой по атрибутам юзера (`users`) и каналу
кампании через 2-hop (`campaigns`) — то есть **три dbt-модели**:

**Вход:**
```jsonc
{
  "name": "lvl_econ",
  "use_base_models": ["users", "campaigns"],   // join'абельны без переобъявления
  "semantic_models": [
    {
      "from": "events",
      "event_scope": { "event_name": ["purchase"] },
      "dimensions": [
        { "source": "event_property", "property": "product_id" },
        { "source": "event_property", "property": "level", "as_type": "categorical" }
      ],
      "measures": [
        { "name": "revenue",  "agg": "sum",            "field": "revenue" },
        { "name": "payers",   "agg": "count_distinct", "field": "user_id" },
        { "name": "purchases","agg": "count",          "field": "*" }
      ]
    }
  ],
  "metrics": [
    { "name": "revenue", "type": "simple", "measure": { "name": "revenue" } },
    { "name": "arppu",   "type": "ratio",
      "numerator": { "name": "revenue" }, "denominator": { "name": "payers" } }
  ]
}
```
> `users`/`campaigns` не переобъявляются: их базовые SM уже существуют, и
> измерения `user__country`, `user__campaign__channel` станут доступны для
> `group_by`/`where` через автоджойн. Чтобы поднять под задачу совсем новую
> dbt-модель — добавляется ещё один элемент в `semantic_models[]` с её `from`.

**Сгенерированный `.mcp/ctx/a1b2c3d4e5/models/lvl_econ.yml`:**
```yaml
semantic_models:
  - name: sm_lvl_econ_events                      # sm_<task>_<from>
    description: "Virtual semantic model for task: lvl_econ"
    model: ref('fct_analytics_events')
    defaults:
      agg_time_dimension: event_time
    primary_entity: event
    entities:
      - name: user
        type: foreign
        expr: user_id
      - name: session
        type: foreign
        expr: session_id
    dimensions:
      - name: event_time
        type: time
        type_params: { time_granularity: second }
        expr: event_timestamp
      - name: lvl_econ__product_id
        type: categorical
        expr: "JSON_VALUE(event_properties, '$.product_id')"
      - name: lvl_econ__level
        type: categorical
        expr: "CAST(JSON_VALUE(event_properties, '$.level') AS INT64)"
    measures:
      - name: lvl_econ__revenue
        agg: sum
        expr: "CAST(JSON_VALUE(event_properties, '$.revenue') AS NUMERIC)"
        agg_time_dimension: event_time
      - name: lvl_econ__payers
        agg: count_distinct
        expr: user_id
        agg_time_dimension: event_time
      - name: lvl_econ__purchases
        agg: count
        expr: "1"
        agg_time_dimension: event_time

metrics:
  - name: lvl_econ__revenue
    type: simple
    type_params:
      measure:
        name: lvl_econ__revenue
        filter: "{{ Dimension('event__event_name') }} = 'purchase'"
  - name: lvl_econ__arppu
    type: ratio
    type_params:
      numerator:   { name: lvl_econ__revenue }
      denominator: { name: lvl_econ__payers }
    filter: "{{ Dimension('event__event_name') }} = 'purchase'"
```

Маппинг по полям:

| Поле декларации | Куда идёт в YAML |
|---|---|
| `name` | префикс `sm_<name>` для каждого SM, `<name>__` для measures/metrics |
| `use_base_models` | не пишет YAML — обеспечивает доступность базовых SM (граф join) |
| `semantic_models[].from` | `model: ref(<dbt_model>)` + `primary_entity` и `foreign`-entities из реестра |
| `semantic_models[].event_scope` | `filter` на measure/metric: `Dimension('event__event_name') IN (...)` |
| `semantic_models[].dimensions[].event_property` | `dimensions[]` c `expr` = распаковка JSON под диалект |
| `semantic_models[].measures[].agg/field` | `measures[].agg` + `expr` (`*`→`"1"`, свойство→распаковка) |
| `…measures[].percentile` | `agg_params.percentile` |
| `metrics[].*` | `metrics[]` c соответствующими `type_params` (§6 спецификации) |
| фильтры (`predicateGroup` / `fieldRef`) | jinja-предикаты `filter` (`Dimension/TimeDimension`) |

### 3.3 Выход тула
```jsonc
{
  "context_id": "a1b2c3d4e5",                          // ВЕРНУТЬ и переиспользовать для той же задачи
  "task": "lvl_econ",
  "file": ".mcp/ctx/a1b2c3d4e5/models/lvl_econ.yml",
  "yaml": "…сгенерированный YAML…",
  "semantic_models": ["sm_lvl_econ_events"],          // объявленные task-SM
  "joined_base_models": ["users", "campaigns"],        // доступны через автоджойн
  "metrics":    ["lvl_econ__revenue", "lvl_econ__arppu"],
  "groupable":  ["metric_time", "lvl_econ__product_id", "lvl_econ__level",
                 "user__country", "user__platform", "user__media_source",
                 "user__campaign__channel"],           // 2-hop через campaigns
  "parse": { "ok": true, "duration_ms": 1840 },        // отсутствует при dry_run
  "assumptions": [
    "primary_entity=event (синтетический PK события)",
    "agg_time_dimension=event_time (event_timestamp, грейн second)",
    "user.* доступны через join events.user→users.user; user__campaign__* — 2-hop через campaigns"
  ],
  "warnings": []
}
```

После успешного вызова сервер выполняет `dbt parse` (если не `dry_run`) и модель
готова к запросу.

---

## 4. Тул `query_semantic_model`

**Назначение.** Выполнить запрос к метрикам ранее созданной задачи (или к
стабильным базовым моделям). Транслируется в `dbt sl query`. Все имена — `enum`.

> Динамический enum: после `create_semantic_model` сервер знает метрики и
> достижимые измерения (включая multi-hop пути присоединённых моделей) и
> **сужает** `enum` запроса под конкретную задачу. Это «контекстная» схема: для
> задачи `lvl_econ` нельзя спросить чужую метрику или недостижимый путь.

### 4.1 JSON Schema (вход)
```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["context_id", "metrics"],
  "properties": {
    "context_id": { "type": "string", "enum": ["« ACTIVE_CONTEXTS »"],
                    "description": "Контекст, в котором созданы модели (id из ответа create_semantic_model). Запрос выполняется в его изолированном dbt-workspace." },
    "task": { "type": "string", "enum": ["« CONTEXT_TASKS »"],
              "description": "Опц.: если в контексте несколько задач — какую запрашивать. Сужает enum метрик/путей." },

    "metrics": {
      "type": "array", "minItems": 1,
      "items": { "type": "string", "enum": ["« CONTEXT_METRICS »"] },
      "description": "Метрики из этого контекста."
    },

    "group_by": {
      "type": "array",
      "description": "Оси группировки. Все имена — из достижимого графа задачи (включая multi-hop ≤2).",
      "items": {
        "oneOf": [
          { "title": "metric_time",
            "type": "object", "additionalProperties": false, "required": ["time"],
            "properties": { "time": { "const": "metric_time" },
                            "grain": { "enum": ["second","minute","hour","day","week","month","quarter","year"], "default": "day" } } },
          { "title": "dimension_path",
            "type": "string", "enum": ["« TASK_GROUPABLE_PATH »"],
            "description": "Измерение task-SM или присоединённой модели: lvl_econ__product_id, user__country, user__campaign__channel (2-hop)." }
        ]
      }
    },

    "where": { "$ref": "#/$defs/predicateGroup",
               "description": "Фильтры; рендерятся в --where через jinja-обёртки." },

    "order_by": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["key"],
        "properties": {
          "key": { "type": "string", "description": "Метрика или элемент group_by (для времени: metric_time__<grain>)." },
          "direction": { "enum": ["asc", "desc"], "default": "asc" }
        }
      }
    },

    "time_range": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "start": { "type": "string", "format": "date", "description": "ISO8601, включительно → --start-time." },
        "end":   { "type": "string", "format": "date", "description": "ISO8601, включительно → --end-time." }
      }
    },

    "limit":   { "type": "integer", "minimum": 1, "maximum": 100000, "default": 1000 },
    "dry_run": { "type": "boolean", "default": false,
                 "description": "true → вернуть только сгенерированный SQL (--compile), без выполнения." }
  },

  "$defs": { "predicate":      { "...": "как в create_semantic_model; fieldRef.path сужен до TASK_GROUPABLE_PATH" },
             "predicateGroup": { "...": "как в create_semantic_model" } }
}
```

### 4.2 Пример вызова и трансляции
**Вход:**
```jsonc
{
  "context_id": "a1b2c3d4e5",
  "metrics": ["lvl_econ__revenue", "lvl_econ__arppu"],
  "group_by": [ { "time": "metric_time", "grain": "day" },
                "user__country", "user__campaign__channel" ],   // 2-hop
  "where": { "op": "and", "conditions": [
    { "field": { "kind": "dimension", "path": "user__acquisition_type" }, "op": "eq", "value": "paid" }
  ]},
  "order_by": [ { "key": "metric_time__day", "direction": "desc" } ],
  "time_range": { "start": "2026-01-01", "end": "2026-03-31" },
  "limit": 100
}
```

**Сгенерированная команда** (в изолированном workspace контекста):
```bash
dbt sl query \
  --project-dir .mcp/ctx/a1b2c3d4e5 \
  --target-path target/ctx/a1b2c3d4e5 \
  --metrics lvl_econ__revenue,lvl_econ__arppu \
  --group-by metric_time__day,user__country,user__campaign__channel \
  --where "{{ Dimension('user__acquisition_type') }} = 'paid'" \
  --order-by -metric_time__day \
  --start-time '2026-01-01' --end-time '2026-03-31' \
  --limit 100
```
При `dry_run: true` добавляется `--compile` и возвращается только SQL.

### 4.3 Выход (единый конверт)
```jsonc
{
  "sql": "…сгенерированный MetricFlow SQL…",
  "command": "dbt sl query --metrics …",
  "columns": [ { "name": "metric_time__day", "type": "date" },
               { "name": "user__country", "type": "string" },
               { "name": "lvl_econ__revenue", "type": "numeric" },
               { "name": "lvl_econ__arppu", "type": "numeric" } ],
  "rows": [ … ],
  "row_count": 87,
  "assumptions": [],
  "warnings": []
}
```

---

## 4a. Тулы изменения и удаления (в рамках контекста)

Все они **обязательно** принимают `context_id` и работают только внутри его
изолированного workspace: перечитывают декларацию контекста, применяют
изменение, ре-рендерят YAML и делают `dbt parse` с персональным `--target-path`.

### `update_semantic_model` — изменить существующий task-SM/метрики
Декларативные правки без переписывания всей задачи. `add_*` добавляет/заменяет
(по имени), `remove_*` удаляет; при удалении measure сервер проверяет, что от него
не зависят метрики (иначе — ошибка со списком зависимых).
```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["context_id", "semantic_model"],
  "properties": {
    "context_id":     { "type": "string", "enum": ["« ACTIVE_CONTEXTS »"] },
    "semantic_model": { "type": "string", "enum": ["« CONTEXT_TASK_SMS »"],
                        "description": "Какой task-SM правим (sm_<task>_<from>)." },
    "set_event_scope":   { "$ref": "create#/$defs/semanticModel/properties/event_scope" },
    "add_dimensions":    { "type": "array", "items": { "$ref": "create#/$defs/semanticModel/properties/dimensions/items" } },
    "remove_dimensions": { "type": "array", "items": { "type": "string", "enum": ["« SM_DIMENSIONS »"] } },
    "add_measures":      { "type": "array", "items": { "$ref": "create#/$defs/semanticModel/properties/measures/items" } },
    "remove_measures":   { "type": "array", "items": { "type": "string", "enum": ["« SM_MEASURES »"] } },
    "add_metrics":       { "type": "array", "items": { "$ref": "create#/$defs/metric" } },
    "remove_metrics":    { "type": "array", "items": { "type": "string", "enum": ["« CONTEXT_METRICS »"] } },
    "dry_run":           { "type": "boolean", "default": false }
  }
}
```
**Выход:** обновлённые `{ context_id, semantic_model, dimensions, measures, metrics, groupable, parse, warnings }`.

### `delete_semantic_model` — удалить один task-SM из контекста
Удаляет указанный task-SM и зависящие от него метрики (с подтверждением через
`cascade`), оставляя остальной контекст нетронутым; ре-parse.
```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["context_id", "semantic_model"],
  "properties": {
    "context_id":     { "type": "string", "enum": ["« ACTIVE_CONTEXTS »"] },
    "semantic_model": { "type": "string", "enum": ["« CONTEXT_TASK_SMS »"] },
    "cascade":        { "type": "boolean", "default": false,
                        "description": "true — удалить и зависящие метрики. Без него при наличии зависимостей вернётся ошибка со списком." }
  }
}
```

### `drop_context` — снести весь контекст
Удаляет workspace целиком: все сгенерированные YAML, артефакты `target/ctx/<id>`,
запись о контексте. Идемпотентен.
```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["context_id"],
  "properties": { "context_id": { "type": "string", "enum": ["« ACTIVE_CONTEXTS »"] } }
}
```

> Все три тула после изменения возвращают результат `dbt parse` и обновлённые
> `enum`-наборы контекста (метрики/пути), чтобы последующие вызовы оставались
> схемно-корректными.

---

## 5. Вспомогательные тулы (grounding и управление)

| Тул | Назначение | Ключевой выход |
|---|---|---|
| `describe_catalog` | Отдать реестр: модели, события, свойства (тип, примеры, кардинальность), атрибуты, граф join (достижимые пути), допустимые agg/типы метрик/гранулярности. Вызывать ПЕРЕД созданием модели. | `models[]`, `event_properties[]`, `groupable_paths[]`, `enums` |
| `list_contexts` | Активные контексты: `context_id`, задачи, возраст, TTL. | `contexts[]` |
| `describe_context` | Содержимое контекста: task-SM, measures, metrics, достижимые пути, путь к YAML/манифесту. | `{ context_id, semantic_models[], metrics[], groupable[] }` |
| `preview_semantic_model` | Сгенерировать YAML без записи (эквивалент `create … dry_run`). | `yaml` |

`describe_catalog` — «карта территории»: его выход питает `enum`'ы и позволяет AI
заполнять декларацию осознанно. Системный промпт обязывает вызвать его перед
первым `create_semantic_model` по новой теме. Управление жизненным циклом
моделей — через `update_semantic_model` / `delete_semantic_model` / `drop_context`
(§4a).

---

## 6. Сквозной сценарий

```
1. describe_catalog()
     → models: events/users/campaigns; props: [revenue:numeric, level:int, …];
       groupable: [user__country, user__campaign__channel, …]

2. create_semantic_model({               // БЕЗ context_id → новая задача
       name:"lvl_econ", use_base_models:["users","campaigns"],
       semantic_models:[{ from:"events", event_scope:{event_name:["purchase"]},
         dimensions:[product_id, level],
         measures:[revenue(sum), payers(cd user_id), purchases(count *)] }],
       metrics:[revenue(simple), arppu(ratio)] })
     → context_id:"a1b2c3d4e5"; пишет YAML в .mcp/ctx/a1b2c3d4e5, dbt parse.

3. query_semantic_model({ context_id:"a1b2c3d4e5",
       metrics:["lvl_econ__revenue","lvl_econ__arppu"],
       group_by:[metric_time/day, user__country, user__campaign__channel],
       where: acquisition_type = paid, time_range: Q1-2026 })
     → dbt sl query в workspace контекста → rows.

4. update_semantic_model({ context_id:"a1b2c3d4e5", semantic_model:"sm_lvl_econ_events",
       add_measures:[{ name:"avg_revenue", agg:"average", field:"revenue" }],
       add_metrics:[{ name:"arppu_paid", type:"simple", measure:{name:"avg_revenue"} }] })
     → re-parse в том же контексте.

5. drop_context("a1b2c3d4e5")             // снести весь изолированный контекст
```

Подход буквально: **AI в изолированном контексте декларирует одну/несколько
«виртуальных» semantic models под задачу (по событиям + присоединённые юзеры/
кампании), dbt пишет SQL, AI выполняет запрос, при необходимости правит модель и
сносит контекст.**

---

## 7. Реализация (blueprint)

1. **Конфиг каталога/реестра** (§2.3) — YAML/JSON рядом с сервером; единственный
   источник физических имён, entities/графа join и правил распаковки JSON.
2. **Генератор enum** — на старте сервер строит производные множества (§2.4),
   включая `GROUPABLE_PATH` обходом графа entity (≤2 hop), и **инъектирует** их в
   JSON-Schema тулов. Контекстно-зависимые наборы (`CONTEXT_METRICS`,
   `CONTEXT_TASK_SMS`, `TASK_GROUPABLE_PATH`, `ACTIVE_CONTEXTS`) пересобираются
   после каждого create/update/delete.
3. **Базовые SM (фикстуры)** — по одному стабильному SM на dbt-модель реестра в
   `models/semantic/_base/` (§2.2): `events`, `users`, `campaigns`, … Деплоятся
   один раз; задают `primary`/`foreign` entities и общий словарь измерений.
4. **Менеджер контекстов** — на `create` без `context_id` генерирует новый id и
   поднимает изолированный workspace:
   - оверлей-проект `.mcp/ctx/<id>/` (симлинк base `models/` + подкаталог
     генерируемых semantic YAML), запуск dbt с `--project-dir` и персональным
     `--target-path target/ctx/<id>`;
   - реестр контекстов в памяти/на диске (`{id, tasks, sms, metrics, ttl}`);
   - TTL/GC и `drop_context` для очистки; неймспейс `ctx_<id>__<task>__…`.
5. **Рендер YAML** — детерминированный шаблонизатор: декларация → semantic models
   + metrics. Распаковка свойств — таблица выражений по `warehouse_dialect`:
   ```
   bigquery:  JSON_VALUE(event_properties, '$.<k>')  [+ CAST под тип]
   postgres:  (event_properties->>'<k>')              [+ ::<type>]
   snowflake: event_properties:<k>::<type>
   ```
6. **Исполнение dbt (per-context)** — обёртки над `dbt parse` и
   `dbt sl query`/`mf query` всегда с `--project-dir`/`--target-path` контекста;
   парсинг вывода в единый конверт; таймауты и `--limit`. Параллельные контексты
   не делят манифест → нет гонок и коллизий имён.
7. **update/delete/drop** — мутируют декларацию контекста, ре-рендерят и делают
   `dbt parse` в его workspace; проверяют зависимости метрик от measures.

---

## 8. Валидация, безопасность, детерминизм

- **Нет неразрешённых имён.** Любая колонка/свойство/событие/атрибут — `enum` из
  каталога; невалидное значение отбраковывается JSON-Schema до генерации YAML.
- **Связность через `if/then`.** Тип агрегации ↔ допустимое поле; тип метрики ↔
  её `type_params`. Нельзя собрать структурно невалидную модель.
- **Структурные фильтры, не строки.** `predicateGroup` рендерится сервером в
  безопасные jinja-обёртки — нет инъекций и «голого» SQL от AI.
- **Read-only.** Семантический слой только читает; DDL/запись отсутствуют.
- **Изоляция по контексту.** Каждый `context_id` — свой workspace
  (`--project-dir`/`--target-path`), свой манифест и неймспейс `ctx_<id>__`.
  Параллельные задачи не конфликтуют по глобально-уникальным именам dbt и не
  делят `semantic_manifest.json`; `drop_context` гарантированно вычищает всё.
- **Неймспейсинг** (`ctx_<id>__<task>__…`) гарантирует глобальную уникальность
  имён dbt и изоляцию задач даже в общем проекте.
- **Безопасные мутации.** `update/delete` проверяют зависимости (нельзя удалить
  measure, на который ссылается метрика, без `cascade`); каждая мутация
  сопровождается `dbt parse` контекста, ошибки парса возвращаются, а не «молча».
- **Детерминизм.** Одна и та же декларация → один и тот же YAML и SQL
  (удобно кэшировать, тестировать снапшотами).
- **Прозрачность.** `dry_run`/`--compile` показывают YAML и SQL до выполнения;
  все неявные решения попадают в `assumptions`.

---

## 9. Связь с существующим дизайном и соседними MCP

- Этот подход **дополняет** структурный аналитический сервер из
  [`analytics-mcp-tools-design.md`](./analytics-mcp-tools-design.md): там SQL
  генерируется детерминированно внутри сервера; здесь — отдаётся MetricFlow, а
  слой остаётся консистентным с остальным dbt-BI.
- Если в окружении уже есть **Cube** MCP — выбрать единый источник истины для
  базовых метрик, чтобы цифры не расходились. dbt Semantic Layer уместен, когда
  метрики уже живут в dbt-проекте и важна консистентность с трансформациями.
