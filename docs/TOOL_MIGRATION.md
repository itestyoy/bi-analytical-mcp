# Миграция на новую схему инструментов (сборка → запрос → показ)

Документ для обновления рецептов (`RECIPES_PATH`, формат как у `config/recipes.json`) и любых
текстов/инструкций, которые называют инструменты Betti. Здесь всё, что изменилось в именах,
аргументах и ответах, и как переписать каждое старое место.

## 0. Коротко

Две стороны, одна схема имён:

| Сторона | Сборка | Запрос и чтение задачи |
|---|---|---|
| семантическая модель | `build_semantic_model` | `query_semantic_model` |
| пайплайн | `build_pipeline_model` | `query_pipeline_model` |

- Любой вызов, который делает работу на складе (сборка или запрос), **возвращает только `task_id`**
  (плюс `context_id`, `read_with`, `next`) и **ничего не ждёт**.
- Результат читает **query-инструмент той же стороны** с `{ task_id }`: он ждёт до 30 с и
  возвращает строки. Пока `status: "running"`, его нужно вызвать ещё раз. Какой инструмент читает
  задачу, написано в поле `read_with` ответа.
- Рисует карточку **только** `display_model_result({ task_id, display })`, один раз на задачу.
- `experiment` не изменился: отдельный процесс, ответ сразу, без задач. Карточку рисует сам при `card: true`.

## 1. Переименования (1:1, аргументы те же)

| Было | Стало | Примечание |
|---|---|---|
| `create_semantic_model` | `build_semantic_model` | те же аргументы, включая `action: "update"` |
| `build_native_model` | `build_pipeline_model` | те же `action`: start / add_step / add_steps / edit_step / insert_step / delete_step / truncate / fork / preview / materialize / discard |
| `display_result` | `display_model_result` | тот же `display` |

Старые имена пока принимаются как скрытые алиасы, но в рецептах и текстах должны быть **новые**.

## 2. Удалено

| Было | Чем заменить |
|---|---|
| `get_task_result({ task_id })` | `query_semantic_model({ task_id })` — для задач `build_semantic_model` и `query_semantic_model`; `query_pipeline_model({ task_id })` — для задач `build_pipeline_model` (materialize), `query_pipeline_model` и `register_native_model` |
| `get_query_result({ query_id })` | то же: `query_semantic_model({ task_id })` / `query_pipeline_model({ task_id })` (`query_id` теперь называется `task_id`) |
| `get_query_result({ context_id, table })` — прочитать таблицу пайплайна | `query_pipeline_model({ task_id: <задача сборки> })` или `query_pipeline_model({ context_id })` (читает собранную модель контекста) |
| `get_query_result({ …, transform })` — перерезать таблицу пайплайна | `query_pipeline_model({ context_id, transform })`: where / group_by / aggregations / having / order_by, **без** `transform.limit`, строки задаются `limit`/`offset` верхнего уровня |
| `get_query_result({ …, transform })` — перерезать сохранённый результат метрик (`qr_…`) | `build_pipeline_model({ action: "start", name, from_task: <task_id запроса с materialize:true> })` + стадии (`where`, `aggregate`, …) + `materialize` |
| `get_query_result({ …, sample, sample_percent })` | стадия `sample` в пайплайне |
| `get_query_result({ …, offset, limit })` — страницы | `query_semantic_model({ task_id, offset, limit })` / `query_pipeline_model({ task_id, offset, limit })` |
| `display` на `query_semantic_model` / `get_query_result` | отдельный вызов `display_model_result({ task_id, display })` |
| `time({ query_id })` — ожидание запроса | query-инструмент стороны с `{ task_id }` (он сам ждёт, `wait_seconds` ≤ 30); `time` остался только чистым таймером `time({ seconds })` |

## 3. Что изменилось в поведении

### 3.1 `build_semantic_model` (бывш. `create_semantic_model`)
- Возвращает `{ task_id, context_id, read_with: "query_semantic_model", next }`.
- `parse`, `metrics`, `groupable` и прочее теперь приходят из `query_semantic_model({ task_id })`, а не из ответа вызова.
- Запрос к этому контексту можно слать сразу: он дождётся разбора (задачи одного контекста идут по очереди).

### 3.2 `query_semantic_model`
- **Два режима** в одном инструменте:
  - запуск: `{ context_id, metrics, group_by, where, order_by, time_range, materialize, limit, offset, dry_run, explain }` → `{ task_id, context_id, read_with, next }`;
  - чтение: `{ task_id, wait_seconds?, offset?, limit? }` → строки (`status: "done"`), ошибка (`status: "error"`) или `status: "running"`.
