# Corpus diff — upstream `v1.0.0` vs our snapshot `2026_10_30-58d055df`

Task: `task-8` · Author: `upstream-diff` · Date: 2026-11-10
Repo under analysis: `E:\0ai\dsh_mod_1\dsh-modern-web-guidance`
Upstream sources compared:

| source | identity | used for |
| --- | --- | --- |
| git tag `v1.0.0` (clone in `.tmp/upstream`) | commit `4dd9683`, released 2026-11-10T03:08:33Z | guide bodies, `SKILL.md`, repo-level docs |
| npm tarball `modern-web-guidance@1.0.0` (`.tmp/upstream-diff/mwg-1.0.0.tgz`, 8,794,985 B, integrity `sha512-vafIZwC8AS6QjM2yyoflZbnc7n3/TVOMLbEMRdPTwcFy0f9/Tq8s5rJQ8UIqRt2KPl9ixravyaMR4nTGuUrcmg==`) | `skill-version.txt` = `2026_11_09-5bcc021b` | **the real upstream artifact**: `gen/guides.json`, guide bytes, `SKILL.md` |

**Why both.** The git checkout is not a valid byte source: every file in it is CRLF (Windows `core.autocrlf`),
while the published package is LF — our vendored corpus matches the **npm tarball** bytes exactly. And
`gen/guides.json` + `skill-version.txt` **do not exist in the git tree at all**; they are build outputs shipped only
in the npm package (same as in `0.0.197`, where the index lived at `skills/modern-web-guidance/guides.json`).

---

## 0. Bottom line

| | ours (`2026_10_30`) | upstream `v1.0.0` | delta |
| --- | ---: | ---: | --- |
| guide `.md` files | 193 | **209** | +16 |
| indexed entries in `guides.json` | 193 | **208** | +15 |
| real new guides | — | **15** | +15 |
| unindexed duplicate file (`prompt-api.md`) | already skipped | still skipped | 0 |
| categories | 17 | **17** | 0 |
| removed / renamed paths | — | **0 / 0** | 0 |
| byte-changed guides | — | **105** of 193 common | — |
| byte-identical guides | — | **88** | — |
| guide bytes | 1,557,860 | **1,952,778** | +394,918 (1.49 → 1.86 MiB) |
| Σ `tokenCount` | 430,254 | **474,620** | +44,366 (+10.3 %) |
| `SKILL.md` | 7,939 B (0.0.197) | **9,793 B** | +23 / −5 lines |
| snapshot id | `2026_10_30-58d055df` | **`2026_11_09-5bcc021b`** | — |

Verdict: **the update is additive and low-risk for our code**. No guide was removed or moved, no category was added
or dropped, the index schema only *gained* one optional field (`volatileFeatures`), and all 193 existing ids still
exist. The work is a re-vendor plus a documentation/test count sweep — not a migration.

---

## 1. Exact counters and what the numbers mean

Our snapshot was built from `modern-web-guidance@0.0.197`, whose package contained **194** guide files of which
**193** were indexed (`built-in-ai/prompt-api.md` is a byte-identical duplicate of `language-model.md` and was never
in the index). Our `data/guides` = exactly those 193 index-backed files — this is still true, verified by hash below.

`v1.0.0` package contains **209** guide files, of which **208** are indexed; `built-in-ai/prompt-api.md` is still the
one unindexed duplicate (`sha256(prompt-api.md) == sha256(language-model.md)`, 19,418 B each in the LF tarball —
19,820 B each in the CRLF git checkout, which is why byte figures differ between sources).

So the file delta 193 → 209 = **+16**, and one of the 16 (`built-in-ai/prompt-api.md`) is not a new guide — it is the
duplicate we already, deliberately, do not vendor. Real new guides = **15**, which matches the release notes exactly.

```
209 files  =  208 indexed  +  1 unindexed duplicate (built-in-ai/prompt-api.md)
208 indexed =  203 use-case guides + 5 broad discipline guides
                (accessibility, forms, html, performance, security)
our 193 files = the 193 index entries from the 0.0.197 index (same rule, applied earlier)
```

The “203” is upstream's own figure, not marketing arithmetic: `README.md:192` opens a `<details>` block titled
**“203 real-world developer use cases”** that enumerates guide-by-guide, and that block contains exactly 203 entries —
the 208 index ids minus the five discipline overviews `accessibility`, `forms`, `html`, `performance`, `security`
(verified by parsing the block; the per-category counts inside it are 22/40/22/25/18/… vs 22/40/22/26/19/… in the
index). The other three files whose name equals their category (`css/css.md`, `privacy/privacy.md`,
`webmcp/webmcp.md`) **are** counted as use cases upstream; a stricter rule (“any basename == category”) would give
8 overviews / 200 use cases, which is *not* how upstream counts.

> For our own docs: we ship **208 guides** (209 files, one deliberate duplicate skip) in 17 categories. “203” is
> upstream's use-case-only count and should not replace 208 in our README, badge or tool description.

Byte identity of the baseline: `data/guides.json` is byte-identical to the `0.0.197` package file
(`sha256 B50D499037C97AECF9C39E5F5BCF5FD39D536E29F06889D3DA8B225DFE430290`, 72,103 B), and every unchanged guide
matches the `0.0.197` package bytes. Our corpus is provably upstream bytes; the diff below is therefore a diff of
upstream content, not of local edits.

---

## 2. Added guides (16 files, 15 real)

Category deltas match the release notes exactly: `ui-components` +8, `ui-behaviors` +3, `ui-atoms` +1,
`user-experience` +2, `pwa` +1, `built-in-ai` +1 (that one is the duplicate). Release-notes grouping is
“UI components (8), UI behaviors (3), Layout and UX (3), PWA (1)” = 15.

| file | H1 title | category | bytes | tokens | featuresUsed |
| --- | --- | --- | ---: | ---: | ---: |
| `built-in-ai/prompt-api.md` | Language Model | built-in-ai | 19,418 | — (duplicate, not indexed) | 0 |
| `ui-components/accordion.md` | Accordion | ui-components | 15,102 | 3853 | 8 |
| `ui-components/app-menus.md` | Build an application menu bar | ui-components | 16,099 | 4106 | 5 |
| `ui-components/breadcrumbs.md` | Build breadcrumbs | ui-components | 12,640 | 3339 | 7 |
| `ui-components/carousel.md` | Build a carousel | ui-components | 15,462 | 3598 | 6 |
| `ui-components/copy-button.md` | Copy button | ui-components | 14,896 | 3769 | 7 |
| `ui-components/navbar.md` | Responsive Site Navigation | ui-components | 18,277 | 4514 | 11 |
| `ui-components/tabs.md` | Tabbed interfaces | ui-components | 22,204 | 5597 | 5 |
| `ui-components/toolbar.md` | Build a toolbar | ui-components | 22,057 | 5524 | 10 |
| `ui-behaviors/drag-and-drop.md` | Rearrange Items with Drag and Drop | ui-behaviors | 16,814 | 3814 | 4 |
| `ui-behaviors/dynamic-sort.md` | Handling dynamic user-triggered changes to sort order | ui-behaviors | 7,039 | 1649 | 3 |
| `ui-behaviors/sortable-table.md` | Sortable Table | ui-behaviors | 7,893 | 2094 | 4 |
| `ui-atoms/single-line-overflow.md` | Single-line text overflow | ui-atoms | 16,466 | 4038 | 9 |
| `user-experience/form-factor-adaptation.md` | Adapt to the form factor | user-experience | 6,122 | 1660 | 6 |
| `user-experience/natural-interactions.md` | Implement natural interactions | user-experience | 9,981 | 2573 | 5 |
| `pwa/install-web-app.md` | Installing web applications | pwa | 15,335 | 3315 | 4 |

