# Правила оформления схемы: структура и описания

Один документ про то, как объявлять источники в dbt-схеме для этого MCP-сервера — и,
отдельно и подробно, **как писать `description` к модели и к полю**, чтобы ИИ-агент понимал
данные с первого взгляда и не тратил вызовы на переспрашивание.

Документ исходит из архитектуры именно нашего агента: часть информации сервер добывает
**из самих данных** (value-индекс, интроспекция склада, свежесть) и отдаёт в
`semantic_index`. Всё, что сервер измеряет сам, в описаниях писать не надо — статичный
комментарий про динамику устаревает молча и начинает врать.

Смежные документы: [`SCHEMA_ACQUISITION_CRASHLYTICS.md`](SCHEMA_ACQUISITION_CRASHLYTICS.md) —
готовые шаблоны для источника падений и источника мер; [`ARCHITECTURE.md`](ARCHITECTURE.md) —
как каталог превращается в модели MetricFlow.

---

## 1. Как агент видит схему

Три уровня, и на каждом видно разное. От этого зависит, **куда** писать текст.

| уровень | что происходит | что агент видит |
|---|---|---|
| **загрузка каталога** | `loadCatalog` разбирает `meta.mcp`, нормализует ключи, отвергает противоречивые объявления | ничего — это происходит до первого вызова |
| **заземление** | объявленное сверяется с реальными колонками таблиц. Обычная колонка (атрибут, свойство, величина, связь), которой физически нет, вырезается. **Структурная** колонка — имя события, время у источника событий, JSON-blob с объявленными в нём свойствами, ключ идентичности — или сама таблица делают модель **недоступной** целиком | вырезанное **не появится нигде**; недоступная модель видна в обзоре в `unavailable_models` с причиной, `semantic_index({ model })` показывает недостающие колонки, ни один инструмент её не принимает |
| **`semantic_index`** | обзор → модель → событие → свойство → поиск | ровно то, что описано ниже |

Ключевое следствие, которое определяет стиль текстов:

- **`description` модели попадает в обзор целиком, дословно, при самом первом вызове**
  `semantic_index()` — без всяких drill-down. Это самое дорогое место в схеме и
  единственное, что агент гарантированно прочитает. Сюда идут правила поведения.
- **`description` колонки видно только при углублении** — `semantic_index({ model })`,
  `({ source, event })`, `({ source, property })`. Значит поле описывается так, чтобы текст был полезен
  тому, кто уже пришёл именно за этим полем.
- **Агент никогда не пишет путь соединения.** Атрибут адресуется только тем, где он лежит:
  `group_by: [{ model: 'users', attribute: 'country' }]`,
  `where: { field: { kind: 'dimension', model: 'users', attribute: 'country' } }`,
  `order_by: [{ key: { model: 'users', attribute: 'country' } }]`. Связь сервер выводит из объявленных
  ключей сам; если к модели ведут несколько связей (варианты ключа), добавляется `via`. Строка вида
  `user__country` **не принимается** — отказ с готовой заменой. Полный перечень доступного —
  `groupable_attributes` в обзоре и `groupable` в ответе `create_semantic_model`. Колонки результата
  тоже без внутреннего разделителя: `users_country`, `crashlytics_app_version`, `metric_time_day` —
  ими же адресуются `order_by` и трансформации `get_query_result`; соответствие возвращается в
  `group_by_resolved`; внутреннего написания MetricFlow агент не видит ни на входе, ни на выходе.
- **Оба текста индексируются для поиска** (`semantic_index({ search })`), с меньшим весом,
  чем имя. Поэтому слова, которыми аналитик называет поле вслух, работают: попадут в
  описание — поле найдётся по ним.

---

## 2. Жёсткие правила структуры

Это не стилистика, это то, без чего каталог либо не загрузится, либо соберёт неверную
модель.

### 2.0. Где живёт `meta` — под `config:` (dbt 1.10+)

До dbt 1.9 `meta:` было собственным свойством модели и колонки. **dbt 1.10 перенёс его под
`config:`**; dbt Core 1.11 старое место ещё читает и только предупреждает
(`PropertyMovedToConfigDeprecation`), а **dbt Fusion считает верхний ключ неизвестным
(`UnusedConfigKey`, dbt1060) и МОЛЧА выбрасывает его**. Для этого сервера это не косметика: в
`meta.mcp` лежит вся его поверхность — роли, ось времени, связи, измерения, меры, — так что каталог
из проекта, разобранного Fusion, оказался бы пустым.

Поэтому пишите так (и на модели, и на колонке):

```yaml
- name: tracking_start_watch_time_of_rewarded
  data_type: timestamp
  config:
    meta:
      mcp:
        dimension: {}
```

Загрузчик (`src/catalog.js`, `mcpMetaOf`) читает ОБА места, `config.meta` побеждает по ключам — так
что проект на полпути миграции работает. Перенести существующий файл целиком:
`python3 scripts/meta-to-config.py --check <путь>` покажет, что изменится (и вернёт 1, если что-то
осталось в старом месте — годится для CI), `--write` перенесёт. Правка построчная: комментарии,
пустые строки и кавычки остаются на месте, а результат перед записью разбирается и сверяется с
ожидаемым документом. Блок, у которого уже есть свой `config:`, и `meta:` внутри flow-мэппинга
(`- { name: ts, meta: { … } }`) скрипт не трогает, а называет — их сливают руками.

### 2.1. Роль — идентичность источника

Источник опознаётся по `meta.mcp.role`, никогда по имени модели. Ровно одна модель на роль.
Санкционированные роли: источник событий (их может быть несколько, они равноправны),
`users`, `experiments`, источник мер (факт без событий).

```yaml
config:
  meta:
    mcp:
      role: crashlytics      # ← идентичность; dbt-модель может называться как угодно
      primary_entity: crash
```

(Дальше в этом документе примеры пишутся без обёртки `config:` — она одна и та же везде, а
загрузчик принимает оба места.)

### 2.2. Ключи связей объявляются в схеме, а не в вызове

```yaml
entities:
  user:      { type: foreign, key: [player_id] }             # ссылаемся на владельца
  ad_funnel: { type: unique,  key: [tracking_id, player_id] } # владеем этой связью
```

| тип | смысл | что даёт |
|---|---|---|
| `primary` | идентичность модели (одна на модель) | модель — цель соединения |
| `unique` | второй ключ, тоже уникальный на строку | модель — цель соединения по этой связи |
| `foreign` | ссылка на того, кто владеет | путь `<связь>__<атрибут>` и `join { via }` |
| `natural` | **не объявляется руками** — производится из окна валидности | — |

Правила: у связи ровно один владелец; **число частей ключа** должно совпадать на обеих
сторонах (имена колонок — нет); `variants` описывают одну связь, которую эта сторона несёт
в нескольких альтернативных колонках.

`unique` — **утверждение о данных, и его никто не проверяет**. Ставит его автор схемы, он
за него и отвечает: если ключ на стороне владельца в действительности не уникален, соединение
размножит строки и метрика вырастет молча. Проверка перед тем, как ставить:

```sql
SELECT <ключ> FROM <таблица владельца> GROUP BY 1 HAVING count(*) > 1;   -- 0 строк = правда
```

### 2.3. Схема помечает, ЧТО можно агрегировать; функцию выбирает вызывающий

```yaml
- name: cost
  meta: { mcp: { measure: { unit: usd, label: "UA cost" } } }   # сумма, среднее, p90 — по вопросу
```

Добавление `agg` — **опт-ин исключение**: дополнительно публикуется губернируемая величина
с зафиксированной функцией, одинаковой для всех. Свободный выбор над тем же полем остаётся.

```yaml
measures:
  total_spend: { expr: cost, agg: sum, unit: usd, description: "Общий расход на привлечение." }
```

### 2.4. Два опт-аута

| ключ | смысл |
|---|---|
| `meta.mcp.dimension: false` | реальная колонка, но не групповой атрибут (техническое поле) |
| `meta.mcp.index: false` | группировать можно, но не профилировать значения (идентификаторы) |

### 2.5. Окно валидности — только на медленно меняющейся размерности

```yaml
- { name: valid_from,  meta: { mcp: { dimension: { validity: start } } } }
- { name: valid_until, meta: { mcp: { dimension: { validity: end } } } }
```

Такая модель соединяется point-in-time и может иметь **ровно один** ключ соединения — свой
естественный. Меры на ней MetricFlow запрещает.

### 2.6. Именование

`__` (двойное подчёркивание) в именах свойств и размерностей запрещено: MetricFlow резервирует
его как разделитель `сущность__атрибут`. Плоское payload-поле называется инвертированной
формой: `price_in_usd_of_event_data`, а не `event_data__price_in_usd`.

---

## 2a. Справочник управляющих ключей `meta.mcp`

Полный перечень того, что читает сервер. Всё, чего здесь нет, он игнорирует. Каждый ключ
описан одинаково: **где** ставится → **что меняет** в поведении.

### Уровень модели

