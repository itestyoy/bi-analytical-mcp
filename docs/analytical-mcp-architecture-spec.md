# Analytical MCP — Архитектура и техническое задание

> **Статус:** Draft v1.0 (build spec). **Аудитория:** разработчики MCP-сервера.
> **Назначение:** единое нормативное ТЗ на реализацию ad-hoc аналитического
> MCP-сервера для игровой event-аналитики. Описывает архитектуру, контракты,
> параметры, их семантику и поведение с точностью, достаточной для разработки.

Сопутствующие документы:
- [`analytics-mcp-tools-design.md`](./analytics-mcp-tools-design.md) — продуктовый
  дизайн, мотивация, таксономия задач, доменный контекст.
- [`cube_tesseract_multistage_context_directives_full_research.md`](./cube_tesseract_multistage_context_directives_full_research.md)
  — авторитетная модель `filter`/`grain` директив (нормативный референс для §6).

**Нормативные ключевые слова:** MUST / MUST NOT / SHOULD / MAY трактуются по RFC 2119.

---

## Оглавление
1. Назначение, границы и принципы
2. Источник данных и Semantic Schema (конфигурация)
3. Архитектура и слои исполнения
4. Базовые типы (shared building blocks)
5. Микро-куб модель (`ModelSpec`)
6. Директивы `filter` и `grain` (нормативная семантика)
7. Декларативный запрос (`QuerySpec`)
8. Движок компиляции (multi-stage → SQL)
9. Конверт ответа (`Response`) и режимы исполнения
10. Каталог тулов (контракты и «компилируется в»)
11. Валидация и коды ошибок
12. Безопасность, лимиты, стоимость
13. Детерминизм, кэширование, наблюдаемость
14. Нефункциональные требования
15. Фазы реализации и критерии приёмки
16. Приложения: enums и глоссарий

---

## 1. Назначение, границы и принципы

### 1.1 Назначение
MCP-сервер предоставляет AI-агенту **структурные инструменты (tools)** для
ad-hoc исследовательской аналитики поверх детальных событий. AI вызывает
типизированные тулы; сервер **детерминированно генерирует SQL**, исполняет его и
возвращает результат в едином конверте. Свободный SQL от модели не принимается.

### 1.2 Границы (scope)
- **В scope:** ad-hoc исследования — фильтрованные подсчёты, последовательности
  событий, поведенческие/квантильные сегменты, last-action оттока, прогрессия по
  сессиям/уровням, профили распределений, корреляции, экономика, монетизация,
  post-hoc разбор A/B.
- **Вне scope:** замена корпоративного семантического слоя (Metabase/Cube) для
  регулярной отчётности; расчёт статзначимости A/B (берётся из GrowthBook).

### 1.3 Единственный источник данных (КРИТИЧНО)
Сервер MUST генерировать SQL **только по двум логическим таблицам**: `events`
(детальные события) и `users` (атрибуты игрока). Витрины семантического слоя,
Cube, агрегаты MUST NOT использоваться как источник запроса. Именованные метрики
семантического слоя — это **SQL-рецепты**, повторяющие их формулу по `events`+`users`
(для совпадения чисел), а не чтение витрины.

### 1.4 Принципы
1. **Структурность:** только типизированные параметры → детерминированный SQL.
2. **Единое ядро:** все тулы компилируются через один движок (§3, §8); тулы — это
   фабрики, не отдельные генераторы SQL.
3. **Декларативность:** задача описывается как **виртуальная микро-модель + запрос**
   (§5, §7), а не как императивный SQL.
4. **Корректность по построению:** per-entity агрегация до join'ов; директивы
   `filter`/`grain` контролируют строки и грань (§6).
5. **Прозрачность:** любой тул умеет `dry_run` (вернуть SQL + допущения).
6. **Консистентность:** общие типы (§4) одинаковы во всех тулах.

---

## 2. Источник данных и Semantic Schema (конфигурация)

### 2.1 Логические таблицы
Сервер оперирует логическими полями; их маппинг на физические колонки задаётся в
конфиге **Semantic Schema** (единственное место с физическими именами). Физически
`events`/`users` MAY указывать на модели DWH (`bi_data_models`, `bi_data_metrics`),
но логически тул всегда видит ровно две детальные таблицы.

#### 2.1.1 `events` — обязательные логические поля
| Логическое поле | Тип | Обязательность | Назначение |
|---|---|---|---|
| `user_id` | string | MUST | ключ join с `users` |
| `app_name` | string | MUST | проект (мультипроектность) |
| `platform` | enum(android,ios) | MUST | платформа |
| `event_name` | string | MUST | тип события |
| `event_timestamp` | timestamp(UTC) | MUST | время события; колонка партиционирования |
| `event_date` | date | SHOULD | партиция/прунинг (если есть) |
| `session_id` | string | MAY | сессия |
| `session_number` | int | MAY | порядковый номер сессии игрока |
| `event_properties` | map/json | MUST | сырые свойства (см. 2.1.2) |

#### 2.1.2 `event_properties` — типизированный реестр свойств
Конфиг MUST содержать реестр известных свойств с типами и (опц.) перечислениями:
`level:int`, `level_id:string`, `score:number`, `attempt:int`, `moves:int`,
`revenue:number`, `currency:string`, `ad_type:enum(banner,interstitial,rewarded)`,
`placement:string`, `is_reward_received:bool`, `is_user_returned:bool`,
`hints_used:int`, `resource_type:string`, `source:string`, `amount:number`,
`result:enum(win,lose)`, `funnel_stage:string`, … Реестр расширяемый. Доступ к
свойству вне реестра → ошибка `UNKNOWN_PROPERTY` (§11).

#### 2.1.3 `users` — обязательные/типовые поля
| Логическое поле | Тип | Назначение |
|---|---|---|
| `user_id` | string (MUST) | ключ |
| `install_date` / `first_seen` | date (MUST) | Cohort Date |
| `platform`, `os_version`, `device_model` | string | техническое |
| `country`, `country_group`, `region`, `language` | string | гео |
| `media_source`, `campaign`, `ad_group`, `creative` | string | UA/атрибуция |
| `acquisition_type` | enum(organic,paid)+incent flag | канал |
| `app_version` | string | версия на установке |
| `att_status`, `gdpr_consent` | string/bool | приватность |
| `user_properties` | map/json | расширяемые атрибуты |

