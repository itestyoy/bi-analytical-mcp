# Схема для acquisition и crashlytics — шаблон

Как объявить в dbt-схеме два источника, которые не являются продуктовыми событиями:
**crashlytics** (отчёты о падениях — второй, равноправный источник событий) и
**acquisition** (расходы на привлечение — источник МЕР, без событий вообще).

Шаблоны ниже копируются в `schema.yml` вашего dbt-проекта (или в `config/catalog.yml`,
если каталог ведётся отдельным файлом) и правятся под реальные имена колонок. Всё, что
здесь объявлено, сервер читает сам — в `src/` нет ни одного места, где были бы зашиты
имена этих колонок, мер или связей.

Проверено на живом складе: `test/integration/fixtures/catalog.yml` — это ровно эти два
шаблона, заполненные, и на них гоняются 50 сценариев в
`test/integration/declared-joins.test.js`.

---

## 0. Роль — это идентичность источника

Источник опознаётся по `meta.mcp.role`, а не по имени модели. Модель может называться
как угодно; ровно одна модель на роль.

| роль | что это | опознаётся по |
|---|---|---|
| `events` | продуктовые события, одна строка = одно событие | `is_event_name` + `is_time` |
| `crashlytics` | **второй источник событий**, независимый и равноправный | то же самое |
| `users` | запись об установке, одна строка на игрока (или на версию, если SCD-2) | — |
| `experiments` | назначения A/B, одна строка на игрок×эксперимент | — |
| `acquisition` | **источник мер**: строки — это суммы, а не события | `is_time` + `measure`, и НЕТ `event_name` |

Два источника событий (`events` и `crashlytics`) **равноправны**: у каждого свой
`known_events`, свои событийные свойства `*_of_event_data`, свой `primary_entity` и своё
место в индексе значений по ключу `(source, property)`. Ни один не «главный». Поэтому
источник всегда идёт **отдельным аргументом**:
`semantic_index({ source, event })`, `build_native_model({ source })`,
`semantic_models[].from` — и никогда не приклеивается к имени.

---

## 1. Что проверяется при загрузке каталога

Каждое правило падает на загрузке с внятным сообщением, а не молчаливо неверным
результатом. Точные тексты — чтобы можно было искать по ним.

| # | правило | сообщение при нарушении |
|---|---|---|
| 1 | у каждой модели есть `meta.mcp.role` | `catalog model '…' is missing meta.mcp.role` |
| 2 | ровно одна модель на роль | `more than one model declares role '…'` |
| 3 | источник событий обязан объявить колонку имени события | `fact model '…' declares no event_name column` |
| 4 | …и колонку времени | `fact model '…' declares no time column` |
| 5 | `primary_entity` уникален по всему каталогу | `models '…' and '…' both declare primary entity '…'` |
| 6 | сущностью владеет ровно одна модель (`primary`/`unique`) | `models '…' and '…' both OWN entity '…'` |
| 7 | обе стороны связи собраны из одинакового числа частей | `entity '…' is declared with N key part(s) on '…' but M on '…'` |
| 8 | тип сущности из набора `primary \| unique \| foreign \| natural` | `unknown entity type '…' — use one of: …` |
| 9 | у `primary`-сущности не бывает вариантов | `a primary entity is the model's single identity and cannot have variants` |
| 10 | у модели одна `primary`-сущность | `model '…' declares two primary entities` |
| 11 | модель с окном валидности не владеет вторым ключом | `declares a validity window … and also owns join key(s) '…' as primary/unique` |
| 12 | колонка ключа существует в модели | `'…' is not a column of the model` |
| 13 | агрегация из поддерживаемого набора | `unknown aggregation '…' — use one of: sum, average, min, max, count, count_distinct, sum_boolean, median, percentile` |
| 14 | `meta.mcp.measure` — это `true` или объект | `meta.mcp.measure must be true, or an object with unit/label/description` |
| 15 | в именах колонок нет `__` (зарезервировано MetricFlow) | `contain '__', which MetricFlow reserves as the entity/dimension separator` |

