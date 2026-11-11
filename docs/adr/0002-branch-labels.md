# ADR-0002: a branch label, read from `<workspace>/.git/HEAD`

- **Status:** accepted
- **Date:** 2026-11-11
- **Amends:** the roadmap's D-2 status note (`docs/ROADMAP.md:235-250`), the "nothing reads `.git` yet"
  clause in `AGENTS.md`, and §10 of `docs/notes/workspace-attribution-contract.md`.

## Context

Workspace attribution (0.10.0) answered "whose counters are these" with a name and an id. It left one
dimension out on purpose: the branch. A scan of `main` and a scan of a rebased feature branch land in
the same bucket, so a reader cannot tell what tree the number measured. That gap is why the label was
deferred, not why it is impossible.

Producing the label means reading `<workspace>/.git/HEAD`. This repository says two things a `.git`
read touches, and neither is optional prose:

- `AGENTS.md:22-24` — "The scanner is the only tool that reads caller-named files, and it is confined to
  the session workspace; everything else reads the bundled corpus."
- the counters' own promise — "ids and numbers, never a path and never a snippet" (`README.md:367`,
  `README.ru.md:410-411`, `README.zh.md:345`), restated as "a workspace is a name and an id, never a
  path" (`AGENTS.md:74-78`).

A read surface is therefore a decision, not a commit. This ADR makes it, and keeps it as small as the
job allows.

Four facts shape the decision, all verified in this tree:

- **`.git` is not always a directory.** In this very workspace it is a file — an agent worktree — holding
  `gitdir: E:/…/.git/worktrees/dsh-8df6d705-613d`, so `join(cwd, '.git', 'HEAD')` fails with `ENOTDIR`
  and the branch lives in the pointed-to directory (`docs/notes/workspace-scoping-facts.md:219-225`).
- **`HEAD` is not always a ref.** A detached checkout holds a bare object id; an unborn branch names a
  ref that does not exist yet.
- **No subprocess is available.** The plugin never spawns a process (`audit/security.md:237-240`), so
  `git rev-parse` is out; the file must be parsed by hand.
- **The counters already store more revealing text.** ADR-0001 keeps the last 1000 queries verbatim.
  A branch name is a weaker disclosure than a query, which is the baseline this decision is measured
  against.

## Decision

### 1. The read is exactly one file, once per scan

The counters read `<workspace>/.git/HEAD`, and nothing else:

- **One path, plus one pointer hop.** If `.git` is a directory, that is `<workspace>/.git/HEAD`. If
  `.git` is a file, its single `gitdir: <path>` line is followed and `<gitdir>/HEAD` is read — a
  relative `gitdir` resolves against the workspace root. Two reads, one hop, never more.
- **No enumeration, no other git file.** No `readdir`, no `.git/config`, no `.git/logs`, no
  `packed-refs`, no ref resolution, no `commondir` walk, no writes.
- **No process, no network.** Unchanged from `AGENTS.md:29-30`; `git` is never invoked.
- **Nothing the caller names reaches it.** The path is the resolved session workspace plus a literal;
  no tool argument, no command argument and no scan path contributes a byte of it.
- **Bound and clamped.** Both files are size-guarded at 1 KiB before reading, and the parsed label is
  clamped (§3). Anything oversized, unreadable, unparsable or absent yields no label.
- **Only the scan path reads.** The label is produced on the one recording path (`index.js:958-988`),
  where the workspace is already resolved, so a scan is the only event that can read `HEAD` — tool call
  and `/guidance-scan` alike. A guidance call reads nothing; with `enabled: false` the counters never
  start and nothing is read. The report path (`/guidance-stats`, the panel) never reads `.git`: a report
  can name a *different* workspace through `--workspace`, and reading `HEAD` from the session directory
  would label that other project with this directory's branch. The report renders a stored label.

### 2. The four shapes, and the answer for each

