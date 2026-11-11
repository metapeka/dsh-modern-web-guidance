# ADR-0003: the panel may write — one action, one file, one confirmation

- **Status:** accepted
- **Date:** 2026-11-11
- **Amends:** `AGENTS.md:135-139` ("the panel holds no filesystem authority: it has two actions") and
  `AGENTS.md:171` ("it wrote nothing through 0.10.0"), the same promise in `README.md:411` and its RU/ZH
  twins, and the phase-C guardrail that anticipated this ADR (`docs/ROADMAP.md:60-62`).

## Context

Through 0.10.0 the plugin read the user's project without ever writing into it: its only writes were to
its own profile document (`stats.json`), which is machine-local and disposable. Phase C asks it to do
something about a finding — mute it, or tell the scan to stop looking — and muting is a **write into the
user's project**: the first one this plugin would ever make there, and the first thing the panel ever asks
for that changes a file.

Three statements stand in the way, and this repository does not break a stated promise quietly:

- `AGENTS.md` (Client half, before this change) — "The panel is read-only apart from one button: it asks
  the host to run `/guidance-scan . --format json`".
- `README.md:411` — "The panel is read-only apart from the scan button".
- `docs/ROADMAP.md:60-62` — "The scanner stays **report-only** and never writes into the user's project.
  Any suppression file is a separate, opt-in, explicitly created local file — and the 'panel is
  read-only' sentence in AGENTS.md must be amended *in the same change* if a phase adds a write action."

The guardrail already contains the decision: a write action is permitted, it must be a separate,
opt-in file, and it must arrive with an amended promise. This ADR is that amendment. It decides **who
may write, on what trigger, into which file, with what confirmation, and what a refusal looks like** —
and it deliberately says nothing about the suppression file's contents, which is
`docs/notes/suppression-contract.md`'s job.

Four facts constrain the design, all true in this tree:

- **The panel has no filesystem.** `client.js` is browser code whose only authority is the plugin
  process, reached through `ctx.remote.commands.execute` (`client.js:2334-2419`); the write happens in
  `index.js`. "The panel writes" is shorthand for "the panel asks a command it can compose, and shows
  the answer", exactly as the scan button already does.
- **The scan already reads one project file without being asked.** `.scanignore` at the workspace root,
  with a documented grammar and malformed lines reported rather than fatal (`lib/scan.js:20-39`,
  `SCAN_IGNORE_FILE` at `:69`). A writer that appends a line its own reader would call malformed has
  shipped a bug, not a feature.
- **An atomic write already exists in this codebase.** The counters write their profile document to a
  sibling `.tmp` and rename it (`lib/store.js:39-44`); the project write reuses that pattern instead of
  inventing a second one.
- **A site has an identity.** B-3's `siteId` is eight lowercase hex characters over path, rule id and
  snippet (`docs/notes/scan-history-contract.md:250-262`), and it is the only thing a suppression may
  name. A suppression by line number, by file, or by "the whole rule" is not available.

## Decision

### 1. Exactly two writes exist, and both append to a workspace-root dotfile

- **Suppress one site** appends one entry to `<workspace>/.suppress` (entry shape: the suppression
  contract).
- **Offer one ignore pattern** appends one line to `<workspace>/.scanignore` (grammar:
  `lib/scan.js:20-39`).

Nothing else. Reset writes the profile document that already exists and touches no project file;
"export" is the clipboard, not a file; a scan never writes. **The four model-facing tools never write,
and there is no write tool**: the only door is a human command, which the panel may compose. A future
phase that wants the model to write needs its own ADR, not an argument from this one.

### 2. The writer never invents a path

The ADR-0002 precedent, inverted: one fixed write path per action, and no caller-named byte in it.

- **The directory is the session workspace**, read from the invocation's session header exactly as the
  scan reads it (`index.js:471-474`, `:515-519`). No header means **refuse**; the writer never falls
  back to `process.cwd()`, which is the plugin process's directory and not the user's project.
- **The filename is a literal** — `.suppress` or `.scanignore`. A site id or a pattern is data written
  *into* the file; it is never a component of its path. There is no `--file`, no `--output`, no
  relative-path argument.
