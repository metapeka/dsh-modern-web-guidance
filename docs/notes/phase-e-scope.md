# Phase E — Auditable: does this record still describe anything? (scope)

Status: **proposed**. This note fixes the phase's contract and nothing else — no code, no test and no
state change lands with it. The inputs are the two things the shipped phases left behind on purpose:
the honest deviations in [`docs/ROADMAP.md:417-428`](../ROADMAP.md) and the six open questions at
[`docs/ROADMAP.md:447-466`](../ROADMAP.md).

## The decision

**Phase E is not reach. It is the review of what A, D, B and C already keep.** Four durable records
now exist — a workspace bucket, a suppression entry, a `.scanignore` line, a lifetime counter — and
three of the four can only be created. A suppression is added and never removed, an ignore line is
written and never read back, a lifetime total never says when it started. In each case a record that no
longer describes anything is indistinguishable from one that does, and the user has no way to find out
or to retire it. E gives those three records one question (*does this still describe anything?*) and
one answer (*here is what it was for, and here is how a human retires it*).

Reach was the alternative and it loses on merit, not on taste. More rules means more findings for a
panel whose finding list is already capped at 200 and whose value is now *deciding* what to do with
them; a per-branch view ([`docs/ROADMAP.md:449-450`](../ROADMAP.md)) is a second axis on numbers that
already have a window, a workspace and a lifetime scope, and D-2 refused a branch as an identity for
good reasons. Both add surface to a product that just learned to write; E removes the ways that surface
can quietly lie. The debt is small, provable, and every item is a defect a user can hit today.

The four candidate buckets, answered one by one rather than blended:

- **Trust** — the phase C deviations. E takes the flake (as a measured number, not a fix by argument) and
  refuses the other three with a reason each: two checkouts cannot share a `.suppress` without reading
  outside the workspace, the `.scanignore` cap asymmetry is deliberate and recorded, and a `--days` reset
  that leaves lifetime bounds alone is the only honest reading of "a day cannot be attributed to a first
  sighting". What remains of Trust — *can this record be reviewed?* — is E's spine, which is why E is
  Trust's remainder plus Answers, not a new direction.
- **Rules** — refused. The parity note is a ledger of deliberate omissions, not a backlog, and the rules
  it does not ship would multiply findings into a panel built to help you decide what to do with the ones
  it already has.
- **Answers** — adopted in one narrow form: the questions a stored record can already answer about
  *itself*. "Which rule is getting worse" needs the per-rule × per-day matrix that was refused on size;
  "when did these books open" needs one field that already exists.
- **Reach** — refused. Another editor or a headless mode would fork the single entry point the whole
  design rests on ([ADR-0003](../adr/0003-write-surface.md)'s one door, the scanner's one workspace).

Scope: **0.12.0**, one release, three items, one ADR (E-3 only; the implementer of E-3 owns it, because a
write decision belongs to the change that makes it).

The fourth record — the workspace bucket — proves the shape rather than needing it. C-3 already
reviews it: `--reset --workspace <name> --dry-run` prints what it erases, `--yes` deletes the bucket,
and the counter document is the only file touched ([`lib/telemetry.js:941-963`](../../lib/telemetry.js)).
E is that same review, extended to the three records that never got one.

## The spine

> **Every durable record can be reviewed, and only a human retires it.**

Three corollaries, and each one is a test somewhere below:

- **Nothing expires on its own.** No timer, no migration, no "cleanup" on load, no deletion because a
  scan did not see something. A record is retired by a named human action, planned first.
- **Absence needs completeness.** "This suppression matches nothing" is a claim about a scan, and a
  truncated or partial scan cannot prove absence. E reuses B's rule rather than inventing a looser one:
  an incomplete scan says *unknown*, never *unused*.
- **Stale is stated, not assumed.** Where the plugin cannot know, it says nothing (no `unused: []` from
  a scan that read fewer files than its baseline); where it can, it says the number and the date it came
  from.

## The three items

Ordered by cost, not by importance: E-1 and E-2 are additive and read-only, E-3 is the one write and
the one ADR. Nothing here blocks anything else.

### E-1 — a lifetime number says when the books opened