| ключ | значение | что меняет |
|---|---|---|
| `role` | `events` / `crashlytics` / `users` / `experiments` / `acquisition` / … | **обязателен.** Идентичность источника; имя модели значения не имеет. Ровно одна модель на роль. |
| `primary_entity` | имя (`event`) или `{ name, key }` | идентичность модели в MetricFlow и цель соединения по этой сущности. Строковая форма — для источников событий (ключа нет, строки не соединяют «на себя»); объектная — для размерности, чей ключ составной. |
| `entities` | `{ <связь>: { type, key \| variants } }` | объявляет ключи соединений один раз, для семантического слоя и pipeline (`via`). См. §2.2. |
| `measures` | `{ <имя>: { expr, unit?, label?, description?, agg? } }` | без `agg` — агрегируемое выражение, функцию выбирает вызывающий; с `agg` — дополнительно губернируемая величина с зафиксированной функцией. |
| `known_events` | список имён событий | **только источник событий.** Словарь событий: значения `event` в инструментах валидируются по нему; попадает в перечень `semantic_index`. |
| `event_semantics` | `{ acquisition_event, session_event, session_end_event, purchase_event, ad_impression_event }` | **только источник событий.** Какое событие означает установку / сессию / покупку / показ рекламы. Идёт в обзор и в guide — retention и конверсии якорятся на правильные события, а не на догадку. |
| `partition_column` | имя колонки | подсказка стоимости: `semantic_index({ model })` отдаёт `cost_hint` «всегда ограничивай запрос по этой колонке». Только текст, не запрет. |
| `require_time_range` | `true` / `false` | **запрет.** Метрика или pipeline без ограничения по времени над этим источником отвергается с требованием `time_range`. Переопределяется на весь каталог переменной `MCP_REQUIRE_TIME_RANGE`. |

Источник событий распознаётся **структурно** — по колонке `is_event_name` или `is_event_data`, — а не по роли. Модель с осью времени, но без этих колонок — источник мер (`acquisition`), и её меры и атрибуты живут по правилам размерности.

### Уровень колонки — структурные

| ключ | где | что меняет |
|---|---|---|
| `entity: { name, type }` | любая модель | одноколоночный ключ связи; `type: primary` делает колонку ключом идентичности. Колонка-ключ **не становится атрибутом**. Составной ключ так не объявить — только через `entities` модели. |
| `is_time: true` | одна колонка на модель | ось времени: `metric_time` и `agg_time_dimension` семантической модели, ось окон и `match_recognize` в pipeline, источник свежести данных. На источнике мер и размерности остаётся групповым атрибутом («установки по дню установки»). |
| `granularity` | рядом с `is_time` или в `dimension` | зерно времени (`day` по умолчанию): `hour`, `day`, `week`, `month`, `quarter`, `year`. |
| `is_event_name: true` | одна колонка, источник событий | имя события — то, по чему фильтруется `event_scope` и строятся шаги воронки. Делает модель источником событий. |
| `is_event_data: true` | одна колонка, источник событий | сырой JSON-payload. Нужен для (а) опознания источника событий и (б) размещения **сложных свойств**, у которых нет плоской колонки — см. `properties` ниже. Физически колонки может не быть, если payload полностью расплющен. |
| `property: true` | плоская колонка источника событий | делает колонку **свойством события** (payload). Всё остальное — на каких событиях оно заполнено, какие значения принимает, как часто пусто — **измеряет индекс**, по каждому источнику отдельно. Без маркера колонка факта — просто колонка. |
| `unit` | величина или числовое свойство | машиночитаемая единица (`usd`, `usd_cents`, `seconds`). Показывается рядом с полем; для строковой колонки с единицей сервер подсказывает привести к числу перед суммой. Не смешивайте единицы в одной метрике — сервер этого не сделает за вас. |

### Уровень колонки — величины

| ключ | что меняет |
|---|---|
| `measure: true` | помечает колонку **суммой**: агрегируема любой функцией (`sum / average / min / max / count / count_distinct / sum_boolean / median / percentile`), функцию выбирает вызывающий. Перестаёт быть атрибутом и не профилируется индексом. |
| `measure: { unit, label, description }` | то же, плюс самоописание в `semantic_index` (поле → единица → смысл). |
| `measure: { …, agg, name? }` | **опт-ин.** Дополнительно публикует губернируемую величину `name` (по умолчанию имя колонки) с зафиксированной функцией. Свободный выбор над колонкой остаётся. `percentile` требует `percentile: 0.9`. |
| `measure` вместе с `dimension` | колонка остаётся атрибутом (группируемой), а не величиной — `dimension` побеждает. Редкий случай: числовой код, по которому и группируют, и который иногда суммируют. |

### Уровень колонки — атрибуты

| ключ | что меняет |
|---|---|
| (ничего) на размерности | **каждая** оставшаяся колонка размерности — групповой атрибут; тип берётся из dbt `data_type` (date/timestamp → время, иначе категория). Помечать не надо. |
| (ничего) на источнике событий | колонка без пометок на источнике событий — **просто колонка**: доступна в pipeline, не атрибут, не свойство. Чтобы группировать по ней в метрике, задача объявляет её `model_column`-размерностью. |
| `dimension: true` или `{ … }` | на источнике событий — сделать колонку атрибутом модели (`app_version`, `device_model` на источнике падений). Именно эти атрибуты становятся доступны **через связь** `<связь>__<атрибут>`, когда другой источник на эту модель ссылается. |
| `dimension: false` | **опт-аут:** реальная колонка, но не атрибут — не появляется среди групповых, не профилируется. Для технических полей (`ingest_batch_id`). В pipeline читается. |
| `dimension: { type }` | принудить тип (`time` / `categorical`), когда `data_type` вводит в заблуждение. |
| `dimension: { validity: start \| end }` | граница окна валидности. Только парой, только на размерности, делает модель медленно меняющейся: соединение point-in-time, сущность `natural`, меры запрещены, один ключ соединения. Переопределяется `MCP_SCD_VALIDITY_PARAMS=false` для старых версий DSI. |
| `dimension: { bundle: true }` | на источнике событий: эта колонка — **идентификатор приложения**. Индекс начинает мерить покрытие свойств по приложениям — **отдельно для каждого источника**: одно и то же приложение шлёт события в каждый источник со своим числом строк и своим набором пустых свойств, поэтому приложение везде — пара (источник, приложение), и вид `semantic_index({ source, bundle })` отвечает по одному источнику (без `source` — по каждому в своём блоке, никогда не сливая). Обзор перечисляет приложения по источникам. |
| `index: false` | **опт-аут индекса:** группировать можно, значения не профилируются. Для идентификаторов, свободного текста, высокой кардинальности — иначе индекс тратит время на бесполезный топ-N. |

### Уровень колонки — сложные типы (источник событий)

| объявление | что меняет |
|---|---|
| `array: { items: <тип>, encoding? }` | плоская колонка — **массив скаляров**. `encoding: native` (настоящий ARRAY/REPEATED) или `json` (JSON-массив в колонке — как STRING с текстом JSON, так и настоящая JSON/jsonb-колонка с `data_type: json`; по умолчанию для `data_type: string`). Открывает `array_length`, `contains`, `element_at`, `unnest` в pipeline. |
| `array: { fields: { <поле>: <тип> }, encoding? }` | **массив структур**: `unnest` с выбором поля, `struct_field`. |
| `properties:` под `is_event_data` | свойства, живущие **в JSON-blob без плоской колонки**: `{ <имя>: { type, items?, fields?, values?, description? } }`. Скалярные типы: `string` (по умолчанию), `int` / `bigint`, `numeric`, `float` / `double` — числовые приводятся при извлечении; сложные: `array`, `array<struct>`. Читаются извлечением из JSON. |
| JSON-объект в колонке | не объявляется отдельно; читается `struct_field` / `compute json_field`. Индекс профилирует скаляры, вложенные поля — нет, поэтому форму объекта описывают в `description` (§7). |

Что делает **тип данных** сам по себе (без ключей): `date` / `timestamp*` / `datetime` → атрибут времени; числовые типы → свойство считается `numeric` и агрегируется без приведения; `string` с `unit` → сервер предупредит привести к числу.

### Переменные окружения, меняющие чтение схемы

| переменная | что меняет |
|---|---|
| `MCP_REQUIRE_TIME_RANGE` | включает / выключает требование окна времени для **всего** каталога поверх `require_time_range` моделей |
| `MCP_SCD_VALIDITY_PARAMS=false` | выключает окна валидности (модели рендерятся с обычным `primary`-ключом) — для старых DSI |
| `MCP_GROUND_CATALOG=0` | выключает заземление по физическим колонкам (§1) — для работы без склада; по умолчанию включено |
| `MCP_INDEX_*` | режим value-индекса: окно дней, батч, порог высокой кардинальности, таймаут — влияет на то, **что** агент увидит в `sample_values`, не на схему |

---

## 2b. Полный гайд: куда что вставлять

Один файл — `schema.yml` вашего dbt-проекта (или `config/catalog.yml`, если каталог ведётся
отдельно). Всё управляющее лежит в `meta.mcp` на **двух уровнях**: на модели и на колонке.
Ниже — полный скелет со всеми четырьмя ролями. Скопируйте, замените имена колонок, удалите
то, чего у вас нет. Каждая пометка прокомментирована: что она включает.