- **The target stays inside the workspace.** The target's realpath must be inside the real workspace,
  and a target that is itself a symlink is refused rather than followed — a symlinked `.scanignore`
  would turn "append one line" into "append one line wherever the repo points".
- **One target per invocation.** No batch mode, no glob, no `--all`, no "suppress the last scan".
- **The target is validated against this workspace, not trusted.** A site id the panel composes from the
  finding it is showing and an id a person types are treated identically: it must resolve in *this*
  workspace's current scan, or the write is refused. Nothing about the request — a path, a line, a
  snippet, a raw rule — is accepted as a target.

### 3. No write without an explicit user action

The trigger is enumerated and closed. The command is the only door; a person types it, or clicks a
confirmation that composes exactly one command line. There is no write on a scan, on a report, on panel
load, on refresh, on session start, on migration, on retry, on error, on shutdown, or on a timer. A
write is never a side effect of reading, and a panel that merely renders never proposes one.

### 4. Confirm before, report after: plan, then apply

Both commands obey one protocol. The suppression line is fixed, because the panel is written against it
and a second name would be a second implementation:

```
/guidance-suppress <siteId> --dry-run      the plan, writes nothing
/guidance-suppress <siteId>                applies it, prints what changed
/guidance-scanignore <pattern> --dry-run   the plan, writes nothing
/guidance-scanignore <pattern>             appends exactly one line
```

A future fourth line follows the same protocol under its own name, not as a flag on these. Three
asymmetries are deliberate and both commands must keep them:

- **`.suppress` is capped and `.scanignore` is not.** A suppression list of 200 entries is a report about a
  codebase; an ignore file that long is a scan that reads nothing. So the suppression plan states the cap
  and the headroom, and the ignore plan states the count it would reach and claims no headroom.
- **Identity is the effect, not the text.** `report/`, `/report/` and `report` are one ignore pattern, and
  the "already present" message names the file's own line rather than the one that was typed.
- **The writer obeys its own reader.** The ignore append re-parses the whole resulting file through the
  same `parseScanIgnore` the scanner uses *before* the rename, so a write can never produce a file the next
  scan would reject.

- **`--dry-run` answers the plan and writes nothing**: the absolute target path, the exact line or
  entry that would be added, whether the file exists, how many entries it holds now, and the remaining
  cap headroom.
- **The panel renders that plan inline** — not a `window.confirm`, which a host can suppress and which
  cannot show a path — and a **second, distinct click** applies it. One click never writes.
- **After the write, the command prints what changed and where** (`<path>: added <entry>`, then the new
  count), and the panel shows that text. Apply is the same command without `--dry-run`, so the panel
  still owns no second implementation: it parses `{kind, text}` exactly as the scan button does
  (`client.js:958-975`).
- **A write never claims that a scan happened.** A policy file takes effect at the *next* scan: no
  counter moves, the last-scan line does not change, and the confirmation says so in those words. The
  scan button stays the only thing that produces scan numbers, and a write never re-scans on its own.
- **A refusal and an outcome are the same shape**, so the panel renders one surface for both: a refusal
  is `kind: 'error'` with a stable code and a reason, and it reaches the same error surface the scan
  button uses (`client.js:2415-2418`) — never `ready` with zeros.

### 5. A refusal is an error, and a no-op is named

Refused before the file is opened: an unknown site id, an id that does not resolve in *this*
workspace's current scan, an id belonging to another workspace, an ambiguous or empty selector, a
pattern outside the `.scanignore` grammar, a target that is unreadable or unparsable, a target that is
a symlink or escapes the workspace, a full cap, no session workspace, and any write failure.

The one benign case is named out loud: **"already suppressed, nothing written"** is a success that says
so. Reporting a no-op as an error would train the user to ignore errors; reporting it as silence would
be the silent no-op this ADR exists to forbid.

After a failed write the target must be **byte-identical** to what it was — the temp-file-plus-rename
rule (`lib/store.js:39-44`) applied to the project file, with the temp removed on failure. A partial or
truncated write is worse than a refusal.