### 2.2 Реестр измерений (dimensions registry)
Конфиг MUST классифицировать каждое измерение как **cohort** или **activity**
(см. §6.5, §4.7) и указывать его SQL-выражение и тип. Когортные: `app_name`,
`country`, `country_group`, `media_source`, `campaign`, `ad_group`, `creative`,
`app_version`, `att_status`. Активностные/прогресс: `level`, `level_id`,
`session_number`, `activity_date`, `funnel_stage`, online/offline.

### 2.3 Реестр именованных метрик (named metrics)
Конфиг MAY содержать рецепты метрик семантического слоя (имя → определение:
формула, фильтры, требуемая грань, atomic/semi-atomic, допустимые измерения).
Используется `Measure.type="named"` (§4.6). Сервер компилирует рецепт в SQL по
`events`+`users`.

### 2.4 Конфиг времени/методологий
Конфиг MUST задавать дефолты: `timezone` (UTC), `cohort_methodology`
(`24h`|`calendar`), `relative_to` (`install`), партиционная колонка и гранулярность
партиций (для прунинга), лимиты по умолчанию (§12).

### 2.5 Схема конфига (эскиз)
```jsonc
{
  "tables": {
    "events": { "physical": "bi_data_models.events", "partition": { "column":"event_date", "grain":"day" } },
    "users":  { "physical": "bi_data_models.users" }
  },
  "field_map": { "events.user_id":"uid", "events.event_timestamp":"ts", "users.install_date":"installed_at", "...": "..." },
  "event_properties": { "level":{"type":"int"}, "ad_type":{"type":"enum","values":["banner","interstitial","rewarded"]}, "...": {} },
  "dimensions": { "country":{"sql":"users.country","kind":"cohort"}, "level":{"sql":"events.event_properties.level","kind":"activity"} },
  "named_metrics": { "arpdau": { "...": "recipe" } },
  "defaults": { "timezone":"UTC", "cohort_methodology":"24h", "relative_to":"install", "row_limit":10000, "max_scan_gb":50, "timeout_s":60 }
}
```

---

## 3. Архитектура и слои исполнения

```text
 AI агент (MCP client)
      │  вызов тула с типизированными параметрами
      ▼
 ┌──────────────────────────────────────────────┐
 │ Слой тулов (§10)                              │  пресеты-фабрики + ядро
 │  presets ──┐                                  │
 │            ▼  синтез (ModelSpec + QuerySpec)   │
 │ ┌────────────────────────────────────────────┐│
 │ │ Ядро: микро-куб компилятор (§5–§8)          ││
 │ │  1. валидация модели/запроса (§11)          ││
 │ │  2. multi-stage планировщик (E→U→S→J→A)     ││
 │ │  3. применение filter/grain директив (§6)   ││
 │ │  4. рендер одного SQL (CTE/broadcast)       ││
 │ └────────────────────────────────────────────┘│
 └──────────────────────────────────────────────┘
      │  параметризованный read-only SQL
      ▼
 Executor (BigQuery): dry-run биллинга → exec → строки
      │
      ▼
 Конверт ответа (§9): sql, columns, rows, assumptions, warnings, …
```

**Нормативно:**
- Каждый тул-пресет (§10.4+) MUST реализовываться как **фабрика**, синтезирующая
  `ModelSpec` + `QuerySpec` и вызывающая ядро. Тул MUST NOT генерировать SQL в обход
  ядра.
- Ядро — единственный компонент, рендерящий SQL.
- Executor MUST быть read-only и параметризованным.

---

## 4. Базовые типы (shared building blocks)

Все типы ниже используются единообразно во всех тулах и в `ModelSpec`/`QuerySpec`.

### 4.1 `TimeRange`
```jsonc
{
  "type": "relative" | "absolute",     // MUST
  "last": "30d",                        // для relative: <N>(d|w|mo); MUST если relative
  "from": "2026-01-01",                 // для absolute (date|timestamp); MUST если absolute
  "to":   "2026-03-31",
  "timezone": "UTC"                     // MAY; дефолт из конфига
}
```
Семантика: ограничивает стадию сканирования по `event_timestamp`. Компилятор MUST
транслировать в фильтр по партиционной колонке для прунинга (§8.5). `TimeRange`
обязателен на верхнем уровне каждого исполняемого запроса (§12).

### 4.2 `Granularity`
enum: `hour | day | week | month | quarter`. Для активности маппится на
DAU/WAU/MAU при measure типа уник-пользователей.

### 4.3 `Window` (окно жизни игрока)
```jsonc
{
  "relative_to": "install" | "activation" | "first_event" | "test_start",  // MUST
  "from_day": 0,                       // включительно, целое >= 0
  "to_day": 2,                          // включительно, >= from_day
  "methodology": "calendar" | "24h"     // MAY; дефолт из конфига
}
```
Семантика: `24h` — сутки отсчитываются 24-часовыми интервалами от точки отсчёта
(методология Appsflyer); `calendar` — календарные даты. `relative_to:"activation"`
/`"test_start"` MUST использоваться для анализа экспериментов (метрики от момента
активации). Применённые значения MUST попасть в `assumptions`.

### 4.4 `Operator` (enum условий)
`eq | neq | gt | gte | lt | lte | in | not_in | between | contains | starts_with |
is_null | is_not_null`. Для `in/not_in` — массив; `between` — `[lo, hi]`.

### 4.5 `FilterGroup` / `FilterCondition` (рекурсивно)
```jsonc
// FilterCondition
{ "field": "event_properties.level" | "user.country", "operator": Operator, "value": <any> }
// FilterGroup
{ "op": "and" | "or", "conditions": [ FilterCondition | FilterGroup, ... ] }
```
Префиксы поля: `event_properties.*` (свойство события), `user.*` (атрибут игрока),
`events.*`/`users.*` (явная таблица). Имена MUST проходить валидацию по реестру (§2).

### 4.6 `Measure`
```jsonc
{
  "type": "count_events" | "count_unique_users" | "count_sessions"
        | "sum" | "avg" | "min" | "max" | "median" | "p25" | "p75" | "p90" | "p95"
        | "rate" | "named",            // MUST
  "field": "event_properties.revenue", // MUST для sum/avg/min/max/перцентилей
  "name": "ARPDAU",                     // MUST для type=named (ключ из §2.3)
  "numerator": EventSelector,           // MUST для type=rate
  "denominator": "cohort" | EventSelector, // MUST для type=rate
  "filters": [ FilterCondition|FilterGroup ], // MAY: локальные фильтры меры (в т.ч. для multi_stage)
  "multi_stage": false,                 // MAY; см. §6
  "grain": GrainDirective,              // MAY; §6
  "filter_directive": FilterDirective,  // MAY; §6 (имя поля `filter` в ModelSpec.measures)
  "alias": "revenue"                    // MAY; имя колонки на выходе
}
```
Семантика типов:
- `count_unique_users` → `COUNT(DISTINCT user_id)` (Atomic Players).
- `rate` → `numerator_users / denominator_users * 100` (§ X Rate). `denominator:"cohort"`
  означает размер когорты/популяции запроса.