```yaml
version: 2
models:

  # ───────────────────────────── 1. ИСТОЧНИК СОБЫТИЙ ─────────────────────────────
  - name: fct_analytics_events                     # имя dbt-модели — любое
    description: >                                 # читается ЦЕЛИКОМ в обзоре при первом вызове
      Client analytics events: one row = one tracked in-game event from the player's device.
      Time axis is device_time (player's zone). Joins to dim_users by player (point-in-time —
      dim_users is slowly-changing). Payload is flattened into *_of_event_data columns; the raw
      event_data JSON is kept only for complex (array) properties.
    meta:
      mcp:                                         # ── уровень МОДЕЛИ ──
        role: events                               # идентичность источника
        primary_entity: event                      # строкой: у событий нет ключа-колонки
        require_time_range: true                   # (опц.) запрет запросов без окна времени
        partition_column: event_date               # (опц.) подсказка стоимости
        known_events: [first_launch, new_session, level_completed, iap_purchase_completed, ad_finished]
        event_semantics:                           # какие события что значат
          acquisition_event: first_launch
          session_event: new_session
          purchase_event: iap_purchase_completed
          ad_impression_event: ad_finished
        entities:                                  # связи с СОСТАВНЫМ ключом — только здесь
          ad_funnel: { type: foreign, key: [tracking_id, player_id_of_internal] }
    columns:                                       # ── уровень КОЛОНКИ ──
      - name: player_id_of_internal
        description: "Stable internal player id — the join key to dim_users and experiments."
        meta: { mcp: { entity: { name: user, type: foreign } } }      # одноколоночный ключ
      - name: session_number
        meta: { mcp: { entity: { name: session, type: foreign } } }
      - name: device_time
        description: "When the event happened on the device, in the player's time zone."
        meta: { mcp: { is_time: true } }                              # ось времени
      - name: event_name
        meta: { mcp: { is_event_name: true } }                        # делает модель источником событий
      - name: bundle_id
        meta: { mcp: { dimension: { bundle: true } } }                # идентификатор приложения
      - name: tracking_id
        meta: { mcp: { index: false } }                               # ключ; не профилировать
      - name: event_date
        meta: { mcp: { dimension: false } }                           # техническая, не атрибут

      # плоские СКАЛЯРНЫЕ свойства payload — property: true делает колонку свойством события
      - name: price_in_usd_of_event_data
        data_type: numeric
        description: "IAP price in USD as charged by the store, before tax."
        meta: { mcp: { property: true, unit: usd } }
      - name: result_of_event_data
        data_type: string
        meta: { mcp: { property: true } }   # словарь-контракт

      # сырой JSON — нужен для СЛОЖНЫХ свойств без плоской колонки (см. §2c)
      - name: event_data
        data_type: jsonb
        meta:
          mcp:
            is_event_data: true
            properties:
              words_collected: { type: array, items: string, description: "Words collected on a level." }
              rewards: { type: "array<struct>", fields: { item: string, qty: int }, description: "Rewards granted." }

  # ────────────────────────── 2. ВТОРОЙ ИСТОЧНИК СОБЫТИЙ ──────────────────────────
  - name: fct_crashlytics_events
    description: "Crash reports: one row = one report. Independent event vocabulary. See §5."
    meta:
      mcp:
        role: crashlytics
        primary_entity: crash
        known_events: [fatal_crash, non_fatal, anr]
        entities:
          ad_funnel:                               # одна связь, НЕСКОЛЬКО альтернативных колонок
            type: foreign
            variants:
              rewarded:     { key: [rewarded_tracking_id, player_id_of_internal] }
              interstitial: { key: [interstitial_tracking_id, player_id_of_internal] }
              banner:       { key: [banner_tracking_id, player_id_of_internal] }
    columns:
      - name: player_id_of_internal
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - name: event_time
        meta: { mcp: { is_time: true } }
      - name: event_name
        meta: { mcp: { is_event_name: true } }
      - name: app_version                          # атрибут ФАКТА — доступен через связь
        meta: { mcp: { dimension: true } }         #   как { model: crashlytics, attribute: app_version } у того, кто ссылается
      - name: device_model
        meta: { mcp: { dimension: true } }
      - name: anr_duration_of_event_data
        data_type: numeric
        meta: { mcp: { property: true, unit: seconds } }
      # сложные типы в ПЛОСКИХ колонках — полностью в §2c
      - name: breadcrumbs_of_event_data
        data_type: string
        meta: { mcp: { array: { items: string, encoding: json } } }
      - name: stack_frames_of_event_data
        data_type: string
        meta: { mcp: { array: { encoding: json, fields: { file: string, line: int, in_app: boolean } } } }
      - name: custom_keys_of_event_data
        data_type: string
        description: "Custom keys attached to the report — a JSON object { level, coins, network }."
        meta: { mcp: { property: true } }

  # ───────────────────── 3. РАЗМЕРНОСТЬ ПОЛЬЗОВАТЕЛЕЙ (SCD-2) ─────────────────────
  - name: dim_users
    description: >
      Player attributes: one row = one player PER VERSION of their attributes. Slowly-changing:
      every join is point-in-time on [install_time_valid_from, install_time_valid_until).
    meta:
      mcp:
        role: users                                # primary_entity не нужна: ключ на колонке
    columns:
      - name: player_id_of_internal
        meta: { mcp: { entity: { name: user, type: primary } } }     # владелец связи user
      - name: install_time_valid_from
        data_type: timestamp
        meta: { mcp: { dimension: { validity: start } } }           # окно — ПАРОЙ
      - name: install_time_valid_until
        data_type: timestamp
        meta: { mcp: { dimension: { validity: end } } }
      - name: install_date
        data_type: date
        meta: { mcp: { is_time: true } }                              # ось времени размерности
      - name: platform
        data_type: string
      - name: country                              # без пометок: на размерности КАЖДАЯ колонка — атрибут
        data_type: string
      - name: media_source
        data_type: string

  # ─────────────────────────── 4. НАЗНАЧЕНИЯ A/B-ТЕСТОВ ───────────────────────────
  - name: fct_experiment_assignments
    description: "A/B assignments: one row = (player, experiment) with the [assigned_at, ended_at] window."
    meta:
      mcp:
        role: experiments
    columns:
      - name: player_id_of_internal
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - { name: experiment_name, data_type: string }
      - { name: variant_group,   data_type: string }
      - { name: assigned_at,     data_type: timestamp }
      - { name: ended_at,        data_type: timestamp }

  # ───────────────────────────── 5. ИСТОЧНИК МЕР ─────────────────────────────────
  - name: fct_player_acquisition
    description: "Acquisition spend: one row = (player, day). Amounts, not events. Joins to players by (player, day)."
    meta:
      mcp:
        role: acquisition
        primary_entity: acquisition                # объектная форма не нужна: ключ на колонке
        measures:                                  # выражения над колонками
          cost_per_click: { expr: "cost / nullif(clicks, 0)", unit: usd }             # функцию выберет вызывающий
          total_spend:    { expr: cost, agg: sum, unit: usd, description: "Total spend." }  # + губернируемая
    columns:
      - name: acquisition_id
        meta: { mcp: { entity: { name: acquisition, type: primary } } }
      - name: player_id_of_internal
        meta: { mcp: { entity: { name: user, type: foreign } } }
      - name: spend_date
        data_type: timestamp
        meta: { mcp: { is_time: true } }
      - name: cost
        data_type: numeric
        meta: { mcp: { measure: { unit: usd, label: "UA cost" } } }   # сумма, не атрибут
      - name: clicks
        data_type: integer
        meta: { mcp: { measure: true } }
      - { name: media_source, data_type: string }                    # атрибуты — без пометок
      - name: campaign_id
        meta: { mcp: { index: false } }
      - name: ingest_batch_id
        meta: { mcp: { dimension: false } }
```

Три правила размещения, которые чаще всего путают:

| хочу | куда |
|---|---|
| ключ связи из **одной** колонки | на колонку: `meta.mcp.entity: { name, type }` |
| ключ связи из **нескольких** колонок, или несколько альтернативных колонок | на модель: `meta.mcp.entities` (`key: [...]` или `variants`) |
| ключ, который сравнивается **по дню** (или другой единице), а не по мгновению | часть ключа как `{ column: <колонка>, grain: day }` — обе стороны усекаются до неё |
| величина — **колонка** | на колонку: `meta.mcp.measure` |
| величина — **выражение** над колонками | на модель: `meta.mcp.measures` |
| свойство события с **плоской** колонкой | на колонку: `meta.mcp.property: true` (для массива — `meta.mcp.array`) |
| свойство события **без** плоской колонки (в JSON-blob) | на колонку `is_event_data`: `meta.mcp.properties` |

Это ровно фикстура `test/integration/fixtures/catalog.yml` — на ней гоняются все
интеграционные сценарии, так что каждая пометка выше проверена на складе.

---

## 2c. Сложные типы: массивы, объекты, JSON — полный гайд

Четыре формы, в которых сложное значение встречается на складе. Для каждой: как выглядят
данные, что писать в схему, что покажет `semantic_index`, и какие стадии pipeline с этим
работают — с числами из фикстуры, которыми это доказано (`crashlytics-complex-types.test.js`).

Общее правило: **сложное значение доступно только через pipeline.** В управляемой метрике
(`create_semantic_model`) массив или объект не сгруппировать и не просуммировать напрямую —
сначала pipeline извлекает скаляр или разворачивает строки.

### Форма A. Массив скаляров в плоской колонке

Данные: колонка `breadcrumbs_of_event_data` типа `string`, в строке — JSON-массив
`["level_start","ad_shown"]`. На BigQuery это же может быть настоящий `ARRAY<STRING>`.

