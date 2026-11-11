# Roadmap: from counters to a workbench

Status: **active**. This page is the working plan — what is wrong with the panel today, what each
phase fixes, and the decisions already taken so a later reader does not relitigate them.

The `🚦 Roadmap` table in [README.md](../README.md) is the *shipped* history: one row per release.
This page is the *unshipped* work: four phases, in order, with the contract for each. When a phase
ships it becomes a row in that table and a file in [docs/releases/](releases/), and its section here
moves to "Done".

## Phase status

| Phase | State | Proposed release |
| --- | --- | --- |
| **A — Readable** | released — 0.9.0 published to npm and GitHub | 0.9.0 |
| **D — Attributable** | released — 0.10.0 published to npm and GitHub | 0.10.0 |
| **B — Over time** | released — 0.10.0 published to npm and GitHub | 0.10.0 |
| **C — Under control** | released — 0.11.0 published to npm and GitHub | 0.11.0 |
| **E — Auditable** | scoped in [docs/notes/phase-e-scope.md](notes/phase-e-scope.md); E-1/E-2/E-3 in flight | 0.12.0 |

Update this table in the same commit that changes a phase's state. A phase is "in progress" only when
its contract below is fixed; it is "done" when its acceptance list passes and its release note exists.

## The diagnosis, measured

A live panel (0.8.2, RU) rendered this:

```text
СРАБОТАВШИЕ ПРАВИЛА
ls-17  121
ls-32  42
ls-01  38
...
ПОДСКАЗКИ, КОТОРЫЕ СТОИТ ОТКРЫТЬ
html (121)  improve-text-layout-and-legibility (42)  ...
```

Four things are wrong with those six lines, and none of them is cosmetic:

1. **`ls-17` is an opaque id.** The rule's own sentence — *"Build the DOM with createElement/append
   instead of `document.write()`…"* — exists in [`lib/scan-rules.js`](../lib/scan-rules.js), next to
   its `confidence` and its `guideId`. It never leaves the host:
   [`renderJson`](../lib/report.js) emits `{ ruleId, count }` only.
2. **`121` has no unit.** It is 121 *findings* (code sites), accumulated over the plugin's lifetime —
   not 121 files, not 121 scans, and **not** the 7-day window the header switch is showing.
   `scanRules` is explicitly "lifetime finding counts, never pruned"
   ([`lib/telemetry.js`](../lib/telemetry.js) `record()`), so the two numbers on one screen answer
   different questions.
3. **The same word means two numbers.** The KPI says **647 замечаний** (lifetime findings) while the
   scanner line says **85 замечаний** (last scan). Both are honest, neither is labelled.
4. **Nothing says which project these are.** One `stats.json` per *profile*
   ([`lib/store.js`](../lib/store.js) `defaultStatePath()`), and `telemetry.record()` is called
   without a workspace, so every project and every branch feeds the same counters. The `cwd` *is*
   available at both entry points — it is simply dropped.

## Guardrails

Every phase keeps these. A phase that wants to break one needs an ADR first.

- Zero runtime dependencies, no network, no code generation.
- The scanner stays **report-only** and never writes into the user's project. Any suppression file is
  a separate, opt-in, explicitly created local file — and the "panel is read-only" sentence in
  [AGENTS.md](../AGENTS.md) must be amended *in the same change* if a phase adds a write action.
- Counters are best-effort: a broken counter must never change what a tool returns, and a corrupt
  state document must degrade to "no data", never to an exception.
- New user-visible strings land in **EN, RU and ZH in the same commit**; `test/client-locales.test.mjs`
  enforces key order and placeholder parity.
- Raw vocabulary stays raw: rule ids (`ls-17`), skip reasons (`dot-directory`) and confidence tokens
  (`high`/`medium`/`low`) are values a reader matches against a scan, not UI words.
- `npm test` is the gate; a change to the tests, the `test` script or `package.json` `files` updates
  [.github/workflows/test.yml](../.github/workflows/test.yml) in the same PR.

---

## Phase A — Readable (no new state)

