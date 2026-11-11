# Phase F — Directional: which way is it going? (scope)

Status: **proposed**. Scope only: no code, no test, no state change lands with this note. The inputs are
[`docs/ROADMAP.md:442-487`](../ROADMAP.md) (what 0.12.0 delivered and what it admitted) and the two
sequences this product has been storing since 0.10.0 without ever reading as sequences.

## Is E's deferral list a phase? No — it is a chore list, and half of it is not even work

The three things E left behind are a *two-checkout suppression dedupe*, a missing `.scanignore` cap, and
the lifetime bounds a window reset leaves in place. None of them is a capability a user asked for, and
they do not share a spine — they are three unrelated asymmetries. Each gets a disposition instead of a
slot:

| E's deferral | Disposition | Why |
| --- | --- | --- |
| Two checkouts share one suppression list | **Never, as a plugin feature** | Reading the other checkout's `.suppress` would break the read confinement to make a convenience claim. Two files is the answer the contract already gives, and it is the honest one. |
| `.scanignore` has no cap | **Rides along, not a phase** | It is a constant, a refusal and one clause of the plan text — the same shape `.suppress` already has. Whoever next touches `/guidance-scanignore` adds it; a phase that ships one `if` is a phase spent on a chore. |
| A window reset leaves lifetime bounds | **Correct behaviour, no change** | A day cannot be attributed to a rule's first sighting, so `ruleFirstSeen` must survive `--days`. "Fixing" it would invent the number the counters exist to avoid. |

So F is not "close the debt". F is a capability: **the product can say which way a number is going, or
refuse and say why.** That is the one question the last four phases made answerable and never answered —
A gave the counts a unit, D gave them an owner, B gave them a comparison between two scans, E gave them a
starting date — and no surface has ever stated a direction over more than two of anything.

## Why this, and not the others

- **Rules parity** — refused again, for the reason recorded in [`legacy-scan-parity.md`](legacy-scan-parity.md):
  a ledger of deliberate omissions. A phase that adds rules adds findings to a panel whose job is now
  deciding what to do with the findings it has.
- **Per-branch counters** ([`docs/ROADMAP.md:508-509`](../ROADMAP.md)) — refused again: a branch is not an
  identity (D-2), and a slope across a `branch-changed` pair is exactly the false number the guard token
  exists to prevent. F *uses* that token rather than dissolving it.
- **A chart** — refused in B on a measured size budget (33 rules × 90 days = 31,051 bytes per workspace
  against 4,501 for the whole-workspace series, [`scan-history-contract.md:75-78`](scan-history-contract.md)).
  F needs no bytes at all: the series it reads are already stored.
- **Reach** (CI mode, another editor, SARIF) — refused: a second surface forks the single door the product
  just paid three phases to build.
- **"Resolved"** — refused. The word does not exist in the product ([`docs/ROADMAP.md:473-475`](../ROADMAP.md)),
  and a trend is exactly where "it got better" would be tempting to print as "it is fixed".

## The spine

> **A direction is a claim about a sequence, and a claim needs a baseline, a denominator, a sample and the
> right to refuse.**

Three corollaries, each a test below:

- **A truncated scan is not a data point.** A scan that hit a cap or a file limit under-counts, so it is a
  hole in the series, excluded from both halves — never a zero and never a drop.
- **The denominator is stated.** "Fewer findings" and "fewer files read" are the fog this phase exists to
  clear, so every slope prints the two halves it compared and the size of each.
- **No direction is better than a wrong one.** A short, mixed or incomplete series prints a refusal token
  (raw, like `branch-changed`), never an arrow and never a percentage.

## The three items

### F-1 — the project's slope

**Today.** `scanHistory` keeps 20 completed scans per workspace, each with `files`, `findings`, `rules`,
`truncated`, `branch` and `suppressed` ([`lib/telemetry.js:526-548`](../../lib/telemetry.js)). The panel
shows the newest five as a list of rows, and phase B's comparison line compares exactly one scan to the
previous one. Nothing says whether the project is winning.

**Change.** The report carries `scanSlope` for the selected workspace: the newest *n* comparable entries
against the *n* before them, findings per 100 files in each half, the delta, and the sample
(`6 scans: 12.4 → 9.1 findings per 100 files`). Files are the denominator because the walk's own limits
make raw findings incomparable between a full scan and a narrow one — B's `fewer-files` token is the same
lesson learned once already.