- Смешивать режимы нельзя: `task_id` вместе с `metrics` и прочими полями запроса отклоняется схемой.
- Поля `display` больше нет.
- `materialize: true` сохраняет результат таблицей `qr_<task_id>`. Она листается через `{ task_id, offset, limit }`, её можно показать сводной или графиком с drill, и от неё можно начать пайплайн (`from_task`).

### 3.3 `build_pipeline_model` (бывш. `build_native_model`)
- `materialize` возвращает `{ task_id, context_id, draft_id, model, read_with: "query_pipeline_model", next }`.
- Строки, `build`, `columns`, `provenance`, `warnings`, `checkpoint` берутся из `query_pipeline_model({ task_id })`.
- Новое: `start` принимает `from_task` вместо `source`, чтобы начать черновик от сохранённой таблицы готовой задачи: запроса с `materialize: true` или сборки пайплайна. `time_range` вместе с `from_task` не допускается, вместо него стадия `where`.
- Повторный `materialize`, пока идёт сборка, отклоняется, и отказ называет `task_id` идущей сборки.

### 3.4 `query_pipeline_model` (новый)
- Запуск: `{ context_id, transform?, limit?, offset? }` → `{ task_id, … }`. Это запрос к **собранной** модели пайплайна контекста.
- `transform` проверяется по колонкам модели прямо в вызове.
- Функции `sum / avg / min / max / count_distinct` требуют `column`; `count` без `column` (или с `column: "*"`) считает строки и по умолчанию называется `count`.
- Чтение: `{ task_id, wait_seconds?, offset?, limit? }`.

### 3.5 `display_model_result` (бывш. `display_result`)
- Рисует результат **модели**: запроса семантической модели или пайплайна. Эксперименты не рисует.
- Одна задача — одна карточка: повторный вызов для того же `task_id` отклоняется.
- Сводная (`kind: "pivot"`) и график с `drill` требуют **сохранённую таблицу**: запрос с `materialize: true` или сборку пайплайна. Результат `query_pipeline_model` для этого не подходит, нужно показать задачу сборки.
- Задачу, которая ещё идёт, не рисует: сначала дождаться её через query-инструмент.

### 3.6 `experiment` — без изменений
- `plan` / `check_split` / `analyze` отвечают сразу, **без `task_id`**.
- Карточку рисует сам при `card: true`, только в хостах с MCP Apps.
- В `display_model_result` эксперимент **не передаётся**.

### 3.7 Поля ответов
| Было | Стало |
|---|---|
| `query_id` | `task_id` |
| `status: "ready"` | `status: "done"` |
| `read_with: { tool: "get_query_result", table }` в ответе сборки | ответ сборки приходит через `query_pipeline_model({ task_id })`, в нём есть `task_id` и `table` |
| `show_to_user: { tool: "get_query_result", … }` | `show_to_user: { tool: "display_model_result", arguments: { task_id } }` (только для хостов с Apps) |
| `semantic_index({ status })` → `query_jobs` (`query_id`) | `tasks` (`task_id`, `tool`) |
| `context({ action: "describe" })` → `read_with: "get_query_result"` | `built_by_task` + `read_with` (текст с `query_pipeline_model`) |

### 3.8 Несколько запросов одним вызовом (новое)
- `query_semantic_model({ context_id, queries: [ {metrics, group_by, …}, … ] })`: до 5 запросов к одному
  контексту. Каждый элемент принимает поля одиночного запроса, а `context_id` указывается один раз сверху.
- `query_pipeline_model({ context_id, queries: [ { transform, limit?, offset? }, … ] })`: до 5 проекций
  собранной модели.
- Все запросы проверяются до запуска: одна ошибка отклоняет весь пакет, и в ответе названо, какой именно
  (`queries[2]: …`). Ответ — `{ task_ids, context_id, read_with, next }`.
- Запросы пакета выполняются параллельно. Каждый остаётся отдельной задачей: его можно читать, листать,
  рисовать через `display_model_result` и начинать от него пайплайн, как одиночный.
- Чтение пакета: `{ task_ids: [...] }`. Ждёт, пока готовы все (до 30 с), и возвращает `results` в том же
  порядке; каждый элемент равен ответу `{ task_id }`. Если часть ещё идёт, `status: "running"`, а `next`
  называет только их. `offset`/`limit` с `task_ids` не принимаются: страницы листают по одной задаче.

