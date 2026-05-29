# Аналитический MCP-сервер для игровой event-аналитики

> Дизайн-документ: какие тулы нужны, какие параметры в них заложить, как сделать
> их **гибкими, универсальными и консистентными**, чтобы AI вызывал **структурные
> инструменты**, а не генерировал SQL «из головы».

Документ описывает семантическую обёртку над двумя таблицами (события + атрибуты
пользователей), которая закрывает широкий класс продуктовых/игровых аналитических
задач: тренды, воронки, retention, когорты, сегментация, поведенческие когорты,
path-анализ, lifecycle, stickiness, прогрессия по уровням и монетизация.

---

## 1. Цели и принципы дизайна

1. **Структурность вместо свободного SQL.** AI выбирает тул и заполняет
   типизированные параметры. Сам SQL генерируется детерминированно внутри
   сервера. Это даёт корректность, безопасность (нет SQL-инъекций и «галлюцинаций
   названий колонок») и воспроизводимость.
2. **Композиционность.** Небольшой набор **переиспользуемых строительных блоков**
   (фильтры, временной диапазон, разбивки, ссылка на когорту) используется во
   **всех** тулах одинаково. Один раз понял фильтр — понял его везде.
3. **Ортогональность.** Каждый тул отвечает на один класс вопросов. Сложные
   задачи собираются комбинацией тулов (например, поведенческая когорта →
   retention этой когорты).
4. **Grounding через метаданные.** Прежде чем что-то считать, AI может (и должен)
   спросить у сервера, какие события и свойства существуют. Это убирает угадывание
   имён.
5. **Dry-run по умолчанию.** Любой тул умеет вернуть сгенерированный SQL без
   выполнения (`dry_run: true`) — для проверки и обучения доверию.
6. **Консистентный контракт ответа.** Все тулы возвращают единый конверт:
   `sql`, `columns`, `rows`, `row_count`, `warnings`, `assumptions`.

---

## 2. Доменная модель данных

Сервер опирается на конфигурируемую схему (semantic schema), описывающую две
таблицы. Это единственное место, где «зашиты» физические имена колонок — тулы
оперируют только логическими именами.

### 2.1 Таблица событий (`events`)
Канонические поля (маппятся на реальные колонки в конфиге):

| Логическое поле | Назначение |
|---|---|
| `user_id` | идентификатор игрока (ключ join с users) |
| `event_name` | тип события (`level_start`, `level_complete`, `purchase`, `session_start`, ...) |
| `event_timestamp` | время события (UTC) |
| `session_id` | (опц.) сессия |
| `event_properties` | полуструктурированные свойства (JSON/MAP): `level`, `score`, `attempt`, `moves`, `revenue`, `currency`, `item_id`, `result` (`win`/`lose`), ... |

### 2.2 Таблица атрибутов пользователей (`users` / UA-данные)
Атрибуты на уровне игрока (обычно «срез на момент установки»):

| Логическое поле | Назначение |
|---|---|
| `user_id` | ключ |
| `install_date` / `first_seen` | дата привлечения (опора для acquisition-когорт) |
| `platform`, `os_version`, `device_model` | техническое |
| `country`, `region`, `language` | гео |
| `media_source`, `campaign`, `ad_group`, `creative` | UA / атрибуция |
| `acquisition_type` (`organic`/`paid`) | канал |
| `app_version` | версия на установке |
| произвольные `user_properties` | расширяемый набор |

> **Конфиг схемы** задаёт: имена таблиц, маппинг логических полей, тип хранения
> `event_properties` (JSON vs колонки), список «известных» событий и свойств с
> типами. Метаданные-тулы (§4.1) читают именно отсюда.

---

## 3. Переиспользуемые строительные блоки (общие типы параметров)

Эти объекты — фундамент консистентности. Они используются во всех тулах с
одинаковой семантикой.

### 3.1 `TimeRange`
```jsonc
{
  "type": "relative" | "absolute",
  "last": "30d",                 // для relative: 7d / 12w / 6mo / 90d
  "from": "2026-01-01",          // для absolute
  "to":   "2026-03-31",
  "timezone": "UTC"
}
```

### 3.2 `Granularity`
`hour | day | week | month | quarter` — шаг временной оси / окна.

### 3.3 `EventSelector` — как опознать событие
```jsonc
{
  "event": "level_complete",     // имя события; "*" = любое
  "filters": FilterGroup,        // условия на свойства этого события (см. 3.4)
  "alias": "win"                 // имя для отображения/ссылок (опц.)
}
```

