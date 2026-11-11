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
(`modern-web-guidance`, `chrome-extensions`), four human commands (`/guidance-stats`, `/guidance-scan`,
`/guidance-suppress`, `/guidance-scanignore`) and one panel.
The scanner is the only tool that reads caller-named files, and it is confined to the session
workspace; everything else reads the bundled corpus, except the counters' branch label, which reads
exactly one fixed file, `<workspace>/.git/HEAD` ([ADR-0002](docs/adr/0002-branch-labels.md)).

## The legacy scanner

`lib/scan.js` walks explicit relative paths and matches rules line by line; `lib/scan-rules.js` is the
rule table (`ls-01` … `ls-33`, each with a `guideId`, a `confidence` and one imperative `message`).
It is a marker scanner, not an AST analyzer: 33 rules over 33 of the 208 guides, with no parity claim
for upstream's engine; report-only — it never writes, spawns a process or reaches the network. The
full interface is `docs/notes/legacy-scan-contract.md`.

- **A new rule goes into `lib/scan-rules.js`, never into the scanner**: a `guideId` that exists in
  `data/guides.json`, a `confidence`, a message naming the modern replacement, and a test in
  `test/scan-rules.test.mjs` (plus `test/scan.test.mjs` when the matching behaviour itself changes).
- **A finding is a code site, not a line**: hits of one rule in one file collapse into one finding while the
  next hit's line is at most `RUN_LINE_GAP = 2` after the previous one — the next line, or one blank line
  later. Every finding carries `lines` and `occurrences` (a single hit is `lines: [n]`, `occurrences: 1`),
  while `line`, `column`, `snippet` and `message` describe the **first** hit, so a rule's message must never
  be reworded to mention a range, and `maxFindings` counts findings, not hits. The run boundaries are
  covered by `test/scan.test.mjs`; the spec is `docs/notes/legacy-scan-contract.md`.
- **Caps are the scanner's, not the caller's**: `SCAN_LIMITS` fixes 16 paths, 200 files, 512 KiB per
  file, 8 MiB total, 200 findings, 100 skipped entries and 160-character snippets; a `limits`
  argument may only tighten them.
- **Paths are relative and stay inside the session workspace**: absolute paths are refused, every
  named path is `realpath`-checked against the session cwd, and a symlink met while walking that
  leaves the workspace is skipped rather than followed.