### 3.9 Отмена задачи (новое)
- `query_semantic_model({ task_id, cancel: true })` / `query_pipeline_model({ task_id, cancel: true })`, или
  `{ task_ids: [...], cancel: true }` для нескольких. Задача той же стороны, что и инструмент.
- Идущая задача сразу получает статус `cancelled`: её процесс на складе останавливается, а стоящая в очереди
  не запустится. Следующие задачи контекста выполняются дальше. Уже завершённую задачу отмена не трогает и
  отвечает `cancelled: false`.
- Чтение отменённой задачи возвращает `status: "cancelled"`.

## 4. Как обновить рецепт (чек-лист для агента)

**Ключи JSON рецепта НЕ меняются**: `create_payload`, `register_payload`, `example_queries`,
`tool_calls`, `ab_test`, `srm_check`, `required_*`, `metric_types`, `approach`, `instead_of`,
`read_first`, `requires`, `runtime` загрузчик читает как раньше. Сами payload-объекты тоже не
меняются: `create_payload` подаётся в `build_semantic_model`, `register_payload` — в пайплайн как
раньше.

Меняется то, что написано **словами** и в `tool_calls`:

1. В `title`, `when_to_use`, `notes`, `hack`, `approach`, `instead_of`, `read_first` заменить:
   - `create_semantic_model` → `build_semantic_model`;
   - `build_native_model` → `build_pipeline_model`;
   - `display_result` → `display_model_result`.
2. Каждое упоминание `get_query_result` переписать по таблице из раздела 2 в зависимости от смысла:
   - прочитать результат → query-инструмент стороны с `{ task_id }`;
   - перерезать таблицу пайплайна → `query_pipeline_model({ context_id, transform })`;
   - перерезать сохранённый результат метрик → пайплайн с `from_task`;
   - выборка (`sample`) → стадия `sample`.
3. Каждое место, где сказано «вызов вернёт строки / rows» у сборки или запроса, дополнить шагом
   чтения: «…возвращает `task_id`; строки — `query_semantic_model({ task_id })` / `query_pipeline_model({ task_id })`».
4. `query_id` → `task_id`; `status: ready` → `status: done`.
5. `time({ query_id })` → чтение query-инструментом с `{ task_id }`. `time({ seconds })` без `query_id` оставить как есть.
6. `display` внутри аргументов `query_semantic_model` вынести в отдельный шаг
   `display_model_result({ task_id, display })`. Если `display` сводная или с `drill`, у запроса должен быть `materialize: true`.
7. `tool_calls` с `"tool": "experiment"` или `"tool": "ab_test"` не трогать. Если где-то в `experiment` стоял `card: true`,
   он остаётся, а `display_model_result` для экспериментов не добавлять.
8. `tool_calls` с `"tool": "create_semantic_model"` / `"build_native_model"` / `"display_result"` переименовать по разделу 1,
   а с `"tool": "get_query_result"` / `"get_task_result"` переписать по разделу 2.
9. Если рецепт перерезал таблицу пайплайна через `transform` с `limit` внутри, убрать `transform.limit`:
   количество строк задаёт `limit` верхнего уровня `query_pipeline_model`.
10. Если в `transform` есть агрегат без `column` (кроме `count`), добавить `column`, иначе вызов будет отклонён.
11. Если рецепт делает подряд несколько независимых запросов к одному контексту (другие метрики, другой
    разрез, другое окно), объединить их в один вызов с `queries: [...]` и читать через `{ task_ids }`.

## 5. Пример переписывания

Было (текст `hack`):
> Build it with build_native_model (start → add_step → materialize); the rows come back directly —
> re-slice them with get_query_result({ context_id, table, transform: { group_by: ["country"] } }).

Стало:
> Build it with build_pipeline_model (start → add_step → materialize); materialize returns a
> task_id — read the rows with query_pipeline_model({ task_id }), and re-slice the built model with
> query_pipeline_model({ context_id, transform: { group_by: ["country"], aggregations: [{ fn: "count" }] } }).

Было:
> query_semantic_model({ context_id, metrics: ["dau"], display: { kind: "line", x: "metric_time_day", y: ["dau"] } })

Стало:
> query_semantic_model({ context_id, metrics: ["dau"], group_by: [{ time: "metric_time", grain: "day" }] }) → task_id;
> query_semantic_model({ task_id }) → rows; then display_model_result({ task_id, display: { kind: "line", x: "metric_time_day", y: ["dau"] } }).