### 3.4 `FilterGroup` — рекурсивные условия (И/ИЛИ)
Единый язык фильтрации для **свойств событий** и **атрибутов пользователей**.
```jsonc
{
  "op": "and" | "or",
  "conditions": [
    {
      "field": "event_properties.level",   // или "user.country"
      "operator": "eq|neq|gt|gte|lt|lte|in|not_in|between|contains|is_null|is_not_null",
      "value": 50
    },
    { "op": "or", "conditions": [ ... ] }   // вложенность допускается
  ]
}
```
- Префикс `event_properties.*` → условие на свойство события.
- Префикс `user.*` → условие на атрибут пользователя (join к `users`).

### 3.5 `Measure` — что считаем
```jsonc
{
  "type": "count_events"        // число событий
        | "count_unique_users"  // DAU/уник. пользователи
        | "count_sessions"
        | "sum" | "avg" | "min" | "max" | "median" | "p90" | "p95",
  "field": "event_properties.revenue",   // для агрегатов по полю
  "alias": "revenue"
}
```

### 3.6 `Breakdown` (разбивка/сегментация)
Список измерений, по которым «разрезать» результат: например
`["user.country", "user.platform", "event_properties.level"]`. Используется
во всех тулах единообразно.

### 3.7 `CohortRef` — ссылка на популяцию пользователей
Любой тул может ограничить расчёт некоторой когортой. Когорту можно задать
**инлайн** или **по ссылке** на ранее построенную (§4.4).
```jsonc
{
  "ref": "cohort_abc123"                 // ссылка на сохранённую когорту
  // ИЛИ инлайн-определение:
  "inline": {
    "user_filter": FilterGroup,          // по атрибутам (UA)
    "did_events": [ EventSelector ],     // совершил эти события...
    "did_not_events": [ EventSelector ], // ...и НЕ совершал эти
    "within": TimeRange
  }
}
```

> **Принцип:** `TimeRange`, `FilterGroup`, `Breakdown`, `Measure`, `CohortRef`
> выглядят одинаково в каждом туле. Это и есть «гибко, универсально и
> консистентно».

---

## 4. Каталог тулов

Для каждого тула: назначение, ключевые параметры (поверх общих блоков), форма
вывода и эскиз генерируемого SQL.

### 4.0 Категории
| Категория | Тулы |
|---|---|
| Метаданные / grounding | `list_events`, `list_properties`, `describe_schema` |
| Базовая аналитика | `metrics_timeseries`, `segmentation` |
| Поведение во времени | `funnel_analysis`, `retention_analysis`, `lifecycle_analysis`, `stickiness_analysis` |
| Когорты | `cohort_retention_grid`, `cohort_define`, `behavioral_segment` |
| Глубокое поведение | `path_analysis`, `distribution_analysis`, `user_timeline` |
| Игровая специфика | `progression_analysis`, `monetization_analysis` |
| Исполнение | `preview_sql` / `run_query` (режимы) |

---

### 4.1 Метаданные (grounding) — `list_events`, `list_properties`, `describe_schema`

**Зачем:** дать AI «карту территории», чтобы он не угадывал имена.

| Тул | Параметры | Выход |
|---|---|---|
| `list_events` | `search?`, `with_volume?` (объём за период) | список событий + частота |
| `list_properties` | `event?` (свойства конкретного события или общие user-атрибуты), `with_sample_values?` | свойства, типы, примеры значений, кардинальность |
| `describe_schema` | — | таблицы, логические поля, поддерживаемые операторы и measure-типы |

> Рекомендация: системный промпт обязывает AI вызвать `list_events`/
> `list_properties` перед первым аналитическим запросом по новой теме.

---

### 4.2 `metrics_timeseries` — тренды/метрики во времени

**Класс задач:** «как менялось во времени» — DAU/WAU/MAU, число событий,
ARPDAU, средний score, конверсия и т.п.

**Параметры:**
```jsonc
{
  "measures": [ Measure ],          // одна или несколько метрик
  "event_selector": EventSelector,  // по какому событию (для count/sum)
  "time_range": TimeRange,
  "granularity": Granularity,
  "breakdown": Breakdown,           // опц. разбивка серий
  "cohort": CohortRef,              // опц. ограничение популяцией
  "filters": FilterGroup,           // опц. доп. условия
  "dry_run": false
}
```
**Выход:** строки `(date, [breakdown...], measure_values)`.

