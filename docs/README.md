# Repository map

Where everything lives, and the one file to open for each kind of question. The README is the front
door for users; this page is the front door for anyone working on the plugin.

## Start here

| Document | What it is | Read it when |
| --- | --- | --- |
| [README.md](../README.md) | the user-facing page: what the tools do, install, usage, the comparison with Google's package | you want to use the plugin |
| [README.ru.md](../README.ru.md) · [README.zh.md](../README.zh.md) | the same page in Russian and Chinese | you read those languages first |
| [AGENTS.md](../AGENTS.md) | the working agreements: CI gate, client-half contract, release ritual, docs conventions | you are an agent or a contributor touching code |
| [GLOSSARY.md](../GLOSSARY.md) | the vocabulary this codebase uses — guide, entry, hit, miss, snapshot, panel | a term in the code or the docs is unclear |
| [NOTICE](../NOTICE) | attribution: what comes from upstream, what was deliberately left out and why | you need the licence story or the corpus provenance |

## Shipping

| Document | What it is | Read it when |
| --- | --- | --- |
| [PUBLISHING.md](../PUBLISHING.md) | the npm rules, trusted publishing, the release ritual, where the plugin is listed | you are releasing, or the publish path misbehaves |
| [docs/releases/README.md](releases/README.md) | the release-notes house style: sections, emoji, rules, checklist | you are writing notes for the version you are about to ship |
| [docs/releases/v0.4.0.md](releases/v0.4.0.md) | the notes as published, one file per release | you want the shape of a finished note |
| [.github/workflows/release.yml](../.github/workflows/release.yml) | manual dispatch, OIDC publish, tarball asset, curated notes | the release did something unexpected |
| [.github/workflows/test.yml](../.github/workflows/test.yml) | the CI gate: `npm test` plus `npm pack --dry-run` on every push | a test fails only in CI |

## Product code

| Path | What it is | Touch it when |
| --- | --- | --- |
| `index.js` | the plugin entry: four tools, two skills, one command, the search description | a tool's name, description or arguments change |
| `lib/guidance.js` | index reading, BM25 ranking, retrieval, experimental annotation, limits | search quality, ranking or the retrieve rendering changes |
| `lib/scan.js` · `lib/scan-rules.js` | the marker scanner (explicit paths, containment, caps) and its 30-rule table | the fourth tool's behaviour or a rule changes |
| `lib/telemetry.js` · `lib/report.js` · `lib/store.js` | the local usage counters, the report shape, the on-disk store | the counters or `/guidance-stats` change |
| `client.js` | the whole client half, shipped as-is: rail icon, panel, EN/RU/ZH dictionaries, bridge call | the panel or its translations change |
| `locale/*.json` | the plugin-list card in each language | the plugin's title or description changes |
| `data/guides.json` · `data/guides/**` · `data/corpus.json` | the vendored corpus: the index, the markdown, the snapshot id | the corpus is refreshed |
| `data/skills/**` | the two skills as shipped (`SKILL.md` + references) | the skill text or its version changes |
| `cordis.patch.yml` | the bundle patch that inserts the plugin row | the plugin id or config defaults change |
| `test/*.mjs` | the suite, one file per area | anything above changes — the gate is `npm test` |

## Research and history

| Document | What it is | Read it when |
| --- | --- | --- |
| [audit/security.md](../audit/security.md) · [audit/corpus.md](../audit/corpus.md) · [audit/bugs.md](../audit/bugs.md) | the 0.1.x audits as they were written — historical, never rewritten | you want the reasoning behind an invariant |
| [docs/adr/](adr/) | architecture decision records, starting with [0001 — local telemetry](adr/0001-local-telemetry.md) | you are about to reverse a decision |
| [docs/notes/upstream-v1.0.0-diff.md](notes/upstream-v1.0.0-diff.md) | every difference between upstream v1.0.0 and our previous snapshot | you are checking a corpus claim |
| [docs/notes/upstream-v1.0.0-code-impact.md](notes/upstream-v1.0.0-code-impact.md) · [docs/notes/upstream-v1.0.0-surfaces.md](notes/upstream-v1.0.0-surfaces.md) | what the upstream release does and does not force us to change | you are planning a refresh |
| [docs/notes/upstream-v1.0.0-plan.md](notes/upstream-v1.0.0-plan.md) | the 0.4.0 plan with its decisions and what was refused | you wonder why something is missing |
| [docs/notes/legacy-scan-feasibility.md](notes/legacy-scan-feasibility.md) | the 0.5.0 `legacy-scan` verdict, rule set and security boundary | you are wondering what the scanner does not do |
| [docs/notes/legacy-scan-contract.md](notes/legacy-scan-contract.md) | the interface the 0.5.0 workstreams coded against: rule shape, scan result, error codes, caps | you are adding a rule or changing the scanner's contract |
| [docs/notes/client-panel-spike.md](notes/client-panel-spike.md) | the spike that settled the panel's slot and bridge design | you are changing how the panel mounts |
| [docs/notes/readme-p0p1-spec.md](notes/readme-p0p1-spec.md) | the source text behind the README's navigation and comparison sections | you edit the READMEs |
| [docs/agents/](agents/) | the agent-facing conventions: issue tracker, triage labels, domain docs | you are wiring this repo into an agent workflow |
| [audit/repro/](../audit/repro) | the repro fixtures kept from the security audit | you are re-running the hardening proof |

## Where to change what

- **Refresh the corpus** — copy `gen/guides.json` into `data/guides.json`, mirror the guide tree into
  `data/guides/`, update `data/corpus.json`, then re-derive the numbers in the three READMEs and
  `NOTICE`. The long form of this ritual is in [PUBLISHING.md](../PUBLISHING.md) and the measured
  numbers live in [docs/notes/upstream-v1.0.0-surfaces.md](notes/upstream-v1.0.0-surfaces.md).
- **Change a tool** — `index.js` for the schema and description, `lib/guidance.js` for behaviour,
  `test/plugin.test.mjs` and `test/guidance.test.mjs` for the guard.
- **Add or change a legacy-scan rule** — `lib/scan-rules.js` only (the scanner takes the table as
  data); the contract, caps and error codes are in
  [docs/notes/legacy-scan-contract.md](notes/legacy-scan-contract.md), and
  `test/scan-rules.test.mjs` guards the table.
- **Change the panel** — `client.js` only; it is shipped as a single file with no build step, and
  `test/client-locales.test.mjs` keeps its dictionaries in sync.
- **Ship a release** — write `docs/releases/v<version>.md`, bump `package.json`, push, then dispatch
  `release.yml` by hand. Never publish on push.