**Today.** `state.since` is written on every fresh document
([`lib/telemetry.js:170`](../../lib/telemetry.js)) and never leaves the document. The panel's
`scanner.lifetime` caption says the ranked counts are lifetime, so a reader knows they are not the
`{days}` window — and cannot tell whether "lifetime" means three weeks or two years. This is A-3's own
argument (*a bare number is what caused the confusion*) applied to the one number A left bare. It is
also open question 4 ([`docs/ROADMAP.md:456-458`](../ROADMAP.md)), and the answer is: one date, not a
scope control.

**Change.** `renderJson` emits `scanCountsSince` (an ISO date, derived from `state.since`) beside the
existing `scanCountsScope: 'lifetime'`, and only while that scope is set. The panel appends
`· since <date>` to the lifetime caption through one new key, `scanner.lifetimeSince`, in EN/RU/ZH. A
document without `since` — every document written before E — emits no field and the panel renders
exactly the 0.11.0 caption. `version` stays `1`; nothing is backfilled, because a date invented for an
old document would be the lie this item exists to remove.

**Protects.** "A counter explains itself" (0.9.0): a lifetime number with no origin is the same defect
as a count with no unit.

**Files.** [`lib/report.js`](../../lib/report.js) (emit the field), [`client.js`](../../client.js) (the
caption, in the three dictionaries the panel already ships), `AGENTS.md` (one clause on the A-3 bullet).
No new command.

**Proof.** `test/report.test.mjs`: with `since` the JSON carries `scanCountsSince`; without it the key
is absent and the JSON is byte-identical to 0.11.0's; with a non-lifetime scope the field is absent
too. `test/client-locales.test.mjs` fails if `scanner.lifetimeSince` is missing or unbalanced in any of
the three dictionaries. The rendering itself has no test harness (the panel is browser code checked by
dictionary parity only), so it is **shown**: two screenshots, one document with `since` and one without,
in the release note.

### E-2 — an ignore line that excludes nothing is named

**Today.** `parseScanIgnore` reports *malformed* lines in `scanned.ignoreProblems`
([`lib/scan.js:45`](../../lib/scan.js), `:620`), and a syntactically perfect pattern that matches
nothing is silent. A `.scanignore` accumulates exactly the lines someone was sure about two releases
ago: a `tmp-deploy/` for a directory the build system renamed, a `*.min.js` for a rule that no longer
fires. The file can only grow, and nothing ever says a line is idle.

**Change.** The walk records, per *source line*, whether that pattern excluded anything:
`ignoreUsage: [{ line, pattern, matched }]`, capped like `ignoreProblems`, and the report gains one
sentence — "3 patterns, 1 matched nothing". The scanner still writes nothing, never suggests a specific
edit in the scan value, and the panel's hint is a sentence, not an action: dropping the line is the
user's job in their own editor.

Two details that must be pinned because they are where this item would otherwise rot:

- **Usage is per line, never per effect.** Two lines that mean the same thing (`report/` and
  `/report/`) are separately reported, so the duplicate the user may now delete is visible. Merging by
  effect would print "1 pattern, 0 matched" and hide it.
- **A pattern that excludes a directory is credited once, for the directory.** The walk makes its
  ignore decision per entry, so an exclusion that stops a whole subtree counts as `matched: 1`, and a
  pattern is never called idle because the files under it were skipped for another reason
  (`dot-directory`, an extension outside the allowlist).

**Protects.** C-2's own promise — "the next scan reads less" — which is a claim nobody can check today.

**Files.** [`lib/scan.js`](../../lib/scan.js) (the walk and the value), [`lib/report.js`](../../lib/report.js)
(the sentence), [`client.js`](../../client.js) (the hint, in the three dictionaries),
`docs/notes/legacy-scan-contract.md` (the shape).

**Proof.** `test/scan-ignore.test.mjs`: a pattern matching files has `matched >= 1`; a pattern matching
nothing has `matched: 0`; two lines with the same effect are two entries; a pattern that only excludes a
dot-directory is credited rather than reported idle; an unreadable ignore file yields **no**
`ignoreUsage` at all — never a list of "everything unused", which would be the exact lie this phase is
about. `test/report.test.mjs` pins the sentence, and the sentence is absent (not empty) when the field
is.

### E-3 — a suppression that matches nothing is counted, and can be removed

**Today.** The mute list is append-only forever ([`lib/suppress.js:42`](../../lib/suppress.js)), capped
at 200 entries ([`lib/suppress.js:53`](../../lib/suppress.js)), and nothing reads it back except the
scanner. Edit a snippet and the site id
changes, so the mute silently stops matching; the finding reappears as new and the entry sits in the
file until the cap refuses the next mute. C-1 shipped a list that can only grow, and the cap turns that
from an inconvenience into a failure. This is the one item that needs an ADR, because ADR-0003 §8 says
a write is *never a delete* — and removing an entry is exactly the boundary that sentence drew.

