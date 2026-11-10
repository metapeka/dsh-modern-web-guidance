# Workspace scoping — verified facts

Fact sheet for the question *"how can a user tell which project or git branch the counters belong
to"*. Every claim below is either a `file:line` citation into this tree, a live observation on this
machine, or an explicit **not determined by this repo** (NDR). Nothing here is a design; no production
code was changed to write it.

Measured tree: `0.8.2`, worktree `dsh-8df6d705-613d`, 2026-11-11.

Line numbers are those of the working tree as read on 2026-11-11. Peers were editing `index.js`,
`lib/report.js` and `client.js` at the same time; nothing in their edits concerns scoping, but a few
line references may drift by a handful of lines. `lib/report.js` citations are pinned to `HEAD`
(`0.8.2`) because that file gained an unrelated ~89-line block above the cited lines.

## Answers at a glance

| # | Question | Answer |
|---|---|---|
| 1 | Where is `stats.json`? | One file per DSH **profile**: `<profile>/storage/modern-web-guidance/stats.json`. No workspace component. |
| 2 | Is `cwd` on the record path? | **Not today.** `record()` gets `{at, tool, …classifyCall}` only. `cwd` exists in the tool's `execute`, but the `tools/result` listener's `exec` is only *shown* carrying `name`/`arguments` — whether it also carries the header is **NDR**. |
| 3 | Is `cwd` reachable in a command handler? | **Yes**, for `/guidance-scan` via `commandCwd()`. `/guidance-stats` never reads it, and the tests hand that handler only `{rawInput}`. |
| 4 | Would a workspace field break tests? | Only if it reaches state or the record. The fakes carry no header at all; `test/scan-command.test.mjs:415` compares command and tool counters for equality and would break first. |
| 5 | Anything in the session header beyond `cwd`? | **NDR.** This repo reads exactly one field and vendors no host types. |
| 6 | Is reading `<cwd>/.git/HEAD` acceptable? | Consistent with the audit's stated rule (fixed path, no model input), **but** it falsifies "everything else reads the bundled corpus" and puts a path into a state document that promises none — both need doc edits. Worktrees make `.git` a **file**, verified here. |
| 7 | What does a version bump cost? | Total, silent loss: `normalizeState` drops a mismatched document and the next write destroys it. Stay on `version: 1`. |

---

## 1. State location — per profile, not per workspace

`lib/store.js:19-22`:

```js
export function defaultStatePath(home) {
  const base = home ?? process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'storage', 'modern-web-guidance', 'stats.json')
}
```

- Precedence is explicit argument → `DSH_PROFILE_DIR` → `DSH_HOME` → `~/.dsh`, then a fixed
  `storage/modern-web-guidance/stats.json` suffix. **No workspace, project, cwd or branch segment.**
- The plugin calls it **with no argument** (`index.js:734`), so a real session always lands on the
  environment branch. The parameter exists only for tests and other callers.
- The tests treat that base as the profile home and both env vars as the same directory
  (`test/stats.test.mjs:16-17`, `test/scan-command.test.mjs:123-124`), and the expected file is
  `home/storage/modern-web-guidance/stats.json` (`test/scan-command.test.mjs:129-131`).
- Reads are forgiving (`lib/store.js:31-37`: missing/corrupt → `null`); writes are one atomic
  `write .tmp` + `rename` (`lib/store.js:39-44`).
- **Is `DSH_PROFILE_DIR` / `DSH_HOME` the profile dir?** The repo only proves the *precedence* and
  that tests may point it at a throwaway directory. Which env vars the real DSH process actually sets,
  and whether they mean "profile home", is **not determined by this repo** — no host docs, no vendor
  types (see §5). Needs a live check before a per-workspace file layout is designed on top of it.

**Architectural consequence, from verified signatures only:** `startUsageCounters` builds **one**
telemetry instance per `apply()` (`index.js:729-742`), and `createTelemetry` captures **one** store
(`lib/telemetry.js:381-384`, `createFileStore({ file })` at `lib/store.js:29`). One host process serves
several sessions/workspaces, so "one file per workspace" cannot be a change at the call site alone: the
store object is fixed at construction and only `load()`/`save()` are used.