| Shape on disk | What is read | The label |
|---|---|---|
| `.git` is a directory; `HEAD` = `ref: refs/heads/main` | `.git/HEAD` | **`main`** — the ref name with the one exact prefix `refs/heads/` stripped |
| `.git` is a file, `gitdir: <path>` (linked worktree) | `<gitdir>/HEAD` | **the same branch name** — e.g. `dsh-8df6d705-613d` in this workspace |
| detached `HEAD` — a bare object id, 40 or 64 hex | `.git/HEAD` | **`detached at a1b2c3d`** — the first seven hex characters; never resolved, never verified |
| unborn branch — `ref: refs/heads/main` with no such ref | `.git/HEAD` | **`main`** — the branch is named, and the read deliberately does not check that the ref exists |

The unborn case is not an accident of implementation: verifying the ref would mean reading
`.git/refs/…` or `packed-refs`, which is out of scope by §1. `HEAD` naming a branch **is** the branch,
whether or not it has a commit.

Any other content is **no label**: an empty file, a `ref:` into a namespace other than `refs/heads/`
(`refs/remotes/…`, `refs/tags/…`), a hex string of the wrong length, a `gitdir:` line that is empty or
points at a directory without `HEAD`, a file over the size bound, or any thrown `ENOENT` / `ENOTDIR` /
`EACCES` / `ELOOP`. A failed read is a missing label: never an error, never a warning, never a guess,
and never a fallback to a parent directory or to `process.cwd()`.

### 3. The label is a validated value, not file bytes

A branch name is accepted only when it matches `[A-Za-z0-9._/-]{1,80}`, contains neither `..` nor `//`,
does not start or end with `/`, and does not start with `-`. Anything else — a space, `~`, `^`, `:`, a
control byte, a non-ASCII byte, a 200-character name — yields **no label** rather than a clipped or
escaped string. The detached label is composed only from validated hex characters.

This is the rule that makes the label safe to print: repo bytes never reach a report verbatim, so a
branch name cannot carry a newline, a terminal escape or a second report line into the panel, the
command output or `stats.json`.

### 4. Storage: per scan, never a key

`lastScan` gains one member, and only when a label was read:

```js
lastScan.branch = { kind: 'branch', name: 'main' }
              | { kind: 'detached', sha: 'a1b2c3d' }
// absent when there is no label
```

- **Per scan, not per bucket.** It lives on `lastScan` — the root's when the scan had no workspace,
  the workspace bucket's when it did (`lib/telemetry.js:650-657`, `:281-297`) — and will live on each
  scan-history entry when history exists. It is never a counter key, never a filter dimension and
  never a fourth bucket (D-2).
- **Absent, not null, in state.** No label means the member is not written, so a 0.10.x document, a
  non-git project and this one all keep the shape they have. `normalizeLastScan` (`lib/telemetry.js:209-221`)
  accepts only the two exact shapes above and drops everything else — a corrupt entry reads as absent,
  never as a half-label.
- **`version` stays `1`.** The member is additive; the version gate is the one thing this repo must
  never move (`AGENTS.md:70-73`). No migration step exists or is needed.
- **The ring is untouched.** `recent` entries keep their exact shape — a `deepEqual` test depends on it.
- **JSON always carries it.** `renderJson`'s `lastScan` emits `branch: null` when absent
  (`lib/report.js:663`), the same "always defaulted" rule the scan detail already follows, so a consumer
  reads `.branch` without a guard.

### 5. Rendering: one line, and only where the label is true