**Change, part one (read).** The scan joins the file against the findings it just produced and the
report carries `suppressions: { entries, matching, unused: [siteId] | null }`. `matching` counts entries
whose site is in this scan; `unused` lists the rest — and is **null, not empty**, when the scan was
truncated, hit a cap or read fewer files than its baseline: same rule as B's diff, same reason. A
malformed line is never "unused"; it is a parse problem and stays one. The panel gets one row — "3
suppressions, 1 matching, 2 unused" — and no button: it reports, and the command acts.

**Change, part two (write, ADR-0004).** `/guidance-suppress --review` lists every entry (site id, date,
reason, matching or unused) in the command result, since that is where a human can read a path-free
list without a new surface. `/guidance-suppress --remove <siteId> [--dry-run]` plans the removal — the
exact line, the count before and after — and the same line without the flag applies it.

ADR-0004 amends ADR-0003 with the narrowest possible widening: **one entry, one invocation, one
confirmed rewrite.** Temp-then-rename, the result re-parsed through the file's own parser before the
rename (the same guard C-2 uses), every other byte preserved, order preserved, a malformed line
preserved (the writer does not tidy what it did not write), and a failure leaving the file
byte-identical. No bulk removal, no automatic expiry, no `.scanignore` equivalent in this phase.

**Protects.** "Muted is not fixed" inverted: a mute that no longer mutes must not keep counting as one.
And the cap stays meaningful, which is what makes `MAX_SUPPRESSIONS = 200` a promise rather than a
trap.

**Files.** [`lib/suppress.js`](../../lib/suppress.js) (removal + review over the existing parser and
serialiser), [`lib/scan.js`](../../lib/scan.js) or [`index.js`](../../index.js) (the join; the scanner
itself must stay a pure reader of the file it already reads), [`lib/report.js`](../../lib/report.js),
`index.js` (two flags), [`client.js`](../../client.js) (the row, in the three dictionaries),
`docs/notes/suppression-contract.md` (the removal and review shapes), `docs/adr/0004-suppression-removal.md`, `AGENTS.md`, `audit/security.md`
(§F11: the write surface changes from "append only" to "append and one confirmed removal").

**Proof.** `test/suppress.test.mjs`: `unused` is null for a truncated scan, empty for a complete one
with no stale entry, and the exact id list otherwise; a malformed line is reported as a problem, never
as unused; `--remove --dry-run` leaves the file byte-identical; an apply removes one entry and every
remaining byte is unchanged (compared literally); an unknown id, an unparsable file and a second
`--remove` in one line are refused with distinct codes and no write; the serialiser's output re-parses
to the same set minus one. `test/report.test.mjs` pins the JSON block and its absence on old documents.

## What E deliberately does not do

| Not doing | Why |
| --- | --- |
| Per-branch counters (open question 1) | A branch is not an identity (D-2). The label plus the `branch-changed` refusal already prevents a false diff; a fourth scope on the same numbers would make the panel mean two things at once. |
| Rename or merge workspaces (open question 2) | Both need a guess about identity — which two buckets are one project — and the path the counters deliberately do not keep. The honest pair already ships: `--reset --workspace <name>` removes a bucket, and "a move is a new workspace" is the stated rule. |
| A second "forget this workspace" command | It would be a synonym: `--reset --workspace <name> --dry-run` already plans the deletion and `--yes` deletes the key ([`lib/telemetry.js:941-963`](../../lib/telemetry.js)). Adding a friendlier name for one operation is how a product ends up with two doors to one room. |
| Automatic expiry of anything | The spine. A timer that deletes records is the silent no-op ADR-0003 forbids, spelled backwards. |
| Reporting a suppression as "fixed" when its site is gone | A site id is a hash of path, rule and snippet; a gone site means the code moved or changed, not that the problem was solved. It is *unused*, and the word matters. |
| Marking a workspace bucket `missing` on its own | Needs a stored path, which D-6 refuses. E reports what it can prove and stays quiet about the rest. |
| One suppression list shared by two checkouts (C deviation 1) | Reading another checkout's `.suppress` would break the read confinement to make a convenience claim. Two files stays the answer; the contract already says so. |
| More rules, an AST engine, SARIF, a CLI | Content and reach work with its own parity note; none of it is what E is for. |
| The `.scanignore` write gaining a cap (C deviation 3) | The asymmetry is deliberate and recorded in ADR-0003; E-2's usage report is the honest mitigation a hand-written file can have. |
| `.git/HEAD` or any live host check (open question 6) | Nothing in E touches attribution; the three unanswered header questions stay open until someone runs them. |

