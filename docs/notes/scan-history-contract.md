# Scan history contract (0.10.0)

This note is the interface for phase B, and only the interface: no code, no test and no state change
lands with it. `docs/ROADMAP.md:324-342` sets the goal ("answer `when` and `did the fix land`
without turning the scanner into a stateful linter") and requires a note before B-3
(`docs/ROADMAP.md:336-340`: "what a site is, what counts as `resolved`, and how a noisy hash is
reported rather than trusted silently"); this is that note, extended to the two workstreams it sits
on.

The three workstreams answer the three questions a reader actually asks of a scan: **what fired, when
it fired, and whether it is still there.** A scan is a marker pass over a workspace
(`lib/scan.js:795-823`); a finding is one code site, not one line (`AGENTS.md`, "A finding is a code
site"); the counters are one `stats.json` per DSH profile that must keep loading across upgrades
(`lib/telemetry.js:24`, `:309-311`).

Every number below is measured, not estimated: the live profile document at
`~/.dsh/storage/modern-web-guidance/stats.json` is **2,917 bytes** on 2026-11-11 (`scanRules` 356,
`scanGuides` 886, `lastScan` 396, 33 rule rows summing 642 findings), and the additions in §10 were
sized by building the proposed shapes and serialising them.

## The problem this solves

Three questions have no answer today, and each one is a missing field rather than a missing feature.

1. **When did a rule fire?** Only the most recent scan survives, and it is overwritten: a completed
   scan replaces `lastScan` wholesale (`lib/telemetry.js:649-658`). The lifetime counters add up
   (`:634-637`) but carry no date, and the call ring keeps `files`/`findings` with **no rule
   breakdown** (`:661-670`) — so "did `ls-13` fire yesterday" is answerable only if yesterday was the
   last scan.
2. **Did the last scan see less than the one before?** Nothing keeps the earlier number. `lastScan`
   has one slot (`lib/telemetry.js:650-657`); `recent` has 1,000 slots but per call and without rule
   counts (`:670`); `byDay` sums scan volume at the root and never partitions it (`:618-624`).
3. **Fixed or not?** Unanswerable twice over: there is no earlier scan to compare against, and the
   obvious identity (`path` + line) cannot work, because a finding is a run of hits and its `line`
   is the *first* hit of the run (`lib/scan.js:809-820`), so inserting one line renames every site
   below it.

The panel is where this hurts: it renders ranked ids and counts (`client.js:1750` and after) but
cannot say when they were seen or whether the number moved. The roadmap's own diagnosis of
`ls-17  121` is the same wound from the other side (`docs/ROADMAP.md:25-53`: an opaque id, no unit,
one word for two numbers, and no project attribution), and the 0.10.0 surface that closed the last of
those (`docs/ROADMAP.md:296-310`) is what this note extends rather than replaces.

## Non-negotiables

- **`version` stays `1`.** `normalizeState()` reads any other version as an empty document
  (`lib/telemetry.js:309-311`), and the next flush overwrites the file atomically
  (`lib/telemetry.js:828-833`): a bump is silent total data loss. Every field below is additive and
  normalises from absent.
- **A missing key reads as empty, never as a zero.** A 0.10.0 document has none of these fields;
  it must load, keep counting, and render *shorter* — no invented `0 scans`, no `never`, no empty
  block (the 0.7.3 rule, restated for 0.10.0).
- **No path, no snippet, no file name, no branch as a key.** The counters promise "ids and numbers,
  never a path and never a snippet" (`README.md:367`, `README.zh.md:345`); §4 stores a hash of a path
  inside a site key and says exactly what that does and does not reveal.
- **The scanner does not change.** No new file read, no new finding member, no new rule, no new cap;
  `SCAN_LIMITS` (`lib/scan.js:85-95`) and the finding shape (`:809-820`) stay as they are, and the
  scan result (`:839-852`) is untouched.
- **Telemetry stays filesystem-free.** The only read in the plugin stays the one ADR-0002 accepted
  (`<workspace>/.git/HEAD`, [ADR-0002](../adr/0002-branch-labels.md)); this note adds no read and no
  process.
- **Guidance counters stay profile-wide.** Only scan data is partitioned per workspace (0.10.0); a
  workspace dimension for search/retrieve would make "hit rate" meaningless.
- **Branch is a label, not a key.** When ADR-0002's label exists it rides on the scan and may be
  printed; it never keys a bucket, a day row, a ring entry or a diff.
- **Every number names its scope and its window**, and no total merges two workspaces into one
  "fixed" figure.
- **The report refuses to guess.** A comparison it cannot prove is named as unavailable with a
  reason token, never rendered as zero.

## Where this refines the brief it was given

Five points, all deliberate. The rest of the direction is adopted as written.

1. **Per-rule day series are refused, and so is the top-N version of them.** §2 carries the
   measurement (33 rules × 90 days = 31,051 bytes per workspace against 4,501 for the workspace-level
   series). The proposed bound ("top N rules by lifetime count") is refused for a second reason: the
   rules a reader checks after a fix are the ones that just *changed*, and a lifetime top-N drops
   exactly those. The honest substitutes are `ruleFirstSeen`/`ruleLastSeen` (§2) and the scan ring
   (§3).
2. **B-2 is a new ring, not a fatter `recent`.** The roadmap's sentence "add `rules`/counts and
   `workspace`/`branch` to the entry" (`docs/ROADMAP.md:333-335`) would put a rule map on each of
   1,000 mixed-call entries, change the shape `test/telemetry.test.mjs:862-868` pins, and make the
   ring answer two questions at once. §3 adds `scanHistory` inside the workspace bucket instead, and
   `recent` keeps its exact shape.
3. **A refusal records nothing in scan history.** The precedent is `lastScan`, which a refusal cannot
   overwrite because a fresh "0 files, 0 findings" row reads as a clean project
   (`lib/telemetry.js:646-648`). The refusal is already counted as an error call (`:615-616`), and the
   button that caused it already shows the scanner's own refusal text.
4. **The site key is a hash of path, rule id and snippet together** (§4). Storing `path` beside a
   snippet hash would be the bigger disclosure, and storing the path at all is what the counters
   promise not to do.
5. **The numbers are bounded by the host, not by a flag**: ring depth 20, ten rules per entry, four
   skip reasons, 200 site keys, 40 diff rows (§10). `/guidance-stats` grows no new option (§8).

## 1. What is stored, and what each part answers

Four storage lives, deliberately different:

| Question | Field | Lifetime |
| --- | --- | --- |
| when did a scan happen, and how much did it see | `scanByDay` (per workspace) | pruned with `byDay`, 90 days by default |
| when was a rule first and last seen | `ruleFirstSeen`, `ruleLastSeen` | lifetime, never pruned, like `scanRules` |
| what did each recent scan find | `scanHistory` (per workspace) | last 20, pruned by the same window |
| is a site still there | `lastSites`, `scanDiff` (per workspace) | latest only, expires with the window |

The full document after 0.10.0, with new members marked:

```js
{
  version: 1,
  since, calls, byDay, byTool, byOutcome, byCategory, retrieved,   // unchanged
  scanRules, scanGuides, lastScan,                                  // legacy root, unchanged
  workspaces: {
    '<id>': {
      name, since, scanRules, scanGuides, lastScan,                 // 0.10.0, unchanged
      scanByDay:     { '<YYYY-MM-DD>': { scans, files, findings } },  // B-1
      ruleFirstSeen: { '<ruleId>': '<YYYY-MM-DD>' },                 // B-1
      ruleLastSeen:  { '<ruleId>': '<YYYY-MM-DD>' },                 // B-1
      scanHistory:   [ /* B-2, oldest first, at most 20 */ ],
      lastSites:     { at, files, ruleCount, rules } | null,         // B-3 baseline
      scanDiff:      { against, resolved, stillOpen, new, retired, partial, rows } | null,
    }
  },
  recent: []                                                        // unchanged
}
```

The root counter block stays exactly as it is: the legacy `_unattributed` bucket gains **no** B
fields, because it is where pre-partition scans live and nobody writes to it any more
(`lib/telemetry.js:324-326`, `:765-772`;
`docs/notes/workspace-attribution-contract.md:107-109`). Its report rows are empty and its panel
section is shorter — never a fabricated series.

## 2. B-1: when a scan happened

### 2.1 `scanByDay`

```js
scanByDay: {
  '2026-11-10': { scans: 2, files: 140, findings: 168 }
}
```

- One row per local day that had at least one **completed** scan, keyed by the same `dayKey()` the
  call series uses (`lib/telemetry.js:73-78`, `:618`), so a day means the same thing in both series.
- `scans` counts completed scans only (`outcome` `findings` or `clean`). A refusal is a *call*, not a
  scan: it reads no files and is already counted by `byDay.calls` and `byOutcome.error`
  (`lib/telemetry.js:610-624`). This is the same distinction `lastScan` already makes
  (`:646-648`).
- `files` and `findings` are the sums of those completed scans' own numbers, as the scan reported
  them (`lib/scan.js:839-852`). They are **not** the root `byDay.files`/`findings`, which add every
  scan call profile-wide (`lib/telemetry.js:623-624`); the two are never added together and the
  report never prints both under one label.
- Pruned with `byDay` in `prune()` (`lib/telemetry.js:573-591`): delete days older than
  `dayKey(now - retention * DAY_MS)`. A row is never kept for a day the call series has dropped.

### 2.2 `ruleFirstSeen` / `ruleLastSeen`

```js
ruleFirstSeen: { 'ls-13': '2026-10-04', 'ls-17': '2026-11-10' },
ruleLastSeen:  { 'ls-17': '2026-11-10', 'ls-13': '2026-11-09' }
```

- Day resolution, not timestamps: the ring entry already carries the exact `at` (§3), and a second
  timestamp per rule would add fourteen bytes a rule for nothing. A day is what "when" means to a
  reader who is not comparing two scans minute by minute.
- Written from the same per-rule counts the lifetime counters use (`lib/telemetry.js:638-645`), so
  the key set equals `scanRules`' key set and no new id class appears.
- Monotonic and idempotent: `firstSeen` takes the earlier day, `lastSeen` the later one, so a
  backwards system clock cannot rewrite history and a replayed call cannot move a date forwards or
  backwards. Both are written only for rules with a positive count in that scan.
- Lifetime, never pruned, for the same reason `scanRules` is (`lib/telemetry.js:634-637`): it is the
  workspace's identity, not a day's slice. It can therefore be older than the 90-day series, and the
  report says so by naming the date rather than implying the window.

### 2.3 What is refused, and why

- **Per-rule × per-day counts** (`scanByDay['2026-11-10']['ls-17']`). Measured: 31,051 bytes for 90
  days × 33 rules in one workspace, versus 4,501 for the workspace-level rows — and it is rewritten
  on every scan, so it also multiplies the write. The ring already answers "which rules were in the
  recent scans" at 0.3 KB per entry.
- **The top-N-bounded variant.** It costs the same write and hides the rows the reader is looking
  for: a rule that just appeared or dropped out is usually not in the lifetime top ten.
- **Per-rule day lists** (`ruleLastDays: ['2026-11-10', ...]`). Measured at 3,783 bytes for eight
  days × 33 rules, and redundant with `lastSeen` plus the ring.
- **A per-rule sparkline.** This is the one thing the roadmap's B-1 sentence promises
  (`docs/ROADMAP.md:330-332`) that these fields cannot support without the refused matrix. The
  honest substitutes are the workspace's per-day row (a workspace sparkline is possible) and
  per-rule first/last seen. §9 keeps the JSON ready for a later chart without claiming one.

## 3. B-2: what the recent scans found

```js
scanHistory: [                                  // oldest first; the array is the order
  {
    at: '2026-11-10T22:27:39.749Z',
    outcome: 'findings',                        // 'findings' | 'clean'
    files: 70,
    findings: 85,
    rules: { 'ls-13': 4, 'ls-02': 2 },          // count desc, id asc, at most 10
    skipped: { extension: 282, 'dot-directory': 2 },   // topSkipReasons, at most 4
    truncated: false,
    branch: { kind: 'branch', name: 'main' },   // optional; ADR-0002 shape; absent when unread
    diff: { resolved: 3, stillOpen: 82, new: 1 },      // null when no comparison was made
  }
]
```

- **Depth 20, per workspace.** 20 entries × 300 bytes is 6 KB on top of 2.9 KB of existing state;
  it is two and a half weeks of one scan a day, which is the horizon the question "did my fix land"
  is answered on. `recent` is 1,000 because it counts every call (`lib/telemetry.js:538`, `:670`);
  scans are rarer and each entry is far heavier.
- **Per-entry caps:** ten rules (`MAX_HISTORY_RULES = 10`, the same number the panel shows), the top
  four skip reasons through the existing `topSkipReasons()` (`lib/telemetry.js:172-185`,
  `MAX_SKIP_REASONS` `:41`), `truncated` verbatim from the scan, and `findings` as the scan's own
  total. An entry never grows with the scan.
- **A refusal appends nothing.** It is not a scan: `files` and `findings` are zero and its error is
  already in the call counters, so a "refused" row in the scan story would be a row with no data.
  The panel's button result still shows the scanner's refusal text, unchanged.
- **The branch label is the ADR's**, read once per completed scan on the recording path
  ([ADR-0002](../adr/0002-branch-labels.md) §1 for the one-file read, §2 for the three shapes, §4 for
  "per scan, never a key"): `{kind:'branch',name}` or `{kind:'detached',sha}`, absent when there is
  no label, and never rendered as `unknown`. History entries carry the same value the last-scan
  pointer carries; ADR-0002 §4 already says the label "will live on each scan-history entry when
  history exists".
- **No `workspace` member in state.** The entry lives inside the bucket, so the workspace is the
  bucket's; storing it per entry would duplicate the name and rewrite 20 entries on a rename. The
  snapshot adds the label when rows from several buckets are merged (§5).
- **Ordering and trimming:** append in `record()`, drop from the front at 20
  (`lib/telemetry.js:670` is the same one-liner pattern), and in `prune()` drop entries older than
  the retention cutoff (`:580-582`). A pruned ring is shorter, never padded.
- **`diff` is a copy of the totals only**, because the per-rule breakdown for an old comparison is
  not worth 300 bytes an entry; the latest comparison keeps its rows (§4.6). A row without `diff`
  is silence, not "nothing changed".

## 4. B-3: fixed or not

### 4.1 What a site is

One finding is one code site: a run of hits of one rule in one file, where the next hit is at most
`RUN_LINE_GAP = 2` lines later (`lib/scan.js:79`, `:803-808`). It carries `path`, `line`, `column`,
`ruleId`, `guideId`, `confidence`, `message`, `snippet`, `lines`, `occurrences`
(`lib/scan.js:809-820`), and `line`/`snippet` describe the **first** hit of the run.

A site identity therefore cannot contain a line number. Inserting a comment above a block moves every
site below it; counting that as "resolved + new" is exactly the false claim this phase exists to
avoid. It also cannot be only `ruleId` + snippet: two files can hold the same one-line snippet.

### 4.2 The site key

```js
siteId(path, ruleId, snippet) -> 'a1b2c3d4'      // FNV-1a 32-bit, eight lowercase hex
```

- Hashing **path, rule id and snippet together**, joined with `\u0000`, is the same frozen algorithm
  as `workspaceId()` (`lib/telemetry.js:247-255`) and produces the same eight-hex shape. It is
  computed in `classifyCall` from the scan value, because the value already carries `path` and
  `snippet` (`index.js:389-390` returns `{format, cwd, ...result}` and the finding carries both) —
  no new read and no filesystem work.
- **Only the hash is stored.** Neither the path nor the snippet enters the state document: the key
  is 8 bytes of derived data, and the document stays "ids and numbers". This is a hash of a path,
  not a path: it cannot be printed, matched or browsed, and reversing it means guessing a full
  workspace-relative path plus the rule id and the exact 160-character snippet. The one honest
  caveat is in §14.
- **A collision is conservative, never a false fix.** If two sites share a key, the key's presence
  says "still open" and its absence says "no longer present": the survivor can hide a fix, it cannot
  invent one. Two byte-identical sites (`path` + `ruleId` + `snippet` in one file) are one key by
  construction, with the same one-way error. The number that matters, a false "resolved", cannot be
  produced by a collision: it would require the key to be absent from the current scan *and* present
  in the baseline, which is the opposite of colliding.
- **Rules retire, sites do not.** The rule id is inside the key, so a rule that leaves the table
  leaves its baseline keys un-matchable, which is why `retired` exists (§4.5) and is never counted
  as resolved.
- **Not in the key:** `line` (moves), `column` (moves), `occurrences`/`lines` (a run may grow), file
  content hash (a file's other lines are irrelevant), and `guideId`/`message` (derived from the rule
  id, so they add nothing).

### 4.3 `classifyCall` gains two members on a scan

```js
{
  // ...0.10.0 scan members...
  sites: { 'ls-13': ['a1b2c3d4', '9f0e1d2c'] },   // per-rule, sorted, deduplicated
  sitesComplete: true                              // false when a finding had no usable path/snippet
}
```

`sites` is bounded by `SCAN_LIMITS.maxFindings = 200` (`lib/scan.js:90`), so a scan can yield at most
200 keys. `sitesComplete` is false when any finding lacks a non-empty `path`, `ruleId` or `snippet`:
a hand-built value, or a future scanner change, then records history but claims no comparison. A
finding with a usable path and rule id but an empty snippet counts as unusable, because an empty
snippet would collapse every such site of one rule in one file into one key. A `clean` scan has no
findings at all, so its `sites` is `{}` and `sitesComplete` is true: a scan that read the same files
and found nothing is comparable, and it is the one scan whose comparison may legitimately resolve
everything.

### 4.4 The baseline: `lastSites`

```js
lastSites: {
  at: '2026-11-10T22:27:39.749Z',        // the scan these keys came from
  files: 70,                             // what that scan read
  ruleCount: 33,                         // how many rules the table had then
  rules: { 'ls-13': ['a1b2c3d4'], 'ls-17': ['deadbeef'] }
}
```

- One baseline per workspace, never a list: the diff is against the immediately preceding completed
  scan, and older site sets are not kept. This is the field that would grow without bound if the
  question were "is this site resolved since the beginning"; it is not.
- Replaced after a completed scan whose sites are complete, which read at least one file and was not
  truncated. Otherwise the old baseline stays and the comparison is skipped (§4.5) — a scan that
  read less cannot prove absence, and must not become the next scan's yardstick.
- `files` and `ruleCount` are the two guard inputs. `ruleCount` is the size of the **current** rule
  table at the time of the scan; `lib/telemetry.js` does not import the table, so it receives the
  ids once at construction (§4.7).
- Normalised defensively: keys are `/^[0-9a-f]{8}$/` only, at most 200 in total (the scanner's own
  `maxFindings`, `lib/scan.js:90`), duplicates dropped.

### 4.5 The comparison, and its guards

For the latest completed scan (`current`) against `lastSites` (`previous`), per rule id present in
either side:

```text
resolved   = previous keys absent from current, for rules the current table still ships
stillOpen  = previous ∩ current
new        = current keys absent from previous
```

with the invariants, both worth a test: `resolved + stillOpen + retired = previous key count` and
`stillOpen + new = current key count`.

Guard clauses, first match wins. The first three ask whether **this scan** can testify at all; the
rest ask whether the comparison itself is fair. Every one yields `partial` and **no numbers**.

| `partial` | When | Baseline replaced? |
| --- | --- | --- |
| `sites-unknown` | `sitesComplete` is false | no |
| `truncated` | the scan hit any cap (`truncated` true) | no |
| `no-files` | the scan read zero files | no |
| `no-baseline` | no `lastSites` (every workspace's first scan) | yes |
| `fewer-files` | `files < lastSites.files` | no |
| `branch-changed` | both scans carry a label and they differ | yes |
| `rule-table-changed` | `ruleIds.length !== lastSites.ruleCount` | yes |

- `no-baseline` is not an error and not a first-run oddity to hide: it is the honest "nothing to
  compare with yet", and the next completed scan compares.
- `fewer-files` is the heuristic that costs the most and is worth it: a scan that read 70 files, then
  12, has not resolved 58 findings. Scanning a different path on purpose is legal and will suppress
  the comparison — an absence of a claim, which is the correct failure.
- `branch-changed` exists because a diff across two trees is a tree difference, not a fix: scanning
  `main`, switching to `feature/x`, scanning again would otherwise report every unrelated difference
  as resolved or new. It fires only when **both** scans carry a label; an unlabelled scan compares,
  and the report never pretends the branch was known.
- `rule-table-changed` catches a plugin upgrade that adds or removes rules: the first scan after it
  would otherwise report every site of a new rule as `new`, and every site of a removed one as
  `resolved` (that path is belt and braces with `retired`). A same-size rewrite of a rule's matcher
  is **not** detectable and is the residual risk named in §14.
- A comparison that ran yields `partial: null` and the numbers; a skipped one yields `null` numbers,
  never zeros.

### 4.6 `scanDiff`, and what "resolved" is a claim about

```js
scanDiff: {
  against: '2026-11-09T08:12:00.000Z',   // the previous scan, null when there was none
  resolved: 3, stillOpen: 82, new: 1,
  retired: 0,                             // baseline sites under rule ids this version no longer ships
  partial: null,                          // or one of the tokens above
  rows: [ { ruleId: 'ls-13', resolved: 2, stillOpen: 4, new: 0 } ]   // at most 40, any-count first
}
```

- **"Resolved" is a claim about exactly two scans, and it says "no longer present".** It is never a
  lifetime total, never a fix, and never evidence about a rule's codebase. The report prints the two
  dates it compared; a reader who wants the older comparisons reads the history entries' `diff`.
- `rows` carries only rules with at least one non-zero number, sorted by `resolved + new` descending
  then id, capped at 40 (`MAX_DIFF_ROWS`), so one stale rule cannot push the rest out of the panel.
- `retired` is separate and never in `resolved`: those sites disappeared because the rule did, not
  because the code changed.
- The entry for the same scan in `scanHistory` carries `{resolved, stillOpen, new}` when `partial`
  was null, and no `diff` otherwise.
- Only a single-workspace selection has a `scanDiff` (§5): a comparison across workspaces compares
  two different projects.

### 4.7 Where the rule table comes from

`createTelemetry()` gains one optional, additive member:

```js
createTelemetry({ store, clock, retentionDays, ringLimit, catalog, ruleIds = [] })
```

`index.js` already imports the frozen table (`lib/scan-rules.js:37`) and passes
`RULES.map((rule) => rule.id)`; a telemetry built without it behaves as if every rule id were known —
no `retired`, no `rule-table-changed` — which keeps hand-built test fixtures working and makes the
dependency explicit rather than a hidden import of `scan-rules.js` into the counters.

## 5. `snapshot()` — the additions

```js
{
  // ...everything 0.10.0 returns, unchanged...
  scanSeries: [ { day: '2026-11-10', scans: 2, files: 140, findings: 168 } ],  // one row per day of the window
  scanHistory: [ { at, outcome, files, findings, rules, skipped, truncated,
                   branch, diff, workspace: { id, name } } ],                  // newest first; workspace only on a merged row
  scanDiff: { /* §4.6 */ } | null,
  topRules: [ { ruleId, count, firstSeen, lastSeen } ]                          // rows gain two members
}
```

- **`scanSeries`** is built in the same loop that builds the call `series` (`lib/telemetry.js:691-712`)
  and covers the same window: one row per day, zeros included, so a chart has no holes. It is emitted
  only when the selected scope has at least one `scanByDay` row: a pre-B document renders without
  the key (and therefore without the block), instead of a flat zero line.
- **Aggregating** (`workspace: 'all'` or an unresolved header) sums `scanByDay` across the buckets,
  merges `scanHistory` newest first capped at 20, and returns `scanDiff: null`, because a comparison
  across workspaces compares two projects. Each merged row gains `workspace: { id, name }` — the only
  place the label is needed; a single-bucket row omits it, because `snapshot.workspace` already names
  the scope. Either way it is added at snapshot time, never stored (§3).
- **Selecting a bucket** returns that bucket's series, history and diff; `_unattributed` returns
  `[]`, `[]`, `null` (the root has no B fields, §1).
- **`topRules`** gains `firstSeen`/`lastSeen` from the bucket's day maps; when aggregating they are
  the earliest and latest day across buckets; when a row's rule has no date (a pre-B document, or a
  legacy root row) they are `null`, so the client renders nothing rather than a fabricated date.
  Rows stay capped at 10 (`MAX_TOP_SCAN_IDS`, `lib/telemetry.js:39`, `:224-234`).
- `lastScan` is untouched by this note; when ADR-0002's label lands it gains `branch` there and here
  with the same shape.

## 6. `/guidance-stats` — the text report

Two additions, both inside the scan block (`lib/report.js:494-524`) and both absent for a pre-B
document:

1. **The comparison line**, immediately after the last-scan line (`lib/report.js:508-523`):

   ```text
   Since the scan of 2026-11-09 08:12: 3 no longer present, 82 still open, 1 new
   ```

   and, when there is no comparison:

   ```text
   Since the scan of 2026-11-09 08:12: not comparable (fewer-files)
   ```

   or, for a first scan, one line saying the next scan will be compared. The reason token is raw,
   like a skip reason (`AGENTS.md`, 0.7.3): `dot-directory` and `fewer-files` are the scanner's
   words, never a translation-table key. The wording is **"no longer present"**, never "fixed":
   the report cannot prove a fix and must not imply one.
2. **A `Recent scans` block**, between the scan counters and the "Queries that returned nothing"
   block (`lib/report.js:550-556`), five rows at most:

   ```text
   Recent scans (last 5 of 12):
     2026-11-10 22:27 - 70 files, 85 findings, rules 4 (ls-13 4, ls-02 2)
     2026-11-09 08:12 - 70 files, 88 findings, rules 3 (ls-13 4, ls-08 2)
   ```

   `+7 earlier` on its own line when the ring holds more, following the `renderBlock` shape the
   other capped blocks already use (`lib/report.js:143`, `:552-565`). The date-time is
   `YYYY-MM-DD HH:MM`
   from the entry's ISO `at`, UTC like every other date the report prints (`when()`,
   `lib/report.js:81`); the per-rule list is capped at `MAX_SCAN_RULES_SHOWN` (`:24`), and a rule id
   never gets a translated label.

   A bucket label appears on a row only when the snapshot is aggregating (the same
   `workspaceLabel()` the footer uses, `lib/report.js:412`).

Absence is the rule: a 0.10.0 snapshot has neither key, so the report is byte-identical to today —
which is what the exact-string tests in `test/report.test.mjs` and `test/stats.test.mjs` already
assert.

## 7. `renderJson` — the additions

The frozen document (`renderJson(snapshot)`, `lib/report.js:634-671`) keeps every key it has and its
order; additions go after the workspace keys (`:664-670`), the same precedent 0.10.0 set:

```js
json.scanSeries  = source.scanSeries   // when the snapshot carries it
json.scanHistory = source.scanHistory
json.scanDiff    = source.scanDiff
```

- `scanSeries`/`scanHistory`/`scanDiff` are snapshot data, not report enrichment, so they are emitted
  in both paths when the snapshot carries them (presence test, like `'workspaces' in source`
  `:667`), and never invented.
- `topRules` rows gain `firstSeen`/`lastSeen` **only in the described path**
  (`renderJson(snapshot, { rules, guides })`, where `message`/`confidence`/`guideId` already join,
  `:657-659`, `docs/notes/workspace-attribution-contract.md:129-135`). The no-options path keeps
  `{ruleId, count}` literally, which is what buys the phase-A freeze
  (`test/report.test.mjs`, "frozen document" tests) its meaning. A rule the `rules` option does not
  know still renders, with `message: ''` and the two dates.
- `scanCountsScope: 'lifetime'` is unchanged: it still describes the ranked rule *counters*, which
  this note does not window. `scanSeries` is windowed and says so by its `day` rows; the panel's
  existing lifetime caption (`client.js:1785`) is about the ranked rows, not about the series, and
  no new scope token is introduced.
- `lastScan` is emitted as today (`lib/report.js:663`); its `branch` member belongs to ADR-0002.

## 8. `/guidance-stats` — flags

No new flag, and no new value form:

```text
/guidance-stats [--days N] [--json] [--reset --yes] [--workspace <name|id>] [--all]
```

- `--days` continues to select the window for the call `series` and now also for `scanSeries`
  (`lib/telemetry.js:691-712`). It does **not** filter `scanHistory`: the ring is depth-bounded, not
  window-bounded, because the comparison that answers "did my fix land" must survive the 7/30 switch
  and is not a window statistic. The panel labels the two surfaces separately ("Recent scans" is not
  "the last N days").
- Caps stay the host's (`AGENTS.md`, "Caps are the scanner's, not the caller's"): depth, rows per
  entry, diff rows and site keys are constants, not options. A caller that wants fewer asks with its
  eyes, or reads the JSON.
- `--reset --yes` still erases everything for now; splitting it is C-3 (`docs/ROADMAP.md:359-361`),
  and a split must name the new fields when it lands.

## 9. Client

`client.js` gets three additions in `renderScanner()` (`client.js:1750` and after), each optional:

1. **A comparison line under the last-scan line**, from `report.scanDiff`: when it carries numbers,
   `scanner.diffAgainst` ("Since the scan of {when}") followed by `scanner.diffCounts`
   ("{resolved} no longer present · {stillOpen} still open · {new} new"); when `partial` is
   `no-baseline`, `scanner.diffFirst`; when it is any other token, `scanner.diffPartial` with the
   raw token, like a skip reason. When `report.scanDiff` is absent or null, nothing.
2. **A `Recent scans` block** between the ranked rule rows and the guide chips: at most five rows,
   each `date time · files · findings · rule×count`, plus the branch label through the ADR's
   existing `scanner.branch`/`scanner.detached` keys when the entry has one, plus
   `scanner.historyMore` ("and {count} earlier") when the ring holds more. No per-row diff: three
   numbers per row in a 280-pixel sidebar is noise, and the JSON keeps them for a chart.
3. **A last-seen suffix on a ranked rule row**, `scanner.lastSeen` ("last {when}"), from the row's
   `lastSeen`; `firstSeen` goes in the row's `title` with the message, where the panel already keeps
   secondary detail (`client.js:1694-1712`, the message is the line's `title` at `:1710`). Absent
   date, absent suffix.

New locale keys, all three dictionaries, same order, same placeholders (the parity test at
`test/client-locales.test.mjs:97-118` enforces it):
`scanner.history`, `scanner.historyMore`, `scanner.diffAgainst`, `scanner.diffCounts`,
`scanner.diffPartial`, `scanner.diffFirst`, `scanner.diffRetired`, `scanner.lastSeen`. Raw tokens
stay raw: rule ids, skip reasons, `partial` reasons and the date strings are data, not locale keys.
The words are "no longer present" in EN, `больше не встречаются` in RU and `不再出现` in ZH — never
`fixed`, `исправлено` or `已修复`, because the panel cannot prove it.

Degradation: a host that sends no `scanHistory`, no `scanDiff` and no `firstSeen`/`lastSeen` renders
exactly today's panel — no empty block, no suffix, no caption. `scanSeries` is data for a later chart
(§2.3) and this phase draws none.

## 10. Size budget, measured

Built from the live profile's shape (70 files, 85 findings, 33 rules, 642 lifetime findings) and
serialised with `JSON.stringify`:

| Member | Worst case (every cap hit) | Measured shape (one scan day, 20 scans, 85 sites) |
| --- | --- | --- |
| `scanByDay` | 4,501 (90 days) | 51 (1 day) |
| `ruleFirstSeen` + `ruleLastSeen` | 1,388 (33 rules each) | 1,388 |
| `scanHistory` | 6,001 (20 entries × 10 rules) | 6,001 |
| `lastSites` | 2,559 (200 keys, 33 rule ids) | 1,294 (85 keys) |
| `scanDiff` | 1,925 (33 rows, capped at 40 → ≤2,400) | 1,485 (25 rows) |
| **Total added per workspace** | **16,461** | **10,306** |

- One workspace goes from **2,917 bytes today** to **13.2 KB** on that measured shape, **19.4 KB** at
  every cap. A scan a day for twenty days adds roughly 1 KB of day rows (14.2 KB), and a profile with
  five active workspaces at every cap is ~92 KB: parsed in **0.64 ms** and stringified in **0.33 ms**,
  once per process load (`lib/telemetry.js:558-570`) and on the 2-second debounced flush
  (`index.js:630`).
- That is small against a bound the document already has: `recent` keeps up to 1,000 entries
  (`lib/telemetry.js:538`) whose queries are capped at 512 characters each (`:32`), so an existing
  document can already be two orders of magnitude larger than what this note adds.
- The refused alternatives, for comparison: the per-rule × per-day matrix **31,051 bytes** per
  workspace, per-rule day lists **3,783 bytes** for eight days. Neither is worth its write
  amplification.
- Nothing here is stored per hit, per file or per snippet: the largest member is the ring, and it is
  depth-capped.

## 11. Migration

`version` stays `1` and nothing is renamed, so a 0.10.0 document is upgraded in place, additively:

- `normalizeWorkspaces()` (`lib/telemetry.js:283-298`) completes each bucket with the new members:
  `scanByDay: {}`, `ruleFirstSeen: {}`, `ruleLastSeen: {}`, `scanHistory: []`, `lastSites: null`,
  `scanDiff: null`. A malformed member reads as its empty value — one bad entry is dropped, never
  thrown, exactly as the existing normaliser treats a bad `scanRules`/`lastScan`.
- The legacy root counters gain nothing (§1): its day maps, ring and diff stay absent, so a report
  over `_unattributed` is shorter than a report over a real bucket — by design, not by defect.
- A 0.10.0 document loads with every existing counter, `lastScan` and ring entry intact; the exact
  deep-equal assertions on the bucket shape (`test/telemetry.test.mjs:851-857`) and on a `recent`
  entry (`:862-868`) must be **updated to the new bucket shape** and **must not change** for
  `recent`. That is the one test edit a bucket extension is allowed to make.
- **The first post-upgrade scan claims nothing.** It has no baseline (`scanDiff.partial:
  'no-baseline'`), appends the first history entry, and writes `lastSites`; the comparison starts
  with the second scan. A workspace that never scans again keeps `scanHistory: []` and renders
  shorter than one that does.
- Pruning extends the existing rules (`lib/telemetry.js:573-591`): `scanByDay` days with `byDay`,
  history entries and `lastSites`/`scanDiff` when older than the window, exactly as `lastScan` is
  dropped today. `ruleFirstSeen`/`ruleLastSeen` are never pruned, like `scanRules`.
- `reset()` (`lib/telemetry.js:821-826`) erases the new fields with everything else — unchanged
  behaviour, and one more thing C-3 has to enumerate when it splits the reset.
- `test/telemetry.test.mjs:821` and `:1006` pin `version === 1`; they stay green without an edit,
  and a new test loads a populated 0.10.0 document and asserts the six empty members.

## 12. What B-3 must never claim

1. **Never "fixed".** The only claim is "the key was in the previous scan and is not in this one".
2. **A snippet edit is not a fix.** Change one character and the key changes: that site is reported
   as one resolved and one new, and the panel's three numbers show both.
3. **A moved line is not a new finding.** The key contains no line number, so the site is the same
   before and after the shift.
4. **A retired rule is not a fix.** Its baseline keys go to `retired`, never to `resolved`.
5. **A rule the table gained is not a new finding.** A table-size change suppresses the comparison
   (`rule-table-changed`); a same-size matcher rewrite cannot be detected and is not claimed.
6. **A smaller scan is not a fix.** Truncated, zero-file and fewer-file scans resolve nothing.
7. **Another branch is not a fix.** Two labelled scans with different labels are not compared.
8. **A refusal is not a scan.** It appends no history entry, becomes no baseline and yields no diff.
9. **A hash collision never fabricates a fix.** It can hide one, never invent one (§4.2).
10. **A duplicate site is one site.** Two byte-identical findings collapse; the survivor can hide a
    fix and cannot invent one.
11. **A deletion is absence, not modernisation.** Removing a file resolves its sites, which is
    correct as absence and is still not evidence the code was updated.
12. **Never a lifetime total.** There is no "total fixed" number anywhere; every comparison names
    the two scan timestamps it used, and older comparisons live in the history entries.
13. **Never per branch.** A history row carries a branch label; it is never a filter, a bucket or a
    key (ADR-0002 §4).

## 13. Tests each workstream owes

- **B-1 (state):** `scanByDay` gains a row per completed scan and no row for a refusal; the same
  day in two workspaces stays separate; pruning drops days older than the window and keeps the rest;
  `firstSeen` is set once and never moved later, `lastSeen` never moves earlier (clock going
  backwards included); the key set equals `scanRules`'; a pre-B document loads with empty maps.
- **B-2 (state):** the ring caps at 20 and drops the oldest; per-entry rules cap at 10 in count/id
  order; skip reasons reuse the top four; a refusal appends nothing but still counts as an error
  call; a `clean` scan appends an entry with no rules; pruning drops entries older than the window;
  the branch label round-trips in all three ADR shapes and is absent when unread.
- **B-3 (state):** `siteId` is stable (golden value), ignores `line`, and changes when the snippet
  changes; `classifyCall` yields per-rule sorted keys and `sitesComplete` true/false; every guard in
  §4.5 fires with its exact token and no numbers; the two invariants in §4.5 hold for a mixed scan;
  `retired` is excluded from `resolved`; a rule table that gained a rule suppresses the diff;
  `lastSites` is not replaced by a truncated or zero-file scan; a collision-shaped pair still
  reports "still open".
- **Snapshot:** aggregation sums days, merges history newest-first with workspace labels and returns
  `scanDiff: null`; a single bucket returns its own three; `_unattributed` returns empties;
  `topRules` dates are the earliest/latest across buckets and `null` when unknown; pre-B state has
  no `scanSeries`/`scanHistory`/`scanDiff` keys.
- **Surface:** the exact text goldens for a pre-B snapshot stay byte-identical, and a 0.10.0 state
  gains the two blocks without changing any existing line; the comparison line says "no longer
  present" and never "fixed"; the five-row cap and `+N earlier` line work; `--days` leaves the ring
  alone; JSON carries the three keys only when present, and `topRules` gains the dates only in the
  described path; `scanCountsScope` is still `lifetime`.
- **Client:** three dictionaries in parity with the eight new keys; the comparison line renders each
  of the three states (counts, first scan, partial token); the history block caps at five and shows
  the hidden count; the last-seen suffix appears only when the row has a date; no `scanSeries` is
  drawn; a report without the new keys renders exactly today's panel.
- **Migration:** a populated 0.10.0 document survives `normalizeState` with all counters and the ring
  intact and six empty members; `version` is still `1`; the first post-upgrade scan produces
  `no-baseline` and the second produces numbers.

## 14. Open questions

1. **Is a hash of a path within "never a path"?** The stored key is eight hex characters derived from
   a path, a rule id and a snippet; nothing can read a path back out, but a reviewer may want the
   privacy note (`README.md:367`) to say so explicitly rather than infer it. The alternative — no
   path component, `ruleId + snippet` only — is cheaper to defend and mis-keys two files that share
   a one-line snippet, which is common in generated code. This note takes the path-hash; if the
   privacy note must say more, that is a doc change, not a shape change.
2. **Do we want the `Recent scans` block in the *text* report at all?** It is the one addition a
   terminal reader can live without, and it costs five lines. It is in because "when" is the
   question, and the panel is not always open; dropping it later is additive in reverse (a shorter
   report is never a broken one).

## 15. Not in this phase

- **B-4, per-window rankings.** `scanCountsScope` stays `'lifetime'`; the 7/30 switch still does not
  re-rank the scan counters. `scanSeries` and the ring are the data a later phase needs, and they
  are stored now so B-4 needs no migration.
- **A per-rule sparkline or chart.** Refused with the matrix (§2.3), and no chart is drawn in the
  panel this phase.
- **Suppression, `.scanignore` writing, reset granularity, export** — all phase C
  (`docs/ROADMAP.md:348-363`), and C-3 must enumerate the new fields when it splits `reset()`.
- **Any write to the project**, any judgment of code quality, and any claim the scanner cannot prove
  (`docs/ROADMAP.md:344`).
- **A change to the `recent` ring**, to `lastScan`'s six members, to the `_unattributed` bucket, or
  to any paired `scanRules`/`scanGuides` lifetime counter.
- **A branch dimension in any counter.** ADR-0002's label is printed, never keyed; per-branch views
  remain a view over this history, not a fourth bucket.

## 16. The slope (0.13.0, phase F-1)

A direction is a claim about a *ring*, so it is derived in `lib/report.js` at render time and stored
nowhere: reporting one leaves `stats.json` byte-identical, and the test compares bytes across a second
instance and again after the debounce window.

- **Rates, not counts.** Each half is `Σfindings / Σfiles × 100`, rounded once to one decimal before
  either surface reads it, and `delta` is computed from the rounded halves — so the text, the JSON and
  the arithmetic a reader does in their head agree. Raw counts are not comparable between a wide and a
  narrow scan; the walk's own caps make sure of that.
- **Two adjacent halves of the newest comparable entries.** `n = floor(comparable / 2)`, older entries
  ignored, no sliding window and no fixed sample. `sample` is what was actually weighed.
- **A truncated entry is a hole, not a zero.** It is dropped *before* the halves are cut and the halves
  are re-cut, so the sample shrinks and the boundary moves; counting a truncated scan as "found
  nothing" would be the single most flattering lie the report could tell.
- **Refusal precedence**: `aggregate` → `too-few-scans` → `branch-changed` → `no-files`. Each is a
  token, and `branch-changed` needs two labelled halves that disagree: a half carries a label only when
  every entry in it does and they agree, so one labelled half states its slope and says nothing about
  branches. `no-files` names the half whose denominator is missing. `too-few-scans` names nothing,
  because naming halves it could not fill would be a number without a sample.
- **`aggregate` prints**, unlike `scanDiff`, which stays silent for an aggregate: a slope is the
  per-workspace claim par excellence, so the aggregate is exactly where a reader must be told why there
  is none.
- **Absent, not falsy.** A snapshot with no ring yields no `scanSlope` member at all; a ring that is not
  an array yields `scanSlope: null` (this host cannot tell); an empty ring yields
  `{ refusal: 'too-few-scans' }` (a real refusal). Three states, because "cannot tell" and "not enough
  data" are different answers.

## 17. A rule's slope (0.13.0, phase F-2)

The ring keeps each scan's ten most-numerous rules. **The ten is a sample, not a census**: a rule absent
from an entry was not in that scan's top ten, which is not the same as a rule that stopped firing. That
single distinction is the whole design, and it is why F-2's hole rule differs from F-1's.

- **Two questions, two scopes.** `not-sampled` (no entry carries the rule at all) is decided over the
  whole comparable series; every other state is decided over the two halves. "No scan sampled it" and
  "the window does not reach the entries that did" are different answers and must not be merged.
- **Trim the halves to the same number of carrying entries.** `pair = min(newer carried, older carried)`;
  `from`/`to` are the sums of the newest `pair` counts on each side, `sample = 2 × pair`. Summing whole
  halves makes a rule carried once recently against three times older read `falling` when it is per
  carrying scan `rising` — and the trim is also what makes `flat` a stated case rather than an artefact of
  half size.
- **The floor decides whether to compare; the sample says how much was compared.** Fewer than three
  carrying entries → `too-few-samples`. With exactly three the fair cut is one against one, so the
  sentence prints `over 2 scans` — smaller than the floor, and honest: the floor is about evidence, the
  sample is about the claim.
- **The words are not B's.** `entered-sample` and `left-sample` are about the *sample*, not the finding:
  a rule can leave the top ten while firing exactly as before. `new`/`resolved` belong to sites (B-3) and
  never appear on a rule slope.
- **Three-way presence, again**: no member = a document without a ring (renders the 0.12.0 report);
  `null` = an aggregate, where there is no single ring to read and F-1's line already says why; a token =
  a real refusal with its sample. Refusals print their sample, because a verdict without its evidence is
  the thing this phase is against.
- **Described rows only.** The frozen two-member row shape (`renderJson(snapshot)` with no options) stays
  two members: the slope is enrichment derived from the ring, not snapshot data, and an older consumer
  parsing that row must not see a member appear inside it.
- **Derived, never stored.** Same as §16: a report leaves `stats.json` byte-identical, and the shared
  window helpers (`comparableSeries`, `halfSeries`) make a truncated scan a hole in every series it
  touches.
