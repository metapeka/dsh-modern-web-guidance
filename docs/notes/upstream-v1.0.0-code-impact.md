# Upstream v1.0.0: влияние на код плагина (tools, поиск, тесты, локаль)

Task: `task-9` · Author: `telemetry-core` · Date: 2026-11-10 · Status: **только анализ** — ни код, ни тесты, ни
данные не менялись, коммитов нет. Единственные записи вне этого файла — черновики в `.tmp/code-impact/`.

Номера строк — дерево `0.3.1` на 2026-11-10. При применении правок идти **снизу вверх** по файлу, чтобы номера
в верхних строках не съезжали.

Смежные заметки, на которые эта опирается и не дублирует их:

- `docs/notes/upstream-v1.0.0-diff.md` — что именно изменилось в корпусе (task-8);
- `docs/notes/upstream-v1.0.0-surfaces.md` — построчная инвентаризация всех текстовых утверждений о корпусе (task-10).

---

## 0. Как это проверено

Главное отличие этой заметки от двух смежных: всё ниже **измерено на настоящих байтах tarball-а**, а не выведено
из описания релиза. Метод:

1. Источник — опубликованный npm-пакет `.tmp/upstream-diff/mwg-1.0.0.tgz`
   (`.tmp/upstream-diff/pkg100/package/skills/modern-web-guidance/`), а не git-тег. В git-дереве нет
   `gen/guides.json` и `skill-version.txt`, а все файлы CRLF; в tarball-е — LF.
2. Собран «кандидат на ре-вендоринг»: `.tmp/code-impact/tarball-data/` — `gen/guides.json` (208 записей) +
   `guides/**` из пакета (209 файлов; `built-in-ai/prompt-api.md` скопирован, но в индексе его нет) +
   `corpus.json` = `{"version":"2026_11_09-5bcc021b","snapshotDate":"2026-11-09"}` (из `skill-version.txt`).
3. Неизменённый код `0.3.1` скопирован в `.tmp/code-impact/provisional-repo2/` поверх этих данных и прогнан
   пофайлово: `node --test --test-isolation=none test/<file>` (в песочнице `node --test test/*.test.mjs` даёт EPERM).
4. Поиск/ретрив проверены прямыми вызовами `lib/guidance.js` на `.tmp/code-impact/tarball-data` (скрипты §9).

Ключевые числа (все перепроверены локально, сходятся со смежными заметками):

| величина | наш снапшот | upstream v1.0.0 | Δ |
| --- | ---: | ---: | ---: |
| записей в `guides.json` | 193 | **208** | +15 |
| файлов `.md` в пакете / вендорим | 193 / 193 | **209 / 208** | +16 / +15 |
| новых / удалённых / переехавших гайдов | — | **15 / 0 / 0** | — |
| категорий | 17 | **17** (тот же набор) | 0 |
| тел гайдов изменено | — | **105** из 193 общих (88 байт-идентичны) | — |
| H1-заголовков изменено | — | **4** | — |
| `description` изменено | — | **4** | — |
| `featuresUsed` изменено | — | **12** | — |
| `tokenCount` изменено | — | **193** (все) | — |
| байт корпуса (208 файлов) | 1 557 860 | **1 952 778** | +394 918 (+25,3 %) |
| Σ `tokenCount` | 430 254 | **474 620** | +44 366 |
| `guides.json` | 72 103 B | **80 329 B** | +8 226 B |
| id снапшота | `2026_10_30-58d055df` | **`2026_11_09-5bcc021b`** | — |
| CLI-ссылок в телах (`npx -y … retrieve "id"`) | 121 / 45 гайдов | **197 / 64 гайда** | +76 / +19 |
| «закрытых» гайдов (`originTrials` / `volatileFeatures`) | 8 / 0 | **8 / 10** (18 уникальных id) | +10 |

Расхождения с брифом, которые надо зафиксировать до релиза:

- **«203 use-case гайда»** — это счёт upstream-а по его README (`README.md:192`), а не размер нашего каталога:
  208 индексированных = 203 use-case + 5 дисциплинарных обзоров (`accessibility`, `forms`, `html`,
  `performance`, `security`). Публиковать надо **208** (см. surfaces §0.1).
- **«98 обновлённых гайдов»** — измерено **105** байт-изменённых (98 из них upstream анонсировал, 7 — «тихие»).
- **«новый порядок категорий/гайдов»** — не подтверждается: набор категорий и их порядок в индексе тот же,
  относительный порядок 193 общих записей не изменился, 15 новых вставлены внутрь своих категорий
  (`ui-components` +8, `ui-behaviors` +3, `user-experience` +2, `ui-atoms` +1, `pwa` +1).

---

## 1. Карта: что обновление корпуса задевает в коде

Обновление — **данные, а не миграция**. Загрузчик читает два файла по имени, всё остальное выводится из них.

