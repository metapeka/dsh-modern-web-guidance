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