**Goal:** every number on the panel says what it is, in what unit, and which rule it belongs to —
without the reader opening a source file. Purely a widening of the data that already exists.

### Contract: `/guidance-stats --json` gains three additive fields

```jsonc
{
  "periodDays": 7,
  "scanCountsScope": "lifetime",          // NEW: topRules/topScanGuides ignore periodDays
  "topRules": [
    {
      "ruleId": "ls-17",
      "count": 121,
      "message": "Build the DOM with createElement/append instead of document.write(), which discards the parsed document.",  // NEW
      "confidence": "medium",             // NEW
      "guideId": "html"                   // NEW
    }
  ],
  "topScanGuides": [
    {
      "guideId": "html",
      "count": 121,
      "description": "Action-oriented guidelines for modern HTML architecture, …"  // NEW
    }
  ]
}
```

Rules of the contract:

- **Additive only.** A consumer that reads `ruleId`/`count` is unaffected. `renderJson(snapshot)`
  called with no options must produce today's output byte for byte, so an older host and a newer
  panel never disagree about the shape they both understand.
- **A row is never dropped because its metadata is missing.** A `ruleId` the current table no longer
  knows keeps its row with `message: ''`, `confidence: ''`, `guideId: null`. The count is still true
  even when the explanation is gone (a renamed or retired rule).
- **`scanCountsScope` is a statement of fact, not a preference.** It says `lifetime`, because that is
  what the counters are. Phase B turns this into real per-window data; until then the client prints
  it, so the period switch cannot silently imply something false.

### Client work

- **Rule row** becomes: id · confidence · `121 findings` · the rule's sentence on a second line
  (clamped, full text in `title`; the line is omitted when the message is empty).
- **Guide chips** keep `html (121)` visible and put the guide's `description` in `title`.
- **One caption** under "Rules that matched" while the scope is lifetime:
  `scanner.lifetime` = EN "Lifetime totals, not the {days}-day window" (+ RU + ZH).
- **Chat tool row**: the finding payload already carries `message` and `snippet` and the row throws
  both away. They become `title`s on the rule and place cells. No second text line per finding.

### Acceptance

- `npm test` green, including the new `test/report.test.mjs` cases: enrichment, unknown rule id,
  unknown guide id, `scanCountsScope`, and byte-identical no-options output.
- A panel on a live host renders `ls-17 · medium · 121 findings` plus the rule sentence, and the
  lifetime caption, with the dictionaries in three languages still in parity.
- Version skew: a 0.8.x host plus a new client renders the old terse rows and **no** caption — a
  missing fact costs a caption, never a row.

**Not in A:** per-window numbers, history, fixes vs unfixed, any write action.

**State:** the code and its tests are in the working tree — `lib/report.js`, `index.js`, `client.js` and
three test files — and the suite is green (257 tests, 256 pass, 1 pre-existing symlink skip; run it as
`NODE_OPTIONS=--test-isolation=none npm test` in a sandbox where `node --test` cannot spawn). The
contract is recorded in [legacy-scan-contract.md](notes/legacy-scan-contract.md), the panel behaviour in
[client-panel-spike.md](notes/client-panel-spike.md) and the agreement in [AGENTS.md](../AGENTS.md).

**Released locally as 0.9.0.** `package.json` moved to 0.9.0, `docs/releases/v0.9.0.md` is written in
house style, the three READMEs carry the 0.9.0 row and the corrected test count (245 → 257) plus a
re-measured packed size (913 kB), and `PUBLISHING.md` follows. **Nothing was pushed and no workflow was
dispatched**, so the `shipped` wording in the README tables and the npm listing become true only at that
dispatch — a separate, explicit step.

---

## Phase D — Attributable (whose numbers are these?)

*Ordered second because A is cheap and D decides whether the numbers can be trusted at all. Nothing
in B or C is worth building on a dataset that silently mixes projects.*

**Goal:** the panel always states which workspace a figure belongs to, and lets the reader switch
between workspaces without leaving it.