Notes:

- None of the 15 new guides is gated: no `originTrials`, no `volatileFeatures` entries.
- All 15 are small-to-medium (6.1–22.2 KB); the biggest are `tabs` (22.2 KB) and `toolbar` (22.1 KB).
- All 15 follow the new house style: an implementation body **plus an explicit `## Fallback strategies` (or
  `## Fallbacks`) section** with one subsection per modern feature used. This is the dominant style of v1.0.0.
- Three new guides are cross-referenced from *existing* guides, so re-vendoring changes prose links too:
  `single-line-overflow` ← `css/css-layout.md`, `ui-atoms/responsive-table.md`;
  `navbar` + `app-menus` ← `ui-components/menu.md`.

---

## 3. Removed / renamed / retitled

- **Removed paths: 0.** Every guide id we ship still exists.
- **Renamed paths: 0.** No id changed category or filename.
- **Retitled H1s: 4** (content changed as well, all inside the 105):

| guide | old H1 | new H1 |
| --- | --- | --- |
| `css/style-parent-with-has.md` | Style Parent with `:has()` | Style a Form Group When a Field Is Invalid with `:has()` |
| `forms/autofill-highlight-inputs.md` | Highlight browser-autofilled fields the user hasn't edited with CSS `:autofill` | Customize the styling of autofilled form fields |
| `ui-behaviors/group-element-transitions.md` | Group Element Transitions | Smoothly rearrange cards, lists, and groups of elements on add, remove, or reorder |
| `ui-components/menu.md` | Build a dropdown menu | Build a popup menu |

Consequence for us: guide **ids are stable, titles are not**; nothing in our search index keys off H1, so no code
change — but any screenshot/doc quoting a title should be refreshed.

---

## 4. Changed guides — 105 byte-changed, 98 announced, 7 silent

Of the 193 guides we currently ship, **105 differ** from v1.0.0 and 88 are byte-identical.

The release notes list **98** guides under “Per-guide changes”. That list is a **strict subset**: 98 of our 105.
Seven guides changed without being announced anywhere in the release notes:

| silent change | category | churn |
| --- | --- | ---: |
| `ui-atoms/scroll-position-aware-elements.md` | ui-atoms | +1 / −1 |
| `visual-design/apply-webgl-shaders.md` | visual-design | +1 / −1 |
| `visual-design/export-html-media-from-canvas.md` | visual-design | +1 / −1 |
| `visual-design/expose-canvas-content-to-browser-features.md` | visual-design | +1 / −1 |
| `visual-design/interactive-content-in-3d-scenes.md` | visual-design | +1 / −1 |
| `built-in-ai/language-detection.md` | built-in-ai | +3 / −0 |
| `css/child-state-based-styling.md` | css | +2 / −2 |

(The five visual-design/built-in-ai one-liners look like a mechanical sweep — a single line edited in place, byte
length unchanged — most likely a compatibility-note line; `child-state-based-styling` and `language-detection` are
ordinary small edits.)

### 4.1 Churn distribution

| changed lines | guides | shape of the edit |
| --- | ---: | --- |
| 1–2 | 20 | link/one-line edit: cross-refs to new guides, a `DO/DON'T` token, `Object.hasOwn()` feature detection, `transition-behavior` wording, title/tone fixes |
| 3–10 | 23 | one bullet or one code block added (contrast ratios, `rpId` usage, reduced-motion guard) |
| 11–40 | 28 | section rewrites, new a11y sub-block |
| 41–100 | 18 | substantial rework, new fallback subsections |
| 100+ | 16 | effectively rewritten guides (see below) |

By category: `ui-behaviors` 26, `forms` 14, `visual-design` 13, `ui-atoms` 12, `ui-components` 11, `security` 9,
`css` 8, `html` 3, `performance` 3, `built-in-ai` 3, `accessibility` 1, `user-experience` 1, `pwa` 1.

### 4.2 Character of the edits, by theme

Measured from the diff hunks (added/removed headings and tokens), cross-checked against the release notes:

1. **Accessibility review by human experts — the dominant theme (~70 guides).**
   - 3:1 non-text contrast for focus rings, icons, custom controls, scrollbar thumbs
     (added tokens `contrast`, `3:1`, plus edits in `icons`, `checkbox`, `customize-scrollbar-color-and-thickness`,
     `branded-select-styling`, `custom-select-picker-layouts`, `adapt-scrollbar-to-contrast-preferences`, …).
   - Error plumbing rewritten: initialise `aria-invalid="false"`, attach error ids to `aria-describedby` **only while
     invalid** (via `data-error`), announce blur errors through a **polite live region**, focus the first invalid
     field on submit. This is the single most repeated change — it recurs in `accessible-error-announcement`,
     `required-field-feedback`, `validate-input-after-interaction`, `select-menu-interaction`,
     `style-parent-with-has`, `forms`.
   - Gesture alternatives: swipe/pull/drag guides gain visible buttons or keyboard paths
     (`swipe-to-remove`, `swipe-to-reveal`, `pull-to-reveal`, `drag`, `drag-and-drop`).
   - Broader coverage of reduced motion, forced colors, focus management, 200 % zoom / 400 % reflow.
2. **Fallback sections re-normalised.** Added headings: `## Fallback strategies` ×11 and
   `## Accessibility considerations` ×11; the old `### Fallback strategies` was removed ×9 (heading promoted one
   level). New per-feature pattern `### Fallbacks & browser support for <feature>` (5 × for Anchor positioning alone,
   with `#### Option 1: Polyfill (@oddbird/css-anchor-positioning)` / `#### Option 2: Progressive enhancement with
   @supports`).
3. **Passkeys (7 guides).** Server-provided `rpId` / `publicKey.rp.id` passed to Signal API methods instead of
   deriving it from `window.location.hostname`; Base64URL validation; `console.warn` instead of console errors.