Про правило 15: вместо `event_data__price_in_usd` пишется перевёрнутая форма
`price_in_usd_of_event_data`.

---

## 2. Crashlytics — шаблон

Второй источник событий. Отличий от продуктового ровно два: свой `primary_entity`
(не `event`) и свой словарь событий.

```yaml
  - name: fct_crashlytics_events            # TODO: реальное имя dbt-модели
    description: >
      Crash-reporting events fact — one row per crash / non-fatal error / ANR reported from
      the player's device. A SEPARATE stream from the analytics fact: its own events and its
      own event-scoped payload. Joins to dim_users by the player key.
    meta:
      mcp:
        role: crashlytics
        primary_entity: crash               # MUST differ from every other model's
        partition_column: event_date        # TODO: the real partition column (cost hint)
        event_semantics:
          crash_event: fatal_crash          # which event marks a hard crash
        known_events:                       # TODO: the real event_name values
          - fatal_crash
          - non_fatal
          - anr
        entities:
          # The crash row records the LAST ad funnel of each format seen before the app died —
          # one column per format, only the one in play populated. They are VARIANTS of one
          # relationship, so the caller picks the format the question is about:
          #   ad_funnel_rewarded / ad_funnel_interstitial / ad_funnel_banner
          # Joining it to the events source reconstructs the funnel that was running.
          # NOBODY owns this key: one funnel id spans SEVERAL events, so neither side is
          # unique on it and MetricFlow cannot join it — it is a PIPELINE join only.
          ad_funnel:
            type: foreign
            variants:
              rewarded:     { key: [rewarded_tracking_id, player_id_of_internal] }
              interstitial: { key: [interstitial_tracking_id, player_id_of_internal] }
              banner:       { key: [banner_tracking_id, player_id_of_internal] }
    columns:
      # ── the three role columns ──────────────────────────────────────────────────
      - name: player_id_of_internal
        data_type: string
        description: "Player identifier; joins crash reports to dim_users."
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - name: event_time                    # TODO: the real crash-time column
        data_type: timestamp
        description: "When the crash was reported — the metric time axis of THIS fact."
        meta: { mcp: { is_time: true } }
      - name: event_name
        data_type: string
        description: "Crash event type; always one of known_events."
        meta: { mcp: { is_event_name: true } }

      # ── ids: referenceable, but there is no value set worth profiling ───────────
      - name: crash_id
        data_type: string
        description: "Crash report identifier (one row per report)."
        meta: { mcp: { index: false } }
      - name: rewarded_tracking_id
        data_type: string
        description: "Last REWARDED ad funnel seen before the crash; NULL if there was none."
        meta: { mcp: { index: false } }
      - name: interstitial_tracking_id
        data_type: string
        description: "Last INTERSTITIAL ad funnel seen before the crash; NULL if there was none."
        meta: { mcp: { index: false } }
      - name: banner_tracking_id
        data_type: string
        description: "Last BANNER ad funnel seen before the crash; NULL if there was none."
        meta: { mcp: { index: false } }

      # ── envelope columns: present on EVERY row → plain groupable attributes ─────
      - name: app_version
        data_type: string
        description: "App version the crash was reported from. Present on every crash row."
        meta: { mcp: { dimension: {} } }
      - name: bundle_id
        data_type: string
        description: "The app the crash came from. Present on every crash row."
        meta: { mcp: { dimension: { bundle: true } } }   # per-app coverage for THIS fact

      # ── event-scoped PAYLOAD: populated only on the listed events, NULL elsewhere ─
      - name: issue_title_of_event_data
        data_type: string
        description: "Crashlytics issue title (the grouping key of a crash). Events: all."
        meta: { mcp: { events: [fatal_crash, non_fatal, anr] } }
      - name: is_fatal_of_event_data
        data_type: boolean
        description: "Whether the report crashed the app. Events: fatal_crash, non_fatal."
        meta: { mcp: { events: [fatal_crash, non_fatal] } }
      - name: anr_duration_of_event_data
        data_type: numeric
        description: "How long the main thread was blocked, in seconds. Events: anr ONLY."
        meta: { mcp: { unit: seconds, events: [anr] } }
      - name: crash_message_of_event_data
        data_type: string
        description: "Exception message of the crash. Events: fatal_crash ONLY."
        meta: { mcp: { events: [fatal_crash] } }

      # ── a COMPLEX (array) payload property — explode it with an unnest stage ────
      - name: breadcrumbs_of_event_data
        data_type: string
        description: >
          Breadcrumb trail leading up to the report — a JSON array of strings, in order.
          Events: all crash events.
        meta:
          mcp:
            events: [fatal_crash, non_fatal, anr]
            array: { items: string, encoding: json }
```

