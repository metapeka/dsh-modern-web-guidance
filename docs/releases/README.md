# Release notes

One file per release: `docs/releases/v<version>.md`. When the file exists, `release.yml` publishes it
as the GitHub release body (creating the release, or editing an existing one); when it does not, the
workflow falls back to `gh release create --generate-notes`, which only lists merged pull requests and
is therefore nearly empty in this repo, where work lands on `main` directly. `docs/` sits outside the
published `files` whitelist, so notes never enter the npm tarball.

Write the file **before** dispatching the release, from measured facts, not from commit messages.

## Shape

```markdown
# <version> — <what the release gives the user> <emoji>

Two to four lines: what moved, by how much, and what deliberately did not change. The first sentence
is the whole release in one line; a reader who stops there is still correct.

## <emoji> Section title

- One fact per bullet, in plain language, spelled out rather than abbreviated.

**Install:** `dsh plugin --profile desktop add dsh-modern-web-guidance`

**Full diff:** https://github.com/metapeka/dsh-modern-web-guidance/compare/v<prev>...v<this>
```

## Sections, in this order — keep only the ones that have something to say

| Emoji | Section | Holds |
| --- | --- | --- |
| 📚 | Corpus | catalog/guide counts, new and rewritten guides, snapshot id |
| ⚠️ | Breaking | anything a user must change, one bullet per break, plus the migration line |
| ✨ | Features | new tools, panel UI, new observable behaviour |
| 🧪 | Behaviour changes | same features, different output: banners, markers, ordering |
| 🛠 | Hardening | limits, validation, dedupe, fixes — what can no longer go wrong |
| 🧩 | Compatibility | DSH version range, Node floor, engines |
| 📝 | Skills and docs | SKILL.md, READMEs, NOTICE, guard documents |
| 📦 | Package | file count, packed size, dependencies, licence, provenance |

## Rules

1. **English body.** The repo's docs are English; the release body is English too.
2. **A collapsed Russian digest is welcome**, not required: `## 🇷🇺 Коротко по-русски` wrapped in
   `<details>`, five to seven bullets in the same order as the English sections, placed just before the
   Install footer. Keep identifiers, file names and commands in Latin.
3. **Numbers are measured and bolded.** `**208 guides**`, `**842 kB packed**`. Never estimate, never
   copy a number out of an older note without re-checking it.
4. **The unit is the user's gain, not the commit.** "`retrieve` now opens with a warning banner" beats
   "added experimentalBanner() to lib/guidance.js".
5. **No hashes, no PR numbers in the body** — the compare link covers the history. Issue links are
   fine when the release exists because of a report.
6. **No "misc" and no "various fixes".** If a change cannot be stated in one sentence, it belongs in
   the section of the feature it serves, or it does not belong at all.
7. **Length: 25–60 body lines.** A section with one bullet is fine; a section with ten is a sign the
   release notes are actually a changelog.
8. **Say what did not change** when that is the reassurance a reader needs (same tools, same corpus
   format, no new dependency).
9. **Emoji set is fixed** to the table above; a release does not invent a new one. The title emoji
   names the release's headline, not its section mix.
10. **Footer is always the same two lines**: the install command and the compare link, in that order.

## Checklist before dispatching

- [ ] `docs/releases/v<version>.md` exists and matches the `package.json` version
- [ ] the first line would still be true if the reader stopped after it
- [ ] every number re-measured in this tree
- [ ] every tool/flag/emoji mentioned exists in the shipped code
- [ ] `gh release edit v<version> --notes-file docs/releases/v<version>.md` for a release that already exists
