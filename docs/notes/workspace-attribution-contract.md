# Workspace attribution contract (0.10.0)

Authoritative interface for the phase D workstreams. Written by the Lead before the work split, so
`lib/telemetry.js`, `index.js` + `lib/report.js` and `client.js` can be written in parallel without
guessing each other's shapes. Rationale, phasing and the decisions behind them:
[docs/ROADMAP.md](../ROADMAP.md) phase D. Verified facts about the current code:
[workspace-scoping-facts.md](workspace-scoping-facts.md).

## The problem this solves

One `stats.json` per **profile** holds the counters of every project. `/guidance-stats` answers "647
findings" without saying whose. `telemetry.record()` is called without a workspace, although the scan
value already carries `cwd` — so the information was never stored, not merely hidden.

## Non-negotiables

- **`version` stays `1`.** `normalizeState()` reads any other version as an empty document and the next
  flush overwrites the file, so a bump is silent total data loss. Partitioning is additive.
- **Zero runtime dependencies, no network, no process spawn, no new read surface.** Nothing reads
  `.git` in this phase.
- **`lib/telemetry.js` stays filesystem-free.** It takes a store, a clock and a catalog; path
  resolution (`realpathSync`, `basename`) happens in `index.js`.
- **No path is stored.** A bucket keeps a name and an id; the full directory path never enters the
  counters document.
- **Existing state loads unchanged**, including a document written by 0.9.0 with scan counters at the
  root.

## 1. Workspace identity

```js
/** Stable id for a resolved workspace path: FNV-1a 32-bit over the string, 8 lowercase hex chars. */
export function workspaceId(path: string): string
```

- Pure, deterministic, no imports, exportable from `lib/telemetry.js`.
- The caller resolves the path first; two different strings are two ids, so a renamed directory is a new
  workspace (accepted for this phase, see ROADMAP open question 2).

`index.js` resolves a workspace once, in one helper used by both entry points:

```js
/** { id, name } for a session workspace, or null when there is no usable path. */
function resolveWorkspace(cwd) // realpathSync(cwd) (fallback: cwd) -> basename -> workspaceId
```

`name` is `basename(real)`, or `'workspace'` when that is empty. Nothing else is stored.

## 2. `classifyCall` — one new field

For `web_guidance_legacy_scan` only, when the payload carries a non-empty `cwd` string, the returned
entry gains:

```js
{ workspacePath: '<raw cwd as it arrived>' }
```

It is the **raw** string: `classifyCall` is pure and must not resolve a path. No other tool emits it —
guidance calls are profile-wide by decision D-5.

## 3. `record({ at, tool, workspace?, ...entry })`

`workspace` is the resolved `{ id, name }` or absent.

- Every call still counts at the root: `calls`, `byDay`, `byTool`, `byOutcome`, and the `recent` ring
  keeps **exactly today's entry shape** (a `deepEqual` test depends on it).
- A scan's `scanRules`, `scanGuides` and `lastScan` go to `workspaces[workspace.id]` when a workspace is
  present.
- With **no** workspace (a pre-D caller, an unresolvable cwd) they go to the root `scanRules`/
  `scanGuides`/`lastScan`, exactly as 0.9.0 did. Those root counters are the legacy bucket.

## 4. State layout

```js
{
  version: 1,
  since, calls, byDay, byTool, byOutcome, byCategory, retrieved,   // unchanged, profile-wide
  scanRules, scanGuides, lastScan,                                  // legacy root scan counters
  workspaces: {
    '<id>': { name: '<basename>', since: <ms>, scanRules: {}, scanGuides: {}, lastScan: null }
  },
  recent: []                                                        // unchanged shape
}
```

`normalizeState()` rebuilds `workspaces` defensively (garbage entries are dropped, never thrown) and
missing `workspaces` reads as `{}`. `prune()` keeps pruning day buckets and an expired `lastScan`; it
**never** drops a workspace or its lifetime counters.

## 5. `snapshot({ days, workspace })`