- `named` → SQL-рецепт из §2.3 (число совпадает с BI). `metric_source="generated"`.

### 4.7 `PerUserAggregate` (ядро вычислений на игрока)
```jsonc
{
  "name": "games_completed_d0_2",       // MUST; идентификатор результата
  "source_event": EventSelector,        // MUST
  "agg": "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | "first" | "last",
  "field": "event_properties.level",    // MUST для sum/avg/min/max/first/last
  "window": Window                       // MAY; окно жизни игрока
}
```
Семантика: компилируется в стадию **U** (грань `user` или иную, см. §8.2),
вычисляя один ряд на игрока. Используется в порогах, квантилях, осях профиля,
сегментах.

### 4.8 `EventSelector`
```jsonc
{ "event": "level_complete" | "*", "filters": FilterGroup?, "alias": "win"? }
```

### 4.9 `Breakdown`
Массив ссылок на измерения (имена из реестра §2.2 или `event_properties.*`/`user.*`):
`["app_name","user.country","event_properties.level","session_number"]`. Семантика
по semi-atomic/rate мерам ограничена когортными измерениями (§6.5).

### 4.10 `CohortRef`
```jsonc
{
  "ref": "cohort_abc123",               // сохранённая когорта (§10: cohort_define/derived_segment)
  "segment_api_id": "high_ad_watchers", // сегмент Player Segmentation API
  "model_segment": "payers",            // имя сегмента внутри текущей ModelSpec
  "inline": {                            // инлайн-определение
    "user_filter": FilterGroup?,
    "did_events": [ EventSelector ]?,
    "did_not_events": [ EventSelector ]?,
    "having": [ { "aggregate": PerUserAggregate, "operator": Operator, "value": <num> } ]?,
    "within": TimeRange?
  }
}
```
Ровно один из `ref|segment_api_id|model_segment|inline` MUST быть задан.

### 4.11 `AppScope`
```jsonc
{ "app_name": "wordsea", "platform": "android" }  // оба MAY, но см. §12 (без app_name → warning/требование)
```

### 4.12 `Order` / `Limit`
`order`: `{ "<measure_or_dimension>": "asc"|"desc" }`. `limit`: целое > 0,
ограничено `max_row_limit` (§12).

---

## 5. Микро-куб модель (`ModelSpec`)

`ModelSpec` — **эфемерная виртуальная семантическая модель**, синтезируемая под
задачу поверх `events`+`users`. Создаётся пресетом или напрямую (`define_model`,
§10.3). Компилируется в SQL вместе с `QuerySpec` (§7). Не персистится в глобальном
слое; MAY кэшироваться по хэшу.

### 5.1 Схема
```jsonc
{
  "name": "task_model",                  // MUST; идентификатор
  "source": { "events": "events", "users": "users" },   // фиксировано (§1.3)
  "joins": [
    { "from": "events", "to": "users", "on": "user_id", "rel": "many_to_one" }  // дефолтный join
  ],
  "grains": [                            // предопределённые rollup-сущности (стадии U)
    { "name": "player",         "keys": ["user_id"] },
    { "name": "player_day",     "keys": ["user_id","activity_date"] },
    { "name": "player_level",   "keys": ["user_id","level"] },
    { "name": "player_session", "keys": ["user_id","session_number"] }
  ],
  "windows": [ { "name": "d0_2", "relative_to":"install", "from_day":0, "to_day":2, "methodology":"24h" } ],
  "dimensions": [
    { "name":"country",      "sql":"users.country",                 "kind":"cohort",   "type":"string" },
    { "name":"media_source", "sql":"users.media_source",            "kind":"cohort",   "type":"string" },
    { "name":"level",        "sql":"events.event_properties.level", "kind":"activity", "type":"int" },
    { "name":"ad_type",      "sql":"events.event_properties.ad_type","kind":"activity","type":"enum" },
    { "name":"install_date", "sql":"users.install_date",            "kind":"cohort",   "type":"time" }
  ],
  "measures": [
    { "name":"users",   "type":"count_distinct", "sql":"events.user_id" },
    { "name":"revenue", "type":"sum", "sql":"events.event_properties.revenue",
      "filters":[ { "sql":"events.event_name='purchase'" } ] },
    { "name":"arpu",    "type":"avg", "multi_stage":true, "sql":"{revenue}",
      "grain": { "include":["user_id"] } },                  // §6
    { "name":"all_ad_revenue", "type":"sum", "multi_stage":true, "sql":"{ad_revenue}",
      "filter": { "exclude":["ad_type"] } }                  // §6
  ],
  "segments": [ { "name":"payers", "did":[ { "event":"purchase" } ] } ]
}
```

### 5.2 Семантика элементов
- **`source`** — фиксировано: только `events`/`users` (§1.3).
- **`joins`** — по умолчанию `events ⋈ users ON user_id` (many_to_one). Дополнительные
  self-join'ы событий (для adjacency/funnel) создаются компилятором по `QuerySpec`,
  а не объявляются вручную.
- **`grains`** — именованные сущности промежуточных стадий **U** (§8.2). Грань
  определяет ключи `GROUP BY` внутренней агрегации.
- **`windows`** — именованные окна (`Window`, §4.3) для оконных per-user мер.
- **`dimensions`** — логические измерения: `sql` (выражение над `events`/`users`),
  `kind` (cohort|activity, §6.5), `type`. Измерение `kind:"cohort"` требует join к
  `users`.
- **`measures`** — меры (см. §4.6 + §6). `sql` MAY ссылаться на другую меру через
  `{measure_name}` — это делает меру multi-stage (агрегат от агрегата).
  `multi_stage:true` MUST быть выставлен явно, если у меры есть `grain`/`filter`
  директива или ссылка на другую меру.
- **`segments`** — именованные поведенческие фильтры (поднабор `CohortRef.inline`):
  `did`/`did_not`/`user_filter`/`having`. Ссылаются из `QuerySpec.segments`.

