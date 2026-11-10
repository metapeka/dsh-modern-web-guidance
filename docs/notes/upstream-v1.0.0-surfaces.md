# Upstream v1.0.0: inventory of every corpus claim (release 0.4.0)

Task: `task-10` · Author: `docs-release` · Date: 2026-11-10 · Status: **inventory only, nothing outside this
file was changed** (no commits, no code, no doc edits).

Line numbers are the 0.3.1 tree as of 2026-11-10. When applying this list to a file, edit **bottom-up** so the
numbers in the higher rows stay valid.

---

## 0. Evidence base

| Source | Where | What it proves |
|---|---|---|
| npm tarball `modern-web-guidance@1.0.0` | `.tmp/upstream-diff/mwg-1.0.0.tgz` → `.tmp/upstream-diff/pkg100/package/` | the bytes we will actually extract: `gen/guides.json`, `guides/`, `skill-version.txt`, `watchdog/`, CLI files |
| upstream git clone at tag `v1.0.0` (commit `4dd9683`, 2026-11-10) | `.tmp/upstream/` | upstream `README.md:192` says "**203 real-world developer use cases**" — the origin of the "203" in the brief |
| prior diff artefacts | `.tmp/code-impact/corpus-diff.json`, `changed-ids-norm.json` | added/removed/moved ids and category totals |
| measurements below | commands in §0.2 | counts, sizes, CLI-reference counts, content-change counts |

### 0.1 The headline number is 208, not 203

`gen/guides.json` inside the 1.0.0 tarball is the authoritative index (same schema as our `data/guides.json`:
`id, description, category, featuresUsed, tokenCount`). It contains **208 entries in 17 categories**.

Where 203 comes from: upstream's `README.md:192` counts only its "use cases". Arithmetic, verified file by file:

- 209 `.md` files ship in `guides/`;
- `built-in-ai/prompt-api.md` is still a **byte-identical duplicate of `language-model.md`** (both
  `sha256 636C12A3…`, 19 820 B) and is **absent from `gen/guides.json`** → 208 indexed guides;
- of those, 5 are the broader discipline guides `accessibility`, `forms`, `html`, `performance`, `security`,
  which upstream does not list as "use cases";
- 203 = the remaining 191 use-case guides + 12 category guides that upstream's README does list.
- **203 + 5 = 208**, which is exactly what our plugin ships (we ship every category/discipline guide — `html`
  is retrieved by tests and README examples today).

So: the number to publish in this repo is **208** (`data/guides.json.length` after refresh). "203" may only be
used with attribution ("upstream lists 203 use cases"). The brief's "15 new" checks out — 193 + 15 = 208. The
brief's "98 updated" does **not**: measured 105 of the 193 shared guides differ (104 after whitespace
normalisation). See §13.

### 0.2 Numbers to publish (measured)

| Quantity | 0.3.1 (now) | upstream v1.0.0 | How it was measured |
|---|---|---|---|
| Indexed guides | 193 | **208** | `gen/guides.json` length / `data/guides.json` length |
| `.md` files on disk | 193 | 209 (208 + the `prompt-api` duplicate) | file count under `guides/` |
| Categories | 17 | **17, same names** | `gen/guides.json` keys — the category set did **not** change |
| New / changed | — | **15 new, 105 changed** (104 normalised) | path diff + content hash vs `data/guides/` |
| CLI cross-references | 121 in 45 guides | **197 in 64 guides** | regex `npx -y modern-web-guidance@latest` |
| Corpus markdown | 1 557 860 B (~1.5 MB) | **1 988 504 B (~1.9 MB)** | byte sum of shipped `.md` |
| Estimated tokens (retrieve-all) | ~450k | **~600k** | 1 988 504 / 3.33 |
| Corpus / skill version | `2026_10_30-58d055df` | **`2026_11_09-5bcc021b`** | `skills/modern-web-guidance/skill-version.txt` |
| Upstream package | `modern-web-guidance@0.0.197` | **`@1.0.0`** | `package.json` in tarball |
| `chrome-extensions` skill | `2026_08_06-8570fe7c` | **unchanged** (same `SKILL.md` hash `C67D9E4B…`, 23 `references/` files) | hash comparison |
| Test count | 66 | 66 (unless you add a test) | `npm test` |
| Tarball | 238 files, 699 KB packed / 1.9 MB unpacked | **recompute** (`npm pack --dry-run`; expect ≈253 files, ≈820–850 KB packed, ≈2.3 MB unpacked) | not measured here — do not guess in PUBLISHING |

Per-category distribution (only six categories change):

