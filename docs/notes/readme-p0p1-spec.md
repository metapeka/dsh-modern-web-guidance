# README navigation: P0 + P1 spec (release 0.4.1 docs pass)

Source of truth for the three READMEs. The English text below is final: `README.md` takes it
verbatim, `README.ru.md` and `README.zh.md` translate the prose but keep **every heading anchor, link
target, table shape, tool name, id and command unchanged**.

## Goals

1. A reader lands on the page and finds their question in one screen (contents + section emoji).
2. The first question every visitor has — "how is this different from Google's own package?" — is
   answered with a table, not with marketing.
3. The catalog stops being an opaque "208 guides": category counts and the experimental subset are one
   click away inside `<details>`.

## Non-negotiable rules

1. **Stable anchors.** Every `##` section — and the one `###` subsection, `which-tool-when` — carries an
   explicit anchor line directly above it; the emoji rule below applies to `##` headings only:
   `<a id="install"></a>` followed by `## 🚀 Install`. Existing ids must not change —
   `what-you-get`, `install`, `how-to-use`, `how-search-works`, `skills`, `security-and-limits`,
   `usage-stats`, `sidebar-panel`, `configuration`, `updating-the-guide-corpus`, `development`,
   `publishing`, `attribution-and-license`. New ids: `which-tool-when`, `vs-google`, `catalog-map`,
   `experimental-guides`, `faq`, `roadmap`, `docs-map`.
2. **One emoji per `##` heading**, from this fixed set — never invent another, never put emoji in
   bullets:

   | Section | Emoji |
   | --- | --- |
   | What you get | 🧰 |
   | Install | 🚀 |
   | How to use | 🧭 |
   | vs Google's package | 🆚 |
   | How search works | 🧠 |
   | Catalog map | 🗺 |
   | Experimental guides | 🧪 |
   | Skills | 🪄 |
   | Security and limits | 🛡 |
   | Usage stats | 📊 |
   | Sidebar panel | 🖥 |
   | Configuration | ⚙️ |
   | Updating the guide corpus | 🔄 |
   | FAQ | ❓ |
   | Roadmap | 🚦 |
   | Docs map | 📚 |
   | Development | 🧑‍💻 |
   | Publishing | 📦 |
   | Attribution and license | ⚖️ |

3. **Keep what exists.** Do not delete, reorder or reword existing paragraphs, tables or code blocks
   beyond the edits this spec lists. The only allowed edits to existing text are the four called out at
   the end ("Small edits to existing text").
4. **No new claims.** Numbers in this spec are measured; do not round them differently or add new
   ones.
5. **`<details>` for anything long** (contents, catalog map, experimental list) so the first screen
   stays readable.

## 1. Badges: add two

After the existing `Guides` and `DSH plugin` image badges, add:

```html
  <a href="https://www.npmjs.com/package/dsh-modern-web-guidance"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-modern-web-guidance"></a>
  <a href="https://github.com/metapeka/dsh-modern-web-guidance/releases"><img alt="release" src="https://img.shields.io/github/v/release/metapeka/dsh-modern-web-guidance?label=release"></a>
```

## 2. Contents block

Directly after the closing `</p>` of the badge row and before the existing `---` + intro paragraph,
insert:

```markdown
<details>
<summary>📑 Contents</summary>

**Start here** · [What you get](#what-you-get) · [Install](#install) · [How to use](#how-to-use) · [Which tool when](#which-tool-when)

**Understand it** · [vs Google's package](#vs-google) · [How search works](#how-search-works) · [Catalog map](#catalog-map) · [Experimental guides](#experimental-guides)

**Operate it** · [Security and limits](#security-and-limits) · [Usage stats](#usage-stats) · [Sidebar panel](#sidebar-panel) · [Configuration](#configuration) · [Updating the corpus](#updating-the-guide-corpus)

**Everything else** · [FAQ](#faq) · [Roadmap](#roadmap) · [Docs map](#docs-map) · [Development](#development) · [Publishing](#publishing) · [License](#attribution-and-license)

</details>
```

## 3. `### Which tool when` — inside "How to use"

Insert as the first subsection of `## How to use`, before `### 1. Just ask for web work (default)`.
It is an `###`, so it carries the anchor `which-tool-when` and **no emoji** (only `##` headings get
one).

```markdown
<a id="which-tool-when"></a>

### Which tool when

| You want | Call | Comes back |
| --- | --- | --- |
| "how is this done today?" | `web_guidance_search` | ranked guide ids for a 2–5 word capability query, optional category filter |
| "show me the guide" | `web_guidance_retrieve` | full markdown, up to 10 guides or 120 000 characters per call |
| "what is even in here?" | `web_guidance_list` | counts per category, or ids and titles for one category |
| "is the catalog actually being used?" | `/guidance-stats` | the local report as text; `--json` is what the panel reads |
```

## 4. `## 🆚 vs Google's package` — new, after "How to use"

Insert after the `### Typical tasks` subsection (i.e. after the last bullet list of "How to use") and
before `## How search works`.

