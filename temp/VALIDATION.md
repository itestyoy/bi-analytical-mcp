# Валидация прод-файлов (temp/)

Файлы: `temp/schema.yml`, `temp/recipes.json` — копии присланных прод-файлов, с исправлениями.
Проверялись загрузчиками и схемами самого сервера, а не глазами.

## Как проверялось

| проверка | чем |
|---|---|
| каталог грузится, guard'ы схемы проходят | `loadCatalog('temp/schema.yml')` |
| рецепты грузятся | `loadRecipes('temp/recipes.json')` |
| каждый `register_payload` / `create_payload` / `tool_calls[].args` — валидный вход инструмента | схемы, собранные из **этого** каталога, через `validateInput` |
| каждый `example_queries[]` — валидный `query_semantic_model` | то же (`context_id` подставлялся заглушкой) |
| `create_payload` компилируется, а не только проходит схему | `Engine._compile` |
| стадии пайплайнов — те же суждения, что делает пошаговый построитель | `Engine._stageWarnings` |
| имена метрик в примерах определены своим же payload | сверка с `create_payload.metrics` + префикс задачи |
| проза не учит формам, которые инструменты больше не принимают | поиск по `semantic_index({ event / property })`, `<entity>__<attr>`, `measure: "строка"`, `meta.mcp.events/values` |

Результат: **28 рецептов, 0 замечаний** после правок ниже.

## Что исправлено

`group_by` в 13 примерах был написан строкой с task-namespaced именем размерности — форма, которую
схема теперь отвергает. Заменено на структурную. Соответствие брал не из строки: у каждого рецепта
свой `create_payload` говорит, какая модель объявляет какой атрибут и под каким именем задачи они
сложены, — строка сверялась с этим списком, и то, что не совпало, не переписывалось бы, а попало в
отчёт (таких не оказалось).

| рецепт | было | стало |
|---|---|---|
| `level_progression` (×2) | `"progression_level_id_of_event_data"` | `{ model: 'events', attribute: 'level_id_of_event_data' }` |
| `monetization_metrics` | `"monetization_product_id_of_event_data"` | `{ model: 'events', attribute: 'product_id_of_event_data' }` |
| `ad_monetization` (×3) | `"ads_network_of_additional_info_of_event_data"`, `"ads_placement_of_event_data"`, `"ads_ad_type_of_event_data"` | `{ model: 'events', attribute: 'network_of_additional_info_of_event_data' / 'placement_of_event_data' / 'ad_type_of_event_data' }` |
| `currency_economy` | `"economy_source_type_of_event_data"` | `{ model: 'events', attribute: 'source_type_of_event_data' }` |
| `game_engagement` | `"game_engagement_chain_of_event_data"` | `{ model: 'events', attribute: 'chain_of_event_data' }` |
| `coin_economy` (×2) | `"coin_economy_source_type_of_event_data"`, `"coin_economy_monetization_type_of_event_data"` | `{ model: 'events', attribute: 'source_type_of_event_data' / 'monetization_type_of_event_data' }` |
| `ad_delivery` (×3) | `"ad_delivery_network_of_additional_info_of_event_data"`, `"ad_delivery_ad_type_of_event_data"`, `"ad_delivery_placement_of_event_data"` | `{ model: 'events', attribute: 'network_of_additional_info_of_event_data' / 'ad_type_of_event_data' / 'placement_of_event_data' }` |

`recipes.json` при записи переформатирован в 2 пробела отступа — содержимое, кроме этих 13 значений,
не менялось.

## Что НЕ менялось, но стоит решить

1. **`events` не объявляет `partition_column`, хотя колонка `event_date` у него есть** — а
   `crashlytics` объявляет (`temp/schema.yml`, стр. ~1954). Если прод-таблица событий
   партиционирована по `event_date`, то самая большая таблица каталога сейчас идёт без
   cost-hint'а и без подсказки ограничивать окно. Объявлять за тебя не стал: партиционирована
   таблица или нет — факт о складе, а не о файле.
2. **`require_time_range` не выставлен нигде.** Если по событиям не должно быть запросов без окна,
   это ставится в схеме и дальше держится сервером.
3. **`users` — slowly-changing** (`install_time_valid_from` / `install_time_valid_until`), и ни один
   рецепт не джойнит его в пайплайне — джойны есть только на `experiments`, который не SCD, так что
   окно там и не нужно. В метрическом пути MetricFlow применяет окно сам. Ничего чинить не пришлось,
   но если появится пайплайн с `join { with: 'users' }` — ему нужен `between`, иначе счётчики
   раздует; сервер теперь такой джойн помечает предупреждением и сам достраивает окно, когда отдаёт
   рецепт.
4. **`measure__ad_revenue`** в `notes` рецепта `blended_revenue` — имя dbt-макроса bi-dbt, а не
   путь `group_by`. Поиск устаревших форм ищет двойное подчёркивание — так выглядела старая
   форма пути (`user__country`), поэтому срабатывает на любом имени чужой системы с `__`.
   Менять нечего: строка лежит в `notes` и ни в какой инструмент не подаётся.

   Что там на самом деле сказано: `blended_revenue` зеркалит макрос bi-dbt — ad revenue
   только по `ad_finished`, `cast` в float64, кламп в [0, 1] USD за показ
   (`least(greatest(…, 0.0), 1.0)`). Кламп ВИНЗОРИЗИРУЕТ: выброс становится 1.0, строка
   не выбрасывается — и именно поэтому рецепт написан нативным пайплайном
   (`compute op=raw`), а не губернируемой мерой: построчный кламп sum-мерой не выразить.

   Где здесь риск, который не ловит никакая наша валидация: связь с макросом чисто
   ТЕКСТОВАЯ. Если в bi-dbt поменяют границу клампа, набор событий или переименуют
   макрос, рецепт продолжит считать по-старому и молча разойдётся с BI — схема тут
   ничего не проверяет, потому что проверять нечего: это обещание в прозе.
   Единственная настоящая страховка — сверка чисел с BI на одном периоде.

## Окружение

`pythonRuntime` на этой машине недоступен (нет dbt-профиля), поэтому `python`-стадия в проверке
рецептов не участвовала; ни один из 28 рецептов её и не объявляет.