```yaml
- name: breadcrumbs_of_event_data
  data_type: string                        # или ARRAY<STRING> на BigQuery
  description: "Breadcrumb trail leading up to the report — a JSON array of strings, in order."
  meta:
    mcp:
      array:
        items: string                      # тип элемента
        encoding: json                     # строка с JSON-массивом; для ARRAY-колонки — native
```

`encoding` можно не писать: для `data_type: string` подразумевается `json`, для остального —
`native`. Исключение — колонка настоящего типа JSON/jsonb (`data_type: json`, как JSON-колонка
BigQuery): по умолчанию она получила бы `native`, поэтому `encoding: json` там пишется явно. Сервер
читает такую колонку теми же JSON-функциями, что и строку, и никогда не сравнивает её со строковым
литералом. `semantic_index({ source, event })` покажет свойство с `type: array`, `complex: true`.

Что с ним делать в pipeline — и что это даёт на фикстуре (13 отчётов, 20 элементов):

```js
// одна строка на элемент — «на каком шаге ломалось»
{ stage: 'unnest', source: 'breadcrumbs_of_event_data', as: 'crumb', type: 'string' }
//   → 20 строк; group_by crumb: level_start 4, net_retry 4, ui_freeze 3, gc_pause 3, …

// длина массива, не меняя грань
{ stage: 'derive', name: 'n_crumbs', op: 'array_length', source: 'breadcrumbs_of_event_data' }
//   → sum(n_crumbs) = 20 по 13 отчётам

// членство: был ли шаг
{ stage: 'derive', name: 'retried', op: 'contains', source: 'breadcrumbs_of_event_data', value: 'net_retry' }
//   → retried = true у 3 отчётов (net_retry встречается 4 раза, но k8 записал его дважды)

// первый / последний элемент — «куда вошёл, где умер»
{ stage: 'compute', name: 'trail',   op: 'json_parse_array', column: 'breadcrumbs_of_event_data' }
{ stage: 'compute', name: 'entered', op: 'element_at', column: 'trail', index: 1 }
{ stage: 'compute', name: 'died_at', op: 'array_last',  column: 'trail' }
```

`unnest` **меняет грань**: строки без массива (NULL) выпадают. Если нужно сохранить все
отчёты — берите `array_length` / `contains`, они грань не меняют.

### Форма B. Массив объектов (структур) в плоской колонке

Данные: `stack_frames_of_event_data` — JSON-массив объектов
`[{"file":"Game.cs","line":42,"in_app":true}, …]`. На BigQuery — `ARRAY<STRUCT<…>>`.

```yaml
- name: stack_frames_of_event_data
  data_type: string
  description: "Exception stack, innermost frame first — a JSON array of { file, line, in_app }."
  meta:
    mcp:
      array:
        encoding: json
        fields:                            # форма элемента — делает тип array<struct>
          file: string
          line: int
          in_app: boolean
```

`fields` — то, что отличает массив структур от массива скаляров: без него `unnest` отдаст
элемент целиком как JSON, с ним — можно сразу привязать одно поле.

```js
// одно поле элемента, одной стадией — «какие файлы падают»
{ stage: 'unnest', source: 'stack_frames_of_event_data', as: 'file', field: 'file' }
//   → 16 кадров по 10 отчётам; group_by file: Game.cs 5, Net.cs 4, Engine.cs 3, Shop.cs 2, Decode.cs 1, Ads.cs 1

// несколько полей — элемент целиком, потом json_field по каждому
{ stage: 'unnest',  source: 'stack_frames_of_event_data', as: 'frame' }
{ stage: 'compute', name: 'file',   op: 'json_field', column: 'frame', field: 'file' }
{ stage: 'compute', name: 'line',   op: 'json_field', column: 'frame', field: 'line', type: 'int' }
{ stage: 'compute', name: 'in_app', op: 'json_field', column: 'frame', field: 'in_app' }
//   → where in_app = false: 3 кадра (все три — Engine.cs); true: 13

// глубина стека без разворота
{ stage: 'derive', name: 'depth', op: 'array_length', source: 'stack_frames_of_event_data' }
//   → 13 строк: k1 2, k2 1, k3 3 … ; у anr — NULL
```

Скрещивание с обычным соединением работает как всегда: `unnest` → `join { with: 'users',
via: 'user', between: … }` → 20 хлебных крошек по странам GB 10 / US 6 / DE 3 / BR 1, дублей нет.

### Форма C. JSON-объект в плоской колонке

Данные: `custom_keys_of_event_data` — одиночный объект `{"level":"12","coins":"340","network":"wifi"}`.
Ключи известны, но **не заданы схемой** — их состав может отличаться от строки к строке.

```yaml
- name: custom_keys_of_event_data
  data_type: string                        # или JSON / jsonb
  description: >
    Custom keys attached to the report — a JSON object. Known keys: level (int), coins (int),
    network (wifi | cellular). Read a key with struct_field / json_field.
  meta:
    mcp:
      property: true
```

Специальной пометки у объекта **нет** — он остаётся обычным event-scoped свойством. Поэтому
это единственный случай, когда **форму значения надо описать словами** в `description`: индекс
профилирует скаляры, а вложенные ключи объекта — нет, и агенту неоткуда узнать, что внутри.

```js
// один ключ как строка
{ stage: 'derive', name: 'network', op: 'struct_field', source: 'custom_keys_of_event_data', field: 'network' }
//   → wifi 8 / cellular 5

// один ключ с приведением типа — для сумм
{ stage: 'compute', name: 'coins', op: 'json_field', column: 'custom_keys_of_event_data', field: 'coins', type: 'int' }
{ stage: 'compute', name: 'level', op: 'json_field', column: 'custom_keys_of_event_data', field: 'level', type: 'int' }
//   → sum(coins) 5205; max(level) 31; median(level) 12
```

Не путайте с формой A: `array_length` / `contains` / `unnest` на объекте отвергаются с
подсказкой — «это не массив; для JSON-объекта используйте struct_field или json_field».

### Форма D. Сырой JSON-blob события с вложенными сложными свойствами

Данные: колонка `event_data` (jsonb) целиком, а внутри — ключи, для которых **нет плоских
колонок**: `{"words_collected":["cat","dog"],"rewards":[{"item":"coin","qty":10}]}`.

```yaml
- name: event_data
  data_type: jsonb
  description: "Raw per-event JSON payload; kept for complex array properties that have no flat column."
  meta:
    mcp:
      is_event_data: true
      properties:                          # свойства, живущие ТОЛЬКО в blob
        words_collected:
          type: array
          items: string
          description: "Words collected on a completed level."
        rewards:
          type: "array<struct>"
          fields: { item: string, qty: int }
          description: "Rewards granted on level completion (item + quantity)."
        difficulty:                        # скаляр в blob тоже можно — но плоская колонка лучше
          type: int
          description: "Level difficulty tier."
```

Свойство из `properties` адресуется **по имени ключа**, а не по колонке, и читается
извлечением из JSON. Стадии — те же, что для форм A и B:

```js
{ stage: 'derive', name: 'n_words', op: 'array_length', source: 'words_collected' }
{ stage: 'derive', name: 'has_cat', op: 'contains',     source: 'words_collected', value: 'cat' }
{ stage: 'unnest', source: 'rewards', as: 'rw' }          // элемент-структура целиком
{ stage: 'compute', name: 'item', op: 'json_field', column: 'rw', field: 'item' }
```

Когда blob, а когда плоская колонка: **плоская всегда лучше** — она типизирована,
профилируется индексом и не требует парсинга на каждом запросе. Blob оставляют для редких
сложных свойств, которые не стоит материализовать колонками.

### Сводка: какая форма → что писать → чем читать

| данные | схема | pipeline |
|---|---|---|
| массив скаляров, плоская колонка | `array: { items, encoding? }` | `unnest` · `array_length` · `contains` · `json_parse_array` + `element_at` / `array_last` |
| массив объектов, плоская колонка | `array: { fields: {…}, encoding? }` | `unnest` с `field` · `unnest` целиком + `json_field` · `array_length` |
| JSON-объект, плоская колонка | ничего особого + `description` с формой | `struct_field` · `json_field` с `type` |
| массив / объект внутри blob | `properties` под `is_event_data` | те же стадии, `source` = имя ключа |
| настоящий ARRAY / REPEATED (BigQuery) | `array: { …, encoding: native }` | те же стадии без парсинга |

Что **нельзя**: объявить массив под `dimension` (сложное значение — не атрибут), группировать
метрику по массиву напрямую.

---

## 2d. Рецепты: спецификация и правила оформления

Рецепт — это **готовая, проверенная на складе полезная нагрузка инструмента** плюс приём, по
которому агент адаптирует её к своему вопросу. Доступны агенту через `semantic_index`: обзор
перечисляет их id, `{ guide }` группирует по семействам, `{ search }` находит по словам,
`{ recipe: id }` отдаёт один целиком. Отдельных инструментов для рецептов нет — намеренно.