Refusals, all from the stored entry fields and none invented: `too-few-scans` (fewer than 4 comparable
entries remain after the holes), `branch-changed` (both halves carry a label and the labels differ),
`no-files` (a half read zero files, so the denominator is missing), `aggregate` (no single ring to read — a
slope is a per-workspace claim, like every number D exists to attribute). A refusal is a token plus the
halves it wanted, never a number.

A truncated entry is a hole, not a zero: it is dropped from whichever half it falls in and the sample
shrinks by one, so a project that hits a cap once still gets a slope over the scans that were complete.
When neither half carries a branch label the slope is still stated and says nothing about branches —
`branch-changed` is a claim about a proven disagreement, never about a missing label.

**Protects.** D-4 (*whose numbers are these?*) applied to time, and B's rule that a comparison may refuse.

**Files.** [`lib/report.js`](../../lib/report.js) (derive + render), [`lib/telemetry.js`](../../lib/telemetry.js)
(nothing — the ring already has every field), [`client.js`](../../client.js) (one line under the
comparison, three dictionaries), `docs/notes/scan-history-contract.md` (the deriving rules).

**Proof.** `test/report.test.mjs`: six entries with known counts produce the stated halves and delta; a
truncated entry is dropped and the test asserts the shrunken sample; mixed branches → `branch-changed`;
three entries → `too-few-scans`; an aggregate snapshot → `aggregate`; a document with no `scanHistory`
renders the 0.12.0 report byte-identically. `test/client-locales.test.mjs` pins the new caption keys in
EN/RU/ZH. `test/stats.test.mjs` pins that a report carrying `scanSlope` leaves `stats.json`
**byte-identical** — reporting a trend writes nothing.

**Honest deviation.** The ring is 20 deep and pruned by the same 90-day window as `scanByDay`
([`scan-history-contract.md:102-104`](scan-history-contract.md)), so a project scanned once a month has
`too-few-scans` for most of the year. That is the correct answer and the note says so instead of widening
the ring.

### F-2 — a rule's slope

**Today.** Each history entry keeps the scan's **ten** most-numerous rules *with counts*
([`lib/telemetry.js:537`](../../lib/telemetry.js), `topRuleCounts` at `:411-424`, cap `MAX_HISTORY_RULES`
at `:77`). The panel's ranked rows show a lifetime count and a last-seen date; the only per-rule movement a
reader can see is "it is in the top ten now".

**Change.** For every ranked rule the report carries `slope: { from, to, sample, direction } | null`: the
counts it has in the entries that carry it, newest half against the previous half. The sample is printed
("ls-17 rising: 9 → 15 over 4 scans") because it is the whole honesty of the claim.

The hole rule is the design: **a rule's absence from an entry means it was not among that scan's ten**, not
that it stopped firing. So a rule is compared only over entries that carry it, and:

- fewer than 3 such entries → `too-few-samples`;
- present only in the newest half → `entered-sample` (a direction with no before);
- present only in the older half → `left-sample` — and it is the sample that left, not the finding: the rule
  may have fewer findings, or the same ones with other rules ahead of it. The words are deliberately not
  B's `new`/`resolved`, because those belong to sites and a rule leaving a top ten is not a site resolving;
- a truncated entry is a hole, like every other series;
- a rule with lifetime findings and no entry at all → `not-sampled`, never "steady".

**Protects.** A-2/A-3's rule that a value is shown with the thing it is: the sample is not a footnote, it is
the last half of the sentence. And the parity note's caveat in reverse — a rule that is merely below the top
ten must not look like a rule that stopped firing.

**Files.** [`lib/report.js`](../../lib/report.js), [`client.js`](../../client.js) (one more line on the row,
three dictionaries), `docs/notes/scan-history-contract.md`, `AGENTS.md` (one clause: the ten is a sample,
not a census).

**Proof.** `test/report.test.mjs`: a rule present in four entries with a rising pair of counts → `rising`
with the sample; a rule present in two → `too-few-samples`; present only in the newest half →
`entered-sample`;
a truncated entry in the middle → excluded from both halves, and the test asserts the exact sample size;
a rule outside every entry but with a lifetime count → `not-sampled`; a 0.12.0 snapshot renders the
0.12.0 panel. The panel row itself is **shown**, not tested: one screenshot with a rising row and one with
`not-sampled`, because the panel has no render harness.

