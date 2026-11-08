# Adversarial audit — `dsh-modern-web-guidance`

Date: 2026-11-08. Surface driven directly: `lib/guidance.js` (`createGuidance({dataDir})`) and
the three tool objects built by `index.js`, using the mocked Cordis ctx from `test/plugin.test.mjs`.
Baseline first: `node test/guidance.test.mjs` → 7/7 pass, `node test/plugin.test.mjs` → 4/4 pass.

All repros live in `audit/repro/bugs/` and run with `node <file>`; each prints EXPECT/ACTUAL,
prints `DEFECT REPRODUCED` and exits 1 while the defect exists. `_harness.mjs` is shared support,
not a finding.

Severity counts: **HIGH 2 · MEDIUM 2 · LOW 3**, plus 4 suspected/unverified items.

---

## CONFIRMED

### 1. HIGH — `web_guidance_retrieve` has no bound on guides, bytes or duplicates
`lib/guidance.js:295-311` (`retrieve`, content pushed at 308), rendered by `index.js:64-75`.
There is no cap on `ids.length`, no per-guide or total byte limit, no truncation, and no
de-duplication (line 302 iterates `requested` as given).

Repro: `node audit/repro/bugs/02-retrieve-unbounded.mjs`
- Expect: a bound (max guides and/or byte cap with a truncation notice).
- Actual: `web_guidance_list` ids → `retrieve(193 ids)` returns **1,566,115 bytes (~447,000 tokens)**
  in one tool result; the same ids passed twice return 386 guides / **3,132,232 bytes**; 10,000
  unknown ids are echoed back verbatim (108,974 bytes).
- Impact: one plausible call ("load everything relevant") overflows the agent's context window and
  can end the session; duplicate ids — the exact thing the description invites ("a comma-separated
  string") — double the payload. Cost is ~0 ms, so nothing throttles it. (Host-side output
  truncation could not be verified — the DSH checkout is a packed asar that is not present at the
  path this session reports — but the tool hands the full payload to the host.)
- Smallest fix: `[...new Set(ids)].slice(0, N)` in `retrieve` (N ≈ 8–12) and stop appending in
  `renderRetrieve` once the joined text passes a byte budget, appending a "... truncated" line; also
  cap the `unknown` echo.

### 2. HIGH — a rejected `buildIndex()` promise is cached forever; one transient read error kills all three tools
`lib/guidance.js:176` (`indexPromise ??= buildIndex()`). `index.js:224-225` claims the opposite:
"a failed warm-up is retried by the first tool call" — it is not, and `void guidance.ready().catch(() => {})`
hides the failure at startup.

Repro: `node audit/repro/bugs/03-sticky-index-rejection.mjs`
- Expect: once the data is readable again, the next tool call rebuilds the index.
- Actual: calls 1–3 and `list()` all reject with the first `ENOENT` after `guides.json` is restored;
  the error is remembered for the lifetime of the instance. Same for malformed JSON, a missing
  per-guide `.md`, a null catalog entry, or a missing `category` — every one of those makes
  `buildIndex()` reject and poisons `search`/`list`/`retrieve` simultaneously.
- Impact: a partial install, an AV/OneDrive lock, or a corrupted catalog silently disables the whole
  plugin for the session; the model sees a raw `ENOENT` and never recovers, and the startup path
  reports success because the warm-up rejection is swallowed.
- Smallest fix:
  ```js
  function index() {
    if (indexPromise === undefined) {
      indexPromise = buildIndex().catch((error) => { indexPromise = undefined; throw error })
    }
    return indexPromise
  }
  ```
  (plus, ideally, skip an unreadable entry instead of failing the entire catalog in `readEntry`).

### 3. MEDIUM — `web_guidance_list` with `category: ""` reports an empty catalog
`index.js:160-167`. `guidance.list({category: args?.category})` is awaited **before** the
`category === ''` check at line 161, so the empty string is applied as a real filter (0 docs) and
then the counts branch sums an empty array.

Repro: `node audit/repro/bugs/01-list-empty-category.mjs`
- Expect: `""` behaves like an omitted category → `{total: 193, categories: [17 rows]}`.
- Actual: `{total: 0, categories: []}`, rendered as
  `0 guides in the Modern Web Guidance catalog:` with no category list. `"   "` is likewise treated
  as a literal category name (`{category: "   ", guides: []}`).
- Impact: the tool's own description promises "193 curated guides"; a model that fills the optional
  field with `""` is told the corpus is empty and abandons the canonical search path — exactly the
  failure mode the tool exists to prevent.
- Smallest fix: normalize before the call —
  ```js
  const raw = typeof args?.category === 'string' ? args.category.trim() : args?.category
  const category = raw === '' ? undefined : raw
  const all = await guidance.list({ category })
  if (category === undefined) { /* counts branch */ }
  ```

### 4. MEDIUM — category matching is exact and unnormalized; a near-miss silently returns nothing
`lib/guidance.js:283-285` (`list`) and `:270` (`search`) compare with `===` against the lowercase
catalog value. No trim, no case folding, no "did you mean".

Repro: `node audit/repro/bugs/05-category-not-normalized.mjs`
- Expect: `"CSS"`, `" css"`, `"css "` behave like `"css"`, or are rejected with the valid list.
- Actual: `css` → 8 search hits / 18 list rows; `"CSS"`, `"Css"`, `" css"`, `"css "`, and
  `"ui-behavior"` (singular) → 0/0, with no diagnostic; the renderer prints
  `0 guide(s) in category "CSS":` as if the category were legitimately empty.