| файл | что читает / предполагает | вердикт для 0.4.0 |
| --- | --- | --- |
| `data/guides.json` | манифест: `id`, `category`, `description`, `featuresUsed[]`, `tokenCount` (+ необязательные `originTrials[]`, `volatileFeatures[]`) | заменить байт-в-байт на `gen/guides.json` (208 записей) |
| `data/guides/**/*.md` | тело гайда, H1 = заголовок, `##`/`###` = searchable headings | заменить на 208 индексированных файлов (LF, без `prompt-api.md`) |
| `data/corpus.json` | только `version` + `snapshotDate` для отчёта | две строки |
| `index.js` | 2 строки с числом 193 в описаниях tools/skill; `readCatalog()` строит `byCategory`/`categoryOf` из манифеста | правка 2 строк (`:23`, `:224`) |
| `lib/guidance.js` | схема манифеста, лимиты, веса, rewrite CLI-ссылок | **изменений не требует** (схема аддитивна; regex совпадает со всеми 197 ссылками) |
| `lib/report.js` | формат `Corpus: …` и лимиты вывода | не требует (числа приходят из снапшота) |
| `lib/telemetry.js` | `catalog.total/byCategory/categoryOf` из `readCatalog()` | не требует (категорийно-агностичен) |
| `lib/store.js` | путь и атомарная запись счётчиков | не требует |
| `client.js` | `report.corpus.total`, строки coverage из снапшота | **не требует** (чисел/категорий в коде нет) |
| `locale/en.json`, `locale/ru.json` | только `meta.title` / `meta.description` | не требует |
| `data/skills/chrome-extensions/**` | 24 md + `skill-version.txt` | **не требует**: побайтово идентичен v1.0.0 (после нормализации EOL) |
| `data/skills/modern-web-guidance/SKILL.md` | наша адаптация 0.0.197 | переадаптировать (`:4` версия, `:7` счётчик, Step 1, новый инвентарь) |
| `test/*.mjs` | 6 равенств на 193, 1 ожидание top-1, 1 строка версии снапшота | 8 ассерт-строк в 7 тестах (§3) |

---

## 2. Жёстко зашитые предположения о корпусе (file:line)

### 2.1 Число гайдов в поставляемых строках

| file:line | текст | почему важно |
| --- | --- | --- |
| `index.js:23` | `SEARCH_DESCRIPTION` → `193 curated, token-efficient guides` | описание инструмента уходит модели; расхождение с реальным каталогом — прямая ложь в промпте |
| `index.js:224` | skill routing description → `search 193 use-case guides before writing HTML…` | эта строка цитируется в `README.md:86`, `README.ru.md:85`, `README.zh.md:84` |
| `package.json:4` | `description` → `Google Chrome's 193-guide catalog…` | попадает в npm/GitHub/manifest |
| `data/skills/modern-web-guidance/SKILL.md:7` | `the catalog lives in this plugin: 193 guides (use-case guides plus broader discipline guides)` | тело скилла, самый дрейфующий текст; лучше писать «208 guides (203 use cases + 5 discipline guides)» или без числа |
| `data/skills/modern-web-guidance/SKILL.md:4` | шапка адаптации → `version 0.0.197` | должно стать `version 1.0.0` |
| `market/awesome-dsh-plugin.yml:10` | `193 Baseline-aware web-platform guides` | витрина маркетплейса |
| `NOTICE:10-14` | `version 0.0.197`, `the corpus is 193 files for 193 index entries` | лицензионная атрибуция; формулировка меняется на 209 файлов / 208 записей |

Документация (README ×3, PUBLISHING) уже расписана в surfaces §1-§4; здесь важно только то, что **источник правды
для числа — `data/guides.json.length` после обновления (208)**, а не 203 из upstream README.

### 2.2 Перечисление 17 категорий

- `index.js:42-43` — `LIST_DESCRIPTION` перечисляет все 17 категорий прозой. Набор в v1.0.0 **не изменился**
  (проверено по `gen/guides.json`: те же 17 `category`), поэтому строка формально не устарела.
- `test/hardening.test.mjs:85` (`css` = 18), `:86` (`UI-COMPONENTS`), `test/plugin.test.mjs:82` (`ui-atoms`) —
  это фильтры по одной категории; `css` остаётся 18, поэтому `:85` продолжает проходить.
- «Категория → массив id» как структура данных нигде не зашита: `data/guides.json` — плоский массив с полем
  `category`; `readCatalog()` (`index.js:281-296`) строит `categoryOf`/`byCategory` при старте, `list()` фильтрует
  (`lib/guidance.js:382-396`), счётчики категорий считаются на лету (`index.js:184-191`), coverage — из манифеста
  (`lib/telemetry.js:360-366`). **Добавление 15 гайдов в существующие категории кода не требует**; единственное
  зашитое перечисление категорий — проза `LIST_DESCRIPTION`.

### 2.3 Лимиты и продублированные константы

Источник правды — `lib/guidance.js:24-30`: `MAX_QUERY_CHARS 512`, `MAX_QUERY_TERMS 24`, `MAX_RETRIEVE_IDS 10`,
`MAX_RETRIEVE_CHARS 120_000`, `MAX_ID_LENGTH 80`, `MAX_UNKNOWN_REPORTED 10`, `MAX_PREFIX_EXPANSIONS 200`.
Схема инструментов дублирует их литералами:

| file:line | дубль |
| --- | --- |
| `index.js:122` | `maxLength: 512` (= `MAX_QUERY_CHARS`) |
| `index.js:153` | `maxItems: 10`, `maxLength: 80` (= `MAX_RETRIEVE_IDS`, `MAX_ID_LENGTH`) |
| `index.js:125`, `:176` | `limit`/`category` 1..25 и `maxLength: 40` |
| `index.js:81-83` | рендер-фолбэки `maxGuides ?? 10`, `Math.round((limits.maxChars ?? 120000) / 1000)` |

С корпусом это не связано, **менять не нужно**. Но после обновления `MAX_RETRIEVE_CHARS` становится фактически
рабочим ограничением ретрива (см. §4.2): лимит «10 id» и лимит «120 000 символов» срабатывают почти одновременно,
и какой именно набор вернётся, зависит от порядка манифеста и размеров тел.

