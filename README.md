<p align="center">
  <img src="icon.png" width="96" height="96" alt="dsh-modern-web-guidance">
</p>

<h1 align="center">dsh-modern-web-guidance</h1>

<p align="center">
  Google Chrome's <a href="https://github.com/GoogleChrome/modern-web-guidance">Modern Web Guidance</a>, offline,<br>
  as a <a href="https://github.com/deepseek-ai">DeepSeek Harness</a> plugin.
</p>

<p align="center">
  208 Baseline-aware guides · 4 tools · 2 skills · zero dependencies · local counters only
</p>

<p align="center">
  <b>English</b> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="package.json"><img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen"></a>
  <a href="#security-and-limits"><img alt="Telemetry" src="https://img.shields.io/badge/telemetry-local--only-brightgreen"></a>
  <a href="https://github.com/metapeka/dsh-modern-web-guidance/actions/workflows/test.yml"><img alt="tests" src="https://github.com/metapeka/dsh-modern-web-guidance/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-modern-web-guidance"><img alt="npm" src="https://img.shields.io/npm/v/dsh-modern-web-guidance"></a>
  <img alt="Guides" src="https://img.shields.io/badge/guides-208-2563eb">
  <img alt="DSH plugin" src="https://img.shields.io/badge/DSH-plugin-0d9488">
  <a href="https://www.npmjs.com/package/dsh-modern-web-guidance"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-modern-web-guidance"></a>
  <a href="https://github.com/metapeka/dsh-modern-web-guidance/releases"><img alt="release" src="https://img.shields.io/github/v/release/metapeka/dsh-modern-web-guidance?label=release"></a>
</p>

<details>
<summary>📑 Contents</summary>