`workspace` is an id, `'all'`, or omitted (omitted === `'all'`, which is today's behaviour).

Returns today's document plus:

```js
{
  // ...everything 0.9.0 returns...
  workspace: { id: '<id>', name: '<name>' } | null,   // null when aggregating
  workspaces: [                                        // for the switcher; [] when there are none
    { id, name, findings, rules, lastScanAt }          // findings = sum of scanRules counts (lifetime)
  ]
}
```

- Selecting an id rebuilds `scanRules`/`scanGuides`/`lastScan` from that bucket only.
- Aggregating sums every bucket **and** the legacy root counters.
- When the legacy root counters are non-empty they appear in `workspaces` as a synthetic entry with
  `id: '_unattributed'` and `name: ''` — the client renders it through a locale key, so 0.9.0's numbers
  never disappear. `snapshot({ workspace: '_unattributed' })` reads the root counters.
- An unknown id is **not** an error here: it aggregates. The command validates before calling.
- The `workspaces` list is ordered by `lastScanAt` descending (nulls last), then by name.

## 6. `/guidance-stats` — flags

```text
/guidance-stats [--days N] [--json] [--reset --yes] [--workspace <name|id>] [--all]
```

- Default with no selector: the **current session's** workspace (from the invocation's session header).
  If the header yields no path, fall back to `--all` behaviour and say so in the text report — never
  let `process.cwd()` pose as the project.
- `--workspace` matches an id, an exact `name`, or a path that hashes to an id. No match is an error
  that lists the known names and ids; it is never a silent aggregate.
- `--all` and `--workspace` together are an error.
- `--reset --yes` stays as it is (global). Splitting it is phase C.
- The text report names the workspace it is showing when one is selected; the JSON always carries
  `workspace`.

## 7. `renderJson` — additive keys

`workspace` and `workspaces` are emitted **only when the snapshot carries them** (`'workspaces' in
snapshot`), so a hand-built 0.8.x snapshot still renders the old document and the phase-A freeze on
`renderJson(snapshot)` keeps its meaning. `scanCountsScope: 'lifetime'` is unchanged — it now describes
one workspace's lifetime or the aggregate's.

## 8. Client

- **A chip in the panel header, always:** the selected workspace's `name`, or the "all workspaces" string.
- **A switcher** (native `<select>`, themed with `--dsw-alias-*` tokens — the panel draws its own
  controls): one option per `workspaces` entry plus "all workspaces". Changing it re-runs
  `/guidance-stats --json --workspace <id>` and re-renders; it never writes.
- `id === '_unattributed'` renders the `workspace.unattributed` locale string, not the empty name. When
  two entries share a `name`, the visible label appends the id so they stay distinguishable.
- **Degradation:** a host that sends no `workspaces` renders no chip and no switcher, and the rest of the
  panel is exactly 0.9.0.
- New locale keys, all three languages, same order and placeholders:
  `workspace.label`, `workspace.all`, `workspace.unattributed`, `workspace.switch`.

## 9. Tests each workstream owes

- **core:** a legacy document (no `workspaces`) loads with its counters and `lastScan` intact; two
  workspaces keep disjoint rule counters; `snapshot('all')` sums them plus the legacy root; an unknown id
  aggregates; garbage bucket entries are dropped; `recent` entries keep their exact shape; `version` is
  still `1`.
- **surface:** `--workspace <name|id>` selects, an unknown selector errors with the known names,
  `--workspace` + `--all` errors, the default resolves the session workspace, the JSON carries
  `workspace`/`workspaces`, and a 0.8.x-shaped snapshot still renders unchanged.
- **client:** the chip renders the selected name; the switcher lists entries plus "all"; selecting one
  issues the `--workspace` line; `_unattributed` renders its locale string; a report without
  `workspaces` renders no chip; three dictionaries stay in parity.

## 10. Not in this phase

The branch label (needs an ADR for reading `.git/HEAD`; the fallback is "no branch, still works"),
per-window scan counts and scan history (B), suppression and reset granularity (C), and any change to
the `recent` ring.