- **The report's last-scan line** appends the label after the counted facts
  (`lib/report.js:508-523`), in the line's own punctuation: `Last scan: 2026-11-11, 70 files, 85 findings
  (rules: ls-13); branch main` or `; detached at a1b2c3d`. No label, no suffix — the line is exactly
  today's text.
- **The panel's last-scan line** gains one fact in the same ` · ` list it already joins
  (`client.js:1719-1737`), through two locale keys: `scanner.branch` (`branch {branch}`) and
  `scanner.detached` (`detached at {sha}`). All three dictionaries get them in the same commit.
- **The workspace chip does not change.** It names the workspace, whose numbers are on screen. Adding a
  branch there would advertise a per-branch scope the counters do not have (D-2), and the chip outlives
  any single scan — it would keep claiming a branch after `git switch`. The branch belongs to the scan,
  so it appears on the scan line, and nowhere else: not in the tiles, not in the ranked rules, not in
  the guidance block, never in a tool result the model reads.
- **A missing label is silence, not "unknown".** This replaces the roadmap's proposed `unknown`
  fallback: a token printed on every non-git project would be noise that looks like data. Version skew
  costs one absent suffix.

### 6. Where the code lives

The read belongs in `index.js`, beside `resolveWorkspace` (`index.js:476-503`), which is already the one
place a workspace path is resolved; the label is read in the directory whose realpath produced the
workspace id, so one resolution serves both. `lib/telemetry.js` stays filesystem-free — it takes a
store, a clock and a catalog (`docs/notes/workspace-attribution-contract.md:21-22`), and a branch that
arrived as a resolved record is another piece of data, not a new dependency. `lib/scan.js` is untouched:
the scanner must keep skipping `.git` as a dot-directory (`AGENTS.md:56-62`).

### 7. What this does not license

This decision buys a label. It does not buy per-branch counters (`ROADMAP.md:389-390`), a branch
filter, a branch key in a bucket, a scan-time `git status`, a remote-tracking read, a commit message, an
author, or a `.git` walk of any kind. A later change that wants one of those is a new ADR.

## Consequences

### The promises this costs, and whether they survive

- **"The scanner is the only tool that reads caller-named files"** — *survives*, in the half that
  matters: no caller-controlled string reaches this read, so the scanner remains the only reader of
  paths a caller names. The sentence's trailing clause — "everything else reads the bundled corpus" —
  stops being true, and `AGENTS.md` must name the one exception next to it.
- **"A workspace is a name and an id, never a path"** — *survives verbatim*. No path is stored, and the
  branch is not a second identity: it is not on the workspace at all, it is on one scan.
- **"Ids and numbers, never a path and never a snippet"** — *needs one clause*. A branch name is neither
  an id nor a number, though it is also not a path. The three READMEs must extend that sentence rather
  than be surprised by it later.
- **ADR-0001's privacy boundary** — *unchanged*: the profile directory still holds everything, and
  nothing leaves the machine.

### Documents that must change

| Document | Change |
|---|---|
| `docs/adr/0002-branch-labels.md` | this file |
| `audit/security.md` | a new append-only §F9 beside §F8, recording the read surface, its bounds and its residual |
| `AGENTS.md:22-24` | the read-surface sentence gains the one fixed-path exception |
| `AGENTS.md:86-90` | the branch bullet stops saying "nothing reads `.git`" and states the rule this ADR fixes |
| `GLOSSARY.md` | a **Branch label** term beside **Workspace id** |
| `docs/notes/workspace-attribution-contract.md:162-172` | §10 stops deferring the label and records it as decided |
| `README.md:361-370` · `README.ru.md:405-411` · `README.zh.md:339-347` | the "ids and numbers, never a path" sentence and the counters paragraph; the 0.10.0 workspace wording is already owed here, so both land in one pass |
| `docs/notes/client-panel-spike.md:183` | "No branch, deliberately" becomes the accepted chip decision |
| `docs/ROADMAP.md:223-250, 314-317, 393-394` | D-2's status note and open question 3 |

### Tests the implementation must carry

1. **The four shapes**, each from a hand-built temp directory (no git needed): normal `.git` directory;
   worktree `.git` **file** with an absolute `gitdir:` and with a relative one; detached `HEAD` at 40
   and at 64 hex (asserting the first seven); unborn `ref: refs/heads/main` with no ref file — still a
   branch label.
2. **Silence on every other shape**: no `.git`, `.git` without `HEAD`, `HEAD` a directory, 2 KiB `HEAD`,
   garbage content, `ref: refs/remotes/origin/main`, an empty file, a branch name with a space / `~` /
   leading `-` / `..` / 81 characters / non-ASCII. Each yields no label, throws nothing, and changes
   neither the scan result nor its text.
3. **The tool's value is untouched**: the scan tool's returned value and `renderScan`'s text contain no
   `branch` key and are byte-identical to 0.10.0's. The model must never see the label.
4. **Reads are counted, not assumed**: exactly one `HEAD` read per completed scan (two scans, two
   reads), zero for a guidance call, zero when the counters are disabled.
5. **State round-trips**: `lastScan.branch` survives `normalizeState`; a malformed entry (`{kind:'nope'}`,
   `{kind:'branch'}` with an empty or over-long name, a bare string) reads as absent; a 0.10.x document
   loads unchanged with six-key `lastScan` and `version: 1`; the `recent` shape is unchanged.
6. **JSON and text**: `branch: null` when absent, the object when present; the report's last-scan line
   gains `; branch main` / `; detached at a1b2c3d`, the panel's gains the same two facts in its ` · `
   list, and both are byte-identical to today without a label — including the existing exact-string
   expectations in `test/stats.test.mjs`.
7. **Locales**: `scanner.branch` and `scanner.detached` in EN/RU/ZH, kept in parity by
   `test/client-locales.test.mjs`; a report without `branch` renders today's line exactly.
8. **The read cannot be steered**: a scan whose `paths` names `.git`, or a workspace directory called
   `.git`, still reads at most `<workspace>/.git/HEAD`; nothing from an argument reaches the read.

### Costs accepted, plainly

- **One extra read per scan** on a file that is two or three lines long; no measurable cost, and no read
  at all when the counters are off.
- **The `.git`-file hop can leave the workspace.** A worktree's git directory legitimately lives outside
  it, and a hand-written `.git` file can point anywhere, so the second read is *not* workspace-confined.
  The bound is the object, not the directory: a file named exactly `HEAD`, at most 1 KiB, parsed into a
  clamped label whose bytes never appear in output. That is the residual this ADR accepts, and §F9 has
  to say so.
- **A branch name is intent-bearing.** `feature/fix-billing-bug` says more than "85 findings" did. It is
  accepted because the counters are local, the file never leaves the machine, ADR-0001 already keeps
  verbatim query text there, the label is overwritten by the next scan rather than accumulated, and
  `--reset --yes` erases it with everything else. There is no opt-in flag: an off-by-default label
  ships dark and buys a config knob instead of a decision.
- **A stale label is possible and is not hidden**: the last scan's branch may differ from the branch the
  session is on now, which is exactly what "recorded per scan" means. Every surface shows it on the scan
  line, next to the scan's date, and never as a claim about the present.

## Alternatives considered

- **No branch, ever (the 0.10.0 status quo).** Keeps every sentence literally true and leaves the reader
  unable to compare two scans of one project. Rejected: the label is the difference between "85
  findings" and "85 findings on `main`", and the cost turned out to be one file.
- **An opt-in config flag.** Rejected: it makes the feature invisible to everyone who does not read the
  config docs, and it mitigates no threat that the stored query ring does not already pose.
- **A field on the workspace bucket (`workspaces[id].branch`).** Rejected: a lifetime bucket would hold a
  momentary fact, go stale on the next `git switch`, and quietly become the per-branch dimension D-2
  refused.
- **Only in the JSON, read fresh by the report.** Rejected: `--workspace` can select a project other
  than the session's, so a report-time read would label the wrong directory; and the label would change
  on refresh without a scan, which no counter may do.
- **`git rev-parse --abbrev-ref HEAD`.** Rejected: the no-spawn rule is a security invariant here
  (`audit/security.md:237-240`), not a preference, and a subprocess would add PATH and cwd-injection
  questions the file read does not have.
- **Ask the host for the branch if the session header ever carries one.** Not available today — this
  repo reads exactly one header field, `cwd` (`docs/notes/workspace-scoping-facts.md:154-170`) — and
  waiting for a host field is not a design. If the header ever does report a branch, prefer it and
  delete this read; that is the exit condition, not a competing option.
- **Resolve the ref to a commit, or read `packed-refs` / `logs` for a fuller identity.** Rejected: a
  wider read for a label that would still not be a key.