4. **Discrete transitions (3 guides).** `transition-behavior: allow-discrete` declared **standalone**, never inside the
   `transition` shorthand, so older parsers don't drop the whole declaration.
5. **Component architecture corrections.** `navigation-drawer` → `<dialog>`+`showModal()` for pure drawers,
   `popover="manual"` for drawer/sidebar hybrids; `menu` → standalone trigger vs menubar, safe-triangle pointer bridge;
   `tabs` (new) → `focusgroup` + `hidden="until-found"`.
6. **Baseline data refresh.** Scroll-driven animations became Baseline Newly available across 9 guides; container
   scroll-state query browser versions updated in 4; `focusgroup` Chrome/Edge 150 in `menu`.
7. **Title narrowing** of 4 guides (§3) so the H1 names one concrete use case.
8. **Bug/lore fixes**: `migrate-web-app-origin` manifest `migrate_to` is a single object (`id`, `install_url`), not an
   array; `typography` line length `max-width: 60ch`; `color`/`contrast-color` luminance math moved to
   `color(xyz-d65)`.

Top-of-churn guides (full list in §10):

| guide | +/− lines | bytes |
| --- | ---: | --- |
| `ui-atoms/scrollability-affordance-hints.md` | +220 / −68 | 3,779 → 12,224 |
| `accessibility/accessible-error-announcement.md` | +168 / −74 | 7,200 → 13,642 |
| `css/style-parent-with-has.md` | +182 / −37 | 6,190 → 13,964 |
| `forms/validate-input-after-interaction.md` | +169 / −21 | 8,823 → 17,625 |
| `forms/required-field-feedback.md` | +154 / −51 | 6,961 → 14,251 |
| `forms/select-menu-interaction.md` | +152 / −20 | 5,573 → 13,181 |
| `ui-behaviors/interest-triggered-tooltips.md` | +149 / −39 | 9,517 → 20,315 |
| `ui-components/persistent-toast-notifications.md` | +142 / −21 | 3,618 → 14,092 |
| `ui-components/hovercard.md` | +126 / −22 | 11,506 → 21,358 |
| `ui-behaviors/declarative-dialog-popover-control.md` | +9 / −91 | 10,523 → 7,742 |

---

## 5. Metadata schema — what actually changed

### 5.1 Guides have no frontmatter, in either version

Neither `0.0.197` nor `v1.0.0` puts YAML frontmatter in guide files: every guide starts directly with `# <H1>`.
So `description`, `featuresUsed`, `tokenCount`, `originTrials`, `volatileFeatures` exist **only** in the generated
index. There is no per-file metadata to migrate, and no scene where our generator can rebuild the index from the
markdown alone — the index must be vendored from the npm package.

### 5.2 `guides.json`: additive change only

| | ours (`0.0.197`) | v1.0.0 |
| --- | --- | --- |
| package path | `skills/modern-web-guidance/guides.json` | **`skills/modern-web-guidance/gen/guides.json`** (moved) |
| size | 72,103 B | 80,329 B |
| entries | 193 | 208 |
| fields | `id`, `description`, `category`, `featuresUsed[]`, `tokenCount`, `originTrials[]` (8 entries) | same six **plus** `volatileFeatures[]` (10 entries) |

Field presence, per entry: `id` ×208, `description` ×208, `category` ×208, `featuresUsed` ×208, `tokenCount` ×208,
`volatileFeatures` ×10, `originTrials` ×8. **No field was removed, renamed, or retyped.** `originTrials` is
unchanged down to the value level (same 8 ids, same `{id, chromestatus_url}` objects).

New field shape:

```json
"volatileFeatures": [ { "reason": "built-in-ai", "id": "languagemodel" } ]
```

`reason` values in this release: `built-in-ai` (4 guides) and `recent-single-engine` (6 guides):

| guide | reason(s) |
| --- | --- |
| `language-detection` | `built-in-ai` |
| `language-model` | `built-in-ai` |
| `summarizer` | `built-in-ai` |
| `translator` | `built-in-ai` |
| `out-of-order-html-streaming` | `recent-single-engine` ×2 (`html-setters`, `html-streaming-setters`) |
| `client-side-encryption` | `recent-single-engine` (`tmp-webcrypto-modern-algos`) |
| `digital-signatures` | `recent-single-engine` (`tmp-webcrypto-modern-algos`) |
| `restrict-outbound-connections` | `recent-single-engine` (`connection-allowlists`) |
| `2d-panning` | `recent-single-engine` (`scroll-axis-lock`) |
| `custom-text-decorations` | `recent-single-engine` (`text-decoration-skip-spaces`) |

For our plugin this is a **non-breaking** addition: `lib/guidance.js` reads `featuresUsed` and `tokenCount` by name
with defaults and ignores unknown fields, so search/retrieve keep working and the 10 volatile guides stay retrievable
(we simply do not gate them — see §6.3 and risk R-3).

### 5.3 Drift inside existing entries

| field | entries changed (of 193 common) | notes |
| --- | ---: | --- |
| `tokenCount` | **193 (all)** | re-tokenised, not content-driven: `accessibility` 14,305 → 13,341 while its file is byte-identical |
| `featuresUsed` | 12 | mostly additional names, e.g. `autofill-highlight-inputs` += `Text stroke and fill (compatibility prefixes)`, `passkey-reauthentication` += `Web authentication signal methods`, `swipe-to-remove` += `prefers-reduced-motion media query` |
| `description` | 4 | `autofill-highlight-inputs`, `break-up-long-tasks`, `scrollability-affordance-hints`, `group-element-transitions` |
| `category` | **0** | category assignment is stable |

Σ `tokenCount` 430,254 → 474,620. Our code and docs treat `tokenCount` as informational (it is folded into the
retrieval hint / report), so no logic change — but every doc claim derived from it (“~450k tokens”, “1.5 MB”) is now
stale by construction.

### 5.4 New generated companions (we do **not** vendor them)

`gen/` also ships embedding/BM25 payloads that only the upstream CLI needs:
`guide-chunks.i8` (516,096 B) + `guide-chunks.json.gz` (652,475 B) + `guide-chunks.scale.f32` (8,064 B),
`query-words.i8` (7,466,240 B) + `query-words.json` (316,653 B) + `query-words.scale.f32` (116,660 B).
Our own BM25 index is built at load time from `guides.json` + guide bodies, so these are irrelevant to us — but they
explain the package layout change and the `THIRD_PARTY_NOTICES` file reappearing in the tarball.

---

## 6. `SKILL.md` — what v1.0.0 changed

Upstream diff, `0.0.197` package `SKILL.md` → `v1.0.0` package `SKILL.md` (LF to LF):
**+23 / −5 lines, 72 → 90 lines, 7,939 → 9,793 B.**

