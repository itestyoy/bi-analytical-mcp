# dbt Semantic Layer / MetricFlow — полная спецификация semantic models

> Справочник-первоисточник для проектирования MCP-тула, который **декларативно
> создаёт semantic model**, отдаёт генерацию SQL движку **MetricFlow** и затем
> выполняет к модели запрос. Здесь зафиксированы все концепты, свойства,
> допустимые значения (enum) и жизненный цикл — чтобы схема тула опиралась на
> точную спецификацию, а не на догадки.

Документ описывает «последнюю» (Latest) YAML-спецификацию dbt Semantic Layer
(доступна в dbt platform и dbt Fusion; в dbt Core — с v1.12, май 2026) и
совместимый с ней «legacy» синтаксис (`semantic_models:` верхнего уровня),
который мы и используем для генерации файлов, т.к. он стабилен и однозначен.

---

## 0. Ментальная модель (зачем это нам)

```
   dbt model (таблица)         semantic model (семантика над таблицей)        metric            запрос
   ─────────────────           ──────────────────────────────────────        ──────            ──────
   fct_events  ───────►  entities (join-ключи) + dimensions + measures  ──►  simple/ratio/  ──►  dbt sl query
   dim_users   ───────►  entities (join-ключи) + dimensions             ──►  cumulative/...      (MetricFlow → SQL)
```

Ключевые тезисы:

1. **Semantic model** — это слой смысла над **одной** dbt-моделью (одной
   таблицей): он объявляет *join-ключи* (`entities`), *оси группировки*
   (`dimensions`) и *агрегируемые величины* (`measures`).
2. **Metric** — это то, что реально спрашивает пользователь (sum/ratio/
   cumulative/derived/conversion). Метрики строятся поверх measures и могут
   соединять несколько semantic models.
3. **MetricFlow** — движок, который из объявленных моделей и метрик **сам
   генерирует SQL** под конкретный диалект склада, включая join'ы между
   semantic models по совпадающим `entities`, разворачивание гранулярности
   времени, оконные функции для cumulative/conversion и т.д.
4. **Мы не пишем SQL.** Мы декларируем семантику и затем выполняем
   `dbt sl query --metrics ... --group-by ... --where ...`.