### 2.4 Формат id/путей, заголовки, frontmatter

- `lib/guidance.js:22` — `SLUG = /^[a-z0-9][a-z0-9-]*$/` для `id` и `category`; все 208 id v1.0.0 проходят
  (в том числе id, начинающиеся с цифры, — `2d-panning`).
- `lib/guidance.js:174` — путь `guides/<category>/<id>.md`; `:176-180` — защита от выхода за `data/`.
  Раскладка v1.0.0 идентична (те же 17 каталогов), путь `prompt-api.md` — единственный файл без записи в индексе.
- `lib/guidance.js:128-131` — заголовок из первого `# `; `:134-140` — `##`/`###` в поисковый текст.
  Frontmatter-а **нет ни в 0.0.197, ни в 1.0.0** (все 208 файлов начинаются с `# `), парсера frontmatter в коде
  нет — и не появится.
- Изменения H1 (влияют на вес `title`): `style-parent-with-has`, `autofill-highlight-inputs`,
  `group-element-transitions`, `menu` — см. §4.1.

### 2.5 Ранжирование: веса и что их двигает

`lib/guidance.js:54-79`: `STOPWORDS`, `FIELD_WEIGHTS` (title 3, id 3, description 2.5, featuresUsed 2.5,
headings 1.5, body 1), бонусы вхождения (id 10, title 6, description 2), `BM25_K1 1.2`, `BM25_B 0.75`;
`stem`/`tokenize` — `:82-121`; сборка полей — `:190-211`; сам поиск — `:328-380`.
Формулы от корпуса не зависят, но 105 изменённых тел, 4 заголовка, 4 описания и 12 `featuresUsed` меняют оценки.
Измеренный эффект — ровно один сдвиг top-1 из 30 проверенных запросов (§4.1).

### 2.6 Строгость загрузчика и режимы отказа (проверено экспериментом)

`lib/guidance.js:167-212` (`readEntry`) + `:214-250` (`buildIndex`):

| вход | поведение | вывод |
| --- | --- | --- |
| неизвестные поля (`volatileFeatures`, `originTrials`) | игнорируются | схема v1.0.0 совместима |
| `description`/`tokenCount` отсутствуют | фолбэки `?? ''` / `round(len/4)` | терпимо |
| `featuresUsed` не массив | `TypeError: (entry.featuresUsed ?? []).join is not a function` (`:194`) | **валит индексацию целиком** |
| `id` не slug / `category` не slug | явная ошибка (`:168-173`) | валит индексацию целиком |
| манифест не массив | ошибка (`:227`), дубликат id — `:234` | валит индексацию целиком |
| битый/missing `.md` | ошибка с скрытым путём (`:181-187`) | валит индексацию целиком |

Важное следствие: `Promise.all(catalog.map(readEntry))` (`:228`) — **одна плохая запись ломает все три
инструмента**, не только свой гайд. Для 0.4.0 это не проблема (v1.0.0 соблюдает схему), но именно поэтому
обновление манифеста нельзя делать «на глазок»: см. обязательные шаги §6.1 и тест-инвариант §6.2-S3.
`readCatalog()` (`index.js:281-296`) вызывается внутри `try` (`index.js:367-377`), поэтому битый манифест
выключает только счётчики, а tools падают на слое `guidance`.

### 2.7 Локаль и панель: чисел и категорий нет

- `client.js:244-269` — панель берёт `corpus.total`, `corpus.version`, `periodDays`, строки `coverage` и
  `deadGuides` из `/guidance-stats --json`; `client.js:524` — KPI «Guides» = `String(report.corpus.total)`.
- Строки — шаблоны без чисел: `{count} of {total} guides` (`client.js:52`), `{retrieved} / {total}` (`:54`),
  `Last {days} days` (`:44`); русские аналоги — `:84`, `:92-94`.
- `locale/en.json:4`, `locale/ru.json:4` — только `meta.title`/`meta.description`, примеры тем без счётчиков.
- `lib/report.js:167-173` — `Corpus: version …, snapshot …, N guides` собирается из снапшота; `:251-254` —
  «dead guides» тоже из `corpus.total`.
- `lib/store.js` и запись метрик (`lib/telemetry.js`) от корпуса не зависят.

**Вердикт по пункту 4 задания: правок нет ни в `client.js`, ни в `locale/*`.** После обновления данных панель
сама покажет 208 и новые coverage-строки; единственное, что меняется, — содержимое `data/corpus.json`.

### 2.8 Идентичность корпуса

`index.js:264-274` (`readCorpusMeta`, терпим к отсутствию файла) + `data/corpus.json`. Достаточно записать
новую пару `version`/`snapshotDate`; формат отчёта и JSON-снапшота не меняется (см. `test/stats.test.mjs:92,112`).

---

## 3. Тесты: что реально падает (измерено)

Прогон неизменённого кода 0.3.1 на данных v1.0.0: **59 из 66 проходят, 7 падают**. Полный список падений:

