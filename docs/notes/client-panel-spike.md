# Client panel spike (0.3.0)

Checked live against the running desktop profile on 2026-11-08 through
`cordis_inspect_query` (Client `Slots`, Client `Service`, Host `Service`) and the installed
client halves in `profiles/desktop/node_modules`. This is the whole "can we build the panel"
answer; the panel work itself is ordinary implementation.

## What a client half is

- A second ESM entry, exported as `./client` and declared by
  `dsh.client: { platform: "web", immediately?: boolean, inject: [...] }` in `package.json`.
- The file registers a lazy factory, and that is the entire contract:

  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-modern-web-guidance',          // must equal the package name
    factory(require) {
      const React = require('react');       // from the browser module table
      return { inject: ['slots'], apply(ctx) { /* ctx.slots.inject(...) */ } };
    },
  });
  ```

- No bundler is required for hand-written JS: React and the host services arrive through
  `require` and `ctx`. `references/ui-plugin.md` forbids loading host client packages as
  modules, so the panel draws its own controls and uses theme tokens (`--dsw-alias-*`).

## Where it lands

- `sidebar.panellist` is a list slot: `{ id, order, label }` — the rail icon.
- `main` is a **keyed** slot whose key is the sidebar entry id:
  "Central panel selected by sidebar entry id". Occupied keys today: `conversation`,
  `plugins`, `schedules`, `skills-manager`, `e0ai-projects`. Our `guidance` is free.
- So one `id: 'guidance'` registration pair (rail + `main.guidance`) is the whole navigation;
  no extra plumbing, and the panel is disposed with the rail entry.
- `main` panel components receive standard props: `useResource`, `useRemoteAccess`,
  `usePanelInfo`, `useSessions`, `useWorkspaces`, `useContextMenu`, `useSessionStatus`.

## How the panel reaches our counters

- Host methods annotated `@Remote` / `@Remote('name')` are exposed to the client as
  `ctx.remote.<namespace>.<method>()` (`credentialsController` backs `ctx.remote.credentials`,
  `subagents` backs `ctx.remote.subagents`, and `commands.execute` is `@Remote` already).
- Rolling our own Remote namespace would mean a typert contribution (generated schema), which
  fights the zero-dependency promise. Instead the panel reuses what 0.2.0 already ships: it
  runs the existing `/guidance-stats --json` command and parses that report, so one operation
  keeps one implementation for both callers (the rule in `references/user-actions.md`).
- Fallback if a panel cannot reach `commands.execute`: a small host service with an `@Remote`
  snapshot method, accepting the codegen cost.

## Remaining risk

One, and it is scoped to a single file: the exact client-side call for that bridge. It is
settled on the first live install in a throwaway authenticated DSH Web instance — not by
more reading.

## Live result (same day, throwaway Web instance)

The bridge works as planned, and two details only a real page could teach:

- A Client half must declare every service it touches in the `inject` list of the object its
  factory returns — and a Remote namespace counts as its own name. `['slots', 'locale']` fails with
  `cannot get property "remote" without inject`; `[… , 'remote']` then fails with
  `cannot get property "remote.commands" without inject`. The working list is
  `['slots', 'locale', 'remote', 'remote.commands']`. `dsh.client.inject` in `package.json` only
  orders activation and does not grant access.
- The call itself is `ctx.remote.commands.execute(sessionId, '/guidance-stats --json', [])`,
  answering `{ ok, value: { result: { kind, text } } }`; `kind === 'error'` carries the command's
  failure text. A `main` panel has no session binding, so the panel addresses the session it picks
  from `useSessions`.

Verified in that instance: the rail icon appears in the navigation with its localized label, the
panel opens as the central view, a real agent turn recorded two tool calls
(`search` + `retrieve`, outcome `hit`, one category `ui-behaviors`, one guide retrieved), and
Refresh rendered them — 2 calls, 100% hit rate, 193 guides, "light dismiss dialog" with 1 hit,
`ui-behaviors 1/37` over the full 17-category table, no missed queries, 192 of 193 guides never
retrieved. Empty state and the no-session state both render as designed.

## What the 0.7.0 rework added

The panel stopped being a scoreboard and became a map. No new host service, no new dependency, still one
hand-written file; the bridge contract above did not change.

- **Three slots, one file.** `sidebar.panellist` (list, id `guidance`, the rail entry), `main` (keyed
  `guidance`, the panel), and — new in 0.7.0 — `tool.call.toolview` (keyed `web_guidance_legacy_scan`,
  the chat table). The third is keyed, so it replaces the generic card for that one tool and leaves it
  in place for every other tool.
- **The data call keeps its shape**: still a plugin command through `remote.commands.execute`, now
  `/guidance-stats --json --days N` so the `7 d` / `30 d` switch picks the window instead of the panel
  reading a wider report and slicing it.
- **The scan button adds one command call**: `/guidance-scan . --format json`. `.` is the session
  workspace the command resolves; the panel names no file itself, and it renders the answer inline
  through the same value reader the chat row uses, so one parser serves both surfaces.
- **Everything on screen is a reduction of that JSON, not a second computation**: the hit rate over the
  calls that could hit (`hits / (hits + misses + unknown-id)`, with the report's own all-calls rate kept
  in the tooltip), dead-guide ids, and the scan rules and guides from `topRules` / `topScanGuides`. The
  panel deliberately shows no path and no snippet: counters are not evidence, and the chat row is where
  files and lines appear.
- **The chat row reads `ToolCallOwnerProps`**: `phase`, `block.argsRaw` while the arguments are still
  being written, and the settled `block` for a result. A `summary`-format answer is parsed back into the
  same table; anything it cannot read degrades to the text the generic card would have shown.

## What the 0.7.3 caveats added

0.7.2 taught the scan's own text to say what it skipped; the panel drew its summary from the JSON and
stayed silent, so a live run showed `70 файлов, 97 замечаний` and nothing about the 280 paths behind it.
0.7.3 puts the two caveats on all three surfaces the panel owns. Still one file, still no new dependency,
still no host method: the data was already in the answer.

- **Three surfaces, one line shape.** (1) The button result appends `scan.skipped` under `scan.summary`,
  naming the top three reasons and adding `scan.skippedMore` inside the parentheses when there are more.
  (2) The section's last-scan line appends `scanner.skipped` and `scanner.cut` to the facts it already
  joined with ` · ` — the total and the flag only, never the breakdown. (3) The chat tool row adds the
  same line under its table, for a JSON **and** a summary answer.
- **Four new keys, no fifth string.** `scan.skipped` (`Skipped {count} ({reasons})`), `scan.skippedMore`
  (`+{more} more`), `scanner.skipped` (`skipped {count}`) and `scanner.cut` (`truncated`), times EN, RU
  and ZH. Truncation reuses `scan.truncated` from 0.7.0 — `Truncated: the scan hit a cap, so this list is
  incomplete.` — because a second wording for the same fact would be a second thing to keep in sync.
- **One parser, both formats.** The chat row already read the `- path:line:column rule (confidence)` lines
  back out of a summary answer; it now also recognises `Skipped 279 path(s): 277 extension, 2
  dot-directory`, so the row's skip line appears whether the model called the tool with `format: 'json'`
  or `'summary'`. The reasons are read verbatim and never mapped through a dictionary.
- **A stale `stats.json` renders shorter, not wrong.** The last-scan line only appends the skip total when
  the stored map is non-empty and the flag only when it is set, so a 0.7.2 state (no `skipped`, no
  `truncated`) prints the line it always did. Inventing `skipped 0` or a bare `truncated` would turn the
  absence of a fact into a claim.

