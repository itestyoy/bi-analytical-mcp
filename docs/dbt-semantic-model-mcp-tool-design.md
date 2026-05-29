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
        │  models/semantic/_generated/<task>.yml  ──►  dbt parse  ──►  manifest│
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

---

## 2. Каталог: основа схемы (две dbt-модели)

Каталог — единственное место, где «зашиты» физические имена и выражения. Из
него сервер **проецирует enum'ы в JSON-Schema тула** и **рендерит `expr`** в YAML.

### 2.1 Базовые модели
| Роль | dbt-модель | Зерно | Назначение |
|---|---|---|---|
| События | `ref('fct_analytics_events')` | 1 строка = 1 событие | аналитические события игрока |
| Атрибуты юзера | `ref('dim_users')` | 1 строка = 1 игрок | UA / срез на момент установки |

`dim_users` объявлен **стабильным** semantic model'ом (фикстура сервера) с
`user` как `primary`-entity и всеми атрибутами-измерениями. Поэтому генерируемая
«виртуальная» модель описывает только сторону **событий** (с `user` как
`foreign`), а атрибуты юзера становятся доступны для `group_by`/`where`
**автоматически** через join по `user`. Это убирает дублирование и конфликты имён.

### 2.2 Формат каталога (конфиг сервера)
```jsonc
{
  "events_model": "fct_analytics_events",
  "users_model":  "dim_users",
  "warehouse_dialect": "bigquery",          // как распаковывать JSON в expr

  "event": {                                 // сторона событий
    "user_key":   { "column": "user_id" },
    "session_key":{ "column": "session_id" },
    "time":       { "column": "event_timestamp", "granularity": "second" },
    "event_name": { "column": "event_name" },

    "known_events": [                          // enum значений event_name
      "session_start","session_end","level_start","level_complete",
      "level_fail","purchase","ad_impression","ad_click","tutorial_step","item_acquired"
    ],

    "properties": {                            // ключи JSON event_properties + типы
      "level":      { "type": "int" },
      "score":      { "type": "int" },
      "attempt":    { "type": "int" },
      "moves":      { "type": "int" },
      "revenue":    { "type": "numeric" },
      "currency":   { "type": "string" },
      "result":     { "type": "string", "values": ["win","lose"] },
      "item_id":    { "type": "string" },
      "product_id": { "type": "string" },
      "ad_network": { "type": "string" },
      "step_id":    { "type": "string" }
    }
  },

  "user": {                                    // сторона атрибутов (для group_by/where)
    "key": { "column": "user_id" },
    "attributes": {
      "install_date":    { "type": "time", "granularity": "day" },
      "platform":        { "type": "string" },
      "os_version":      { "type": "string" },
      "device_model":    { "type": "string" },
      "country":         { "type": "string" },
      "region":          { "type": "string" },
      "language":        { "type": "string" },
      "media_source":    { "type": "string" },
      "campaign":        { "type": "string" },
      "ad_group":        { "type": "string" },
      "creative":        { "type": "string" },
      "acquisition_type":{ "type": "string", "values": ["organic","paid"] },
      "app_version":     { "type": "string" }
    }
  }
}
```

### 2.3 Производные перечисления (как сервер строит enum'ы)
Из каталога сервер вычисляет именованные множества, которые подставляются в
`enum` JSON-Schema тулов:

| Имя множества | Из чего собирается | Где используется в схеме |
|---|---|---|
| `EVENT_NAME` | `event.known_events` | `event_filter`, измерение `event_name`, фильтры |
| `EVENT_PROP` | ключи `event.properties` | `field` мер по свойству, измерения по свойству |
| `EVENT_PROP_NUMERIC` | свойства с `type ∈ {int,numeric}` | `field` для `sum/avg/median/percentile` |
| `USER_ATTR` | ключи `user.attributes` | `group_by`, `where`, разбивки |
| `USER_ATTR_CATEGORICAL` | атрибуты с `type ≠ time` | категориальные `group_by`/`where` |
| `DIM_TIME_GRAIN` | из §8 спецификации | грейн time-измерений |
| `AGG` / `METRIC_TYPE` / … | фикс. enum из спецификации | агрегации, типы метрик |

> Каждое значение в этих enum снабжается описанием (тип, пример значений,
> кардинальность из `list_properties`), чтобы у AI был «grounding» прямо в схеме.

---

## 3. Тул `create_semantic_model`

**Назначение.** Декларативно описать виртуальную semantic model по событиям и
набор метрик к ней. Тул материализует YAML, ставит неймспейс, проставляет
`user`/`session` entities и `metric_time` автоматически.