**Эскиз SQL:**
```sql
SELECT date_trunc('day', e.event_timestamp) AS d,
       u.country,
       count(DISTINCT e.user_id) AS dau
FROM events e
JOIN users u USING (user_id)
WHERE e.event_timestamp BETWEEN :from AND :to
  AND e.event_name = 'session_start'
GROUP BY 1, 2 ORDER BY 1;
```

---

### 4.3 `segmentation` — разрез метрики по сегментам (без оси времени)

**Класс задач:** «сколько / какой средний X по странам / платформам / уровням /
кампаниям» — топ-N, доли, сравнение сегментов.

**Параметры:** `measures`, `event_selector`, `breakdown` (обязателен),
`time_range`, `filters`, `cohort`, `order_by?`, `limit?`.

**Выход:** таблица `(segment..., measures...)`, отсортированная.

```sql
SELECT u.media_source, count(DISTINCT e.user_id) AS payers,
       sum((e.event_properties->>'revenue')::numeric) AS revenue
FROM events e JOIN users u USING (user_id)
WHERE e.event_name = 'purchase' AND e.event_timestamp BETWEEN :from AND :to
GROUP BY 1 ORDER BY revenue DESC LIMIT 20;
```

---

### 4.4 `funnel_analysis` — воронки

**Класс задач:** конверсия по последовательности шагов, где отваливаются.
Покрывает туториал, путь до первой покупки, прохождение набора уровней.

**Параметры:**
```jsonc
{
  "steps": [ EventSelector, EventSelector, ... ],  // 2+ шага по порядку
  "order": "ordered" | "any_order",
  "conversion_window": "24h" | "7d" | null,        // макс. время на весь путь
  "step_window": "1h",                              // опц. окно между шагами
  "time_range": TimeRange,                          // когда стартовала воронка
  "breakdown": Breakdown,                           // конверсия по сегментам
  "cohort": CohortRef,
  "count_mode": "unique_users",
  "include_step_timing": true                       // среднее время между шагами
}
```
**Выход:** на каждый шаг — `users`, `conversion_from_prev`, `conversion_from_start`,
`avg_time_to_step`; опционально с разбивкой.

**Реализация:** оконные функции / последовательный self-join с проверкой
`ts_step_{i+1} > ts_step_i` и попадания в окно. Поддержать `breakdown` (например,
сравнить воронку первой покупки по `media_source`).

---

### 4.5 `retention_analysis` — удержание

**Класс задач:** возвращаются ли игроки. Все основные модели retention.

**Параметры:**
```jsonc
{
  "cohort_event": EventSelector,    // событие «входа» в когорту (install/first_seen/level_start)
  "return_event": EventSelector,    // что считаем «возвратом» (любая активность по умолчанию)
  "retention_type": "n_day"         // вернулся ровно на день N
                  | "unbounded"     // вернулся на день N или позже
                  | "rolling"       // активен в окне
                  | "bracket",      // диапазоны (D1, D3-7, D8-14...)
  "periods": [0,1,3,7,14,30],       // какие лаги считать
  "granularity": "day" | "week" | "month",
  "time_range": TimeRange,          // окно набора когорт
  "breakdown": Breakdown,           // retention по сегментам/каналам
  "cohort": CohortRef
}
```
**Выход:** матрица retention `(cohort_period, period_offset → % вернувшихся)`
плюс размеры когорт. Это покрывает D1/D7/D30 и стандартную retention-heatmap.

```sql
WITH first AS (
  SELECT user_id, min(event_timestamp)::date AS cohort_day
  FROM events WHERE event_name='session_start' GROUP BY 1)
SELECT f.cohort_day,
       date_diff('day', f.cohort_day, e.event_timestamp::date) AS day_n,
       count(DISTINCT e.user_id) AS retained
FROM first f JOIN events e USING (user_id)
GROUP BY 1,2;
```

---

### 4.6 `cohort_retention_grid` — когортная сетка (acquisition-cohorts)

**Класс задач:** классическая когортная таблица «по дате установки × возраст»
с метрикой не только retention, но и ARPU/выручки/конверсии нарастающим итогом.

**Параметры:** `cohort_by` (`install_date`/первое событие), `cohort_granularity`
(`day|week|month`), `metric` (`retention | cumulative_revenue | arpu | conversion`),
`periods`, `breakdown` (например по `media_source`), `time_range`.