### 5.3 Правила валидности модели
- Имена `dimensions`/`measures`/`segments`/`grains`/`windows` MUST быть уникальны.
- Все ссылки (`{measure}`, `grain.include:[dim]`, `keys:[dim]`) MUST резолвиться.
- Циклические ссылки мер MUST отвергаться (`MODEL_CYCLE`).
- `cohort`-измерение/мера с join MUST иметь корректный `joins`.

---

## 6. Директивы `filter` и `grain` (нормативная семантика)

Полная модель — в [`cube_tesseract_multistage_context_directives_full_research.md`].
Здесь — нормативные требования к реализации. Главный принцип:

> **`filter` меняет видимые строки (`WHERE`). `grain` меняет грань агрегации
> (`GROUP BY`/`PARTITION BY`).** Их MUST NOT путать.

### 6.1 Состояния контекста
Планировщик MUST поддерживать два состояния:
- **root state** — исходный контекст `QuerySpec` (dimensions, time_dimensions,
  фильтры, сегменты), создаётся один раз. Measure-фильтры в root MUST NOT протекать.
- **parent state** — состояние стадии выше; наследуется дочерней стадией, если не
  задан `filter.mode:"fixed"`.

### 6.2 `FilterDirective` (поле `filter` у меры)
```jsonc
{
  "mode": "relative" | "fixed",          // MAY; дефолт relative
  "exclude": [ "<dim>" ],                 // MAY; взаимоисключающе с keep_only
  "keep_only": [ "<dim>" ],               // MAY; взаимоисключающе с exclude
  "include": [ FilterCondition|FilterGroup ]  // MAY; добавляемые предикаты
}
```
Семантика (MUST):
- `mode:relative` — база = parent state; `mode:fixed` — база = root state.
- `exclude:[X]` — удалить из контекста фильтры/сегменты, таргетящие X.
- `keep_only:[X]` — оставить только фильтры по X, прочее удалить.
- `include:[...]` — AND-добавить предикаты (поддержка вложенных `or`/`and`).
- Влияет на `WHERE`/сегменты; на `GROUP BY` MUST NOT влиять.
Use-cases (см. §10): знаменатель доли across фильтра (`exclude`), стабильный
страновой бенчмарк (`keep_only`), каноническая метрика (`include`), фиксированный
baseline (`mode:fixed`).

### 6.3 `GrainDirective` (поле `grain` у меры)
```jsonc
{
  "exclude":   [ "<dim>" ],   // взаимоисключающе с keep_only
  "keep_only": [ "<dim>" ],   // взаимоисключающе с exclude
  "include":   [ "<dim>" ]    // добавить измерения к грани
}
```
Семантика (MUST), относительно унаследованной грани:
- `include:[d]` — **добавить** d к грани внутренней стадии (per-entity → затем
  свёртка во внешней стадии). Требует **join-path** (§8.4).
- `keep_only:[d]` — **пересечь** грань строго с d. Если d отсутствует в гранях
  запроса → пустое пересечение → **grand total** (MUST вернуть `warning`).
- `exclude:[d]` — **убрать** d из грани (расчёт «across d»). Для аддитивных мер MAY
  рендериться window-path (`OVER (PARTITION BY …)`).
- Влияет на `GROUP BY`/`PARTITION BY`/ключи; на видимость строк MUST NOT влиять.

### 6.4 Порядок операций (MUST соблюдать)
```
1. Резолв меры и статических фильтров
2. Выбор базы: root (mode=fixed) | parent (relative)
3. filter.exclude → 4. filter.keep_only → 5. filter.include
6. grain.exclude / grain.keep_only (по dimensions и time_dimensions)
7. grain.include (добавление измерений)
8. time_shift / window transform
9. Удалить фильтр на саму вычисляемую меру
10. Построить дочерние CTE; при необходимости keys_input для восстановления грани
11. Рендер логического → физического SQL; broadcast обратно на грань родителя
```

### 6.5 Cohort vs activity измерения
Сервер MUST знать `kind` каждого измерения (§2.2). Для мер `type:"rate"`/named
semi-atomic разбивка (`Breakdown`) и `grain` MUST быть ограничены **cohort**-измерениями;
попытка использовать activity-измерение → `warning` + игнор разбивки (не «тихо
неверное» число).

### 6.6 Broadcast
Если дочерняя грань грубее родительской (измерение родителя отсутствует у ребёнка),
компилятор MUST «размножить» значение обратно на полную грань родителя через
`keys_input` + финальный full-key aggregate. Это намеренное поведение (percent-of-total,
share), а не ошибка дублирования.

### 6.7 Валидация директив
- `exclude` и `keep_only` в одной директиве одновременно → `DIRECTIVE_CONFLICT`.
- Неразрешённое измерение в директиве → `UNKNOWN_DIMENSION`.
- `grain.include` несовместимой грани (нет ключа в `events`) → `INVALID_GRAIN`.

---

## 7. Декларативный запрос (`QuerySpec`)

### 7.1 Схема
```jsonc
{
  "model": "task_model" | ModelSpec,     // MUST: ref или инлайн-модель
  "measures": [ "<measure_name>" ],       // MUST (>=1) — кроме чисто метаданных
  "dimensions": [ "<dimension_name>" ],   // MAY
  "timeDimensions": [
    { "dimension": "install_date", "granularity": Granularity?, "dateRange": ["2026-01-01","2026-03-31"] }
  ],                                       // MAY; dateRange обязателен для исполнения (§12)
  "filters": [ { "member":"<dim>", "operator": Operator, "values":[ ... ] } ], // MAY
  "segments": [ "<segment_name>" ],        // MAY
  "cohort": CohortRef,                     // MAY; ограничение популяции
  "app_scope": AppScope,                   // MAY (см. §12)
  "order": { "<member>": "asc"|"desc" },   // MAY
  "limit": 1000,                           // MAY; дефолт/максимум из конфига
  "dry_run": false                         // MAY; дефолт false
}
```

### 7.2 Семантика
- `measures`/`dimensions`/`timeDimensions`/`filters`/`segments` ссылаются на элементы
  `ModelSpec`. Неразрешённое имя → ошибка (§11).
- `timeDimensions[].dateRange` транслируется в `TimeRange` и партиционный прунинг.
- `filters` — это фильтры **root state** (§6.1); меры с директивами модифицируют их
  локально.
- `cohort` ограничивает популяцию (подмешивается в `WHERE user_id IN (...)` или join).
- Грань запроса = `dimensions` + `timeDimensions`; относительно неё работают `grain`
  директивы мер (§6.3).

---

## 8. Движок компиляции (multi-stage → SQL)