### 3.1 JSON Schema (вход)
> `enum`-списки, помеченные `« {NAME} »`, сервер подставляет из каталога (§2.3).
> Так гарантируется, что **никаких неразрешённых имён** в инструмент не попадёт.

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "measures"],
  "properties": {

    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{2,40}$",
      "description": "Имя задачи/модели. Используется как namespace-префикс для всех имён (модель, measures, metrics), чтобы соблюсти глобальную уникальность dbt."
    },
    "description": { "type": "string" },

    "event_scope": {
      "description": "Опц. ограничение модели классом событий. Транслируется в filter measures/metrics, а не в WHERE по таблице.",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "event_name": {
          "type": "array",
          "items": { "type": "string", "enum": ["« EVENT_NAME »"] },
          "minItems": 1,
          "description": "Одно или несколько имён событий (только из каталога)."
        }
      }
    },

    "dimensions": {
      "description": "Категориальные/временные оси на стороне событий. Атрибуты юзера добавлять НЕ нужно — они доступны автоматически через join по user.",
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["source"],
        "oneOf": [
          {
            "title": "event_column",
            "properties": {
              "source": { "const": "event_column" },
              "column": { "enum": ["event_name", "session_id", "platform_hint"] },
              "label":  { "type": "string" }
            },
            "required": ["source", "column"]
          },
          {
            "title": "event_property",
            "properties": {
              "source":   { "const": "event_property" },
              "property": { "type": "string", "enum": ["« EVENT_PROP »"],
                            "description": "Ключ event_properties; expr рендерится сервером под диалект склада." },
              "as_type":  { "enum": ["categorical", "time"], "default": "categorical" },
              "label":    { "type": "string" }
            },
            "required": ["source", "property"]
          }
        ]
      }
    },

    "measures": {
      "description": "Агрегаты на стороне событий. Имена неймспейсятся префиксом name.",
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "agg"],
        "properties": {
          "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,40}$" },
          "agg":  { "enum": ["count","count_distinct","sum","average","median","min","max","percentile","sum_boolean"],
                    "description": "Тип агрегации (см. спецификацию §5.1)." },

          "field": {
            "description": "ЧТО агрегируем. Зависит от agg.",
            "oneOf": [
              { "title": "events",        "const": "*",
                "description": "Только для agg=count — считаем события." },
              { "title": "unique_users",  "const": "user_id",
                "description": "Для agg=count_distinct — уникальные игроки." },
              { "title": "unique_sessions","const": "session_id",
                "description": "Для agg=count_distinct — уникальные сессии." },
              { "title": "event_property","type": "string", "enum": ["« EVENT_PROP_NUMERIC »"],
                "description": "Числовое свойство события — для sum/average/median/min/max/percentile." }
            ]
          },

          "percentile": {
            "type": "number", "minimum": 0, "exclusiveMaximum": 1,
            "description": "Только для agg=percentile (напр. 0.95)."
          },
          "filter": { "$ref": "#/$defs/predicateGroup",
                      "description": "Доп. условие именно для этой меры." },
          "label":  { "type": "string" }
        },
        "allOf": [
          { "if": { "properties": { "agg": { "const": "percentile" } } },
            "then": { "required": ["percentile"] } },
          { "if": { "properties": { "agg": { "enum": ["sum","average","median","min","max","percentile"] } } },
            "then": { "properties": { "field": { "enum": ["« EVENT_PROP_NUMERIC »"] } } } }
        ]
      }
    },

    "metrics": {
      "description": "Метрики поверх measures. Имена неймспейсятся префиксом name.",
      "type": "array",
      "items": { "$ref": "#/$defs/metric" }
    },

    "dry_run": {
      "type": "boolean", "default": false,
      "description": "true — вернуть сгенерированный YAML без записи и dbt parse."
    }
  },

  "$defs": {

    "fieldRef": {
      "description": "Ссылка на поле для фильтров/группировок — строго из каталога, с квалификацией стороной.",
      "type": "object",
      "additionalProperties": false,
      "required": ["side", "name"],
      "oneOf": [
        { "title": "event_name",
          "properties": { "side": { "const": "event" }, "name": { "const": "event_name" } } },
        { "title": "event_property",
          "properties": { "side": { "const": "event_property" },
                          "name": { "type": "string", "enum": ["« EVENT_PROP »"] } } },
        { "title": "user_attribute",
          "properties": { "side": { "const": "user" },
                          "name": { "type": "string", "enum": ["« USER_ATTR »"] } } },
        { "title": "metric_time",
          "properties": { "side": { "const": "time" }, "name": { "const": "metric_time" },
                          "grain": { "enum": ["« DIM_TIME_GRAIN »"] } } }
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
        "name":   { "type": "string", "description": "Имя measure из этой же декларации (без префикса)." },
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
Для `name: lvl_econ`, диалект BigQuery, декларация ниже:

**Вход (фрагмент):**
```jsonc
{
  "name": "lvl_econ",
  "event_scope": { "event_name": ["purchase"] },
  "dimensions": [
    { "source": "event_property", "property": "product_id" },
    { "source": "event_property", "property": "level", "as_type": "categorical" }
  ],
  "measures": [
    { "name": "revenue",  "agg": "sum",            "field": "revenue" },
    { "name": "payers",   "agg": "count_distinct", "field": "user_id" },
    { "name": "purchases","agg": "count",          "field": "*" }
  ],
  "metrics": [
    { "name": "revenue", "type": "simple", "measure": { "name": "revenue" } },
    { "name": "arppu",   "type": "ratio",
      "numerator": { "name": "revenue" }, "denominator": { "name": "payers" } }
  ]
}
```

**Сгенерированный `models/semantic/_generated/lvl_econ.yml`:**
```yaml
semantic_models:
  - name: sm_lvl_econ
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
| `name` | префикс `sm_<name>` для модели, `<name>__` для measures/metrics |
| `event_scope.event_name` | `filter` на measure/metric: `Dimension('event__event_name') IN (...)` |
| `dimensions[].event_property` | `dimensions[]` c `expr` = распаковка JSON под диалект |
| `measures[].agg/field` | `measures[].agg` + `expr` (для `*`→`"1"`, числового свойства→распаковка) |
| `measures[].percentile` | `agg_params.percentile` |
| `metrics[].*` | `metrics[]` c соответствующими `type_params` (§6 спецификации) |
| фильтры (`predicateGroup`) | jinja-предикаты `filter` |

### 3.3 Выход тула
```jsonc
{
  "semantic_model": "sm_lvl_econ",
  "file": "models/semantic/_generated/lvl_econ.yml",
  "yaml": "…сгенерированный YAML…",
  "metrics":    ["lvl_econ__revenue", "lvl_econ__arppu"],
  "dimensions": ["lvl_econ__product_id", "lvl_econ__level"],
  "groupable":  ["metric_time", "lvl_econ__product_id", "lvl_econ__level",
                 "user__country", "user__platform", "user__media_source", "…"],
  "parse": { "ok": true, "duration_ms": 1840 },   // отсутствует при dry_run
  "assumptions": [
    "primary_entity=event (синтетический PK события)",
    "agg_time_dimension=event_time (event_timestamp, грейн second)",
    "атрибуты user.* доступны для group_by/where через join по entity user"
  ],
  "warnings": []
}
```

После успешного вызова сервер выполняет `dbt parse` (если не `dry_run`) и модель
готова к запросу.

---

## 4. Тул `query_semantic_model`

**Назначение.** Выполнить запрос к ранее созданной (или стабильной) модели.
Транслируется в `dbt sl query`. Все имена — `enum`.

> Динамический enum: после `create_semantic_model` сервер знает метрики и
> измерения этой модели и **сужает** `enum` в схеме запроса под них
> (`metrics`, `group_by`, `where.field`). Это «контекстная» схема: для модели
> `lvl_econ` нельзя спросить чужую метрику.

### 4.1 JSON Schema (вход)
```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["semantic_model", "metrics"],
  "properties": {
    "semantic_model": { "type": "string", "enum": ["« CREATED_MODELS »"],
                        "description": "Имя ранее созданной модели (sm_<name>) или стабильной модели." },

    "metrics": {
      "type": "array", "minItems": 1,
      "items": { "type": "string", "enum": ["« MODEL_METRICS »"] },
      "description": "Метрики этой модели."
    },

    "group_by": {
      "type": "array",
      "items": {
        "oneOf": [
          { "title": "metric_time",
            "type": "object", "additionalProperties": false, "required": ["time"],
            "properties": { "time": { "const": "metric_time" },
                            "grain": { "enum": ["second","minute","hour","day","week","month","quarter","year"], "default": "day" } } },
          { "title": "event_dimension",
            "type": "string", "enum": ["« MODEL_DIMENSIONS »"] },
          { "title": "user_attribute",
            "type": "string", "enum": ["« USER_ATTR_QUALIFIED »"],
            "description": "Атрибут юзера, квалифицированный: user__country, user__platform, …" }
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

  "$defs": { "predicate": { "...": "как в create_semantic_model" },
             "predicateGroup": { "...": "как в create_semantic_model" } }
}
```

### 4.2 Пример вызова и трансляции
**Вход:**
```jsonc
{
  "semantic_model": "sm_lvl_econ",
  "metrics": ["lvl_econ__revenue", "lvl_econ__arppu"],
  "group_by": [ { "time": "metric_time", "grain": "day" }, "user__country" ],
  "where": { "op": "and", "conditions": [
    { "field": { "side": "user", "name": "acquisition_type" }, "op": "eq", "value": "paid" }
  ]},
  "order_by": [ { "key": "metric_time__day", "direction": "desc" } ],
  "time_range": { "start": "2026-01-01", "end": "2026-03-31" },
  "limit": 100
}
```

**Сгенерированная команда:**
```bash
dbt sl query \
  --metrics lvl_econ__revenue,lvl_econ__arppu \
  --group-by metric_time__day,user__country \
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

## 5. Вспомогательные тулы (grounding и управление)

| Тул | Назначение | Ключевой выход |
|---|---|---|
| `describe_catalog` | Отдать каталог: события, свойства (тип, примеры, кардинальность), атрибуты юзера, допустимые agg/типы метрик/гранулярности. Вызывать ПЕРЕД созданием модели. | `events[]`, `event_properties[]`, `user_attributes[]`, `enums` |
| `list_semantic_models` | Перечислить созданные виртуальные модели + их метрики/измерения. | `models[]` |
| `drop_semantic_model` | Удалить файл модели и пересобрать манифест (`dbt parse`). | `{ removed, parse }` |
| `preview_semantic_model` | Сгенерировать YAML без записи (эквивалент `create … dry_run`). | `yaml` |

`describe_catalog` — это «карта территории»: именно его выход питает `enum`'ы и
позволяет AI заполнять декларацию осознанно. Системный промпт обязывает вызвать
его перед первым `create_semantic_model` по новой теме.

---

## 6. Сквозной сценарий

```
1. describe_catalog()
     → events: [purchase, level_complete, …]; props: [revenue:numeric, level:int, …];
       user: [country, media_source, acquisition_type, …]

2. create_semantic_model({ name:"lvl_econ", event_scope:{event_name:["purchase"]},
       dimensions:[product_id, level], measures:[revenue(sum), payers(cd user_id),
       purchases(count *)], metrics:[revenue(simple), arppu(ratio)] })
     → пишет YAML, dbt parse, готово. groupable включает user__country и т.д.

3. query_semantic_model({ semantic_model:"sm_lvl_econ",
       metrics:["lvl_econ__revenue","lvl_econ__arppu"],
       group_by:[metric_time/day, user__country],
       where: acquisition_type = paid, time_range: Q1-2026 })
     → dbt sl query → rows.

4. (опц.) drop_semantic_model("sm_lvl_econ")   // эфемерность виртуальной модели
```

Подход буквально: **AI декларирует «виртуальную» semantic model под конкретную
задачу, dbt пишет SQL, AI выполняет запрос** — и при желании удаляет модель.

---

## 7. Реализация (blueprint)

1. **Конфиг каталога** (§2.2) — YAML/JSON рядом с сервером; единственный
   источник физических имён и правил распаковки JSON по диалекту.
2. **Генератор enum** — на старте сервера строит производные множества (§2.3) и
   **инъектирует** их в JSON-Schema тулов. Запросная схема пересобирается после
   каждого `create_semantic_model` (контекстные `MODEL_METRICS` и т.д.).
3. **Рендер YAML** — детерминированный шаблонизатор: декларация → semantic model
   + metrics. Распаковка свойств — таблица выражений по `warehouse_dialect`:
   ```
   bigquery:  JSON_VALUE(event_properties, '$.<k>')  [+ CAST под тип]
   postgres:  (event_properties->>'<k>')              [+ ::<type>]
   snowflake: event_properties:<k>::<type>
   ```
4. **Стабильная users-модель** — фикстура `models/semantic/_users.yml`
   (`user` primary + все атрибуты-измерения) деплоится один раз; виртуальные
   модели только ссылаются на entity `user`.
5. **Исполнение dbt** — обёртки над `dbt parse` и `dbt sl query`/`mf query`;
   парсинг табличного/JSON-вывода в единый конверт; таймауты и `--limit`.
6. **Изоляция файлов** — генерируемые модели в `models/semantic/_generated/`,
   удаляются `drop_semantic_model`; имена с префиксом `sm_`/`<task>__`.

---

## 8. Валидация, безопасность, детерминизм

- **Нет неразрешённых имён.** Любая колонка/свойство/событие/атрибут — `enum` из
  каталога; невалидное значение отбраковывается JSON-Schema до генерации YAML.
- **Связность через `if/then`.** Тип агрегации ↔ допустимое поле; тип метрики ↔
  её `type_params`. Нельзя собрать структурно невалидную модель.
- **Структурные фильтры, не строки.** `predicateGroup` рендерится сервером в
  безопасные jinja-обёртки — нет инъекций и «голого» SQL от AI.
- **Read-only.** Семантический слой только читает; DDL/запись отсутствуют.
- **Неймспейсинг** гарантирует глобальную уникальность имён dbt и изоляцию задач.
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