**Honest deviation.** The stored counts are per scan and per rule, not per site: a `rising` rule may have
the same sites and more of them, or the same sites in a bigger file. F says "the counts it saw, over the
scans that saw it" and nothing more — the site-level story stays B-3's baseline and the diff's job.

### F-3 — the corpus answer rate, this window against the last

**Today.** `/guidance-stats` prints `{calls} calls, {x}% hit rate` for one window, and `hitRate` divides
*hits by every call* — including scans, lists and errors — which is why `hitRate.raw` exists to explain it
([`lib/report.js:223-228`](../../lib/report.js), `:775`). The report also prints miss queries, category
coverage and dead guides, all static for the window. A corpus owner — the person who edits
`data/guides.json` — can see that a search missed; they cannot see whether an edit made next week better
than last week.

**Change.** The report gains one line, in the corpus block where that owner already reads, computed from
the root `byDay` rows, which carry `byOutcome` per day and are pruned at 90 days
([`lib/telemetry.js:162-164`](../../lib/telemetry.js)):

> Guidance answered 84% of what it was asked in the last 30 days (120 of 143), against 78% in the 30 days
> before (96 of 123).

`answer rate` is `(hit + list) / (hit + list + miss + unknown-id)`: the guidance calls only, so a week with
more scans cannot move it. **This is deliberately not the KPI's `hit rate`** — the KPI answers "what did
the agent get, out of everything it did", and the answer rate answers "did the corpus answer what it was
asked". Two questions, two names, one glossary entry each; neither is redefined and the KPI keeps its
existing sentence.

Refusals: `no-previous` (the earlier window has no rows — a reset erased them, or the document is young),
`thin` (either window has fewer than 10 guidance calls, so a percentage would be noise), and `no-days` (a
document without per-day rows at all). A refusal prints the token and, where it exists, the rate it could
have compared.

**Protects.** D-5 (guidance counters stay profile-wide — so this belongs in the report's corpus block, not
the workspace-scoped panel) and the counters' stated purpose: they exist so a corpus decision can be made
on evidence.

**Files.** [`lib/report.js`](../../lib/report.js) (the sentence and the rate), [`lib/telemetry.js`](../../lib/telemetry.js)
(one derived summary field: this window and the previous one, from `byDay`), `GLOSSARY.md` (**answer rate**),
`docs/notes/scan-history-contract.md` or the report contract note (the sentence shape). **No panel change** —
see below.

**Proof.** `test/report.test.mjs`: two windows of hand-built day rows produce the stated counts and
percentages; the KPI line is unchanged on the same snapshot; zero guidance calls in the earlier window →
`no-previous`; nine calls → `thin`; a document with no `byDay` → the line is absent (not "0%"). A test
pins the two definitions apart: the same snapshot's `hitRate` (all calls) and answer rate (guidance calls)
differ, and both are computed by one function each. A reset that deletes the earlier window turns the line
into `no-previous` rather than a drop to zero — the one test that pins "an erased baseline is not an
improvement".

**Honest deviation.** `list` counts as answered: the list tool did return the corpus's own inventory, which
is an answer, if a cheap one. `error` is excluded from both numerator and denominator, because a failed call
is not a corpus verdict. Both are decisions of this note, not measurements, and the note says which.

## What F refuses because a phase is a small thing

| Not in F | Why |
| --- | --- |
| Any new field in `stats.json` | F reads two existing series; the only state-shaped risk is growth, and the answer is no growth. A test asserts the document is byte-identical after a report. |
| A chart, sparkline or per-rule × per-day matrix | Refused in B on a measured budget, refused again: F's rendering is tokens, samples and two sentences. |
| A new command (`/guidance-trend`) | The existing report and panel carry the fields; a second entry point would be a fourth door for numbers. |
| A slope for guides | `scanGuides` is lifetime only, with no series to read. A guide slope would need the matrix B refused. |
| A second rate in the panel | The panel is the project workbench; the answer rate is a corpus number and stays in the report's corpus block (D-5). |
| A trend across branches, or for an aggregate | `branch-changed` and `aggregate` are the answers; a slope across either is the number this phase exists to refuse. |
| "Resolved", "improved", "fixed" | No word in the product may claim a fix; F says *fewer findings per file* and *answered more*, both of which are measurable and neither of which is a fix. |
| The E chore list | Dispositions in the table above: one never, one rides along, one is correct as it is. |

## What must not change

**No ADR.** F writes nothing, stores nothing, adds no command and breaks no stated promise, so there is no
decision here that a future reader must not relitigate — the choices it does make (files as the
denominator, the sample as part of the sentence, `answer rate` as its own word) are recorded here and in
the two contracts the fields belong to.

