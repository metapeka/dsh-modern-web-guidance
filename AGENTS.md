# dsh-modern-web-guidance

## Agent skills

### Issue tracker

GitHub Issues in `metapeka/dsh-modern-web-guidance`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root, with ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## CI

`.github/workflows/test.yml` is the source of truth: every push to `main` and every PR runs `npm test` plus `npm pack --dry-run`, and `npm test` on its own reproduces it locally.

A change to the tests, the `test` script or `package.json` `files` must update that workflow in the same PR.

## Client half

`client.js` is browser code shipped as-is: one file, no bundler, no new dependencies. It registers a
lazy factory through `window.__ModuleLoader__.load({ id: <package name>, factory(require) })`, takes
React from `require('react')` and nothing else from the host, and declares its Cordis services in the
returned `inject` list — `slots`, `locale`, `remote` and `remote.commands` are all required for the rail
entry and the panel's data call (`ctx.remote.commands.execute`). The panel registers
`sidebar.panellist` id `guidance` and the keyed `main` slot with the same key; there is no other wiring.
See `docs/notes/client-panel-spike.md` for the verified contract.
