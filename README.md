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
| Tool | `web_guidance_retrieve` | Full markdown for one or more guide ids |
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
of the `npx` CLI, keeps the framework/SSR/DOM notes and the Baseline fallback policy, and drops the CLI and telemetry
sections. The `chrome-extensions` skill is bundled unchanged and loads its `references/` files from the skill directory.

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
3. Run `npm test` to confirm the corpus still loads and the smoke queries still rank correctly.

## Development

```shell
node --test test/
```

Tests cover the index, search ranking, retrieval, and plugin registration with a mocked Cordis context.

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