**На что смотреть при заполнении**

- `primary_entity: crash` — не `event`. Иначе правило 5.
- `events: [...]` на каждой payload-колонке — это её область: на остальных событиях она
  читается NULL. Индекс значений использует это, чтобы отличать «ожидаемый NULL» от дыры
  в данных.
- Формат `<имя>_of_event_data` — не `event_data__<имя>` (правило 15).
- Варианты `ad_funnel` — если у вас один столбец tracking id, а не три, объявляйте его
  плоско, без `variants`: `ad_funnel: { type: foreign, key: [tracking_id, player_id_of_internal] }`.

---

## 3. Acquisition — шаблон

Источник **мер**: `event_name` нет, поэтому это не источник событий. Но своя ось времени
и свои суммы есть, и объявляются они здесь же.

Ключевой принцип: **схема помечает, ЧТО можно агрегировать; функцию выбирает вызывающий.**
Одна и та же колонка сегодня суммируется, завтра читается на p90.

```yaml
  - name: fct_player_acquisition            # TODO: реальное имя dbt-модели
    description: >
      Player-level acquisition spend: one row per (player, day) with the cost, impressions
      and clicks attributed to that player. Amounts are MEASURES (aggregate them); the channel
      columns are attributes (group by them). Joins to dim_users and to the events sources by
      the player key.
    meta:
      mcp:
        role: acquisition
        primary_entity: acquisition         # MUST differ from every other model's
        partition_column: spend_date        # TODO: the real partition column (cost hint)
        # A model-level entry is an aggregatable EXPRESSION over the model's columns. Like a
        # marked column it fixes NO function — the caller picks one per question.
        measures:
          cost_per_click: { expr: "cost / nullif(clicks, 0)", unit: usd, description: "Per-row cost per click." }
    columns:
      # ── grain + join keys ───────────────────────────────────────────────────────
      - name: acquisition_id                # TODO: surrogate key of the (player, day) grain
        data_type: string
        description: "Surrogate key of the (player, day) row."
        meta: { mcp: { entity: { name: acquisition, type: primary } } }
      - name: player_id_of_internal
        data_type: string
        description: "Player the spend is attributed to; joins to dim_users and the events sources."
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - name: spend_date
        data_type: timestamp
        description: "The day the spend was recorded — this source's time axis."
        meta: { mcp: { is_time: true } }

      # ── AMOUNTS: aggregatable, never groupable. NO function is fixed here ───────
      - name: cost
        data_type: numeric
        description: "Acquisition cost attributed to the player on that day."
        meta: { mcp: { measure: { unit: usd, label: "UA cost" } } }
      - name: impressions
        data_type: integer
        description: "Ad impressions that led to the attribution, that day."
        meta: { mcp: { measure: true } }
      - name: clicks
        data_type: integer
        description: "Ad clicks that led to the attribution, that day."
        meta: { mcp: { measure: true } }

      # ── ATTRIBUTES: groupable ───────────────────────────────────────────────────
      - name: media_source
        data_type: string
        description: "Acquisition channel the spend was booked against."
      - name: campaign
        data_type: string
        description: "Campaign name the spend was booked against."
      - name: campaign_id
        data_type: string
        description: "Campaign id — groupable, but an id has no value set worth profiling."
        meta: { mcp: { index: false } }
      - name: ingest_batch_id
        data_type: string
        description: "Loader batch id — a real column a pipeline can reference, but not an attribute."
        meta: { mcp: { dimension: false } }
```