### 6. The reader is forgiving; the writer is not

This section and §5 are where the write posture legitimately diverges from ADR-0002's silence: a read
that fails loses a label, a write that fails must not lose data, so the writer is loud where the reader
is quiet.

- **`.scanignore` is hand-written and stays hand-written.** The writer appends and nothing else: it
  never reformats, reorders, dedupes or deletes a line the user wrote, and it never rewrites the file
  from a parsed model. If the file cannot be read, the write is refused rather than clobbered. If it
  does not end with a newline, the writer adds the separator first — otherwise two patterns silently
  become one.
- **`.suppress` is plugin-owned, and still never overwritten blind.** The scan tolerates a malformed
  entry and keeps the good ones; the writer must not "repair" a file it cannot parse, because that
  would erase a list the user can no longer see. Unparsable means refuse.
- **Only what the reader accepts is written.** The `.scanignore` pattern is validated against
  `lib/scan.js:20-39` and the suppression entry against the contract *before* the write, so the next
  scan never has to report the writer's own line as malformed.
- **The writer adds no evidence, only the decision.** An entry carries the site hash, the reason the
  person typed and the date — never the path, the snippet or the line number the finding came from.
  Those live in the scan and in the chat row; a policy file is not a second copy of them, and a reason
  is stored verbatim (length-clamped) because it is the user's own words, not the plugin's.

### 7. Bounded, local, and quiet

Caps belong to the suppression contract; the writer refuses a write that would cross one instead of
truncating to fit. No network, no process spawn, no `git`, no editor: Node writes the file in-process.
Nothing about a write is logged, reported or stored anywhere except in that command's own result — no
counter, no history entry, no telemetry field, because "how often I muted a finding" is not a number
this plugin has any use for.

### 8. What a write can never be

Never a delete or a rename. Never a write outside the workspace, into `.git`, or into source code.
Never an automatic suppression, a bulk suppression, or a suppression the model asked for. Never a
write during a scan or a report. Never a project write issued by the counters path. A later request for
any of these is a new ADR.

## Consequences

### The promises this costs, and whether they survive

- **"The panel is read-only apart from one button"** — *does not survive, as written*. It becomes: the
  panel holds no filesystem authority and can request exactly two writes, each a command it composes
  only after showing the plan and receiving a second confirmation. Both `AGENTS.md` sites and the three
  READMEs are amended in this change or with it.
- **"The scanner stays report-only and never writes into the user's project"** — *survives*. The
  scanner still imports no write API and writes nothing while scanning; the write is a separate command
  that a person invokes. The guardrail's own qualifier ("a separate, opt-in, explicitly created local
  file") is what this ADR implements, and the sentence needs "the *command*, not the scan, may append"
  spelled out next to it.
- **"The panel owns no second data path"** — *survives, extended*: it gains a second *action* and still
  no second implementation, no second parser and no second data path.
- **"A workspace is a name and an id, never a path"** — *survives*. The written file is in the project;
  the counters still store no path.
- **ADR-0002's read posture** — *unchanged*: one fixed read, bounded, silent on failure. ADR-0003 gives
  the write side the same spine and a louder failure mode, because a read that fails loses a label and
  a write that fails wrongly loses data.

### Documents that must change

| Document | Change |
|---|---|
| `docs/adr/0003-write-surface.md` | this file |
| `audit/security.md` | an append-only §F10 beside §F9: the write surface, its bounds, its residual |
| `AGENTS.md:135-139` | the Client-half sentence names the write action and links this ADR |
| `AGENTS.md:171` | the 0.10.0 bullet no longer claims the panel writes nothing |
| `AGENTS.md:64-70` | the scanner bullet: a suppressed finding is reported, never hidden |
| `GLOSSARY.md` | a **Suppressed finding** term |
| `README.md:411` · `README.ru.md` · `README.zh.md` | the read-only sentence; the panel now offers one write |
| `docs/notes/suppression-contract.md` | restates the location and name fixed here; does not re-decide them |
| `docs/ROADMAP.md:60-62, 380-393` | the guardrail's promise is now satisfied by an ADR, and the phase-C status note |