Abridged for readability: unchanged context is elided and long lines are wrapped — the authoritative output is
`git diff --no-index <0.0.197 SKILL.md> <1.0.0 SKILL.md>` (+23 / −5).

```diff
-## Usage Instructions
+## Primary Workflow
@@ Step 1. Search Use Cases
+- **Name implied UI primitives**: When the user's prompt expresses intent without naming the UI primitive
+  (e.g. "confirm first", "pick a date"), translate the domain intent into the implied UI component or platform
+  mechanism (e.g. search `"confirmation modal dialog"` … `"date picker input"` rather than `"pick a date"`).
-npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_10_30-58d055df
+npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_11_09-5bcc021b
-> - **No match on a web UI/CSS/DOM behavior (or broad UI audit)**: … run `list` once …
-> - **Topic not covered**: … proceed … without retry loops …
+> - **Weak or empty results**: … **rephrase `search` once** using the concrete HTML/CSS/UI component noun or
+>   synonym (e.g., `dialog`, `modal`, `popover`, `table`, `form`) before falling back to `list` …
+> - **Topic not covered**: If no `description` matches after rephrasing, proceed without retrieving unrelated guides.
@@ Step 3. Verify Guidance Compliance
+- Do not run `legacy-scan`; it's for detecting legacy patterns to modernize, not this.
@@ after Step 4
+## Alternative flow: Modernize an existing codebase
+**Only** when asked for a broad, open-ended codebase modernization … run the 4-step modernization flow:
+> **Note**: `legacy-scan` scans for a curated subset (~20% of the guidance corpus).
+1. Scan: Run `legacy-scan <path> --json` …
+2. Verify: Check each finding against its `keepWhen` / `dropWhen` rubric; drop false positives …
+3. Report: Summarize verified findings … noting that `legacy-scan` only checks the subset (~20 %) …
+4. Modernize (when the user asked to modernize rather than only audit/report): Retrieve each finding's guide …,
+   apply the replacement …, and re-run `legacy-scan <path>` on the modified files to confirm resolution.
+   - Dropped findings and kept fallbacks still match static scans; do not edit safe code or inspect
+     `legacy-scan.mjs` to force 0 findings.
@@ Reactive Policy Discovery
-Suggest documenting a policy in `CLAUDE.md` or `AGENTS.md`
+Suggest documenting a policy in `AGENTS.md` or `CLAUDE.md`
```

Semantic blocks, in the order that matters for us:

1. **Search-query refinement (new, in the workflow).** Two additions: *translate domain intent into the implied UI
   primitive* (a new bullet with examples), and *rephrase `search` **once** before falling back to `list`*
   (replacing the old “no match → run `list` immediately” advice). The `--skill-version` pin moved to
   `2026_11_09-5bcc021b`.
2. **`legacy-scan` 4-step workflow (new, separate “Alternative flow” section).** Gated on “only for broad, open-ended
   modernization with no named feature”; scan → verify against `keepWhen`/`dropWhen` → report → modernize + re-scan.
   Also a guard in Step 3: *do not run `legacy-scan` for ordinary implementation work*.
3. **Step 2 / Step 4 JSON shape.** Unchanged in substance (multi-id retrieve, `>9.5 KB` output saved to a file must be
   read with the file tool, one `### Modern Web Guidance` disclosure bullet per applied id, ≤75 words, verbatim quote).
4. **Volatile / Origin-Trial gating and `.mwgrc` are *not* mentioned in `SKILL.md`.** They live in README + CLI (see
   §6.3). So a skill rewrite does not need gating prose unless *we* decide to surface the gate.
5. **Guidelines / “Interpreting Browser Support & Fallbacks”** are unchanged apart from the `AGENTS.md`/`CLAUDE.md`
   ordering; the Baseline-anchored fallback rule (`Baseline YYYY` satisfied when “Baseline since” ≤ YYYY) is verbatim.

### 6.1 What this means for our adapted `SKILL.md`

Our copy is a deliberate adaptation (tool calls `web_guidance_search` / `web_guidance_retrieve` / `web_guidance_list`
instead of `npx`, plus the data-not-instructions guardrail). Porting the upstream delta gives:

| upstream change | action for our adapted copy |
| --- | --- |
| intent → implied UI primitive bullet | **port** (drop the `npx` framing, keep the examples) |
| “rephrase once before `list`” | **port** — our Step 1 already says “rephrase once with different wording before concluding the catalog does not cover it”; align wording, keep `web_guidance_list` as the fallback |
| `--skill-version` pin | **drop** — no CLI in our plugin (corpus identity lives in `data/corpus.json`) |
| `legacy-scan` 4-step flow + Step 3 guard | **do not port** — we ship no scanner. Do add one neutral sentence: *“This plugin does not include the upstream `legacy-scan` modernization workflow.”* so a model does not try to run it |
| `AGENTS.md`/`CLAUDE.md` order | trivial, port if touching the file |
| counts (`193`) | **update to 208** and refresh the “When to use it” list with the 15 new component/pattern guides (accordion, app menus, breadcrumbs, carousel, copy button, navbar, tabs, toolbar, drag-and-drop, dynamic sort, sortable table, single-line overflow, form-factor adaptation, natural interactions, web app install) |

### 6.2 Upstream package surface around the skill (context, we vendor none of it)

| package entry | 0.0.197 | 1.0.0 | note |
| --- | --- | --- | --- |
| `skill-version.txt` | `2026_10_30-58d055df` | `2026_11_09-5bcc021b` | our `corpus.json` mirrors this |
| `guides.json` | `guides.json` 72,103 B | `gen/guides.json` 80,329 B | vendored (ours) |
| `search.mjs` | 423,970 B | **6,890 B** + map | CLI split; embeddings moved to `gen/` |
| `modern-web.mjs` | 26,615 B | 38,282 B | CLI; gained `legacy-scan`, `set-baseline`, volatile gate |
| `legacy-scan.mjs` | — | **4,992,779 B** | new (not for us: we ship zero dependencies, no scan tool) |
| `watchdog/main.js` | 4,446 B | 4,446 B | unchanged |
| `THIRD_PARTY_NOTICES` | present (23,718 B) | present (33,965 B) | covers CLI deps only (grew with the embedder/`legacy-scan` deps) |

### 6.3 Gating behaviour in v1.0.0 (CLI-side, informational for our design)

`.mwgrc` was already present in `0.0.197` with `allowOriginTrials`; v1.0.0 adds:

| `.mwgrc` key | CLI command | effect |
| --- | --- | --- |
| `allowOriginTrials: true` | `set-allow-origin-trials` | unlocks `retrieve` for the 8 `originTrials` guides (unchanged from 0.0.197) |
| `allowVolatileFeatures: true` | `set-allow-volatile-features` | **new** — unlocks `retrieve` for the 10 `volatileFeatures` guides |
| `baseline: "widely" \| "newly" \| "limited" \| "2024"` | **new** `set-baseline` | injects a “Project Baseline Target (`.mwgrc`)” note into `retrieve` output |