**Два слоя, которые складываются, и РАЗНЫЕ по природе.** Системные рецепты едут вместе с
сервером (`config/recipes.json` рядом с ним) и описаны **по ПРИЁМУ, а не по бизнес-задаче**: тип
метрики, джойн, шаблон стадий пайплайна, статистический тест, ход на python-рантайме. Причина:
бизнес-форма («воронка туториала», «экономика монет») у каждого продукта своя, а техника —
одна и та же, и именно её агент не знает. Поэтому в системном слое НЕТ «рецепта на DAU» — есть
`measure_over_metric_time`; нет «рецепта на ARPPU» — есть `ratio_metric`. Реальный вопрос
собирается из двух-трёх приёмов.

Развёртывание добавляет СВОИ файлы через `RECIPES_PATH` (можно несколько через запятую) — и вот
там место доменному: ваши игры, ваши события, ваши договорённости, ваши готовые «воронка
туториала» и «экономика монет». Оба слоя предлагаются вместе; при совпадении `id` побеждает ваш,
то есть системный рецепт переопределяется намеренно, а не случайно. В ответах у каждого рецепта
есть `origin: system | deployment | generated`.

**Третий вид — СПРАВОЧНЫЙ рецепт, и он генерируется.** Библиотеке python-рантайма нельзя верить
по памяти: её подписи — факт конкретной версии. Поэтому `scripts/bigframes-facts.py` вычитывает их
из самой библиотеки в `config/bigframes-facts.json`, а `pythonReferenceRecipes()`
(`src/python-guide.js`) публикует этот лист как рецепты, которые можно ЗАБРАТЬ ПО ID посреди
написания кода: `bf_ml_signatures` (конструкторы всех оценщиков `bigframes.ml` с разделением на
позиционные и keyword-only) и `bf_frame_method_rules` (какие методы фрейма требуют порядка, какие
— индекса, и подписи, которые удивляют). У такого рецепта нет `register_payload` — его тело это
поле `reference`; он подчиняется тем же правилам видимости (`requires`, `runtime`), у него
`origin: generated`, и развёртывание всё равно может переопределить его id своим файлом. Правило
простое: список, который агент рискует вспомнить неправильно, генерируется из источника и
проверяется тестом, а не переписывается руками в прозу.

Отсюда правило для системного рецепта: **минимум прозы, максимум техники**. `title` называет
приём, `hack` — как его обобщить, `notes` — чем он вредит, если применить неверно (неаддитивность,
размножение строк, неполный период), `when_to_use` — словами, которыми спрашивает человек (по нему
работает нечёткий поиск). Бизнес-контекст в системный рецепт не пишется: он в payload и так есть,
потому что payload обязан исполняться на фикстуре.

**Не каждый рецепт подходит каждому развёртыванию.** Рецепт может объявить, что ему нужно, и
тогда всё, что ПЕРЕЧИСЛЯЕТ рецепты (обзор, `{ guide }`, enum в схеме инструмента), предложит
только подходящие:

| поле | значение | когда рецепт скрыт |
|---|---|---|
| `requires` | `python_models` | здесь dbt не запускает python-модели |
| `dialect` | `bigquery` / `postgres` / список | склад другого типа |
| `runtime` | `bigframes` / `snowpark` / список | python-модели уходят на другой рантайм |

Запрос такого рецепта по id всё равно отвечает — и объясняет в `unavailable_here`, почему он
здесь не годится.

### Что рецепт даёт агенту

`semantic_index({ recipe })` возвращает рецепт как есть плюс две рамки: имена метрик
**намеспейсятся именем задачи** (`<name>_<metric>` — в `example_queries` уже полные имена), и
рецепт — **строительный блок**: взять `hack`, адаптировать payload под точный вопрос, отдать
`create_payload` в `create_semantic_model`, а pipeline — в `build_native_model`.

Поэтому самое ценное поле — не payload, а **`hack`**: обобщённый приём, из которого агент
собирает решение задачи, для которой рецепта нет. Payload — доказательство, что приём работает.

### Поля

| поле | обяз. | что это | как писать |
|---|---|---|---|
| `id` | да | идентификатор, `snake_case` | в системном слое — ПО ПРИЁМУ (`ratio_metric`, `pipeline_episodes_by_gap`), в вашем — по задаче (`tutorial_funnel`). Попадает в enum инструмента — переименование ломает вызовы |
| `task_type` | да | семейство | одно из уже существующих (см. ниже) — по нему `{ guide }` группирует. Новое семейство заводите осознанно |
| `title` | да | заголовок | приём (системный слой) или что считаем (ваш), по-английски, одна строка |
| `when_to_use` | да | когда брать | **формулировками вопроса, как его задаёт человек**: «How many unique users over time» — это то, по чему рецепт находится поиском |
| `required_events` | да | события, без которых рецепт не работает | реальные имена из `known_events`; пустой список — если рецепт не про события |
| `required_properties` | да | свойства payload | имена свойств; пустой список допустим |
| `required_user_attrs` | да | атрибуты размерности | имена колонок `dim_users` |
| `required_roles` | нет | роли, которые должны быть в каталоге | `[experiments]` для A/B, `[acquisition]` для расходов |
| `metric_types` | да | какого рода результат | из словаря ниже |
| `create_payload` | одно из | payload `create_semantic_model` | управляемый путь: `name`, `use_base_models?`, `semantic_models`, `metrics` |
| `register_payload` | одно из | payload с `pipeline` | для того, что метрикой не выразить: воронки, сессии, окна, A/B-агрегаты |
| `tool_calls` | одно из | `[{ tool, args }]` | рецепт без склада — чистый расчёт (`experiment({ action: 'plan' })`) |
| `example_queries` | для `create_payload` | `[{ metrics, group_by?, … }]` | 2–5 запросов: **первый исполняется в тесте**; остальные показывают срезы. Имена метрик — полные |
| `ab_test` | для A/B | сопоставление колонок результата → аргументы `experiment({ action: 'analyze' })` | см. таблицу ниже |
| `srm_check` | для SRM | `{ group_field, n_field, expected_ratio? }` | → `experiment({ action: 'check_split' })` |
| `approach` | для приёма | форма, которая работает | одна строка кода в обратных кавычках + чем она является; только в рецепте-приёме |
| `instead_of` | для приёма | форма, которая падает, и почему | называйте класс ошибки (`NullIndexError`, `OrderRequiredError`) или в чём тихая неправильность |
| `read_first` | для python | куда пойти ДО написания функции | `semantic_index({ guide: "python" })` — правила рантайма; рецепт есть один приём оттуда |
| `notes` | да | что учесть при чтении результата | оговорки, определения, что НЕ значит цифра |
| `hack` | да | обобщённый приём | формула: *что сделать → чем это является → как расширить* («Extrapolate: …») |

Семейства системного слоя — технические, по роду приёма:

| `task_type` | что в нём |
|---|---|
| `metric_types` | губернируемые метрики: простая по метрик-тайму, ratio, derived, cumulative, conversion-окно, boolean-мера, выбор агрегации под вопрос, губернируемая мера из схемы, воронка из шагов-свойств, две шкалы событий и нетто, одна мера на двух гранах, мера не-событийного источника |
| `joins` | связи: группировка по атрибуту другой модели, когортная сетка по двум временным осям, метрики двух независимых источников, джойн пайплайна по имени связи, point-in-time джойн |
| `pipeline` | шаблоны стадий: оконный lag и дельта, эпизоды по разрыву, ось возраста через date_diff, упорядоченная последовательность (match_recognize), unnest массива, переформатирование (unpivot/pivot), проверка объёма и покрытия |
| `ab_test` | статистика: proportion, mean (Welch), CUPED, ratio (delta-метод), SRM, планирование мощности, две любые группы без эксперимента |
| `bigframes` | ходы на python-рантайме: правильная форма одной операции над фреймом рядом с падающей (см. четвёртую форму ниже) |

Семейства ВАШЕГО слоя — какие захотите (`trends`, `monetization`, `ads`, `economy`,
`progression`, `engagement`, `data_quality`, …): `{ guide }` покажет их рядом с системными,
и именно так бизнес-язык и попадает в набор, не смешиваясь с техникой.

Словарь `metric_types`: `simple`, `ratio`, `derived`, `cumulative`, `conversion` — типы
управляемых метрик; `proportion`, `mean`, `cuped`, `ratio` — статистические тесты A/B; `srm`,
`power` — сопутствующие расчёты.

### Четыре формы рецепта

**Управляемая метрика** — `create_payload` + `example_queries`. Самая частая форма. Агент
может не только выполнить пример, но и **переспросить** тот же контекст любым другим срезом.

```json
{
  "id": "metric_by_user_segment",
  "task_type": "segmentation",
  "title": "Metric sliced by a user attribute",
  "when_to_use": "Revenue / payers / ARPPU broken down by country, platform, media_source or acquisition_type.",
  "required_events": ["iap_purchase_completed"],
  "required_properties": ["price_in_usd"],
  "required_user_attrs": ["country", "platform", "media_source", "acquisition_type"],
  "metric_types": ["simple", "ratio"],
  "create_payload": {
    "name": "rev_segment",
    "use_base_models": ["users"],
    "semantic_models": [{
      "from": "events",
      "event_scope": { "event_name": ["iap_purchase_completed"] },
      "measures": [
        { "name": "revenue", "agg": "sum",            "field": "price_in_usd_of_event_data" },
        { "name": "payers",  "agg": "count_distinct", "field": "player_id_of_internal" }
      ]
    }],
    "metrics": [
      { "name": "revenue", "type": "simple", "measure": { "name": "revenue" } },
      { "name": "payers",  "type": "simple", "measure": { "name": "payers" } },
      { "name": "arppu",   "type": "ratio",  "numerator": { "name": "revenue" }, "denominator": { "name": "payers" } }
    ]
  },
  "example_queries": [
    { "metrics": ["rev_segment_revenue"], "group_by": [{ "model": "users", "attribute": "country" }] },
    { "metrics": ["rev_segment_arppu"],   "group_by": [{ "model": "users", "attribute": "acquisition_type" }] }
  ],
  "notes": "User attributes come through the declared events.user → users.user relationship; no join is written.",
  "hack": "Any measure + group_by { model: 'users', attribute: '<attr>' } makes the semantic layer join the user dimension. Extrapolate: segment ANY metric by ANY user attribute the same way."
}
```

