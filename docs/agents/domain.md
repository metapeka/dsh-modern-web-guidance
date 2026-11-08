# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

This repo uses the **single-context** layout: one `GLOSSARY.md` and one `docs/adr/` at the repo root. It ships a single package, so there is no per-context split.

```
/
├── GLOSSARY.md
├── docs/adr/                          ← system-wide decisions
├── index.js
├── lib/
└── data/
```

`GLOSSARY.md` exists and is maintained by `/domain-modeling`. `docs/adr/` is created lazily, when the first decision deserves a record.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root: the project's domain vocabulary. Use these terms, and don't drift to the words it lists under `_Avoid_`.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If a file in this list doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates ADRs lazily when a decision actually gets resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (local telemetry), but worth reopening because…_
