# The suppression file, and what "suppressed" means in a report (0.11.0)

This note is the interface for C-1, and only the interface: no code, no test and no state change lands
with it. `docs/ROADMAP.md:380-382` sets the workstream ("a file the user creates on request, keyed by
the site identity from B-3, carrying a reason and a date; the scan reports `suppressed: N` and the
difference between 'fixed' and 'muted' stays visible"), and `docs/ROADMAP.md:60-62` sets the guardrail
it must not break ("the scan stays report-only; suppression is a separate opt-in file, not a scanner
silence switch"). [ADR-0003](docs/adr/0003-write-surface.md) already decided **who may write, when, and
what a refusal looks like**; it deliberately leaves the file's contents to this note
(`docs/adr/0003-write-surface.md:29-30`: "says nothing about the suppression file's contents, which is
`docs/notes/suppression-contract.md`'s job"). Nothing below re-decides a door that ADR already built.

The one sentence everything else serves:

> A suppressed finding is still a finding. It stays in the count of what the scanner sees, it is
> reported separately (`suppressed: N`), it is visible by rule, and it is never counted as "resolved" by
> the scan diff — because muting is not fixing.

That sentence is testable, and §13 and §19 say how. Every number in §16 is measured, not estimated:
the proposed shapes were built and serialised on 2026-11-11.

One vocabulary warning before the sections. Phase B uses the verb "suppress" for a *guard* — "scanning
a different path on purpose is legal and will suppress the comparison" (`docs/notes/scan-history-contract.md:351`).
In this note "suppression" and "suppressed" always mean the user's decision and the file that records
it; a refused comparison is "refused", never "suppressed".

## The problem this solves

Three questions have no answer today, and each one is a missing file rather than a missing feature.

1. **"Do I already know about this finding?"** The scanner has no memory of decisions. Every scan
   re-reports every site (`lib/scan.js:830-836`), and a team that has looked at a site and chosen to
   keep it has two bad options: read past it every time, or exclude the file. The second is `.scanignore`
   (`lib/scan.js:409-420`), which does not mute a finding — it stops the file being read at all
   (`lib/scan.js:573` and after), so the rest of that file's findings disappear with it. There is no
   way to say "this one site, on purpose".
2. **"How much of what the scanner sees have I muted?"** Nothing to answer with: the scan has no notion
   of a muted finding, so the only honest count is the one nobody can produce. A number that mixes
   "muted" with "fixed" is worse than no number (`docs/ROADMAP.md:25-53` is the same wound from the
   other side: one word for two numbers).
3. **"Did the fix land, or did I mute it?"** Phase B answers half of it: a site is `siteId()`
   (`docs/notes/scan-history-contract.md:250-262`, `lib/telemetry.js:697-703`), and "resolved" is a
   claim about two scans, not about a fix (`docs/notes/scan-history-contract.md:327-332`). If a muted
   finding left the diff, muting would read as fixing and phase B's promise would be dead on arrival.
   Keeping it in the diff is the whole point of this note.

The identity is what makes a reviewable file possible: without `siteId()` a suppression would have to
name a line (`lib/scan.js:809-820` makes a finding a *run*, so any insertion renames every site below
it) or a whole file or rule (which is `.scanignore`, or a silence switch). The identity exists, is
golden-pinned (`test/site-identity.test.mjs:31-36`) and is already stored in state. This note spends it.

## Non-negotiables

- **`version` stays `1`.** The counters read any other version as an empty document
  (`lib/telemetry.js:816-868`) and the next flush overwrites the file atomically
  (`lib/store.js:41-43`): a bump is silent total data loss. Every member below is additive and
  normalises from absent.
- **A missing member reads as absent, never as a zero.** A pre-C document has no suppression members,
  and a pre-C scan value has no `siteId` in its findings; both render exactly what they rendered before
  (the 0.7.3 rule, `AGENTS.md` "Both scan caveats are on screen"). A zero is a claim; silence is not.
- **A suppressed finding is still a finding.** The scan never removes, reorders, re-caps or re-sorts
  one (`lib/scan.js:830-836`, `:839-852`): `findings.length` is unchanged, `guides` is unchanged,
  `scanned.*` is unchanged, `truncated` is unchanged.
- **One identity, one algorithm.** A key is `siteId(path, ruleId, snippet)` — FNV-1a 32-bit over the
  NUL-joined triple, eight lowercase hex, no line number (`lib/telemetry.js:680-703`). A second function
  that "almost" matches would make "suppressed" and "still open" disagree about the same site, which is
  the one bug this feature must not have.
- **The file stores decisions, not evidence.** An entry carries the site hash, the reason a person typed
  and the date — never the path, the snippet or the line the finding came from
  (`docs/adr/0003-write-surface.md:141-144`). `stats.json` holds ids and numbers only (`README.md:367`);
  the policy file holds strictly less.
- **Only ADR-0003's confirmed command writes.** A scan never writes, creates, renames or deletes the
  file; the model-facing tools never write to it (ADR-0003:58-61). The scan reads it.
- **The reader is forgiving, the writer is strict** (ADR-0003:124-144). A malformed file costs
  suppressions, never a scan; a malformed existing file is a refusal, never a "repair".
- **Every failure degrades toward showing more findings.** Any unreadable byte, any cap, any version
  mismatch can only make findings visible again — never hide one silently.
- **`.scanignore` keeps precedence, because it runs earlier.** An ignored path is never read, so it
  produces no finding, so it can never be suppressed. The two are different instruments and the file
  order says so (§14).
- **The diff never counts a suppressed site as resolved**, and the report never subtracts a `suppressed`
  count from anything (§13).

## Where this refines the brief it was given

1. **The name and location are already fixed.** The brief asks for "the file name and location";
   ADR-0003 fixed both (`.suppress`, workspace root, `docs/adr/0003-write-surface.md:51-61`, `:63-80`).
   This note restates them once so the two documents cannot drift, then spends its space on contents.
2. **`.suppress`, not a second dotfile per concern.** One file, one grammar, one atomic write.
3. **The hash moves into its own module.** `siteId()` currently lives in `lib/telemetry.js:697-703`,
   the counters module, which `AGENTS.md` keeps filesystem-free and which the scanner must not import.
   C-1 needs the same function in three places (the counters, the scanner, the write command), so it
   moves to `lib/site.js` and `lib/telemetry.js` re-exports it: one algorithm, unchanged public API,
   unchanged golden test.
4. **The file grammar moves into `lib/suppress.js`**, pure like `parseScanIgnore`
   (`lib/scan.js:342-369`): the scanner reads with it, the writer validates with it, and no second
   grammar can drift from the first.
5. **The scanner's "one file" sentence becomes two.** `lib/scan.js:20-21` and
   `docs/notes/legacy-scan-contract.md:206-207`, `:212` say `.scanignore` is *the* one file the scanner
   reads without being asked. After C-1 that sentence is false unless amended: there are two fixed
   workspace-root files. Both are bounded; only `.scanignore` changes what is read. The amendment is
   part of C-1, not a follow-up.
6. **"A reason and a date" stay in the file.** The brief asks for them, and they are what makes the
   entry reviewable — but they are prose in the user's language, so they never enter a report: the
   counters speak ids and numbers, and the panel is a counters view (`AGENTS.md` "Counters are not
   evidence").
7. **"Visible by rule" means a per-rule breakdown of the suppressed count**, not a way to mute a rule:
   ADR-0003 forbids muting "the whole rule" (`docs/adr/0003-write-surface.md:45-47`), and this note
   keeps that refusal.

## 1. The file

- **Name and location: `<workspace>/.suppress`**, at the workspace root, never in a subdirectory, never
  a configurable path. Exactly one target from the session workspace (ADR-0003:63-80).
- **Created only by the command, never by a scan.** A workspace that never mutes never gets the file;
  a scan that finds none reads a missing file as zero suppressions with no diagnostic (the `.scanignore`
  precedent: ENOENT is silence, `lib/scan.js:409-420`).
- **Read once at the start of every scan**, beside `.scanignore` (`lib/scan.js:563`), so an edit takes
  effect on the next scan without a restart. The read is stat-first and bounded (§4).
- **It is not a security boundary and it cannot widen the scan.** `.scanignore` can only make a scan
  read less; `.suppress` changes nothing about what is read. Neither can reach outside the workspace.
- **It does not have to be committed, and it is not machine state.** It belongs to the project: it
  describes this tree's decisions, so a teammate cloning the repository inherits the reasoning (that is
  also its cost — a mute is visible to reviewers, ADR-0003:229-230).
- **The walk never reads it as source.** `extname('.suppress')` is `''`, which is not in `EXTENSIONS`
  (`lib/scan.js:55-67`, `:287-289`), so a dot-file with no extension is skipped as `extension` when the
  walk meets it — the same way the ignore file is counted (`docs/notes/legacy-scan-contract.md:265-266`).
- **One file, one format, one writer.** No per-directory suppression files, no merging of several.

## 2. The exact JSON

```json
{
  "version": 1,
  "entries": {
    "96cb61de": {
      "reason": "legacy demo page, tracked in #412 and kept until the redesign lands",
      "at": "2026-11-11"
    }
  }
}
```

Member by member:

| member | type | written by | read as | matched? |
| --- | --- | --- | --- | --- |
| `version` | number, `1` | the writer | any other value is `version` and nothing is muted (§3) | no |
| `entries` | object, key = `siteId` | the writer appends one key | only eight-lowercase-hex keys are entries | **yes, the key alone** |
| `entries[k].reason` | string, 1–200 characters, one line | the writer, clamped | advisory | no |
| `entries[k].at` | string, `YYYY-MM-DD` | the writer, host clock | advisory | no |

- **Three things and no more: the hash, the reason, the date.** ADR-0003 fixes the list
  (`docs/adr/0003-write-surface.md:141-144`): an entry never carries the path, the snippet or the line
  number the finding came from, because a policy file is not a second copy of the evidence. That is why
  this note has no path cap and no rule field — the ADR already refused them.
- **The key is the identity and the only matcher.** Everything else is commentary, so a corrupted
  `reason` cannot mute anything, a hand-edited key that matches nothing mutes nothing, and there is no
  second field whose mismatch could make "suppressed" and "still open" disagree.
- **A map, not an array.** A duplicate site is impossible by construction (a second append is a benign
  "already there", ADR-0003:116-118) and lookup is one `Set` hit per finding.
- **`at` is a day, not a timestamp.** The file is a log read in a diff; a day is enough, and it is the
  same resolution `scanByDay` uses (`docs/notes/scan-history-contract.md:137-157`). It is the host
  clock at write time, not the finding's first-seen date — the counters know that one, and the file
  must not claim it.
- **The reason is the only human text, and it is load-bearing for review.** Without a path, the recall
  cue for `96cb61de` is the sentence the person wrote next to it; the hash is locatable from the scan
  that reports it and from the chat row (`docs/adr/0003-write-surface.md:239-241` accepts exactly this
  cost). A missing reason still mutes (§3) — the identity is the decision, the prose is the note.
- **Unknown members survive a scan and are lost on the next write.** The writer serialises the parsed
  model canonically, so a hand-added extra member is not preserved and never matched. That is safe
  because a format change must bump `version`, and the writer refuses a version it does not know (§3)
  instead of rewriting it.
- **Canonical serialisation the writer must produce**: `JSON.stringify(document, null, 2)` plus a
  trailing newline, `version` first, `entries` sorted by key. Deterministic output is what makes "a
  failed write leaves the file byte-identical" checkable (ADR-0003:212-213) and a diff one line.
- **Why not NDJSON?** One entry per line would append without a rewrite, but it is not "the exact JSON
  shape" the brief specifies and it loses the single-document `version` check. The rewrite is safe
  because the writer only ever rewrites a file it fully parsed and its version it knows.

## 3. Reading: what happens to a bad file

The reader is forgiving in exactly one direction: a broken file means fewer mutes, never a failed scan
and never a hidden finding.

| condition | entries honoured | problem token | scan |
| --- | --- | --- | --- |
| file absent | 0 | none | runs, no line printed |
| unreadable (EACCES, a directory, a link loop) | 0 | `unreadable` | runs, says so |
| larger than `MAX_SUPPRESS_BYTES` | 0 | `too-large` | runs, says so (checked before the read) |
| not JSON, or not an object, or no usable `entries` object | 0 | `malformed` | runs, says so |
| `version` is not `1` | 0 | `version` | runs, says so |
| a key that is not eight lowercase hex | that entry dropped | `invalid` for that key | runs, says so and applies the rest |
| an entry value that is not an object | that entry dropped | `invalid` for that key | runs, says so and applies the rest |
| a valid key with a missing or blank member | the entry is kept | none | the missing member reads as `''` |

Rules behind the table:

- **A bad entry is one entry.** "Ignore the bad entry, keep the good ones" is per entry, never
  per file: one typo must not unmute five hundred decisions. A file-level failure (unparsable, wrong
  version, oversize, unreadable) is the only all-or-nothing case, because there is no entry to trust.
- **Nothing is ever repaired, guessed or partially written.** The reader never rewrites; the writer
  never repairs (ADR-0003:124-144).
- **The safety direction is monotone.** Every row above can only add findings to the screen. No row can
  remove one. That is the property the tests pin (§19), not each individual row.
- **A missing `reason` does not unmute.** The identity is the decision; the reason is commentary. A
  hand-edited entry with a key and no reason still mutes, and the file is the place to fix the prose.
- **Problems are a list, capped, and never file skips.** `MAX_SUPPRESS_PROBLEMS = 20` — the
  `MAX_IGNORE_PROBLEMS` precedent (`lib/scan.js:71-72`): a corrupt file must not flood a report, and
  problems never enter `skipped`, `skippedTotal` or `skippedByReason` (the `.scanignore` rule,
  `docs/notes/legacy-scan-contract.md:104-119`).
- **BOM and decoding.** A leading BOM is stripped before parsing, like the ignore file's text is
  normalised (`lib/scan.js:423-427`); a file that is not valid UTF-8 is `malformed`, not a crash.
- **A bad entry's finding comes back on screen by itself** — the user sees the site they thought they
  muted. The JSON problem list exists for the writer (it refuses to append into a file with bad
  entries) and for tests; the text renderer reports the file-level failures (§7).

## 4. Caps, and what happens past them

| cap | value | enforced where | past it |
| --- | --- | --- | --- |
| `MAX_SUPPRESSIONS` | 200 entries | the writer, before the write | refuse (`cap`), print the headroom, leave the file untouched (ADR-0003:148) |
| `MAX_REASON_CHARS` | 200 characters, one line | the writer, at composition | clamped before the plan, so the plan shows the exact entry that will be written; a reader never rejects on reason length (ADR-0003:144) |
| `MAX_SUPPRESS_BYTES` | 256 KiB | the reader, stat-first | nothing is muted, one `too-large` problem |
| `MAX_SUPPRESS_PROBLEMS` | 20 problems | the reader | the list is capped; `suppressed` is still counted honestly |

- **The entry cap is a refusal, never a truncation.** The writer either appends the entry or writes
  nothing; there is no "wrote 199 of 200". The command prints the count, the cap and the headroom in
  the plan so the number is visible before the confirmation (ADR-0003:93-95).
- **Why 200.** `maxFindings` is 200 (`lib/scan.js:90`): one scan can never display more muted sites
  than it can display findings, so a list longer than that cannot be exercised by a single scan. A
  project whose suppression list passes 200 has a policy problem, and a refusal names it.
- **Caps belong to the writer; the reader has only a byte guard.** A hand-edited file with 300 valid
  entries is still read in full (up to the byte guard) and all 300 mute — the reader must not silently
  unmute what is on disk. The next *write* refuses with `cap` until the list is pruned by hand. This is
  the one place where "strict writer, forgiving reader" is visible in both directions.
- **The caps compose with room to spare.** A writer-compliant 200-entry file with 200-character reasons
  is 54,037 bytes (measured: §16) — under the 256 KiB guard with 4.7× headroom — so a file the writer
  produced can never be one the reader refuses.
- **The reason cap is a review budget, not a storage limit.** Two hundred characters is a sentence and
  a half; a longer reason is a design document and belongs in the issue the reason names. The clamp is
  visible in the plan, so nothing is shortened behind the user's back.

## 5. Where it is applied, and what it may not change

- **Read** at the start of `scan()`, beside the ignore file (`lib/scan.js:563`), after the paths are
  resolved and validated, before the walk. A missing file costs one failed read — the same as a missing
  `.scanignore`.
- **Applied after the findings array is final**, after the caps (`lib/scan.js:830-836`) and before the
  result literal (`:839-852`): for each returned finding compute `siteId(finding.path, finding.ruleId,
  finding.snippet)`, always attach it as `finding.siteId`, and when the key is in the file set
  `finding.suppressed = true` and bump the count.
- **The scanner never filters.** No `findings.filter(...)`, no early `continue`, no second array. The
  only mutation is two members on an object that is already in the array. This is load-bearing for §13:
  the counters' `sites` map and the diff are built from `findings`, so a filtered finding would
  disappear from the comparison and a mute would read as a fix.
- **`guides` keeps counting muted findings.** `summarizeGuides()` (`lib/scan.js:446-455`) runs on the
  same array: the guide list answers "what would I load for these findings", and a muted finding is
  still one. Excluding them would be a second, hidden filter.
- **Only returned findings can be marked.** A scan cut by `maxFindings` may under-count:
  `suppressed <= findings.length` always holds, and a truncated scan's `suppressed` describes the
  returned list. A truncated scan is already a partial report (`truncated: true`); this is one more
  reason its numbers are floors, not totals.
- **Cost.** One eight-hex hash per finding over a snippet of at most 160 characters
  (`lib/scan.js:85-95`); at 200 findings that is microseconds, and the counters already pay the same
  hash (`lib/telemetry.js:928-948`).

## 6. The scan result

Additive, after `truncated` so the existing member order is untouched:

```js
{
  scanned:  { /* unchanged */ },
  findings: [
    { /* path, line, column, ruleId, guideId, confidence, message, snippet, lines, occurrences */
      siteId: '96cb61de',      // always, eight lowercase hex
      suppressed: true },      // only when muted; absent otherwise
  ],
  guides:   [ /* unchanged, muted findings included */ ],
  truncated: false,
  suppressed: 3,                                    // always, 0 included
  suppressProblems: [ { key: null, reason: 'malformed' } ],   // only when non-empty
  suppressions: { entries: 5, matching: 2, unused: ['96cb61de', '0a1b2c3d'],  // 0.12.0, ADR-0004
                  items: [ { siteId: '96cb61de', date: '2026-11-01', reason: 'one page only', matched: true },
                           { siteId: '0a1b2c3d', reason: 'stale', matched: false } ] },
}
```

- **`suppressions` is the review, and it is attached only when one could be computed** (0.12.0, §22):
  absent when there is no suppression file, when the file cannot be read, or when the value is an
  error. Present when a file was read and joined against this scan. `unused` is **`null`, never `[]`**,
  for a scan that could not prove absence (truncated, hit a cap, zero files, or fewer files than the
  baseline), so "0 unused" stays a claim a complete scan earns and nothing else gets for free.
- **`items` is the file, `unused` is the verdict** (added with the panel's review block): one row per
  honoured entry, carrying the file's own `at` and `reason` verbatim (trimmed and clamped to the same
  40/200 budget the writer enforces) and `matched`. `matched` is `true`/`false` only for a complete scan
  and `null` otherwise — the row-level spelling of `unused`, never `false` for "cannot say". A field the
  entry does not store is **omitted, not empty**, and there is no rule id: the file keeps a one-way hash,
  so a rule id could only be invented. Above `MAX_SUPPRESSIONS` the rows are omitted rather than
  truncated, because a prefix would read as the whole file. A host that predates `items` is a valid
  block, and the panel falls back to listing `unused`.

- **The same word at two depths**: a number on the result, a boolean on the finding. `suppressed === 3`
  at the top, `suppressed === true` on a finding; never a count on a finding and never a boolean at the
  top. Consumers can tell them apart by type, not by guessing.
- **`suppressed: 0` is written, not omitted.** A completed scan did read the file; "zero" is a fact. A
  pre-C value has no such member and reads as absent — and the renderers show nothing for both, so the
  absence costs nothing on screen.
- **`suppressProblems` is written only when non-empty**, like `ignoreProblems` is always present but
  usually empty: absent means none, so a JSON consumer does not need to test for `null` and a text
  consumer does not print an empty line.
- **`siteId` is on every finding, mute or not**, because the panel needs a target to offer muting even
  when no file exists yet — that is exactly when the first suppression is written.
- **The scan does not gain a flag.** Suppression applies because the file exists, not because a caller
  asked. §20 records the refused `--no-suppress`.

## 7. The text renderer (`index.js:171-266`)

Three additions, each absent on a pre-C value, so a pre-C scan renders byte-identically:

1. **The summary line** (`index.js:200-201`) gains a clause only when the count is positive:
   `Scanned 70 file(s) (48 kB) — 85 finding(s), 3 suppressed.` Zero → the line is exactly today's.
2. **A problem line** beside the `.scanignore` diagnostics (`index.js:218-228`), one per shape:
   - file level: `Suppression file: malformed; nothing is muted this scan.` (the token is raw, like a
     skip reason: `unreadable`, `too-large`, `malformed`, `version`)
   - entry level: `Suppression file: 2 entries ignored; the rest applied.`
   Both are absent when there is nothing to say; neither is a skip line.
3. **A row suffix** on each muted finding (`index.js:233-244`): `- src/app.css:12:5 ls-13 (high) … (suppressed)`.
   The collapsed-run location is untouched, so a muted run still prints its range.

` (suppressed)` is the one machine-readable marker in the text, and the client text parser strips it
back into the flag (§12); therefore it goes **after** the message, never inside it, and the message is
never reworded to mention it.

**0.12.0 adds no fourth line here.** A review is a statement about the *file*, not about the scan the
text is describing, so the scan text stays byte-identical to 0.11.0 and the review is read on the stats
surface (§9, §22) and in `--review`. `test/suppress.test.mjs` fails if a `Suppressions:` line appears.

## 8. The counters

- **`classifyCall`** (`lib/telemetry.js:895-970`): on a completed scan, count
  `suppressed = findings.filter((f) => f.suppressed === true).length` and
  `suppressedRules` from the same subset; use `finding.siteId` when it is eight hex, otherwise compute
  it from path/rule/snippet (the B-3 fallback, `docs/notes/scan-history-contract.md:279-297`). The
  `sites` map is built from **all** findings, unchanged — that is the diff guarantee.
- **`lastScan`** (`lib/telemetry.js:281-296`, `:1260-1320`) gains:
  - `suppressed`: number, written on every completed scan, `0` included;
  - `suppressedRules`: `{ ruleId: count }`, at most ten by count desc (`topRuleCounts()`,
    `lib/telemetry.js:314-327` — reused, not re-implemented), written only when non-empty.
  On read, `suppressed` is clamped to `findings` (a subset cannot exceed its whole) and anything
  non-numeric reads as absent.
- **History rows** (`lib/telemetry.js:1266-1275`, read at `:1108-1129`) gain `suppressed`: number, `0`
  included. It costs 15 bytes per row and makes "when did the muting start" visible in the Recent
  scans block.
- **`scanByDay` does not change** (`lib/telemetry.js:1261-1264`): the series measures scan volume, and
  a mute is not volume.
- **No lifetime counter.** `scanRules` already counts a muted finding, because it is a finding; a
  lifetime "suppressed" sum would count the same site on every scan and answer nothing. ADR-0003 also
  forbids counting the write (ADR-0003:150-152): the only suppression numbers are per scan.
- **Aggregating workspaces never sums** (`lib/telemetry.js:1029-1040`): the newest bucket's own
  `lastScan` object travels with its members, so an aggregate report shows the newest scan's mute count,
  not a total of every workspace's. One scan's count is not a total.
- **A refusal writes nothing**: an errored or refused call never touches `lastScan`
  (`lib/telemetry.js:646-658`), so it cannot add or clear a suppression count.
- **The review rides on `lastScan` too** (0.12.0, `suppressionReviewOf()`): `suppressions: { entries,
  matching, unused, items? }`, validated at the door and clamped on read. `unused: null` survives as
  `null` — it is the value that says "this scan could not prove absence", and `[]` is a different,
  stronger claim. A block that cannot be read is dropped **whole**, never turned into three zeros, and
  the version stays `1`: a pre-0.12.0 document renders exactly what it rendered before the member
  existed. `items` is copied rather than aliased on read, so a panel that annotates a row cannot edit the
  record, and a malformed row or a non-boolean `matched` is dropped or `null`ed at both doors — never
  coerced to `false`.

## 9. The report

**Text** (`lib/report.js:647-769`), immediately after the last-scan line (`:693-713`) and before the
comparison line (`:717-718`), only when the last scan's count is positive:

```
Suppressed: 3 in the last scan (ls-13 2, ls-08 1) - muted, still findings
```

- Never a zero, never an empty line, never "0 suppressed".
- The rule list is raw ids with counts, at most `MAX_SCAN_RULES_SHOWN = 5` (`lib/report.js:26`), the
  same budget the ranked rule list uses.
- "in the last scan" is not decoration: the number belongs to one scan, and the phrase stops it being
  read as a lifetime total.
- "muted, still findings" is the sentence the whole note exists for. It never says "resolved",
  "accepted", "fixed" or "ignored".

**JSON** (`lib/report.js:836-889`): the members ride on `lastScan`
(`lib/report.js:451-469`, `:867-868`):

```js
lastScan: { at, files, findings, rules, skipped, truncated, branch?, suppressed: 3,
            suppressedRules: { 'ls-13': 2, 'ls-08': 1 },
            suppressions: { entries: 5, matching: 2, unused: ['96cb61de'] } }   // 0.12.0
```

- **`suppressions` is the review, and it is the only 0.12.0 addition** (`lib/report.js:487`,
  `:503`): three members, `unused` a sorted list of eight-hex ids or `null`. It rides inside
  `lastScan` beside the counts it qualifies — the report has no top-level suppression block, for the
  same reason it has no top-level `suppressed`. The text report gains no line: a review is a
  statement about a file, and the row that shows it is `--review` (and, when the panel grows one, the
  panel). A pre-C document has no member and renders exactly as 0.11.0 did.

- **No top-level `suppressed`.** One number, one place: the snapshot's `lastScan` is a spread
  (`lib/telemetry.js:1612`), so a second copy would be a second thing to keep in step. The scan's own
  result is top-level because it describes one scan; the report describes many things of which one is
  the last scan, and the count rides there.
- A pre-C document has neither member, so the JSON says nothing rather than `0` and the text prints
  nothing.
- **No reason, no path, no snippet** ever enters this document, by construction: the counters only
  receive counts and rule ids.
- The report-side `normalizeLastScan` (`lib/report.js:451-469`) keeps both members only when well
  formed, like every other member it normalises.

## 10. One table for all surfaces

| surface | a suppressed finding shows as | a pre-C input shows |
| --- | --- | --- |
| scan result (JSON) | `findings[i].suppressed: true`, `findings[i].siteId`, top-level `suppressed: N`, `suppressProblems` when non-empty, and (0.12.0) `suppressions: { entries, matching, unused }` | no `siteId`, no flags, no count, no review |
| `/guidance-scan` text | `— 85 finding(s), 3 suppressed.` and ` (suppressed)` on the row | the same text as 0.11.0, byte for byte |
| `/guidance-stats` text | `Suppressed: 3 in the last scan (ls-13 2, ls-08 1) - muted, still findings` | no line |
| report JSON | `lastScan.suppressed`, `lastScan.suppressedRules`, and (0.12.0) `lastScan.suppressions` | no members |
| `/guidance-suppress --review` | one block: every entry with its date and reason, then `Matching the last scan:` / `Unused:` | `No completed scan is recorded…`, and no entry called unused |
| panel, scanner section | the same `Suppressed: 3 (…)` line under the last scan | no line |
| panel, own scan result | the count in the summary, and the tag on the finding's row | no count, no tag |
| chat tool row | the tag `muted` in the rule cell, the row dimmed | no tag, the row as today |

## 11. The panel

- **Reading.** `readLastScan` (`client.js:756-769`) gains `suppressed` (number, default `0`) and
  `suppressedRules` (map, default `{}`); `readReport` (`client.js:875-950`) passes them through. A
  missing member is `0`, which renders no line — never a fabricated "0 suppressed".
- **The scanner section** renders the report line under the last-scan line, using `scan.suppressed`
  with `{count}` and `{rules}` when the count is positive.
- **The panel's own scan result** (`client.js:2038-2060`) gains the count in its summary and a tag on
  each muted row. To make a site selectable at all — the target ADR-0003's confirmation needs — the
  scan result also renders its findings, at most `MAX_TOOL_ROWS = 16` (`client.js:74`), each row
  `rule · place` plus the tag. This is the one place in the panel that may show a path, because it is
  the user's own scan of their own workspace, exactly like the chat row (`client.js:2262-2283`); the
  counters section keeps its "ids and numbers, never a path" rule (`AGENTS.md` "Counters are not
  evidence"). The mute affordance itself is ADR-0003's flow; this note only fixes what a muted row
  looks like and that a muted row offers nothing to mute again.
- **Two new strings**, in `EN`, `RU` and `ZH`, same commit, same order
  (`test/client-locales.test.mjs:97-118`):
  - `scan.suppressed` = `Suppressed {count} ({rules})`
  - `scan.suppressedTag` = `muted`
  The write-flow strings (plan, confirm, refusal) belong to ADR-0003's task, not to this note.
- **Version skew costs a line, never a row.** A pre-C document renders the 0.11.0 panel exactly; a
  pre-C scan value renders rows without a tag. The findings list appears for any host, because the data
  it needs has been in the scan value since 0.5.0 — only the tag depends on C.
- **Never colour alone.** The tag is text, so a muted row is readable without the dimming.

## 12. The chat tool row

- **Reading the value**: `readScanValue` (`client.js:1143-1165`) keeps `suppressed` on a finding and the
  top-level count; `readScanText` (`client.js:1178-1233`) strips the trailing ` (suppressed)` from the
  parsed message into the same flag (the row regex is `client.js:1185`). Both readers must agree, or the
  same call renders differently depending on which path the host answered with — a test pins that.
- **Rendering** (`client.js:2262-2283`): a muted row carries the tag in the rule cell and the dimmed
  style; the place cell keeps its path and the snippet stays in its `title`. The table keeps four
  columns: the tag rides inside the rule cell, so the grid does not shift.
- **The header count stays `findings`**, because a muted finding is still one. Only the per-row tag
  distinguishes them; there is no "85 findings (3 muted)" arithmetic in the header.
- **The problem note**, when `suppressProblems` carries a file-level failure, is one line under the
  table — the same sentence as the text renderer.

## 13. The diff: a suppressed site is present

- **The guarantee.** `classifyCall`'s `sites` map is built from every finding
  (`lib/telemetry.js:928-948`), and `compareSites` diffs that map against `lastSites`
  (`lib/telemetry.js:1277-1319`). A muted finding is still in `findings`, so its key is still in
  `sites`: the site reads `stillOpen` — present in both scans — and can never read `resolved`. The
  comparison guards are untouched.
- **The test this must carry**, in `test/telemetry.test.mjs` (and end to end in
  `test/suppress.test.mjs`):
  1. scan A of a tree with 85 findings, no file → baseline written, `suppressed: 0`;
  2. write one `.suppress` entry for site X of those 85;
  3. scan B of the same tree → `findings` is still 85, `suppressed: 1`, and
     `scanDiff` is `{ resolved: 0, stillOpen: 85, new: 0 }` with `lastScan.suppressed: 1`.
  This is the test the Lead asked for: if suppression is ever implemented as a filter, it fails.
- **A mute that is then fixed is resolved, once.** Fix X → scan C: `resolved: 1`, `suppressed: 0`, and
  X's entry is inert — kept, never an error, never deleted by the scan. Muting does not freeze the
  diff; it only stops a mute from *looking* like a fix.
- **`stillOpen` and `suppressed` are never comparable.** The first counts sites across two scans, the
  second counts findings in one scan; the report never subtracts one from the other and never says "82
  open, 3 of them muted" as if it were arithmetic.

## 14. Precedence against `.scanignore`

- **Order decides, not policy.** The ignore file is read and applied during the walk
  (`lib/scan.js:563`, `:573`): an ignored path produces no finding at all, so no suppression can ever
  match it. An entry naming an ignored path is inert. That is correct, not a conflict: the path is not
  "suppressed", it is not in the scan.
- **An ignored path is never reported as suppressed**, and a suppressed site is never reported as
  skipped. They are different instruments with different counts.
- **The scanner's read promise changes from one file to two.** `lib/scan.js:20-21` and
  `docs/notes/legacy-scan-contract.md:206-207`, `:212` must be amended in the same change: two fixed
  workspace-root files, both bounded, and only `.scanignore` changes what is read. A stale sentence is a
  lie in the code's own documentation.
- **Why muting is not an ignore entry.** `.scanignore` excludes by path, so it hides a whole file's
  findings and cannot express "this one site"; and it hides the finding rather than reporting it, which
  would make the suppressed count impossible. The glossary keeps the two apart (`GLOSSARY.md:63-73`
  for `.scanignore`, `:75-82` for the suppressed finding).

## 15. Reset, retention, and what a scan never does

- **`telemetry.reset()`** (`reset({ scope })`, `lib/telemetry.js`) writes the profile document only. The
  workspace file is untouched, exactly as ADR-0003 requires (ADR-0003:220-221, test 12). C-3 made that
  function targetable — `all`, `scans`, `workspace`, `window` — and **none of the four scopes opens
  `.suppress`**: the narrowest reset and the widest one both leave the mute list standing, because muting
  is not a counter. Each scoped outcome says so in its own sentence, and four end-to-end tests pin it with
  real bytes on disk (see `test/stats.test.mjs`).
- **Retention never touches the project file.** `prune()` (`lib/telemetry.js`) expires
  counters; the entries are lifetime. Losing `lastScan.suppressed` to the window is not losing the mute:
  the next scan restores the count.
- **Unmatched entries are inert and never auto-deleted.** A scan cannot prove a site is gone — it saw
  the paths it was told to walk, not the project — so "not seen in this scan" is never claimed as stale
  (§18).
- **A scan never writes**, and a failed read is a missing mute, never an error.

## 16. Size budget, measured

Measured by building the shapes and serialising them (`node`, 2026-11-11):

| shape | bytes |
| --- | --- |
| `.suppress`, 1 entry, 2-space JSON | 174 |
| `.suppress`, 200 entries, typical (55-char reason) | 27,437 (137/entry) |
| `.suppress`, 200 entries, worst case (200-char reason) | 54,037 (270/entry) |
| parse of the 200-entry typical file | 0.09 ms per parse |
| parse of the 200-entry worst-case file | 0.19 ms per parse |
| scan result, `siteId` + flags, per finding (JSON format only) | ~29 |
| scan result, 200 findings with ids, 3 flags and one problem | +5,786 |
| `lastScan` with `suppressed` and `suppressedRules` (two rules) | +55 |
| one history row with `suppressed` | +15 (×20 = +300) |

- **The profile grows by ~355 bytes per workspace**, not by the file: the list lives in the project.
  Against a 13.2 KB phase-B document that is ~2.7%, and it is bounded, unlike the file.
- **The scan result grows by under 6 KB** on a 200-finding JSON scan (an existing ~81 KB payload);
  the summary format is unchanged except the summary clause.
- **The worst-case file is 4.7× under the reader's guard**, which is why the caps can be checked
  independently (§4). The absence of a stored path is most of the saving: an entry is a hash, a
  sentence and a day.

## 17. Migration

- **`stats.json`: `version` stays `1`.** `lastScan` and history rows gain members that normalise from
  absent (`lib/telemetry.js:281-296`, `:448-456`; `lib/report.js:451-469`). A pre-C document loads,
  renders byte-identically and gains the members on the first C scan.
- **The file: no migration.** Absent is the pre-C state and costs nothing; the first write creates
  `version: 1`; a future format bumps it, and the reader reports `version` instead of guessing.
- **The scan result: additive.** A consumer that reads findings by named members is unaffected by
  `siteId`/`suppressed`; the counters' fallback keeps hand-built test fixtures working
  (`test/site-identity.test.mjs:24-29` builds findings with only path/ruleId/snippet).
- **No file is created on upgrade.** A project that never mutes never sees `.suppress`.

## 18. What this must never claim

1. Never "fixed", "resolved", "accepted", "ignored" or "false positive" for a suppressed finding. It is
   muted, and it is still a finding.
2. Never "not present" — a suppressed site is in `findings`, in `sites` and in the diff.
3. Never that muting reduces the lifetime counts: `scanRules` counts the muted finding too.
4. Never a lifetime suppression total; only per-scan numbers exist.
5. Never that a suppression is a fix in progress, a TODO, or a debt owner. It records a decision, not a
   plan.
6. Never that the file is a security boundary, or that it makes the scanner read less. It reads more
   (the file itself) and mutes on top.
7. Never that an unmatched entry is stale, gone, or an error. A scan sees the paths it was given.
8. Never a locator inside an entry — no path, no snippet, no line, no rule id — and never a reason out of
   the file into `stats.json`, a report or a chat row. The reason is the user's prose in the user's
   language; it lives in the file (ADR-0003:141-144).
9. Never a `suppressed` count that the scan did not produce — no estimate, no carry-over from the last
   scan when this one could not read the file. "Unreadable" means "nothing is muted this scan", and the
   report says so (`suppressed: 0` plus the problem), it does not repeat yesterday's number.
10. Never that suppression is automatic, or that a model asked for it. Only the explicit, twice-confirmed
    command writes (ADR-0003).
11. Never that `.scanignore` and `.suppress` are two spellings of one thing: one hides a path from the
    scan, the other marks a finding the scan still reports.
12. Never that a suppressed site is "the same number" as `stillOpen`: sites and findings are different
    quantities, and no report subtracts them.
13. Never a suppression by line, by file or by rule — only by `siteId` (ADR-0003:45-47).

## 19. Tests each workstream owes

**Scanner (`lib/scan.js`, `lib/suppress.js`, `lib/site.js`) — `test/suppress.test.mjs`, plus additions to
`test/scan.test.mjs` and `test/site-identity.test.mjs`:**

- the file absent → `suppressed: 0`, no `suppressProblems`, findings, `guides`, `scanned` and
  `truncated` byte-identical to a scan of the same tree without the feature;
- a matching entry → the finding keeps its place, its order and its neighbours, gains
  `suppressed: true` and a `siteId` equal to `siteId(path, ruleId, snippet)`; `suppressed` counts it;
- an entry whose key matches nothing → no effect, no problem;
- an entry carrying an unknown member (`path`, `ruleId`, anything a hand edit or a future format left) →
  still mutes, and the member is never matched, never a problem;
- an entry with a valid key and no members at all (`{}`) → still mutes (the identity is the decision);
- a reason longer than `MAX_REASON_CHARS` → the writer clamps it before the plan, and the plan shows the
  clamped entry that will be written;
- `findings.length`, `guides[].findings`, `scanned.*` and the caps unchanged by suppression (the
  load-bearing assertion of §13);
- malformed JSON → all findings visible, one `malformed` problem, `suppressed: 0`;
- one bad key among good ones → the good ones mute, one `invalid` problem, `suppressed` counts the good;
- `version: 2` → nothing muted, one `version` problem;
- a file over 256 KiB → nothing muted, one `too-large` problem, no read of the tail;
- an unreadable file / a directory named `.suppress` → `unreadable`, no throw;
- 200-entry file → all honoured; a 300-entry hand-edited file → all honoured, no silent unmute;
- problem list capped at 20;
- a scan never creates or modifies the file (mtime and bytes before/after);
- the golden `siteId('src/app.css', 'ls-13', '::-webkit-scrollbar') === '96cb61de'` unchanged after the
  move to `lib/site.js` (`test/site-identity.test.mjs:31-36`).

**Counters (`lib/telemetry.js`) — `test/telemetry.test.mjs`:**

- a completed scan stores `lastScan.suppressed` and `suppressedRules` (capped at ten, count desc);
- a pre-C payload without `suppressed` stores `0` and no `suppressedRules`;
- the diff test of §13 verbatim (mute in the middle of two scans → `resolved: 0`, `stillOpen`
  unchanged, `suppressed: 1`);
- fix-after-mute → `resolved: 1` and an inert entry;
- a history row carries `suppressed`, and `scanHistory` rounds trip it;
- a refusal / truncated scan stores no suppression numbers for the refused call;
- `normalizeState` keeps the members, clamps `suppressed <= findings`, drops non-numbers;
- `scanByDay` unchanged by a mute;
- the aggregate snapshot's `lastScan.suppressed` is the newest scan's, never a sum.

**Report (`lib/report.js`, `index.js`) — `test/report.test.mjs`, `test/stats.test.mjs`,
`test/scan-command.test.mjs`:**

- the text line appears only when positive, with the per-rule list, and says "muted";
- a pre-C snapshot renders byte-identically (the existing golden-style assertions);
- `renderJson` carries `lastScan.suppressed`/`suppressedRules` and no top-level `suppressed`;
- the scan text: summary clause, ` (suppressed)` suffix, both problem sentences, and a pre-C value
  byte-identical;
- tool text and command text stay identical (`test/scan-command.test.mjs` drift test).

**Panel and chat row (`client.js`) — `test/client-locales.test.mjs`:**

- both new keys exist in all three dictionaries with the same placeholders and order
  (`:97-118`);
- the scanner section renders the line from `lastScan` and renders nothing when absent
  (the `:316-336` precedent);
- the chat row tags a muted row and leaves a pre-C row untouched;
- the value reader and the text reader agree on `suppressed` for the same call;
- a muted row offers no mute affordance, and a row without `siteId` offers none either.

**The write boundary — `test/suppress.test.mjs` (reader side) and ADR-0003's own list:**

- the scan never writes (covered above) and the reader never creates the file;
- `parseSuppressions(serializeSuppressions(entries))` round-trips, and the serialised form is exactly
  what the reader accepts (ADR-0003:138-140).

## 20. Open questions

1. **Is 200 the right entry cap?** It equals `maxFindings` and keeps the worst-case file 1.6× under the
   byte guard. A larger cap means a larger guard; a smaller one means refusing a list a project might
   honestly need. Measured, not settled by taste — but it is a policy number.
2. **The panel's findings list.** Rendering the scan result's findings is what makes muting reachable
   without showing a path in the counters section (§11). If the Lead prefers the panel to stay
   purely aggregated, the only mute target left is the command, and the tag disappears from the panel.
   The chat row keeps its tag either way.
3. **A `--no-suppress` run?** Refused for now: a scan that ignored the file would report
   `suppressed: 0` while the file still mutes, giving that number two meanings. If "show me everything"
   is needed, it is a separate mode with its own name, not a silence flag.
4. **Should an unmatchable entry be surfaced somewhere ("not seen since…")?** Refused for this phase:
   one scan cannot prove an absence, and phase B already refuses to call an absent site retired without
   a baseline. If it ever ships, it is a counter's claim, not the file's.

## 21. Not in this phase

- **Unmuting from the panel** — the write surface is ADR-0003's, and the one deletion ADR-0004 licenses
  is a confirmed command, one entry per line (§22). A panel button that removes would be a second
  entry point to the same write, and phase E deliberately keeps the panel read-only.
- **Bulk removal, a `--remove --all`, or a prune** — refused by ADR-0004: one entry, one invocation, one
  confirmation, because a bulk rewrite is exactly the "delete something a human wrote" the ADR has to
  licence per action rather than per session.
- **Any list management** (prune, rename, merge, inspect, export) — the file is small, JSON and in the
  repository; a UI for it is C-4 material.
- **Muting a whole rule, a file or a line** — forbidden by ADR-0003:45-47 and by §18.
- **Suppression across workspaces** — a file is per workspace, like the counters' buckets.
- **TTL, expiry, auto-pruning of unmatched entries** — still refused by §15 and §18. An entry is
  retired by a human who has seen the evidence, never by a timer or by a scan that did not see it.
- **Counting writes in telemetry** — forbidden by ADR-0003:150-152, and §22 restates it for the removal.
- **The append command's own grammar** (`--dry-run`, the confirmation, the refusal codes) — ADR-0003;
  the two new forms are ADR-0004 and §22.
- **C-2 (a `.scanignore` writer), C-3 (reset granularity), C-4 (export)** — their own contracts.

## 22. ADR-0004: the review, and the one confirmed removal

ADR-0004 amends ADR-0003's "a write is never a delete" with the narrowest widening it can: **one entry,
one invocation, one confirmed rewrite.** The ADR is the licence; this section is the shape.

### The review (read, `--review`)

```js
suppressions: { entries: 5, matching: 2, unused: ['96cb61de', '0a1b2c3d'] }   // complete scan
suppressions: { entries: 5, matching: 2, unused: null }                      // unproven
```

- `entries` counts every readable entry in the file; `matching` counts the entries whose site id this
  scan produced; `unused` is the rest — **and `null`, never `[]`, when absence is unproven**: a truncated
  scan, a scan that hit a cap, a scan with no files, or a scan that read fewer files than its baseline.
  The rule is phase B's, reused verbatim (`docs/notes/scan-history-contract.md`), because "this scan did
  not see it" is not "it is dead" in either place.
- **A malformed entry is never `unused`.** It is a parse problem, it is reported as one, and it is
  excluded from all three numbers — a line the reader cannot read is not evidence about a site.
- The join happens in `index.js` where the site ids exist (`attachSuppressionReview`), not in
  `lib/scan.js`: the scanner stays a pure reader, and the counters only ever see counts and ids.
- **`--review` prints the file, never a diff.** With a stored review it prints `Matching the last
  scan:` and, when the list is non-null, `Unused:`. Without one it says which evidence is missing and
  reports no entry as unused. It always ends `Nothing was written.` and it takes no `--dry-run`: the
  read half has no mode to ask for.

### The removal (write, `--remove <siteId>`)

- **Grammar:** `/guidance-suppress --remove <siteId>` plans; the same line without `--dry-run` applies.
  Exactly one id, exactly one entry, exactly one confirmed rewrite. Any other combination is a refusal
  with its own sentence: `--review` with `--remove`, `--review` with a site id, `--review` with
  `--reason`, `--review` with `--dry-run`, `--remove` with no id, `--remove` with a second id,
  `--remove` with `--reason`.
- **A cut, not a rewrite.** The member's bytes and exactly one separator are removed from the text; every
  other byte, the file's formatting, its unknown members and its malformed entries survive untouched.
  The result is re-parsed through the file's own parser before the rename, so a cut that would leave a
  file the reader cannot read is refused (`unwritable`) rather than written. Temp file + rename, one
  fixed path, no symlink followed — the same writer discipline as the append path.
- **Three answers, and the third is the point:** `removed` (the site is no longer muted; the next scan
  counts it as a finding again), **`absent`** (a named no-op: `Nothing to remove: <id> is not in
  <file>, which holds N entries; nothing was written.` — not an error, not silence), and a **refusal**
  (`malformed`, `version`, `too-large`, `unreadable`, `unwritable`) which leaves the file byte-identical.
- **A removal is not a fix, and it moves no counter.** It un-mutes a finding; it says nothing about
  whether the finding went away, and nothing about what a previous scan reported. No counter, no
  `lastScan` member, no history row changes — `test/stats.test.mjs` compares the counters document byte
  for byte across a removal, and `test/suppress.test.mjs` compares the file before and after.