| # | file:line | ассерт | факт на v1.0.0 |
| --- | --- | --- | ---: |
| 1 | `test/guidance.test.mjs:11` | `assert.equal(guides.length, 193)` | 208 |
| 2 | `test/guidance.test.mjs:24` (→ `:29`) | кейс `['passkey sign in', 'passkey-registration']` | top-1 = `passkey-management` |
| 3 | `test/plugin.test.mjs:80` | `assert.equal(grouped.total, 193)` | 208 |
| 4 | `test/hardening.test.mjs:83` | `list({category: ''}).length === 193` | 208 |
| 5 | `test/hardening.test.mjs:84` | `list({category: null}).length === 193` | 208 |
| 6 | `test/hardening.test.mjs:94` | `value.total === 193` | 208 |
| 7 | `test/stats.test.mjs:92` | `match(/Corpus: version 2026_10_30-58d055df/)` | новая версия в `corpus.json` |
| 8 | `test/stats.test.mjs:112` | `payload.corpus.total === 193` | 208 |

(Строк-ассертов 8, падающих тестов 7: в `test/hardening.test.mjs` проверки `:83` и `:84` живут в одном тесте.)

На что обратить внимание в «зелёной» части:

- `test/hardening.test.mjs:45-53` (`retrieve(all ids)` → ровно 10 гайдов, `truncated`, `chars ≤ 120 000`)
  **проходит, но на пределе**: на v1.0.0 возвращается 10 гайдов и **119 140** символов, т. е. запас до лимита
  120 000 — **860 символов (0,7 %)**. Проверка держится на «пропустил и продолжил» (`lib/guidance.js:430-435`):
  первые 10 id дают 9 гайдов (не влезает `atrule-support-conditionals`), а дальше добирается `responsive-design`.
  Любое подрастание любого из этих тел или перестановка манифеста снова даст 9/8. Тест стоит переписать так,
  чтобы он проверял инвариант (`≤ 10`, `≤ 120 000`, `truncated`, `skipped.length > 0`), а не магическое «10».
- `test/hardening.test.mjs:144-152` («served guides never tell the agent to run the upstream CLI») проходит:
  все 197 вхождений в 64 гайдах точно совпадают с `lib/guidance.js:19` (других форм `npx` в телах нет), и все
  переписаны на `web_guidance_retrieve(...)` при загрузке.
- `test/hardening.test.mjs:154-159` (`passkeys` переписан) проходит; комментарий `:155` про «45 guides» устарел
  (теперь 64).
- `test/hardening.test.mjs:85` (`css` = 18) остаётся верным: в `css` по-прежнему 18 гайдов.
- `test/report.test.mjs` — **не падает и менять его не обязательно**: фикстуры синтетические
  (`:14`, `:30-31`, `:141`, `:151` — свои собственные числа, не читают `data/`). Обновить версию/208 в фикстуре
  стоит только ради реализма (S, опционально), тесты зелёные и без этого.
- `test/telemetry.test.mjs`, `test/store.test.mjs`, `test/paths.mjs` — синтетика, правок нет
  (`telemetry.test.mjs:21,162` — необязательная косметика).
- `test/plugin.test.mjs:60,70,82` — проходят: `light-dismiss-a-dialog` остаётся top-1, `dialog` сохраняет H1,
  `ui-atoms` непустой.

Дешёвые инварианты, которые стоит добавить вместе с обновлением (защищают все будущие рефреши):

1. `data/guides.json.length` = числу `.md`, на которые он ссылается (208 = 208), `prompt-api` не проиндексирован;
2. все `id`/`category` проходят `SLUG` и уникальны;
3. каждый файл начинается с `# ` (иначе `titleOf` молча падает на `id`).

---

## 4. Поведение поиска и ретрива на v1.0.0 (измерено)

### 4.1 Ранжирование

Батарея из 30 запросов (7 из `test/guidance.test.mjs`, 8 из README-таблицы «типичные задачи», 15 новых гайдов):
**29/30 дают ожидаемый top-1**. Единственный сдвиг:

| запрос | было top-1 | стало top-1 | счёт |
| --- | --- | --- | --- |
| `passkey sign in` | `passkey-registration` | **`passkey-management`** | 32,50 vs 30,00 vs 27,92 (`passkey-reauthentication`) |

Это не регрессия поиска, а изменение контента: `passkey-management` (17 759 B) переписан под сценарии входа.
Варианты для теста/README (измерено):

| запрос | top-1 | отрыв |
| --- | --- | --- |
| `passkey registration` | `passkey-registration` | 68,06 vs 42,54 — устойчиво |
| `passkey login` | `passkey-authentication` | 34,26 vs 30,88 — тонко |
| `passkeys` | `passkeys` (обзор) | 43,86 |

Рекомендация: в тесте заменить пару на `['passkey registration', 'passkey-registration']` (семантика та же,
отрыв большой), в README-таблице строку «Passwordless sign-in» переписать на «Passkey registration».
Вариант «оставить запрос, поменять ожидание на `passkey-management`» работает, но отрыв 2,5 балла — хрупко.

Все 15 новых гайдов на своих запросах дают top-1 (`accordion`, `tabs`, `carousel`, `breadcrumbs`, `navbar`,
`toolbar`, `copy button`, `drag and drop`, `sortable table`, `dynamic sort`, `app menus`, `single line overflow`,
`install web app`, `form factor adaptation`, `natural interactions`) — новых «пожирателей» чужих запросов нет,
кроме ожидаемого соседства (`responsive data table` → вторым `sortable-table`).

### 4.2 Ретрив и лимиты

- `retrieve(all 208 ids)`: возвращает **10 гайдов / 119 140 символов**, `skipped` = 198. Лимит по числу (10)
  и по символам (120 000) срабатывают почти одновременно; какой именно набор вернётся, зависит от порядка
  манифеста и размеров тел (сначала пропуск, потом добор мелкими — `lib/guidance.js:430-435`).
