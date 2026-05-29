# Аналитический MCP-сервер для **ad-hoc** игровой event-аналитики

> Дизайн-документ: какие тулы нужны и какие в них параметры, чтобы AI вызывал
> **структурные инструменты** под **исследовательские (ad-hoc) задачи**, а не
> генерировал SQL «из головы».

## 0. Главный тезис: это НЕ ещё один семантический слой

В компании **уже есть** семантический слой (Metabase Semantic Layer на витринах
`bi_data_metrics`, плюс пирамида метрик, Atomic/Semi-Atomic, словарь метрик и
измерений). Он отлично решает **классические BI-задачи**: стандартные метрики на
заранее смоделированных витринах, дашборды, регулярная отчётность, готовые разрезы.

**Этот MCP-сервер решает другой класс задач — ad-hoc исследования**, которые
семантический слой структурно **не может** выразить, потому что они требуют:

- **вычислений на уровне игрока «на лету»** (агрегаты по событиям → пороги/квантили
  → сегмент), которых нет среди готовых дименьшенов;
- **условий на соседние события** в хронологии пользователя (event X, рядом с
  которым было event Y);
- **произвольных гипотез** «сделал X → как ведёт себя дальше», last-action,
  поиска зависимостей и корреляций;
- **доступа к сырым параметрам событий**, не вынесенным в витрину.

> Семантический слой = «известные вопросы, считаем быстро и одинаково».
> Этот сервер = «новые вопросы, которые задают раз и под конкретное исследование».

### 0.1 Единственный источник данных для SQL — две детальные таблицы

**Сервер генерирует SQL ровно по двум таблицам:**

1. **`events`** — детальные событийные данные (по одному ряду на событие игрока, с
   сырыми параметрами в `event_properties`);
2. **`users`** — атрибуты пользователя (UA / acquisition данные, по ряду на игрока).

Никакие витрины `bi_data_metrics`, готовые метрики семантического слоя, Cube или
другие агрегаты **не** являются источником запроса. Вся аналитика — от DAU до
last-action — собирается **из сырых событий и атрибутов** через `JOIN events × users`.
Семантический слой здесь — только **референс определений** (как считать метрику,
как её называют), чтобы наши числа совпадали с BI; но сам расчёт всегда выполняется
по `events` + `users`. Именно поэтому возможен весь ad-hoc класс задач: у нас есть
доступ к деталям, которых в витринах нет.

Дизайн заземлён на **реальные ad-hoc задачи компании** (openmygame / malpa games):
ТЗ BI-команды «GD Tasks» и реальные исследования по retention, экономике, балансу
уровней, post-hoc разбору A/B (Confluence: BI, Product Analytics, WO/Word Search
Sea, Sudoku, MW, WP и др.). См. §3 и §10.

---

## 1. Принципы дизайна

1. **Ad-hoc прежде всего.** Покрываем исследовательские задачи. Классические
   витринные вопросы отдаём семантическому слою; если такая метрика нужна внутри
   исследования — повторяем её **формулу в SQL по `events`+`users`** (§0.1), а не
   читаем витрину.
2. **Структурность вместо свободного SQL.** AI выбирает тул и заполняет
   типизированные параметры; SQL генерируется детерминированно внутри сервера
   (корректность, безопасность, воспроизводимость).
3. **Композиционность.** Маленький набор **переиспользуемых блоков** (фильтры,
   диапазон, разбивки, мера, per-user агрегаты, ссылка на когорту) одинаков во всех
   тулах. Сложные исследования = комбинация тулов.
4. **Вычисления на уровне игрока — первый класс.** Per-user агрегаты, квантильные
   сегменты, last-action, частоты, последовательности — встроенные примитивы, а не
   «хак».
5. **Grounding через метаданные.** Перед расчётом AI спрашивает у сервера события,
   свойства, именованные метрики и измерения (убирает угадывание имён).
6. **Dry-run по умолчанию.** Любой тул умеет вернуть SQL без выполнения
   (`dry_run: true`).
7. **Единый конверт ответа:** `sql`, `columns`, `rows`, `row_count`, `warnings`,
   `assumptions`, `metric_source`.

---

## 2. Граница: что делает семантический слой и чего он НЕ может

| Класс задачи | Семантический слой (Metabase/Cube) | Этот MCP (ad-hoc) |
|---|---|---|
| DAU/WAU/MAU, ARPU/ARPPU, ROAS, LTV, Retention Rate Day X по готовым дименьшенам | ✅ канон, быстро | реплицирует формулу в SQL по `events`+`users` (`named`-рецепт) |
| Стандартные дашборды и регулярная отчётность | ✅ | — |
| Разрез метрики по **сырым параметрам события**, которых нет в витрине | ⚠️/❌ | ✅ |
| Сегмент = **агрегат по игроку** (>X подсказок, <Y avg время уровня) | ❌ (нет такого дименьшена) | ✅ `behavioral_segment_metrics` |
| **Квантильная** сегментация на лету (5×20% по games_completed) | ❌ | ✅ `derived_segment` |
| Условие на **соседнее событие** (X, рядом с которым был Y) | ❌ | ✅ `adjacent_event_count` |
| **Last-action** перед оттоком, на гранулярности уровня | ❌ | ✅ `churn_last_action` |
| Воронки с окнами, path, произвольные последовательности | ⚠️ ограниченно | ✅ |
| Поведенческие когорты «сделал X → что дальше» | ❌ | ✅ `cohort_define` + любой тул |
| Поиск зависимостей/корреляций между параметрами уровня и исходом | ❌ | ✅ `correlation_explore` |
| Post-hoc разбор A/B по сегментам (глубже стат-движка) | ⚠️ | ✅ `post_hoc_segment_compare` |

> Эта таблица — карта «зачем мы вообще нужны». Если ответ полностью лежит в правой
> колонке семантического слоя — корректно отослать туда (или вызвать Cube), а не
> пересчитывать.

---

## 3. Таксономия ad-hoc исследовательских задач (что реально спрашивают)

Собрано из ТЗ BI-команды (Confluence **GD Tasks**, BI/4971790388) и реальных
исследований. Это «класс задач», под которые проектируется каталог тулов (§5).