## Acceptance

1. **Tests.** Every item lands with the test named above, and the full `npm test` is green in CI. The
   four symlink skips are still the only skips.
2. **The C flake, replaced by a number.** The 0.11.0 note records one flake in `test/stats.test.mjs`
   "under concurrent edits" ([`docs/ROADMAP.md:426-428`](../ROADMAP.md)). E does not fix it by
   argument: the final tree is run 20 consecutive times, and the release note carries the result
   (`20/20`, or the failure and what it was). A test that fails once in twenty is a defect; the note
   says which.
3. **One reproducible command per item**, pasted into the release note:
   - E-1: `/guidance-stats --json` on a 0.12.0 profile carries `scanCountsSince`; the checked-in 0.10.0
     document (a fixture, not a mock) carries no such field and renders the 0.11.0 caption unchanged.
   - E-2: a workspace with a `.scanignore` line for a directory that does not exist → the report
     sentence with `1 matched nothing`.
   - E-3: suppress a site, change the snippet by one character, rescan → `unused: [<id>]`; then
     `--suppress --remove <id> --dry-run` prints the exact line and writes nothing.
4. **Compatibility.** `version` stays `1`; a 0.11.0 document renders the 0.11.0 panel plus nothing
   (every new field absent); `npm pack --dry-run` records the size delta against 0.11.0's 971 kB.
5. **The promises.** ADR-0004 lands with the code, `AGENTS.md` and `audit/security.md` are amended in
   the same change, and no promise is narrowed quietly — that is the house rule the last three phases
   each paid for once.

## What must not change

- **`version: 1`.** Every field E adds is additive, absent on an old document, and rendered as the 0.11.0
  surface. A bump is total data loss (D-3) and no item here needs one.
- **The four model-facing tools.** No tool gains a parameter or a write. The scan *value* gains one
  additive map (`ignoreUsage`, E-2), which a 0.11.0 consumer can ignore exactly as it ignores every other
  field it does not know.
- **The scanner stays a reader.** It writes nothing, spawns nothing, and its only new output is a count of
  what its own ignore file did.
- **One write door.** E-3 widens ADR-0003's append into append-and-one-confirmed-removal; it does not add a
  second door, a second file or a second command.
- **Caps stay caps.** No item raises `SCAN_LIMITS`, `MAX_SUPPRESSIONS` or `MAX_SUPPRESS_BYTES`.
- **The panel still invents no data.** Every new sentence and every new number comes from the host's JSON;
  a host that sends none renders the 0.11.0 panel.
- **Nothing leaves the machine.** No network, no telemetry of the review itself.

## Open questions this scope leaves open

1. **Is the C flake a race or a machine artefact?** E's 20-run measurement answers "does it reproduce", not
   "why". If it reproduces, the cause is `test/stats.test.mjs`'s use of a shared temp path, and a separate
   fix owns it — not E's items.
2. **Does `unused` belong in the chat tool row too?** E-3 puts the row in the panel and the command; the
   chat row is the third surface and a fourth string. Left to whoever implements it, with the rule that
   "muted" and "unused" never share a word.
3. **Per-branch view (open question 1) stays open.** E neither answers nor precludes it; a later phase that
   wants it must justify a fourth scope against D-2, and E's review items do not depend on the answer.
4. **What prunes `scanByDay` and `workspaces` in a document that is never reset?** Nothing does, and E does
   not add a pruner (the spine forbids automatic deletion). If a real profile grows past a size the team
   cares about, that is its own measured phase.

## How we would know E was the wrong phase

If, a month after 0.12.0, a real profile shows `unused: 0` in every scan and no `.scanignore` line
ever idle, then E-2 and E-3 were ceremony: the honest reading would be that these lists are small and
short-lived, and the review should collapse into one hint rather than a block. The roadmap's own
diagnosis was measured before it was written; E's two review items accept the same test. E-1 stays
either way — a lifetime number with no origin is a defect no measurement can make right.