**Start here** · [What you get](#what-you-get) · [Install](#install) · [How to use](#how-to-use) · [Which tool when](#which-tool-when)

**Understand it** · [vs Google's package](#vs-google) · [How search works](#how-search-works) · [Catalog map](#catalog-map) · [Experimental guides](#experimental-guides)

**Operate it** · [Security and limits](#security-and-limits) · [Usage stats](#usage-stats) · [Sidebar panel](#sidebar-panel) · [Configuration](#configuration) · [Updating the corpus](#updating-the-guide-corpus)

**Everything else** · [FAQ](#faq) · [Roadmap](#roadmap) · [Docs map](#docs-map) · [Development](#development) · [Publishing](#publishing) · [License](#attribution-and-license)

</details>

---

Coding models default to legacy web patterns because that is what their training data contains. This plugin puts 208
curated, token-efficient guides in front of the agent, plus an offline search tool, so it reaches for the current
platform API (native `<dialog>`/popover, anchor positioning, container queries, view transitions, scroll-driven
effects, `:has()`, passkeys, `fetchpriority`, …) instead of a JavaScript workaround or a library.

Everything runs locally: the guides ship inside the package, search is computed in-process, and there are no network
calls. Usage counters have existed since 0.2.0, but they never leave the machine — see [Usage stats](#usage-stats).

<a id="what-you-get"></a>

## 🧰 What you get

| Kind | Name | Description |
|---|---|---|
| Tool | `web_guidance_search` | Ranked guide ids for a 2–5 word capability query, optional category filter |
| Tool | `web_guidance_retrieve` | Full markdown for one or more guide ids (max 10 guides / 120k characters per call) |
| Tool | `web_guidance_list` | Catalog overview: counts per category, or ids/titles for one category |
| Tool | `web_guidance_legacy_scan` | Regex marker scan of explicit paths for legacy patterns; reports findings, changes nothing |
| Skill | `modern-web-guidance` | The workflow: search → retrieve → implement → verify → disclose |
| Skill | `chrome-extensions` | Manifest V3 engineering and Chrome Web Store submission guidance |

The scanner is report-only, and it reads code only. `web_guidance_legacy_scan` takes `paths` (1–16 files or
directories, no default target), an optional `rules` list of up to 33 rule ids, and `format: 'summary' | 'json'`; it
reads at most 200 files, 512 kB per file and 8 MB per call, and returns at most 200 findings. A finding is a **code
site**, not a line: hits of one rule on neighbouring lines — the next line, or one blank line later — collapse into a
single finding that carries `lines` and `occurrences`, so a twenty-line legacy block is one finding with a range
instead of twenty findings, and the 200-finding cap counts sites rather than hits. Its allowlist is 18 code
extensions — `.js`, `.jsx`, `.ts`, `.css`, `.html`, `.vue`, `.svelte`, `.astro`, `.json` and their kin — and Markdown is
not one of them: a `.md` or `.mdx` file is reported as skipped, never scanned, because a document that quotes an
anti-pattern is documentation, not legacy code. Dot-directories are never entered: the usual ones (`.git`, `.turbo`,
`.next`, `.cache`) sit in the scanner's own skip list, and any other — `.github`, `.vscode` — comes back as one
`dot-directory` skip instead of being read. It carries 33 rules, 30 of them upstream's; the
[parity note](docs/notes/legacy-scan-parity.md) accounts for what is still missing and for the one real debt.

A workspace can also say what it means by "here". `.scanignore` at its root lists paths a scan must leave out — one
pattern per line, `#` for a comment, `report/` for every directory of that name, `src/app.js` for one file, `*` inside
a single segment, and no negation, no `**`, no `?`. The file is read at the start of every scan; a malformed line is
reported (`Ignored 1 line in .scanignore (line 7: bad pattern)`) and an unreadable one does not stop the scan. It is
not a security boundary: the scanner is already confined to the workspace, so it can only make a scan read less.

```text
# .scanignore — leave the build output and the scraped dumps alone
tmp-deploy/
report/
*.min.js
```

Either way the summary says what it skipped, and why: `Skipped 284 path(s): 282 extension, 2 dot-directory` on this
repository — `path(s)`, not `file(s)`, because a skipped directory is one entry rather than one per file inside it.

The same scan is a human command, `/guidance-scan <paths> [--rules ls-01,ls-13] [--format summary|json]`: it reuses the
tool's scanner, its refusals and its caps, and refuses to run without at least one explicit path. The panel's scan
button is the same operation with `.` already filled in, so it covers every code file in the session workspace and
skips the prose.

The catalog covers `css`, `ui-atoms`, `ui-components`, `ui-behaviors`, `forms`, `html`, `js`, `accessibility`,
`visual-design`, `security`, `performance`, `built-in-ai`, `pwa`, `wasm`, `webmcp`, `privacy`, and `user-experience`.

<a id="install"></a>

## 🚀 Install

Published on npm:

```shell
dsh plugin --profile desktop add dsh-modern-web-guidance
```

From GitHub:

```shell
dsh plugin --profile desktop add github:metapeka/dsh-modern-web-guidance
```

From a local checkout (no registry needed):

```shell
dsh plugin --profile desktop add file:E:/path/to/dsh-modern-web-guidance
```

From an agent session, `plugin_manager` with `action: "install_bundle"` and the absolute package directory as `target`
does the same thing. The bundle inserts one row (`modern-web-guidance`) and needs no build step, no dependencies, and no
native modules.

<a id="how-to-use"></a>

## 🧭 How to use

Nothing has to be wired up: the plugin registers itself, and the `modern-web-guidance` skill tells the agent when to
reach for it. There are three ways to work with it.

<a id="which-tool-when"></a>

### Which tool when

| You want | Call | Comes back |
| --- | --- | --- |
| "how is this done today?" | `web_guidance_search` | ranked guide ids for a 2–5 word capability query, optional category filter |
| "show me the guide" | `web_guidance_retrieve` | full markdown, up to 10 guides or 120 000 characters per call |
| "what is even in here?" | `web_guidance_list` | counts per category, or ids and titles for one category |
| "is the catalog actually being used?" | `/guidance-stats` | the local report as text; `--json` is what the panel reads |
| "will the code I am about to write or review use a legacy pattern?" | `web_guidance_legacy_scan` | findings for the paths you name explicitly, up to 200 per call |
| "do it myself, from the terminal" | `/guidance-scan src/` | the same findings as text; `--format json` gives the machine value, `--rules ls-01,ls-13` narrows the table |

### 1. Just ask for web work (default)

The skill's routing description is "search 208 use-case guides before writing HTML, CSS or client-side JavaScript", so
a normal request is enough — the agent searches, retrieves what it needs, and writes code against the current platform
API instead of a workaround:

```text
You: Add a modal settings dialog that closes on backdrop click.

Agent: web_guidance_search({"query": "light dismiss dialog"})
       → light-dismiss-a-dialog, platform-controls-dismiss-dialog, dialog, …
       web_guidance_retrieve({"ids": "light-dismiss-a-dialog,dialog"})
       → full guides with closedby/commandfor examples and Baseline fallbacks
```

### 2. Ask for it explicitly

Use this when you want the guarantee, or when the agent skipped the lookup on a task that clearly deserves one:

- "check the modern web guidance for how this is done today"
- "look it up in the guides before writing that CSS"
- "verify this is Baseline, and show me the fallback"
- "find the guide for light-dismiss dialogs and follow it"

### 3. Browse the catalog yourself

`web_guidance_list` answers "what is even in here" without spending a retrieval:

```text
web_guidance_list({})                          → 208 guides across 17 categories
web_guidance_list({"category": "css"})         → the 18 CSS guides by id and title
web_guidance_search({"query": "view transition"}) → ranked shortlist before you retrieve
```

Category filters are forgiving (`" CSS "` and `"Css"` mean `css`), and a misspelled category returns the list of real
ones instead of an empty result.

### Typical tasks

| You want | Query the agent can use | Guide it lands on |
|---|---|---|
| A modal that closes on backdrop click | `light dismiss dialog` | `light-dismiss-a-dialog` |
| Keep the page from scrolling under a modal | `prevent page scroll under modal` | `prevent-page-scroll-under-modal-dialog` |
| A table that works on a phone | `responsive data table` | `responsive-table` |
| Light/dark theme switching | `dark mode toggle` | `dark-mode-toggle` |
| Sliding tab indicator without JavaScript | `anchor positioning` | `anchor-positioning-tab-underline` |
| Inline validation that doesn't nag while typing | `form validation after interaction` | `validate-input-after-interaction` |
| Passwordless sign-in | `passkey registration` | `passkey-registration` |
| Faster LCP | `prioritize hero image` | `fetchpriority` guides |
| A Manifest V3 extension | (skill) `chrome-extensions` | extension skill references |

<a id="vs-google"></a>

## 🆚 vs Google's package

This plugin **vendors Google's corpus** — the same 208 guides, byte-identical — and adds the layer
DeepSeek Harness needs: model-facing tools, a sidebar panel and no runtime dependencies. It does not
reimplement their agent, and it deliberately drops the engines that would not survive a plugin's size
and security budget. The honest split:

| | Google `modern-web-guidance` | This plugin |
| --- | --- | --- |
| Shape | npm package: a CLI plus skills, run as `npx -y modern-web-guidance@latest …` | DSH plugin: 4 tools, 2 skills, 2 human commands, a sidebar panel |
| Audience | any agent that can run a shell command | DeepSeek Harness sessions |
| Guide corpus | 208 indexed guides (209 `.md` files, one byte-identical duplicate) | the same 208, byte-identical, snapshot `2026_11_09-5bcc021b` |
| Lookup | precomputed assets in `gen/` — quantized word vectors (`query-words.i8`, 7.47 MB) and chunk embeddings, 9.16 MB together | BM25 built in-process from `guides.json` and the guide bodies: no assets, no model download (measured 29/30 top-1 on a 30-query probe) |
| Runtime dependencies | Node plus the CLI engines shipped in the package | none |
| Network | `npx` fetches the package, then works locally | never — the corpus is inside the package |
| Legacy scan | a 4.99 MB `legacy-scan` engine with a four-step scan → verify → report → modernize workflow | shipped since 0.5.0: a dependency-free regex scanner over 33 rules, 30 of them upstream's, explicit paths only, report only — with `/guidance-scan` as its human command since 0.7.0, and code files only since 0.7.1 |
| Experimental guides | gated inside the CLI | `[experimental]` marker in `web_guidance_search`, warning banner in `web_guidance_retrieve` |
| Usage insight | none | local counters, the `/guidance-stats` report, the `/guidance-scan` command and a panel that maps both |
| Languages | English guides | the same guides; docs in EN/RU/ZH, panel in EN/RU/ZH |
| Size | — | 256 files, 943 kB packed, 2.8 MB unpacked |

What this means in practice: if you work outside DeepSeek Harness, use their package — it is the
reference implementation and it owns the corpus. Inside Harness you want the tools in the model's tool
list, an install with no build step and no network, and a panel that says whether the guides are being
used; that is this plugin.

<a id="how-search-works"></a>

## 🧠 How search works

`lib/guidance.js` builds a BM25 index over the bundled corpus at first use (~1.9 MB of markdown, indexed in a few
hundred milliseconds and cached): title, id, description, `featuresUsed`, headings and body, with stopword filtering,
a small English stemmer, prefix expansion, and exact id/title containment bonuses. No embeddings, no bundled model, no
TensorFlow.js — the package stays small and every result is explainable.

Compared with the upstream semantic search, phrase-like queries (`"light dismiss dialog"`, `"anchor positioning"`) rank
the specific guide first; broad topical queries can differ in ordering. If a search misses, `web_guidance_list` shows
what the catalog contains.

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

<a id="skills"></a>

## 🪄 Skills

The `modern-web-guidance` skill body is adapted from upstream: it tells the agent to call this plugin's tools instead
of the `npx` CLI, keeps the framework/SSR/DOM notes and the Baseline fallback policy, drops the CLI and telemetry
sections, and states the trust boundary — retrieved guides are reference material, not instructions. The
`chrome-extensions` skill is bundled unchanged and loads its `references/` files from the skill directory.

<a id="security-and-limits"></a>

## 🛡 Security and limits

The corpus is third-party text that ends up in a model's context, and tool arguments come from that model, so both
sides are bounded:

- **No network, no execution, one local write.** The plugin imports only local `node:fs`, `node:fs/promises`, `node:path`,
  `node:url` and `node:buffer`; it has no dependencies and no lifecycle scripts, so nothing is fetched or run at install
  time. The only file it writes is its own counters file (see [Usage stats](#usage-stats)).
- **Guides cannot smuggle commands.** Upstream's guide bodies cross-reference each other with
  `npx -y modern-web-guidance@latest retrieve "…"` (197 occurrences in 64 guides). Those references are rewritten to
  `web_guidance_retrieve({"ids":["…"]})` when the index loads, so nothing a model reads from the catalog asks it to
  install and execute an unpinned remote package. The files on disk stay byte-identical to the pinned snapshot.
- **`web_guidance_retrieve` is bounded**: at most 10 guides and 120 000 characters per call, duplicate ids collapse, the
  unknown-id echo stops at 10, and the renderer says explicitly what was not returned and to request it separately.
  Retrieving all 208 guides would hand back 1.9 MB (~475k tokens) in one result.
- **`web_guidance_search` is bounded**: the query is capped at 512 characters and 24 distinct terms before the lexical
  scan. A 137 KB query used to block the host's event loop for seconds; the same shape now costs milliseconds.
- **The scanner reads only what it is given.** `web_guidance_legacy_scan` has no default target: the caller names 1–16
  paths, each must resolve inside the session workspace, and a symlink that escapes it is skipped rather than followed.
  It refuses absolute paths, paths outside the workspace and missing paths (`path-absolute`, `path-outside`,
  `path-missing`), caps the read at 200 files, 512 kB per file and 8 MB per call, and never writes a byte. It also
  reads only code: `.md` and `.mdx` are outside the allowlist, so prose comes back as skipped instead of becoming a
  finding. The human command `/guidance-scan` goes through the same scanner, so it refuses the same paths and applies
  the same caps; it also refuses to run with no path at all, so nothing can walk the whole workspace by accident.
- **The catalog cannot reach outside the package**: entry ids and categories must be slugs, and every resolved path is
  checked to stay inside the data directory. A tampered `guides.json` used to be able to read any `*.md` on disk.
- **Failures retry and stay opaque**: a transient read error no longer poisons the tool for the session, and tool errors
  no longer disclose absolute install paths.

These properties are covered by `test/hardening.test.mjs`, which fails on the pre-hardening code, and by
`test/scan-core.test.mjs` for the scanner's containment and caps. The full audit — three
reports plus runnable repros — lives in [`audit/`](audit/), and the repro scripts under `audit/repro/` exit non-zero
while a defect is live.

<a id="usage-stats"></a>

## 📊 Usage stats

Since 0.2.0 the plugin records what the four tools are actually asked for. The counters are local: no endpoint, no
analytics service, no third-party SDK, and nothing leaves the machine.

The report is a human slash command, not a tool the agent can call:

```text
/guidance-stats                 per-tool totals for the last 7 days
/guidance-stats --days 30       a wider window
/guidance-stats --json          the same report as JSON
/guidance-stats --reset --yes   erase everything
```

`--days N` defaults to 7. What is counted: calls per tool, outcomes (hit, miss, unknown id, list, error), per-day
counts, per-category hit counts, per-guide retrieve counts, and the last 1000 calls with their query text and returned
ids. Misses are the point — a count of misses that cannot be reproduced cannot be fixed.

0.5.0 adds a fourth row (`legacy-scan`) and a findings total to the same report. 0.7.0 keeps the scan detail with it:
the rules and guides the findings pointed at, and the last completed scan (when, files read, findings), which the report
prints as `Most matched rules: …` and `Last scan: …`. That detail is ids and numbers, never a path and never a snippet.
Since 0.10.0 the same detail is also kept **per workspace** — keyed by an id derived from the directory, not
by the directory itself — and the last scan may carry the one thing that is neither an id nor a number: a
**branch label**, read from the workspace's `.git/HEAD` (one hop through a worktree's `gitdir:` pointer,
nothing else, no `git` process) and printed on the `Last scan:` line. A failed read prints nothing at all.
The same release keeps a site key so that "did the fix land" has an answer: eight hex characters of a
hash over a finding's path, rule id and snippet — a hash of a path, never a path, and the snippet itself
is never stored.

Where it lives: the profile's durable storage, the same trust boundary that already holds session logs. Retention
defaults to 90 days, and `--reset --yes` erases it.

Turn it off: set `enabled: false` in the plugin config — no listener is registered and no file is written.

<a id="sidebar-panel"></a>

## 🖥 Sidebar panel

The plugin adds a client half: a guidance icon in the left rail opens **Guidance Insights** in the central area. It
draws the counters `/guidance-stats` prints as a map, and answers four questions in that order:

- **how much, and how well** — total calls, and a hit rate over the calls that could hit (search hits, search misses and
  unknown ids), with the report's own all-calls rate in the tile's tooltip; a `7 d` / `30 d` switch re-reads the window
- **when** — calls per day, one bar per day of the window
- **with what, and how it ended** — calls by tool and by outcome, side by side
- **what the scanner catches** — the last completed scan, the rules that matched most (up to 10) and the guides those
  findings point at; the button below runs the scanner over every code file in the session workspace (Markdown is
  skipped and reported as skipped) and shows that run's result inline — `Scanned 70 files, 85 findings` followed by
  `Skipped 284 (282 extension, 2 dot-directory)` and, when a cap cut the list, the truncation line, so a count is never
  printed without the caveats behind it

Below those, the report's lists: the most frequent queries with hit and miss counts, category coverage against the 208
guides, the queries that found nothing, and the dead guides — listed by id, up to 20.

Refresh re-reads the counters, and the `7 d` / `30 d` switch sends `/guidance-stats --json --days N` to the host. In a
conversation, a scan renders as a table — rule, place, confidence, guide — up to 16 rows and an "and N more" count,
whichever format the call asked for, with the same skip line under it: the summary format prints `Skipped 284 path(s):
282 extension, 2 dot-directory` as prose and the row reads that line back, so JSON and summary answers show the same
caveats. The place column prints the site rather than a line: a single hit stays `path:line`, a collapsed run prints
`path:110-112`, and one that skips a line adds its count — `path:2-4 (2)` — because the range alone would overstate it.
The last-scan line makes the same point in one line — `Last scan: 2026-11-11 · 70 files · 85 findings ·
skipped 284`, the total only, with `· truncated` appended when a cap cut the run — and a state file written before 0.7.3
simply renders shorter rather than claiming nothing was skipped.

The panel is read-only apart from the scan button: it changes no counter, never leaves the machine, and adds no network
calls and no new tools — the same four tools stay exactly four. A scan it starts is counted like any other scan. Paths
and snippets stay out of the panel by design: the panel shows counters, not evidence, and the chat row is where files
and lines appear. `/guidance-stats` remains the text and `--json` version for the terminal and the agent, and
`/guidance-scan` is the text twin of the button.

<a id="configuration"></a>

## ⚙️ Configuration

The plugin needs no configuration to work. It registers its tools and skills on the host context and is inert when the
profile has no `tools` or `skills` service. The one setting is `enabled` on the plugin row: `false` turns the local
counters off, and `/guidance-stats` with them; `/guidance-scan` keeps working, because scanning is not counting (see
[Usage stats](#usage-stats)).

<a id="updating-the-guide-corpus"></a>

## 🔄 Updating the guide corpus

The corpus is a pinned snapshot of upstream `modern-web-guidance@1.0.0`
(skill version `2026_11_09-5bcc021b`). To refresh it:

1. Download the upstream npm tarball. The index lives in `gen/`, not at the package root: copy
   `package/skills/modern-web-guidance/gen/guides.json` to `data/guides.json` and
   `package/skills/modern-web-guidance/guides/` to `data/guides/`. Ship only the guides listed in that index
   (208 of the 209 files; `built-in-ai/prompt-api.md` is a byte-identical duplicate of `language-model.md` and
   is not indexed). Copy `package/skills/chrome-extensions` to `data/skills/`.
2. Keep `data/skills/modern-web-guidance/SKILL.md` (this plugin's adapted version) — do not overwrite it with the
   upstream CLI-oriented file.
3. Run `npm test` to confirm the corpus still loads and the smoke queries still rank correctly. The tests also fail if
   any served guide tells the agent to run the upstream CLI, so a refreshed corpus needs no manual de-CLI pass — the
   rewrite happens at load time (`lib/guidance.js`, `CLI_REFERENCE`).

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

**What can the legacy scanner actually do?** It is a regex marker scan, not a parser: 33 rules matched
line by line, covering 33 of the 208 guides (15.9 %), with no AST, no data-flow analysis and no autofix —
it reports and stops. It reads code, not prose: 18 code extensions, and a `.md` file is skipped with reason
`extension` even when it is named explicitly, because a README that quotes an anti-pattern is
documentation. It makes no parity claim with Chrome's own `legacy-scan`, a 4.99 MB engine with a
bundled TypeScript compiler; this one is a dependency-free pass that can produce false positives and
misses, so treat a finding as a lead to verify, not as a verdict.

**Does anything leave my machine?** No. The corpus is inside the package, search is computed
in-process, and there are no network calls. The usage counters are local files and can be switched off
with `enabled: false` — see [Security and limits](#security-and-limits) and [ADR 0001](docs/adr/0001-local-telemetry.md).

**Google says 203 use cases. Why does this say 208?** Upstream's own count is 203 *use-case* guides;
the index has 208 entries, the extra five being the discipline overviews (`accessibility`, `forms`,
`html`, `performance`, `security`). This plugin ships what the index ships.

**Which DSH versions work?** `engines.dsh` is `>=0.2.0-rc.1 <0.3.0-0` and Node `>=22.19.0`. The tools
work on their own; the panel additionally needs the host's `slots`, `locale` and `remote` services.

<a id="roadmap"></a>

## 🚦 Roadmap

| Release | State | What it is |
| --- | --- | --- |
| 0.4.0 | shipped | the upstream v1.0.0 corpus (208 guides) plus experimental marking |
| 0.4.1 | shipped | docs: navigation, the comparison, the catalog map |
| 0.5.0 | shipped | `legacy-scan` as the fourth tool: 30 regex rules, explicit paths only, report only — `web_guidance_legacy_scan`, with a fourth counter and a findings total in the panel. Design and verdict: [docs/notes/legacy-scan-feasibility.md](docs/notes/legacy-scan-feasibility.md) |
| 0.6.0 | shipped | three more rules (`:host-context()`, text balancing, `select:invalid`) take the table to 33 rules, 30 of them upstream's, and a guide-hash guard keeps a rule honest after a corpus refresh |
| 0.7.0 | shipped | the panel becomes a map rather than a scoreboard — period switch, calls per day, per tool and per outcome, dead guides by id, an honest hit rate, what the scanner catches and a scan button — with `/guidance-scan` as the scanner's human command and a chat table for its findings |
| 0.7.1 | shipped | the scanner stops reading documentation: `.md` and `.mdx` leave the allowlist and are reported as skipped, so a project whose only defect is its prose scans clean |
| 0.7.2 | shipped | the scanner stops entering dot-directories and honours a workspace-root `.scanignore`, and the scan text now itemises what it skipped per reason — `Skipped 279 path(s): 277 extension, 2 dot-directory` |
| 0.7.3 | shipped | the panel stops quoting a scan without its caveats: the button result, the last-scan line and the chat table row all say how many paths were skipped and by which reasons, and whether a cap truncated the list; `lastScan` stores both facts and an older state file upgrades silently |
| 0.8.0 | shipped | a finding becomes one code site instead of one line: a run of one rule's hits on neighbouring lines collapses into a single finding carrying `lines` and `occurrences`, every surface prints the range (`path:110-112`, `path:2-4 (2)` when it skips a line), and the 200-finding cap counts sites — so counts fall because blocks collapsed, not because code got cleaner |
| 0.8.2 | shipped | 0.8.1 shipped a `package.json` carrying a UTF-8 byte-order mark, which the host rejects with `SyntaxError: Unexpected token` even though `require()` and `npm pack` accept it; 0.8.2 strips the mark and adds a byte-level test over the manifest, the entry files and the shipped JSON, so a BOM cannot pass CI again |
| 0.8.1 | shipped | `ls-12` stops advising `display: flex` where that advice breaks code: the line-clamp idiom (`display: -webkit-box` + `-webkit-line-clamp` + `-webkit-box-orient: vertical`) is no longer reported, only the prefixed spellings a clamp cannot serve are — precision bought with recall, and a page that really does use bare `display: -webkit-box` as flexbox now goes unreported |
| 0.9.0 | shipped | a counter explains itself: a ranked rule row reads `ls-17 · medium · 121 findings` with the rule's own sentence underneath, a guide chip puts the catalog's description in its hint, and one caption says the ranked counts are lifetime totals rather than the window the tiles above show — the words come from the host (`renderJson(snapshot, { rules, guides })`), so a missing field costs a caption or a hint, never a row |
| 0.10.0 | shipped | the counters say whose numbers they are, when each scan fired, and whether a site is still there: scan counters are partitioned per workspace, with a chip and a switcher in the panel and `--workspace`/`--all` on the command; the last scan carries `; branch main`, read from one fixed `.git/HEAD`; and a 20-deep scan history plus a hash-only site comparison print `Since the scan of …: 3 no longer present, 82 still open, 1 new` — or `not comparable` with the reason, never three zeros |

The working plan for what comes after these releases — readable counters, per-workspace attribution,
scan history and per-finding control — lives in [docs/ROADMAP.md](docs/ROADMAP.md), together with the
contract and the decisions behind each phase.

Deliberately **not** planned: shipping upstream's 9.16 MB embedding tables, or its 4.99 MB
`legacy-scan` engine with a bundled TypeScript compiler. Both would break "zero runtime dependencies,
no network, no code generation" for a gain the lexical index does not show.

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
| [`docs/notes/legacy-scan-feasibility.md`](docs/notes/legacy-scan-feasibility.md) | you want the analysis behind `legacy-scan`: what upstream's engine does, what a regex scan can match, and the verdict |

<a id="development"></a>

## 🧑‍💻 Development

```shell
npm test
```

`npm test` runs 373 tests across seventeen files: `guidance.test.mjs` covers the index, ranking, retrieval and the stemmer;
`plugin.test.mjs` mounts the plugin against a fake Cordis context; `hardening.test.mjs` guards the security invariants;
`report.test.mjs`, `stats.test.mjs`, `store.test.mjs` and `telemetry.test.mjs` cover the counter pipeline and its 0.7.0
scan fields; `scan-core.test.mjs`, `scan-rules.test.mjs` and `scan-tool.test.mjs` cover the scanner's containment, its
rule table and the tool contract, `scan.test.mjs` is the end-to-end scan, `scan-ignore.test.mjs` holds the
`.scanignore` grammar and the dot-directory rule to their spec, and `scan-command.test.mjs` holds
`/guidance-scan` to the same refusals and the same values; `scan-guides.test.mjs` checks the guide hashes the rule table
points at, `client-locales.test.mjs` keeps the panel's three dictionaries in sync, `branch-label.test.mjs` covers the
four `.git/HEAD` shapes and every way the read stays silent, and `site-identity.test.mjs` pins the site hash and every
comparison guard. In a sandbox that forbids child processes, run the files directly (`node test/hardening.test.mjs`).

<a id="publishing"></a>

## 📦 Publishing

Marketplace submission and npm steps are documented in [PUBLISHING.md](PUBLISHING.md); the prepared awesome-dsh-plugin
entry lives in [`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml).

<a id="attribution-and-license"></a>

## ⚖️ Attribution and license

Apache-2.0. The guide corpus, the `chrome-extensions` skill, and the source of the adapted `SKILL.md` come from
[GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) (Copyright Google LLC,
Apache-2.0). See [NOTICE](NOTICE) for exactly what was copied, adapted, or removed.

This plugin is not an official Google product. It removes the upstream CLI (`modern-web.mjs`, `search.mjs`,
`legacy-scan.mjs`), the precomputed semantic-search tables under `gen/` and the Clearcut telemetry watchdog the
upstream CLI ships (0.x packages bundled a TensorFlow.js MiniLM model instead of those tables).
