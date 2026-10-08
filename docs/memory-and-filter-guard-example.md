# Пример: как это работает (память + кросс-язык + гард значений)

Живой прогон на фикстуре (`test/integration/fixtures/catalog.yml`). Всё ниже — **реальные
ответы движка**. Семантический кросс-язычный поиск показан через стаб-эмбеддер (механизм
идентичен настоящей мультиязычной модели `text-embedding-3-large`, которая стоит по
умолчанию); лексический мост и гард значений работают «как есть», без сети.

> Воспроизвести: см. скрипт в конце документа.

---

## Полный цикл

```
вопрос пользователя
  → discover (semantic_index: overview → event → property → search)
  → resolve (нашли реальное поле/значение)
  → memory record (notes: [{ note + question + bilingual aliases + targets }])
  → в следующий раз: semantic_index { search } (RU/EN, лексика + семантика), { notes: true }
                      ИЛИ инлайн в semantic_index { source, property } / { source, event } / { model }
  → строим запрос
  → гард значений не даёт подставить непроверенное / не-то-регистра значение
```

Каждый слой — отдельная защита от «галлюцинаций»: **имена полей** берутся только из каталога
(enum/grounding), **значения фильтров** сверяются с реальными (гард), **накопленные находки**
переиспользуются и находятся на любом языке.

---

## 1. ИИ выяснил нетривиальное → записал в память (двуязычно)

Пользователь спросил размыто про «формат рекламы». ИИ разобрался и сохранил находку:

```json
memory({ "request": {
  "action": "record",
  "notes": [{
    "note": "'ad format' = the event_data property ad_type_of_event_data (only on ad_started/ad_finished); values rewarded/interstitial/banner",
    "question": "which ad format drives the most rewarded revenue?",
    "targets": [{ "source": "events", "name": "ad_type_of_event_data" }, { "source": "events", "name": "ad_finished" }],
    "aliases": ["ad format", "формат рекламы", "тип рекламы"]
  }]
} })
```

`notes` — список: одна находка — список из одной, несколько находок одного исследования
сохраняются вместе (все или ни одной). Ответ — каждая находка **привязалась к реальным сущностям**:

```json
{
  "saved": true,
  "notes": [{
    "id": "519f5af8cac1",
    "note": "'ad format' = the event_data property ad_type_of_event_data …",
    "question": "which ad format drives the most rewarded revenue?",
    "linked_to": [
      { "kind": "property", "target": { "source": "events", "name": "ad_type_of_event_data" }, "surfaces_in": "semantic_index({ request: { source: 'events', property: 'ad_type_of_event_data' } })" },
      { "kind": "event",    "target": { "source": "events", "name": "ad_finished" },           "surfaces_in": "semantic_index({ request: { source: 'events', event: 'ad_finished' } })" }
    ],
    "aliases": ["ad format", "формат рекламы", "тип рекламы"],
    "links": []
  }],
  "next": "Saved. A finding surfaces in semantic_index on the entities it is linked to, via semantic_index({ request: { search } }) — including its aliases — and in semantic_index({ request: { notes: true } })."
}
```

---

## 2–3. Позже находим — и по-английски, и по-русски

Память читается `semantic_index`: `{ search }` возвращает подходящие заметки в
`memory_matches` рядом с совпадениями каталога, `{ notes: true }` — все заметки.

```
semantic_index { search: "ad format" }      → memory_matches: заметка  ✅
semantic_index { search: "формат рекламы" } → memory_matches: та же заметка  ✅   (через RU-алиас)
```

Это **лексический мост**: двуязычные алиасы делают заметку findable независимо от языка
запроса — работает даже без эмбеддера (`memory_semantic: false`). Fuzzy/подстрока сама по себе не
перепрыгивает между кириллицей и латиницей, поэтому алиасы на обоих языках обязательны.

---

## 4. Семантика кросс-язык — без общих слов

Сохранили англоязычную заметку `"IAP purchases are failing for some payers"`. Запрос
по-русски **«низкая выручка»** — ни одного общего слова с заметкой:

```
RU "низкая выручка" → memory_semantic = true → нашёл EN-заметку  ✅
```

Это работа **мультиязычной модели**: «выручка» и «IAP / payers» попадают в одну смысловую
область → косинус высокий. **Один вектор на заметку**, никакого пер-языкового хранения.

---

## 5. Та же находка сама всплывает в индексе

`semantic_index({ source: "events", property: "ad_type_of_event_data" })` возвращает поле `memory`:

```json
"memory": [
  {
    "id": "519f5af8cac1",
    "note": "'ad format' = the event_data property ad_type_of_event_data …",
    "question": "which ad format drives the most rewarded revenue?",
    "about": [
      { "kind": "property", "source": "events", "name": "ad_type_of_event_data" },
      { "kind": "event", "source": "events", "name": "ad_finished" }
    ],
    "recorded_at": "2026-10-08"
  }
]
```

ИИ, придя к этому свойству в следующий раз, сразу видит контекст — не переисследует.

---

## 6. Гард значений фильтра (`organic` vs `Organic`)