**Interface:** [docs/notes/workspace-attribution-contract.md](notes/workspace-attribution-contract.md) is
the authoritative shape — state layout, `workspaceId`, `classifyCall`, `record`, `snapshot`, the command
flags, the JSON keys and the client behaviour. The three workstreams code against it, not against each
other's reading of this page.

### What is true today

`defaultStatePath()` resolves to `<profile>/storage/modern-web-guidance/stats.json`: **one document
per profile**, shared by every workspace and every branch. `telemetry.record({ at, tool, ...entry })`
carries no workspace, so the information is not merely hidden — it was never stored.

### Verified mechanics

Measured against the tree; the full sheet with citations is
[docs/notes/workspace-scoping-facts.md](notes/workspace-scoping-facts.md).

- **The scan value already carries its workspace.** `runScanRequest` returns
  `{ format, cwd, ...result }` ([`index.js`](../index.js)), so `classifyCall` can attribute a scan
  from `payload.cwd` with no new plumbing and no dependency on the host's event shape. The same value
  reaches the recorder from both the tool and `/guidance-scan`.
- **The `tools/result` listener is not a source of truth for the session.** Both test fakes raise the
  event with `{ name, arguments }` only, so whether the real `exec` carries `agent.session.header` is
  *not* determined by this repository. The design must not depend on it — and, because of the point
  above, it does not.
- **A command handler can resolve the workspace** through `commandCwd(invocation)`, which
  `/guidance-scan` already uses; whether every real invocation carries the header is asserted in a
  comment rather than observed, so a missing workspace must degrade to an explicit "all workspaces",
  never to `process.cwd()` posing as the project.
- **One telemetry instance, one store, fixed at construction.** A file-per-workspace layout is a
  call-site change in several places; a map inside the single document is not.
- **Only scans are workspace-scoped.** A search query and a retrieved guide belong to the corpus, not
  to a directory. The numbers that genuinely differ per project are the scan ones — findings, rules,
  guides, skip reasons, last scan.

A version bump is the one part of this phase that can destroy data, and the repository already has the
right precedent for avoiding it; see D-3.

### Options considered

| # | Shape | For | Against |
| --- | --- | --- | --- |
| 1 | One state file per workspace (`workspaces/<id>/stats.json`) | isolation; deleting a project's counters is deleting a folder | many files; a global view needs an aggregation pass; more IO paths to keep atomic |
| 2 | **One document, `workspaces` as a map** (chosen) | one atomic write, one migration, a global view is a sum in memory; the `store.load/save` contract is untouched | the document grows with the number of workspaces |
| 3 | Tag records with a workspace, keep counters global | smallest diff | cannot answer "this project's rule counts" — the ring is capped at 1000 and pruned at 90 days |

### Decision: D-1 — scan counters are partitioned by workspace, inside the existing document

- **The document stays `version: 1`.** Partitioning is additive, exactly like the 0.6.0 scan fields: a
  `workspaces: { '<id>': { scanRules, scanGuides, lastScan } }` subtree beside today's root counters.
  Keeping the version is not cosmetic — `normalizeState()` returns an *empty* document for any other
  version, so a bump would destroy the very counters it was meant to organise (see D-3).
- **Only scan-scoped numbers move into a bucket.** `scanRules`, `scanGuides`, `lastScan` and — in phase
  B — scan history are per workspace. Guidance counters (calls, hits, misses, retrieved guides,
  coverage) stay profile-wide, because they measure the corpus, and a corpus is not a directory. The
  report therefore labels its two halves: the scan block names its workspace, the corpus block says it
  is global.
- **`<id>` is a short hash of `realpath(cwd)`**, the same normalisation the scanner already uses for
  containment. The bucket stores `name` (the basename); the full path is stored only when the user opts
  in, so the counters document does not gain a filesystem map by default. Two projects sharing a
  basename stay distinct by id; **a moved or renamed directory is a new realpath and therefore a new
  workspace** — see open question 2.
- `classifyCall()` emits `workspace` from `payload.cwd`; `snapshot({ days, workspace })` selects one
  bucket and `'all'` sums them all.

### Decision: D-2 — a branch is a label, not a key