### 8.1 Канонические стадии
| Стадия | Назначение | Грань выхода |
|---|---|---|
| **E** Event scan | фильтр `events` (event_name, property-фильтры, TimeRange, app), проекция полей | event |
| **U** Per-entity aggregate | свёртка к ряду на сущность (`grains`), per-user меры | user/user_day/user_level/user_session |
| **S** Segment/bucket | присвоение сегмента (пороги/ntile), join атрибутов `users` | user (+segment, cohort dims) |
| **J** Join/combine | соединение веток U/S и с `users` | user (обогащённый) |
| **A** Final aggregate | агрегация по грани запроса → результат | breakdown grain |

### 8.2 Планирование
- Для каждой меры компилятор определяет требуемую грань (с учётом `grain` директив)
  и набор фильтров (с учётом `filter` директив, §6.4).
- Per-entity свёртка (U) MUST выполняться до join'ов и до финальной агрегации (A) —
  устранение fan-out/двойного счёта.
- Несколько мер с разными гранями → несколько CTE, соединяемых по общим ключам
  (full-key aggregate, §6.6).

### 8.3 Рендер
Компилятор MUST генерировать **один** SQL с CTE (`WITH`), параметризованный
(значения фильтров — bind-параметры). Имена CTE детерминированы.

### 8.4 Window-path vs Join-path
- `grain.exclude`/`keep_only` для аддитивных мер MAY рендериться как
  `agg(...) OVER (PARTITION BY <reduced grain>)` (оптимизация).
- `grain.include` и неаддитивные случаи MUST использовать join-path (под-CTE более
  тонкой грани + повторная агрегация).

### 8.5 Партиционирование и стоимость
- `TimeRange`/`dateRange` MUST транслироваться в предикат по партиционной колонке
  (`event_date`/`_PARTITIONTIME`) для прунинга.
- Перед исполнением компилятор MUST выполнить dry-run оценку сканируемых байт; при
  превышении `max_scan_gb` → ошибка `SCAN_LIMIT_EXCEEDED` (§11/§12).

### 8.6 Детерминизм
Одинаковые (`ModelSpec`+`QuerySpec`) MUST давать побайтово одинаковый SQL (стабильный
порядок CTE/колонок/предикатов) для кэширования и снапшот-тестов.

---

## 9. Конверт ответа (`Response`) и режимы исполнения

### 9.1 Схема
```jsonc
{
  "sql": "WITH ... SELECT ...",          // всегда
  "columns": [ { "name":"...", "type":"..." } ],
  "rows": [ [ ... ], ... ],               // отсутствует при dry_run
  "row_count": 123,                       // отсутствует при dry_run
  "metric_source": "generated",           // всегда из events+users
  "model": { "...": "компактное описание использованной микро-модели" },
  "assumptions": [ "tz=UTC", "methodology=24h", "relative_to=install", "inactivity=5d" ],
  "warnings": [ "semi-atomic меру нельзя резать по activity-измерению — разбивка проигнорирована" ],
  "stats": { "scanned_bytes": 1234567, "duration_ms": 842, "cache_hit": false }
}
```

### 9.2 Режимы
- `dry_run:true` → MUST вернуть `sql` + `assumptions` + `model` (+ `stats.scanned_bytes`
  из dry-run), без `rows`. Ничего не исполнять.
- Обычный → исполнить с `row_limit`/`timeout`/`max_scan_gb`; вернуть `rows`.
- Все «додуманные» дефолты (методология, окно, tz, дефолтный return-event, обрезка
  кардинальности) MUST попадать в `assumptions`/`warnings`.

---

## 10. Каталог тулов (контракты и «компилируется в»)

Все тулы возвращают `Response` (§9). Все принимают `dry_run?`. Пресеты (§10.4+) MUST
реализовываться как фабрики (§3): из своих параметров строят `ModelSpec`+`QuerySpec`.
Раздел «Компилируется в» — нормативное поведение фабрики.

### 10.1 Метаданные (grounding)
| Тул | Вход | Выход |
|---|---|---|
| `list_events` | `app_name?`, `search?`, `with_volume?`, `time_range?` | события + (опц.) частота |
| `list_properties` | `event?`, `with_sample_values?` | свойства, типы, примеры, кардинальность |
| `list_metrics` | `block?`, `search?` | именованные метрики (имя, atomic/semi-atomic, допустимые измерения) |
| `describe_schema` | — | таблицы/поля, операторы, measure-типы, cohort/activity измерения, грани, окна |
Тулы метаданных читают конфиг (§2)/лёгкие запросы; AI SHOULD вызывать их перед
первым аналитическим запросом по новой теме.

### 10.2 `query_model` — прямой декларативный запрос (ядро)
**Вход:** `QuerySpec` (§7) — с инлайн `model` или `model_ref`.
**Поведение:** валидация (§11) → компиляция (§8) → исполнение/`dry_run`.
**Назначение:** общий доступ к ядру; в него «опускаются» все пресеты.

### 10.3 `define_model` — создание/валидация микро-модели (ядро)
**Вход:** `ModelSpec` (§5).
**Выход:** `model_ref` + компактное описание + список предупреждений валидации.
Модель кэшируется по хэшу; `model_ref` MAY использоваться в `query_model`/пресетах.

### 10.4 `event_count` — фильтрованный подсчёт по событию (GD Tasks Блок 1)
**Вход:**
```jsonc
{
  "event_selector": EventSelector,                 // MUST
  "measures": ["count_events","count_unique_users"], // >=1
  "property_splits": ["event_properties.is_reward_received","event_properties.is_user_returned"], // MAY
  "breakdown": Breakdown,                           // MAY (app/country/install_date/media_source)
  "link_to_install": true,                          // MAY; join к users для когортных разрезов
  "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef, "dry_run": false
}
```
**Компилируется в:** ModelSpec с мерами `count_events`/`count_unique_users`
(фильтр = `event_selector`), dimensions = `breakdown` + `property_splits`; QuerySpec
с этими measures/dimensions и `TimeRange`. `link_to_install` → join к `users`.

### 10.5 `metrics_timeseries` — тренды во времени
**Вход:** `measures[]` (вкл. `named`), `event_selector?`, `time_range`, `granularity`,
`breakdown?`, `rebase_to?` (дата нормировки к baseline), `app_scope?`, `cohort?`,
`filters?`. **Компилируется в:** QuerySpec с `timeDimensions[{granularity}]`;
`rebase_to` → пост-обработка (деление серий на значение в baseline-дате,
фиксируется в `assumptions`).

