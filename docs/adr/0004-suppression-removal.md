# ADR-0004: the suppression list can be reviewed, and one entry removed

- **Status:** accepted
- **Date:** 2026-11-11
- **Amends:** [ADR-0003](0003-write-surface.md) §8, whose first sentence is *"Never a delete or a
  rename"*. This ADR licenses exactly one deletion, of exactly one kind of thing, and keeps every other
  clause of ADR-0003 standing. Also amended in the same change: `AGENTS.md` (the scanner bullet and the
  Client-half write list), `audit/security.md` (§F11), `docs/notes/suppression-contract.md` §15, and the
  phase-E acceptance note that anticipates this ADR (`docs/notes/phase-e-scope.md` §"E-3").

## Context

Phase C gave the product its first write into the user's project: one entry appended to
`<workspace>/.suppress`, naming one code site by `siteId` ([ADR-0003](0003-write-surface.md)). That list
is **append-only and capped at 200 entries** (`MAX_SUPPRESSIONS`). The cap is what turns a stale entry
from an inconvenience into a failure: at 200 entries the next mute is refused, and the only way out is a
text editor and a JSON document keyed by eight-hex hashes.

A suppression goes stale by itself, and silently. Its key is
`siteId(path, ruleId, snippet)` — edit the snippet by one character and the site id changes. The mute
stops matching, the finding comes back **as new**, and the entry keeps sitting in the file pretending to
be one of the 200 decisions the project has made. Nothing in the product can answer the only question
that matters about such a record: *does this still describe anything?* Phase E is that question
(`docs/notes/phase-e-scope.md`), and this ADR is the half of it that removes something.

Three facts constrain the design, all true in this tree:

- **A suppression is content-addressed, so it can be joined.** A scan's findings carry the same
  `siteId()` the file is keyed by, and `classifyCall` already builds a site map with a completeness flag
  (`lib/telemetry.js`, `sites`/`sitesComplete`, used by B's comparison). The join needs no new identity
  and no second parser.
- **The scanner already knows when it cannot testify.** B settled the rule for absence: a truncated or
  narrowed scan says *not comparable*, never "resolved" (`docs/notes/scan-history-contract.md`). "Unused"
  is an absence claim and inherits that rule exactly.
- **ADR-0003 drew the deletion line on purpose.** §8: *"Never a delete or a rename."* This repository
  does not cross a stated line quietly, so the crossing gets an ADR; the question is only whether the
  deletion can be made as narrow as the append.

## Decision

### 1. A review is a join, and half of its answer is "I cannot tell"

The scan joins the file it just read against the findings it just produced, and the result is one
additive block:

```
suppressions: {
  entries: number, matching: number, unused: string[] | null,
  items?: [{ siteId: string, date?: string, reason?: string, matched: boolean | null }],
}
```

- `entries` counts the entries the file's own parser **honours**. An entry the parser drops is a parse
  problem, reported as `suppressProblems` and never counted here — and never called unused.
- `matching` counts entries whose `siteId` is in this scan.
- `unused` lists the rest — **and is `null`, never `[]`, whenever the scan cannot prove absence**: it was
  truncated at a cap, it read zero files, a finding arrived without a usable identity, or it read fewer
  files than the previous scan. `[]` is a claim that every entry still matches; only a complete scan may
  make it. An incomplete scan says *unknown*, and the sentence it prints says why.
- `items` (added the same day, after the panel showed that three numbers cannot list a file) is one row
  per honoured entry carrying what the file itself stores: the `siteId`, its `at` as `date`, its `reason`,
  and `matched`. **`matched` is the row-level spelling of `unused`**: `true`/`false` only when the scan was
  complete and could have seen that site, `null` otherwise — never `false` as a stand-in for "cannot say".
  A field the entry does not carry is **absent**, not empty, and there is deliberately **no rule id**: the
  file keeps `{ reason, at }` under a one-way hash, so a rule id could only be invented. Rows are omitted
  entirely above `MAX_SUPPRESSIONS`, because a truncated prefix would read as the whole file while the
  counts and `unused` still tell the truth. `items` is optional: a host without it is the 0.12.0 block.
- The block rides on the scan value, and from there into the workspace's `lastScan` in the profile
  document, `version` still `1`. It becomes visible on exactly two surfaces: the **stats** JSON
  (`lastScan.suppressions` in `renderJson`) and `/guidance-suppress --review`. **The scan text gains no
  line**: the scan's own words answer "what did this scan find", while a review is a statement about the
  file, and a fourth line there would be a claim about a file on a surface titled `Scanned N files`.
  A document written before 0.12.0 has no block, and a review over it is the absence path below, not a
  zero.
- **Computing a review writes nothing and moves no counter.** It is a read of two things the product
  already holds, joined.

### 2. `/guidance-suppress --review` prints the list, and has no mode in which it writes

```
/guidance-suppress --review
```

One command line, no selector, no `--dry-run` (the absence of a write is not a mode to ask for) and no
`--yes`. It prints, per entry: the site id, the date the entry records, the reason the person typed, and —
**only when the counters can prove it** — whether this scan matched it. Where it cannot prove it, it says
so in words and leaves the entry unmarked.

- **The absence path is a state, not an error.** With no stored block (a pre-0.12.0 counters document, or
  a last scan that could not testify) the review prints the entries it can read and the count the counters
  can prove, and states plainly that which entries the scan did not see is unknown. It never falls back to
  calling them unused: that is the exact lie the whole phase exists to prevent, and the two ways of
  reaching this state are indistinguishable to the plugin, so they get one sentence.
- A malformed entry is listed as a **parse problem**, with its key as far as it can be quoted, and is
  never counted, matched or called unused.
- **A review never writes.** Not the file, not the profile document, not a cache invalidation. A review
  that mutated anything would be the silent write ADR-0003 §3 forbids, dressed as a read.

### 3. One entry, one invocation, one confirmed rewrite

```
/guidance-suppress --remove <siteId> --dry-run   the plan, writes nothing
/guidance-suppress --remove <siteId>             removes exactly that entry
```

Plan-then-apply, the protocol ADR-0003 §4 fixed: the plan names the absolute file, the entry it would
remove (its date and reason, so the confirmation is of a payload and not of an intention), the count
before and after, and says nothing has been written; the same line without `--dry-run` applies it.

The rewrite is bounded by five rules, and each one is a test:

- **Exactly one entry, named by the caller.** No bulk removal, no glob, no `--all`, no "remove everything
  unused", no automatic expiry, no removal of an entry the person did not name.
- **Every other byte is preserved.** The file is edited by cutting the one member out of its text, not by
  re-serialising a parsed model: order, unknown members, hand formatting, comments a future format may
  add and malformed entries the parser dropped all survive. ADR-0003 §6's rule — the writer never tidies
  what it did not write — applies to the removal unchanged.
- **The writer obeys its own reader.** The resulting text is re-parsed through `parseSuppressions` before
  the rename; the entry set must equal the old set minus exactly one, and the problem list must be
  untouched. A mismatch is a refusal and the original file is not replaced.
- **Temp then rename, and a failure is a no-op.** The bytes land in a sibling temp file and are renamed
  over the target; a failed write leaves the file byte-identical and the temp removed.
- **One fixed path, as before.** The workspace comes from the invocation's session header and the
  filename is the literal `.suppress`; no caller-named byte is ever a path component, and a symlinked,
  unreadable or oversized target is refused rather than followed.

### 4. A named no-op is not an error, and a refusal is not a no-op

- **The target is absent** → a success that says so: nothing was removed, the file is unchanged, and the
  count it holds is printed. Reporting this as an error would train a reviewer to ignore errors.
- **Refused before the file is opened** — an id that is not eight lowercase hex characters, two targets in
  one line, `--remove` with a `--reason`, `--review` with a selector, no session workspace, a target that
  is a symlink or outside the workspace, a file that does not parse, a file past the size guard, a failed
  write. Each is a distinct code and a distinct sentence, `kind: 'error'`, and the file is untouched.
- A file with **entry-level** problems is not refused: the removal preserves what it cannot read and the
  result is verified against the same problem list. Only a file-level failure — unparsable, unknown
  version, no `entries` object — refuses the removal, because there is no structure to cut.

### 5. A removal is not a fix

**Deleting a suppression un-mutes a finding. It says nothing about whether the finding went away.**

- **No counter may move because of a removal.** Not `scanRules`, not `scanGuides`, not `lastScan`, not its
  `suppressed` count, not the review block already stored on it, not the day series, not the recent ring,
  not the profile document's bytes. The plugin's numbers keep what the scan reported to them; the next
  scan is the first thing allowed to change them.
- **The outcome text says exactly what changed**: the id, the file, the count before and after, that the
  site is no longer muted, that the next scan will count it as a finding again, and that no counter has
  changed. "Removed" is never rendered as "resolved", "fixed" or "gone".
- **The stored review block is a statement about its own scan** and a removal does not retro-edit it. See
  the residual below; it is the one place where the product knowingly keeps a number that a later action
  has made out of date, and the review says so instead of hiding it.

### 6. The one honest residual

**A removal cannot undo what a previous scan already reported.** The workspace's `lastScan` keeps the
`suppressed` count, the rule split and the review block that its scan produced, because a record of what
a scan saw is not a live view of the file. After a removal, the report still prints "1 suppressed" for
that scan until the next scan runs and mutes nothing — at which point the number becomes `0` honestly,
by measurement rather than by invitation. A product that silently rewrote the last scan's numbers to
match a newer file would be editing evidence, and the review is the one surface whose whole value is
that it does not.

Second, smaller residual, stated for the same reason: the review block stored on `lastScan` is computed
once, at scan time. A file edited by hand after that scan is reviewed by `--review` (which reads the file
fresh) but not by the panel row until the next scan — and the review marks those entries from the stored
join, so a hand-added entry simply reads as unmatched-by-that-scan rather than as invisible.

## Consequences

### The promises this costs, and whether they survive

- **ADR-0003 §8 ("Never a delete or a rename")** — *does not survive as written*. It becomes: never a bulk
  delete, never a rename, never an automatic or scheduled delete, never a delete on the scan, review or
  report path, and exactly one confirmed removal of one named entry. Everything else in §8 stands.
- **"The mute list is append-only"** (`docs/notes/phase-e-scope.md` §"Today", `AGENTS.md`) — *does not
  survive*: it is now append-and-one-confirmed-removal, which is what makes `MAX_SUPPRESSIONS` a promise
  rather than a trap.
- **"The writer never repairs what it cannot parse"** — *survives*: the removal preserves malformed
  entries and refuses a file-level failure.
- **"Reset never touches project policy"** — *survives*: a counter reset still leaves `.suppress`
  byte-identical; the two deletions in the product stay separate commands with separate targets.
- **"The panel still invents no data"** — *survives*: the review row, when it lands, renders the host's
  numbers and prints a guard token when the host sent none.
- **`version: 1`** — *survives*: the block is additive, absent on an old document, and the next flush
  never rewrites what it did not read.

### Documents that must change

| Document | Change |
|---|---|
| `docs/adr/0004-suppression-removal.md` | this file; amends ADR-0003 §8 |
| `docs/adr/0003-write-surface.md` | §8 gains one sentence pointing here |
| `audit/security.md` | an append-only §F11: the surface is now "append and one confirmed removal" |
| `AGENTS.md` | the scanner bullet ("append-only" → reviewable and removable by one confirmed command) and the Client-half write list, if the panel ever offers the action |
| `docs/notes/suppression-contract.md` | §6, §7, §9, §10 gain the block and the "no scan line" decision; §21 stops saying the surface is append-only; §22 is the new review/removal contract |
| `GLOSSARY.md` | **Unused suppression** (an entry no complete scan matched) — the word that must never drift into "fixed" |
| `docs/notes/phase-e-scope.md` | §"E-3" accepted; its proof list is the test list below |

### Tests the implementation must carry

1. **`unused` is `null`, never `[]`, for an incomplete scan**: a truncated scan, a scan of zero files, a
   scan whose finding carries no identity, and a scan that read fewer files than the previous one each
   produce `unused: null` — and the text says unknown.
2. **A complete scan reports exactly**: a stale id is listed, a matching entry is not, and a malformed
   entry is a problem rather than an unused id.
3. **`--review` never writes**: byte-identical file and profile document before and after, including the
   absence path (no stored block) and the malformed-entry path.
4. **`--review` with no stored block lists what it can prove** and states, in words, that the rest is
   unknown — never that everything is unused.
5. **`--dry-run` writes nothing**: no temp file, no mtime change, the exact entry in the plan.
6. **An apply removes one entry and preserves every other byte**, including order, an unknown member and
   a malformed entry, compared literally.
7. **The result re-parses to the same set minus one**, with the same problem list.
8. **An absent target is a named no-op**: success, nothing written, byte-identical.
9. **Refusals are distinct and write nothing**: not-a-site-id, two targets, `--review` with a selector,
   `--remove` with `--reason`, unparsable file, symlinked target, unreadable target, failed rename.
10. **A removal moves no counter**: the profile document's bytes, the report's text and the last scan's
    `suppressed` count are identical before and after.
11. **A removal makes the next scan count the site again**: the finding is no longer suppressed, and its
    `siteId` still resolves to the same identity.
12. **`version` stays `1`** and a document without the block renders the 0.11.0 surface. Carried by
    `test/telemetry.test.mjs` (a stored review is additive; a corrupt one is dropped on load, never read
    as zeros) and `test/report.test.mjs` (the JSON block, its clamping, and its absence on an old
    document — the text report grows no line).

### Costs accepted, plainly

- **A removal is not undoable.** The entry is gone; the reason and the date go with it. The plan shows
  them first, which is the only mitigation the product can honestly offer.
- **A removal can lose a mute that was still wanted.** If a person removes an entry the scan matched, the
  finding comes back as a finding — which is the truth, and worse for them. The plan prints whether this
  scan matched it, so the choice is informed when the evidence exists.
- **The review can be stale, and says so.** See the residual.
- **One more command line, one more confirm step, and the writer's strictness** (a byte-preserving cut, a
  re-parse guard, a temp file) — three small pieces of machinery in exchange for not losing a list a
  person wrote.