## 2. Record path — `cwd` is not there today

Today's single recording surface (`index.js:757-775`):

```js
usage.start((toolName, args, value, isError) => {
  const tool = TRACKED_TOOLS.get(toolName)
  if (tool === undefined) return
  let entry
  try { entry = classifyCall({ tool: toolName, args, value, isError }) } catch { return }
  void Promise.resolve()
    .then(() => telemetry.record({ at: Date.now(), tool, ...entry }))
    .catch(() => {})
  scheduleSave()
})
```

- The entry is `{at, tool, …classifyCall}` (`index.js:771`). `classifyCall` produces outcome, query,
  ids, category, count, files, findings, rules, guides, ruleCounts, guideCounts, skipped, truncated,
  isError (`lib/telemetry.js:288-362`) — **no location field of any kind.**
- The listener itself (`index.js:777-792`) is `const onResult = (exec, result) => …` and forwards
  `exec?.name`, `exec?.arguments`, `result?.value`, `result?.isError` (`index.js:780`). It **never
  touches `exec.agent`**.
- `cwd` *is* reachable one layer up, in the tool's own `execute`: `exec?.agent?.session?.header?.cwd ??
  process.cwd()` (`index.js:431`; contract copy at `docs/notes/legacy-scan-contract.md:329`). Only the
  scan tool reads it; the other three tools never look at `exec` beyond `signal`
  (`index.js:288, 318, 337, 430`).
- **Is `exec.agent.session.header` on the `tools/result` `exec`?** **Not determined by this repo.** The
  code reads only `name`/`arguments` off it, and the two fakes that raise the event pass exactly
  `{ name, arguments }` (`test/stats.test.mjs:86-89`, `test/scan-command.test.mjs:411-412`). The audit
  records the opposite direction only — "`index.js` passes `cwd` from the session header and nothing
  else" (`audit/security.md:218`), about the *tool* call. Needs a live check on the host event payload.
- Fallback caveat: `?? process.cwd()` (`index.js:431`, `index.js:473`) means a caller without a header
  (every test that passes `{}`) is attributed to the **plugin process directory**, not the workspace.
  Any new field derived this way can be silently *wrong* rather than absent.

State-side shape, for the migration question: the ring entry is `{at, tool, outcome}` plus optional
`query`/`ids`/`files`/`findings`/`isError` (`lib/telemetry.js:491-500`), rebuilt defensively on load
(`lib/telemetry.js:251-268`).

## 3. Command path — `cwd` reachable, used by one of the two commands

`index.js:464-474`:

```js
function commandCwd(invocation) {
  const header = invocation?.agent?.session?.header ?? invocation?.session?.header
  return header?.cwd ?? process.cwd()
}
```

- `/guidance-scan` uses it: `runScanRequest(…, commandCwd(invocation), …)` at `index.js:517`. The
  comment above it asserts a command invocation "carries the same session header" (`index.js:465-467`),
  and the tests supply `{ rawInput, agent: { session: { header: { cwd } } } }`
  (`test/scan-command.test.mjs:93-95`).
- `/guidance-stats` does **not** call `commandCwd` anywhere (`index.js:653-691`): it parses
  `invocation?.rawInput` only (`index.js:670`) and snapshots by `days` (`index.js:681`). Its tests pass
  `{ rawInput: '' }` / `{ rawInput: '--json' }` with no header (`test/stats.test.mjs:92, 111, 114`;
  `test/scan-command.test.mjs:140`).
- So the mechanism to read a workspace in *any* command handler exists and is proven for one command;
  whether the host actually hands **every** command invocation a session header is **not determined by
  this repo** (asserted in a comment, emulated in tests, never observed live).
- `snapshot()` takes only `{days}` (`lib/telemetry.js:510`), and both call sites pass only `days`
  (`index.js:672, 681`). A per-workspace report therefore needs a new argument or a new state layout —
  the current signature has nowhere to put one.

## 4. Test fakes — what exists, and what a workspace field would break

**`test/plugin.test.mjs`** (`test/plugin.test.mjs:8-29`) is the *minimal* context: `tools.register`,
`skills.register`, `effect(create)` — **no `on`, no `off`, no `get`, no `commands`**.

- Because `startUsageCounters` returns early when `typeof ctx.on !== 'function'` (`index.js:727`), the
  counters never start in this file at all: `apply(ctx)` (`test/plugin.test.mjs:33`) registers tools and
  skills only. Nothing in it can see a stats document.
- Its tool `exec` is literally `{}` (`test/plugin.test.mjs:59, 69, 80, 87, 96, 99`), so
  `exec?.agent?.session?.header?.cwd` is `undefined` and the scan tool falls back to `process.cwd()`.
  **No fake here carries `agent.session.header`.**
- Adding a workspace field read with optional chaining and a fallback therefore does not break this
  file. Adding a *required* one, or one that throws, would.

Where a workspace field actually lands decides the breakage:

| Reach of the new field | Breaks | Why |
|---|---|---|
| Only the `record()` argument, never stored | nothing | `record()` ignores unknown keys (`lib/telemetry.js:436-503`) |
| Stored on each ring entry | `test/stats.test.mjs:324-330` | `assert.deepEqual(store.state.recent.at(-1), {at, tool, outcome, files, findings})` — exact object |
| Stored on `lastScan` | `test/telemetry.test.mjs:735` (and every `lastScanOf` helper, e.g. `:286-288`) | asserts the six documented keys exactly |
| Exposed in the snapshot / JSON | `test/stats.test.mjs:266-271, 317-320` and `lib/report.js:434-451` (`renderJson`, HEAD) | the panel parses that object; new keys are additive-safe, renamed ones are not |
| Recorded on the command path only | `test/scan-command.test.mjs:400-416` | "the counters cannot tell a command scan from a tool scan" compares the two snapshots with `deepEqual`; the command invocation carries a header (`:94`) while the listener call passes `{name, arguments}` only (`:412`) |

The same file is the proof that a command *does* reach `cwd` (`test/scan-command.test.mjs:94, 446,
456`) and that the tool's `exec` does (`test/scan-command.test.mjs:407-410`,
`test/scan-tool.test.mjs:43`, `test/scan.test.mjs:64`).

## 5. Session header beyond `cwd` — not determined by this repo

- The only fields the code reads are `agent.session.header.cwd` (`index.js:431`) and, defensively,
  `session.header.cwd` one level up (`index.js:472`). No id, name, branch or project is read anywhere.
- The only host type mentioned is a JSDoc import: `@param {import('@deepseek-ai/cordis').Context} ctx`
  (`index.js:719, 805`). It resolves to nothing in this tree — `package.json` has **no**
  `dependencies`/`devDependencies` (its only script is `"test": "node --test test/*.test.mjs"`,
  `package.json:69-72`), and the release checklist records the absence deliberately
  (`PUBLISHING.md:108`, "No `@deepseek-ai/*` dependencies at all"). So the header shape is not
  recoverable by reading this repo.
- The release notes speak about workspaces only as *scan subjects* — "The counts differ between
  workspaces, and that is the point of them" (`docs/releases/v0.7.3.md:21-24`) means what is in the
  directory when the scan runs, **not** that counters are partitioned. Do not read it as an existing
  feature.
- **NDR:** whether the host exposes a workspace id, project name, or branch anywhere in the session
  (header or elsewhere); whether `cwd` is a stable absolute path or a per-session wrapper directory.
  This needs a live check against the running host, not this repo.

## 6. Reading `<cwd>/.git/HEAD` under the stated security posture

What the repo states:

- **The audit's own rule** (`audit/security.md:15-19`): the plugin is in-process and imports `node:fs`
  directly, so "can read host files" is *not* a finding; what matters is "whether attacker- or
  model-controlled input widens that". A `<cwd>/.git/HEAD` read with `cwd` taken from the host's session
  header and a constant suffix is not model-controlled input — it does not widen the surface in those
  terms. Note the `?? process.cwd()` fallback (§2) is the one path where the *subject* of the read can be
  wrong; it is still not attacker-chosen.
- **The read-surface claim it would falsify** (`AGENTS.md:22-23`): "The scanner is the only tool that
  reads caller-named files, and it is confined to the session workspace; everything else reads the
  bundled corpus." A `.git/HEAD` read makes the second clause false.
- **The no-path promise it would falsify** (`README.md:367`): the scan detail is "ids and numbers, never
  a path and never a snippet"; `lib/telemetry.js:606-607` repeats it ("Ids and numbers only — never a
  path, a snippet or a file name"); `docs/releases/v0.7.3.md:49-50` says "No path and no snippet appears
  anywhere new". A stored workspace path (or even a basename) is the first path in that document.
- **The privacy boundary** (`docs/adr/0001-local-telemetry.md:16-17, 26-27`): what is recorded is "per
  tool … counts … and a bounded ring"; "the privacy boundary is the profile data directory". A workspace
  identifier changes *what* is stored, not where — so it is an ADR-level change, not a bugfix.
- **No process spawns** (`audit/security.md:198-200, 237-240`; `AGENTS.md:29-30`; `lib/scan.js:42-43`
  imports only read-side `node:fs/promises`). `git rev-parse` is therefore **not** an option; the file
  has to be parsed by hand.
- **The precedent for how to record it:** `audit/security.md:212-215` added "§F8 — 0.5.0 read surface" as
  an **append-only section** when the scanner introduced a new read, and `docs/README.md:45` fixes the
  audit's status as "historical, never rewritten". So the expectation is a new numbered/lettered
  subsection, not edits to F1–F7.
- **Historical claims already stale** — worth knowing before citing the audit as current:
  `audit/security.md:263-265` says "Filesystem writes: none", and `:288-289` says "no `process.env` read
  … no telemetry". Both are false since the counters shipped (`lib/store.js:20, 39-44`).

Repository boundaries that would need an update if `.git/HEAD` is read:

1. `AGENTS.md:22-23` — the read-surface sentence.
2. `audit/security.md` — a new section beside §F8, stating the fixed path, the read-only single-file
   scope, failure → no attribution, and that the path never comes from tool arguments.
3. `README.md:361-370` (and the RU/ZH mirrors) — "What is counted" / "Where it lives", plus the
   never-a-path sentence at `:367`.
4. `docs/adr/0001-local-telemetry.md` — a new ADR or an amendment: the counters now carry a workspace
   identifier. (It is already stale on tool count: "three tools", `:16`.)
5. `lib/report.js:434-468` (`renderJson`'s doc comment, HEAD) and `docs/notes/client-panel-spike.md:67` —
   the JSON the panel parses.

Git mechanics a hand parser must handle (git semantics, **not** repo facts — the repo contains no HEAD
parsing at all):

- **Normal checkout:** `<cwd>/.git` is a directory; `<cwd>/.git/HEAD` is a small text file,
  `ref: refs/heads/<branch>` when on a branch, a raw object id when detached.
- **Linked worktree:** `<cwd>/.git` is a **file**. Verified live in this very task's workspace
  (`E:/0ai/dsh_mod_1/dsh-modern-web-guidance/.agents/worktrees/dsh-8df6d705-613d/.git`):
  `kind: file`, content `gitdir: E:/0ai/dsh_mod_1/dsh-modern-web-guidance/.git/worktrees/dsh-8df6d705-613d`.
  The branch lives in `<gitdir>/HEAD`, which there reads `ref: refs/heads/dsh-8df6d705-613d` (verified).
  `readFile(join(cwd, '.git', 'HEAD'))` therefore fails with `ENOTDIR` in a worktree — the `.git`-is-a-file
  branch is not hypothetical for this project, whose own agents work in `.agents/worktrees/*`
  (and `.agents` is in the scanner's skip list, `lib/scan.js:65`).
- **Detached HEAD** is a bare object id in the same file; length and algorithm vary by repo. Which form
  to accept, and what to print for detached, is a design decision, not something this repo answers.
- `.git` is already never read by the scanner: `SKIP_DIRECTORIES` includes it (`lib/scan.js:62-66`) and
  dot-directories are skipped as `dot-directory` (`AGENTS.md:56-62`). That protects the *scan*, not a
  counters read — a second, separate read surface with its own containment argument ("one fixed child of
  the session cwd", not "caller-named paths").

## 7. Migration risk — a version bump silently erases every counter

`lib/telemetry.js:222-224`:

```js
function normalizeState(loaded, now) {
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) return emptyState(now)
  if (loaded.version !== STATE_VERSION) return emptyState(now)
```

Chain, all verified:

1. `STATE_VERSION` is `1` (`lib/telemetry.js:18`), with the comment "bumping it makes older state read as
   empty" (`lib/telemetry.js:17`).
2. `ensure()` caches whatever `normalizeState` returned (`lib/telemetry.js:400-414`), so the drop happens
   once and is not recoverable in-process.
3. The old document's `since` is also replaced by "now" (`lib/telemetry.js:84-87, 227`).
4. The first flush after the upgrade writes the replacement over the file — atomically, one `rename`
   (`lib/telemetry.js:623-627` → `lib/store.js:39-44`). **The pre-upgrade counters are gone, with no
   backup, no warning, and no message in the report** (the report simply renders the empty state:
   `lib/report.js:338-343`, HEAD).
5. Test proof of the read side: `test/telemetry.test.mjs:194-205` — a document with `version: 99` reports
   `calls: 0`, and the next `record()` starts the count at 1.

The repo's established alternative is **additive fields on `version: 1`**, used twice and documented:

- 0.6.0 added `scanRules`/`scanGuides`/`lastScan` without a bump (`lib/telemetry.js:93-97`;
  `test/telemetry.test.mjs:486-510` shows an old document still loading and the new counters starting
  empty), and `test/telemetry.test.mjs:711-743` shows a pre-audit `lastScan` normalising to the six keys.
- 0.7.3 stated the rule out loud: "`version` stays `1`: the fields are additive … No migration step, no
  `version` bump, nothing to run by hand" (`docs/releases/v0.7.3.md:30, 37-39`).

Safest migration shape, given the above: **keep `version: 1` and partition inside the document** — a
`workspaces: { <key>: {…counters…} }` subtree plus a `_unattributed` bucket that owns today's root
counters, read as "everything recorded before partitioning". Two hard constraints from the code:

- The merge must happen in `normalizeState` (or in `ensure()` immediately after it), because that is the
  only point where a loaded document crosses into a state (`lib/telemetry.js:405-406`). `reset()`
  bypasses loading entirely (`lib/telemetry.js:615-620`) and would not run it.
- If a version bump is ever unavoidable, migrate **before** the version check: read the old document,
  move its root counters into `_unattributed`, write the new version. Anything after line 224 operates on
  an empty state and cannot recover the file, since the write is destructive (`lib/store.js:41-43`).

## What this repository does not answer

1. Which env vars the real DSH sets, and whether `DSH_PROFILE_DIR`/`DSH_HOME` is the profile home (§1).
2. Whether the `tools/result` payload's `exec` carries `agent.session.header` (§2).
3. Whether *every* command invocation carries the session header, or only `/guidance-scan`'s callers do
   (§3).
4. Whether the session exposes a workspace id, project name, branch, or a stable workspace path anywhere
   (§5).
5. Detached-HEAD's exact byte format and the policy for rendering it (§6).

Each of these changes the design and cannot be settled from this tree; they need a live host check
(e.g. the running GUI's inspect surface) before per-workspace partitioning is specified.
