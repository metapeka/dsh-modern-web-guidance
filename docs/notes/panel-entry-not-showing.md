# Troubleshooting: the rail entry is missing after an install

Symptom: the plugin is in the profile's `package.json`, `dsh-modern-web-guidance` appears in `dsh.profile.bundles`,
and yet the left rail has no entry and `web_guidance_search` is not callable. A page reload changes nothing.

## What it is not

A 0.4.1-era note claimed a "re-render race" — that the entry only appeared after switching the UI language.
That was a misreading of the rail: the entry **was** there, labelled with the Russian title `Статистика подсказок`,
and switching to Chinese renamed the same row to `指引使用统计`. There is no race, and nothing in `client.js`
needs to change.

## What it actually was

The running host had never composed the bundle. The profile manifest listed it, but the live plugin list did
not contain it, so neither the Host half (tools) nor the Client half (rail entry) was mounted.

Three independent checks that agreed, all available without a restart:

1. `plugin_manager` → `list_plugins` returned 238 rows and **none** of them was `dsh-modern-web-guidance`.
2. In the page, `performance.getEntriesByType('resource')` had **no** `/plugins/??…,dsh-modern-web-guidance/client.js`,
   so the browser never even fetched the client bundle.
3. `cordis_inspect_query` → Client `Slots.listSubTree` with root `sidebar.panellist` listed four occupants
   (`plugins`, `skills-manager`, `schedules`, `e0ai-projects`) and no `guidance`.

A composing host picks up `dsh.profile.bundles` when it starts; editing the profile while the app is running
does not necessarily add a new bundle to the live composition. `patchReload: live` covers edits to rows the
host already knows, not a package it has never mounted.

## Fix

Re-install the bundle so the live composition is rebuilt — no app restart needed:

```
plugin_manager remove_bundle   target: dsh-modern-web-guidance
plugin_manager install_bundle  target: E:\0ai\dsh_mod_1\dsh-modern-web-guidance
```

`install_bundle` answers `application: "applied"`; after that the same three checks flip:

- `list_plugins` gains the row (version `0.4.1`, `fiberPhase: active`);
- a page reload fetches `dsh-modern-web-guidance/client.js`;
- `sidebar.panellist` gains `{"id":"guidance","order":40,"active":true}`.

Then the rail row appears in the active UI language (`Guidance Insights` / `Статистика подсказок` /
`指引使用统计`), and the panel opens with its empty state — both verified live in the `desktop` profile on
2026-11-10, screenshot `rail-entry-live.png` in the session's `.tmp` (not committed).

Restarting the DeepSeek Harness app has the same effect, and is the only option when the tool used to install
was the CLI rather than `plugin_manager`.