Gates are implemented as markdown banners prepended to the retrieved guide (including “never bypass this gate” text),
not as errors in `search`: volatile and OT guides stay searchable and only `retrieve` is gated.
Our plugin has no equivalent (we serve the guide verbatim) — see risk R-3.

---

## 7. Categories — final table

17 categories, unchanged set (no new category directory in v1.0.0):

| category | ours | v1.0.0 | Δ |
| --- | ---: | ---: | ---: |
| accessibility | 4 | 4 | 0 |
| built-in-ai | 4 | 5 | +1 |
| css | 18 | 18 | 0 |
| forms | 19 | 19 | 0 |
| html | 8 | 8 | 0 |
| js | 5 | 5 | 0 |
| performance | 26 | 26 | 0 |
| privacy | 1 | 1 | 0 |
| pwa | 1 | 2 | +1 |
| security | 17 | 17 | 0 |
| ui-atoms | 12 | 13 | +1 |
| ui-behaviors | 37 | 40 | +3 |
| ui-components | 14 | 22 | +8 |
| user-experience | 1 | 3 | +2 |
| visual-design | 22 | 22 | 0 |
| wasm | 1 | 1 | 0 |
| webmcp | 3 | 3 | 0 |
| **files / index entries** | **193 / 193** | **209 / 208** | **+16 / +15** |

---

## 8. What our re-vendoring must do

Nothing here is a code redesign: the corpus is data, and our code reads both files by name. Ordered checklist.

### 8.1 Get the right artifact (do not use the git tag)

```bash
# in the repo root; the tarball is the only source of gen/guides.json + skill-version.txt
mkdir -p .tmp/mwg-1.0.0 && cd .tmp/mwg-1.0.0
npm pack modern-web-guidance@1.0.0          # or: curl -L -o mwg.tgz \
  # https://registry.npmjs.org/modern-web-guidance/-/modern-web-guidance-1.0.0.tgz
# verify BEFORE extracting:
#   sha512 integrity = sha512-vafIZwC8AS6QjM2yyoflZbnc7n3/TVOMLbEMRdPTwcFy0f9/Tq8s5rJQ8UIqRt2KPl9ixravyaMR4nTGuUrcmg==
#   size            = 8,794,985 B
tar -xzf modern-web-guidance-1.0.0.tgz     # → package/skills/modern-web-guidance/
```

Note for sandboxed runs: `npx`/`npm view` fail on the npm cache directory (EPERM outside the workspace), while a plain
`node -e "fetch(...)"` download inside `.tmp/` works. Use the Node fetch route if npm is blocked.

### 8.2 Replace the corpus (all-or-nothing, byte copy)

```bash
SRC=.tmp/mwg-1.0.0/package/skills/modern-web-guidance
rm -rf data/guides
mkdir -p data/guides
node -e '
  const fs=require("fs"),path=require("path");
  const src=process.argv[1], dst="data/guides";
  const idx=JSON.parse(fs.readFileSync(path.join(src,"gen/guides.json"),"utf8"));
  for (const {id,category} of idx) {
    const from=path.join(src,"guides",category,id+".md");
    const to=path.join(dst,category,id+".md");
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.copyFileSync(from,to);          // preserve LF bytes, no reformatting
  }
  console.log("vendored",idx.length,"guides");
' "$SRC"
```

Expected result: **208 files in 17 category dirs**, 1,952,778 B total.
`built-in-ai/prompt-api.md` is intentionally **not** copied — it is not in the index and is a byte-identical
duplicate of `language-model.md` (this rule is already documented in `NOTICE:13`).

Then the two metadata files:

```bash
cp "$SRC/gen/guides.json" data/guides.json          # 80,329 B, 208 entries (path changed upstream: gen/)
# data/corpus.json ← new snapshot identity
printf '{\n  "version": "2026_11_09-5bcc021b",\n  "snapshotDate": "2026-11-09"\n}\n' > data/corpus.json
```

`v1.0.0` keeps the `guides.json` **field set** backward compatible (adds only `volatileFeatures`), so `index.js`,
`lib/guidance.js`, `lib/report.js` need **no** change for the corpus to load.

### 8.3 Chrome extensions skill — no work

`data/skills/chrome-extensions/` (24 markdown + `skill-version.txt` = `2026_08_06-8570fe7c`) is **byte-identical** to
`v1.0.0`'s `skills/chrome-extensions/`: 0 added, 0 removed, 0 differing files. Leave untouched, re-verify hashes when
re-running the audit.

### 8.4 Re-adapt `SKILL.md` (§6.1)

Update the count (193 → 208), refresh the “When to use it” inventory with the new component guides, port the two
search-refinement improvements, add the one-line “we do not ship `legacy-scan`” note, keep the guardrail block and the
`web_guidance_*` tool workflow verbatim.

### 8.5 Sweep the hardcoded counts and derived numbers

`193` appears in (all need 208 unless noted):

| file:line | what |
| --- | --- |
| `README.md:13,28,34,86,113,167,209`, `README.ru.md` (same lines), `README.zh.md` (same lines) | badges, prose, tool examples, “retrieving all 193 guides … 1.5 MB (~450k tokens)” |
| `index.js:23`, `index.js:224` | tool and skill descriptions shipped to the model |
| `market/awesome-dsh-plugin.yml:10` | marketplace blurb |
| `NOTICE:13` | “corpus is 193 files for 193 …” wording + snapshot identity |
| `PUBLISHING.md:60,78,118,132` | release/checklist claims |
| tests: `test/guidance.test.mjs:11`, `test/hardening.test.mjs:83,84,94`, `test/plugin.test.mjs:80`, `test/report.test.mjs:14,141,151`, `test/stats.test.mjs:112` | equality assertions + the fixture snapshot string |

Numbers that must be **re-derived**, not just bumped:

| claim | old | new |
| --- | --- | --- |
| guide bytes (README:167, PUBLISHING) | 1.5 MB / 1,557,860 B | **1,952,778 B (1.86 MiB)** |
| tokens (README:167 “~450k tokens”) | 430,254 | **474,620** |
| index size (audit/notice) | 72,103 B | **80,329 B** |
| package unpacked files/size (PUBLISHING:127 “230 files / 1.72 MB”) | — | recompute with `npm pack --dry-run`; only deltas are certain: **+15 files, +8,226 B index, +394,918 B corpus** |
| snapshot identity (`report.js` fixture, `test/report.test.mjs:14`) | `2026_10_30-58d055df` / `2026-10-30` | `2026_11_09-5bcc021b` / `2026-11-09` |

Also review: `locale/*.json` and the client panel copy if they mention “193” or “1.5 MB” (they did not appear in the
grep for `193`, but re-grep before release), and any `PUBLISHING.md` screenshot with the panel counters.