- Отдельно `retrieve(first 10 ids)` = 9 гайдов — это нормальное поведение лимита, но показывает, что «10»
  в тесте не гарантировано.
- Одиночный ретрив, unknown-id, дедупликация, `limits` в ответе — без изменений.

### 4.3 Производительность

| метрика | 193 гайда | 208 гайдов |
| --- | ---: | ---: |
| холодная сборка индекса (`ready()`) | 130-170 мс | 157-216 мс (замеры 179 мс) |
| поиск (top-8, один запрос) | 0,8-1,4 мс | 0,3-0,9 мс |
| размер корпуса | 1,49 MiB | 1,86 MiB |

Индекс строится в фоне при `apply` (`index.js:439-441`), поэтому первый вызов инструмента уже тёплый;
действий не требуется.

### 4.4 Что ещё меняется в выводе

- `tokenCount` изменился у **всех** 193 записей (пере-токенизация upstream-а), в т. ч. у байт-идентичных тел
  (например, `accessibility`: 14 305 → 13 341). У нас `tokenCount` только информационный (в JSON-ответе
  `search`, `hit.tokenCount`; в рендер не попадает) — правок нет, но любые доки/фикстуры с «~450k токенов»
  надо пересчитать (474 620 по манифесту).
- 4 новых H1 и 4 обновлённых `description` — это то, что видит модель в результатах поиска; после обновления
  цитаты в README/доках сверять с новым индексом.
- **18 гайдов теперь «закрыты»** по метаданным upstream-а: 8 с `originTrials` (были и в 0.0.197 —
  `verify-email-ownership`, `apply-webgl-shaders`, `export-html-media-from-canvas`,
  `expose-canvas-content-to-browser-features`, `interactive-content-in-3d-scenes`, `agentic-forms`,
  `agentic-javascript-tools`, `webmcp`) и 10 с новым `volatileFeatures` (`language-detection`, `language-model`,
  `summarizer`, `translator`, `out-of-order-html-streaming`, `client-side-encryption`, `digital-signatures`,
  `restrict-outbound-connections`, `2d-panning`, `custom-text-decorations`). Наш загрузчик эти поля не читает
  (`lib/guidance.js:190-211`), т. е. мы отдаём их как обычные гайды — это продуктовое решение, см. D-1.

---

## 5. Решения под функциональность v1.0.0

### D-1. Volatile features / Origin Trials: нужен ли аналог гейта

**Как у upstream.** Гейт живёт в манифесте (`originTrials` ×8, `volatileFeatures` ×10) и в CLI: `retrieveUseCase`
(`modern-web.mjs:286-335`) проверяет `.mwgrc[allowOriginTrials|allowVolatileFeatures] !== true` и **бросает**
`OriginTrialGateError`/`VolatileFeatureGateError`; текст ошибки — это CAUTION-блок с «never bypass this gate» и
командой разблокировки (`modern-web.mjs:255-285`). При `false` — вариант «политика проекта запрещает». Плюс
новый `baseline` в `.mwgrc` подмешивает `> [!IMPORTANT]`-баннер в начало гайда (`modern-web.mjs:233-254`).
Поиск/листинг гейт не трогает — гайд остаётся находимым. В `SKILL.md` про гейты **не сказано ни слова**.
`.mwgrc` ищется вверх от cwd до `.git`, затем `~/.mwgrc` (`modern-web.mjs:126-165`).

**У нас.** Ни `.mwgrc`, ни чтения полей, ни баннеров. Инструменты вообще не читают файлов пользователя — это
часть модели безопасности (см. `README.md:153-173`), и текущий cwd хоста не обязан быть корнем проекта.

**Варианты.**

| вариант | что делать | сложность | риск | цена/эффект |
| --- | --- | --- | --- | --- |
| (a) игнорировать, задокументировать | 1 предложение в `SKILL.md`: «экспериментальные/одиночно-движковые API помечены в самом гайде — проверяйте статус» | S | низкий | 0 кода; поведение честно описано, но модель не предупреждена |
| (b) аннотировать при ретриве | читать `originTrials`/`volatileFeatures` в `readEntry` (`lib/guidance.js:190-211`) и добавлять в начало `content` короткий баннер («Origin Trial / volatile feature: <ids>; проверьте поддержку»), в `search` — пометку `[experimental]` в строке результата | M (~40-60 строк + 2 теста) | низкий | предупреждение есть, контент доступен; ни один существующий тест не трогает gated-id, так что правок тестов не требует |
| (c) блокировать + opt-in в конфиге плагина | `retrieve` возвращает `gated` вместо контента, пока `allowOriginTrials`/`allowVolatileFeatures` не true; конфиг через `apply(ctx, config)` (`index.js:438`) | M-L (~100-150 строк: `retrieve`-контракт + рендер + конфиг + доки) | средний-высокий | по умолчанию перестанут отдаваться `language-model`, `summarizer`, `webmcp`, `agentic-*`; измерено: из 10 гайдов, которые сейчас возвращает `retrieve(all)`, 4 gated (`language-detection`, `language-model`, `summarizer`, `translator`) → вернётся 6, тест `hardening:45-53` придётся менять |
| (d) полноценный `.mwgrc` (поиск файла, baseline-баннеры, set-* UX) | как у CLI | L | высокий | нет надёжного project-root в контексте инструмента; чтение произвольного cwd — новый класс риска; не для 0.4.0 |