### 3.1 Фильтрованный подсчёт по событию + связь с когортой (GD Tasks, Блок 1)
> *Посчитать число событий/уникальных пользователей по ивенту с условиями на его
> параметры, с разбивкой/фильтрацией по когортам (app/country/install_date/
> media_source), и со сплитом по комбинациям параметров события.*

Пример: по `ad_finished` где `ad_type='rewarded'` и `placement='RewardedGameScreen'`
посчитать пользователей и события, разделив на сегменты по
`(is_reward_received, is_user_returned)`. → §5.2 `event_count` (+ event-property
splits), §5.4 `conversion_rate`.

### 3.2 Условие на соседнее событие в хронологии (GD Tasks, Блок 2)
> *Посчитать событие X, до/после которого произошло событие Y с заданными
> параметрами. Условие — не на само событие, а на соседнее во времени у игрока.*

Пример: число `coins_outcome`, **после** которого было `ad_finished` с
`placement='RewardedGameScreen'`. → §5.5 `adjacent_event_count`.

### 3.3 Метрики по поведенческим сегментам (GD Tasks, Блок 3)
> *Смотреть метрики только по пользователям, удовлетворяющим условию на его
> поведение, где сегмент формируется из агрегатов самого игрока (сумма/среднее/кол-во).*

Пример: ключевые метрики только по тем, у кого `hints_used > x` ИЛИ
`avg_level_time < y`. → §5.6 `behavioral_segment_metrics` (+ `cohort_define` с
per-user порогами).

### 3.4 Динамическая (квантильная) сегментация и профили сегментов
> *Разбить игроков на N равных групп по per-user метрике и сравнить богатый профиль.*

Реальный кейс (Retention D1, WO): 5 сегментов по 20% от `games_completed` за
`d0_2` (low / middle_low / middle / middle_high / high); по каждому — avg/median
completed levels, p25/p75, max_level, started_levels, total_complete_time и т.д.
Также skill-сегменты (fast/middle/slow) и ad-watch tiers (low/mid/high/extreme).
→ §5.7 `derived_segment` + §5.13 `distribution_profile`.

### 3.5 Last-action перед оттоком
> *Найти последнее событие/уровень игрока, после которого N дней не было активности
> (отток), и распределить отток по последнему действию.*

Кейс (WO): `last_action` за `d0_d2` с колонками `segment, event, last_lvl, lvl,
level_id, ad_type, ad_place, med_coins, players, share_pct`. → §5.8
`churn_last_action`.

### 3.6 Прогрессия по сессиям и по уровням
> *Где осыпается аудитория по номеру сессии и по номеру/ID уровня.*

Кейс (WO): по `session_number` — `players, share_from_start_pct,
avg/median_session_duration, completed_levels`; по уровням — Started/Win rate,
attempts, churn_at_level, «стена сложности». → §5.9 `session_progression`,
§5.14 `progression_analysis`.

### 3.7 Root-cause просадки метрики
> *Почему упал Retention/ARPU: разложить на состав трафика (media_source, organic),
> прокси-метрики (avg_playtime_d3), привести к baseline, сопоставить динамику.*

Кейс (WO, «падение Retention RU Android»): доли media_source vs installs vs
avg_playtime_d3, нормировка к baseline. → §5.2 `event_count`/`metrics_timeseries`
+ §5.10 `behavioral_segment` сравнение + §5.15 `correlation_explore`.

### 3.8 Поиск зависимостей / корреляций
> *Связан ли параметр уровня/поведения с исходом: ad usage vs completion rate,
> число ходов/техник vs прохождение, трата монет vs досмотр RV.*

Кейсы (Sudoku «поиск зависимостей», RewardedGameScreen). → §5.15
`correlation_explore` + §5.5 `adjacent_event_count`.

### 3.9 Экономика: структура источников и баланс
> *Откуда игроки берут и куда тратят валюту, по сегментам, на поздних уровнях;
> баланс ресурса на конец дня/уровня/сессии.*

Кейс (WO, free/reward `currency_income` по ad-watch сегментам). → §5.16
`economy_analysis`.

### 3.10 Post-hoc разбор A/B (глубже стат-движка)
> *Почему вариант выиграл/проиграл: разрез по сегментам новизны (новички/1-99/100+),
> last-action в base vs test, поведенческие различия.*

Кейсы (New Balance V1 post-hoc, A/A-тест с CUPED). GrowthBook даёт значимость —
мы даём **поведенческое «почему»**. → §5.17 `post_hoc_segment_compare`.

### 3.11 Внешний референс полноты: маппинг на чарты Amplitude
Amplitude — эталон гибкой event-аналитики. Его сила не в количестве чартов, а в
**малом наборе переиспользуемых блоков**, из которых собирается любой анализ. Мы
повторяем именно эту идею (§4), а список их чартов используем как чек-лист, что
ничего из класса задач не упущено.