### 8.6 Re-run the audit against the new tarball

`audit/repro/corpus/provenance.mjs` hardcodes the old extraction path `E:\0ai\dsh_mod_1\.tmp-mwg\pkg\package`
(the `0.0.197` tarball). Point it at the v1.0.0 extraction, then:

```bash
node audit/repro/corpus/provenance.mjs     # 235 shipped data files; expect exactly 2 deviations:
                                          #   SKILL.md (our adaptation) + prompt-api.md (deliberate skip)
node audit/repro/corpus/index-integrity.mjs  # 208 ↔ 208 bijection, 0 missing, 0 orphan
node audit/repro/corpus/scan.mjs           # injection/hidden-codepoint/URL surface on the new bytes
node audit/repro/corpus/comments.mjs       # HTML-comment inventory will shift
```

Expectation from this diff: guide bodies are pure upstream bytes, so verdicts should not change — but the *counts*
in `audit/corpus.md` (files, bytes, lines, codepoints, host histogram, token totals) all change and must be
regenerated, not hand-edited.

### 8.7 Verify, then release

1. `node --test test/*.test.mjs` (Lead environment — spawn is EPERM in the sandbox, so this is not a sandbox step).
2. Independent recount (cheap sanity, no test runner needed):

```bash
node -e '
  const fs=require("fs"),p=require("path"),cp=require("child_process");
  const idx=JSON.parse(fs.readFileSync("data/guides.json","utf8"));
  const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);
  const files=walk("data/guides").filter(f=>f.endsWith(".md"));
  const ids=new Set(idx.map(e=>e.id));
  const stems=new Set(files.map(f=>p.basename(f,".md")));
  console.log({entries:idx.length, files:files.length, missing:idx.filter(e=>!stems.has(e.id)).length,
               orphan:[...stems].filter(s=>!ids.has(s)).length,
               bytes:files.reduce((n,f)=>n+fs.statSync(f).size,0),
               tokens:idx.reduce((n,e)=>n+e.tokenCount,0)});
'
# expected: { entries: 208, files: 208, missing: 0, orphan: 0, bytes: 1952778, tokens: 474620 }
```

3. Bump our plugin version (0.3.1 → 0.4.0: corpus refresh + skill rewrite, no API change) and rewrite the changelog
   with the measured numbers from §0, not the upstream headline numbers.

### 8.8 Decisions the Lead has to make (not mechanical)

| # | decision | options | cost |
| --- | --- | --- | --- |
| D-1 | Do we implement gate banners for `originTrials` / `volatileFeatures`? | (a) no gating — status quo, document it; (b) mark the 18 gated guides in search results and add a banner to `retrieve` text; (c) full `.mwgrc` support | (a) 0; (b) ~1 option flag + banner text + 2 tests; (c) config reader + policy UX = new scope |
| D-2 | Do we mention `.mwgrc` / Baseline target in our skill? | (a) no; (b) one sentence that the plugin assumes the guide's default Baseline policy | (b) is cheap and honest |
| D-3 | `legacy-scan` | do not ship (4.99 MB bundle, violates our zero-dependency/no-CLI story); state it in the skill | 0 |
| D-4 | `THIRD_PARTY_NOTICES` | keep omitting — we still vendor only markdown + JSON, no third-party code | 0, but re-check if `gen/` vectors are ever vendored |

---

## 9. Risks that can move the release plan

| # | risk | evidence | impact / mitigation |
| --- | --- | --- | --- |
| R-1 | **The git tag is not a vendorable source** | git tree has no `guides.json`/`skill-version.txt`; all 209 guide files are CRLF there vs LF in the package; our corpus matches the package bytes | any re-vendoring from `.tmp/upstream` alone would produce a CRLF corpus, no index, and a fake “all 209 changed” diff. Pin the npm tarball + integrity in the refresh script |
| R-2 | **Network is required to refresh** | registry reachable only through Node `fetch`; `npm view`/`npx` die on the npm cache dir (EPERM) in this sandbox | refresh script must download via `node -e fetch(...)` into `.tmp/`, verify `sha512-vafIZw…`, and fail loudly otherwise |
| R-3 | **We serve 18 gated guides ungated** | 8 `originTrials` + 10 `volatileFeatures`; upstream gates `retrieve` behind `.mwgrc` | behaviour mismatch with upstream, not a crash. Decide D-1; at minimum document it (a volatile/single-engine API can be recommended without the “experimental” banner) |
| R-4 | **Headline numbers are not the numbers we ship** | “203 use-case guides” = the 208 index ids minus 5 discipline overviews (§1) — consistent, but it is *not* our catalog size; “98 guides changed” vs measured 105 byte-changed (98 announced + **7 silent**) | do not copy upstream numbers into our README. Use measured 208 guides / 209 files / 15 new / 105 changed, and if we quote “98 updated”, say “98 announced upstream (+7 undocumented edits)” |
| R-5 | **All 193 `tokenCount` values changed** without content change | e.g. `accessibility` 14,305 → 13,341 on an identical file | anything comparing token counts across snapshots is meaningless; README “~450k tokens” and any `tokenCount`-derived fixture (report output) must be regenerated |
| R-6 | **Payload growth** | corpus +394,918 B (1.49 → 1.86 MiB), index +8,226 B, +15 files | still far below the old 1.5 MB expectation for a single retrieve (cap is 120,000 chars per call), but `PUBLISHING.md` size claims and any tarball measurement must be redone |
| R-7 | **Notices/attribution wording** | `NOTICE:13` explains the 193/193 rule and the snapshot identity | update wording to 208/208 + new snapshot; Apache-2.0 obligations unchanged (still unmodified upstream content + our single adapted `SKILL.md`) |

---

## 10. Appendix — all 105 byte-changed guides

“release notes” = the guide appears in the upstream v1.0.0 “Per-guide changes (98 guides)” list; **silent** = it does
not, despite a byte difference.