### Tests the implementation must carry

1. **No tool writes.** A scan and a report each run against a fake host context with a write detector;
   neither reaches a write API, and `lib/scan.js` still imports none.
2. **`--dry-run` writes nothing**: with the file absent, still absent after; with it present,
   byte-identical and the same mtime.
3. **Unknown or ambiguous targets are refused before the file is opened**: an unknown site id, a site
   id from another workspace, an empty selector, a glob, an absolute path, `..`, and a pattern with
   `**` each return a distinct code and leave the workspace with no new or changed file.
4. **Append preserves bytes**: a hand-written `.scanignore` with comments, blank lines and no trailing
   newline keeps every prior byte, gains exactly one line, and produces no `ignoreProblems` on the next
   scan.
5. **Unreadable or unparsable targets refuse**: an unreadable `.scanignore` and a `.suppress` full of
   garbage each refuse with the file byte-identical afterwards.
6. **Symlinks are refused**: a symlinked `.scanignore`, and a target whose realpath leaves the
   workspace, are both refused without touching the destination.
7. **A failed write leaves the original intact**: with the rename forced to fail, the target is
   unchanged, the temp file is gone, and the command returns an error — never a success.
8. **Caps refuse instead of truncating**, and the file is untouched at the boundary.
9. **"Already present" says so**: a second identical suppression reports nothing written, not an error,
   and leaves the bytes unchanged.
10. **The panel shows the plan then applies**: one click produces only the `--dry-run` call and no
    write; the confirm click produces the write; a refusal reaches the error surface, never `ready`.
11. **No workspace header → refuse**, with no file created in `process.cwd()` or anywhere else.
12. **Reset does not touch project policy**: `/guidance-stats --reset --yes` leaves `.suppress` and
    `.scanignore` byte-identical.
13. **A pre-C host renders the old panel exactly**: no suppression affordance, no new required strings.

### Costs accepted, plainly

- **The plugin can write into the user's project.** That is the whole point, and it is why the write is
  one line, one file, one action, path-validated and visible. A muted finding is still counted as
  suppressed, so a write can hide a finding from the eye but not from the numbers.
- **`.suppress` can be committed.** It is a reviewable decision, not a hidden setting; a stub file
  appears only on request.
- **A cross-process race can lose one append** (two hosts on one profile, one workspace). The file is a
  set of entries, the command reports what it wrote, and the loss is re-addable; a lock file in the
  user's project would be a second artifact and is refused.
- **One more command, one confirm step and two locale strings per action.** The panel gets slower to
  use in exchange for never muting a finding by accident.

## Alternatives considered

- **Stay read-only; let the user hand-edit the file.** Rejected: the roadmap's point is to do something
  about a finding, and hand-editing a JSON keyed by an eight-hex hash is not a workflow. The file is
  still editable by hand, which is what keeps it reviewable.
- **A write *tool* for the model.** Rejected: a model that can mute the finding it dislikes turns a
  report into a verdict. The tools stay read-only and the door stays human.
- **Keep `--reset` all-or-nothing and skip the panel write.** Rejected: reset is a deletion of the
  user's data; it is not the action phase C is for.
- **Store suppressions in the profile, not the project.** Rejected: a suppression is a decision about a
  project, reviewable in that project's repository and shareable with its team. The profile document is
  throwaway, machine-local and unreviewable.
- **A `window.confirm` before writing.** Rejected: it cannot show the target path, the host may suppress
  it, and it is untestable. An inline plan plus a second click shows exactly what will change.
- **Let the panel write the file directly.** Rejected: browser code has no filesystem authority here,
  and a second implementation would drift from the command the API exposes.
- **Auto-create `.suppress` on the first scan.** Rejected: "created only on request" is the guardrail;
  a scan that writes is the promise this ADR is amending, not repeating.
- **Rewrite `.scanignore` from a parsed model, or write through a symlink.** Rejected: the first
  destroys hand formatting, the second turns an append into an escape.
- **Overwrite a `.suppress` that fails to parse.** Rejected: silent data loss, and it would erase the
  evidence of whatever corrupted it.