> Поэтому MCP-тулу достаточно сгенерировать **корректный YAML** semantic model +
> metrics, выполнить `dbt parse` (пересборка семантического манифеста) и затем
> `dbt sl query`. Вся «опасная» часть (SQL, join'ы, окна) — на стороне dbt.

---

## 1. Где объявляется и как «оживает»

### 1.1 Расположение файлов
Semantic models, dimensions, measures и metrics объявляются в **YAML** внутри
dbt-проекта (обычно в каталоге `models/…`, в `*.yml`-файлах). Семантические
объекты ссылаются на dbt-модель через `model: ref('<model_name>')`.

### 1.2 Жизненный цикл (важно для «на лету»)
```
0. (однократно) dbt run --select metricflow_time_spine   # материализовать time spine
1. Записать/обновить YAML semantic model + metrics
2. dbt parse                       # пересобирает target/semantic_manifest.json
3. mf query --metrics ...           # MetricFlow читает манифест и генерит SQL
```
- **`dbt parse` достаточно** для семантических правок — пересобирать все модели
  (`dbt run`) не нужно, **если** (а) базовые fct/dim-таблицы уже существуют в
  складе и (б) time spine уже материализован (см. §1.4). Time spine —
  исключение: его надо **построить `dbt run`** один раз заранее.
- `target/semantic_manifest.json` — артефакт, который читает MetricFlow.

**Изоляция параллельных «виртуальных» моделей.** Поскольку имена measures/metrics
**глобально уникальны** в проекте, а `semantic_manifest.json` один на проект,
несколько одновременно генерируемых наборов моделей нужно изолировать. dbt даёт
для этого штатные рычаги:
- `--target-path target/ctx/<id>` — отдельный каталог артефактов (свой
  `semantic_manifest.json`) на каждый прогон/контекст;
- `--project-dir <workspace>` — отдельный (оверлейный) проект, где поверх общих
  base-моделей лежат только модели данного контекста;
- неймспейсинг имён (префикс) — страховка от коллизий даже в общем проекте.

Эти механизмы — основа «контекстов выполнения» в дизайне MCP-тула
([`dbt-semantic-model-mcp-tool-design.md`](./dbt-semantic-model-mcp-tool-design.md), §3 «Контексты выполнения и изоляция»).

### 1.3 Два движка запроса
| Аспект | `dbt sl query` (platform / Fusion) | `mf query` (dbt Core, `pip install dbt-metricflow`) |
|---|---|---|
| Исполнение | удалённо в dbt platform | локально |
| Показать SQL | `--compile` | `--explain` |
| Экспорт CSV | — | `--csv file.csv` |
| Прочее | `--metrics/--group-by/--where/--order-by/--limit` идентичны; `--start-time/--end-time` — только `mf`/Core |

> Кроме CLI есть **GraphQL** и **JDBC** API dbt Semantic Layer (см. §7.3). Для
> MCP-сервера с локальной изоляцией по контексту основной движок — **`mf` (dbt
> Core)**: только он совместим с пер-контекстными `--project-dir`/`--target-path`.

### 1.4 Time spine — обязательная инфраструктура времени
MetricFlow требует **материализованную модель time spine** для: `metric_time`,
любых грейнов (`metric_time__day/week/...`), метрик `cumulative` и `conversion`.
- Объявляется в YAML (`time_spine` + модель `metricflow_time_spine`) и
  **строится `dbt run --select metricflow_time_spine`** (или seed) — `dbt parse`
  для неё **недостаточно**, нужна реальная таблица в складе.
- Для внутридневной детализации нужен дополнительный **sub-daily** time spine.
- Практический вывод для нашего домена: держать time spine как часть **базового**
  dbt-проекта, материализовать один раз; «на лету» создаются только семантические
  модели/метрики, а spine уже есть.

---

## 2. Semantic model — свойства верхнего уровня

```yaml
semantic_models:
  - name: <string>            # уникально в проекте; основа для имён join'ов
    description: <string>     # опц.
    label: <string>           # опц.: человекочитаемое имя для BI
    model: ref('<dbt_model>') # ОБЯЗАТЕЛЬНО: ровно одна dbt-модель (одна таблица)
    defaults:
      agg_time_dimension: <dimension_name>  # дефолтная ось времени для measures
    primary_entity: <string>  # опц.: если в таблице нет натурального PK
    config:                   # опц.
      meta: { <free-form> }   # произвольные метаданные
      enabled: <bool>         # опц.: включить/выключить SM
    entities:   [ ... ]       # join-ключи (см. §3)
    dimensions: [ ... ]       # оси группировки/фильтрации (см. §4)
    measures:   [ ... ]       # агрегаты (см. §5)
```

| Свойство | Обяз. | Назначение |
|---|---|---|
| `name` | да | Уникальное имя semantic model в проекте. |
| `model` | да | `ref('...')` на **одну** dbt-модель. SM = семантика над одной таблицей. |
| `description` | нет | Документация. |
| `label` | нет | Человекочитаемое имя для отображения в BI. |
| `defaults.agg_time_dimension` | усл. | Какую time-dimension использовать как ось времени по умолчанию для measures, если у самого measure не указана `agg_time_dimension`. |
| `primary_entity` | усл. | Синтетический первичный ключ модели, если среди `entities` нет `type: primary`. Нужен, когда у таблицы нет естественного PK (типично для таблицы событий). |
| `config.meta` | нет | Произвольные метаданные (пробрасываются в манифест/BI). |
| `config.enabled` | нет | Булев флаг включения semantic model. |
| `entities` | да* | Список join-ключей. |
| `dimensions` | нет | Список измерений. |
| `measures` | нет | Список мер. |

> **Ограничение №1:** один semantic model = одна dbt-модель. Соединение данных
> из двух таблиц (события + атрибуты юзера) делается **не** join'ом в SQL, а
> через **совпадающие entities** в двух разных semantic models — MetricFlow
> построит join сам.

---

## 3. Entities — join-ключи

```yaml
entities:
  - name: <string>     # уникально в пределах SM; имя, по которому идёт join
    type: primary | unique | foreign | natural
    expr: <string>     # опц.: колонка или SQL-выражение, если name ≠ имя колонки
    label: <string>    # опц.: человекочитаемое имя для BI
    role: <string>     # опц.: role-playing — переименование одной сущности под
                       #       разные роли (напр. ordered_at_entity vs delivered_at_entity)
```

> `role` нужен, когда одна и та же физическая сущность участвует в нескольких
> ролях/путях join (role-playing dimensions/entities) — позволяет различать их в
> группировках (`ordered_at_entity__…` vs `delivered_at_entity__…`).

### 3.1 Типы entity (enum)
| `type` | Семантика | Null | Уникальность |
|---|---|---|---|
| `primary` | ровно одна запись на строку, покрывает все строки таблицы | нельзя | уникален |
| `unique` | одна запись на строку, но возможно подмножество строк | можно | non-null значения уникальны |
| `foreign` | ссылка на строку в другой таблице; 0..N вхождений | можно | не обязателен |
| `natural` | «естественный» ключ из реальных данных | — | **только для SCD type II** |

### 3.2 Как entities соединяют модели
- Join между semantic models идёт **по совпадающему имени entity**.
- Один `primary`/`unique` ключ может присоединяться к нескольким `foreign`.
- Пример нашего домена: `dim_users` объявляет `user` как `primary`, а
  `fct_events` объявляет `user` как `foreign (expr: user_id)`. Тогда любая
  метрика по событиям может группироваться/фильтроваться по атрибутам юзера —
  MetricFlow присоединит `dim_users` автоматически.
- Составной (суррогатный) ключ: перечисление колонок через `|`, напр.
  `expr: date_key | brand_code`.

```yaml
entities:
  - name: event        # синтетический PK события (через primary_entity на SM)
    type: primary
  - name: user
    type: foreign
    expr: user_id
  - name: session
    type: foreign
    expr: session_id
```

### 3.3 Join'ы между несколькими semantic models (entity-graph)

> **Главный принцип организации многих dbt-моделей:** *один semantic model = одна
> dbt-модель*. Несколько таблиц (события + атрибуты юзера + справочники) — это
> **несколько semantic models**, которые MetricFlow **соединяет сам** по
> совпадающим `entities`. Никакого `JOIN` в YAML/SQL руками не пишется.

**Граф соединений.** MetricFlow строит граф: *узлы* — semantic models, *рёбра* —
join-пути через entities. Когда в запросе встречаются метрика из одной модели и
измерение из другой, движок находит путь в графе и генерирует нужный join.

**Матрица допустимости join (по типам entity).** Соединять можно **только на
`primary` или `unique` ключ** — `foreign` не может быть целью join:

| Entity в таблице A | Entity в таблице B | Join | Допустимо |
|---|---|---|---|
| primary | primary | left | ✅ |
| primary | unique | left | ✅ |
| unique | unique | left | ✅ |
| foreign | primary | left | ✅ |
| foreign | unique | left | ✅ |
| primary | foreign | fan-out | ❌ |
| unique | foreign | fan-out | ❌ |
| foreign | foreign | fan-out | ❌ |

- **fct + dim** → **left join** (сохраняются все строки «базовой» таблицы).
- **несколько fct-моделей** → **full outer join** (чтобы не потерять данные).
- Наш случай: `fct_analytics_events.user` (`foreign`) → `dim_users.user`
  (`primary`) = валидный left join. Метрика по событиям свободно группируется по
  атрибутам юзера.

**Квалификация измерений через путь entity.** Измерение из присоединённой модели
адресуется как `<entity>__<dimension>` (напр. `user__country`,
`order_id__is_food_order`).

**Multi-hop (несколько переходов).** Можно пройти по графу до **3 таблиц / 2
переходов**. Синтаксис: `entity_path__dimension_name`.
- Схема `events → users → campaigns`: ✅ `user__campaign__channel` (2 перехода).
- Глубже 2 переходов (3 join-а) — ❌ (запрещено во избежание неоднозначности).

**Защита от fan-out / chasm.** Многие-ко-многим и размножение строк блокируются
самой матрицей типов entity; перед выполнением MetricFlow делает семантическую
валидацию (`explain`-запрос к складу), проверяя существование колонок и
отсутствие неоднозначных путей.

**Вывод для дизайна MCP.** Чтобы задействовать N dbt-моделей в одной задаче,
нужно иметь N semantic models с согласованными entities. Тул может:
- **ссылаться** на уже существующие (стабильные) semantic models базовых моделей;
- **генерировать** дополнительные semantic models для других dbt-моделей на лету;
- объявлять метрики, которые MetricFlow сам «сошьёт» join'ами по графу entity.

---

## 4. Dimensions — оси группировки и фильтрации

```yaml
dimensions:
  - name: <string>           # уникально в пределах SM
    type: categorical | time
    description: <string>    # опц.: документация
    label: <string>          # опц.: человекочитаемое имя для BI
    expr: <string>           # опц.: SQL-выражение, если ≠ прямой колонке
    is_partition: <bool>     # опц.: пометка партиционирующей колонки (time)
    type_params:             # для type: time (time_granularity фактически обязателен)
      time_granularity: day | week | month | quarter | year   # (+ hour/sub-daily, см. §4.2)
      validity_params:       # только для SCD type II
        is_start: <bool>     # колонка valid_from
        is_end:   <bool>     # колонка valid_to
```

### 4.1 Типы dimension (enum)
- **`categorical`** — атрибут для группировки/сегментации (страна, платформа,
  имя события, признак `is_bulk` и т.п.). Может быть выражением:
  ```yaml
  - name: is_high_score
    type: categorical
    expr: "case when score > 1000 then true else false end"
  ```
- **`time`** — временная ось. Минимум одна time-dimension нужна, чтобы
  существовала `metric_time` (виртуальная общая ось времени MetricFlow).
  ```yaml
  - name: event_time
    type: time
    type_params:
      time_granularity: day
    is_partition: true
  ```

### 4.2 `time_granularity` (enum)
**Стандартные** (всегда доступны): `day`, `week`, `month`, `quarter`, `year`.

Дополнительно:
- **sub-daily** (`hour` и мельче) — поддерживается **только при наличии
  специального sub-daily time spine** и при поддержке складом; это не «обычные»
  значения enum. `minute`/`second` документированы слабо и требуют такого
  time spine — для событийной аналитики внутри дня сначала готовится sub-daily
  time spine. Значения `nanosecond/microsecond/millisecond` **не входят** в
  модель гранулярностей dbt — не использовать.
- **custom granularities** (напр. `fiscal_year`, `fiscal_week`) — задаются в
  конфиге time spine через `custom_granularities` и затем доступны как грейн.

> Для нашего домена событий безопасный дефолт — хранить time-dimension с грейном
> `day` (а где нужна внутридневная детализация — поднять sub-daily time spine).
> `time_granularity` задаёт **минимальный** грейн; в запросе агрегируем только до
> **более крупного** (`metric_time__week`, `metric_time__month`, …).
> Для `time`-dimension `time_granularity` фактически **обязателен**.

### 4.3 `validity_params` (SCD Type II)
Для медленно меняющихся измерений: ровно одна колонка `is_start: true`
(valid_from) и одна `is_end: true` (valid_to); entity такой модели должна быть
`type: natural`. Для нашего домена обычно не нужно (атрибуты юзера — срез на
момент установки), но включено в спецификацию для полноты.

---

## 5. Measures — агрегируемые величины

```yaml
measures:
  - name: <string>              # уникально ВО ВСЁМ проекте (не только в SM)
    agg: <aggregation_type>     # обязательно (см. §5.1)
    expr: <string>              # опц.: колонка/выражение для агрегации
    description: <string>       # опц.
    label: <string>             # опц.
    agg_time_dimension: <name>  # опц.: ось времени для этого measure
    create_metric: <bool>       # опц.: авто-создать simple-метрику из measure
    agg_params:                 # опц.: параметры для percentile
      percentile: <0..1>
      use_discrete_percentile: <bool>   # true=дискретный, false=непрерывный
      use_approximate_percentile: <bool>
    non_additive_dimension:     # опц.: не аддитивная по времени мера (см. §5.2)
      name: <time_dimension_name>
      window_choice: min | max
      window_groupings: [ <entity>, ... ]
    config:
      meta: { <free-form> }
```

### 5.1 `agg` (enum) — типы агрегации
| `agg` | Что делает |
|---|---|
| `sum` | сумма значений |
| `min` | минимум |
| `max` | максимум |
| `average` | среднее |
| `median` | медиана (p50) |
| `percentile` | перцентиль (через `agg_params.percentile`) |
| `count_distinct` | число уникальных значений (напр. уникальные `user_id`) |
| `sum_boolean` | сумма булевых (подсчёт `true`) — удобно для флагов/«сделал событие» |
| `count` | количество строк/событий |

Примеры:
```yaml
measures:
  - name: events_count
    agg: count
    expr: 1
  - name: unique_users
    agg: count_distinct
    expr: user_id
  - name: revenue_usd
    agg: sum
    expr: revenue            # после распаковки из event_properties
  - name: p95_score
    agg: percentile
    expr: score
    agg_params: { percentile: 0.95, use_discrete_percentile: false }
  - name: payers_flag
    agg: sum_boolean
    expr: "case when event_name = 'purchase' then true else false end"
```

### 5.2 `non_additive_dimension`
Для мер, которые **нельзя суммировать по времени** (классика — MRR/баланс).
`window_choice: max` берёт значение на конец периода; `window_groupings`
ограничивает «снимок» по сущностям (напр. на каждого `user_id`).

### 5.3 Важные ограничения
- Имена measures **глобально уникальны** в проекте и не должны совпадать с
  именами entities/dimensions. Для «виртуальных» моделей это решается
  **неймспейсингом по имени задачи** (префикс).
- `expr` — это **нативный SQL диалекта склада**. Распаковка JSON-свойств
  (`event_properties`) делается здесь (напр. Postgres `(event_properties->>'level')::int`,
  BigQuery `JSON_VALUE(event_properties, '$.level')`).

> **Примечание dbt:** measures постепенно мигрируют в «simple»-метрики под
> ключом `metrics:`. Для генерации файлов мы используем классический
> `measures:` + `metrics:` — он стабилен и однозначно поддерживается MetricFlow.

---

## 6. Metrics — то, что спрашивает пользователь

```yaml
metrics:
  - name: <string>
    description: <string>     # опц.
    label: <string>           # опц.
    type: simple | ratio | cumulative | derived | conversion
    type_params: { ... }      # зависит от type (см. ниже)
    filter: |                 # опц.: предикат на jinja-объектах (см. §6.6)
      {{ Dimension('user__country') }} = 'US'
    config:
      meta: { <free-form> }
      group: <string>         # опц.: логическая группа метрик
```

### 6.1 `simple` — обёртка над одним measure
```yaml
- name: total_revenue
  type: simple
  type_params:
    measure:
      name: revenue_usd
      filter: "{{ Dimension('event__event_name') }} = 'purchase'"  # опц.
      fill_nulls_with: 0                                            # опц.
      join_to_timespine: true                                      # опц.
```

### 6.2 `ratio` — отношение двух **метрик**
> Важно: `numerator`/`denominator` ссылаются на **метрики**, а не на measures
> напрямую. В классическом подходе сначала оборачиваем нужный measure в
> `simple`-метрику, затем ссылаемся на неё. Доступны `name`, `filter`, `alias`
> (alias нужен, если одна метрика используется дважды с разными фильтрами).
```yaml
# сперва simple-метрики поверх measures:
- name: revenue_metric
  type: simple
  type_params: { measure: { name: revenue_usd } }
- name: payers_metric
  type: simple
  type_params: { measure: { name: payers } }   # count_distinct(user_id), filter=purchase
# затем отношение метрик:
- name: arppu
  type: ratio
  type_params:
    numerator:   { name: revenue_metric }
    denominator: { name: payers_metric }
  # у numerator/denominator допустимы свои filter и alias
```

### 6.3 `cumulative` — накопление по времени
```yaml
- name: rolling_7d_revenue
  type: cumulative
  type_params:
    measure: { name: revenue_usd }
    cumulative_type_params:
      window: "7 days"          # скользящее окно; без него — накопление за всё время
      grain_to_date: month      # ИЛИ накопление с начала грейна (сбрасывается)
      period_agg: first | last | average   # как реагрегировать в периоде
```
- `window` — формат `"<n> <granularity>"`: `"7 days"`, `"1 month"`.
- При заданном `window` в запросе **обязательно** должна быть `metric_time`.
- **Предусловие:** для cumulative (как и для любых `metric_time`/грейнов и для
  conversion) в проекте **должен существовать материализованный time spine**
  (см. §1.4). Без него запрос упадёт.

### 6.4 `derived` — формула над другими метриками
```yaml
- name: arpdau
  type: derived
  type_params:
    expr: "revenue / nullif(dau, 0)"
    metrics:
      - name: revenue_usd
        alias: revenue
      - name: dau
      # у каждого input-метрика можно задать filter/offset_window
```

### 6.5 `conversion` — конверсия между двумя событиями
```yaml
- name: visit_to_purchase
  type: conversion
  type_params:
    conversion_type_params:
      base_measure:       { name: visits }
      conversion_measure: { name: purchases }
      entity: user                          # ключ, связывающий два события
      window: "7 days"                      # окно конверсии
      calculation: conversion_rate | conversion   # доля (по умолч.) или сырое число
      constant_properties:                  # опц.: что должно совпасть в обоих событиях
        - base_property: product_id
          conversion_property: product_id
      fill_nulls_with: 0                     # опц.
```

### 6.6 `filter` — единый язык предикатов (jinja-объекты)
Фильтры метрик и `--where` в запросе пишутся через типобезопасные «обёртки»:
| Обёртка | Для чего | Пример |
|---|---|---|
| `Dimension('<entity>__<dim>')` | категориальное измерение | `{{ Dimension('user__country') }} = 'US'` |
| `TimeDimension('<name>', '<grain>')` | временное измерение | `{{ TimeDimension('metric_time', 'week') }} >= '2026-01-01'` |
| `Entity('<entity>')` | значение ключа | `{{ Entity('user') }} = '...'` |
| `Metric('<name>', group_by=[...])` | метрика-как-измерение в фильтре | `{{ Metric('purchases', group_by=['user']) }} > 5` |

> Имя измерения в фильтре квалифицируется именем entity, через который оно
> доступно: `user__country`, `event__event_name`, `metric_time`.
>
> **Ограничения `Metric(...)` в фильтре:** в `group_by` допускается **ровно одна
> сущность** (несколько не поддерживается), и она должна агрегироваться до
> грейна, который join'ится к внешнему запросу **без размножения строк**
> (иначе fan-out). Напр. для запроса по аккаунтам `group_by=['account']`
> валидно, а `group_by=['model']` — нет.

---

## 7. Запрос к семантическому слою

> **Движок.** `dbt sl query` — команда **dbt platform** (исполняется удалённо в
> dbt Cloud/Fusion). Локально (dbt Core, `pip install dbt-metricflow`)
> используется **`mf query`**. Поскольку наш MCP-дизайн опирается на локальную
> файловую изоляцию по контексту, **основной движок — `mf query` (dbt Core)**.
> Ниже — пример на `mf query`.

```bash
mf query \
  --metrics total_revenue,dau \
  --group-by metric_time__day,user__country \
  --where "{{ Dimension('user__acquisition_type') }} = 'paid'" \
  --where "{{ TimeDimension('metric_time','day') }} >= '2026-01-01'" \
  --order-by -metric_time__day \
  --limit 100 \
  --start-time '2026-01-01' --end-time '2026-03-31' \
  --explain     # показать сгенерированный SQL (dbt platform: dbt sl query --compile)
```

| Параметр | Назначение |
|---|---|
| `--metrics` | список метрик через запятую, без пробелов |
| `--group-by` | измерения/entities; время с грейном: `metric_time__month` |
| `--where` | предикат(ы) на jinja-обёртках (§6.6); можно несколько |
| `--order-by` | сортировка; префикс `-` = DESC |
| `--limit` | лимит строк (дефолт 100) |
| `--start-time` / `--end-time` | ISO8601, включительно — диапазон по `metric_time`. **Доступно только в `mf`/dbt Core**, в dbt platform пока нет |
| `--explain` / `--compile` | показать SQL: `mf --explain` / platform `--compile` |
| `--csv FILE` | экспорт в CSV (только `mf`) |
| `--saved-query` | выполнить предопределённый saved query |
| `--decimals`, `--show-sql-descriptions`, `--display-plans` | округление / описания / визуализация плана |

### 7.1 Сопутствующие команды (интроспекция и валидация)
Полезны для MCP-тула (grounding и проверка перед запросом):
- `mf list metrics`, `mf list dimensions --metrics <m>`, `mf list dimension-values`,
  `mf list entities`, `mf list saved-queries` — что доступно для запроса;
- `mf validate-configs` (Core) / `dbt sl validate` (platform) — семантическая
  валидация моделей/метрик **до** запроса;
- `mf health-checks` — проверка соединения со складом.

### 7.2 Saved queries (опц.)
Запрос можно зафиксировать как объект `saved_queries:` в YAML и выполнять по
имени (`--saved-query`) или материализовать как экспорт:
```yaml
saved_queries:
  - name: paid_revenue_daily
    query_params:
      metrics: [total_revenue]
      group_by: ["TimeDimension('metric_time','day')", "Dimension('user__country')"]
      where: ["{{ Dimension('user__acquisition_type') }} = 'paid'"]
      order_by: ["-metric_time__day"]
      limit: 1000
    exports:
      - name: paid_revenue_daily
        config: { export_as: table, schema: analytics, alias: paid_revenue_daily }
```
Материализация: `dbt build --resource-type saved_query` / `dbt sl export`.

### 7.3 Программные API
Кроме CLI, dbt Semantic Layer отдаёт **GraphQL** и **JDBC** API (а также Python
SL-клиент) для запуска запросов программно. Для MCP-сервера, чья задача —
«выполнить запрос», это часто более удобная интеграционная поверхность, чем CLI
(особенно в dbt platform-варианте). Выбор интеграции — см. дизайн тула.

---

## 8. Сводные enum'ы (для проектирования схемы тула)

| Концепт | Допустимые значения |
|---|---|
| `entity.type` | `primary`, `unique`, `foreign`, `natural` |
| `dimension.type` | `categorical`, `time` |
| `time_granularity` | **стандартные:** `day`, `week`, `month`, `quarter`, `year`; `hour`/sub-daily — только с sub-daily time spine; custom (`fiscal_*`) — через time spine. `nanosecond/microsecond/millisecond` — НЕ поддерживаются |
| `measure.agg` | `sum`, `min`, `max`, `average`, `median`, `percentile`, `count_distinct`, `sum_boolean`, `count` |
| `metric.type` | `simple`, `ratio`, `cumulative`, `derived`, `conversion` |
| `cumulative.period_agg` | `first`, `last`, `average` |
| `conversion.calculation` | `conversion_rate`, `conversion` |
| `non_additive.window_choice` | `min`, `max` |
| фильтр-обёртки | `Dimension`, `TimeDimension`, `Entity`, `Metric` |

---

## 9. Ограничения и подводные камни (учесть в туле)

1. **1 SM = 1 dbt-модель.** Соединение событий и атрибутов юзера — только через
   общий entity `user`, а не через join в SQL.
2. **Глобальная уникальность имён** measures/metrics (и неконфликт с
   entity/dimension именами) → неймспейсить «виртуальные» объекты префиксом.
3. **`metric_time`** появляется только если есть хотя бы одна `time`-dimension;
   для `cumulative` с `window` она обязательна в запросе.
4. **`expr` — это SQL диалекта склада**, особенно для распаковки JSON
   (`event_properties`). Маппинг логическое-имя → выражение должен жить в
   конфиге, а не угадываться AI.
5. **`dbt parse` обязателен** после записи/изменения YAML, иначе запрос увидит
   старый манифест. **Но** этого достаточно только для семантики над уже
   существующими таблицами — **time spine нужно материализовать `dbt run`** (§1.4).
6. **Time spine — жёсткое предусловие** для `metric_time`, любых грейнов,
   `cumulative` и `conversion`. Без материализованного time spine эти запросы
   падают.
7. **`dbt sl query` ≠ локальная команда.** Это dbt platform (удалённо); локально
   — `mf query` (dbt Core). Локальная файловая изоляция совместима только с `mf`.
8. **Версии.** «Последняя» YAML-спецификация — dbt Core v1.12 (май 2026)/Fusion;
   мы генерируем **legacy**-форму (`semantic_models:`/`measures:`/`metrics:`).
   Зафиксировать матрицу версий dbt + adapter + `dbt-metricflow`, на которой это
   проверено, и держать снапшот-тест `dbt parse` + `mf validate-configs`.
9. **Read-only.** Семантический слой только читает; запись/DDL отсутствуют.

> **Legacy ↔ Latest.** В новой (v1.12+) спецификации measures сворачиваются в
> `simple`-метрики, SM встраиваются в YAML модели (`models: → semantic_model:`),
> `time_granularity` → `granularity`, перцентиль — `percentile`+`percentile_type`,
> а cumulative/ratio/derived/conversion ссылаются на метрики через
> `input_metric(s)`/`base_metric`/`conversion_metric` (а не `measure`). Мы
> сознательно используем legacy-форму ради стабильности — при апгрейде dbt
> сверять, что выбранная версия её ещё принимает.

---

## Источники

- [dbt — Semantic models](https://docs.getdbt.com/docs/build/semantic-models)
- [dbt — Entities](https://docs.getdbt.com/docs/build/entities)
- [dbt — Dimensions](https://docs.getdbt.com/docs/build/dimensions) · [Dimension properties](https://docs.getdbt.com/reference/dimension-properties)
- [dbt — Measures](https://docs.getdbt.com/docs/build/measures)
- [dbt — Metrics overview](https://docs.getdbt.com/docs/build/metrics-overview)
- [dbt — Conversion metrics](https://docs.getdbt.com/docs/build/conversion) · [Cumulative metrics](https://docs.getdbt.com/docs/build/cumulative)
- [dbt — Metrics as dimensions / filters](https://docs.getdbt.com/docs/build/ref-metrics-in-filters)
- [dbt — MetricFlow commands](https://docs.getdbt.com/docs/build/metricflow-commands)
- [dbt — About MetricFlow](https://docs.getdbt.com/docs/build/about-metricflow) · [Time spine & custom granularities](https://docs.getdbt.com/docs/build/metricflow-time-spine)
- [dbt — Semantic layer reference](https://docs.getdbt.com/reference/semantic-layer-reference)