| guide | category | +lines | -lines | bytes (old → new) | release notes |
| --- | --- | ---: | ---: | --- | --- |
| `ui-atoms/scrollability-affordance-hints.md` | ui-atoms | +220 | -68 | 3,779 → 12,224 | listed |
| `accessibility/accessible-error-announcement.md` | accessibility | +168 | -74 | 7,200 → 13,642 | listed |
| `ui-components/menu.md` | ui-components | +113 | -108 | 29,155 → 31,801 | listed |
| `css/style-parent-with-has.md` | css | +182 | -37 | 6,190 → 13,964 | listed |
| `forms/required-field-feedback.md` | forms | +154 | -51 | 6,961 → 14,251 | listed |
| `forms/validate-input-after-interaction.md` | forms | +169 | -21 | 8,823 → 17,625 | listed |
| `ui-behaviors/interest-triggered-tooltips.md` | ui-behaviors | +149 | -39 | 9,517 → 20,315 | listed |
| `ui-behaviors/group-element-transitions.md` | ui-behaviors | +98 | -86 | 5,158 → 6,365 | listed |
| `ui-components/navigation-drawer.md` | ui-components | +119 | -55 | 16,375 → 20,826 | listed |
| `forms/select-menu-interaction.md` | forms | +152 | -20 | 5,573 → 13,181 | listed |
| `ui-components/persistent-toast-notifications.md` | ui-components | +142 | -21 | 3,618 → 14,092 | listed |
| `security/passkey-management.md` | security | +113 | -39 | 11,796 → 17,759 | listed |
| `ui-behaviors/swipe-to-remove.md` | ui-behaviors | +125 | -27 | 27,826 → 34,703 | listed |
| `ui-components/hovercard.md` | ui-components | +126 | -22 | 11,506 → 21,358 | listed |
| `ui-components/persistent-app-tours.md` | ui-components | +91 | -44 | 5,354 → 11,505 | listed |
| `forms/forms.md` | forms | +75 | -40 | 15,093 → 19,384 | listed |
| `ui-behaviors/declarative-dialog-popover-control.md` | ui-behaviors | +9 | -91 | 10,523 → 7,742 | listed |
| `ui-behaviors/swipe-to-reveal.md` | ui-behaviors | +78 | -18 | 10,791 → 14,518 | listed |
| `ui-atoms/viewport-aware-dropdowns.md` | ui-atoms | +66 | -22 | 7,209 → 10,157 | listed |
| `ui-components/stack-drill-down.md` | ui-components | +60 | -17 | 34,192 → 37,348 | listed |
| `ui-behaviors/scrollytelling.md` | ui-behaviors | +39 | -35 | 8,482 → 9,013 | listed |
| `forms/autofill-highlight-inputs.md` | forms | +45 | -27 | 2,320 → 3,628 | listed |
| `html/html.md` | html | +44 | -25 | 17,935 → 21,320 | listed |
| `ui-behaviors/animate-to-from-top-layer.md` | ui-behaviors | +35 | -33 | 10,285 → 10,942 | listed |
| `ui-behaviors/motion.md` | ui-behaviors | +31 | -36 | 5,189 → 7,787 | listed |
| `ui-behaviors/scroll-snap-realtime-feedback.md` | ui-behaviors | +64 | -1 | 6,871 → 10,983 | listed |
| `performance/out-of-order-html-streaming.md` | performance | +43 | -20 | 8,084 → 12,432 | listed |
| `ui-atoms/carousel-slide-effects.md` | ui-atoms | +41 | -21 | 8,329 → 10,358 | listed |
| `forms/rich-media-picker.md` | forms | +55 | -4 | 6,822 → 10,728 | listed |
| `built-in-ai/language-model.md` | built-in-ai | +46 | -12 | 16,697 → 19,418 | listed |
| `ui-behaviors/scroll-entry-exit-effects.md` | ui-behaviors | +43 | -12 | 8,052 → 10,057 | listed |
| `ui-atoms/position-aware-tooltips.md` | ui-atoms | +31 | -16 | 6,948 → 8,460 | listed |
| `ui-behaviors/drag.md` | ui-behaviors | +39 | -5 | 4,864 → 6,996 | listed |
| `security/passkey-authentication.md` | security | +28 | -15 | 9,904 → 11,774 | listed |
| `security/passkey-reauthentication.md` | security | +24 | -10 | 5,055 → 6,512 | listed |
| `security/passkey-conditional-create.md` | security | +18 | -13 | 6,715 → 8,040 | listed |
| `security/passkey-registration.md` | security | +18 | -13 | 9,532 → 10,583 | listed |
| `ui-behaviors/highlight-text-ranges.md` | ui-behaviors | +20 | -11 | 5,574 → 6,525 | listed |
| `security/quick-sign-ins.md` | security | +18 | -12 | 16,498 → 17,882 | listed |
| `ui-components/progress-ring.md` | ui-components | +20 | -8 | 6,174 → 7,080 | listed |
| `visual-design/contrast-color.md` | visual-design | +8 | -19 | 7,014 → 7,263 | listed |
| `ui-components/scrollspy.md` | ui-components | +19 | -4 | 5,948 → 7,036 | listed |
| `ui-behaviors/carousel-snap-highlights.md` | ui-behaviors | +15 | -6 | 5,855 → 7,678 | listed |
| `forms/animated-select-picker.md` | forms | +13 | -7 | 8,116 → 8,748 | listed |
| `user-experience/content-first-noise-reduction.md` | user-experience | +6 | -14 | 8,465 → 8,475 | listed |
| `css/animate-to-intrinsic-sizes.md` | css | +12 | -6 | 5,463 → 5,809 | listed |
| `ui-behaviors/move-dom-element-without-losing-state.md` | ui-behaviors | +14 | -4 | 2,634 → 3,855 | listed |
| `ui-components/dialog.md` | ui-components | +5 | -13 | 12,388 → 12,398 | listed |
| `ui-components/spinner.md` | ui-components | +14 | -4 | 5,313 → 6,025 | listed |
| `ui-behaviors/interactive-content-reveal.md` | ui-behaviors | +12 | -5 | 5,218 → 5,846 | listed |
| `css/calculate-with-intrinsic-sizes.md` | css | +13 | -3 | 9,944 → 10,671 | listed |
| `visual-design/color.md` | visual-design | +8 | -8 | 3,596 → 4,481 | listed |
| `pwa/migrate-web-app-origin.md` | pwa | +6 | -8 | 3,636 → 3,700 | listed |
| `ui-behaviors/2d-panning.md` | ui-behaviors | +8 | -6 | 9,118 → 9,427 | listed |
| `forms/custom-select-picker-layouts.md` | forms | +6 | -7 | 7,573 → 8,000 | listed |
| `ui-atoms/state-aware-sticky-headers.md` | ui-atoms | +11 | -2 | 6,429 → 6,885 | listed |
| `ui-behaviors/parallax-scroll-effects.md` | ui-behaviors | +8 | -5 | 9,064 → 9,753 | listed |
| `forms/autofill-sign-in-form.md` | forms | +8 | -4 | 10,540 → 10,767 | listed |
| `forms/autofill-sign-up-form.md` | forms | +8 | -4 | 11,772 → 11,864 | listed |
| `ui-behaviors/scroll-snap-state-sync.md` | ui-behaviors | +10 | -1 | 4,050 → 4,954 | listed |
| `ui-behaviors/spatial-navigation.md` | ui-behaviors | +10 | -1 | 5,800 → 6,937 | listed |
| `visual-design/adapt-scrollbar-to-contrast-preferences.md` | visual-design | +5 | -6 | 3,611 → 3,699 | listed |
| `html/form-associated-custom-elements.md` | html | +10 | -0 | 4,245 → 5,012 | listed |
| `ui-atoms/scroll-progress-indicator.md` | ui-atoms | +4 | -6 | 6,918 → 6,774 | listed |
| `ui-behaviors/animate-element-entry-exit.md` | ui-behaviors | +5 | -4 | 7,814 → 7,840 | listed |
| `visual-design/typography.md` | visual-design | +5 | -4 | 2,415 → 3,678 | listed |
| `forms/autofill-address-form.md` | forms | +6 | -2 | 4,866 → 5,009 | listed |
| `forms/autofill-payment-form.md` | forms | +6 | -2 | 9,827 → 9,970 | listed |
| `ui-behaviors/custom-button-actions.md` | ui-behaviors | +7 | -1 | 8,239 → 8,363 | listed |
| `visual-design/browser-ui-theming.md` | visual-design | +6 | -2 | 3,717 → 4,231 | listed |
| `visual-design/dark-mode.md` | visual-design | +7 | -1 | 16,873 → 17,170 | listed |
| `visual-design/shaped-cutouts.md` | visual-design | +5 | -3 | 7,179 → 7,311 | listed |
| `ui-atoms/shrinking-header-on-scroll.md` | ui-atoms | +4 | -3 | 6,516 → 7,191 | listed |
| `ui-behaviors/anchor-positioning-tab-underline.md` | ui-behaviors | +3 | -4 | 3,026 → 3,130 | listed |
| `built-in-ai/summarizer.md` | built-in-ai | +5 | -1 | 6,099 → 6,360 | listed |
| `security/security.md` | security | +3 | -3 | 29,832 → 30,035 | listed |
| `ui-behaviors/scroll-completion-effects.md` | ui-behaviors | +6 | -0 | 6,793 → 7,630 | listed |
| `ui-atoms/component-specific-light-dark-theme.md` | ui-atoms | +5 | -0 | 9,526 → 9,737 | listed |
| `css/atrule-support-conditionals.md` | css | +1 | -3 | 5,799 → 5,775 | listed |
| `css/child-state-based-styling.md` | css | +2 | -2 | 4,971 → 4,969 | **silent** |
| `ui-behaviors/interest-triggered-action-previews.md` | ui-behaviors | +2 | -2 | 4,981 → 4,970 | listed |
| `built-in-ai/language-detection.md` | built-in-ai | +3 | -0 | 3,658 → 3,663 | **silent** |
| `ui-atoms/icons.md` | ui-atoms | +2 | -1 | 18,080 → 18,343 | listed |
| `ui-behaviors/light-dismiss-a-dialog.md` | ui-behaviors | +3 | -0 | 3,693 → 4,244 | listed |
| `visual-design/custom-text-decorations.md` | visual-design | +2 | -1 | 16,727 → 16,762 | listed |
| `css/css-layout.md` | css | +2 | -0 | 21,396 → 21,659 | listed |
| `css/fluid-scaling.md` | css | +2 | -0 | 3,095 → 3,317 | listed |
| `css/responsive-design.md` | css | +1 | -1 | 1,439 → 1,885 | listed |
| `forms/brand-consistent-forms.md` | forms | +1 | -1 | 8,513 → 8,556 | listed |
| `forms/branded-select-styling.md` | forms | +1 | -1 | 5,742 → 5,785 | listed |
| `html/web-components.md` | html | +1 | -1 | 6,732 → 6,804 | listed |
| `performance/break-up-long-tasks.md` | performance | +1 | -1 | 2,239 → 2,287 | listed |
| `performance/performance.md` | performance | +1 | -1 | 21,123 → 21,118 | listed |
| `security/passkeys.md` | security | +1 | -1 | 4,511 → 4,973 | listed |
| `security/restrict-outbound-connections.md` | security | +1 | -1 | 13,361 → 13,539 | listed |
| `ui-atoms/scroll-position-aware-elements.md` | ui-atoms | +1 | -1 | 3,718 → 3,718 | **silent** |
| `ui-behaviors/directional-navigation-transitions.md` | ui-behaviors | +1 | -1 | 5,026 → 5,225 | listed |
| `ui-components/checkbox.md` | ui-components | +2 | -0 | 5,645 → 5,878 | listed |
| `visual-design/apply-webgl-shaders.md` | visual-design | +1 | -1 | 13,404 → 13,404 | **silent** |
| `visual-design/customize-scrollbar-color-and-thickness.md` | visual-design | +2 | -0 | 2,483 → 2,771 | listed |
| `visual-design/export-html-media-from-canvas.md` | visual-design | +1 | -1 | 17,553 → 17,553 | **silent** |
| `visual-design/expose-canvas-content-to-browser-features.md` | visual-design | +1 | -1 | 20,075 → 20,075 | **silent** |
| `visual-design/interactive-content-in-3d-scenes.md` | visual-design | +1 | -1 | 19,627 → 19,627 | **silent** |
| `ui-atoms/pull-to-reveal.md` | ui-atoms | +1 | -0 | 4,811 → 5,144 | listed |
| `ui-atoms/responsive-table.md` | ui-atoms | +1 | -0 | 4,256 → 4,556 | listed |