**Рекомендация:** (b) как «желательное» 0.4.0, иначе (a). (c) — только если Lead сознательно хочет
fail-closed поведение и готов принять смену контракта `retrieve`; (d) — 0.5.0+ и только вместе с решением,
откуда брать корень проекта.

### D-2. Рефайнмент поискового запроса

**Как у upstream.** В `SKILL.md` Step 1 появились два правила: «Name implied UI primitives» (переводить
намерение в UI-примитив: `"confirm first"` → `"confirmation modal dialog"`, `"pick a date"` →
`"date picker input"`) и «rephrase `search` once before `list`». Сам поиск у них — эмбеддинги + BM25,
векторы лежат в `gen/` (9,16 МБ).

**У нас.** Чистый лексический BM25 со стеммингом, префиксным расширением и бонусами вхождения
(`lib/guidance.js:323-379`). Измерение на новом корпусе: 29/30 top-1, включая все «подразумеваемые» кейсы
(`"prevent page scroll under modal"`, `"responsive data table"`, `"light dismiss dialog"`) и все 15 новых идов.
Т. е. **код менять не нужно**; изменился только текст скилла.

**Рекомендация:** портировать формулировки Step 1 в наш `SKILL.md` (S, без кода). Синоним-таблицы/эмбеддинги —
отказаться (см. X-1): любое вмешательство в веса сейчас ломает проверенные пары, а выигрыш не измерен.

### D-3. `legacy-scan` и 4-шаговый workflow

**Как у upstream.** Отдельный CLI-движок `legacy-scan.mjs` (**4 992 779 B**), команда
`npx … legacy-scan <path> --json`, 4 шага (scan → verify по `keepWhen`/`dropWhen` → report → modernize+rescan)
и правило «сканирует ~20 % каталога». В `SKILL.md` это отдельная секция «Alternative flow».

**У нас.** Правило «три инструмента остаются тремя»; инструменты не читают файлов пользователя (сканирование
чужого кода — принципиально другая поверхность: файловая система вне `data/`, отчёты, false positives).
Портировать движок = +5 МБ и новая подсистема, четвёртый инструмент = нарушение ограничения.

**Рекомендация:** отказаться в 0.4.0 (X-2). В `SKILL.md` добавить одну нейтральную фразу «this plugin does not
include the upstream `legacy-scan` workflow», чтобы модель не пыталась его вызвать. Возможное будущее — отдельный
scope (команда/скилл, не tool) в 0.5+.

### D-4. Переезды категорий, frontmatter, «категория → массив»

Переездов нет (0), категорий по-прежнему 17, frontmatter-а нет ни в одной версии, манифест плоский.
**Решений не требуется**; единственное действие — verify-only для `LIST_DESCRIPTION` (`index.js:42-43`) и
теста-инварианта «описание перечисляет ровно категории индекса» (опционально, S).

### D-5. Идентичность корпуса и путь в tarball-е

`data/corpus.json` — две строки (`2026_11_09-5bcc021b`, `2026-11-09`, из `skill-version.txt`).
Отдельно: **инструкция по обновлению в `README.md:225-236` указывает неверный путь** — там
`package/skills/modern-web-guidance/{guides.json,guides}`, а в 1.0.0 манифест лежит в
`skills/modern-web-guidance/gen/guides.json` (плюс появились `skill-version.txt`, `gen/*`, CLI-файлы).
Это надо поправить в доках, иначе следующий рефреш сломается на «нет файла guides.json».

---

## 6. Ранжированный список правок

### 6.1 Обязательные (без них 0.4.0 нельзя выпускать)

| # | правка | file:line | сложность | риск |
| --- | --- | --- | --- | --- |
| O-1 | Заменить корпус: `gen/guides.json` → `data/guides.json` (208 записей), `guides/**` → `data/guides/**` (208 индексированных файлов, LF, без `prompt-api.md`), `corpus.json` → новая пара | `data/guides.json`, `data/guides/**`, `data/corpus.json` | S | низкий (данные; `lib/*` уже совместим) |
| O-2 | Обновить число в описаниях tools/skill: `193` → `208` (не 203) | `index.js:23`, `index.js:224` | S | низкий (но строка `:224` цитируется в 3 README — менять вместе) |
| O-3 | `package.json`: версия 0.3.1 → 0.4.0 и `description` «193-guide» → «208-guide» | `package.json:3`, `package.json:4` | S | низкий |
| O-4 | Переадаптировать `SKILL.md`: шапка `version 1.0.0`, счётчик 208, портировать Step 1 (implied primitives/rephrase-once), добавить фразу про отсутствие `legacy-scan`, обновить инвентарь «When to use it» новыми темами | `data/skills/modern-web-guidance/SKILL.md:4`, `:7`, `:26-36` | S-M | низкий |
| O-5 | Починить 8 ассерт-строк в 7 падающих тестах (6 счётчиков + строка версии + ожидание top-1) | `test/guidance.test.mjs:11`, `:24`; `test/plugin.test.mjs:80`; `test/hardening.test.mjs:83`, `:84`, `:94`, `:155` (комментарий); `test/stats.test.mjs:92`, `:112` | S | низкий |
| O-6 | Документация: README ×3 (+бейджи, 208, 1 952 778 B, 474 620 токенов, 197/64 ссылок, строка passkey), PUBLISHING (`:60`, `:78`, `:118`, `:132`, `:251-253` — версия снапшота и битый якорь `#updating-the-corpus`), NOTICE (`:10-14`, `:23-27`, `:29-31` — добавить `legacy-scan` в список вырезанного), `market/awesome-dsh-plugin.yml:10`, `README.md:225-236` (путь `gen/guides.json`) | см. surfaces §1-§6, §10 | S | низкий (делает docs-release, но релиз без этого «врёт») |