```markdown
<a id="vs-google"></a>

## 🆚 vs Google's package

This plugin **vendors Google's corpus** — the same 208 guides, byte-identical — and adds the layer
DeepSeek Harness needs: model-facing tools, a sidebar panel and no runtime dependencies. It does not
reimplement their agent, and it deliberately drops the engines that would not survive a plugin's size
and security budget. The honest split:

| | Google `modern-web-guidance` | This plugin |
| --- | --- | --- |
| Shape | npm package: a CLI plus skills, run as `npx -y modern-web-guidance@latest …` | DSH plugin: 3 tools, 2 skills, a sidebar panel |
| Audience | any agent that can run a shell command | DeepSeek Harness sessions |
| Guide corpus | 208 indexed guides (209 `.md` files, one byte-identical duplicate) | the same 208, byte-identical, snapshot `2026_11_09-5bcc021b` |
| Lookup | precomputed assets in `gen/` — quantized word vectors (`query-words.i8`, 7.47 MB) and chunk embeddings, 9.16 MB together | BM25 built in-process from `guides.json` and the guide bodies: no assets, no model download (measured 29/30 top-1 on a 30-query probe) |
| Runtime dependencies | Node plus the CLI engines shipped in the package | none |
| Network | `npx` fetches the package, then works locally | never — the corpus is inside the package |
| Legacy scan | a 4.99 MB `legacy-scan` engine with a four-step scan → verify → report → modernize workflow | not shipped; planned as a dependency-free, report-only regex scanner in 0.5.0 |
| Experimental guides | gated inside the CLI | `[experimental]` marker in `web_guidance_search`, warning banner in `web_guidance_retrieve` |
| Usage insight | none | local counters, `/guidance-stats`, and the sidebar panel |
| Languages | English guides | the same guides; docs in EN/RU/ZH, panel in EN/RU/ZH |
| Size | — | 253 files, 842 kB packed, 2.4 MB unpacked |

What this means in practice: if you work outside DeepSeek Harness, use their package — it is the
reference implementation and it owns the corpus. Inside Harness you want the tools in the model's tool
list, an install with no build step and no network, and a panel that says whether the guides are being
used; that is this plugin.
```

## 5. `## 🗺 Catalog map` — new, after "How search works"

```markdown
<a id="catalog-map"></a>

## 🗺 Catalog map

Everything is local, so the catalog is only as useful as the agent's ability to find the right guide.
`web_guidance_list` prints these counts at runtime; this is what they look like at snapshot
`2026_11_09-5bcc021b`.

<details>
<summary>Counts per category (208 guides, 17 categories)</summary>

| Category | Guides | Category | Guides |
| --- | --- | --- | --- |
| `ui-behaviors` | 40 | `html` | 8 |
| `performance` | 26 | `js` | 5 |
| `ui-components` | 22 | `accessibility` | 4 |
| `visual-design` | 22 | `built-in-ai` | 4 |
| `forms` | 19 | `user-experience` | 3 |
| `css` | 18 | `webmcp` | 3 |
| `security` | 17 | `pwa` | 2 |
| `ui-atoms` | 13 | `privacy` · `wasm` | 1 · 1 |
| | | **total** | **208** |

</details>
```

## 6. `## 🧪 Experimental guides` — new, right after "Catalog map"

```markdown
<a id="experimental-guides"></a>

## 🧪 Experimental guides

Eighteen of the 208 guides describe platform features that are not safe to assume: eight sit behind an
Origin Trial in Chrome, and ten are volatile in a single engine. Upstream flags them in its index; this
plugin surfaces the flag where the agent will actually see it:

- `web_guidance_search` appends `[experimental]` to the hit;
- `web_guidance_retrieve` opens the guide with a `> [!WARNING]` banner naming the reason;
- the guide body itself is untouched — byte-identical to upstream — and the banner counts against the
  120 000-character budget, not against the 10-guide limit.

<details>
<summary>The 18 flagged guides</summary>

**Origin Trial (8)** — the feature ships behind a trial token: `verify-email-ownership`,
`apply-webgl-shaders`, `export-html-media-from-canvas`, `expose-canvas-content-to-browser-features`,
`interactive-content-in-3d-scenes`, `agentic-forms`, `agentic-javascript-tools`, `webmcp`.

**Volatile in one engine (10)** — one engine implements it, or the API is still moving:
`language-detection`, `language-model`, `summarizer`, `translator`, `out-of-order-html-streaming`,
`client-side-encryption`, `digital-signatures`, `restrict-outbound-connections`, `2d-panning`,
`custom-text-decorations`.

</details>

Treat a flagged guide as "the shape of the solution, not a guarantee". Feature-detect what it
describes, and tell the user which part is behind a flag before shipping it.
```

## 7. `## ❓ FAQ` — new, after "Updating the guide corpus"