В базе значение хранится как `Organic`. ИИ пишет фильтр `where result_of_event_data = 'organic'`:

```
REJECTED: stages[0]: filter value(s) not verified against the real data — check the exact value
via semantic_index({ request: { source, property } }) and use it as stored:
  where result_of_event_data: value 'organic' is not a real value —
  the column holds it with different casing. Did you mean: 'Organic'?
```

С правильным регистром — проходит:

```
where result_of_event_data = 'Organic'  →  action = add_steps  ✅
```

Проверка идёт строго **из того источника**, к которому запрос (ключ value-индекса = именно
эта таблица/колонка), потому что в другом источнике то же значение может быть в другом
регистре.

### Что блокируется жёстко, а что только предупреждает

| Случай | Поведение |
|---|---|
| Значение есть, но в другом РЕГИСТРЕ (`organic` → `Organic`) | **HARD reject** + подсказка реального значения |
| Значения нет, и весь набор значений мал и полностью проиндексирован | **HARD reject** + список известных значений |
| У поля много значений (> лимита top-N) / индекс неполный | **WARN**, не блок (значение может существовать вне индекса) |
| Похожее-но-другое значение (`level_1` vs `level_3`) | **WARN**, не блок |
| Поле не проиндексировано / число / диапазон (`gt`/`lt`) | не проверяется |

---

## Конфигурация

| Переменная | Назначение |
|---|---|
| `MEMORY_EMBEDDINGS=openai` + `OPENAI_API_KEY` | включить семантический (векторный) поиск памяти |
| `OPENAI_EMBEDDING_MODEL` | модель эмбеддингов (по умолчанию `text-embedding-3-large`, мультиязычная) |
| `OPENAI_BASE_URL` | OpenAI-совместимый эндпойнт (Azure / Voyage / Cohere / локальный bge-m3 / multilingual-e5) |
| `MCP_MEMORY_DB` | персистентный том для памяти (findings переживают рестарт контейнера) |

Без `MEMORY_EMBEDDINGS` память работает в чисто лексическом (fuzzy + двуязычные алиасы)
режиме — кросс-язык всё равно работает через алиасы, просто без семантической близости.

---

## Скрипт для воспроизведения

```js
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { loadCatalog } from './src/catalog.js';
import { ContextManager } from './src/context-manager.js';
import { Engine } from './src/engine.js';

const CAT = './test/integration/fixtures/catalog.yml';
const ctx = () => new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'demo-')) });

// Стаб мультиязычного эмбеддера: RU+EN-синонимы → одна ось (как настоящая модель — в одно пространство).
function stub() {
  const AX = [
    ['monetization','монетизация','revenue','выручка','iap','money','деньги','payers','платящие'],
    ['retention','удержание','возврат'],
  ];
  const vec = (t) => { const toks = String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u); return AX.map((set) => toks.filter((w) => set.includes(w)).length); };
  return { model: 'stub-multi', embed: async (texts) => texts.map(vec) };
}

const e = new Engine({ catalog: loadCatalog(CAT, {}), contextManager: ctx(), embedder: stub() });

// 1) record
const rec = await e.memory({ action: 'record', notes: [{
  note: "'ad format' = ad_type_of_event_data (only on ad_started/ad_finished); rewarded/interstitial/banner",
  question: 'which ad format drives the most rewarded revenue?',
  targets: [{ source: 'events', name: 'ad_type_of_event_data' }, { source: 'events', name: 'ad_finished' }],
  aliases: ['ad format', 'формат рекламы', 'тип рекламы'] }] });

// 2-3) search EN + RU — .memory_matches
await e.semantic_index({ search: 'ad format' });
await e.semantic_index({ search: 'формат рекламы' });

// 4) semantic cross-language
await e.memory({ action: 'record', notes: [{ note: 'IAP purchases are failing for some payers', aliases: ['monetization'], targets: [{ source: 'events', name: 'price_in_usd_of_event_data' }] }] });
await e.semantic_index({ search: 'низкая выручка' });   // → .memory_matches находит EN-заметку
await e.semantic_index({ notes: true });                // → все заметки

// 5) surfaces in the property view
await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });   // .memory = [...]

// 6) filter-value guard
const e2 = new Engine({ catalog: loadCatalog(CAT, {}), contextManager: ctx() });
e2.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'Organic', freq: 10 }, { value: 'Paid', freq: 5 }] });
const d = await e2.build_pipeline_model({ action: 'start', name: 'guard_demo', source: 'events' });
await e2.build_pipeline_model({ action: 'add_steps', draft_id: d.draft_id, stages: [{ stage: 'where', conditions: [{ column: 'result_of_event_data', op: 'eq', value: 'organic' }] }] }).catch((err) => err.message); // → REJECTED, did you mean 'Organic'?
await e2.build_pipeline_model({ action: 'add_steps', draft_id: d.draft_id, stages: [{ stage: 'where', conditions: [{ column: 'result_of_event_data', op: 'eq', value: 'Organic' }] }] }); // → OK
```