### 10.6 `segmentation` — разрез без оси времени
**Вход:** `measures[]`, `event_selector?`, `breakdown` (MUST), `time_range`,
`filters?`, `app_scope?`, `cohort?`, `order?`, `limit?`.

### 10.7 `conversion_rate` — X Rate (доли/конверсии)
**Вход:** `numerator: EventSelector` (MUST), `denominator: "cohort"|EventSelector`
(MUST), `breakdown?` (только cohort-измерения), `time_range`, `app_scope?`, `cohort?`.
**Компилируется в:** мера `type:"rate"`; знаменатель across нерелевантных фильтров
реализуется `filter.exclude`/`grain.keep_only` (§6).

### 10.8 `adjacent_event_count` — условие на соседнее событие (GD Tasks Блок 2)
**Вход:**
```jsonc
{
  "anchor_event": EventSelector,      // MUST: X
  "neighbor_event": EventSelector,    // MUST: Y
  "relation": "next" | "prev" | "next_within" | "prev_within",  // MUST
  "within": "10m" | "1 event" | "same_session",                 // MAY (для *_within)
  "measures": ["count_events","count_unique_users"],
  "breakdown": Breakdown?, "time_range": TimeRange, "app_scope": AppScope?, "cohort": CohortRef?
}
```
**Компилируется в:** стадия U с оконными `LAG/LEAD` по `(user_id ORDER BY
event_timestamp)`; предикат на соседа = `neighbor_event`; затем агрегация. Выход
включает долю X с совпавшим соседом.

### 10.9 `funnel_analysis` — воронки
**Вход:** `steps: EventSelector[]` (>=2), `order: "ordered"|"any_order"`,
`conversion_window?`, `step_window?`, `time_range`, `breakdown?`, `app_scope?`,
`cohort?`, `count_mode:"unique_users"`, `include_step_timing?`.
**Выход:** на шаг — `users`, `conversion_from_prev`, `conversion_from_start`,
`avg_time_to_step`. **Компилируется в:** последовательные self-join/оконные стадии
с проверкой `ts_{i+1}>ts_i` и окон.

### 10.10 `retention_analysis` — удержание
**Вход:** `cohort_event: EventSelector`, `return_event: EventSelector?` (дефолт —
любая активность), `retention_type: "n_day"|"unbounded"|"rolling"|"bracket"`,
`periods:int[]`, `granularity:"day"|"week"|"month"`, `time_range`, `breakdown?`,
`app_scope?`, `cohort?`, `methodology?`. **Выход:** матрица
`(cohort_period, period_offset → % вернувшихся)` + размеры когорт.
**Компилируется в:** per-user флаг возврата на лаге N (`grain.include:[user_id]`) →
агрегат по когорте.

### 10.11 `cohort_retention_grid` — когортная сетка
**Вход:** `cohort_by`, `cohort_granularity:"day"|"week"|"month"`,
`metric:"retention"|"cumulative_revenue"|"arpu"|"roas"|"ltv"|"conversion"`,
`periods`, `breakdown?`, `time_range`, `app_scope?`. **Выход:** матрица
Cohort Date × Retention X Day.

### 10.12 `cohort_define` — конструктор поведенческих когорт
**Вход:** `user_filter?`, `did_events?`, `did_not_events?`, `frequency?`
(`{event,operator,count}` или `having` по `PerUserAggregate`), `within: TimeRange`,
`app_scope?`, `name`, `materialize: "reference"|"user_list"`.
**Выход:** `cohort_ref`, размер, (опц.) список `user_id`. Соответствует
`ModelSpec.segments` / `CohortRef`.

### 10.13 `behavioral_segment_metrics` — метрики по поведенческому сегменту (GD Tasks Блок 3)
**Вход:**
```jsonc
{
  "having": [ { "aggregate": PerUserAggregate, "operator": Operator, "value": <num> } ], // MUST
  "having_op": "and" | "or",
  "measures": [ Measure ],                  // MUST
  "breakdown": Breakdown?, "time_range": TimeRange, "app_scope": AppScope?
}
```
**Компилируется в:** стадия U с per-user агрегатами → стадия S с условием `having`
(сегмент) → A с `measures`.

### 10.14 `derived_segment` — динамическая (квантильная/пороговая) сегментация
**Вход:**
```jsonc
{
  "metric": PerUserAggregate,               // MUST
  "method": "ntile" | "thresholds",         // MUST
  "buckets": 5,                             // для ntile
  "labels": ["low","middle_low","middle","middle_high","high"],
  "thresholds": [1,5,20,50],               // для thresholds
  "time_range": TimeRange, "app_scope": AppScope?, "materialize": "reference"|"dimension"
}
```
**Выход:** определение сегмента + размеры групп; `segment_ref`/измерение для
подстановки в `breakdown`/`cohort`. **Компилируется в:** U (per-user metric) → S
(`NTILE(buckets)` или CASE по порогам).

