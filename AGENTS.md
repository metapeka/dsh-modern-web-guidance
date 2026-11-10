# dsh-modern-web-guidance

## Agent skills

### Issue tracker

GitHub Issues in `metapeka/dsh-modern-web-guidance`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root, with ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Product surface

Four model-facing tools: `web_guidance_search`, `web_guidance_retrieve` and `web_guidance_list`
(`lib/guidance.js`), plus `web_guidance_legacy_scan` (`lib/scan.js`). Two skills
(`modern-web-guidance`, `chrome-extensions`), one human command (`/guidance-stats`) and one panel.
The scanner is the only tool that reads caller-named files, and it is confined to the session
workspace; everything else reads the bundled corpus.

## The legacy scanner

`lib/scan.js` walks explicit relative paths and matches rules line by line; `lib/scan-rules.js` is the
rule table (`ls-01` … `ls-33`, each with a `guideId`, a `confidence` and one imperative `message`).
It is a marker scanner, not an AST analyzer: 33 rules over 33 of the 208 guides, with no parity claim
for upstream's engine; report-only — it never writes, spawns a process or reaches the network. The
full interface is `docs/notes/legacy-scan-contract.md`.

- **A new rule goes into `lib/scan-rules.js`, never into the scanner**: a `guideId` that exists in
  `data/guides.json`, a `confidence`, a message naming the modern replacement, and a test in
  `test/scan-rules.test.mjs` (plus `test/scan.test.mjs` when the matching behaviour itself changes).
- **Caps are the scanner's, not the caller's**: `SCAN_LIMITS` fixes 16 paths, 200 files, 512 KiB per
  file, 8 MiB total, 200 findings, 100 skipped entries and 160-character snippets; a `limits`
  argument may only tighten them.
- **Paths are relative and stay inside the session workspace**: absolute paths are refused, every
  named path is `realpath`-checked against the session cwd, and a symlink met while walking that
  leaves the workspace is skipped rather than followed.
- **A rule upstream has and we do not ship has a reason, not a to-do**: the absent and half-covered
  rules, and the one real debt (no guide-hash invalidation), are recorded in
  `docs/notes/legacy-scan-parity.md`; read it before adding a rule to "close the gap".

## CI

`.github/workflows/test.yml` is the source of truth: every push to `main` and every PR runs `npm test` plus `npm pack --dry-run`, and `npm test` on its own reproduces it locally.

A change to the tests, the `test` script or `package.json` `files` must update that workflow in the same PR.

`.github/workflows/release.yml` publishes: manual dispatch only, no repository secrets (OIDC trusted
publishing), skips versions already on the registry, and attaches the tarball to the `v<version>`
release. Never make it run on push.

Release notes are written by hand before the dispatch, one file per release:
`docs/releases/v<version>.md`. The workflow publishes that file as the release body (or edits an
existing release) and only falls back to `--generate-notes` when it is missing. The house style —
sections, emoji, the rules a note must satisfy — is `docs/releases/README.md`; follow it instead of
inventing a layout per release.

## Client half

`client.js` is browser code shipped as-is: one file, no bundler, no new dependencies. It registers a
lazy factory through `window.__ModuleLoader__.load({ id: <package name>, factory(require) })`, takes
React from `require('react')` and nothing else from the host, and declares its Cordis services in the
returned `inject` list — `slots`, `locale`, `remote` and `remote.commands` are all required for the rail
entry and the panel's data call (`ctx.remote.commands.execute`). The panel registers
`sidebar.panellist` id `guidance` and the keyed `main` slot with the same key; there is no other wiring.
See `docs/notes/client-panel-spike.md` for the verified contract.

Panel strings live in three dictionaries — `EN`, `RU` and `ZH` — registered in one
`ctx.locale.register(NS, { en, ru, zh })` call. `test/client-locales.test.mjs` enforces key, order and
placeholder parity between them and the shape of `locale/*.json`, so a new string must land in all three
languages in the same commit.
