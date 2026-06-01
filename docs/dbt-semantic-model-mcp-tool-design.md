# MCP-тул: декларативное создание dbt semantic model «на лету» + запрос

> Дизайн тулов, реализующих подход **«AI декларирует — dbt пишет SQL»**.
> AI не генерирует SQL и не угадывает имена колонок. Он заполняет
> **полностью схематизированный** объект: каждое поле, где ожидается колонка или
> свойство, — это `enum` из реального каталога двух базовых dbt-моделей. Тул
> материализует это в корректный YAML semantic model + metrics, выполняет
> `dbt parse` и затем `mf query` (dbt Core).
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
        │      │  рендер `mf query ...` (dbt Core)  ──►  выполнение  ──►  rows  │
        └──────┴──────────────────────────────────────────────────────────────┘
```

> **Движок исполнения — dbt Core + `mf query`** (`pip install dbt-metricflow`),
> НЕ `dbt sl query`. Причина: `dbt sl query` исполняется удалённо в dbt platform
> и **несовместим** с локальной пер-контекстной изоляцией (`--project-dir`/
> `--target-path`), на которой построен дизайн. Сервер несёт `dbt-metricflow` +
> адаптер склада и владеет профилем/кредами. Вариант на dbt platform — отдельный,
> без файловой изоляции (см. §10), вне основного hot-path.

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
> **Прунинг (m3):** при построении enum пути с «висящим» `foreign` (нет
> соответствующего `primary`/`unique` в реестре) **исключаются** — чтобы AI не
> получил путь, который пройдёт схему, но упадёт на запросе.

---

## 3. Архитектура нескольких semantic models под задачу

Из спецификации §3.3: **один semantic model = одна dbt-модель**, а join'ы между
ними MetricFlow строит сам по `entities`.

> **Важный инвариант (по итогам аудита, C3):** в пределах одного контекста для
> каждой dbt-модели существует **ровно один** semantic model. Мы **не** создаём
> второй («task») SM поверх той же таблицы — это давало бы дублирующие join-узлы
> одного грейна и неоднозначные пути в графе entity. Вместо этого task-специфичные
> measures/dimensions **домешиваются в единственный SM этой таблицы** внутри
> контекста.

**Модель работы (две роли, но одна SM на таблицу в контексте):**

| Роль | Что это |
|---|---|
| **Шаблон SM (base template)** | по одному на dbt-модель реестра (`events`, `users`, `campaigns`…): entities, словарь измерений, базовые measures. Хранится в каталоге как шаблон. |
| **SM контекста** | материализованная в overlay-проекте контекста копия шаблона **+** домешанные task-measures/dimensions. На каждую вовлечённую таблицу — одна такая SM. |

**Как тул задействует несколько dbt-моделей:**
1. **Подключить** модели реестра — `use_base_models: ["users","campaigns"]`:
   их SM-шаблоны материализуются в контексте, измерения сразу доступны для
   `group_by`/`where` через join по entity (`user__country`,
   `user__campaign__channel`). Переобъявлять ничего не нужно.
2. **Дополнить** SM нужной таблицы task-объектами — `semantic_models[]` с `from`
   (таблица из реестра): сервер **домешивает** measures/dimensions в единственную
   SM этой таблицы (merge), а не создаёт дубль. Если у таблицы ещё нет шаблона —
   создаётся новая SM (единственная для неё).
3. **Метрики** (`metrics[]`) ссылаются на measures любых вовлечённых SM; join
   разруливается автоматически. Несколько fct-таблиц → full-outer по общим entity.

> Итог: «виртуальная модель под задачу» = набор SM (по одной на таблицу) в
> изолированном контексте, где SM нужной таблицы расширена task-measures/metrics.
> Это и есть «несколько semantic models под задачу» — но без дублей над одной
> таблицей.

**Time spine (по итогам аудита, C2).** `metric_time`, грейны, `cumulative` и
`conversion` требуют **материализованного** time spine (спецификация §1.4). Он —
часть **базового** dbt-проекта и строится один раз `dbt run --select
metricflow_time_spine` (не `dbt parse`, не на лету). Контекст наследует его из
базового проекта/склада. Если запрошен `metric_time`/cumulative/conversion, а
spine не сконфигурирован — тул возвращает понятную ошибку, а не падение dbt.

### Контексты выполнения и изоляция (`context_id`)

Всё создание/обновление/запрос виртуальных моделей идёт **внутри контекста** —
изолированного рабочего пространства. Это исключает: коллизии глобально-уникальных
имён dbt (measures/metrics), смешивание `semantic_manifest.json` между
параллельными задачами и гонки при `dbt parse`/`mf query`.

**Что изолирует контекст:**
| Ресурс | Изоляция |
|---|---|
| Overlay-проект | свой `--project-dir .mcp/ctx/<context_id>/` |
| Файлы YAML | сгенерированные SM/metrics в overlay |
| Артефакты dbt | свой `--target-path target/ctx/<context_id>` (свой `semantic_manifest.json`) |
| Имена объектов | неймспейс `<task>__…` (в изолированном режиме префикс `ctx_<id>__` **не нужен** — см. ниже, m1) |
| Видимость | контекст видит только свои SM (по одной на таблицу) + общий time spine |

**Поток `context_id` (правило для AI):**
```
create_semantic_model({ ... })                  // БЕЗ context_id
   → сервер аллоцирует НОВЫЙ context_id, поднимает workspace, возвращает его