**Pipeline** — `register_payload` c `pipeline`, часто с `ab_test` / `srm_check`. Для того, чего
управляемая метрика не выражает. Результат — таблица; тест требует **не меньше двух строк**.

```json
{
  "id": "ab_test_conversion",
  "task_type": "ab_test",
  "required_roles": ["experiments"],
  "metric_types": ["proportion"],
  "register_payload": {
    "name": "ab_checkout_conversion",
    "pipeline": {
      "source": "events",
      "stages": [
        { "stage": "join", "with": "experiments", "via": "user",
          "attrs": ["experiment_name", "variant_group", "assigned_at", "ended_at"] },
        { "stage": "where", "conditions": [
          { "left": { "column": "device_time" }, "op": "gte", "right": { "column": "assigned_at" } },
          { "left": { "column": "device_time" }, "op": "lte", "right": { "column": "ended_at" } } ] },
        { "stage": "compute", "name": "is_conv", "op": "case", "type": "int",
          "cases": [{ "when": [{ "column": "event_name", "op": "eq", "value": "iap_purchase_completed" }], "then": { "value": 1 } }],
          "else": { "value": 0 } },
        { "stage": "aggregate", "group_by": ["experiment_name", "variant_group", "player_id_of_internal"],
          "measures": [{ "name": "converted", "fn": "max", "column": "is_conv" }] },
        { "stage": "aggregate", "group_by": ["experiment_name", "variant_group"],
          "measures": [{ "name": "n", "fn": "count" }, { "name": "conversions", "fn": "sum", "column": "converted" }] },
        { "stage": "order_by", "keys": [{ "key": "variant_group", "direction": "asc" }] }
      ]
    }
  },
  "ab_test": { "metric": "proportion", "group_field": "variant_group", "n_field": "n", "conversions_field": "conversions" },
  "notes": "Rows are n + conversions per variant (exposed = users with in-window events). Control = the control variant_group row, variants = the rest.",
  "hack": "Join experiments, window events to [assigned_at, ended_at], flag conversion per user (case → max), aggregate n + conversions per variant, call experiment({ action: 'analyze' }). Extrapolate: any per-variant rate."
}
```

Сопоставление `ab_test` — какие колонки результата нужны для какого теста:

| `metric` | обязательные поля сопоставления | что должен отдать pipeline на каждую группу |
|---|---|---|
| `proportion` | `group_field`, `n_field`, `conversions_field` | число пользователей и число сконвертировавшихся |
| `mean` | `group_field`, `n_field`, `mean_field`, `stddev_field` | n, среднее, стандартное отклонение (сначала агрегируйте на пользователя) |
| `cuped` | … + `sumY_field`, `sumY2_field`, `sumX_field`, `sumX2_field`, `sumXY_field` | суммы метрики и ковариаты (до-экспериментальной) и их произведений |
| `ratio` | … + `sumNum_field`, `sumDen_field`, `sumNum2_field`, `sumDen2_field`, `sumNumDen_field` | суммы числителя, знаменателя, квадратов и произведения |

Первая строка результата — контроль, остальные — варианты; поэтому `order_by` по группе
в конце pipeline обязателен: порядок строк — часть контракта.

**Только инструмент** — `tool_calls`, без склада. Каждый вызов должен вернуть `ok: true`.

```json
{
  "id": "ab_test_power",
  "task_type": "ab_test",
  "metric_types": ["power"],
  "required_events": [], "required_properties": [], "required_user_attrs": [], "required_roles": [],
  "tool_calls": [
    { "tool": "experiment", "args": { "action": "plan", "metric": "proportion", "baseline": 0.2, "mde": 0.02 } },
    { "tool": "experiment", "args": { "action": "plan", "metric": "mean", "stddev": 12, "mde": 1.5 } }
  ],
  "notes": "Pure calculation. Provide baseline (proportion) or stddev (mean) plus EXACTLY ONE of mde or n.",
  "hack": "Up-front power analysis: baseline + target effect → required n per group; or n → MDE. Run before the test and after an inconclusive one."
}
```

**Приём работы с python-рантаймом** — `register_payload` со стадией `python`, `requires:
"python_models"`, `runtime: "<рантайм>"` и парой `approach` / `instead_of`. Такой рецепт описан
НЕ по бизнес-задаче, а по ОДНОМУ ДЕЙСТВИЮ над фреймом: подставить значение из справочника,
вернуть агрегат группы на строки, взять топ-N, посчитать порог, предсказать модель, закешировать
промежуток. Причина: на BigFrames падает или тихо врёт не задача, а конкретная форма записи
(у фрейма из `dbt.ref()` нет индекса и нет порядка строк), поэтому полезно ровно то, что
показывает рабочую форму рядом с падающей. Реальный вопрос собирается из нескольких таких
приёмов — id названы по действию (`bf_*`), а не по вопросу.

То же правило распространяется на ML-часть библиотеки: не «рецепт на сегментацию игроков», а по
ОДНОЙ ВОЗМОЖНОСТИ — параметры оценщика и куда девать стандартизацию, предсказание в строку,
обучение с метками `fit(X, y)`, оценка через `train_test_split` + `score()`, снижение размерности,
категориальные признаки через `ColumnTransformer`, вывод, который ЗАМЕНЯЕТ фрейм. А то, что агент
рискует вспомнить неправильно — подписи конструкторов и предусловия методов, — вообще не
пересказывается: оно генерируется из установленной библиотеки и публикуется отдельными
СПРАВОЧНЫМИ рецептами (`bf_ml_signatures`, `bf_frame_method_rules`), которые забираются по id
посреди написания кода. Правило, по которому это разложено (какой текст где живёт), написано
в начале `src/python-guide.js` и охраняется `test/unit/python-surface-layering.test.js`.