### Четыре ключа, которые всё решают

| ключ | где | что делает |
|---|---|---|
| `measure: true` \| `{ unit, label, description }` | на колонке | **помечает колонку суммой.** Агрегируется любой функцией, выбранной вызывающим. Сумма — не атрибут, поэтому колонка перестаёт быть группируемой и не профилируется индексом значений |
| `measures: { <имя>: { expr, … } }` | на модели | то же для агрегируемого **выражения** над колонками. Функция так же не фиксируется |
| `dimension: false` | на колонке | настоящая колонка, но **не атрибут**: pipeline её видит, группировать по ней нельзя |
| `index: false` | на колонке | группировать можно, **профилировать не надо** (id) |

### Когда всё-таки фиксировать функцию

Добавьте `agg` (и при желании `name`) в объявление — это **опт-ин**: дополнительно
публикуется управляемая мера с раз и навсегда заданной функцией, одинаковой для всех.
Свободный выбор функции над сырой колонкой при этом остаётся.

```yaml
      - name: impressions
        data_type: integer
        meta: { mcp: { measure: { agg: sum, name: total_impressions } } }
```

Допустимые значения `agg`: `sum`, `average`, `min`, `max`, `count`, `count_distinct`,
`sum_boolean`, `median`, `percentile` (для последнего нужен ещё `percentile: 0.9`).

---

## 4. Связи: объявляются в схеме, никогда не в вызове

Модель объявляет ключ **один раз**, и оба пути читают одно и то же объявление: запрос
метрики группирует по `<связь>__<атрибут>`, pipeline соединяет через `via: <связь>`.
Ни один из них не повторяет имя колонки.

```yaml
    meta:
      mcp:
        entities:
          <имя связи>:
            type: primary | unique | foreign | natural
            key:  [<колонка>, …]        # одна колонка или несколько для составного ключа
```

Стороны могут называть свои колонки по-разному — совпасть должны только имя связи и
**число частей ключа** (правило 7).

### Кто с кем соединяется

| откуда | куда | по чему | каким путём |
|---|---|---|---|
| acquisition | events / crashlytics | `user` (игрок) | pipeline `via: 'user'` — соединение **многие-ко-многим** по своей природе |
| acquisition | users (installs) | `user` **+ окно валидности** | governed сам, pipeline — через `between` |
| events / crashlytics | users (installs) | `user` **+ окно валидности** | то же |
| crashlytics | events | `ad_funnel_<формат>` | **только pipeline** — ключом никто не владеет |
| events / crashlytics | experiments | `user` | оба пути |

Про строку 1: пара «событие × строка расхода» размножается намеренно — у игрока много
событий и несколько дней расходов. Суммировать деньги по такому соединению **нельзя**
(в фикстуре это 267.75 вместо 17.50); оно годится, чтобы протащить атрибут канала к
событиям, а не чтобы считать по нему бюджет.

### Что join отдаёт из присоединённой модели

По умолчанию — **все её колонки**: идентификаторы, ось времени, событийные свойства
`*_of_event_data` и **суммы**. Это важно именно для источника мер: сумма намеренно не
является группируемым атрибутом, поэтому «отдать размерности» означало бы потерять
`cost`, `impressions` и `clicks` — то есть всё, ради чего источник и присоединяли.

Единственное исключение — колонка, чьё имя в конвейере уже занято: две колонки под одним
именем ниже по цепочке не адресуются, поэтому присоединённая пропускается, и ответ шага
прямо перечисляет какие. Потерять её нельзя — она берётся под своим именем:

```json
{ "stage": "join", "with": "events", "via": "ad_funnel_rewarded",
  "attrs": ["event_id", { "column": "event_name", "as": "ad_event_name" }] }
```

`attrs` сверяется с реальными колонками присоединённой модели, так что опечатка падает
здесь со списком доступного, а не ошибкой базы.

### Несколько соединений подряд

Стадии `join` складываются: каждая становится своим CTE, и следующая видит всё, что
накопилось. Так одна цепочка достаёт все четыре источника сразу — «какая рекламная воронка
крутилась, когда приложение упало, у игрока из какой страны, купленного по какому каналу».