```markdown
<a id="faq"></a>

## ❓ FAQ

**The plugin is installed but I see nothing.** The bundle inserts one row (`modern-web-guidance`) and
needs no build step. Restart DSH after `dsh plugin --profile desktop add …`; the tools appear in the
next session's tool list, and the panel as an icon in the left rail.

**Search returns nothing useful.** Queries are 2–5 words describing a capability ("light dismiss
dialog", "view transition", "container query"), not sentences. If a query still misses, call
`web_guidance_list` for the category overview and retrieve by id from there.

**Why did a result say `[experimental]`?** The guide's platform feature is behind an Origin Trial or
is volatile in one engine — see [Experimental guides](#experimental-guides). The guide is still the
right shape; feature-detect it before shipping.

**Does anything leave my machine?** No. The corpus is inside the package, search is computed
in-process, and there are no network calls. The usage counters are local files and can be switched off
with `enabled: false` — see [Security and limits](#security-and-limits) and [ADR 0001](docs/adr/0001-local-telemetry.md).

**Google says 203 use cases. Why does this say 208?** Upstream's own count is 203 *use-case* guides;
the index has 208 entries, the extra five being the discipline overviews (`accessibility`, `forms`,
`html`, `performance`, `security`). This plugin ships what the index ships.

**Which DSH versions work?** `engines.dsh` is `>=0.2.0-rc.1 <0.3.0-0` and Node `>=22.19.0`. The tools
work on their own; the panel additionally needs the host's `slots`, `locale` and `remote` services.
```

## 8. `## 🚦 Roadmap` — new, right after FAQ

```markdown
<a id="roadmap"></a>

## 🚦 Roadmap

| Release | State | What it is |
| --- | --- | --- |
| 0.4.0 | shipped | the upstream v1.0.0 corpus (208 guides) plus experimental marking |
| 0.4.1 | this pass | docs: navigation, the comparison, the catalog map |
| 0.5.0 | next | `legacy-scan` as a fourth tool: 30–35 regex rules ported from upstream's engine, explicit paths only, report-only output. Design and verdict: [docs/notes/legacy-scan-feasibility.md](docs/notes/legacy-scan-feasibility.md) |

Deliberately **not** planned: shipping upstream's 9.16 MB embedding tables, or its 4.99 MB
`legacy-scan` engine with a bundled TypeScript compiler. Both would break "zero runtime dependencies,
no network, no code generation" for a gain the lexical index does not show.
```

## 9. `## 📚 Docs map` — new, right after Roadmap

```markdown
<a id="docs-map"></a>

## 📚 Docs map

| Document | Read it when |
| --- | --- |
| [`docs/README.md`](docs/README.md) | you want the full map of this repository |
| [`PUBLISHING.md`](PUBLISHING.md) | you are releasing: npm rules, trusted publishing, the release ritual |
| [`docs/releases/README.md`](docs/releases/README.md) | you are writing release notes — the house style lives here |
| [`AGENTS.md`](AGENTS.md) | you are an agent working in this repo: CI, client half, conventions |
| [`GLOSSARY.md`](GLOSSARY.md) | a term in this codebase is unclear |
| [`NOTICE`](NOTICE) | attribution: what came from upstream and what was left out, and why |
| [`audit/`](audit) | you want the 0.1.x security, corpus and bug audits as they were written |
| [`docs/adr/`](docs/adr) | you want the decisions: local telemetry, and what followed |
| [`docs/notes/`](docs/notes) | you want the research behind a release (upstream diffs, feasibility studies, plans) |
```

## 10. Small edits to existing text

1. **Test count.** The "Development" section currently says `68 tests across seven files: …`. The panel
   gains a test file, so the number drifts. Replace the count and the file list with a count-free
   sentence that still says what is covered:

   ```markdown
   `npm test` runs the suite: `guidance.test.mjs` covers the index, ranking, retrieval and the stemmer;
   `plugin.test.mjs` mounts the plugin against a fake Cordis context; `hardening.test.mjs` guards the
   security invariants; `report.test.mjs`, `stats.test.mjs`, `store.test.mjs` and `telemetry.test.mjs`
   cover the counter pipeline; `client-locales.test.mjs` keeps the panel's three dictionaries in sync.
   ```

2. **Panel languages.** Every mention of the panel being "EN + RU" becomes "EN, RU and ZH" (the
   Chinese dictionary lands in the same pass).

3. **Corpus totals stay as they are**: 208 guides, 1 952 778 B, ~475k tokens, 197 cross-references in
   64 guides. Do not restate them in the new sections.

4. **Anchor duplication check.** After editing, `python .tmp/check-readme.py` (written by the Lead)
   verifies that every link target in the contents block exists as an `<a id=…>` in the same file.

## 11. What each file owner does

| File | Owner | Notes |
| --- | --- | --- |
| `README.md` | `docs-release` | apply sections 1–10 verbatim |
| `README.ru.md` | `panel-docs` | same structure, Russian prose, ids/commands/tool names unchanged |
| `README.zh.md` | `ci-docs` | same structure, Chinese prose (简体中文), ids/commands/tool names unchanged |
| `docs/README.md` | Lead | the repository map the new Docs map points at |
| `client.js`, `locale/zh.json`, `test/client-locales.test.mjs` | `panel-client` | the Chinese panel dictionary |