Switching branches does not change the question "what legacy patterns does this project contain", and
a branch name is not a stable identity (detached HEAD, rebase, deletion, worktrees). Therefore:

- the branch is recorded **per scan** and shown on the scan history entry and the last-scan line;
- lifetime rule counts stay per workspace;
- a branch filter is a *view* over scan history (phase B), never a fourth counter bucket.

If per-branch totals are genuinely wanted later, that is a new decision: it multiplies the state
document and needs its own migration.

> **Status of the branch label: decided, and narrowed on the way.** ADR-0002
> ([docs/adr/0002-branch-labels.md](adr/0002-branch-labels.md)) accepted a read of exactly
> `<workspace>/.git/HEAD`, once per completed scan: one `gitdir:` hop when `.git` is a file (a worktree),
> no enumeration, no second git file, no ref resolution, no subprocess, both files clamped at 1 KiB. It
> answers the four shapes the mechanics throw at it — directory, worktree file, detached, unborn — and
> makes every other shape **silence rather than a label**. The label lives on `lastScan.branch`, either
> `{ kind: 'branch', name }` or `{ kind: 'detached', sha }`, and it renders on the last-scan line only.
>
> What it costs: `AGENTS.md`'s read-surface sentence gains one named exception, and the three READMEs'
> "ids and numbers, never a path" sentence gains one clause. What it does not cost: no path is stored, the
> workspace stays a name and an id, and **the panel's workspace chip stays workspace-only** — a chip
> outlives a scan, so it would keep advertising a branch after `git switch`.
>
> The fallback is corrected too: a failed read is a **missing** label, not an "unknown" one. A token
> printed on every non-git project would be noise shaped like data.

### Decision: D-3 — partition additively; never bump the version

`normalizeState()` treats any other `version` as "no state", returns an empty document, and the next
flush atomically overwrites the file — so a bump is silent, total data loss, and it is already proven
by a test. The live profile holds real counters (647 findings on the screen that started this page).

D-1 therefore keeps `version: 1` and adds the `workspaces` subtree, following the repository's own
precedent for additive state. Counters that predate partitioning stay at the root and are surfaced
through a synthetic `_unattributed` bucket (display name "Before workspace scoping") in the switcher,
so nothing is hidden and nothing is deleted. If a later phase genuinely needs a version bump, the
migration runs *before* the version check and ships with a test that a populated `version: 1` document
survives it — that invariant is worth a test on its own, independent of this phase.

### Client work

- **Workspace chip in the panel header, always visible:** name · branch when known. No number on the
  panel is allowed to be unattributed while this chip is absent. The full path appears only when the
  opt-in is enabled — the default is a name, not a directory listing.
- **Switcher:** "this workspace", every known workspace (with last-scan date and its own counts), and
  an "all workspaces" aggregate row. Selecting one re-renders the same sections; nothing is invented.
- **Command parity:** `/guidance-stats --workspace <name|path>` and `--all`; the panel calls the
  command with the flag, so one implementation keeps serving both surfaces.
- **JSON parity:** the report names its own workspace (`workspace: { id, name, path, branch }`) and
  lists known ones for the switcher.

### Acceptance

- A session in project A and a session in project B record into disjoint buckets; each panel shows its
  own workspace's numbers and names it.
- A pre-D `stats.json` upgrades without losing a single counter, and the unattributed bucket appears.
- `/guidance-stats --json` without a selector behaves predictably: default = the current session's
  workspace, never a silent mix.

### Delivered in 0.10.0

Built against [workspace-attribution-contract.md](notes/workspace-attribution-contract.md), which holds the
exact shapes; this is the summary and the list of places where reality differed from the design above.

- **State:** an additive `workspaces` subtree, `version` still **1**, one bucket
  `{ name, since, scanRules, scanGuides, lastScan }` per workspace. A 0.9.0 document loads with every
  counter and its last scan intact; the root counters surface as `_unattributed`. `recent` entries are
  byte-for-byte unchanged.
- **Identity:** `workspaceId()` is FNV-1a 32-bit over the resolved path — eight lowercase hex characters,
  pinned by a golden value because it keys every bucket. The display name is the basename. **No path is
  stored.**