### 10.15 `behavioral_segment` — сравнение двух групп
**Вход:** `group_a: CohortRef`, `group_b: CohortRef` (или `split_by_event:
EventSelector` → did/didn't), `compare_measures: Measure[]`, `time_range`, `app_scope?`.
**Выход:** таблица метрик A vs B + дельта.

### 10.16 `churn_last_action` — последнее действие перед оттоком (GD Tasks/исследования)
**Вход:**
```jsonc
{
  "inactivity_days": 5,                     // MUST
  "window": Window,                          // MAY (напр. d0_2)
  "last_action_fields": ["event_name","event_properties.level","event_properties.level_id","event_properties.ad_type","event_properties.placement"],
  "segment_by": "<segment_ref>" | Breakdown,
  "time_range": TimeRange, "app_scope": AppScope?, "cohort": CohortRef?
}
```
**Выход:** `(segment, last_event, last_lvl, level_id, ad_type, ad_place, players,
share_pct)`. **Компилируется в:** U с `last` по `event_timestamp` среди ушедших в
отток (нет активности `inactivity_days`), затем A по `last_action_fields`.

### 10.17 `session_progression` — осыпание по номеру сессии
**Вход:** `max_session?`, `min_share_pct?`, `breakdown?`, `window?`, `time_range`,
`app_scope?`, `cohort?`. **Выход:** по `session_number` — `players`,
`share_from_start_pct`, `avg/median_session_duration`, `avg/median_completed_levels`.
**Компилируется в:** грань `player_session`.

### 10.18 `lifecycle_analysis`
**Вход:** `active_event`, `granularity:"day"|"week"|"month"`, `dormant_after`,
`time_range`, `breakdown?`, `app_scope?`, `cohort?`. **Выход:** по периоду —
`new/current/resurrected/dormant/churned`.

### 10.19 `stickiness_analysis`
**Вход:** `event_selector`, `window:"week"|"month"`, `metric:"dau_mau_ratio"|
"days_active_distribution"`, `time_range`, `breakdown?`, `app_scope?`, `cohort?`.

### 10.20 `distribution_profile` — распределения и профиль сегмента
**Вход:** `metric: PerUserAggregate | "<event field>"`, `mode:"histogram"|
"percentiles"|"per_segment_profile"`, `stats:["avg","median","p25","p75","max"]`,
`segment_by?`, `buckets?`, `time_range`, `app_scope?`, `cohort?`.

### 10.21 `path_analysis` — пути (Pathfinder)
**Вход:** `anchor_event`, `direction:"after"|"before"`, `steps:int`, `max_paths:int`,
`within_session?`, `exclude_events?`, `time_range`, `app_scope?`, `cohort?`.
**Выход:** дерево/список путей с долями переходов.

### 10.22 `progression_analysis` — прогрессия по уровням
**Вход:**
```jsonc
{
  "level_dimension": "by_order" | "by_id",   // MUST
  "start_event":"level_start","win_event":"level_complete","fail_event":"level_fail",
  "level_range": { "from":1, "to":200 },
  "metrics": ["players_reached","started_rate","win_rate","avg_attempts","avg_moves","churn_at_level","coins_spent_at_level"],
  "breakdown": Breakdown?, "time_range": TimeRange, "app_scope": AppScope?, "cohort": CohortRef?
}
```
**Компилируется в:** грань `player_level`; метрики через rate/per-user агрегаты.

### 10.23 `economy_analysis` — игровая экономика
**Вход:**
```jsonc
{
  "income_event":"currency_income","outcome_event":"currency_outcome",
  "resource_field":"event_properties.resource_type","amount_field":"event_properties.amount",
  "source_field":"event_properties.source", "convert_to_coins": true,
  "metric":"income|outcome|net|cumulative_income|cumulative_outcome|balance|source_structure",
  "axis":"by_day|by_session|by_level", "axis_range": { "from":0, "to":200 },
  "breakdown": Breakdown?, "time_range": TimeRange, "app_scope": AppScope?, "cohort": CohortRef?
}
```
**Выход:** факт/кумулятив/баланс/структура источников по оси и сегментам.

### 10.24 `monetization_analysis` — IAP + реклама
**Вход:**
```jsonc
{
  "revenue_kind":"iap|ad|total", "purchase_event":"purchase","ad_event":"ad_impression",
  "ad_type":"banner|interstitial|rewarded|all",
  "metric":"arpdau|arppu|arpu|conversion_to_payer|payer_share|time_to_first_purchase|ltv_curve|revenue_by_product|ad_impressions_per_dau|ad_arpu",
  "net_of_refunds": true, "ltv_horizon":[1,7,30,90,180],
  "breakdown": Breakdown?, "granularity": Granularity?, "time_range": TimeRange, "app_scope": AppScope?, "cohort": CohortRef?
}
```
**Компилируется в:** per-user меры (`grain.include:[user_id]`) для ARPU/ARPPU/LTV;
`net_of_refunds` → `filter` корректировка; именованные метрики — через `named`.

### 10.25 `correlation_explore` — поиск зависимостей
**Вход:** `unit:"level"|"user"|"segment"`, `x:{metric|field}`, `y:{metric|"completion_rate"|"churn"}`,
`method:"scatter_table"|"correlation"|"grouped_compare"`, `breakdown?`, `time_range`,
`app_scope?`, `cohort?`. **Выход:** пары (x,y) + коэффициент связи; `assumptions`
MUST содержать «корреляция ≠ причинность».

### 10.26 `post_hoc_segment_compare` — post-hoc разбор A/B
**Вход:** `experiment_key`, `variants:["base","test"]`, `segment_by:[...]`,
`compare:[...]`, `time_range`, `app_scope?`. **Выход:** сравнение вариантов по
сегментам/поведению. Статзначимость берётся из `experiment_lookup`, не считается.

### 10.27 `experiment_lookup` — мост к GrowthBook
**Вход:** `experiment` (ключ/имя), `metric?`, `segment?`. **Выход:** variation,
uplift, Chance to Win, p-value (через `growthbook_*`). A/B сам не считается.

### 10.28 `compose_pipeline` — императивная проекция ядра (escape hatch)
**Вход:** `stages: Stage[]` — типизированные стадии (`event_scan`,
`per_user_aggregate`, `segment`, `join`, `retention`, `aggregate`) со ссылками по
`id`/`from` и директивами `grain`/`filter` (§6). **Поведение:** валидация графа
(совместимость гранёй, отсутствие fan-out, `keep_only`/`exclude` не вместе) →
опускание в `ModelSpec`+`QuerySpec` → ядро. Остаётся структурным (не свободный SQL).

### 10.29 `user_timeline` — отладка на уровне игрока
**Вход:** `user_id` (или малый `CohortRef` с `limit`), `time_range`, `event_filter?`,
`app_scope?`, `limit`. **Выход:** атрибуты игрока + упорядоченная лента событий.

---

## 11. Валидация и коды ошибок

Валидация выполняется **до** генерации SQL. Ошибка MUST содержать `code`, `message`,
`path` (указатель на поле) и (где уместно) `suggestions` (ближайшие имена).

| Code | Условие |
|---|---|
| `UNKNOWN_EVENT` | событие не в реестре (§2.1) |
| `UNKNOWN_PROPERTY` | свойство не в реестре (§2.1.2) |
| `UNKNOWN_DIMENSION` | измерение/мера/сегмент не в `ModelSpec`/реестре |
| `MISSING_REQUIRED` | отсутствует обязательный параметр |
| `INVALID_ENUM` | значение вне допустимого enum |
| `DIRECTIVE_CONFLICT` | `exclude` и `keep_only` одновременно (§6.7) |
| `INVALID_GRAIN` | грань несовместима (нет ключа в `events`) |
| `MODEL_CYCLE` | циклическая ссылка мер (§5.3) |
| `SEMI_ATOMIC_BREAKDOWN` | semi-atomic мера по activity-измерению (→ обычно `warning`, не ошибка) |
| `TIME_RANGE_REQUIRED` | нет `time_range`/`dateRange` для исполнения (§12) |
| `SCAN_LIMIT_EXCEEDED` | dry-run байт > `max_scan_gb` (§8.5) |
| `ROW_LIMIT_INVALID` | `limit` <= 0 или > `max_row_limit` |
| `APP_SCOPE_REQUIRED` | конфиг требует явный `app_name`, он не задан |

Несоответствие, которое можно «починить» дефолтом, MUST становиться `warning`, а не
ошибкой (напр. обрезка кардинальности, игнор недопустимой разбивки).

---

## 12. Безопасность, лимиты, стоимость

- **Read-only:** только `SELECT`. Любой DDL/DML MUST быть невозможен. Параметризация
  значений (bind-параметры) — обязательна; конкатенация пользовательских значений в
  SQL MUST NOT использоваться.
- **Allowlist:** таблицы/колонки только из конфига (§2). Доступ к иным → ошибка.
- **Обязательный time-bound:** исполняемый запрос MUST иметь `time_range`/`dateRange`;
  иначе `TIME_RANGE_REQUIRED`.
- **Партиционный прунинг** (§8.5) — обязателен; запрос без прунинга по дате SHOULD
  отвергаться или предупреждать.
- **Лимиты (из конфига, дефолты):** `row_limit=10000`, `max_row_limit`,
  `timeout_s=60`, `max_scan_gb=50`, `max_breakdown_cardinality` (обрезка с `warning`).
- **Мультипроектность:** без `app_scope.app_name` — `warning` (или `APP_SCOPE_REQUIRED`,
  если включено в конфиге).
- **Стоимость:** перед исполнением — dry-run оценка байт; превышение → отказ.

---

## 13. Детерминизм, кэширование, наблюдаемость

- **Детерминизм SQL** (§8.6): стабильные имена CTE, порядок колонок/предикатов.
- **Кэш модели:** `ModelSpec` кэшируется по хэшу → `model_ref`.
- **Кэш результата (MAY):** ключ = хэш(`ModelSpec`+`QuerySpec`+конфиг-версия); TTL из
  конфига; `stats.cache_hit` MUST отражать факт.
- **Логирование:** для каждого вызова — tool, нормализованные параметры, хэш SQL,
  `scanned_bytes`, `duration_ms`, коды ошибок/warnings. PII (user_id) в логах MUST
  быть минимизирован/хэширован согласно политике.
- **Воспроизводимость:** `dry_run` + `assumptions` достаточно для ручной проверки.

---

## 14. Нефункциональные требования

- **Расширяемость:** добавление нового тула = новая фабрика (§3), без изменения ядра.
- **Целевой бэкенд:** BigQuery (диалект Standard SQL). Архитектура SHOULD изолировать
  диалект за слоем рендера для потенциального портирования.
- **Производительность:** компиляция (без исполнения) < 200 мс на типовой запрос.
- **Тестируемость:** снапшот-тесты SQL по (`ModelSpec`+`QuerySpec`); golden-набор
  кейсов из реальных исследований (§ дизайн-док §10).
- **Совместимость чисел:** для `named`-метрик — расхождение с Metabase в пределах
  оговорённого допуска; методология фиксируется в `assumptions`.

---

## 15. Фазы реализации и критерии приёмки

### Фаза 0 — Фундамент (ядро)
- Semantic Schema config (§2); базовые типы (§4); `ModelSpec`/`QuerySpec` (§5,§7);
  компилятор multi-stage + `filter`/`grain` + broadcast (§6,§8); конверт+`dry_run`
  (§9); валидация/ошибки (§11); безопасность/лимиты (§12).
- Тулы: `describe_schema`, `list_events`, `list_properties`, `list_metrics`,
  `define_model`, `query_model`.
- **Приёмка:** golden snapshot-тесты SQL для percent-of-total, ARPU
  (`grain.include:[user_id]`), страновой бенчмарк (`filter.keep_only`); прунинг
  партиций подтверждён планом; `dry_run` отдаёт корректный SQL+assumptions.

### Фаза 1 — Ядро ad-hoc (GD Tasks)
- `event_count`, `adjacent_event_count`, `behavioral_segment_metrics`,
  `derived_segment`, `cohort_define`.
- **Приёмка:** воспроизведены примеры GD Tasks Блоки 1–3 (сплит по параметрам;
  X рядом с Y; метрики по `having`); квантильные 5×20% сегменты совпадают с эталоном.

### Фаза 2 — Исследовательский топ
- `churn_last_action`, `session_progression`, `distribution_profile`,
  `progression_analysis`, `correlation_explore`, `metrics_timeseries`(rebase),
  `segmentation`, `conversion_rate`, `retention_analysis`.
- **Приёмка:** воспроизведены таблицы из реальных retention/last-action/session
  исследований (с допуском).

### Фаза 3 — Когорты/деньги/поведение
- `behavioral_segment`, `cohort_retention_grid`, `lifecycle_analysis`,
  `stickiness_analysis`, `path_analysis`, `economy_analysis`, `monetization_analysis`.

### Фаза 4 — A/B и escape
- `post_hoc_segment_compare`, `experiment_lookup`, `user_timeline`,
  `compose_pipeline`.
- **Приёмка:** post-hoc разрез base/test по сегментам новизны; pipeline опускается в
  тот же SQL, что эквивалентный набор пресетов.

---

## 16. Приложения

### 16.1 Enums (сводно)
- `Operator`: см. §4.4.
- `Measure.type`: см. §4.6.
- `Granularity`: hour|day|week|month|quarter.
- `Window.relative_to`: install|activation|first_event|test_start.
- `Window.methodology`/`cohort_methodology`: calendar|24h.
- `dimension.kind`: cohort|activity.
- `relation` (adjacency): next|prev|next_within|prev_within.
- `retention_type`: n_day|unbounded|rolling|bracket.

### 16.2 Глоссарий
- **Atomic / Semi-Atomic** — мера, фильтруемая по всем измерениям / только по
  когортным; основа X Rate (`Atomic/Semi-Atomic×100`).
- **Broadcast** — размножение значения грубой грани на тонкую грань отчёта (§6.6).
- **Grain (грань)** — набор ключей `GROUP BY` стадии/запроса.
- **Multi-stage measure** — мера-«агрегат от агрегата», считаемая через под-CTE.
- **Micro-cube (микро-модель)** — эфемерная виртуальная модель под задачу (§5).
- **Preset (пресет)** — тул-фабрика, синтезирующая `ModelSpec`+`QuerySpec`.

### 16.3 Ссылки
- Дизайн и таксономия: `analytics-mcp-tools-design.md`.
- Директивы (нормативный референс): `cube_tesseract_multistage_context_directives_full_research.md`.
- Cube PR #10957 (grain & filter directives) — внешний референс модели.