**Выход:** треугольная/прямоугольная матрица когорта×возраст. Это объединяет
retention и LTV-кривые в одном представлении.

---

### 4.7 `cohort_define` — конструктор поведенческих когорт (переиспользуемый)

**Класс задач:** определить группу пользователей по поведению/атрибутам и
**сохранить как ссылку** (`CohortRef.ref`), чтобы подставлять в любой другой тул.
Это ключ к «как вели себя пользователи, у которых было то или иное событие».

**Параметры:**
```jsonc
{
  "user_filter": FilterGroup,           // UA-атрибуты (country, media_source...)
  "did_events": [ EventSelector ],      // совершили эти события
  "did_not_events": [ EventSelector ],  // и НЕ совершали эти
  "frequency": { "event": "...", "operator": "gte", "count": 3 },  // частотный критерий
  "within": TimeRange,
  "name": "paid_us_reached_lvl50",
  "materialize": "reference" | "user_list"   // вернуть handle или сам список user_id
}
```
**Выход:** `cohort_ref`, размер когорты, (опц.) список `user_id`.
**Паттерн использования:** `cohort_define` → `retention_analysis(cohort=ref)` или
`metrics_timeseries(cohort=ref)` — то есть «взять тех, у кого было событие X, и
посмотреть, как они себя ведут дальше».

---

### 4.8 `behavioral_segment` — «кто сделал X, потом Y» (сравнение групп)

**Класс задач:** разбить пользователей на did/didn't (или сравнить две когорты) и
сопоставить их по любой метрике. Быстрый ответ на «чем отличаются те, кто
совершил событие, от тех, кто нет».