- **Attribution:** `classifyCall()` carries the raw `payload.cwd` as `workspacePath`; `index.js` resolves
  it (realpath → basename → id), then strips it, so a path never reaches the state document. A bucket is
  never pruned, only its `lastScan` can expire.
- **Report:** `/guidance-stats [--days N] [--json] [--workspace <name|id|path>] [--all] [--reset --yes]`.
  The default is the session workspace from the invocation header; an invocation without one aggregates
  **and says so**, because `process.cwd()` is never used on the report path. An unknown selector is an
  error listing every `name (id)`, a duplicate name is refused rather than guessed, and an absent bucket
  draws empty instead of borrowing the aggregate. The text report names what it shows:
  `Workspace: app (91a3a510)`.
- **JSON:** `workspace: { id, name } | null` and `workspaces: [{ id, name, findings, rules, lastScanAt }]`,
  emitted only when the snapshot carries them, so a hand-built older snapshot still renders unchanged.
- **Panel:** a chip and a native switcher between the title and the 7/30 switch; selecting one re-runs
  `/guidance-stats --json --workspace <id>` through the existing bridge. Four locale keys in EN/RU/ZH. No
  `workspaces` in the report means no chip and no switcher — exactly the 0.9.0 panel.

**Where this differs from the design above, and why:**

- **`branch` landed after this phase, not inside it.** ADR-0002 accepted the one-file `HEAD` read, so the
  label now rides on `lastScan.branch` and prints on the last-scan line; the panel's chip still names only
  the workspace. Acceptance bullet 1 is therefore met **per workspace**, and "per branch" remains what D-2
  said it is — a *view over scan history* (B-2), never a fourth counter bucket.
- **`path` is neither stored nor emitted** (D-6): name plus id only, and two checkouts sharing a name are
  told apart by the id suffix the panel appends (`app · aaaa`).
- **The `_unattributed` label is the client's**, not the host's: the host sends an empty name and the panel
  renders `workspace.unattributed`; the text report prints the raw id.

---

## Phase B — Over time (when did it fire, and did we fix it?)

**Goal:** answer "when" and "did the fix land" without turning the scanner into a stateful linter.

Precondition: phase D, because a timeline per workspace is meaningless while workspaces share a file.

**Interface:** [docs/notes/scan-history-contract.md](notes/scan-history-contract.md) fixes the shapes —
`scanByDay` and `ruleFirstSeen`/`ruleLastSeen` per bucket, a 20-deep `scanHistory`, and B-3's `siteId`
(FNV-1a over path + rule id + snippet, **hash only, never a line number**) with a `lastSites` baseline and a
`scanDiff`. Its two open questions are answered here: the path hash stays, because eight bytes of derived
data are not a path and the READMEs will say so; and the recent-scans block stays in the text report,
because "when" is the question and the panel is not always open.

- **B-1 — per-day scan counters.** `scanByDay` next to the existing `byDay`, so a rule gets a
  sparkline and "first seen / last seen / trend". Today only `lastScan` survives, and it is
  overwritten by every scan.
- **B-2 — scan history.** The ring already stores one entry per call with `files` and `findings` but
  no rule breakdown. Add `rules`/counts and `workspace`/`branch` to the entry, then render
  "scan of 2026-11-10 21:26 · 70 files · 85 findings · ls-13×4 …" so change between scans is visible.
- **B-3 — resolved vs open.** The honest answer to "исправили или нет" needs a *site identity* that
  survives a line shift. `path + line` does not; `path + ruleId + hash(snippet)` mostly does. This is
  the one item in the roadmap that adds a genuinely new concept, so it gets its own note before any
  code: what a site is, what counts as "resolved", and how a noisy hash is reported rather than
  trusted silently.
- **B-4 — per-window counts.** Turn `scanCountsScope: 'lifetime'` into a real choice: lifetime and
  window side by side, so the 7/30-day switch stops being decorative for scan data.

**Not in B:** writing to the project, judging code quality, claiming a fix the scanner cannot prove.