Порядок применения: данные → `index.js` → `package.json` → `SKILL.md` → тесты → доки, и `node --test` пофайлово
после каждого шага (полный `npm test` — только в среде Lead, в песочнице spawn даёт EPERM).

### 6.2 Желательные (в 0.4.0, если есть ёмкость; каждая независима)

| # | правка | file:line | сложность | риск |
| --- | --- | --- | --- | --- |
| S-1 | Аннотировать gated-гайды при ретриве (вариант D-1b): баннер в `content` + пометка в результатах поиска | `lib/guidance.js:190-211`, `:403-446`; `index.js:67-90` | M | низкий (ни один тест не трогает gated-id) |
| S-2 | Добавить тест-инвариант «манифест ↔ файлы» (208/208, `prompt-api` не проиндексирован, все id — slug, все тела с `# `) | `test/hardening.test.mjs` (новый тест) | S | низкий |
| S-3 | Укрепить `retrieve`-тест: проверять `≤ 10`/`≤ 120 000`/`truncated`/`skipped`, а не магическое «10» (сейчас запас 0,7 %) | `test/hardening.test.mjs:45-53` | S | низкий |
| S-4 | Обновить README-таблицу «типичные задачи» (строка passkey) и числа лимитов, если они там приводятся | `README.md:120-133`, `:161-167` | S | низкий |
| S-5 | Обновить синтетические фикстуры версии снапшота для реализма (`report.test.mjs:14,141,151`, `telemetry.test.mjs:21,162`) — на зелёность не влияет | см. file:line | S | низкий |
| S-6 | Заменить рендер-фолбэки лимитов на значения из payload ретрива (`index.js:81-83`) — косметика, убирает второй источник правды | `index.js:81-83` | S | низкий |
| S-7 | `readCatalog()`: дедуплицировать id через `Set` (защита от будущего манифеста с дублями; сейчас дублей нет, `guidance` и так падает на `:234`) | `index.js:281-296` | S | низкий |

### 6.3 Отказаться в 0.4.0 (и почему)

| # | что | причина | когда вернуться |
| --- | --- | --- | --- |
| X-1 | Эмбеддинги/векторный поиск (ассеты `gen/`: `query-words.i8` 7,47 МБ, `guide-chunks.*`, всего 9,16 МБ) | нарушает «ноль зависимостей» и размер пакета; измерено, что лексический BM25 даёт 29/30 top-1 на новом корпусе; выигрыш не доказан | не планируется без отдельного решения о размере пакета |
| X-2 | `legacy-scan` (движок 4,99 МБ) и 4-шаговый flow | четвёртый инструмент запрещён; сканирование пользовательских файлов — новая поверхность безопасности | 0.5+, отдельный скилл/команда, не tool |
| X-3 | `.mwgrc`-дискавери, baseline-баннеры, `set-*` UX | нет надёжного корня проекта в контексте инструмента; чтение произвольного cwd — новый риск; нужен продуктовый UX | 0.5+ вместе с решением про config |
| X-4 | Гейт по умолчанию (fail-closed retrieve) | по умолчанию отрежет `language-model`, `summarizer`, `webmcp`, `agentic-*` — ядро ценности плагина; меняет контракт `retrieve` и тест `hardening:45-53` | только если Lead выберет D-1(c) сознательно |
| X-5 | Пайплайн frontmatter/метаданных, «сборка индекса из markdown» | метаданных в файлах нет ни в одной версии; индекс — генерируемый артефакт upstream-а, его надо вендорить | не планируется |
| X-6 | Любая новая UI-функциональность панели | ограничение релиза 0.4.0 | 0.5+ |
| X-7 | «Починка» исторических чисел в `audit/*` | это датированный аудит; правится квалификатором, а не цифрами (surfaces §11) | не менять |

---

## 7. Минимальный объём 0.4.0 (предложение)

Состав: **обновление данных + переадаптация скилла + текстовые числа + тесты**, без изменений `lib/*`,
`client.js`, `locale/*`.

Файлов 17 (из них 3 — данные):

1. `data/guides.json` ← `gen/guides.json` (80 329 B, 208 записей, байт-в-байт);
2. `data/guides/**` ← 208 индексированных `.md` (1 952 778 B, LF; `prompt-api.md` не вендорим);
3. `data/corpus.json` ← `{"version":"2026_11_09-5bcc021b","snapshotDate":"2026-11-09"}`;
4. `index.js:23`, `index.js:224` — 193 → 208;
5. `package.json:3`, `:4` — 0.4.0 + 208-guide;
6. `data/skills/modern-web-guidance/SKILL.md` — `:4` версия, `:7` счётчик, Step 1 (`:26-36`), фраза про
   `legacy-scan`, инвентарь тем;
7. `test/guidance.test.mjs:11`, `:24`; `test/plugin.test.mjs:80`; `test/hardening.test.mjs:83`, `:84`, `:94`,
   `:155`; `test/stats.test.mjs:92`, `:112`;
8. доки: README ×3 (включая бейджи `guides-193` → `guides-208`, `:131` passkey, `:167`), `NOTICE:10-14` и
   `:23-27`, `:29-31`, `PUBLISHING.md:60`, `:78`, `:118`, `:132`, `:251-253`, `market/awesome-dsh-plugin.yml:10`,
   `README.md:225-236` (путь `gen/guides.json`).