```json
{
  "id": "bf_lookup_via_merge",
  "task_type": "bigframes",
  "title": "BigFrames approach — a value from a lookup: merge, never map",
  "when_to_use": "You have a mapping (id → label, day → target, country → tier) and want it as a column.",
  "approach": "Put the other side in a frame and MERGE on the key: `lookup = bpd.DataFrame({\"k\": [...], \"v\": [...]}); df = df.merge(lookup, on=\"k\", how=\"left\")`.",
  "instead_of": "`df[\"v\"] = df[\"k\"].map(mapping)` — map aligns two objects by index, and the frame from dbt.ref() has none: NullIndexError.",
  "requires": "python_models",
  "runtime": "bigframes",
  "read_first": "semantic_index({ guide: \"python\" }) first — the frame rules of this runtime. This recipe is ONE approach from it, filled in and compiling.",
  "register_payload": { "name": "lookup_merge", "pipeline": { "source": "events", "stages": ["…SQL-стадии…", "…стадия python…"] } },
  "notes": "…",
  "hack": "Any \"value from somewhere else\" is a merge: a dict, a groupby result, a second table, a threshold per group."
}
```

Как такой рецепт достаётся агенту: описание стадии `python` — это ИНДЕКС рецептов, а не
инструкция. Оно несёт, чем этот рантайм отличается и чем это грозит, а дальше — каждый id вместе
с приёмом, который он закрывает (`<id>: <title>`), под требованием изучить их ДО того, как писать
функцию (`STUDY THE RECIPES FIRST`), и `semantic_index({ recipe: "<id>" })`, чтобы взять один
целиком. Сами формы кода лежат в рецептах и в `semantic_index({ guide: "python" })` — там правила
с обоснованием и do/avoid/why на каждую операцию; `{ guide: true }` показывает рецепты вместе под
`tasks.bigframes`. Поэтому `title` у такого рецепта — это НАЗВАНИЕ ПРИЁМА: по нему агент в описании
выбирает, что читать. Там, где dbt не запускает python-модели, они не предлагаются вовсе — и тогда
описанию стадии не на что ссылаться, поэтому оно возвращается к тому, чтобы нести все правила и
формы само.

### Что рецепт обязан выдержать

Рецепт **не валидируется по структуре** при загрузке — он валидируется **исполнением**.
`test/integration/recipes-parse.test.js` прогоняет каждый рецепт на складе фикстуры:

| форма | что проверяется |
|---|---|
| `create_payload` | `create_semantic_model` парсится (dbt parse), **первый** `example_queries` исполняется и возвращает строки |
| `register_payload` | pipeline собирается и выполняется, результат ≥ 2 строк; если есть `ab_test` — строки скармливаются `experiment({ action: 'analyze' })` и `p_value` ∈ [0, 1]; если `srm_check` — то же для `check_split` |
| `tool_calls` | каждый вызов возвращает `ok: true` |
| `requires: python_models` | на складе фикстуры (PGlite) python-модели не бегают, поэтому проверяется КОМПИЛЯЦИЯ под развёртывание, которое их бегает: `register_native_model({ …, dry_run: true })` — стадии рендерятся, цепочка моделей раскладывается, тела функций проходят статический гейт, объявленные `output.columns` доходят до SQL-стадий после; плюс наличие `read_first`, `hack`, `notes` |

Следствия для автора: имена событий, свойств и атрибутов в payload должны существовать **в
фикстуре** (`test/integration/fixtures/catalog.yml`), а не только в проде — иначе рецепт не
проходит тест и не попадает в поставку. `required_*` при этом **никем не проверяются** — это
подсказка агенту, что нужно иметь в каталоге, чтобы приём был применим; заполняйте честно.

### Как писать `when_to_use`, `notes`, `hack`

Три текстовых поля работают по-разному, и путать их — главная ошибка.

- **`when_to_use` — для поиска.** Индексируется вместе с `id`, `title`, `task_type` и `hack`.
  Пишите словами вопроса, а не словами реализации: «how many users came back on day 7», а не
  «conversion metric with a 7-day window». Несколько формулировок через запятую — нормально.
- **`notes` — для чтения результата.** Что цифра значит и чего не значит, какие определения
  приняты («cohort = users with a first_launch»), какой шаг обязателен перед выводом («run
  check_split first»). Не пересказывайте payload — он рядом.
- **`hack` — для переноса.** Формула из трёх частей: *что сделали → чем это является в терминах
  семантического слоя → как расширить.* Обязательная третья часть начинается со слова
  «Extrapolate:» — так агент отличает приём от описания. Пример: «Retention = a conversion
  metric (base = install event, conversion = a later activity event) with window = 'N day'.
  Extrapolate: change N or the base/return events for any Dn.»

Все три — на английском, как и описания в схеме (см. «Язык описаний»).

### Чего в рецепте не должно быть

- значений, которые агент возьмёт из индекса: «top countries are US, GB» — он спросит сам;
- payload, который работает только на проде: рецепт без прохождения теста не рецепт;
- нескольких задач в одном рецепте — одна задача, один `hack`; вторая задача — второй рецепт;
- `example_queries` с одними и теми же срезами: каждый пример должен показывать новый способ
  спросить тот же контекст (по времени, по атрибуту, через связь);
- имён метрик без префикса задачи в `example_queries` — запрос не найдёт метрику.

### Чек-лист нового рецепта

- [ ] `id` по задаче, `task_type` из существующих семейств (или осознанно новое);
- [ ] `when_to_use` — формулировками вопроса; `title` — что считаем;
- [ ] ровно одна форма: `create_payload` + `example_queries` / `register_payload` (+ `ab_test`/`srm_check`) / `tool_calls`;
- [ ] все имена в payload существуют в фикстуре; первый пример возвращает строки;
- [ ] для A/B: результат отсортирован по группе, контроль первой строкой, сопоставление полей полное;
- [ ] `required_*` заполнены честно, `required_roles` — если нужна роль кроме событий и пользователей;
- [ ] `hack` заканчивается «Extrapolate: …»; `notes` — про чтение результата, не про payload;
- [ ] `npm run test:integration -- test/integration/recipes-parse.test.js` зелёный.

---

## 3. Конфиги, которые загрузка отвергает

Тот же принцип действует и на границе со складом: если в таблице нет колонки, на которую
опирается вся логика модели, модель не идёт дальше. Для источника событий это колонки
`is_event_name` и `is_time`, а также `is_event_data`, когда в blob объявлены `properties`;
для любой модели — все части ключа `primary_entity`. Отсутствие самой таблицы считается тем же.
Модель исключается из каталога с причиной: остальные источники работают как обычно, обзор
перечисляет её в `unavailable_models`, `semantic_index({ model })` называет недостающие колонки,
а `create_semantic_model` / `build_native_model` отвечают отказом валидации с той же причиной.
Если недоступными оказались **все** источники событий, сервер не стартует. Окно валидности сюда
не входит: без колонок окна модель считается плоской размерностью, это штатная деградация.
Обычные колонки — атрибут, свойство, величина, одна из связей, колонка приложения — вырезаются
по одной, и модель остаётся доступной.


Каждый из них раньше загружался и собирал модель по **одному** из двух объявлений — какое
победит, решал порядок ключей в файле. Теперь каждый отвергается с указанием замены.

| что в схеме | почему отказ |
|---|---|
| две колонки с `entity.type: primary` | у модели одна идентичность; для ключа из двух колонок — составной ключ в `entities` |
| `primary_entity: X`, а колонка объявляет `primary` с именем `Y` | одно из двух отбрасывалось |
| одна связь на двух колонках | вторая перезаписывала первую; альтернативные ключи — это `variants` |
| одна связь и на колонке, и в `entities` | уровень модели побеждал по позиции в файле |
| связь названа так же, как `primary_entity` | в манифест уходили две сущности с одним именем |
| `type: natural` руками | dbt падал фразой DSI про окно валидности, которого автор не писал |
| окно валидности на источнике событий | признак ставился, а рендер факта его не читал вообще |
| метка `validity` на колонке-ключе / оси времени / величине | ветка колонки забирала её раньше разбора размерностей — метка не читалась никогда |

Проверки: `test/unit/declared-join-keys.test.js`.

---

## 4. Что сервер уже знает из данных — и чего поэтому НЕ писать в описаниях

Это главный пункт документа. Всё в левой колонке агент получает **измеренным**, из
value-индекса и интроспекции склада. Дублировать это статичным текстом не нужно и вредно:
текст устаревает, а данные нет.

| сервер отдаёт сам | откуда | значит в `description` НЕ пишем |
|---|---|---|
| список значений и их частоты, топ-N | value-индекс | «Возможные значения: wifi, cellular, …» |
| число различных значений | value-индекс | «Около 200 уникальных кампаний» |
| полнота: доля NULL, покрытие | склад | «Обычно пустое», «заполнено в 80% строк» |
| на каких событиях свойство встречается | измеренное покрытие по событиям | «Приходит на level_completed» |
| покрытие по приложениям | value-индекс по bundle | «В fillwords не собирается» |
| свежесть данных | max по оси времени | «Данные до вчера» |
| какие колонки реально есть | интроспекция | — (несуществующее просто не появится) |
| ключи связей, их тип, куда ведут, и что с ними можно | `entities` | «Джойнится с dim_users по player_id» |
| какие поля агрегируемы, с какими функциями | `measure` / `measures` | «Можно суммировать» |
| подсказка про партиционирование | `partition_column` | «Всегда фильтруй по дате» |
| единица и подпись величины | `unit`, `label` | — (пишем в ключи, не в прозу) |

Единственное исключение про полноту: короткая фраза-**контракт** («приходит на каждом
событии») уместна, потому что это обещание пайплайна, а не измерение — если поле пустое,
это баг данных, и агенту полезно знать, что так быть не должно. Но чисел и долей — не надо.

**Отдельно про перечисление значений.** Реальный пример из нашего продового каталога:

```yaml
# ПЛОХО — семь значений, которые индекс отдаёт с частотами и которые изменятся
- name: app_id_of_main_data
  description: "Short app code identifying the game (e.g. fillwords, relax_puzzles,
    sky_words, tile_trip, word_pizza, word_search_sea, word_spells)."
```

```yaml
# ХОРОШО — смысл и назначение; значения агент возьмёт из индекса, свежие
- name: app_id_of_main_data
  description: "Short internal game code — a stable app identifier that survives rebranding
    and is NOT the store bundle_id. The axis for comparing games with each other."
```

Словаря значений в схеме **нет вовсе** — ни как ключа, ни как прозы. Значения, их частоты и
то, на каких событиях поле заполнено, агент получает из индекса, по каждому источнику отдельно.
В описание идёт только **смысл** особого значения («пустая строка — игрок отказался»), не список.

---

## Язык описаний — английский

Все `description` — модели, колонки, величины — пишутся **на английском**. Это правило, а не
рекомендация, и причины у него технические:

- **Один язык на весь контекст агента.** Имена колонок, ключи схемы (`role`, `entities`,
  `measure`), тексты инструментов MCP, сообщения об ошибках и значения в индексе — английские.
  Русское описание посреди этого читается как исключение, и модель тратит внимание на
  переключение, а не на смысл.
- **Поиск работает по словам.** `semantic_index({ search })` сравнивает запрос с именами и
  описаниями. Английское описание находится и по английскому имени колонки, и по термину
  из вопроса; смесь языков дробит одно понятие на два набора слов, и половина совпадений
  теряется.
- **Так уже устроен продовый каталог** — все 202 колонки `fct_analytics_events` описаны
  по-английски. Новые источники не должны заводить второй язык.

Термины бизнеса, у которых нет устоявшегося английского эквивалента, транслитерируются и
поясняются один раз: `"Fillwords (word-search game) app code"`. Внутри этого документа
пояснения — на русском, а **примеры описаний — на английском**, как они и должны стоять в схеме.

---

## 5. `description` к МОДЕЛИ

Появляется в обзоре целиком при первом же вызове. Пишите его как **инструктаж перед работой**,
а не как строку каталога.

**Обязательные четыре слота:**

1. **Что такое одна строка** (грань). Дословно: «одна строка = одно событие», «одна строка =
   один игрок», «одна строка = игрок × эксперимент», «одна строка = игрок × день».
2. **Чем модель является в бизнес-смысле** и зачем существует.
3. **Как её соединять** — по какой сущности, и если соединение point-in-time, то прямо сказать.
4. **Границы применимости** — чего в этой модели нет и куда за этим идти.

**Что ещё стоит написать здесь, и только здесь:** правила поведения, которые агент должен
знать до первого запроса. Окно доступных данных («события есть с 2024-01»), определение
метрик времени, специфика потока событий, требование ограничивать время, соглашение об
именах. Это единственное место, где директива гарантированно прочитана.

```yaml
description: >
  Crash reports: one row = one report sent from a device. A source independent of the
  product events, with its own event vocabulary (fatal_crash / non_fatal / anr) and its
  own payload. Time axis is event_time — device time in the player's time zone.
  Joins to dim_users by player; dim_users is slowly-changing, so the join is
  point-in-time: in a pipeline state the window in join.between.
  There are NO product events and NO revenue here — those live on the events source.
  Stack frames and breadcrumbs are complex types, reachable only through a pipeline
  (unnest / struct_field).
