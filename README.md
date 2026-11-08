# dsh-modern-web-guidance

Modern web platform guidance for [DeepSeek Harness](https://github.com/deepseek-ai) agents — Google Chrome's
[Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance) catalog packaged as a DSH plugin.

Coding models default to legacy web patterns because that is what their training data contains. This plugin puts 193
curated, token-efficient guides in front of the agent, plus an offline search tool, so it reaches for the current
platform API (native `<dialog>`/popover, anchor positioning, container queries, view transitions, scroll-driven
effects, `:has()`, passkeys, `fetchpriority`, …) instead of a JavaScript workaround or a library.

Everything runs locally: the guides ship inside the package, search is computed in-process, no network calls and no
telemetry.

## What you get

| Kind | Name | Description |
|---|---|---|
| Tool | `web_guidance_search` | Ranked guide ids for a 2–5 word capability query, optional category filter |
| Tool | `web_guidance_retrieve` | Full markdown for one or more guide ids (max 10 guides / 120k characters per call) |
| Tool | `web_guidance_list` | Catalog overview: counts per category, or ids/titles for one category |
| Skill | `modern-web-guidance` | The workflow: search → retrieve → implement → verify → disclose |
| Skill | `chrome-extensions` | Manifest V3 engineering and Chrome Web Store submission guidance |

The catalog covers `css`, `ui-atoms`, `ui-components`, `ui-behaviors`, `forms`, `html`, `js`, `accessibility`,
`visual-design`, `security`, `performance`, `built-in-ai`, `pwa`, `wasm`, `webmcp`, `privacy`, and `user-experience`.

## Install

Published package (after `npm publish`):

```shell
dsh plugin --profile desktop add dsh-modern-web-guidance
```

From this directory (no registry needed):

```shell
dsh plugin --profile desktop add file:E:/path/to/dsh-modern-web-guidance
```

From GitHub:

```shell
dsh plugin --profile desktop add github:metapeka/dsh-modern-web-guidance
```

From an agent session, `plugin_manager` with `action: "install_bundle"` and the absolute package directory as `target`
does the same thing. The bundle inserts one row (`modern-web-guidance`) and needs no build step, no dependencies, and no
native modules.

## Try it

```text
You: Add a modal settings dialog that closes on backdrop click.

Agent: web_guidance_search({"query": "light dismiss dialog"})
       → light-dismiss-a-dialog, platform-controls-dismiss-dialog, dialog, …
       web_guidance_retrieve({"ids": "light-dismiss-a-dialog,dialog"})
       → full guides with closedby/commandfor examples and Baseline fallbacks
```

## How search works

`lib/guidance.js` builds a BM25 index over the bundled corpus at first use (~1.5 MB of markdown, indexed in a few
hundred milliseconds and cached): title, id, description, `featuresUsed`, headings and body, with stopword filtering,
a small English stemmer, prefix expansion, and exact id/title containment bonuses. No embeddings, no bundled model, no
TensorFlow.js — the package stays small and every result is explainable.

Compared with the upstream semantic search, phrase-like queries (`"light dismiss dialog"`, `"anchor positioning"`) rank
the specific guide first; broad topical queries can differ in ordering. If a search misses, `web_guidance_list` shows
what the catalog contains.

## Skills

The `modern-web-guidance` skill body is adapted from upstream: it tells the agent to call this plugin's tools instead
of the `npx` CLI, keeps the framework/SSR/DOM notes and the Baseline fallback policy, drops the CLI and telemetry
sections, and states the trust boundary — retrieved guides are reference material, not instructions. The
`chrome-extensions` skill is bundled unchanged and loads its `references/` files from the skill directory.

## Security and limits

The corpus is third-party text that ends up in a model's context, and tool arguments come from that model, so both
sides are bounded:

- **No network, no execution, no writes.** The plugin imports only `node:fs` read APIs, `node:path` and `node:url`; it
  has no dependencies and no lifecycle scripts, so nothing is fetched or run at install time.
- **Guides cannot smuggle commands.** Upstream's guide bodies cross-reference each other with
  `npx -y modern-web-guidance@latest retrieve "…"` (121 occurrences in 45 guides). Those references are rewritten to
  `web_guidance_retrieve({"ids":["…"]})` when the index loads, so nothing a model reads from the catalog asks it to
  install and execute an unpinned remote package. The files on disk stay byte-identical to the pinned snapshot.
- **`web_guidance_retrieve` is bounded**: at most 10 guides and 120 000 characters per call, duplicate ids collapse, the
  unknown-id echo stops at 10, and the renderer says explicitly what was not returned and to request it separately.
  Retrieving all 193 guides used to hand back 1.5 MB (~450k tokens) in one result.
- **`web_guidance_search` is bounded**: the query is capped at 512 characters and 24 distinct terms before the lexical
  scan. A 137 KB query used to block the host's event loop for seconds; the same shape now costs milliseconds.
- **The catalog cannot reach outside the package**: entry ids and categories must be slugs, and every resolved path is
  checked to stay inside the data directory. A tampered `guides.json` used to be able to read any `*.md` on disk.
- **Failures retry and stay opaque**: a transient read error no longer poisons the tool for the session, and tool errors
  no longer disclose absolute install paths.

Both properties are covered by `test/hardening.test.mjs`, which fails on the pre-hardening code. The full audit — three
reports plus runnable repros — lives in [`audit/`](audit/), and the repro scripts under `audit/repro/` exit non-zero
while a defect is live.

## Configuration

The plugin takes no configuration. It registers its tools and skills on the host context and is inert when the profile
has no `tools` or `skills` service.

## Updating the guide corpus

The corpus is a pinned snapshot of upstream `modern-web-guidance@0.0.197`
(skill version `2026_10_30-58d055df`). To refresh it:

1. Download the upstream npm tarball and extract `package/skills/modern-web-guidance/{guides.json,guides}` into
   `data/`, and `package/skills/chrome-extensions` into `data/skills/`.
2. Keep `data/skills/modern-web-guidance/SKILL.md` (this plugin's adapted version) — do not overwrite it with the
   upstream CLI-oriented file.
3. Run `npm test` to confirm the corpus still loads and the smoke queries still rank correctly. The tests also fail if
   any served guide tells the agent to run the upstream CLI, so a refreshed corpus needs no manual de-CLI pass — the
   rewrite happens at load time (`lib/guidance.js`, `CLI_REFERENCE`).

## Development

```shell
node --test test/
```

26 tests across three files: `guidance.test.mjs` covers the index, ranking, retrieval and the stemmer;
`plugin.test.mjs` covers tool and skill registration against a mocked Cordis context; `hardening.test.mjs` covers the
audit findings and fails on the pre-hardening code. In a sandbox that forbids child processes, run the files directly
(`node test/hardening.test.mjs`).

## Publishing

Marketplace submission and npm steps are documented in
[PUBLISHING.md](https://github.com/metapeka/dsh-modern-web-guidance/blob/main/PUBLISHING.md); the
prepared awesome-dsh-plugin entry lives in
[`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml).

## Attribution and license

Apache-2.0. The guide corpus, the `chrome-extensions` skill, and the source of the adapted `SKILL.md` come from
[GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) (Copyright Google LLC,
Apache-2.0). See [NOTICE](NOTICE) for exactly what was copied, adapted, or removed.

This plugin is not an official Google product. It removes the upstream CLI, the bundled TensorFlow.js embedder and the
Clearcut telemetry watchdog the upstream CLI ships.