**Гибкие блоки Amplitude → наши блоки:**
| Amplitude | У нас |
|---|---|
| Любое событие + property-фильтры | `EventSelector` + `FilterGroup` (§4.4–4.5) |
| **«Measured as»** (uniques / totals / sum / avg / % active / formula) | `Measure` (§4.6), вкл. `rate` и `named` |
| **Group by** любым свойством события/пользователя | `Breakdown` (§4.8) |
| **Behavioral Cohort** (did/didn't, частота, окно, последовательность) — переиспользуется в любом чарте | `cohort_define` → `CohortRef` (§4.9), питает любой тул |
| **Formulas** (арифметика над метриками) | формульная мера / `compose_pipeline` (§5.21) |
| **Microscope** (drill-down до пользователей и их стримов) | `user_timeline` (§5.20) |
| Order of operations (per-user счёт → пороги → группировка) | **multi-stage пайплайн** E→U→S→A (§4.12) |

**Чарты Amplitude → наши тулы (чек-лист покрытия):**
| Amplitude chart | Вопрос | Наш тул |
|---|---|---|
| Event Segmentation | сколько/кто делает событие, тренд и разрез | `event_count`, `metrics_timeseries`, `segmentation` |
| Funnel Analysis | где отваливаются в последовательности | `funnel_analysis` |
| Retention Analysis | возвращаются ли | `retention_analysis`, `cohort_retention_grid` |
| Stickiness | DAU/MAU, дни активности | `stickiness_analysis` |
| Lifecycle | new/active/resurrected/dormant | `lifecycle_analysis` |
| Pathfinder / Journeys | реальные пути до/после события | `path_analysis`, `adjacent_event_count` |
| Behavioral Cohorts | группа по поведению, переиспользуемая | `cohort_define`, `derived_segment` |
| Compass / корреляции с retention | какое действие коррелирует с удержанием | `correlation_explore` |
| User Sessions | поведение по сессиям | `session_progression` |
| Microscope | разбор конкретных пользователей | `user_timeline` |

> Вывод из Amplitude: **не плодить чарты, а дать мало гибких блоков + один
> композиционный механизм** (у них — формулы и behavioral cohorts поверх единого
> движка; у нас — `compose_pipeline` поверх multi-stage скелета). Специализированные
> тулы — это удобные пресеты, а не отдельные «движки».

---

## 4. Доменная модель и переиспользуемые блоки

Сервер опирается на конфигурируемую **semantic schema** — маппинг логических полей
на физические колонки **двух таблиц: `events` и `users`** (см. §0.1). Это
единственные источники для SQL; тулы оперируют только логическими именами поверх них.

### 4.1 Таблица событий (`events`)
`user_id`, `app_name`, `platform`, `event_name`, `event_timestamp`, `session_id`,
`session_number`, `event_properties` (JSON/MAP: `level`, `level_id`, `score`,
`attempt`, `moves`, `revenue`, `ad_type` (banner/interstitial/rewarded),
`placement`, `is_reward_received`, `is_user_returned`, `hints_used`, `currency`,
`resource_type`, `amount`, `result`, `funnel_stage`, …).

### 4.2 Таблица атрибутов пользователей (`users` / UA)
`user_id`, `install_date`/`first_seen` (Cohort Date), `platform`, `os_version`,
`device_model`, `country`/`country_group`, `language`, `media_source`, `campaign`,
`ad_group`, `creative`, `acquisition_type` (organic/paid, incent/non-incent),
`app_version`, `att_status`, `gdpr_consent`, произвольные `user_properties`.

### 4.3 `TimeRange` / `Granularity`
```jsonc
{ "type":"relative|absolute", "last":"30d", "from":"2026-01-01", "to":"2026-03-31", "timezone":"UTC" }
```
`Granularity`: `hour|day|week|month|quarter`.

### 4.4 `FilterGroup` — рекурсивные И/ИЛИ, единый язык для свойств событий и атрибутов
```jsonc
{
  "op": "and|or",
  "conditions": [
    { "field":"event_properties.placement", "operator":"eq", "value":"RewardedGameScreen" },
    { "field":"user.media_source", "operator":"in", "value":["unityads","applovin_int"] },
    { "op":"or", "conditions":[ ... ] }
  ]
}
```
Операторы: `eq|neq|gt|gte|lt|lte|in|not_in|between|contains|is_null|is_not_null`.
Префиксы: `event_properties.*` (свойство события), `user.*` (атрибут игрока).

### 4.5 `EventSelector`
```jsonc
{ "event":"ad_finished", "filters": FilterGroup, "alias":"rv" }
```

### 4.6 `Measure` — что считаем
```jsonc
{
  "type": "count_events | count_unique_users | count_sessions
         | sum | avg | min | max | median | p25 | p75 | p90 | p95
         | rate | named",
  "field": "event_properties.revenue",
  "name": "ARPDAU",                     // type=named: метрика семантического слоя
  "numerator": EventSelector,           // type=rate
  "denominator": "cohort" | EventSelector,
  "alias": "revenue"
}
```
- `named` → **встроенный SQL-рецепт**, повторяющий определение метрики из
  семантического слоя (ARPDAU, LTV, Retention Rate Day X…), но считаемый **по
  `events`+`users`**, а не читаемый из витрины. Цель — совпадение чисел с BI.
- `rate` → конверсия по принципу Atomic/Semi-Atomic (`num/denom×100`), тоже из сырых.

### 4.7 `PerUserAggregate` — вычисление на уровне игрока (ядро ad-hoc)
Базовый примитив для GD Tasks Блок 3 и квантильных сегментов.
```jsonc
{
  "name": "games_completed_d0_2",
  "source_event": EventSelector,          // напр. level_complete
  "agg": "count | count_distinct | sum | avg | min | max | first | last",
  "field": "event_properties.level",      // для sum/avg/min/max
  "window": {
    "relative_to": "install | activation | first_event | test_start",  // точка отсчёта окна
    "from_day": 0, "to_day": 2,           // окно жизни игрока в днях
    "methodology": "calendar | 24h"       // календарные сутки vs 24-часовые от точки отсчёта
  }
}
```
Используется для: порогов (`> x`), квантильных сегментов (ntile), осей профиля.

> **Точка отсчёта и методология (из практики BI).** `relative_to:"activation"` /
> `"test_start"` нужны для анализа экспериментов: GrowthBook считает метрики от
> **момента активации** игрока, а не от установки. `methodology:"24h"` повторяет
> 24-часовую (Appsflyer) методологию когортных метрик Metabase; `"calendar"` —
> календарные сутки. Дефолт берётся из конфига и попадает в `assumptions`.

### 4.8 `Breakdown` и когортные vs активностные измерения
Список измерений для разреза: `["app_name","user.country","user.media_source",
"event_properties.level","session_number"]`. Сервер знает (из конфига), какие
измерения **когортные** (App Name, Country, Media Source, Campaign…). Для
`rate`/semi-atomic мер разбивка только по когортным → иначе понятный `warning`.

### 4.9 `CohortRef` — популяция игроков
```jsonc
{
  "ref": "cohort_abc123",                 // сохранённая когорта (§5.6)
  "segment_api_id": "high_ad_watchers",   // сегмент Player Segmentation API
  "inline": {
    "user_filter": FilterGroup,
    "did_events": [ EventSelector ],
    "did_not_events": [ EventSelector ],
    "having": [ { "aggregate": PerUserAggregate, "operator":"gte", "value":3 } ],
    "within": TimeRange
  }
}
```

### 4.10 `AppScope`
Общий фильтр области: `app_name?`, `platform?`. Без него — требование явного выбора
или `warning` (портфель мультипроектный — легко получить «среднюю по больнице»).

> **Принцип консистентности:** `TimeRange`, `FilterGroup`, `Measure`,
> `PerUserAggregate`, `Breakdown`, `CohortRef`, `AppScope` одинаковы во всех тулах.

### 4.11 Грануляция (entity grain)
Любая ad-hoc задача считается на какой-то «единице». Сервер поддерживает несколько
грануляций промежуточного агрегата, и это явный параметр там, где он важен:
`event` (ряд = событие), `user` (ряд = игрок), `user_day`, `user_session`,
`user_level`, `level`, `cohort_day`. Грань определяет, на каком уровне выполняется
per-user/per-entity свёртка перед финальной агрегацией (см. §4.12).

### 4.12 Multi-stage пайплайн — ядро движка вычислений
Это центральная концепция. **Любой тул внутри компилируется в конвейер (DAG)
типизированных стадий**, где каждая стадия — это CTE, считающая «что-то своё» и
агрегирующая до нужной грани, а следующие стадии **соединяют** результаты. Так
устроены и Amplitude (его «order of operations»: сначала per-user счёт, потом
пороги/группировки), и классический SQL-паттерн «aggregate-then-join».

Канонические стадии:

| Стадия | Что делает | Грань на выходе |
|---|---|---|
| **E — Event scan** | фильтр сырых `events` (event_name, property-фильтры, time, app), выбор нужных полей | event |
| **U — Per-entity aggregate** | свёртка событий в один ряд на сущность: `count/sum/avg/first/last/min_ts/max_ts`, формирование per-user метрик (`PerUserAggregate`) | user / user_day / user_level / user_session |
| **S — Segment/bucket** | присвоение сегмента: пороги или `ntile`-квантили над U; присоединение атрибутов из `users` (когортные измерения) | user (+ segment, cohort dims) |
| **J — Join/combine** | соединение нескольких U/S-веток между собой (напр. «ветка did X» ⋈ «ветка revenue» ⋈ «ветка retention») и/или с `users` | user (обогащённый) |
| **A — Final aggregate** | агрегация по `breakdown`-измерениям → итоговая таблица | breakdown grain |

**Зачем это в дизайне:**

1. **Единая модель.** Все ad-hoc-тулы (§5) — это **пресеты** одного и того же
   скелета E→U→S→J→A. `event_count` = E→A; `behavioral_segment_metrics` = E→U→S(having)→A;
   `derived_segment` = E→U→S(ntile); `churn_last_action` = E→U(last per user)→A;
   `adjacent_event_count` = E→U(LAG/LEAD)→A. Это и делает набор «консистентным».
2. **Корректность.** Per-user свёртка (U) выполняется **до** межпользовательской
   агрегации (A) и до join'ов — это устраняет fan-out и двойной счёт при соединении
   событийных таблиц (главная причина неверных чисел в «ручном» SQL).
3. **Композиция = переиспользование.** Выход стадии S (сегмент/когорта) — это
   `CohortRef`/`segment_ref`, который **подставляется на вход другому тулу**. Именно
   так поведенческая когорта из одного исследования питает retention/монетизацию в
   следующем (как behavioral cohorts в Amplitude).
4. **Производительность/стоимость.** Скелет позволяет автоматически: агрегировать
   до join (aggregate-then-join), пушить фильтры в стадию E, использовать
   партиционирование BigQuery по дате (pruning) и оценивать сканируемый объём.

**`compose_pipeline` — композиционный тул (§5.21)** даёт прямой доступ к этому
скелету, когда ни один специализированный тул не подходит: AI описывает стадии
структурно (а не пишет SQL), переиспользуя те же блоки (`EventSelector`,
`PerUserAggregate`, `FilterGroup`, `Breakdown`). Это «escape hatch», который
**остаётся структурным**.

```jsonc
// Пример: «среди тех, кто за d0_2 прошёл >20 уровней (квантиль high),
//          какой D7 retention в разрезе media_source»
{
  "stages": [
    { "id":"lvl", "type":"per_user_aggregate",
      "source": { "event":"level_complete" },
      "agg":"count", "as":"games_completed",
      "window": { "relative_to":"install", "from_day":0, "to_day":2 } },
    { "id":"seg", "type":"segment", "from":"lvl",
      "method":"ntile", "by":"games_completed", "buckets":5,
      "keep":["high"] },
    { "id":"ret", "type":"retention", "cohort":"seg",
      "return_event": { "event":"session_start" }, "period":7 },
    { "id":"out", "type":"aggregate", "from":"ret",
      "breakdown":["user.media_source"], "measure":"rate" }
  ]
}
```


---

## 5. Каталог тулов

Помечены: класс задачи из §3 и блок пирамиды метрик (Onboarding/Engagement/
Progression/Retention/IAP/Ad/Economy/Cross-block).

### 5.0 Категории
| Категория | Тулы |
|---|---|
| Метаданные / grounding | `list_events`, `list_properties`, `list_metrics`, `describe_schema` |
| Подсчёты и доли | `event_count`, `metrics_timeseries`, `segmentation`, `conversion_rate` |
| Последовательности | `adjacent_event_count`, `funnel_analysis`, `path_analysis`, `session_progression` |
| Поведенческие сегменты | `cohort_define`, `behavioral_segment_metrics`, `derived_segment`, `behavioral_segment` |
| Отток и профили | `churn_last_action`, `retention_analysis`, `lifecycle_analysis`, `stickiness_analysis`, `distribution_profile` |
| Зависимости | `correlation_explore` |
| Игровая специфика | `progression_analysis`, `economy_analysis`, `monetization_analysis` |
| Эксперименты | `post_hoc_segment_compare`, `experiment_lookup` |
| Композиция (ядро) | `compose_pipeline` (multi-stage скелет, §4.12) |
| Отладка / исполнение | `user_timeline`, `preview_sql`/`run_query` |

---

### 5.1 Метаданные — `list_events`, `list_properties`, `list_metrics`, `describe_schema`
**Зачем:** карта территории, чтобы AI не угадывал имена и совпадал с BI.

| Тул | Параметры | Выход |
|---|---|---|
| `list_events` | `app_name?`, `search?`, `with_volume?` | события + частота |
| `list_properties` | `event?`, `with_sample_values?` | свойства, типы, примеры, кардинальность |
| `list_metrics` | `block?`, `search?` | именованные метрики семантического слоя (имя, Atomic/Semi-Atomic, допустимые измерения) |
| `describe_schema` | — | таблицы/слои, поля, операторы, measure-типы, когортные vs активностные измерения |

---

### 5.2 `event_count` — фильтрованный подсчёт по событию (GD Tasks Блок 1)
**Класс §3.1. Блок:** любой.
**Что:** число событий и/или уникальных пользователей по `EventSelector` с
условиями на параметры события, разбивкой по когортам и **сплитом по комбинациям
значений параметров события**.
```jsonc
{
  "event_selector": EventSelector,          // ad_finished, ad_type=rewarded, placement=...
  "measures": ["count_events","count_unique_users"],
  "property_splits": ["event_properties.is_reward_received","event_properties.is_user_returned"],
  "breakdown": Breakdown,                    // app/country/install_date/media_source
  "link_to_install": true,                   // join к users для когортных разрезов
  "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
**Выход:** `(breakdown..., property_splits..., events, users)`.

### 5.3 `metrics_timeseries` — тренды во времени
**Класс §3.7. Блок:** любой. Метрики (вкл. `named`: ARPDAU, Ad Impr per DAU,
avg_playtime_d3) во времени, с `breakdown`, опц. **нормировкой к baseline-дате**
(`rebase_to: "2025-12-01"`) для сопоставления динамик при root-cause.

### 5.4 `segmentation` / `conversion_rate`
`segmentation` — разрез меры по сегментам без оси времени (топ-N, доли).
`conversion_rate` — универсальный X Rate (`numerator/denominator×100`): FTD
Conversion, Payer Share, Level X Started Rate, доля дошедших до события.

### 5.5 `adjacent_event_count` — условие на соседнее событие (GD Tasks Блок 2)
**Класс §3.2, §3.8. Блок:** Engagement/Monetization.
**Что:** считать событие X, у которого **соседнее** (предыдущее/следующее) событие
в хронологии игрока = Y с заданными параметрами.
```jsonc
{
  "anchor_event": EventSelector,            // X: coins_outcome
  "neighbor_event": EventSelector,          // Y: ad_finished placement=RewardedGameScreen
  "relation": "next" | "prev" | "next_within" | "prev_within",
  "within": "10m" | "1 event" | "same_session",   // окно/дистанция «соседства»
  "measures": ["count_events","count_unique_users"],
  "breakdown": Breakdown, "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
**Реализация:** оконные `LAG/LEAD` по `(user_id ORDER BY event_timestamp)` +
условие на соседа. **Выход:** число X с совпавшим соседом (+ доля от всех X).

### 5.6 `behavioral_segment_metrics` — метрики по поведенческому сегменту (GD Tasks Блок 3)
**Класс §3.3. Блок:** Cross-block.
**Что:** посчитать метрики **только по игрокам**, чьи per-user агрегаты проходят
условие. Объединяет `cohort_define(having)` и расчёт метрик в одном вызове.
```jsonc
{
  "having": [
    { "aggregate": PerUserAggregate, "operator":"gt", "value": 10 },   // hints_used > 10
    { "aggregate": PerUserAggregate, "operator":"lt", "value": 30 }    // avg_level_time < 30
  ],
  "having_op": "and" | "or",
  "measures": [ Measure ],
  "breakdown": Breakdown, "time_range": TimeRange, "app_scope": AppScope
}
```

### 5.7 `derived_segment` — динамическая (квантильная/пороговая) сегментация
**Класс §3.4. Блок:** Cross-block.
**Что:** разбить игроков на группы по per-user метрике — равными квантилями
(ntile) или по заданным порогам — и **сохранить как `CohortRef`** или сразу отдать
сегмент как измерение для других тулов.
```jsonc
{
  "metric": PerUserAggregate,               // games_completed за d0_2
  "method": "ntile" | "thresholds",
  "buckets": 5,                             // ntile → low..high (5×20%)
  "labels": ["low","middle_low","middle","middle_high","high"],
  "thresholds": [1,5,20,50],               // для method=thresholds (ad-watch tiers)
  "time_range": TimeRange, "app_scope": AppScope,
  "materialize": "reference" | "dimension"
}
```
**Выход:** определение сегмента + размеры групп; `segment_ref` для подстановки в
`breakdown`/`cohort` любого тула. Покрывает skill (fast/slow) и ad-watch tiers.

### 5.8 `churn_last_action` — последнее действие перед оттоком
**Класс §3.5. Блок:** Retention/Progression.
**Что:** для игроков, ушедших в отток (нет активности `inactivity_days` подряд) в
окне, найти **последнее событие** и распределить отток по нему.
```jsonc
{
  "inactivity_days": 5,
  "window": { "relative_to":"install", "from_day":0, "to_day":2 },
  "last_action_fields": ["event_name","event_properties.level","event_properties.level_id","event_properties.ad_type","event_properties.placement"],
  "segment_by": "derived_segment_ref | Breakdown",
  "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
**Выход:** `(segment, last_event, last_lvl, level_id, ad_type, ad_place, players,
share_pct)` — где именно «отваливаются».

### 5.9 `session_progression` — осыпание по номеру сессии
**Класс §3.6. Блок:** Engagement/Onboarding.
**Что:** по `session_number` — `players`, `share_from_start_pct`,
`avg/median_session_duration`, `avg/median_completed_levels`.
**Параметры:** `max_session`, `min_share_pct` (отсечь хвост), `breakdown`
(сегменты), `window`, `time_range`, `app_scope`, `cohort`.

### 5.10–5.12 Поведение во времени
- `retention_analysis` — D1/D7/D30, n_day/unbounded/rolling/bracket, retention-heatmap,
  `breakdown` по каналам/гео/версии, `cohort`.
- `lifecycle_analysis` — new/active/resurrected/dormant/churned (порог = Game Churn).
- `stickiness_analysis` — DAU/MAU-ratio, «активен X из N дней».
- `cohort_retention_grid` — Cohort Date × Retention X Day с метрикой retention /
  cumulative_revenue / ARPU / ROAS / LTV.
- `behavioral_segment` — сравнить две группы (did/didn't или два `CohortRef`) по
  набору метрик (retention, ARPU, sessions, playtime, avg level) + дельта.

### 5.13 `distribution_profile` — распределения и профиль сегмента
**Класс §3.4. Блок:** Progression/Engagement.
**Что:** распределение/перцентили per-user или per-event величины; **богатый
профиль по сегментам** (как таблицы avg/median/p25/p75/max в исследованиях).
**Параметры:** `metric` (PerUserAggregate | event field), `mode`
(`histogram | percentiles | per_segment_profile`), `stats`
(`["avg","median","p25","p75","max"]`), `segment_by`, `buckets`, `time_range`,
`app_scope`, `cohort`.

### 5.14 `progression_analysis` — прогрессия по уровням (игровая специфика)
**Класс §3.6, §3.8. Блок:** Progression.
```jsonc
{
  "level_dimension": "by_order" | "by_id",      // Level X по порядку ИЛИ по ID
  "start_event":"level_start","win_event":"level_complete","fail_event":"level_fail",
  "level_range": { "from":1, "to":200 },
  "metrics": ["players_reached","started_rate","win_rate","avg_attempts","avg_moves","churn_at_level","coins_spent_at_level"],
  "breakdown": Breakdown,                         // напр. app_version (баланс между версиями)
  "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
**Выход:** по уровню — достигли/начали/прошли/попытки/отвал/трата валюты. Прямо
поддерживает A/B по балансу уровней и поиск «стены сложности».

### 5.15 `correlation_explore` — поиск зависимостей
**Класс §3.8. Блок:** Cross-block.
**Что:** связь между параметром (уровня/сегмента/поведения) и исходом — таблица
сопоставления и коэффициент связи.
```jsonc
{
  "unit": "level" | "user" | "segment",
  "x": { "metric": PerUserAggregate | "event_properties.moves" },
  "y": { "metric": "completion_rate" | "churn" | PerUserAggregate },
  "method": "scatter_table | correlation | grouped_compare",
  "breakdown": Breakdown, "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
**Выход:** пары (x,y) с метрикой связи (напр. Pearson/Spearman) и оговорками
(`assumptions`: корреляция ≠ причинность). Пример: ad usage vs completion rate.

### 5.16 `economy_analysis` — экономика (игровая специфика)
**Класс §3.9. Блок:** Economy. На базе `currency_income`/`currency_outcome`.
```jsonc
{
  "income_event":"currency_income","outcome_event":"currency_outcome",
  "resource_field":"event_properties.resource_type","amount_field":"event_properties.amount",
  "source_field":"event_properties.source",          // free / rewarded / purchase / ...
  "convert_to_coins": true,
  "metric":"income|outcome|net|cumulative_income|cumulative_outcome|balance|source_structure",
  "axis":"by_day|by_session|by_level",
  "axis_range": { "from":0, "to":200 },
  "breakdown": Breakdown,                              // resource_type / source / сегмент
  "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
**Выход:** факт/кумулятив/баланс/структура источников ресурса по оси и сегментам —
для поиска инфляции/дефицита и анализа free vs rewarded зависимости.

### 5.17 `monetization_analysis` — монетизация (IAP + реклама)
**Класс §3.7. Блок:** IAP/Ad Monetization.
```jsonc
{
  "revenue_kind":"iap|ad|total",
  "purchase_event":"purchase","ad_event":"ad_impression",
  "ad_type":"banner|interstitial|rewarded|all",
  "metric":"arpdau|arppu|arpu|conversion_to_payer|payer_share|time_to_first_purchase|ltv_curve|revenue_by_product|ad_impressions_per_dau|ad_arpu",
  "net_of_refunds": true,                  // вычитать Refunds/Cancelled
  "ltv_horizon":[1,7,30,90,180],
  "breakdown": Breakdown, "granularity": Granularity,
  "time_range": TimeRange, "app_scope": AppScope, "cohort": CohortRef
}
```
Где метрика есть в семантическом слое — использовать её определение (`named`).

### 5.18 `post_hoc_segment_compare` — post-hoc разбор A/B
**Класс §3.10. Блок:** Cross-block.
**Что:** взять варианты эксперимента (`base`/`test`, по ключу из GrowthBook),
сравнить по сегментам **новизны** (новички/1-99/100+) и поведению (last-action,
профили), чтобы объяснить «почему» победил/проиграл. Статзначимость — из
GrowthBook (`experiment_lookup`), а здесь — поведенческое объяснение.
```jsonc
{
  "experiment_key":"ab_seg_wss_2026_04_09_android_ru_levels_v3",
  "variants": ["base","test"],
  "segment_by": ["newbie_segment","derived_segment_ref"],
  "compare": ["retention","churn_last_action","avg_levels","ad_impressions","coins_spent"],
  "time_range": TimeRange, "app_scope": AppScope
}
```

### 5.19 `experiment_lookup` — мост к GrowthBook
Достаёт результат эксперимента (variation, uplift, **Chance to Win**, p-value) из
GrowthBook (`growthbook_*`). Сам A/B не считаем (см. §9). Имена экспериментов едины
между Jira/Confluence/Firebase/GrowthBook.

### 5.20 `user_timeline` / исполнение
- `user_timeline` — хронология событий игрока + атрибуты (валидация гипотез/QA).
- `dry_run:true` → только `sql`+`assumptions`. Обычный вызов → выполнить с
  `row_limit`, таймаутом и оценкой сканируемого объёма (BigQuery-биллинг).
- Опциональный `run_validated_sql` (read-only) — выключен по умолчанию.

### 5.21 `compose_pipeline` — структурный multi-stage конструктор (ядро)
**Класс:** любой нестандартный. **Блок:** Cross-block.
**Что:** прямой доступ к скелету E→U→S→J→A (§4.12). AI задаёт список **типизированных
стадий** (`event_scan`, `per_user_aggregate`, `segment`, `join`, `retention`,
`aggregate`), ссылаясь по `id`/`from`, и переиспользует те же блоки
(`EventSelector`, `PerUserAggregate`, `FilterGroup`, `Breakdown`, `Measure`). Сервер
валидирует граф (грани совместимы, нет fan-out), компилирует в один SQL с CTE,
делает `dry_run`/выполняет. Это «escape hatch», который **остаётся структурным** —
покрывает редкие комбинации, под которые нет специализированного тула, без падения в
свободный SQL. Любую промежуточную стадию-сегмент можно сохранить как `CohortRef`.
Пример графа — в §4.12.

---

## 6. Консистентность, валидация, безопасность

- **Единый конверт ответа:**
  ```jsonc
  {
    "sql":"…", "columns":[{"name":"…","type":"…"}], "rows":[…], "row_count":123,
    "metric_source":"generated",   // всегда из events+users; "named"-рецепт повторяет формулу BI
    "assumptions":["inactivity=5d","tz=UTC","корреляция ≠ причинность"],
    "warnings":["semi-atomic метрику нельзя резать по активностному измерению — разбивка проигнорирована"]
  }
  ```
- **Валидация имён** событий/свойств/метрик/измерений по метаданным; неизвестное →
  ошибка с подсказкой ближайших совпадений.
- **Правило Atomic/Semi-Atomic** и **когортные vs активностные** измерения — не
  даём «тихо неверных» чисел.
- **Мультипроектность:** без `AppScope` — предупреждение/требование.
- **Read-only**, параметризованные запросы, allowlist таблиц/колонок → нет инъекций.
- **Защита от тяжёлых запросов / стоимость BigQuery:** обязательный `time_range`,
  лимиты кардинальности `breakdown`, дефолтные `row_limit`/таймаут, **прунинг по
  партициям** (таблицы партиционированы по дате — фильтр по `event_timestamp`
  обязан попадать в партиции), оценка сканируемых байт (dry-run биллинга) до
  выполнения.
- **Aggregate-then-join (§4.12):** per-user свёртка до соединений — корректность
  (нет fan-out) и дешевле по сканированию.
- **Методология в `assumptions`:** применённые `relative_to`/`methodology`
  (install vs activation, 24h vs calendar) всегда отражаются в ответе, чтобы число
  можно было сверить с Metabase/GrowthBook.
- **Детерминизм:** одинаковые параметры → одинаковый SQL (кэш, снапшот-тесты).

---

## 7. Карта «класс задачи → тул»

| Вопрос исследователя | Тул(ы) | §3 |
|---|---|---|
| Считать событие с условиями на параметры + сплит + когорта | `event_count` | 3.1 |
| Событие X рядом с событием Y (досмотр RV после траты монет) | `adjacent_event_count` | 3.2 |
| Метрики только по «тем, у кого >x подсказок» | `behavioral_segment_metrics` | 3.3 |
| Разбить на 5 квантилей по активности и сравнить профили | `derived_segment` + `distribution_profile` | 3.4 |
| Где отваливаются: последнее действие перед оттоком | `churn_last_action` | 3.5 |
| Осыпание по сессиям / по уровням, «стена» | `session_progression`, `progression_analysis` | 3.6 |
| Почему упал Retention/ARPU (состав трафика, baseline) | `metrics_timeseries`(rebase), `behavioral_segment` | 3.7 |
| Связь ad usage и completion / ходов и прохождения | `correlation_explore` | 3.8 |
| Структура источников валюты, баланс, free vs rewarded | `economy_analysis` | 3.9 |
| Почему вариант A/B выиграл/проиграл (по сегментам) | `post_hoc_segment_compare` (+ `experiment_lookup`) | 3.10 |
| Как ведут себя «совершившие X» дальше | `cohort_define` → любой тул с `cohort` | — |
| Стандартная витринная метрика | → семантический слой / `named` | §2 |

---

## 8. Минимальный план внедрения (приоритеты)

1. **Фундамент:** конфиг схемы + общие блоки (§4, особенно `PerUserAggregate`) +
   **multi-stage движок E→U→S→J→A (§4.12)**, на котором собираются все тулы +
   `describe_schema`/`list_events`/`list_properties`/`list_metrics` + единый
   конверт, `dry_run`, `AppScope`, грануляция (§4.11). Сразу заложить движок как
   общий слой — иначе тулы разъедутся в несовместимый SQL.
2. **Ядро ad-hoc (по GD Tasks):** `event_count` (Блок 1), `adjacent_event_count`
   (Блок 2), `behavioral_segment_metrics` (Блок 3), `derived_segment`,
   `cohort_define`.
3. **Исследовательский топ:** `churn_last_action`, `session_progression`,
   `distribution_profile`, `progression_analysis`, `correlation_explore`,
   `metrics_timeseries`(rebase).
4. **Поведение/когорты/деньги:** `retention_analysis`, `behavioral_segment`,
   `cohort_retention_grid`, `lifecycle_analysis`, `economy_analysis`,
   `monetization_analysis`.
5. **A/B и отладка:** `post_hoc_segment_compare`, `experiment_lookup`,
   `user_timeline`, опц. `run_validated_sql`.
6. **Композиция:** `compose_pipeline` (§5.21) — как только движок §4.12 стабилен,
   открыть структурный escape hatch для нестандартных комбинаций.

---

## 9. Интеграция: разделение труда

> **Главное:** наш единственный источник данных для SQL — `events` + `users`
> (§0.1). Мы **не** запрашиваем витрины/Cube и не делегируем им расчёт; перечисленные
> системы — это либо референс определений, либо внешние результаты, либо адресат, куда
> уместно отослать классический витринный вопрос.

- **Семантический слой (Metabase/Cube)** — классический BI: стандартные метрики,
  дашборды, регулярные разрезы. Для нас — **референс формул и имён метрик** (чтобы
  `named`-рецепты по `events`+`users` давали то же число), а не источник данных. Если
  вопрос целиком закрывается витриной — корректно отослать туда, а не пересчитывать.
- **GrowthBook** (`growthbook_*`) — статзначимость A/B (Bayesian, Chance to Win,
  power). Мы читаем результат (`experiment_lookup`) и даём поведенческое «почему»
  (`post_hoc_segment_compare`) — расчётом по `events`+`users`.
- **Player Segmentation API** — готовые сегменты игроков: `CohortRef.segment_api_id`
  ссылается на них (список `user_id` подмешивается в `WHERE`), а не дублирует логику.
- **DWH:** физически `events` и `users` могут маппиться на модели Model/Metric-слоя
  (`bi_data_models`, `bi_data_metrics`) — это деталь конфига schema; **логически тул
  всегда видит ровно две детальные таблицы** и строит из них весь SQL.

---

## 10. Что и как исследуют в компании (реальный контекст)

- **ТЗ BI-команды «GD Tasks»** прямо формулирует нужные ad-hoc примитивы
  (фильтрованный подсчёт, условие на соседнее событие, метрики по поведенческим
  сегментам) — это каркас §3.1–3.3.
- **Retention deep-dives** (WO): квантильные сегменты по активности, профили
  d0/d0_2, анализ по сессиям, last-action перед оттоком; root-cause через состав
  трафика и avg_playtime_d3, нормировка к baseline.
- **Экономика** (WO): структура `currency_income` free vs rewarded по ad-watch
  сегментам и skill-сегментам (fast/middle/slow).
- **Баланс уровней** (WO, Sudoku): модель сложности, поиск «проблемных» уровней,
  зависимости (ходы/техники/ad usage vs прохождение) — A/B по балансу.
- **A/B**: формализованный пайплайн в Jira (Idea→Validation→Backlog→In test→
  Won/Lost/Inconclusive→Rollout), Value/Effort-скоринг, GrowthBook + CUPED, A/A
  тесты, post-hoc разбор по сегментам новизны (новички/1-99/100+).
- **Монетизация**: разборы падения ARPU/LTV, ROAS по закрытым когортам.

---

## Источники

### Внутренние (Confluence/Jira, openmygame)
- **GD Tasks** — BI/4971790388 (ТЗ ad-hoc задач: Блоки 1–3, 5)
- Retention D1 deep-dive (квантильные сегменты, сессии, last-action) — WO/4874240120
- Анализ причин падения Retention RU Android — WO/4774428695
- Исследование экономики free/reward currency_income — WO/4927258627
- Исследования A/B по балансу уровней — WO/4801953941; Sudoku «поиск зависимостей» — Sudoku/4124672001
- Metabase - Исследование RewardedGameScreen — (личное пространство) /4826464352
- Post-hoc A/B «New Balance V1» — WO/4906909697; A/A-тест (CUPED) — MW/4687396865
- [Metabase] Semantic Layer: Metrics Calculation Guide — BI/4144398337; Metrics Documentation Overview — BI/3612573764
- Data Warehouse Layered Architecture — BI/3396534300
- Пайплайн A/B тестов (пирамида метрик) — PA/4881940484; A/B Statistic Engine — BI/3859152921; Power Calculation — BI/3804758049
- Player Segmentation API — BI/4340121602; Сегментация игроков (BI API) — FLWRD-5668
- [Dimension] Retention X Day — BI/3508502782; Game Funnel Stage — BI/3916857510; Segment → Online Players — BI/4056481835
- Методологии расчёта (24h Appsflyer vs calendar, авто-смена в экспериментах) — BI/4144398337
- GrowthBook: метрики от момента активации — Publishing/4561764368
- ELT (Extract-Load-Transform) и партиционирование BigQuery — BI/3481665728
- Ingame Events Service (приём событий) — BI/3820290053; Кастомные аналитические события — PA/2602991642

### Внешние (таксономия гибкой event-аналитики и бенчмарки)
- [Amplitude — Charts: find the right one (taxonomy)](https://help.amplitude.com/hc/en-us/articles/115001816407)
- [Amplitude — Historical Count / order of operations (multi-stage)](https://amplitude.com/docs/analytics/historical-count-2)
- [Amplitude — Guide to Behavioral Cohorting](https://amplitude.com/blog/guide-to-behavioral-cohorting)
- [Amplitude — Product Analytics Guide](https://amplitude.com/explore/analytics/product-analytics-guide)
- [Amplitude — Funnel Analysis](https://amplitude.com/guides/funnel-analysis)
- [Amplitude — Pathfinder & Behavioral Cohorts](https://e-cens.com/blog/amplitude-101-advanced-analysis-with-pathfinder-cohorts/)
- [Optimizely — Funnel analysis SQL (warehouse-native)](https://www.optimizely.com/insights/blog/funnel-analysis-sql/)
- [Metabase Learn — CTEs for multi-stage SQL](https://www.metabase.com/learn/sql/working-with-sql/sql-cte)
- [PostHog — Cohorts](https://posthog.com/docs/data/cohorts)
- [Adjust — Cohort KPIs: event conversion & funnels](https://www.adjust.com/blog/demystifying-cohorts-3-tracking-custom-user-journeys-with-event-kpis/)
- [GameAnalytics — 22 metrics all game developers should know](https://www.gameanalytics.com/blog/metrics-all-game-developers-should-know)
- [Game Growth Advisor — Mobile Game KPIs & Benchmarks 2026](https://gamegrowthadvisor.com/blog/2026-03-17-mobile-game-kpis-benchmarks-2026/)
- [dbt — Semantic Layer / MetricFlow metrics](https://docs.getdbt.com/docs/build/metrics-overview)
- [Statsig — Best Product Analytics Tools](https://www.statsig.com/comparison/best-product-analytics-tools)