```

Чего в описании модели не надо: числа строк, перечни событий (их считает сервер), список
колонок, повторение того, что уже сказано ключами `role` / `primary_entity` / `time`.

---

## 6. `description` к ПОЛЮ

Читает тот, кто уже пришёл за этим полем. Задача текста — чтобы поле нельзя было применить
неправильно.

### Формула: четыре слота, по одному предложению

```
[1 что это по-человечески] [2 как заполняется / откуда берётся]
[3 ловушка или граница] [4 для какого вопроса брать]
```

Не все четыре обязательны для каждого поля, но **если у поля есть ловушка — она обязательна.**
Ради неё описание и существует.

### Пиши

| что | зачем | пример |
|---|---|---|
| расшифровку сокращённого имени | `anr` = Application Not Responding | "ANR — the main thread stopped responding" |
| смысл, а не тип | тип агент видит | "per-player session counter" |
| **шкалу и единицу** | главный источник ошибок в 10× и 100× | "revenue in **cents**", "playtime in seconds" |
| **какие часы** | сдвиг на сутки в отчётах | "device time in the player's zone, not server UTC" |
| **чем отличается от соседнего поля** | их два, а правильный один | "unlike `bundle_id`, survives rebranding" |
| **как заполняется** | объясняет пропуски и перекосы | "set on the ad request, not on the impression" |
| **историю схемы** | иначе тихий недосчёт по старым данным | "present from v1; absent on older events" |
| **смысл особых значений** | не список, а значение | "empty string = declined, NULL = never asked" |
| для какого вопроса брать | маршрутизирует | "the lifetime axis for retention" |
| синонимы, которыми это называют вслух | поиск индексирует описания | "media source, a.k.a. acquisition network / channel" |

### Не пиши

- значения и их частоты, кардинальность, доли NULL — **сервер измеряет** (см. §4);
- на каких событиях встречается — индекс измеряет покрытие по событиям;
- имя колонки другими словами: `device_model — "Device model."` не добавляет ничего;
- тип данных и «может быть NULL»;
- как соединять и по какой колонке — это `entities`;
- какую агрегацию применять — функцию выбирает вызывающий;
- ссылки на дашборды, тикеты, имена людей, даты «актуально на»;
- «важное поле», «используется в отчётности» — оценок агент применить не может.

### Плохо → хорошо

```yaml
# ПЛОХО: пересказ имени
- name: revenue_of_event_data
  description: "Ad revenue."
# ХОРОШО: шкала + как заполняется + ловушка
- name: revenue_of_event_data
  description: >
    Revenue from ONE ad impression, in CENTS (divide by 100 for USD). The network's
    estimate, delivered with the impression event and never restated afterwards, so the
    sum here differs from the network's own report for the same day. Empty on ad_started —
    populated on ad_finished.
```

```yaml
# ПЛОХО: тип и очевидность
- name: device_time
  description: "Event timestamp, may be NULL."
# ХОРОШО: какие часы + роль поля
- name: device_time
  description: >
    When the event happened on the player's device, normalized to the player's time
    zone — not the server's receive time. The source's primary time axis: a day here is
    the player's day, so daily charts will not match server-side ones across zone borders.
```

```yaml
# ПЛОХО: дублирует то, что считает индекс
- name: media_source
  description: "Acquisition source. Values: organic, meta, google, applovin (about 40 in
    total); empty for 12% of players."
# ХОРОШО: смысл + различение + синонимы
- name: media_source
  description: >
    The channel that brought the player (a.k.a. media source, acquisition network) — from
    attribution at install time, never updated afterwards. Organic arrives as its own value,
    not as an empty one: empty means attribution did not arrive, and such players are NOT
    organic. The primary cut for comparing traffic quality.
```

### Длина

Одно-три предложения. Больше — только если у поля есть настоящая история схемы или
несколько ловушек. Исследования по text-to-SQL показывают, что более подробные описания
поднимают точность даже там, где человеку они кажутся избыточными (+20% и более на
BIRD-Bench), — но это про **смысл и ловушки**, а не про пересказ данных, которые агент и так
получает измеренными.

---

## 7. Особые случаи

**Свойства событий (payload).** Колонка помечается `meta.mcp.property: true`; описание пишется
на неё. На каких событиях поле заполнено — измеряет индекс; в тексте — что это за величина, её
единица и ловушки.

**Величины.** `unit` и `label` — ключи, не проза. В `description` — что именно входит в сумму
и что не входит: "acquisition spend excluding VAT and agency fees".

**Ключи связей.** Обычно описания не требуют вообще: тип, части ключа и цель отдаёт
`semantic_index`. Пишите, только если ключ неочевиден: "ad-funnel id shared by every event of one
funnel; empty on events outside an ad funnel".

**Колонки окна валидности.** Скажите, что это границы версии строки, а не бизнес-даты:
"start of the period during which this version of the player's attributes was current".

**Сложные типы (массивы, JSON).** Скажите форму и что с ней делать: "JSON array of stack
frames, each `{ file, line, in_app }`; reach it in a pipeline via `unnest` / `struct_field`".
Это единственный случай, когда структура значения уместна в тексте: индекс профилирует
скаляры, а не вложенные поля.

**Технические колонки.** Ставьте `dimension: false` и **не описывайте** — поле не должно
попадать в перечень атрибутов вообще.

---

## 8. Чек-лист перед коммитом схемы

Структура:

- [ ] у каждой модели есть `meta.mcp.role`, и роль в каталоге одна;
- [ ] `primary_entity` объявлена один раз — либо строкой на модели, либо на своей колонке;
- [ ] у каждой связи ровно один владелец, и число частей ключа совпадает с обеих сторон;
- [ ] `unique` проверен запросом на дубли (§2.2);
- [ ] свойства payload помечены `property: true` (массивы — `array`); никаких списков событий или значений;
- [ ] величины помечены `measure`, `agg` добавлен только там, где функция обязана быть одна;
- [ ] технические поля — `dimension: false`, идентификаторы — `index: false`;
- [ ] окна валидности — парой, только на размерности, и у такой модели один ключ соединения;
- [ ] в именах свойств и размерностей нет `__`.

Описания:

- [ ] все описания — на английском, один язык на весь каталог;
- [ ] у модели описаны грань строки, назначение, способ соединения, границы применимости;
- [ ] правила поведения (окно данных, требование ограничивать время) — в описании модели;
- [ ] у каждого поля со шкалой указана единица; у каждого времени — какие часы;
- [ ] у пар похожих полей сказано, чем они отличаются;
- [ ] ни одно описание не перечисляет значения, доли и кардинальность;
- [ ] нет пересказов имени, типов, «может быть NULL», ссылок и дат актуальности.

Проверить локально:

```bash
node -e "import('./src/catalog.js').then(({loadCatalog}) => {
  const c = loadCatalog('config/catalog.yml', {});
  console.log('роли:', c.modelKeys().join(', '));
})"
```

Загрузка отвергнет противоречия из §3 сразу и скажет, чем заменить. Дальше посмотрите глазами
агента — тем же вызовом, которым он смотрит: `semantic_index()` (обзор — виден текст модели),
`semantic_index({ model })` (колонки и их тексты рядом с измеренными значениями).

---

## Источники

Внешние практики описаний метаданных для ИИ-агентов, с поправкой на то, что у нас часть
контекста поступает из данных:

- [Synthetic SQL Column Descriptions and Their Impact on Text-to-SQL Performance](https://arxiv.org/html/2408.04691) — подробные описания колонок заметно поднимают точность; «избыточные» для человека детали помогают модели.
- [Techniques for improving text-to-SQL (Google Cloud)](https://cloud.google.com/blog/products/databases/techniques-for-improving-text-to-sql) — имён колонок недостаточно: нужны бизнес-определения, контекст связей и примеры значений.
- [Semantic Layer vs. Text-to-SQL (dbt Labs)](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026) — почему согласованный семантический слой точнее генерации SQL по сырой схеме.
- [How a semantic layer makes your text-to-SQL agent smarter (Neo4j)](https://neo4j.com/blog/agentic-ai/how-a-neo4j-semantic-layer-makes-your-text-to-sql-agent-smarter-and-cheaper/) — сущности и связи как отдельный слой поверх таблиц.