| Category | 0.3.1 | v1.0.0 | Δ |
|---|---|---|---|
| accessibility | 4 | 4 | — |
| built-in-ai | 4 | 4 | — (5 files, 1 is the duplicate) |
| css | 18 | 18 | — |
| forms | 19 | 19 | — |
| html | 8 | 8 | — |
| js | 5 | 5 | — |
| performance | 26 | 26 | — |
| privacy | 1 | 1 | — |
| pwa | 1 | **2** | +1 |
| security | 17 | 17 | — |
| ui-atoms | 12 | **13** | +1 |
| ui-behaviors | 37 | **40** | +3 |
| ui-components | 14 | **22** | +8 |
| user-experience | 1 | **3** | +2 |
| visual-design | 22 | 22 | — |
| wasm | 1 | 1 | — |
| webmcp | 3 | 3 | — |
| **total** | **193** | **208** | **+15** |

The 15 new ids: `accordion`, `app-menus`, `breadcrumbs`, `carousel`, `copy-button`, `drag-and-drop`,
`dynamic-sort`, `form-factor-adaptation`, `install-web-app`, `natural-interactions`, `navbar`,
`single-line-overflow`, `sortable-table`, `tabs`, `toolbar` (the 16th added file, `prompt-api`, is the
duplicate and must not be counted or shipped).

Two consequences the docs must absorb: `css` stays at **18** (so `test/hardening.test.mjs:85` and
README:114 stay correct — do not "fix" them), and the category list itself is unchanged, so the
enumeration in README:52-53 / RU:52 / ZH:51 and in `index.js:42-43` needs *verification*, not rewriting.

### 0.3 Re-derive the numbers at refresh time (source of truth = the refreshed index, not this note)

```sh
# N, categories and per-category counts
node -e "const g=require('./data/guides.json');const b={};for(const x of g)b[x.category]=(b[x.category]||0)+1;console.log(g.length,Object.keys(b).length,JSON.stringify(b))"

# CLI cross-references still present in the bundled guides
node -e "const fs=require('fs'),p=require('path');let n=0,f=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const x=p.join(d,e.name);if(e.isDirectory())w(x);else if(e.name.endsWith('.md')){const c=(fs.readFileSync(x,'utf8').match(/npx -y modern-web-guidance@latest/g)||[]).length;if(c){n+=c;f++}}}})('data/guides')"

# corpus size in bytes / MiB
node -e "const fs=require('fs'),p=require('path');let b=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const x=p.join(d,e.name);if(e.isDirectory())w(x);else if(e.name.endsWith('.md'))b+=fs.statSync(x).size}})('data/guides');console.log(b,(b/1048576).toFixed(2))"
```

