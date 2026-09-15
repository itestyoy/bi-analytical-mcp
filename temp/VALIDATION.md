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

## Партиция объявлена; требование окна — нет

В `temp/schema.yml` у events добавлено:

```yaml
partition_column: event_date   # cost hint: физическая партиция
```

Колонка `event_date` была, а объявления не было — самая большая таблица каталога
шла без cost-hintа. Теперь `semantic_index({ model: 'events' })` называет партицию и
советует всегда ограничивать запрос окном. У `crashlytics` объявление уже было.

`require_time_range` **не включён** — пробовали и отменили. Почему это важно
знать, если решите вернуться к нему: флаг не советует, а ОТВЕРГАЕТ вызов без
окна — и ни один из 59 вызовов, которые отгружают рецепты (49 `example_queries` +
10 пайплайнов), окна не несёт. То есть включение флага требует одновременно
дописать окна во все рецепты, иначе отвалятся все 28.

Если понадобится разово — есть рантайм-переключатель `MCP_REQUIRE_TIME_RANGE`: он
включает требование для всего сервера без правки схемы (и так же потребует окон
в рецептах).

Проверено поведением на этом же каталоге:

| проверка | результат |
|---|---|
| метрический запрос без окна | принимается (ничто не требует окна) |
| пайплайн без окна | собирается (dry run) |
| `semantic_index({ model: 'events' })` | `partition_column: event_date` + cost hint «ALWAYS bound queries with time_range» |

Рецепты при этом остались БЕЗ окон, как и были: заглушки `2026-08-01 … 2026-08-31`,
добавленные ради флага, сняты из всех 59 мест — фиксированные даты внутри шаблона
без принуждающего их флага только сбивали бы с толку.

## Что НЕ менялось

**`users` — slowly-changing** (`install_time_valid_from` / `install_time_valid_until`), и ни один
   рецепт не джойнит его в пайплайне — джойны есть только на `experiments`, который не SCD, так что
   окно там и не нужно. В метрическом пути MetricFlow применяет окно сам. Ничего чинить не пришлось,
   но если появится пайплайн с `join { with: 'users' }` — ему нужен `between`, иначе счётчики
   раздует; сервер теперь такой джойн помечает предупреждением и сам достраивает окно, когда отдаёт
   рецепт.
## Ссылки на макросы bi-dbt убраны

Восемь рецептов обещали соответствие макросам bi-dbt — «mirrors macro X exactly»,
«faithful units_playtime», «exactly as the BI macro does». Обещание было чисто ТЕКСТОВЫМ:
никто макрос не читает, ничего с ним не сверяется — значит правка на стороне bi-dbt
(граница клампа, набор событий, переименование) расходила рецепт с BI молча, и ни
одна проверка этого не ловила. Ссылки убраны: теперь рецепт описывает СВОЮ
формулу и ничего не обещает про чужой объект.

Сами вычисления НЕ менялись — ни одного `compute`, `measure` или границы клампа.
Изменилась только проза (12 полей `notes` / `when_to_use` / `hack` в 8 рецептах):

| рецепт | было | стало |
|---|---|---|
| `blended_revenue` | «ad_revenue mirrors macro measure__ad_revenue EXACTLY» | «ad_revenue is defined here as: ad_finished only, cast to float64, clamped to [0,1] USD per impression» |
| `blended_revenue` (hack) | «how to mirror a bi-dbt measure macro» | ºпострочный кламп живёт только в compute op=raw» |
| `game_playtime_native` | «mirrors macro units_playtime exactly» | «complete_time clamped to [0,3600] seconds per row, then summed» |
| `ad_quality_native` | «mirrors macros ad_revenue / ad_display_duration / ad_latency» | три ограниченные построчно величины с их границами, каждая суммируется |
| `game_state_snapshots_native` | «mirrors the unit_started/completed_* snapshot macros» | что именно снимается на событиях и суммируется |
| `resource_balance_coins_native` | «mirrors macros … exactly» | взвешивание подсказок по цене конкретного приложения, неоценённые типы дают 0 |
| `game_engagement`, `coin_economy`, `ad_delivery` | «макрос клампит / флорит, а здесь нет» | «здесь величина суммируется как есть; ограниченный вариант требует нативного пайплайна» + ссылка на него |

Важное, что при этом уточнилось, а не пропало: IAP-нога `blended_revenue` — это
внутриигровая цена `iap_purchase_completed` до налога и без валидации. Цифра BI,
построенная на валидированных покупках, — ДРУГАЯ величина, и она не совпадёт никогда,
по построению. Раньше это было сказано через отрицание («the IAP leg does NOT mirror a
macro»), теперь — прямо, с указанием, откуда брать данные, если вопрос про биллинг.

Скан прозы теперь не находит ни одной ссылки на макросы — и вместе с ними ушло
единственное ложное срабатывание поиска на двойное подчёркивание (`measure__ad_revenue`).

## Окружение

`pythonRuntime` на этой машине недоступен (нет dbt-профиля), поэтому `python`-стадия в проверке
рецептов не участвовала; ни один из 28 рецептов её и не объявляет.