create_semantic_model({ context_id, ... })      // С context_id из прошлого ответа
   → добавляет/домешивает SM/метрики в ТОТ ЖЕ контекст
query/update/delete_*({ context_id, ... })       // всегда в рамках контекста
```
- **Та же задача / продолжение** → AI передаёт `context_id` из предыдущего ответа.
- **Новая задача** → `context_id` не передаётся, создаётся свежий контекст.

**Реализация overlay-проекта (точно, по итогам аудита M2).** Лёгкий, но
**самодостаточный** dbt-проект на контекст. В него нужно положить (симлинк/копия):
- `dbt_project.yml` (с корректными `model-paths`, относительными к нему);
- **SQL базовых моделей** (`fct_analytics_events`, `dim_users`, … — не только
  semantic YAML, иначе `ref()` не разрешится) **и** модель/seed **time spine**;
- `dbt_packages/` (или прогон `dbt deps`), если база использует пакеты
  (`dbt_utils`, календарь и т.п.);
- собственный подкаталог сгенерированных semantic/metrics YAML контекста.
Запуск dbt всегда с `--project-dir`, персональным `--target-path` и
`--profiles-dir` (креды склада). Базовые таблицы и time spine **уже
материализованы** в складе — overlay только парсит семантику и шлёт запросы.
Перед объявлением «parallel-safe» — сквозной smoke-тест (`dbt parse` +
`mf validate-configs` + пробный `mf query --explain`).

**Режимы и неймспейс (m1).**
- *Изолированный режим (рекомендуемый):* у каждого контекста свой манифест →
  имена должны быть уникальны лишь **внутри** контекста; префикс `ctx_<id>__`
  избыточен — оставляем только человекочитаемый `<task>__`.
- *Общий проект (запасной):* один `models/` на всех; тогда нужны и `ctx_<id>__`
  префикс, и **файловые локи** на `dbt parse`/`target` (иначе параллельные
  парсы гонятся по общему состоянию).

**Жизненный цикл, состояние, конкурентность (M4).**
- **Персистентный реестр** контекстов (sqlite/JSON под проектом), а не только
  in-memory: при рестарте (в т.ч. в эфемерном контейнере) — **реконсиляция** с
  тем, что реально лежит на диске (`target/ctx/*`, `.mcp/ctx/*`); «осиротевшие»
  id чистятся, валидные восстанавливаются. Enum `ACTIVE_CONTEXTS` строится из
  реестра после реконсиляции.
- **Лизы/рефкаунт:** TTL/GC и `drop_context` **не сносят** workspace, пока есть
  in-flight `mf query` по этому контексту — берётся лиза на время запроса, GC
  ждёт/отменяет subprocess, и только потом `rm -rf`.
- **Эфемерный контейнер:** контексты переживают рестарт по диску; долговременное
  хранение — только то, что закоммичено (генерируемые YAML по запросу можно
  отдать пользователю/закоммитить, но по умолчанию они эфемерны).
- `list_contexts`/`describe_context` показывают активные контексты и их возраст/TTL.

## 3a. Тул `create_semantic_model`

**Назначение.** Декларативно описать SM нужных таблиц (по одной на таблицу) и
метрики к ним. Тул материализует/домешивает YAML в overlay контекста, проставляет
`primary_entity`, `foreign`-ключи и `metric_time` из реестра, неймспейсит имена и
делает `dbt parse` в workspace контекста (time spine — уже в базовом проекте).

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
      "description": "Имя задачи. Namespace-префикс <name>__ для generируемых measures/metrics внутри контекста. В изолированном режиме этого достаточно для уникальности (отдельный манифест на контекст)."
    },
    "description": { "type": "string" },

    "use_base_models": {
      "type": "array",
      "items": { "type": "string", "enum": ["« MODEL_KEY »"] },
      "description": "Базовые dbt-модели, чьи измерения/measures сделать доступными через автоджойн (без переобъявления). Напр. ['users','campaigns']."
    },

    "semantic_models": {
      "type": "array",
      "description": "Task-объекты (measures/dimensions), домешиваемые в SM соответствующих таблиц (по одному элементу на таблицу — НЕ создаёт дубль SM над одной таблицей, C3). Обычно один элемент — по событиям.",
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
                "description": "Только для from=events: КАТЕГОРИАЛЬНОЕ измерение из JSON event_properties (expr рендерит сервер под диалект). as_type=time запрещён (m2): ось времени берётся из физической event_timestamp/metric_time, JSON-извлечённое время ломает partition pruning и не годится как agg_time_dimension.",
                "properties": {
                  "source":   { "const": "event_property" },
                  "property": { "type": "string", "enum": ["« EVENT_PROP »"] },
                  "as_type":  { "const": "categorical", "default": "categorical" },
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

**Сгенерированный `.mcp/ctx/a1b2c3d4e5/models/events.yml`** — это **единственная**
SM таблицы событий в контексте (шаблон `events` + домешанные task-объекты), а не
параллельный дубль (C3):
```yaml
semantic_models:
  - name: events                                  # одна SM на таблицу в контексте
    description: "events SM (base template + task lvl_econ)"
    model: ref('fct_analytics_events')
    defaults:
      agg_time_dimension: event_time
    primary_entity: event
    entities:
      - { name: user,    type: foreign, expr: user_id }
      - { name: session, type: foreign, expr: session_id }
    dimensions:
      - name: event_time                          # из шаблона; грейн day (см. spine)
        type: time
        type_params: { time_granularity: day }
        expr: event_timestamp
      # ── домешано задачей lvl_econ ──
      - name: lvl_econ__product_id
        type: categorical
        expr: "JSON_VALUE(event_properties, '$.product_id')"
      - name: lvl_econ__level
        type: categorical
        expr: "CAST(JSON_VALUE(event_properties, '$.level') AS INT64)"
    measures:
      # ── домешано задачей lvl_econ; event_scope ВПЕЧАТАН в expr каждого measure (M3) ──
      - name: lvl_econ__revenue
        agg: sum
        expr: "CASE WHEN event_name = 'purchase' THEN CAST(JSON_VALUE(event_properties, '$.revenue') AS NUMERIC) END"
        agg_time_dimension: event_time
      - name: lvl_econ__payers
        agg: count_distinct
        expr: "CASE WHEN event_name = 'purchase' THEN user_id END"
        agg_time_dimension: event_time
      - name: lvl_econ__purchases
        agg: sum
        expr: "CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END"
        agg_time_dimension: event_time

metrics:
  - name: lvl_econ__revenue                        # simple над scoped measure
    type: simple
    type_params: { measure: { name: lvl_econ__revenue } }
  - name: lvl_econ__payers                         # авто-обёртка для ratio
    type: simple
    type_params: { measure: { name: lvl_econ__payers } }
  - name: lvl_econ__arppu                          # ratio ссылается на МЕТРИКИ, не measures
    type: ratio
    type_params:
      numerator:   { name: lvl_econ__revenue }
      denominator: { name: lvl_econ__payers }
```
> Почему так: (1) **C3** — одна SM на таблицу; (2) **M3** — `event_scope` впечатан
> в `expr` каждого measure (`CASE WHEN …`), поэтому мера не «протекает» на другие
> классы событий независимо от метрики; (3) **ratio** в dbt ссылается на
> **метрики**, поэтому сервер авто-создаёт `simple`-обёртки для measures,
> используемых в numerator/denominator.

Маппинг по полям:

| Поле декларации | Куда идёт в YAML |
|---|---|
| `name` | префикс `<name>__` для measures/metrics (одна SM на таблицу не префиксуется) |
| `use_base_models` | не пишет YAML — материализует SM-шаблоны нужных таблиц (граф join) |
| `semantic_models[].from` | выбирает/создаёт **единственную** SM этой таблицы (merge, не дубль) |
| `semantic_models[].event_scope` | впечатывается в `expr` **каждого** measure через `CASE WHEN` (M3) |
| `semantic_models[].dimensions[].event_property` | `dimensions[]` c `expr` = распаковка JSON под диалект |
| `semantic_models[].measures[].agg/field` | `measures[].agg` + `expr`; `field=*`→`CASE WHEN <scope> THEN 1 ELSE 0 END` (agg sum), числовое свойство→`CASE WHEN <scope> THEN CAST(JSON…) END` |
| `semantic_models[].measures[].filter` | сворачивается в `expr` (`CASE WHEN …`), т.к. dbt measures не имеют `filter` |
| `…measures[].percentile` | `agg_params.percentile` |
| `metrics[] simple/cumulative/conversion` | `metrics[]` c `type_params` (§6 спецификации) |
| `metrics[] ratio` | numerator/denominator → **метрики**; сервер авто-создаёт `simple`-обёртки для упомянутых measures |
| фильтры запроса (`predicateGroup`/`fieldRef`) | jinja-предикаты в `--where` (§4a.1 — таблица операторов) |

### 3.3 Выход тула
```jsonc
{
  "context_id": "a1b2c3d4e5",                          // ВЕРНУТЬ и переиспользовать для той же задачи
  "task": "lvl_econ",
  "files": [".mcp/ctx/a1b2c3d4e5/models/events.yml"],  // по одной SM на таблицу
  "yaml": "…сгенерированный YAML…",
  "semantic_models": ["events"],                       // единственная SM таблицы (augmented)
  "joined_models": ["users", "campaigns"],             // доступны через автоджойн
  "metrics":    ["lvl_econ__revenue", "lvl_econ__payers", "lvl_econ__arppu"],
  "groupable":  ["metric_time", "lvl_econ__product_id", "lvl_econ__level",
                 "user__country", "user__platform", "user__media_source",
                 "user__campaign__channel"],           // 2-hop через campaigns
  "parse": { "ok": true, "duration_ms": 1840 },        // или { ok:false, error:{stage,message,field} }
  "assumptions": [
    "primary_entity=event (синтетический PK события)",
    "agg_time_dimension=event_time (event_timestamp, грейн day; sub-daily нужен sub-daily time spine)",
    "event_scope=purchase впечатан в expr всех measures (M3)",
    "ratio arppu: авто-созданы simple-метрики lvl_econ__revenue/__payers",
    "user.* через join events.user→users.user; user__campaign__* — 2-hop через campaigns"
  ],
  "warnings": []
}
```

После успешного вызова сервер выполняет `dbt parse` (если не `dry_run`) **в
workspace контекста** (time spine уже материализован в базовом проекте) — модель
готова к запросу. При ошибке парса возвращается структурный
`error: { stage:"parse", message, offending_field }`, а не «молчаливый» сбой.

---

## 4. Тул `query_semantic_model`

**Назначение.** Выполнить запрос к метрикам ранее созданной задачи (или к
стабильным базовым моделям). Транслируется в **`mf query`** (dbt Core) в
workspace контекста. Все имена — `enum`.

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
    "offset":  { "type": "integer", "minimum": 0, "default": 0,
                 "description": "Постраничность: сервер режет результат на страницы и возвращает cursor (большой результат не должен раздувать MCP-ответ)." },
    "max_bytes_scanned": { "type": "integer",
                 "description": "Опц. кост-гард: предел сканируемых байт склада (BigQuery dry-run estimate перед выполнением)." },
    "dry_run": { "type": "boolean", "default": false,
                 "description": "true → вернуть только сгенерированный SQL (mf --explain) + оценку стоимости, без выполнения." }
  },

  "$defs": { "predicate":      { "...": "как в create_semantic_model; fieldRef.path сужен до TASK_GROUPABLE_PATH" },
             "predicateGroup": { "...": "как в create_semantic_model" } }
}
```

**Рендеринг операторов `predicate.op` → `--where` (m4).** Сервер детерминированно
разворачивает структурный предикат в jinja+SQL (нет «голого» SQL от AI):

| `op` | Рендер (для `Dimension('user__country')`) |
|---|---|
| `eq`/`neq` | `{{ Dimension('user__country') }} = 'US'` / `!=` |
| `gt`/`gte`/`lt`/`lte` | `… > 5` и т.п. |
| `in`/`not_in` | `… IN ('US','GB')` / `NOT IN (...)` |
| `between` | `… BETWEEN 1 AND 10` |
| `is_null`/`is_not_null` | `… IS NULL` / `IS NOT NULL` |
| time-поле | `{{ TimeDimension('metric_time','day') }} >= '2026-01-01'` |

> На каждый оператор — снапшот-тест рендера. `order_by.key` сервер
> **канонизирует** из элементов `group_by`/`metrics` (для времени —
> `metric_time__<grain>`), чтобы AI не собирал строку грейна вручную (m5).

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

**Сгенерированная команда** (`mf query` в изолированном workspace контекста):
```bash
mf query \
  --project-dir .mcp/ctx/a1b2c3d4e5 \
  --target-path target/ctx/a1b2c3d4e5 \
  --profiles-dir <profiles_dir> \
  --metrics lvl_econ__revenue,lvl_econ__arppu \
  --group-by metric_time__day,user__country,user__campaign__channel \
  --where "{{ Dimension('user__acquisition_type') }} = 'paid'" \
  --order-by -metric_time__day \
  --start-time '2026-01-01' --end-time '2026-03-31' \
  --limit 100
```
При `dry_run: true` добавляется `--explain` и возвращается только SQL (без
выполнения в складе).

### 4.3 Выход (единый конверт)
```jsonc
{
  "ok": true,                                  // false → см. error
  "sql": "…сгенерированный MetricFlow SQL…",
  "command": "mf query --metrics …",
  "columns": [ { "name": "metric_time__day", "type": "date" },
               { "name": "user__country", "type": "string" },
               { "name": "lvl_econ__revenue", "type": "numeric" },
               { "name": "lvl_econ__arppu", "type": "numeric" } ],
  "rows": [ … ],
  "row_count": 87,
  "page": { "limit": 100, "offset": 0, "has_more": false, "cursor": null },  // пагинация (M5)
  "cost": { "estimated_bytes_scanned": 1240000000 },                         // кост-гард (M5)
  "assumptions": [],
  "warnings": [],
  "error": null   // при ok:false: { stage:"parse"|"validate"|"query", message, offending_field }
}
```
> **M5 (надёжность):** перед выполнением сервер (1) валидирует сгенерированный
> YAML JSON-схемой и `mf validate-configs`; (2) на `dry_run`/BigQuery делает
> dry-run оценку стоимости; (3) ошибки `dbt parse`/`mf` парсит в структурный
> `error{stage,message,offending_field}`; (4) пагинирует результат (`limit`+
> `offset`+`cursor`) и/или режет по размеру ответа с флагом усечения.

---

## 4a. Тулы изменения и удаления (в рамках контекста)

Все они **обязательно** принимают `context_id` и работают только внутри его
изолированного workspace: перечитывают декларацию контекста, применяют
изменение, ре-рендерят YAML и делают `dbt parse` с персональным `--target-path`.

### `update_semantic_model` — изменить SM таблицы / метрики в контексте
Декларативные правки без переписывания всей задачи. `add_*` добавляет/заменяет
(по имени) **task-объекты** в SM соответствующей таблицы, `remove_*` удаляет; при
удалении measure сервер проверяет, что от него не зависят метрики (иначе — ошибка
со списком зависимых). Базовые (шаблонные) measures/dimensions не трогаются.
```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["context_id", "semantic_model"],
  "properties": {
    "context_id":     { "type": "string", "enum": ["« ACTIVE_CONTEXTS »"] },
    "semantic_model": { "type": "string", "enum": ["« CONTEXT_SMS »"],
                        "description": "SM таблицы в контексте (одна на таблицу: events/users/…)." },
    "set_event_scope":   { "$ref": "create#/$defs/semanticModel/properties/event_scope" },
    "add_dimensions":    { "type": "array", "items": { "$ref": "create#/$defs/semanticModel/properties/dimensions/items" } },
    "remove_dimensions": { "type": "array", "items": { "type": "string", "enum": ["« TASK_DIMENSIONS »"] } },
    "add_measures":      { "type": "array", "items": { "$ref": "create#/$defs/semanticModel/properties/measures/items" } },
    "remove_measures":   { "type": "array", "items": { "type": "string", "enum": ["« TASK_MEASURES »"] } },
    "add_metrics":       { "type": "array", "items": { "$ref": "create#/$defs/metric" } },
    "remove_metrics":    { "type": "array", "items": { "type": "string", "enum": ["« CONTEXT_METRICS »"] } },
    "dry_run":           { "type": "boolean", "default": false }
  }
}
```
**Выход:** обновлённые `{ context_id, semantic_model, dimensions, measures, metrics, groupable, parse, warnings }`.

### `delete_semantic_model` — убрать task-объекты SM таблицы (или метрику)
Удаляет task-добавленные measures/dimensions/metrics для SM указанной таблицы (с
`cascade` для зависимых метрик), оставляя шаблон таблицы и остальной контекст
нетронутыми; ре-parse. Полный снос контекста — `drop_context`.
```jsonc
{
  "type": "object", "additionalProperties": false,
  "required": ["context_id", "semantic_model"],
  "properties": {
    "context_id":     { "type": "string", "enum": ["« ACTIVE_CONTEXTS »"] },
    "semantic_model": { "type": "string", "enum": ["« CONTEXT_SMS »"] },
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
     → mf query в workspace контекста → rows.

4. update_semantic_model({ context_id:"a1b2c3d4e5", semantic_model:"events",
       add_measures:[{ name:"avg_revenue", agg:"average", field:"revenue" }],
       add_metrics:[{ name:"avg_rev_metric", type:"simple", measure:{name:"avg_revenue"} }] })
     → домешивает в SM таблицы events, re-parse в том же контексте.

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
   `CONTEXT_SMS`, `TASK_GROUPABLE_PATH`, `ACTIVE_CONTEXTS`) пересобираются
   после каждого create/update/delete.
3. **Базовый dbt-проект** — общий, материализуется один раз: SQL базовых моделей
   (`fct_analytics_events`, `dim_users`, `dim_campaigns`), **time spine**
   (`dbt run --select metricflow_time_spine`, C2) и SM-шаблоны (по одному на
   таблицу). Это фундамент, который наследуют контексты.
4. **Менеджер контекстов** — на `create` без `context_id` генерирует новый id и
   поднимает **самодостаточный** overlay-проект (M2):
   - `.mcp/ctx/<id>/` с `dbt_project.yml`, симлинком/копией SQL базовых моделей и
     time spine, `dbt_packages/` (или `dbt deps`), подкаталогом генерируемых
     semantic/metrics YAML; запуск dbt с `--project-dir`, `--target-path
     target/ctx/<id>`, `--profiles-dir`;
   - **персистентный** реестр контекстов (sqlite/JSON), реконсилируемый с диском
     на старте (M4); лизы на in-flight запросы; TTL/GC и `drop_context`;
   - одна SM на таблицу в контексте (C3), неймспейс `<task>__` (в изолированном
     режиме без `ctx_` — m1).
5. **Рендер YAML** — детерминированный шаблонизатор: декларация → одна SM на
   таблицу (+ авто-`simple`-обёртки для ratio) + metrics. `event_scope` и
   measure-фильтры **впечатываются в `expr`** через `CASE WHEN` (M3). Распаковка
   свойств — по `warehouse_dialect`:
   ```
   bigquery:  JSON_VALUE(event_properties, '$.<k>')  [+ CAST под тип]
   postgres:  (event_properties->>'<k>')              [+ ::<type>]
   snowflake: event_properties:<k>::<type>
   ```
6. **Исполнение dbt (per-context)** — обёртки над `dbt parse` + `mf validate-configs`
   + `mf query` (НЕ `dbt sl query`, C1) всегда с `--project-dir`/`--target-path`/
   `--profiles-dir` контекста; структурный разбор ошибок и вывода в единый
   конверт; таймауты, `--limit`/`offset`, кост-гард. Параллельные контексты не
   делят манифест → нет гонок.
7. **update/delete/drop** — мутируют декларацию контекста, ре-рендерят и делают
   `dbt parse` в его workspace; проверяют зависимости метрик от measures.
8. **Версии (M1)** — зафиксировать матрицу `dbt-core` + adapter +
   `dbt-metricflow`, на которой проверена генерация legacy-YAML; CI-снапшот:
   round-trip генерируемого YAML через `dbt parse` + `mf validate-configs` +
   пробный `mf query --explain` на пиннутой версии.

---

## 8. Валидация, безопасность, детерминизм

- **Нет неразрешённых имён.** Любая колонка/свойство/событие/атрибут — `enum` из
  каталога; невалидное значение отбраковывается JSON-Schema до генерации YAML.
- **Связность через `if/then`.** Тип агрегации ↔ допустимое поле; тип метрики ↔
  её `type_params`. Нельзя собрать структурно невалидную модель.
- **Структурные фильтры, не строки.** `predicateGroup` рендерится сервером в
  безопасные jinja-обёртки — нет инъекций и «голого» SQL от AI.
- **Read-only.** Семантический слой только читает; DDL/запись отсутствуют.
- **Изоляция по контексту.** Каждый `context_id` — свой overlay-проект и
  `--target-path`, свой манифест. Параллельные задачи не делят
  `semantic_manifest.json` и не конфликтуют по именам; `drop_context` (с лизами,
  M4) гарантированно вычищает всё. В изолированном режиме `ctx_`-префикс не нужен
  (m1); он требуется только в запасном общем-проектном режиме (+ локи на parse).
- **Одна SM на таблицу в контексте (C3).** Нет дублирующих SM над одной таблицей
  → нет неоднозначных join-путей.
- **Корректность скоупа (M3).** `event_scope`/measure-фильтры впечатаны в `expr`
  каждого measure — мера не «протекает» на другие классы событий.
- **Time spine — предусловие (C2).** `metric_time`/cumulative/conversion требуют
  материализованного spine из базового проекта; при его отсутствии — понятная
  ошибка, не падение dbt.
- **Движок — `mf` (dbt Core), не `dbt sl query` (C1)** — единственный совместимый
  с файловой изоляцией.
- **Безопасные мутации.** `update/delete` проверяют зависимости (нельзя удалить
  measure, на который ссылается метрика, без `cascade`); каждая мутация — с
  `dbt parse` контекста; ошибки возвращаются структурно, а не «молча».
- **Надёжность (M5).** Pre-parse JSON-Schema + `mf validate-configs`; структурный
  `error{stage,message,field}`; пагинация и кост-гард на запросах.
- **Версии (M1).** Пиннутая матрица dbt + adapter + metricflow; CI-снапшот
  round-trip генерируемого legacy-YAML.
- **Детерминизм.** Одна и та же декларация → один и тот же YAML и SQL.
- **Прозрачность.** `dry_run`/`--explain` показывают YAML и SQL до выполнения;
  все неявные решения — в `assumptions`.
- **Граница доверия — каталог.** Единственное место free-text→SQL — это
  `expr`-шаблоны каталога (контролируются разработчиком) и `derived.expr`
  (формула над **именованными** метриками) — последний валидируется грамматикой
  числовых выражений.

---

## 9. Связь с существующим дизайном и соседними MCP

- Этот подход **дополняет** структурный аналитический сервер из
  [`analytics-mcp-tools-design.md`](./analytics-mcp-tools-design.md): там SQL
  генерируется детерминированно внутри сервера; здесь — отдаётся MetricFlow, а
  слой остаётся консистентным с остальным dbt-BI.
- Если в окружении уже есть **Cube** MCP — выбрать единый источник истины для
  базовых метрик, чтобы цифры не расходились. dbt Semantic Layer уместен, когда
  метрики уже живут в dbt-проекте и важна консистентность с трансформациями.

---

## 10. Альтернатива на dbt platform (без файловой изоляции)

Основной дизайн — **dbt Core + `mf`** с пер-контекстными overlay-проектами. Если
требуется именно **dbt platform** (`dbt sl query`, GraphQL/JDBC API), модель
изоляции меняется принципиально (C1):

- `dbt sl query` исполняется **удалённо** против одного развёрнутого окружения и
  **не видит** локальные overlay/`--target-path`. Файловая изоляция невозможна.
- Изоляция «на лету» тогда требует либо отдельного **развёрнутого окружения/ветки
  на контекст** (тяжело, медленно), либо отказа от пер-контекстных виртуальных
  моделей в пользу заранее задеплоенных метрик + только запросов.
- Реалистичный гибрид: **создание/итерация** виртуальных моделей — локально на
  dbt Core (`mf`), а **продакшн-запросы** консистентных, «устоявшихся» метрик —
  через dbt platform API после деплоя. Это держит «черновую» генерацию изолированной,
  а стабильные метрики — в общем семантическом слое.

Выбор фиксируется в конфиге сервера; hot-path по умолчанию — dbt Core.

---

## 11. Программный доступ к запросам (execution backends)

Запрос можно исполнять не только через CLI. Все бэкенды реализуют один контракт
`{ parse(projectDir), query(projectDir, opts) }`, поэтому взаимозаменяемы
(`Engine` принимает любой `runner`).

| Backend | Как работает | Когда |
|---|---|---|
| **`mf` CLI** (`src/dbt-runner.js`, по умолчанию) | shell `mf query`/`--explain`, парсинг CSV/SQL | просто, надёжно; минус — холодный старт Python (~2с) на запрос |
| **MetricFlow sidecar** (`python/mf_sidecar.py` + `src/backends/mf-engine.js`) | **тёплый** Python-процесс с `MetricFlowEngine` (та же связка, что у `mf` CLI: `CLIConfiguration → MetricFlowEngine.query()/explain()`), общение по stdio JSON | **программный** локальный доступ для dbt Core: без холодного старта, структурированные результаты (`column_names`/`rows`) и `explain` SQL |
| **dbt platform SL** (dbtsl / GraphQL / JDBC) | как в dbt-mcp `client.py`: `SyncSemanticLayerClient` к **хостинговому** SL (host + token + environment_id), Arrow Flight | только dbt Cloud/platform (§10), без файловой изоляции; для JS — напрямую через GraphQL/JDBC (официального JS SDK нет) |

**Вывод по вопросу «можно ли программно».**
- Для **локального dbt Core** программный доступ — это **`MetricFlowEngine`**
  (Python). У него те же методы, что в `mf` CLI: `query`, `explain`,
  `list_metrics`, `simple_dimensions_for_metrics`. Из JS он недоступен напрямую
  (это Python), поэтому используем **тёплый sidecar** — он сохраняет нашу
  пер-контекстную файловую изоляцию (работает в `--project-dir` контекста) и
  убирает накладные расходы CLI. Реализовано и покрыто интеграционным тестом
  (даёт идентичный результат запросу через `mf`).
- `dbtsl`-подход из dbt-mcp `client.py` — это **хостинговый** SL платформы
  (Cloud), не локальный dbt Core; он уместен только в platform-режиме (§10).

`parse` во всех локальных бэкендах остаётся через `dbt parse` (пишет
`semantic_manifest.json`, который читает движок).