### Delivered in 0.10.0

B-1, B-2 and B-3 ship; **B-4 does not** and `scanCountsScope` stays `'lifetime'`. Where the delivered shape
differs from the sketch above:

- **The sparkline is refused, with numbers.** A per-rule × per-day matrix costs 31 KB per workspace at the
  90-day window, so `scanByDay` counts scans, files and findings per day and each rule carries a `lastSeen`
  day instead of a series. `ruleFirstSeen`/`ruleLastSeen` are lifetime and only move outward.
- **History keeps one entry per completed scan, 20 deep**, with capped rule and skip-reason lists, and a
  refused scan records nothing at all — the `lastScan` precedent, so a refusal cannot erase what the last
  good scan said.
- **A site is a hash, and a comparison may refuse.** `siteId` hashes `path + ruleId + snippet` and only the
  eight hex characters are stored. A comparison needs a complete, untruncated baseline, and otherwise
  prints one of seven tokens (`sites-unknown`, `truncated`, `no-files`, `no-baseline`, `fewer-files`,
  `branch-changed`, `rule-table-changed`) instead of numbers. A collision can hide a fix; it cannot invent
  one, and a retired rule is never counted as resolved.
- **The text report prints three numbers; `retired` is panel-only**, and a pre-0.10.0 document renders
  exactly as before on both surfaces — the 0.7.3 rule, extended across a whole phase.

---

## Phase C — Under control (do something about it)

**Goal:** decide, per finding, "fix it" or "I know, leave it" — and make the panel honest about both.

Precondition: B-3 (a suppression without a site identity is a suppression you cannot review).

- **C-1 — suppression list.** A local file, created only on request, keyed by site identity, with a
  reason and a date. The scan reports suppressed findings separately (`suppressed: N`) instead of
  pretending they vanished — the difference between "fixed" and "muted" must stay visible.
- **C-2 — add to `.scanignore`.** The ignore file already exists and already wins over explicit paths;
  a button that *offers* the pattern (and never writes silently) is the natural first write action.
- **C-3 — reset, precisely.** `telemetry.reset()` is all-or-nothing today. Split it: this workspace,
  window only, scan counters only — so erasing scan debt does not erase the search/miss history that
  drives corpus decisions.
- **C-4 — export.** The report is already JSON; a "copy as JSON" affordance costs nothing and makes
  the counters usable for a corpus review.

C is the only phase that touches the "panel is read-only" promise. It ships with an ADR that amends
[AGENTS.md](../AGENTS.md) in the same change, and with the rule that **no write ever happens without
an explicit user action and a visible confirmation**.

### Delivered in 0.11.0