- **A cross-process race can still lose a concurrent append**, exactly as ADR-0003 accepted; the removal
  adds no lock file either.

## Alternatives considered

- **Stay append-only; let a person hand-edit the file.** Rejected: hand-editing a JSON keyed by eight-hex
  hashes is not a workflow, and the cap then refuses the next mute with no in-product way out.
- **Automatically expire entries whose site the last scan did not see.** Rejected: a scan cannot prove a
  site is gone — it saw the paths it was told to walk, not the project — so this is deletion on suspicion,
  and it is a timer deleting records, which the phase's spine forbids.
- **"Remove everything unused" in one confirmation.** Rejected: one confirmation for N deletions is the
  bulk write ADR-0003 §8 refuses, and `unused` may be `null` — a command that deletes what it cannot list
  is the exact failure mode this ADR exists to prevent.
- **Rewrite the file from a parsed model.** Rejected: it destroys hand formatting and silently drops the
  malformed entries the parser tolerates, which is "repair" by another name.
- **Store the review only in the profile document and never in the scan value.** Rejected: the panel, the
  chat row and the command would then need three readings of one fact, and the scan value is where the
  site ids actually exist.
- **Compute `unused` from `lastSites`** (the comparison baseline). Rejected: `lastSites` is the last scan
  that could testify, not the newest scan, so it is stale exactly when the newest scan was partial —
  producing confident numbers precisely when the evidence is weakest.
- **A removal tool for the model, or a `--remove` that takes a rule id.** Rejected: the first turns a
  report into a verdict; the second deletes a decision about a site nobody named.
- **A silent `--yes`-free default that removes the newest unused entry.** Rejected: a removal must name
  what it removes, or it is the silent deletion the last three phases spent their time forbidding.