- Impact: the model concludes a real category is empty and stops searching; the typo is invisible.
- Smallest fix: `const category = typeof options.category === 'string' ? options.category.trim().toLowerCase() : options.category`
  in both `list` and `search`, applied consistently with defect 3.

### 5. LOW (data-gated) — catalog entry values are interpolated into a path: `../../..` escapes `dataDir`
`lib/guidance.js:125-126` — `join('guides', entry.category, `${entry.id}.md`)` with no validation,
then `readFile(join(dataDir, relative))`.

Repro: `node audit/repro/bugs/04-entry-path-escape.mjs`
- Expect: an id/category containing `..`, `/`, `\` or `:` is rejected as unknown; the read stays
  inside `dataDir`.
- Actual: an entry `{id: '../../../outside-the-data-dir', category: 'css'}` makes `retrieve` return
  the contents of a file **outside** `dataDir` (`"# OUTSIDE\n\nsecret marker 42\n"`) as guide
  markdown. Absolute Windows paths work the same way.
- Impact: gated on a corrupted/tampered bundled `guides.json` (the model cannot write it), so not
  remotely triggerable today — but it turns any catalog-integrity accident into an arbitrary-file
  read whose bytes are handed to the model. Defense in depth, and the same missing validation is
  what makes defect 2's "one bad entry kills the index" so easy to hit.
- Smallest fix: in `readEntry`, reject when `/[\\/:]/.test(id)` or the id/category starts with `.`,
  and assert the resolved absolute path is inside `dataDir` before reading.

### 6. LOW — `limit` contract is inconsistent and unenforceable by the host
`lib/guidance.js:230`: `Math.min(Math.max(Number(options.limit) || 8, 1), 25)`; schema at
`index.js:102` is `{type:'number'}` with no `minimum`/`maximum`, while the description says "1-25".

Repro: `node audit/repro/bugs/06-limit-values.mjs`
- Expect: documented 1–25, `0`/`-1` rejected or clamped to 1 and never to a *larger* value.
- Actual: `limit: 0` → **8** (the `||` treats 0 as absent, so asking for fewer returns more),
  `-1` → 1, `2.7` → 2 (slice truncation), `'5'` → 5, `Infinity` → 25, `NaN`/`null` → 8.
- Impact: low — the cap holds at 25, but "0 means 8" is surprising and the schema gives the host no
  way to reject nonsense before the call.
- Smallest fix: `const n = Number(options.limit); const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 25) : 8`
  and add `minimum: 1, maximum: 25` to the schema.

### 7. LOW — no upper bound on query length; per-query CPU grows with distinct terms
`lib/guidance.js:181-191` (`expand` walks every vocabulary key for each term ≥5 chars) reached from
`prepare`/`search` (`:193-199`, `:228-255`).

Repro: `node audit/repro/bugs/07-query-length-unbounded.mjs`
- Expect: a query length/term-count cap.
- Actual: 110,667 bytes (~14k distinct terms) blocks the event loop for **5.8 s** (100 terms → 57 ms,
  1,000 → 534 ms); scaling is linear, so a pasted 1 MB blob costs tens of seconds inside one call.
  `100k` chars of repeated `a` or whitespace is ~0 ms, so only the distinct-term shape hurts.
- Impact: low (a model rarely sends that), but a single runaway query stalls the whole host turn.
- Smallest fix: truncate in `prepare` (`normalized = normalized.slice(0, 2000)`) and cap
  `queryTerms` to the first ~32 terms.

---

## SUSPECTED / NOT CONFIRMED (evidence collected, no reachable path)

1. **`ids` schema uses `oneOf` with no root `type`** (`index.js:128-131`). It is valid JSON Schema
   2020-12, but a host that converts tool schemas to OpenAI-strict function schemas rejects `oneOf`
   outright (strict mode allows `anyOf`). I could not verify the DSH host's converter — the checkout
   path `…/app.asar/dsh` does not exist on this machine, so this stays unproven. If in doubt, the
   branchless form `{type:['string','array'], items:{type:'string'}}` is safe everywhere.
2. **`renderRetrieve` throws on a malformed value** (`index.js:67`: `guide.content.trim()` when
   `content` is missing → `TypeError: Cannot read properties of undefined (reading 'trim')`).
   No path from `execute` produces such a guide, so this is hardening only, not a defect.
3. **Duplicate ids in `guides.json`** are not validated: `byId.set` silently last-wins (`:161`) while
   `docs` keeps both, so `list` reports 194 with 193 unique ids and there is no record of which body
   won. Bundled data has no duplicates today (193/193 unique).
4. **`apply()` twice on one ctx** registers each tool twice (mock ctx shows two registrations per
   name); whether the real host rejects duplicate names is unknown. Likewise, tool objects still
   execute after the mock disposers run — in the real host they are unregistered, so not a defect.

## Checked and clean (no finding)
- Scores never become `NaN`/`Infinity` for empty corpus, single doc or zero-weight docs; sort is
  stable for ties (V8 stable sort), so ranking order is deterministic.
- 50 parallel `search()` calls before `ready()` share one build (246 ms, all correct) — no duplicate
  index construction.
- Query abuse (`''`, whitespace, `100k` repeated chars, NUL, Cyrillic/emoji/CJK, quotes/shell/SQL
  shapes) does not throw; the tokenizer is ASCII-only, which is consistent with the English corpus.
- `retrieve` with `[]`, `''`, `','`, `null`, numbers, objects, nested arrays, traversal strings and
  NUL bytes never throws — bad values are reported as `unknown`.
- `renderSearch`/`renderList` tolerate `null`, `{}` and non-array `results`/`guides`.
- Empty `guides.json` array degrades gracefully (all three tools return empty, no throw).