---

## 11. Reproduce (analysis scripts are temp-only, git-ignored)

All scripts live in `.tmp/upstream-diff/` and are read-only w.r.t. the repo (they only write reports into `.tmp/`):

| script | purpose |
| --- | --- |
| `fetch-tarball.mjs` | downloads `modern-web-guidance@1.0.0` from the registry into `.tmp/upstream-diff/mwg-1.0.0.tgz` |
| `inventory.py` | path set diff, added/removed, depth + frontmatter probes |
| `diff.py` | 193 vs 209 comparison → `added.json`, `changed.json`, category counters, titles |
| `schema.py` | `guides.json` schema diff, `volatileFeatures`/`originTrials` inventory, tokenCount drift, new-guide metadata |
| `themes.py` | heading/token theme extraction over the 105 changed guides, description/features drift |
| `titles.py` | H1 title drift, churn buckets, new-guide structure, cross-reference graph |
| `crosscheck.py` | release-notes list vs measured changes, volumes, chrome-extensions hash check |
| `tables.py` | generates the two markdown tables spliced into this document |
| `release-notes.mjs` | fetches the GitHub release body (used for the 98-guide list) |

Intermediate reports: `diff-report.txt`, `schema-report.txt`, `themes-report.txt`, `titles-report.txt`,
`crosscheck-report.txt`, `release-notes.txt`, plus `pkg100/` (extracted tarball).

Verification of every claim above is a one-liner over `.tmp/upstream-diff/pkg100/package/skills/modern-web-guidance/`
(209 guide files, `gen/guides.json`, `skill-version.txt`) vs `data/` (193 guide files, `guides.json`, `corpus.json`).