All four items shipped. The suite went from 373 tests to 463 (459 pass, 4 skipped — every skip is this
machine's inability to create a symlink, not a product behaviour).

- **C-1 — mute one finding.** `lib/site.js` is the one FNV-1a site identity shared by the scanner, the
  counters and the file, and `lib/suppress.js` owns the JSON shape, the caps (200 entries, 200-character
  reason, 256 KiB) and the canonical serialiser. `/guidance-suppress <siteId> [--dry-run]` plans, then
  applies, and the panel needs a second distinct click. The promise that carries the phase: a suppressed
  finding is **muted, not fixed** — it keeps its place, its order and its count, gains `suppressed: true`,
  and the phase B diff may never turn it into "resolved".
- **C-2 — offer a `.scanignore` line.** `/guidance-scanignore <pattern> [--dry-run]`, identity by effect
  (`report/` ≡ `/report/`), the file's own line ending preserved, temp-then-rename, and the *result* is
  re-parsed through the scanner's own `parseScanIgnore` before the rename — the writer cannot produce a
  file its reader would reject. The panel says "the next scan reads less", never "muted": the two writes
  make different promises and the words stay apart.
- **C-3 — reset precisely.** `reset({ scope })` with `all | scans | workspace | window`; a bare
  `--reset --yes` still wipes exactly what it always wiped, and **no scope opens `.suppress`** — muting is
  not a counter, so the mute list outlives any erasure, pinned by four end-to-end tests with real bytes.
- **C-4 — copy as JSON.** It copies the envelope the panel already holds: no host call, no file, and it is
  absent when there is no report or no clipboard.

Honest deviations, in the phase B spirit:

- The suppression list is **not** partitioned by workspace beyond living at the workspace root. A shared
  profile with two checkouts of the same project keeps two independent files, which is the intended
  reading, but nothing dedupes them.
- `--reset --days N` clears a window and **says** that lifetime rule bounds survive it: a day cannot be
  attributed to a rule's first sighting, so the counters that are lifetime by definition do not shrink.
- The `.scanignore` write has **no cap**, unlike `.suppress` (200). The plan therefore states the count it
  would reach and claims no headroom; the asymmetry is deliberate and recorded in ADR-0003.
- One flake was observed once, mid-run, in `test/stats.test.mjs` while a peer was writing `index.js`; it
  passed on every subsequent run, twice in a row on the final tree. Recorded here rather than buried,
  because a test that fails only under concurrent edits is still a test worth watching.

---

## Decisions log

| # | Decision | Why |
| --- | --- | --- |
| A-1 | Rule `message` stays English on all three locales | It is the scanner's canonical sentence, shared with the tool text and the chat row; translating it would create a second wording to keep in sync. Revisit only if the panel is ever shipped alone. |
| A-2 | Confidence tokens stay raw (`high`/`medium`/`low`) | Same rule as ids and skip reasons: a value matched against scan text, not UI copy. |
| A-3 | The unit is spelled, not implied (`121 findings`) | A bare number is what caused the confusion in the first place. |
| A-4 | Enrichment lives in the JSON, not in a second command | One implementation per operation; the panel already parses this report. |
| D-1 | Scan counters are partitioned by workspace, inside the existing document | Scans are the only workspace-scoped numbers; a map in one document keeps the single atomic write and needs no call-site change. |
| D-2 | Branch is a per-scan label, never a counter key | Unstable identity (detached HEAD, rebase, worktrees); a name is not a bucket. |
| D-3 | Stay on `version: 1`, partition additively, never bump | `normalizeState` reads any other version as an empty document and the next flush overwrites the file — a bump is silent total loss. |
| D-4 | The header always names the workspace | A number whose owner is unknown is worse than no number. |
| D-5 | Guidance counters stay profile-wide | Hits, misses, coverage and dead guides measure the corpus, not a directory. |
| D-6 | The counters document stores a name, not a path, by default | Keeps the "ids and numbers, never a path" promise honest; the full path is an opt-in. |

## Open questions

1. **Per-branch counters** — is "all branches of this project" the wanted unit (current plan), or must
   `main` and a feature branch keep separate totals? The second is possible but needs its own schema.
2. **Workspace renames and moves** — a moved project becomes a new workspace. Merge/rename tooling is
   deliberately out of scope for D; is that acceptable, or does D need a `--rename-workspace`?
3. **`.git/HEAD` reads** — **resolved by [ADR-0002](adr/0002-branch-labels.md)**: one fixed file, one
   `gitdir:` hop, silence on anything else, and the drafted "unknown" fallback dropped. What stays open is
   only the per-branch *view* (item 1), not the label.
4. **Retention vs lifetime** — `lastScan` is pruned after 90 days while `scanRules` never is. Should
   the lifetime counters gain an explicit "since" date in the panel (they already have one in the
   state document), or is that noise?
5. **Where does the roadmap live** — this page, or GitHub Issues (see
   [docs/agents/issue-tracker.md](agents/issue-tracker.md))? If issues become the source of truth,
   this file shrinks to the phase contracts and links out.
6. **Live host checks that reading cannot settle** (from
   [workspace-scoping-facts.md](notes/workspace-scoping-facts.md)): does the real `tools/result`
   `exec` carry `agent.session.header`; does `DSH_PROFILE_DIR` actually mean the profile home; does
   every command invocation carry a session header. D is designed not to depend on any of them, but
   knowing the answers would let it attribute *all* calls, not only scans.