Не входит: `lib/*`, `client.js`, `locale/*`, `lib/report.js`-формат, панель, гейты, `legacy-scan`, эмбеддинги,
исторические `audit/*`.

Приёмка (в среде Lead, где spawn разрешён; в песочнице — пофайлово):

```bash
node --test --test-isolation=none test/guidance.test.mjs   # 7/7
node --test --test-isolation=none test/plugin.test.mjs     # 4/4
node --test --test-isolation=none test/hardening.test.mjs  # 15/15
node --test --test-isolation=none test/report.test.mjs     # 14/14
node --test --test-isolation=none test/stats.test.mjs      # 5/5
node --test --test-isolation=none test/store.test.mjs      # 5/5
node --test --test-isolation=none test/telemetry.test.mjs  # 16/16
# итого 66/66
```

Плюс смоук: `web_guidance_list({})` → `total: 208`, 17 строк категорий; `web_guidance_search('tabs')` →
`tabs` первым; `web_guidance_retrieve('tabs')` → markdown с `# `; `/guidance-stats --json` → `corpus.total: 208`,
`corpus.version: 2026_11_09-5bcc021b`.

Оценка: ~1 файл данных (1,95 МБ / 1,86 MiB), 2 строки в `index.js`, 2 в `package.json`, 1 файл скилла, 7 ассертов в тестах,
6 доков + бамп версии. Без нового кода в `lib/` — риск регрессии минимален.

---

## 8. Риски, за которыми надо следить

| # | риск | доказательство | что делать |
| --- | --- | --- | --- |
| R-1 | Манифест можно взять не оттуда: в 1.0.0 он переехал в `gen/guides.json`; README-инструкция всё ещё указывает старое место | `README.md:225-236` vs `pkg100/…/gen/guides.json` | поправить путь в доках (O-6), при рефреше брать только tarball |
| R-2 | Смена типа `featuresUsed` (или `category`) в будущем манифесте валит **все** tools, а не один гайд | `lib/guidance.js:194`, `:168-173`, `:228` | тест-инвариант S-2 + понятная ошибка уже есть; в 0.4.0 не блокер |
| R-3 | Лимит 120 000 символов стал рабочим: 10 гайдов = 119 140 символов (запас 860) | §4.2, `lib/guidance.js:430-435` | S-3 (тест на инвариант, а не на «10») |
| R-4 | 105 изменённых тел + 4 заголовка + 4 описания могут сдвигать top-1 вне тестового набора | §4.1 (один измеренный сдвиг из 30) | после рефреша прогнать README-таблицу и батарею из §9; не менять веса «на глаз» |
| R-5 | `tokenCount` пере-токенизирован целиком | §4.4 | не сравнивать токены между снапшотами; пересчитать доки (474 620) |
| R-6 | CRLF, если рефрешить из git-клона, а не из tarball-а | в tarball-е LF (проверено: 0 CRLF), в клоне CRLF | брать npm-пакет; `gitattributes` всё равно нормализует, но байты перестанут совпадать с upstream |
| R-7 | 18 gated-гайдов отдаются без предупреждения (built-in AI, WebMCP, canvas/WebGL, WebCrypto) | §4.4 / D-1 | решить D-1: минимум — фраза в `SKILL.md`, лучше — S-1 |
| R-8 | Числа в доках снова разъедутся, если писать «203»/«98» из релиз-нотов | §0 | публиковать измеренные 208 / 105 / 1 952 778 B / 474 620 токенов |

---

## 9. Воспроизведение

Черновики и скрипты (вне git, `.tmp/` в `.gitignore`): `.tmp/code-impact/`

| скрипт | что делает |
| --- | --- |
| `npx-usage.mjs` | считает CLI-ссылки в телах (форма, файлы, вхождения) |
| `build-tarball-data.mjs` | собирает `.tmp/code-impact/tarball-data/` из `pkg100` (208 индексированных + `guides.json` + `corpus.json`) |
| `authoritative-diff.mjs` | дифф нашего снапшота vs v1.0.0: записи, байты, H1, описания, `featuresUsed`, категории, gated-метаданные → `authoritative-diff.json` |
| `changed-depth.mjs` | глубина изменений тел (105 изменённых, распределение churn) |
| `probe-tarball.mjs` / `measure.mjs` | батарея запросов, ретрив-лимиты, время сборки индекса |
| `schema-probe.mjs` | режимы отказа загрузчика + точный подсчёт CLI-ссылок (197/64) |
| `final-numbers.mjs` | байты/токены/категории для таблиц §0 |
| `diff-skills-norm.mjs` | `data/skills/**` vs v1.0.0 с нормализацией EOL (chrome-extensions идентичен) |
| `provisional-repo2/` | копия `0.3.1` + данные v1.0.0, на которой получены 7 падений §3 |
| `passkey-queries.mjs` | варианты passkey-запросов для §4.1 |

Команды, которыми получены числа §0/§3/§4 (PowerShell; `npm test` целиком в песочнице падает на spawn — гонять
пофайлово):

```powershell
# данные из tarball-а
node .tmp/code-impact/build-tarball-data.mjs .
# дифф и гейты
node .tmp/code-impact/authoritative-diff.mjs .
# прогон тестов на неизменённом коде + новых данных
Set-Location .tmp/code-impact/provisional-repo2
foreach ($f in 'guidance','plugin','hardening','report','stats','store','telemetry') {
  node --test --test-isolation=none "test/$f.test.mjs"
}
```