**Параметры:** `group_a: CohortRef`, `group_b: CohortRef` (или
`split_by_event: EventSelector` → автоматически did/didn't), `compare_measures`
(retention, ARPU, sessions, avg level...), `time_range`.

**Выход:** сравнительная таблица метрик A vs B (+ дельта). Может опираться на
`cohort_define` и `metrics_timeseries` под капотом.

---

### 4.9 `path_analysis` — пути пользователей (Pathfinder)

**Класс задач:** какие события чаще всего идут **до/после** опорного, где
нелинейные ветвления и неожиданные дропы.

**Параметры:**
```jsonc
{
  "anchor_event": EventSelector,
  "direction": "after" | "before",
  "steps": 3,                       // глубина пути
  "max_paths": 20,                  // топ-N путей
  "within_session": true,           // ограничить сессией
  "time_range": TimeRange,
  "cohort": CohortRef,
  "exclude_events": ["heartbeat"]
}
```
**Выход:** дерево/список путей с долями переходов на каждом шаге.

---

### 4.10 `lifecycle_analysis` — жизненный цикл (new/active/resurrected/dormant/churned)

**Класс задач:** структура активной базы по состояниям и переходам между ними от
периода к периоду.

**Параметры:** `active_event` (что считаем активностью), `granularity`
(`day|week|month`), `dormant_after` (порог неактивности), `time_range`,
`breakdown`, `cohort`.

**Выход:** по каждому периоду — `new / current / resurrected / dormant / churned`
(+ их пересечения), пригодно для stacked-area графика роста базы.

---

### 4.11 `stickiness_analysis` — липкость

**Класс задач:** DAU/MAU-ratio и «сколько дней из N пользователь активен» —
насколько привычка сформирована.

**Параметры:** `event_selector`, `window` (`week|month`), `metric`
(`dau_mau_ratio | days_active_distribution`), `time_range`, `breakdown`, `cohort`.

**Выход:** ratio во времени и/или распределение «активен X из N дней».

---

### 4.12 `distribution_analysis` — распределения / гистограммы / частоты

**Класс задач:** распределение значения свойства (score, moves, attempts,
revenue), частота события на пользователя, перцентили.

**Параметры:** `event_selector`, `field` (для числового свойства),
`mode` (`histogram | frequency_per_user | percentiles`), `buckets`/`bucket_size`,
`time_range`, `breakdown`, `cohort`.

**Выход:** бины и их наполнение или таблица перцентилей.

---

### 4.13 `user_timeline` / `user_profile` — отладка на уровне игрока

**Класс задач:** посмотреть полную хронологию событий конкретного игрока и его
атрибуты — для разбора кейсов и валидации гипотез.

**Параметры:** `user_id` (или маленький `CohortRef` с `limit`), `time_range`,
`event_filter`, `limit`.

**Выход:** атрибуты пользователя + упорядоченная лента событий со свойствами.

---

### 4.14 `progression_analysis` — прогрессия по уровням (игровая специфика)

**Класс задач:** для пазлов/word-игр — как игроки проходят уровни: где «стена
сложности», win-rate, среднее число попыток, отвал по уровням. По сути
специализированная воронка по `level`.

**Параметры:**
```jsonc
{
  "level_field": "event_properties.level",
  "start_event": "level_start",
  "win_event":  "level_complete",
  "fail_event": "level_fail",
  "level_range": { "from": 1, "to": 200 },
  "metrics": ["players_reached","win_rate","avg_attempts","avg_moves","churn_at_level"],
  "time_range": TimeRange,
  "breakdown": Breakdown,        // например по app_version (баланс уровней между версиями)
  "cohort": CohortRef
}
```
**Выход:** по каждому уровню — достигли / прошли / win-rate / попытки / отвал.
Идеально для поиска проблемных уровней и балансировки сложности.

---

### 4.15 `monetization_analysis` — монетизация (игровая специфика)

**Класс задач:** ARPU, ARPPU, ARPDAU, конверсия в платящих, доля платящих,
время до первой покупки, LTV-кривая, выручка по продуктам/каналам.

**Параметры:**
```jsonc
{
  "revenue_field": "event_properties.revenue",
  "purchase_event": "purchase",
  "metric": "arpdau|arppu|arpu|conversion_to_payer|payer_share|time_to_first_purchase|ltv_curve|revenue_by_product",
  "ltv_horizon": [1,7,30,90],     // для ltv_curve (по acquisition-когортам)
  "time_range": TimeRange,
  "granularity": Granularity,
  "breakdown": Breakdown,         // по media_source / country / platform
  "cohort": CohortRef
}
```
**Выход:** запрошенная метрика во времени / по сегментам / как кривая по когортам.

---

### 4.16 Исполнение: `preview_sql` и `run_query`

Не отдельный класс анализа, а режимы любого тула:
- `dry_run: true` → вернуть только `sql` + `assumptions` (ничего не выполнять).
- обычный вызов → выполнить и вернуть `rows` (с `row_limit`, по умолчанию,
  например, 10 000, и защитой по таймауту/сканируемому объёму).

Опциональный «escape hatch» `run_validated_sql` (выполнить ревью-нутый SQL) лучше
держать **выключенным** или строго read-only — он противоречит идее структурных
тулов, но иногда нужен для нестандартных задач.

---

## 5. Консистентность, валидация, безопасность

- **Единый конверт ответа** у всех тулов:
  ```jsonc
  {
    "sql": "…",
    "columns": [ {"name":"…","type":"…"} ],
    "rows": [ … ],
    "row_count": 123,
    "assumptions": ["return_event по умолчанию = любая активность", …],
    "warnings": ["breakdown по высокой кардинальности обрезан до 50"]
  }
  ```
- **Валидация на входе:** имена событий/свойств сверяются с метаданными; неизвестное
  имя → ошибка с подсказкой ближайших совпадений (а не «тихий» неверный SQL).
- **Только read-only**, параметризованные запросы, allowlist таблиц/колонок из
  конфига → нет инъекций.
- **Защита от «тяжёлых» запросов:** обязательный `time_range`, лимиты на
  кардинальность `breakdown`, дефолтные `row_limit` и таймаут.
- **Детерминизм:** одинаковые параметры → одинаковый SQL (удобно кэшировать и
  тестировать снапшотами).
- **Прозрачность допущений:** всё, что сервер «додумал» (дефолтный return-event,
  окно воронки, таймзона), попадает в `assumptions`.

---

## 6. Карта «класс задачи → тул»

| Вопрос бизнеса / аналитика | Тул(ы) |
|---|---|
| Сколько DAU/выручки и как меняется во времени | `metrics_timeseries` |
| Топ стран/каналов по выручке, разрез метрики | `segmentation` |
| Где отваливаются в туториале / пути до покупки | `funnel_analysis` |
| D1/D7/D30, retention-heatmap | `retention_analysis` |
| Когортная таблица install×возраст, LTV-кривые | `cohort_retention_grid`, `monetization_analysis` |
| Определить группу «совершившие событие X» | `cohort_define` |
| Как ведут себя те, у кого было событие X | `cohort_define` → любой тул с `cohort` |
| Чем отличаются сделавшие X от не сделавших | `behavioral_segment` |
| Что игроки делают до/после события | `path_analysis` |
| Структура базы: новые/вернувшиеся/уходящие | `lifecycle_analysis` |
| Насколько «липкий» продукт (DAU/MAU) | `stickiness_analysis` |
| Распределение score/attempts/частоты | `distribution_analysis` |
| Разбор конкретного игрока | `user_timeline` |
| Сложность/баланс уровней, где «стена» | `progression_analysis` |
| ARPU/ARPPU/конверсия/время до 1-й покупки | `monetization_analysis` |
| A/B результаты эксперимента | GrowthBook MCP (см. §7) |

---

## 7. Интеграция с уже подключёнными MCP (Cube, GrowthBook)

В окружении уже доступны два MCP-сервера — это влияет на границы ответственности:

- **Cube** (`cube_query_*`) — семантический слой. Если метрики/измерения уже
  определены в Cube, часть «базовой аналитики» (§4.2–4.3) можно делегировать ему,
  а наш сервер сосредоточить на поведенческих задачах, которые Cube не покрывает
  «из коробки» (воронки с окнами, retention-матрицы, path, поведенческие когорты,
  прогрессия). Возможен вариант: наши тулы генерируют **Cube-запрос**, а не сырой
  SQL — тогда метрики остаются консистентными с остальным BI.
- **GrowthBook** (`growthbook_*`) — эксперименты. Для A/B-задач отдельный тул не
  нужен: результаты берём из GrowthBook. Наша роль — отдавать `CohortRef`
  (поведенческие сегменты) и метрики, которыми можно обогащать анализ экспериментов.

> Рекомендация: на старте определить, что является **источником истины для
> метрик** (Cube vs наш SQL-генератор), чтобы цифры не расходились между
> инструментами.

---

## 8. Минимальный план внедрения (приоритеты)

1. **Фундамент:** конфиг схемы + общие типы (§3) + `describe_schema`/`list_events`/
   `list_properties` + единый конверт ответа и `dry_run`.
2. **Топ-5 по ценности:** `metrics_timeseries`, `segmentation`, `funnel_analysis`,
   `retention_analysis`, `cohort_define`.
3. **Поведение/когорты:** `behavioral_segment`, `cohort_retention_grid`,
   `lifecycle_analysis`, `stickiness_analysis`, `path_analysis`,
   `distribution_analysis`.
4. **Игровая специфика:** `progression_analysis`, `monetization_analysis`.
5. **Отладка/escape:** `user_timeline`, опционально `run_validated_sql` (read-only).

---

## Источники (research)

- [Amplitude — Product Analytics Guide](https://amplitude.com/explore/analytics/product-analytics-guide)
- [Amplitude — Funnel Analysis](https://amplitude.com/guides/funnel-analysis)
- [Amplitude — Cohort Retention Analysis](https://amplitude.com/explore/analytics/cohort-retention-analysis)
- [Amplitude — Pathfinder & Behavioral Cohorts](https://e-cens.com/blog/amplitude-101-advanced-analysis-with-pathfinder-cohorts/)
- [Amplitude — Stickiness interpretation](https://amplitude.com/docs/analytics/charts/stickiness/stickiness-interpret)
- [PostHog — Cohorts](https://posthog.com/docs/data/cohorts)
- [Adjust — Cohort KPIs: event conversion & funnels](https://www.adjust.com/blog/demystifying-cohorts-3-tracking-custom-user-journeys-with-event-kpis/)
- [GameAnalytics — 22 metrics all game developers should know](https://www.gameanalytics.com/blog/metrics-all-game-developers-should-know)
- [Game Growth Advisor — Mobile Game KPIs & Benchmarks 2026](https://gamegrowthadvisor.com/blog/2026-03-17-mobile-game-kpis-benchmarks-2026/)
- [TyrAds — Mobile Game KPIs](https://tyrads.com/mobile-game-kpis/)
- [dbt — Creating metrics (Semantic Layer / MetricFlow)](https://docs.getdbt.com/docs/build/metrics-overview)
- [dbt — Building semantic models](https://docs.getdbt.com/best-practices/how-we-build-our-metrics/semantic-layer-3-build-semantic-models)