```json
{ "source": "crashlytics", "stages": [
  { "stage": "join", "with": "events",      "via": "ad_funnel_rewarded", "kind": "inner", "attrs": ["event_id"] },
  { "stage": "join", "with": "users",       "via": "user", "kind": "inner", "attrs": ["country"],
    "between": { "value": "event_time", "from": "install_time_valid_from", "to": "install_time_valid_until" } },
  { "stage": "join", "with": "acquisition", "via": "user", "kind": "inner", "attrs": ["media_source", "cost"] }
] }
```

Два правила, которые здесь важны:

- **`via` всегда разрешает левый ключ от ИСХОДНОГО источника pipeline**, а не от накопленного
  отношения. Все `ON` в примере выше висят на колонках строки падения — и связь должна быть
  объявлена именно у источника.
- **Порядок соединений не меняет получившееся отношение, но меняет момент атрибуции.** Та же
  цепочка, пройденная со стороны событий (`events` → `users` → `acquisition` → `crashlytics`),
  даёт ровно те же пары «падение × событие × строка расхода». А вот страна получится другая:
  каждая цепочка берёт версию установки, действительную на **своё** время — время падения или
  время рекламного события, — и игрок, сменивший страну между ними, попадёт в разные когорты.
  Это не расхождение, а ровно то, что просили: в фикстуре 20 GB / 2 BR по времени падения
  против 16 US / 4 GB / 2 BR по времени события.

Деньги при этом суммировать по цепочке нельзя ровно по той же причине, что и в паре
acquisition × events: строки расходов размножаются по событиям.

### Соединение с медленно меняющейся моделью — всегда point-in-time

Если `dim_users` несёт окно валидности:

```yaml
      - name: install_time_valid_from
        data_type: timestamp
        meta: { mcp: { dimension: { validity: start } } }
      - name: install_time_valid_until
        data_type: timestamp
        meta: { mcp: { dimension: { validity: end } } }
```

— то на игрока приходится **несколько версий**, и соединение по одному ключу совпадёт с
каждой исторической версией и раздует любой счёт.

- **governed** — MetricFlow применяет окно сам: просто группируйте по `user__country`.
- **pipeline** — окно указывается явно, в стадии соединения. Намеренно явно: время, о
  котором спрашивают, видно прямо в месте вызова.

```json
{ "stage": "join", "with": "users", "via": "user",
  "between": { "value": "spend_date",
               "from": "install_time_valid_from",
               "to": "install_time_valid_until" } }
```

`value` — колонка **этой** стороны: для acquisition это `spend_date`, для событий —
время события, для отчёта о падении — время падения. Если соединение стоит **после**
`match_recognize`, времени события уже нет: берите `first_seen_at` — первое событие
воронки.

MetricFlow разрешает модели с окном валидности ровно **один** ключ соединения, как её
естественный. Второй `primary`/`unique` там отвергается на загрузке (правило 11); его
можно объявить `foreign` — в pipeline он останется рабочим.

### Варианты: одна связь на нескольких колонках

Когда одну связь несут несколько альтернативных колонок (по одной на формат рекламы),
объявляются `variants`, и каждый превращается в свою связь `<связь>_<вариант>`. Сторона,
у которой такая колонка одна, объявляет её плоско — она отвечает всем вариантам сразу:

```yaml
    # на источнике продуктовых событий
    entities:
      ad_funnel: { type: foreign, key: [tracking_id, player_id_of_internal] }
```

Выбирает вариант **вызывающий**: `via: 'ad_funnel_rewarded'` и `via: 'ad_funnel_banner'`
дают разные ответы, и это правильно.

### Связь, которой никто не владеет, — это нормально

`ad_funnel` не принадлежит никому: одна воронка — это несколько событий, значит ни одна
сторона по этому ключу не уникальна. Управляемого пути у неё нет, и так и должно быть —
MetricFlow умеет соединять только по уникальному ключу. Pipeline соединяет её без
вопросов.