- **A rule upstream has and we do not ship has a reason, not a to-do**: the absent and half-covered
  rules, and the one caveat that survived the 0.6.0 guard (a guide hash proves the guide changed, not
  that a rule's message still describes its replacement), are recorded in
  `docs/notes/legacy-scan-parity.md`; read it before adding a rule to "close the gap".
- **The command is the tool's second entry point, so there is one of everything**: `/guidance-scan` in
  `index.js` calls the same `runScanRequest` and renders with the same `renderScan`, so a change to the
  scanner, its refusals or its text reaches both surfaces; `test/scan-command.test.mjs` fails if the
  two ever drift.
- **Dot-directories are never walked, and `.scanignore` is the only way to exclude an artifacts
  directory**: a directory whose name starts with `.` is skipped as `dot-directory` (one entry per
  directory, even when a path names it explicitly), so `tmp-deploy/`, `report/` and friends are excluded
  by a workspace-root `.scanignore` — never by a new entry in `SKIP_DIRECTORIES`, which is for names every
  project shares. The ignore file is **not** a security boundary: the scanner is already confined to the
  workspace, so it can only make a scan read less. Both rules are specified in
  `docs/notes/legacy-scan-contract.md` and covered by `test/scan-ignore.test.mjs`.
- **A suppressed finding is muted, not fixed, and the scan still counts it.** A suppression names one code
  site by `siteId` — never a line, never a whole rule — and lives in a workspace-root file that only an
  explicit human command touches, after a visible confirmation ([ADR-0003](docs/adr/0003-write-surface.md)).
  Since 0.12.0 the file is **reviewable and shrinkable**: `/guidance-suppress --review` joins it against the
  current scan and reports how many entries matched nothing (`unused` is `null`, never `0` or `[]`, when the
  scan was incomplete), and `/guidance-suppress --remove <siteId>` plans first, then deletes exactly one
  entry on a second, distinct confirmation ([ADR-0004](docs/adr/0004-suppression-removal.md)). A removal is
  **not a fix**: it un-mutes a finding and moves no counter, so the two numbers still cannot be confused.
  The scan keeps the finding, reports it separately (`suppressed: N`) by rule, and never counts a suppressed
  site as resolved: "fixed" and "muted" must never look the same number. The scanner itself still writes
  nothing; the confirmed command is the only writer in the product.
  The file's shape and its reporting rules are `docs/notes/suppression-contract.md`.

## Telemetry and attribution

`lib/telemetry.js` counts every call, then partitions **scan** counters per workspace (0.10.0). One
`stats.json` per DSH profile serves every project, so an unattributed number is the defect this section
exists to prevent.

- **Partition additively; never bump `version`.** `normalizeState()` reads any other version as an empty
  document and the next flush atomically overwrites the file, so a bump is silent total data loss. The
  `workspaces` subtree and the `_unattributed` bucket are how the old counters survive; a test pins both,
  and `recent` entries keep their exact shape.
- **A workspace is a name and an id, never a path.** `workspaceId()` is FNV-1a 32-bit over the resolved
  path — eight lowercase hex characters, pinned by a golden value because it keys every bucket — and the
  display name is the basename. `index.js` resolves the path and strips it before `record()` sees it;
  `lib/telemetry.js` stays filesystem-free. The exact shapes are
  `docs/notes/workspace-attribution-contract.md`.
- **The report refuses to guess.** The default workspace comes from the invocation's session header; with
  no header the report aggregates *and says so*, because `process.cwd()` is not the user's project. An
  unknown selector is an error listing every `name (id)`, a duplicated name is refused rather than guessed,
  and an absent bucket draws empty instead of borrowing the aggregate.
- **Guidance counters stay profile-wide.** They measure the bundled corpus, not a project; a workspace
  dimension would make "hit rate" mean nothing. Scan counters are the only partitioned ones.
- **Branch is a label, not a key, and it comes from one fixed file.** A completed scan may read exactly
  `<workspace>/.git/HEAD` — one hop through a worktree's `gitdir:` pointer, no enumeration, no second git
  file, no subprocess — and stores `lastScan.branch` as `{kind:'branch',name}` or
  `{kind:'detached',sha}`, never as a counter key. A failed read is a missing label: no error, no guess,
  no "unknown" token. The scope, the four shapes and the tests are
  [ADR-0002](docs/adr/0002-branch-labels.md).
- **History is bounded, and a comparison is allowed to refuse.** A completed scan appends to a 20-deep
  `scanHistory` and to `scanByDay`, and replaces the site baseline only when it was complete, untruncated
  and non-empty; `ruleFirstSeen`/`ruleLastSeen` are lifetime and only move outward. "Resolved" means
  *absent from the current scan but present in the baseline* — a claim about exactly two scans, never about
  a fix — and seven guard tokens exist so a comparison prints "not comparable" instead of a number. A site
  is `siteId()`, FNV-1a over `path + ruleId + snippet`: the hash is stored, the path and the snippet never
  are, and a line number is never part of it. Unless the token is `no-baseline`, a refusal must not replace
  what the last comparable scan said. The spec is
  [docs/notes/scan-history-contract.md](docs/notes/scan-history-contract.md).
- **A direction is derived, never stored** (0.13.0, F-1): the report reads the ring and states
  `findings per 100 files` for the newest comparable half versus the half before it, or refuses with a
  bare token — `too-few-scans`, `branch-changed`, `no-files` (naming the half), `aggregate`. Rates
  rather than counts, because the walk's caps make raw counts incomparable; a truncated scan is a
  **hole, not a zero**, so it is dropped before the halves are cut. Refusing is the normal outcome here:
  a slope needs a sample, one tree and a denominator, and the report says which one is missing instead
  of printing a number that looks like progress. `likelihood` is not a word this product uses: the sign
  of `delta` is the whole claim, and no surface colours it as a recovery. The deriving rules are §16 of
  `docs/notes/scan-history-contract.md`.
- **The ten is a sample, not a census** (0.13.0, F-2): the ring keeps each scan's ten most-numerous rules,
  so a rule's absence from an entry means it was not in that scan's top ten — never that it stopped
  firing. A per-rule slope is therefore computed only over the entries that carry the rule, the halves are
  trimmed to the same number of carrying entries (summing whole halves can invert the direction), and the
  four tokens say what happened to the *sample*: `too-few-samples` (under three carrying entries),
  `entered-sample`, `left-sample`, `not-sampled`. `left-sample` is not `resolved` and `entered-sample` is
  not `new`; those belong to sites. The sample is printed beside every claim because it is the claim's
  honesty, the floor decides whether to compare while the sample says how much was compared, an aggregate
  carries `slope: null` with F-1's line giving the reason, and the frozen two-member row shape keeps two
  members — the slope is enrichment for described rows, not snapshot data. §17 of
  `docs/notes/scan-history-contract.md`.

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
`sidebar.panellist` id `guidance` and the keyed `main` slot with the same key; a third registration owns
the chat side — the keyed `tool.call.toolview` slot under `web_guidance_legacy_scan`, which renders one
scan call as a table (rule, place, confidence, guide) and leaves the generic card on every other tool.
The panel holds no filesystem authority: every one of its actions is either a command line the host runs or
a copy of data it already received.
The scan button asks for `/guidance-scan . --format json`. Phase C adds the two writes ADR-0003 licenses
([ADR-0003](docs/adr/0003-write-surface.md)): one suppression entry, `/guidance-suppress <siteId> --dry-run`
then the same line without the flag, and one `.scanignore` line,
`/guidance-scanignore <pattern> --dry-run` then the same line without the flag. Each writes only after the
plan is shown and a second, distinct confirmation is given — so a scan or a render never writes, and a single
click never writes. C-4's "copy as JSON" adds no third path: it copies the envelope the panel already holds,
never a new host call and never a file.
See `docs/notes/client-panel-spike.md` for the verified contract.

Panel strings live in three dictionaries — `EN`, `RU` and `ZH` — registered in one
`ctx.locale.register(NS, { en, ru, zh })` call. `test/client-locales.test.mjs` enforces key, order and
placeholder parity between them and the shape of `locale/*.json`, so a new string must land in all three
languages in the same commit.

- **Both scan caveats are on screen, on all three surfaces, and a stale state file renders shorter**
  (0.7.3): the button result (`scan.skipped`, `scan.skippedMore`), the last-scan line (`scanner.skipped`,
  `scanner.cut`) and the chat tool row all say how many paths the walk skipped and whether a cap truncated
  the list. Truncation reuses `scan.truncated`; there is no fifth string. Skip **reason tokens stay raw and
  untranslated** — `dot-directory` in EN, RU and ZH alike, like a rule id — and they are never mapped
  through the locale dictionaries. A `stats.json` written before 0.7.3 has no `skipped`/`truncated`, so the
  line must render *shorter*: never invent a `skipped 0` and never show `truncated` because the field was
  absent. The stored map keeps the top four reasons, so its sum can be smaller than the scan's own
  `skippedTotal` — that is the contract, not a bug to "fix" in the panel.
- **A counter explains itself, and a lifetime total says so** (0.9.0): a ranked rule row carries its id,
  its raw confidence token and a count that names its unit (`121 findings`, through the existing
  `finding` plurals), with the rule's own `message` clamped to two lines underneath — and no second line
  at all when the host sends none. A guide chip keeps `id (count)` visible and puts the catalog
  `description` in its `title`. While `scanCountsScope` is `lifetime`, one caption (`scanner.lifetime`)
  says the ranked counts are not the `{days}` window the tiles above show — and since E-1 that caption also
  names the day the counting began (`scanner.lifetimeSince`, fed by `scanCountsSince`), because a total
  with no origin cannot be read. The origin is the selected bucket's own start, never the document's, and
  legacy root counters have none: absence is silent, so an undated document renders the 0.9.0 caption
  character for character, and `normalizeState` preserves a missing `since` as `null` instead of stamping
  `now` on load. **The words come from the
  host**: `renderJson(snapshot, { rules, guides })` joins them from `lib/scan-rules.js` and the catalog,
  so the panel invents nothing, and the chat row reads the same per-finding `message`/`snippet` as
  `title`s rather than adding a line per row. Version skew costs a caption or a hint, never a row — a
  host without those fields renders exactly the terse ids and counts it always did. Confidence tokens
  stay raw like rule ids: there are no `confidence.*` keys, and the locale test rejects them on purpose.
- **The panel names whose numbers it is showing** (0.10.0): a chip and a native `<select>` sit between the
  title and the 7/30 switch, rendering `workspace.label` from the report's `workspace` and listing every
  entry of `workspaces` plus `workspace.all`. Selecting one re-runs
  `/guidance-stats --json --workspace <id>` through the same bridge as refresh, so the panel still owns no
  second data path — it wrote nothing through 0.10.0, and the only write it may ever request is one
  confirmed command (ADR-0003). An empty or `_unattributed` name renders
  `workspace.unattributed`, never a blank chip; two entries sharing a name get an id suffix (`app · aaaa`).
  A host that sends no `workspaces` renders no chip and no switcher — the 0.9.0 panel exactly.
- **The panel answers "when" and "did it land", and says so when it cannot** (0.10.0, phase B): a
  comparison line under the last scan, a five-row Recent scans block, and a last-seen date on each ranked
  rule row — each rendered only when the host sends it, so a pre-B document renders the 0.9.0 panel. A
  guard token prints raw and untranslated, `not comparable (fewer-files)`, and a diff without numbers
  prints no numbers at all — never three zeros. There is no chart: the per-rule × per-day matrix was
  refused on its size budget, so `scanSeries` carries whole scans, not rules, and the panel draws no
  sparkline.
- **Every record can be reviewed, and an unanswered action says so** (0.12.0, phase E): the scanner
  section carries one `.scanignore` sentence (`scanner.ignoreUsage`) built from the **two integers** the
  host persists, never from the pattern text — the per-line rows are transient and the panel does not
  draw them; a document without the counts renders shorter rather than "0 matched nothing". The copy
  action is bounded (`COPY_TIMEOUT_MS`): a clipboard write parked by an unfocused window never settles, so
  the label races the write and a fourth state says the clipboard did not answer. The label never claims
  success while the write is in flight, a late success does not flip it back, and "did not answer" is not
  "refused" — a parked promise was never refused. The mute plan opens with the same panel-owned lead-in
  the ignore plan has (`scan.muteNote`), so the pair is symmetric, and it repeats the invariant: a mute
  hides one site and the scan still counts it as suppressed. The suppression list is shown as a file, not
  as a verdict: one row per entry with the file's own date and reason, and `matched` in three states —
  `true`/`false` only when the scan was complete, `null` (unknown) whenever it could not prove absence,
  which renders as its own marker and never as "unused". Every row carries its own Remove under the same
  two-click discipline; the plan text is the host's, verbatim and English, and the host sends no rule id
  because the file keeps only a one-way hash — a row that invents one is a bug, not a nicety. A host that
  predates `items` falls back to listing `unused` ids, and that fallback is tested as its own state. Host
  plan sentences stay verbatim and English; the panel never parses or translates them. **The three
  verdicts are three pills, not one grey word**: a live-host pass measured `совпало` / `не совпало` /
  `неизвестно` sharing one transparent style, so the tri-state existed in the data and in the caption but
  not on the row — the verdict now has its own tag (`S.mutedTag` is for other chips), and `unknown` must
  stay visually distinct from `unused`, not merely spelled differently. **A write keeps the reader's
  place**: the refresh after a confirmed write restores `scrollTop` and brings the outcome into view,
  because the measured behaviour was a jump to the top with the answer below the fold, which reads as a
  failure to the person who just confirmed. One write block, chosen by `write.target`, never two.
- **Every panel action leaves a command row in the conversation, and that is the accepted price** (0.12.0):
  `ctx.remote.commands.execute` renders each `/guidance-stats --format json` and
  `/guidance-scan . --format json` line the panel runs as a truncated JSON block in the transcript, so the
  panel spends one visible row on mount and one per scan. The only ways to reduce it are a cached envelope
  (stale numbers on open) or a second data path (forbidden), so the calls stay — and the copy action, which
  calls nothing, adds no row.