- **`version: 1`**, and not one new persisted field. F is a reader.
- **The four tools** and the four commands: no parameter, no result field, no new command.
- **The KPI's `hit rate`** keeps its definition and its `hitRate.raw` explanation; the answer rate is a
  different, separately named number.
- **The guard tokens** (`branch-changed`, `fewer-files`, `no-baseline`, …) keep their meanings and print raw.
- **The panel invents nothing**: every slope word and sample comes from the host's JSON, and a document
  without the fields renders the 0.12.0 panel character for character.
- **A refusal records nothing**: reporting a slope never appends to history, never counts a call, never
  touches the clock differently from a plain report.
- **A workspace is a name and an id, never a path.** F prints names, ids, counts and dates; the
  per-100-files denominator is a number the scan already returns, so no path reaches a slope, a sentence
  or a screen.
- **A suppressed finding is muted, not fixed — and a slope cannot be moved by muting.** `findings` counts a
  suppressed site exactly as it counts any other, so `scanSlope` neither subtracts suppressions nor reads
  them: a workspace that muted every finding would show the same slope. Test: suppress a site, rescan, and
  assert the slope is byte-identical to the run before the mute.
- **A removal is not a fix**, from the other side: `--remove` un-mutes one entry and moves no counter, so it
  moves no slope either — the same test, run backwards.
- **Site identity is a hash, and no path or snippet is ever stored.** F stores nothing at all, so it adds no
  exception to either rule: the two series it reads were written under those promises and F reads numbers
  off them.

## Acceptance

1. **Tests.** `test/report.test.mjs` covers every sentence and every refusal of F-1 and F-2 and the three
   refusals of F-3; `test/telemetry.test.mjs` covers the two-window derivation and the byte-identical
   document assertion; `test/client-locales.test.mjs` covers the new caption keys in EN/RU/ZH. Full
   `npm test` green in CI, with the four symlink skips still the only skips.
2. **Shown, not claimed.** Three screenshots: a rising rule row, a `not-sampled` row, and the project's
   slope line; plus the report's answer-rate sentence pasted into the release note, with the window it used.
3. **One reproducible command per item:**
   - F-1: two scans of the same workspace at different file counts → the line states both halves.
   - F-2: the checked-in fixture where a rule appears only in the older half → `left-sample`, and a rule
     that fires but never reaches the top ten → `not-sampled`. A live demo is not possible on purpose: a
     suppression does not move a count (ADR-0004), so nothing a user can do from the panel makes a rule
     leave the ten — only a code change does.
   - F-3: run the report against a fixture with two windows of day rows where the older window is better →
     the sentence says the rate *fell*, and the KPI line is untouched.
4. **Back-compat.** A 0.12.0 document renders the 0.12.0 report and panel byte for byte; a document whose
   history is empty renders no slope rather than a zero.
5. **The cost, stated.** `stats.json` does not grow; the JSON the panel already receives grows by one
   `scanSlope` object and one field per ranked rule — recorded in the release note as a size delta.

## How we would know F was the wrong phase

If two months of real profiles show that the stored ring is almost always shorter than four comparable
scans — the shape a project scanned when someone remembers has — then F-1 and F-2 print `too-few-scans` for
most users, and the honest reading would be that a 20-deep ring is a sample of *events*, not of *time*, and
direction belongs to a coarser anchor (per release, per month) that F did not build. F-3 is independent: it
reads the profile's day rows, which fill without anyone remembering to act.

## Open questions this scope leaves open

1. **What anchors a release?** F-1 compares two halves of a ring; a corpus owner asked "since the last
   release" and the document records no release. A later phase could stamp the version that wrote a scan —
   one field, additive, no bump — but it is not needed for F and not decided here.
2. **Does the answer rate belong in the panel at all?** Decided no for now (D-5, two rates), but if the
   corpus block ever moves to the panel, the rate moves with it and not before.
3. **Per-branch view** (open question 1) stays open; F's `branch-changed` refusal is what keeps it honest in
   the meantime.
4. **A slope for the suppression list** — "am I muting more than I fix?" is the sharpest question this
   product could ask and could not answer: a mute moves no counter by design (ADR-0004), so the answer
   would be a *count of mutes over time*, which the history's `suppressed` field already has — but reading
   it as a verdict would make "muted" sound like a defect. Left open, deliberately.
