# Open issue: the rail entry is missing on a fresh profile until a re-render

Found while verifying 0.4.1 in a throwaway `dsh web` instance (temp `DSH_HOME`, plugin installed
either from `file:` or from `dsh-modern-web-guidance@0.4.1` on the registry). Not reproduced in the
long-lived `desktop` profile, where the entry has been present since 0.3.0.

## Symptom

1. Start a fresh host with the plugin installed; the client bundle does load —
   `/plugins/??…,dsh-modern-web-guidance/client.js` is in `performance.getEntriesByType('resource')`.
2. The left rail shows the built-in entries but **not** `Guidance Insights`. The panel cannot be opened.
3. Switch the UI language in Settings (any language) — the host re-renders — and the entry appears, with
   its localized title from the dictionary of that language.

A plain page reload does not fix it; only the locale-driven re-render does. Dismissing the preview
notice makes no difference.

## Why it matters

The README FAQ says "restart DSH after installing, the panel appears in the left rail". On a fresh
profile that promise is not kept, and the workaround (change the language) is not something a user would
guess.

## Where to look

- `client.js` registers the entry inside `ctx.effect(() => ctx.slots.inject('sidebar.panellist', …))`
  together with the `locale.register` call in the same effect chain.
- `package.json` declares `dsh.client.immediately: true` and injects `slots`, `locale`, `remote`.
- Hypotheses, cheapest first: (a) the panellist is snapshotted before our injection lands, and nothing
  re-renders it afterwards; (b) the effect that injects throws while `remote` is still undefined and the
  plugin is never re-applied; (c) `immediately` ordering differs in a host whose client plugins load in a
  second batch (both temp instances load ~60 built-in bundles first).

Next step is a client-side trace: log inside the effect, and check whether `slots.inject` is called at
all on the broken load. Only after that is a fix honest — the 0.4.1 release does not touch this path.

## Not related to localization

The same missing entry happens when the host starts in Russian, English or Chinese; switching the
language is merely what forces the re-render. The Chinese dictionary itself renders correctly once the
panel is open: title `指引使用统计`, subtitle, `更新于 {time}`, empty state and `刷新` button.