`197 / 64` was cross-checked against the current corpus (the same script returns `121 / 45` for 0.3.1, which
matches the claim in today's README), so the method is sound.

---

## 1. README.md

| Place | Current | Should become |
|---|---|---|
| `README.md:13` | `193 Baseline-aware guides · 3 tools · 2 skills · zero dependencies · local counters only` | `208 Baseline-aware guides` + the rest unchanged |
| `README.md:28` | badge `https://img.shields.io/badge/guides-193-2563eb` | `guides-208-2563eb` |
| `README.md:34` | `This plugin puts 193 curated, token-efficient guides in front of the agent` | `… puts 208 curated …` |
| `README.md:52-53` | the 17-name category list | **no change expected** — set unchanged; verify against `gen/guides.json` after the refresh |
| `README.md:86` | quotes the skill routing description `"search 193 use-case guides before writing HTML, CSS or client-side JavaScript"` | this is a verbatim quote of `index.js:224` — change both together. Recommended: `"search 208 guides before writing HTML, CSS or client-side JavaScript"` (drop "use-case": 208 is not the use-case count — see §13 Q1) |
| `README.md:113` | `→ 193 guides across 17 categories` | `→ 208 guides across 17 categories` |
| `README.md:114` | `→ the 18 CSS guides by id and title` | **leave** — css stays 18 (verified) |
| `README.md:137` | `(~1.5 MB of markdown, indexed in a few hundred milliseconds and cached)` | `(~1.9 MB of markdown …)`; re-check the "few hundred milliseconds" figure while you are there — the corpus grew ~28 % |
| `README.md:162` | `(121 occurrences in 45 guides)` | `(197 occurrences in 64 guides)` |
| `README.md:167` | `Retrieving all 193 guides used to hand back 1.5 MB (~450k tokens) in one result.` | `Retrieving all 208 guides would hand back ~1.9 MB (~600k tokens) in one result.` (or drop the absolute figures: "the whole catalog") |
| `README.md:209` | `retrieved guides against the 193 in the corpus` | `against the 208 in the corpus` |
| `README.md:227-228` | `pinned snapshot of upstream modern-web-guidance@0.0.197` / `(skill version 2026_10_30-58d055df)` | `modern-web-guidance@1.0.0` / `(skill version 2026_11_09-5bcc021b)` |
| `README.md:230-231` | step 1: extract `package/skills/modern-web-guidance/{guides.json,guides}` into `data/` | **1.0.0 has no root `guides.json`.** New step: copy `package/skills/modern-web-guidance/gen/guides.json` → `data/guides.json` (same schema, 208 entries) and `package/skills/modern-web-guidance/guides/` → `data/guides/` (ship the 208 indexed guides; `built-in-ai/prompt-api.md` stays unshipped, as NOTICE already says). `chrome-extensions` is unchanged (identical hash) but copying it is harmless |
| `README.md:40` | `Usage counters do exist in 0.2.0, but they never leave the machine` | `Usage counters have existed since 0.2.0, but …` (in a 0.4.0 README "in 0.2.0" reads like news) |
| `README.md:181` | `0.2.0 records what the three tools are actually asked for.` | `Since 0.2.0 the plugin records what …` (same reason; optional if you keep version history out of the README) |
| `README.md:204` | `0.3.0 adds a client half: …` | `The plugin adds a client half: …` (same reason) |
| `README.md:244` | `66 tests across seven files` | unchanged by a corpus refresh; re-check after the test edits (`PUBLISHING.md:60` and RU/ZH carry the same number) |
| `README.md:148-151` | "skill body is adapted from upstream: … keeps the framework/SSR/DOM notes and the Baseline fallback policy, drops the CLI and telemetry sections" | claim stays true **only if** `data/skills/modern-web-guidance/SKILL.md` is re-adapted from the 1.0.0 body (it gained `legacy-scan` and npx sections) — see §7 |
| `README.md:261-262` | `removes the upstream CLI, the bundled TensorFlow.js embedder and the Clearcut telemetry watchdog` | 1.0.0 **no longer ships a TensorFlow.js model**: it ships quantised tables under `gen/` (`query-words.*`, `guide-chunks.*`). New wording: `removes the upstream CLI (modern-web.mjs, search.mjs, legacy-scan.mjs), its precomputed vector tables (gen/) and the Clearcut telemetry watchdog` |

Not affected, listed so nobody "fixes" them: `README.md:25` telemetry badge, `:26-27` tests/npm badges,
`:135-144` "How search works" (its "no embeddings, no bundled model, no TensorFlow.js" is about **our**
plugin and stays true), `:47` "max 10 guides / 120k characters", `:49-50` skills table, `:158-160` security
bullets.

## 2. README.ru.md

Mirror of §1. Note the **grammar** change: 193 takes `гайда` (paucal), 208 takes `гайдов` (genitive plural).

| Place | Current | Should become |
|---|---|---|
| `README.ru.md:13` | `193 гайда с Baseline-фолбэками · 3 инструмента · 2 скилла · ноль зависимостей · только локальные счётчики` | `208 гайдов с Baseline-фолбэками · …` |
| `:28` | badge `guides-193` | `guides-208` |
| `:35` | `плагин кладёт перед агентом 193 курируемых, экономных по токенам гайда` | `208 курируемых … гайдов` |
| `:52` | список из 17 категорий | без изменений (сверить) |
| `:85` | `«искать по 193 гайдам, прежде чем писать…»` | `«искать по 208 гайдам…»` — синхронно с `index.js:224`; русская формулировка должна цитировать новую английскую |
| `:111` | `→ 193 гайда в 17 категориях` | `→ 208 гайдов в 17 категориях` |
| `:112` | `→ 18 CSS-гайдов по id и заголовкам` | без изменений (css = 18) |
| `:135` | `(~1.5 MB markdown, индексация …)` | `~1.9 MB markdown`, сверить время индексации |
| `:162` | `(121 вхождение в 45 гайдах)` | `(197 вхождений в 64 гайдах)` |
| `:167` | `Извлечение всех 193 гайдов раньше отдавало 1.5 MB (~450k токенов) одним результатом.` | `Извлечение всех 208 гайдов … ~1.9 MB (~600k токенов) …` |
| `:209` | `извлечённые гайды против 193 в корпусе` | `против 208 в корпусе` |
| `:227` | `закреплённый срез апстрима modern-web-guidance@0.0.197 (версия скилла 2026_10_30-58d055df)` | `@1.0.0 (версия скилла 2026_11_09-5bcc021b)` |
| `:230` | шаг 1 распаковки `{guides.json,guides}` | `gen/guides.json` → `data/guides.json` + `guides/` (как в §1) |
| `:40`, `:181`, `:204` | `в 0.2.0`, `0.2.0 записывает`, `0.3.0 добавляет` | `начиная с 0.2.0`, `С версии 0.2.0 плагин записывает`, `Плагин добавляет` |
| `:244` | `66 тестов в семи файлах` | без изменений (сверить с реальным `npm test`) |
| `:261-262` | `убирает CLI апстрима, встроенный эмбеддер на TensorFlow.js и сторож телеметрии Clearcut` | новая формулировка из §1 (CLI + `gen/`-таблицы + watchdog); TFJS-модели в 1.0.0 уже нет |

## 3. README.zh.md

| Place | Current | Should become |
|---|---|---|
| `README.zh.md:13` | `193 篇带 Baseline 降级方案的指南 · 3 个工具 · 2 个技能 · 零依赖 · 仅本地统计` | `208 篇带 Baseline 降级方案的指南 · …` |
| `:28` | badge `guides-193` | `guides-208` |
| `:34` | `这个插件把 193 篇经过筛选、节省 token 的指南放到智能体面前` | `208 篇` |
| `:51` | 17 个分类的列表 | 不变（核对） |
| `:84` | `“在写 HTML、CSS 或客户端 JavaScript 之前先检索 193 篇用例指南”` | `208 篇`（与 `index.js:224` 同步；若英文改成 "208 guides"，中文改为「208 篇指南」） |
| `:110` | `→ 17 个分类共 193 篇指南` | `→ 17 个分类共 208 篇指南` |
| `:111` | `→ 18 篇 CSS 指南的 id 与标题` | 不变（css = 18） |
| `:133` | `约 1.5 MB markdown，几百毫秒建好并缓存` | `约 1.9 MB`；复核「几百毫秒」 |
| `:153` | `（121 处，分布在 45 篇指南里）` | `（197 处，分布在 64 篇指南里）` |
| `:157` | `此前一次取回全部 193 篇会返回 1.5 MB（约 450k token）` | `全部 208 篇 … 约 1.9 MB（约 600k token）` |
| `:197` | `已取回的指南对 193 篇语料` | `对 208 篇语料` |
| `:213` | `上游 modern-web-guidance@0.0.197 的锁定快照（技能版本 2026_10_30-58d055df）` | `@1.0.0（技能版本 2026_11_09-5bcc021b）` |
| `:215` | 解压 `{guides.json,guides}` | `gen/guides.json` → `data/guides.json` + `guides/`（同 §1） |
| `:38`, `:170`, `:192` | `0.2.0 里有使用统计`, `0.2.0 记录`, `0.3.0 增加了客户端部分` | `自 0.2.0 起有使用统计`, `自 0.2.0 起插件记录`, `插件增加了客户端部分` |
| `:228` | `七个文件共 66 个测试` | 不变（核对） |
| `:244` | `移除了上游 CLI、CLI 附带的 TensorFlow.js 嵌入模型以及 Clearcut 遥测看门狗` | 同 §1 的新表述（1.0.0 的 `gen/` 量化表替代了 TFJS 模型） |

## 4. PUBLISHING.md

| Place | Current | Should become |
|---|---|---|
| `PUBLISHING.md:14` | `Status: dsh-modern-web-guidance@0.3.1 is live on npm` | after the release: `@0.4.0 is live`, and note it carries the upstream v1.0.0 corpus (208 guides) |
| `:60` | `Real working code: 3 tools, 2 skills, 193 guides, 66 tests` | `208 guides` (test count only if it changes) |
| `:78` | panel pre-flight: `(2 calls, 100% hit rate, full 17-category coverage table, 192 of 193 guides never retrieved)` | this is **dated evidence from 0.3.0**. Either re-run the panel after the refresh and write `207 of 208`, or mark the bullet `(0.3.0, 193-guide corpus)`. Do not silently rewrite the observation |
| `:118` | PR body `… over Google Chrome's 193-guide Modern Web Guidance catalog` | `208-guide` |
| `:132` | `The description is checked against the code. "three tools", "193 guides", …` | `"208 guides"` — and the check is `data/guides.json.length`, not the upstream README |
| `:184` | `The upstream CLI, the TFJS model and upstream's Clearcut telemetry are deliberately not included` | `… the upstream CLI, its precomputed vector tables (gen/) and the Clearcut telemetry …` (see §10) |
| `:188` | `238 files, 699 KB packed / 1.9 MB unpacked at 0.3.0.` | recompute from `npm pack --dry-run` **after** the refresh; expected ≈253 files, ≈820–850 KB packed, ≈2.3 MB unpacked. Never publish an estimate as fact |
| `:251-252` | `snapshot of upstream modern-web-guidance@0.0.197` / `(corpus version 2026_10_30-58d055df, chrome-extensions skill 2026_08_06-8570fe7c)` | `@1.0.0` / `(corpus version 2026_11_09-5bcc021b, chrome-extensions skill 2026_08_06-8570fe7c — unchanged)` |
| `:56`, `:64-66`, `:72-76` | `Since 0.3.0 …`, `0.2.0 adds counters`, `0.3.0's panel …` | historical pre-flight history — leave as is; only `:14` is "current status" and must move to 0.4.0 |
| `:89`, `:244-247` | commit `0.1.0`, `gh release create v0.1.0 …` | historical examples; optionally refresh the release example to `v0.4.0` when you cut this release |

## 5. AGENTS.md, GLOSSARY.md, docs/**/*.md

| Place | Current | Should become |
|---|---|---|
| `AGENTS.md:1-35` | no counts anywhere (CI, client-half, tracker conventions) | **no changes** |
| `GLOSSARY.md:27` | corpus-version example `2026_10_30-58d055df` | optional: `2026_11_09-5bcc021b`. Recommended addition while you are here: a **Use-case guide** vs **Discipline guide** entry — it is the distinction behind 203 vs 208 and keeps future docs from conflating them |
| `docs/adr/0001-local-telemetry.md:9` | `nobody can tell which of the 193 guides agents actually retrieve` | **historical ADR — do not edit.** If the refresh deserves a record, add `docs/adr/0002-…` instead |
| `docs/notes/client-panel-spike.md:1`, `:75-76` | `Client panel spike (0.3.0)`; `… 193 guides … full 17-category table … 192 of 193 guides never retrieved` | **dated live evidence — do not rewrite.** When the panel is re-verified after the refresh, append a new "Re-verified <date> against the 208-guide corpus" paragraph; the 0.3.0 numbers stay as history |
| `docs/agents/domain.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` | no counts | **no changes** |
| `docs/notes/upstream-v1.0.0-surfaces.md` | this file | — |

## 6. market/awesome-dsh-plugin.yml

| Place | Current | Should become |
|---|---|---|
| `market/awesome-dsh-plugin.yml:10` | `Bundles Google Chrome’s Modern Web Guidance offline: three tools that search, retrieve and list 193 Baseline-aware web-platform guides, plus the modern-web-guidance and chrome-extensions skills.` | `… 208 Baseline-aware web-platform guides …` (keep "three tools", quoting of the description, and the `: ` rule) |
| `:5`, `:7` | `category: skill`, icon URL | no change |

If the catalog PR is not yet merged (PUBLISHING:121-127 says the branch was prepared), fold this into the same
one-line submission. If it is merged, open a one-line follow-up PR; never hand-edit the generated catalog
READMEs (PUBLISHING:128-129).

## 7. package.json, locale/*, data/skills/modern-web-guidance/SKILL.md

| Place | Current | Should become |
|---|---|---|
| `package.json:3` | `"version": "0.3.1"` | `"0.4.0"` |
| `package.json:4` | `Google Chrome's 193-guide catalog with offline search …` | `208-guide catalog` |
| `package.json:46-59` | keywords | no *required* change (no new categories). Optional discoverability: `built-in-ai`, `pwa`, `webmcp`, `wasm` — the 15 new guides strengthen exactly these themes |
| `locale/en.json:4` | `… dialogs, CSS layout, view transitions, forms, accessibility, performance.` | no counts; the example list is illustrative. Optional refresh to mention the new themes (tabs, carousel, PWA install, prompt API). No change required |
| `locale/ru.json:4` | same, in Russian | same as above |
| `data/skills/modern-web-guidance/SKILL.md:4` | `version 0.0.197` (adaptation header) | `version 1.0.0` |
| `data/skills/modern-web-guidance/SKILL.md:7` | `The catalog lives in this plugin: 193 guides (use-case guides plus broader discipline guides), all Baseline-aware.` | `208 guides (upstream's 203 use-case guides plus the broader discipline guides), all Baseline-aware.` — or drop the number here entirely (the body does not need it and it is the most drift-prone copy) |
| `data/skills/modern-web-guidance/SKILL.md:1-76` | adapted from 0.0.197 | **re-adapt from the 1.0.0 body** (90 lines): upstream added the `legacy-scan` flow and npx/pnpx sections; our adaptation must keep dropping them, keep the data-not-instructions guardrail, and keep mapping search/retrieve/list onto the three tools. The Baseline fallback policy wording is materially unchanged, so `:52`/`:74-75` survive |
| `data/skills/modern-web-guidance/SKILL.md:42` | broader guides list `(html, css, forms, accessibility, performance, security, visual-design)` | verify against the new index; upstream 1.0.0 also names `color`, which is **not** one of our categories — do not add it |
| `data/skills/modern-web-guidance/SKILL.md` "When to use it" bullets | component/form/perf/security topics | optional: add the new subjects (tabs, accordion, carousel, toolbar, navbar, breadcrumbs, sortable table, PWA install, natural interactions) so routing matches the 15 new guides |

## 8. index.js, client.js, lib/

| Place | Current | Should become |
|---|---|---|
| `index.js:23` | `Search Google Chrome's Modern Web Guidance catalog: 193 curated, token-efficient guides covering modern browser` | `208 curated, token-efficient guides` |
| `index.js:42-43` | `LIST_DESCRIPTION` enumerates the 17 categories | set unchanged — **verify only**; regenerate from the index if you touch it at all |
| `index.js:224` | skill routing description `search 193 use-case guides before writing HTML, CSS or client-side JavaScript` | `search 208 guides before writing HTML, CSS or client-side JavaScript`; this is the string quoted at `README.md:86` / RU:85 / ZH:84 — change all four together |
| `index.js:24-26` | feature list (dialogs, popovers, …, WebMCP) | optional: add `PWA install` and the built-in-AI prompt API, both newly represented |
| `index.js:325`, `:299` | `/guidance-stats` description, argument parsing | no counts — **no change** |
| `client.js` (whole file) | panel reads `report.corpus.total`, `corpus.version`, coverage rows from the report; no numeric literals for the corpus | **no change** — the KPI and coverage bars update themselves once the index is refreshed. Its `Guides` / `Подсказок` labels carry no number |
| `lib/*` | no hardcoded corpus counts; everything derives from `data/guides.json` + `data/corpus.json` | **no change**. One check: the npx rewrite regex in `lib/guidance.js` (`CLI_REFERENCE`) must still match the new bodies — the 1.0.0 references keep the exact form `npx -y modern-web-guidance@latest retrieve "id"` (197 of them), so no regex change is expected, but the "no npx in served output" test must be re-run |

## 9. test/*.mjs

| Place | Current | Should become |
|---|---|---|
| `test/guidance.test.mjs:11` | `assert.equal(guides.length, 193)` | `208` |
| `test/guidance.test.mjs:17-30` | 7 smoke queries asserting the top-1 id | numbers unchanged, but **105 guides changed**, so re-verify: all ids still exist (0 removed), the ranking may not. Be ready to update an expectation or a query, and to re-check the same table in README:120-133 |
| `test/plugin.test.mjs:80` | `assert.equal(grouped.total, 193)` | `208` |
| `test/hardening.test.mjs:83-84` | `…list({category: ''}).length, 193` and `(category: null)` | `208` |
| `test/hardening.test.mjs:85` | `…list({category: ' CSS '}).length, 18` | **leave 18** — css is unchanged; add a comment that css is pinned by the corpus, or replace with a lookup from the fixture if you want it to stop being a magic number |
| `test/hardening.test.mjs:94` | `assert.equal(value.total, 193)` | `208` |
| `test/report.test.mjs:14` | fixture `corpus: { version: '2026_10_30-58d055df', snapshotDate: '2026-10-30', total: 193 }` | synthetic fixture: update to the new version/date/208 for realism (not required for green tests) |
| `test/report.test.mjs:141` | `deadGuides: { total: 193 }` | 208 together with `:14` |
| `test/report.test.mjs:151` | `assert.match(text, /Corpus: version 2026_10_30-58d055df, snapshot 2026-10-30, 193 guides/)` | only if you change the fixture at `:14` |
| `test/report.test.mjs:30` | coverage row `{ category: 'css', retrieved: 12, total: 58 }` | **do not touch** — deliberately synthetic, unrelated to the real css count |
| `test/stats.test.mjs:92` | `assert.match(report.text, /Corpus: version 2026_10_30-58d055df/)` | new version from `data/corpus.json`: `2026_11_09-5bcc021b` — **required** |
| `test/stats.test.mjs:112` | `assert.equal(payload.corpus.total, 193)` | `208` |
| `test/telemetry.test.mjs:21`, `:162` | mock `version: '2026_10_30-58d055df'` | synthetic; optional. Update both lines together if you do |
| `test/store.test.mjs`, `test/paths.mjs` | no corpus numbers | no change |

Optional but cheap: one assertion that `data/guides.json.length` equals the number of referenced `.md` files
(and that `prompt-api` is not indexed) — that is the invariant this whole inventory keeps tripping over.

## 10. NOTICE (not in the brief, but it ships in the tarball)

| Place | Current | Should become |
|---|---|---|
| `NOTICE:11-14` | `(version 0.0.197, skill version 2026_10_30-58d055df)` … `the corpus is 193 files for 193 index entries` | `(version 1.0.0, skill version 2026_11_09-5bcc021b)` … `209 files, of which 208 are indexed: data/guides/built-in-ai/prompt-api.md is still a byte-identical duplicate of language-model.md and absent from upstream's index` |
| `NOTICE:16` | `chrome-extensions … (skill version 2026_08_06-8570fe7c)` | unchanged (verified: same `skill-version.txt`, identical `SKILL.md` hash) |
| `NOTICE:23-27` | `the 121 occurrences of npx … across 45 guides become web_guidance_retrieve` | `197 occurrences across 64 guides` |
| `NOTICE:29-31` | `Removed: the upstream modern-web-guidance CLI (search.mjs, modern-web.mjs), the bundled TensorFlow.js MiniLM embedder, the usage-vectors file, and the Google Clearcut telemetry watchdog` | rewrite for 1.0.0: CLI (`modern-web.mjs`, `search.mjs`, `legacy-scan.mjs` + map), the `gen/` vector tables (`query-words.*`, `guide-chunks.*`), and `watchdog/`. The TFJS model existed in 0.0.197, **not** in 1.0.0 — keeping that sentence would describe a different release |

## 11. audit/*.md — historical, do not rewrite

These are dated records (`2026-11-08`, code `0.1.0`) and must stay reproducible. **Decision requested: leave
the numbers, add a snapshot qualifier** (recommended) rather than editing figures:

| File | Corpus claims inside | Recommendation |
|---|---|---|
| `audit/security.md:1`, `:19`, `:34`, `:45`, `:51`, `:243-244` | title `0.1.0`; `121 times in 45/193 guides`; `193 entries`, `17 categories`; upstream `0.0.197` | leave numbers; add at the top: `Historical: audited against the 193-guide / 17-category corpus of 2026-10-30. Not rewritten for the 208-guide upstream v1.0.0 refresh (0.4.0).` |
| `audit/corpus.md:3-5`, `:21`, `:114`, `:141-144`, `:147`, `:149` | audit date 2026-11-08; upstream `0.0.197`; `193 .md in 17 categories`; `~1.5 MB`; TFJS/usage-vectors removal evidence | same one-line qualifier; keep every figure and every hash |
| `audit/bugs.md:1-5`, `:24`, `:67`, `:71`, `:151-152` | date 2026-11-08; `193`; `7/7`, `4/4` test counts | same qualifier |
| `audit/repro/**` (`bugs/01-list-empty-category.mjs:4,23,25`, `02-retrieve-unbounded.mjs:6`, `corpus/refs-check.mjs:23`, the `*.json` result dumps) | hardcoded `193` / `121` assertions | **freeze** — these reproduce pre-hardening behaviour against the corpus of that day. Do not "fix" them to 208; that would falsify the record. Note in the qualifier line that a rerun against a refreshed corpus will mismatch by design |

## 12. Release checklist — 0.4.0 (draft)

**Decide first:** N = 208 (§0.1); changed-guide count = 105 (not 98); whether `prompt-api` stays unshipped
(recommended: yes).

1. **Refresh `data/`** from `.tmp/upstream-diff/mwg-1.0.0.tgz`
   (`.tmp/upstream-diff/pkg100/package/`):
   `gen/guides.json` → `data/guides.json`; `guides/` → `data/guides/` (208 indexed guides; keep the duplicate
   out); `skills/chrome-extensions/` → `data/skills/chrome-extensions/` (identical, copy for completeness);
   write `data/corpus.json` = `{"version":"2026_11_09-5bcc021b","snapshotDate":"2026-11-09"}` (convention:
   the version's own date, as `2026_10_30` did).
2. **Re-adapt** `data/skills/modern-web-guidance/SKILL.md` from the 1.0.0 body (drop `legacy-scan`/npx, keep
   the guardrail and the tool mapping; header `version 1.0.0`).
3. **Docs**, in this order: NOTICE (§10) → package.json (`:3`, `:4`) → index.js (`:23`, `:224`; then the
   README quotes) → README ×3 (§1-3, bottom-up) → PUBLISHING (§4) → market yml (§6) → GLOSSARY/SKILL (§5, §7)
   → test asserts (§9).
4. **Bump** `package.json` 0.3.1 → 0.4.0. No dependency changes, no `files[]` changes (`lib`, `data`, `client.js`
   are already listed).
5. **Local checks** (sandbox here cannot run the whole suite: `node --test` EPERM). Run each file directly:
   `node test/guidance.test.mjs`, `test/plugin.test.mjs`, `test/hardening.test.mjs`, `test/report.test.mjs`,
   `test/stats.test.mjs`, `test/store.test.mjs`, `test/telemetry.test.mjs`; re-derive counts (§0.3); then
   `npm pack --dry-run` (needs approval) and paste the **real** file count / packed / unpacked numbers into
   `PUBLISHING.md:188`.
6. **CI**: push to `main`; `.github/workflows/test.yml` must be green (`npm test` + `npm pack --dry-run`).
7. **Publish — GitHub Actions only.** Actions → *release* → **Run workflow** (`workflow_dispatch`; it is the
   only trigger by design). Optionally first run with `dry_run: true` to build and attach the tarball without
   publishing. Trusted publishing is already configured (OIDC, trusted publisher pinned to this repo +
   `release.yml`, no environment): the workflow runs `npm test`, reads the version, **skips npm if that version
   is already on the registry**, publishes `npm publish --provenance --access public`, polls the registry for
   up to 5 minutes, then packs and attaches `dsh-modern-web-guidance.tgz` to the `v0.4.0` release. The empty
   `NPM_TOKEN` fallback branch stays unused. **Never publish from this machine** — it cannot reach
   `registry.npmjs.org` (ECONNRESET).
8. **After publish:**
   - `npm view dsh-modern-web-guidance version` → `0.4.0`; `npm view … dist.tarball`; `latest` points at it;
     provenance/sigstore statement present on the npm page.
   - Install into a throwaway profile: `dsh plugin --profile <tmp> add dsh-modern-web-guidance` → 3 tools,
     2 skills; `web_guidance_list({})` → `total: 208`, 17 categories; one smoke search; `/guidance-stats --json`
     → `corpus.total: 208`, `corpus.version: 2026_11_09-5bcc021b`; panel KPI shows 208.
   - GitHub release `v0.4.0` carries the stable-named tarball; release notes state upstream v1.0.0, 208 guides,
     15 new, 105 changed, corpus version `2026_11_09-5bcc021b`.
   - Update the PUBLISHING status block (`:14`) and tarball stats (`:188`) in a follow-up commit; update
     `market/awesome-dsh-plugin.yml` (§6) before/with the catalog submission, or as a one-line follow-up PR if
     it is already merged.
   - Static badges in README ×3 are URL-encoded numbers — changing `guides-193` to `guides-208` is the whole
     badge update; the npm and tests badges are dynamic. No icon re-upload (the 512×512 PNG is unchanged).
9. **Rollback:** `npm deprecate dsh-modern-web-guidance@0.4.0 "…"` and ship 0.4.1 — npm unpublish is not a plan.

## 13. Open questions and conflicts to resolve

1. **203 vs 208 (blocking).** Brief says 203; upstream's own README counts 203 *use cases*. Our shipped corpus
   is 208 because we also ship the 5 discipline guides. Publishing 203 in the tagline would be wrong for this
   plugin. Recommendation: publish **208**, and if you want the upstream figure, write it with attribution.
   Related: "use-case guides" in the skill routing description should probably become plain "guides".
2. **98 vs 105 changed guides.** Measured 105 raw / 104 normalised against the 193 shared guides. Release
   notes and `docs/` should use the measured number; confirm where 98 came from before it reaches the release
   text.
3. **Version phrasing in the README** (`0.2.0`/`0.3.0` sentences). Minimal fix is "since 0.2.0" / "the plugin
   adds"; if you prefer the README to stop keeping a version history, drop the numbers entirely. Not blocking.
4. **`prompt-api`.** Still a byte-identical duplicate, still absent from `gen/guides.json`. Recommend keeping
   it unshipped (208 files, clean NOTICE story); shipping it would make 209 and duplicate content in search.
5. **`snapshotDate`.** `2026-11-09` (the date inside the skill version) is consistent with how `2026-10-30`
   was derived; the tag commit is `2026-11-10`. Pick one and keep corpus.json and the report display aligned.
6. **Adjacent, not part of this inventory:** `AGENTS.md:23` says the release workflow runs with "no repository
   secrets", while `release.yml` still declares an `NPM_TOKEN` fallback env (empty today). Worth a one-line
   correction while touching release docs, but it is out of scope for the corpus refresh.
7. **Verify the tarball, not just the clone.** Every number above was read from the published
   `modern-web-guidance@1.0.0` npm tarball (`.tmp/upstream-diff/pkg100`), not from the git clone; the clone was
   used only to quote upstream's README. Re-run §0.3 on the refreshed tree before writing any number into a
   shipped file.