---

## 5. Как это выглядит на вызове

Расход по стране установки на день расхода — управляемый путь, окно применяется само:

```json
{ "metrics": ["ua_cost"], "group_by": ["user__country"] }
```

То же самое через pipeline, с явным окном:

```json
{ "source": "acquisition", "stages": [
  { "stage": "join", "with": "users", "via": "user",
    "between": { "value": "spend_date", "from": "install_time_valid_from", "to": "install_time_valid_until" },
    "kind": "inner", "attrs": ["country"] },
  { "stage": "aggregate", "group_by": ["country"],
    "measures": [{ "name": "total", "fn": "sum", "column": "cost" }] }
] }
```

Какая рекламная воронка крутилась, когда приложение упало:

```json
{ "source": "crashlytics", "stages": [
  { "stage": "join", "with": "events", "via": "ad_funnel_rewarded",
    "kind": "inner", "attrs": ["event_id", "event_name"] }
] }
```

Медиана стоимости клика — функция выбрана на месте, в схеме её нет:

```json
{ "source": "acquisition", "stages": [
  { "stage": "aggregate", "group_by": ["media_source"],
    "measures": [{ "name": "cpc_p50", "fn": "median", "column": "cost_per_click" }] }
] }
```

---

## 6. Чек-лист перед мержем

- [ ] `role` проставлена, и такая модель в каталоге одна.
- [ ] `primary_entity` не совпадает ни с одной другой моделью.
- [ ] У источника событий есть `is_event_name` и `is_time`; `known_events` перечислены полностью.
- [ ] У источника мер есть `is_time`, и `event_name` нет вовсе.
- [ ] Каждая payload-колонка несёт `events: [...]` — список событий, на которых она заполнена.
- [ ] Ни в одном имени колонки нет `__`.
- [ ] Суммы помечены `measure`, атрибуты — нет; `agg` стоит только там, где функцию действительно хотят зафиксировать для всех.
- [ ] Ключи связей объявлены в схеме, а не передаются в вызове.
- [ ] У связи ровно один владелец (`primary`/`unique`) — либо владельца нет вовсе, и тогда это осознанно pipeline-связь.
- [ ] Обе стороны каждой связи собраны из одинакового числа частей.
- [ ] Если у модели есть окно валидности — она не владеет вторым ключом.
- [ ] Каталог загружается: `node -e "import('./src/catalog.js').then(m => m.loadCatalog('<путь>', {}))"`.

---

## 7. Заземление: объявление, которого нет в таблице

Каталог сверяется с **реальными** колонками таблиц при загрузке, и всё, чего физически
нет, вырезается: колонки, свойства событий, размерности, **ключи связей** и сам флаг
медленно меняющейся модели.

- Связь, у которой хотя бы одна часть ключа не пережила сверку, исчезает: её нет в
  перечне `via`, и позвать её нельзя — отказ приходит на валидации ввода, а не как
  ошибка базы.
- Если пара колонок окна валидности не пережила сверку, модель перестаёт считаться
  медленно меняющейся и рендерится обычной размерностью. Иначе манифест содержал бы
  `natural`-сущность без окна, а такой dbt отвергает целиком.

Всё вырезанное пишется в лог загрузки — молча ничего не пропадает. Это значит, что
шаблон можно завести заранее, до того как колонки появятся в складе: сервер поднимется,
а недостающее просто не будет предлагаться.

---

## Куда смотреть дальше

| файл | что там |
|---|---|
| `test/integration/fixtures/catalog.yml` | оба шаблона, заполненные, — рабочая эталонная схема |
| `test/integration/declared-joins.test.js` | 50 сценариев на живом складе: поведение связей, заземление, генерация SQL, вызов через MCP, цепочка на все четыре источника, полнота полей при join |
| `test/integration/fixtures/SEED_DATA.md` | §12-13: тестовые данные по связям и по SCD-2 |
| `config/catalog.yml` | закомментированный шаблон в составе прод-каталога |
| `CLAUDE.md` | правила модели данных, которым эта схема обязана соответствовать |
