# `legacy-scan` feasibility — can we ship a 4th tool without a TypeScript compiler?

Task: `task-13` (research for 0.5.0) · Author: `upstream-diff` · Date: 2026-11-10
Repo under analysis: `E:\0ai\dsh_mod_1\dsh-modern-web-guidance`
Artifact dissected: `.tmp/upstream-diff/pkg100/package/skills/modern-web-guidance/legacy-scan.mjs`
(4,992,779 B = 4.76 MiB, 575 lines, minified ES module)
Corpus reference: `data/guides.json` (208 guides, 17 categories, snapshot `2026_11_09-5bcc021b`)

**Verdict: GO, with a reduced rule set — 20–30 regex rules, ~13.5 % guide coverage, explicit-paths-only,
report-only.** Upstream's *rule table and its rubrics* are extractable data; upstream's *detectors* are not — they are
hand-written functions over a bundled TypeScript compiler. A re-implementation is feasible as a **marker scanner**,
not as an AST analyzer, and it must not advertise upstream parity.

| question | answer |
| --- | --- |
| Are rules extractable as data? | **Yes for the rule table** — 35 rules, 33 guide ids, verifier rubrics, marker vocabulary (`.tmp/legacy-rules.json`, 40,350 B). |
| Is the detection logic extractable? | **No.** Logic is code (`matcher` functions) executing against `ts.SourceFile`; 5 rules go through an AST factory, the other 30 are bespoke visitors. Re-using it means shipping ~5 MB + the TS compiler. |
| Does a dependency-free regex scanner work? | **Yes, for 20 of 35 rules** (19 guides, 9.1 %). Adding 10 crafted rules reaches 30 rules / 28 guides (13.5 %). |
| Does it need an AST? | Only for the 13 "context" rules (form semantics, dialog click-flow, IME handling). Those are the ones we drop. |
| Effort | (a) data + regex, zero deps: **~1.5–2 days** (≈700–900 LOC delta across code/tests/docs). (b) AST: **no-go** (a vendored TS compiler, +5 MB, breaks the zero-dependency contract). |

---

## 1. What is inside `legacy-scan.mjs` — facts

### 1.1 It bundles the TypeScript compiler

Probes over the raw bundle text (count of literal occurrences, first offset):

| probe | count | first offset |
| --- | ---: | ---: |
| `SyntaxKind` | 1 684 | 4 989 |
| `isPropertyAccessExpression` | 66 | 50 163 |
| `isCallExpression` | 42 | 37 702 |
| `forEachChild` | 41 | 17 701 |
| `createProgram` | 19 | 13 014 |
| `ScriptTarget` | 20 | 4 549 |
| `ts.version` | 4 | 1 186 639 |
| `node_modules/typescript` | 1 | 3 659 677 |

The `node_modules/typescript` hit is the compiler's own self-reference inside the vendored snapshot:

```js
var Pit="/node_modules/typescript/lib";function TPe(o){if(o.libFolderPath!=null){ …
```

That single embed accounts for the overwhelming majority of the 4.99 MB: the *rules* are ~40 KB of text (see §1.3),
the rest is compiler + scanner plumbing. This is why upstream's npm download is 8.8 MB after the search engine moved
off TensorFlow.js — the TS compiler is the remaining heavy payload.

### 1.2 The rule engine is `ts.SourceFile` visiting (the AST factory)

Five rules are built by one factory (`fk`, at offset 4 254 974). Its body, verbatim, is the whole architecture:

```js
function fk(o){return{kind:"js",fastTokens:o.fastTokens??[],matchFile(r,a){
  if(o.shouldSkipFile?.(r,a))return[];
  let f=[],_=o.dedupeLines?new Set:null,
      y=o.matchCall?r.getDescendantsOfKind(FC.SyntaxKind.CallExpression):[],
      C=o.matchNew?r.getDescendantsOfKind(FC.SyntaxKind.NewExpression):[],
      …
  for(let B of P){ … if(_?.has(U)||o.featureGuardTokens&&W0(B,o.featureGuardTokens)||o.isGuarded?.(B,r,a))continue;
    let Y=FC.Node.isCallExpression(B)?o.matchCall?.(B,r,a):o.matchNew?.(B,r,a);
    Y&&(_?.add(U),f.push({line:U,message:Y}))}return f}}}
```

`r` is a `ts.SourceFile`, `r.getDescendantsOfKind(SyntaxKind.CallExpression)` is the TypeScript API, `W0(...)` is a
guard-token check on a node. The other 28 resolved rules ship bespoke `matcher` functions that receive the same
`(file, text)` pair and call helpers such as `Ei(node)`, `Xi.Node.isPropertyAccessExpression`, `dq(y.getRight())`,
`forEachChild` — i.e. they *also* walk the AST. Two rule ids stayed unresolved by static name matching (`improve-text-layout-and-legibility/package-text-balance`, `scroll-entry-exit-effects/package-scroll-reveal`) because their
matcher identifiers are minified locals reused elsewhere; their sibling variants (`…/js-text-balance`, `…/js-scroll-reveal`)
are AST rules, so there is no reason to believe these two are text-only.

**Consequence: the detection semantics are not data.** Extracting them means either (a) shipping the bundle + compiler,
or (b) re-deriving each rule by reading minified JS and re-writing it — which is exactly "re-implement", not "reuse".

### 1.3 But the rule *table* is plain data and extracts cleanly

Each rule is a self-contained object literal. The scanner I wrote walks balanced braces with a JS-string-aware lexer and
pulls them out. All **35** rule objects share one schema:

| field | present in | content |
| --- | ---: | --- |
| `id` | 35/35 | rule id; 12 of them are `<guideId>/<variant>` (e.g. `slider/js-slider`, `sanitize-untrusted-html/js-dompurify-innerhtml`) |
| `guideId` | 35/35 | guide the finding maps to — **33 unique guides** |
| `guideHash` | 35/35 | content hash of that guide (6 inline hex literals, 29 shared vars) — upstream invalidates a rule when its guide changes |
| `summary` | 35/35 | one-sentence human description of the legacy pattern |
| `matcher` | 35/35 | reference to a detector **function** |
| `verifierRubric.keepWhen[]` | 35/35 | when the finding is a true positive (65 bullets total, 1–3 per rule) |
| `verifierRubric.dropWhen[]` | 35/35 | explicit false-positive cases (2–4 bullets each) |

Example (unescaped from the bundle):

```js
{id:"autofill-address-form", guideId:"autofill-address-form", guideHash:dWt,
 summary:"Postal address form fields (<input> or <textarea>) inside a <form> should specify standard autocomplete attributes (e.g. street-address, postal-code).",
 matcher:xWt,
 verifierRubric:{
   keepWhen:["The input or textarea is part of an address, billing, checkout, or shipping form collecting postal street address or postal code data.",
             "The field lacks a standard autocomplete attribute or specifies autocomplete=\"off\", …"],
   dropWhen:["The input is a search box, filter query, or location search autocomplete input (type=\"search\" or search field).",
             "The input is disabled, readonly, hidden, or part of a non-form test fixture or XML data schema.",
             "The component receives its autocomplete attribute dynamically via props, context, or JSX spread."]}}
```

A second data layer sits in the factory arguments: **`fastTokens` pre-filters exist for 31 of 35 rules** (2 declare an empty list, 2 matchers stayed unresolved) — short strings
the scanner greps for before parsing. That is upstream's own marker vocabulary, and it is directly reusable by us:

| rule | `fastTokens` |
| --- | --- |
| `customize-scrollbar-color-and-thickness` | `-webkit-scrollbar` |
| `deliver-optimized-decorative-images` | `-webkit-image-set` |
| `soft-edge-content-fade` | `-webkit-mask-image`, `-webkit-mask` |
| `dark-mode` | `prefers-color-scheme` |
| `select-menu-interaction/css-select-invalid` | `:invalid` |
| `validate-input-after-interaction` | `:invalid` |
| `animate-to-intrinsic-sizes` | `max-height` |
| `custom-text-decorations` | `border-bottom` |
| `icons` | `hue-rotate`, `sepia` |
| `dynamic-sibling-animations` | `:nth-child(1)`, `:nth-child(2)`, `:nth-of-type(1)`, `:nth-of-type(2)` |
| `child-state-based-styling/js-parent-class` | `classList`, `addClass`, `removeClass`, `toggleClass` |
| `slider/js-slider` | `noUiSlider`, `nouislider` |
| `interest-triggered-tooltips/js-tooltip` | `tippy` |
| `scroll-entry-exit-effects/*` | `AOS.init`, `ScrollReveal`, `new WOW` |
| `equal-width-text-lines/js-fittext` | `fitty`, `fitText`, `fittext` |
| `improve-text-layout-and-legibility/*` | `balanceText`, `Balancer` |
| `sanitize-untrusted-html/js-dompurify-innerhtml` | `DOMPurify`, `sanitize`, `sanitizeHtml`, `xss`, `insane` |
| `format-human-readable-durations/js-duration-formatter` | `humanizeDuration`, `prettyMs`, `moment.duration`, `dayjs.duration`, `.humanize(`, `formatDuration`, … |
| `scrollspy` | `data-spy`, `data-bs-spy`, `data-scrollspy`, `scrollspy`, `data-target` |
| `secure-external-subresources` | `https://cdnjs.cloudflare.com/`, `https://cdn.jsdelivr.net/`, `https://unpkg.com/` |
| `flicker-free-client-side-ab-testing` | `async-hide`, `ab-loading` |
| `checkbox` | `checkbox`, `Checkbox`, `custom-control-input`, `custom-checkbox`, `:checked` |
| `autofill-payment-form` | `card`, `cvv`, `cvc`, `csc`, `exp`, `credit`, `cc-` |
| `autofill-sign-in-form` / `sign-up-form` | `password` |
| `ime-safe-enter-submit` | `keydown`, `onkeydown`, `onKeyDown` |
| `form-fields-automatically-fit-contents` | `autosize`, `scrollHeight`, `scrollWidth` |

Extracted artifact: **`.tmp/legacy-rules.json`, 40,350 B** — 0.8 % of the bundle, 35 rules, all summaries, all
`keepWhen`/`dropWhen`, all `guideId`s. (Also `.tmp/legacy-rules-engines.json` with the engine kind per rule.)

### 1.4 Coverage of the extracted rules

| metric | value |
| --- | ---: |
| rules | 35 |
| unique guides referenced | **33** |
| share of the 208-guide corpus | **15.9 %** |
| rule ids that are `<guide>/<variant>` sub-rules | 12 |
| guide ids that do **not** exist in the v1.0.0 corpus | 0 (all 33 resolve) |

Upstream's release notes say the scanner covers "roughly 20 % of guides"; measured 15.9 %. Close enough to treat their
number as approximate — and it confirms that even with a full AST the tool is a *hint generator for a seventh of the
catalog*, not a verdict engine.

---

## 2. Regex alternative without an engine

### 2.1 Rule-by-rule feasibility

I classified all 35 rules by whether a text/regex implementation can reproduce the finding without semantic context:

| tier | meaning | rules | guides | % of corpus |
| --- | --- | ---: | ---: | ---: |
| **A** | mechanical legacy marker; a regex hit *is* the finding (deprecated prefix, removed API, bundled library name, legacy CSS selector) | 20 | 19 | **9.1 %** |
| **B** | needs DOM/form/component context to decide (`<dialog>` vs any click listener, address form vs search box, IME handling, prop-driven state) — regex gives a weak hint, `dropWhen` would dominate | 13 | 13 | 6.2 % |
| unresolved engine | same class as B in practice | 2 | 2 | 1.0 % |
| **all** | upstream parity ceiling | 35 | 33 | 15.9 % |

Tier A rules are exactly the ones whose `dropWhen` lists are short: `-webkit-scrollbar`, `-webkit-image-set`,
`-webkit-mask-image`, `-webkit-text-emphasis`, `:invalid` selector, `prefers-color-scheme`-driven manual theming,
`:nth-child(1/2)` sibling arithmetic, `hue-rotate/sepia` icon recolouring, `max-height` transition,
`classList` on `parent()`, plus the library-name family (`noUiSlider`, `tippy`, `fitty/fitText/balanceText`,
`AOS/ScrollReveal/WOW`, `DOMPurify`, `humanizeDuration/prettyMs`, `data-bs-spy`, `async-hide`, CDN hosts).

### 2.2 Proposed rule set: 30 regex rules

Same table used to compute coverage; `guideId` is upstream's own mapping, so findings land on real guides.

| # | rule id | regex (JS) | guide |
| ---: | --- | --- | --- |
| 1 | `document-write` | `\bdocument\.write(ln)?\s*\(` | `html` (overview guide) |
| 2 | `exec-command` | `\bdocument\.execCommand\s*\(` | `html` (overview guide) |
| 3 | `webkit-scrollbar` | `-webkit-scrollbar` | `customize-scrollbar-color-and-thickness` |
| 4 | `webkit-image-set` | `-webkit-image-set` | `deliver-optimized-decorative-images` |
| 5 | `webkit-mask` | `-webkit-mask(-image)?\s*:` | `soft-edge-content-fade` |
| 6 | `webkit-prefixed-props` | `-(?:webkit\|moz)-(?:box\|transform\|transition\|flex\|border-radius\|appearance)\b` | `css` (overview guide) |
| 7 | `css-invalid-pseudo` | `(?<![\w:-]):invalid\b(?![-\w])` | `select-menu-interaction` |
| 8 | `css-prefers-color-scheme` | `prefers-color-scheme` | `dark-mode` |
| 9 | `css-maxheight-transition` | `transition[^;{}]*\bmax-height\b` | `animate-to-intrinsic-sizes` |
| 10 | `css-text-decoration-prefix` | `-webkit-text-(?:decoration\|emphasis)` | `custom-text-decorations` |
| 11 | `css-nth-child-arithmetic` | `:nth-(?:child\|of-type)\(\s*[0-9]+\s*\)` | `dynamic-sibling-animations` |
| 12 | `css-hue-rotate-icons` | `filter\s*:\s*[^;{}]*hue-rotate` | `icons` |
| 13 | `jquery-dom` | `\$\s*\(\s*['\"`]` | *(no guide — finding only)* |
| 14 | `jquery-parent-class` | `(?:parent\(\)\|parents\(\))\.(?:add\|remove\|toggle)Class` | `child-state-based-styling` |
| 15 | `dompurify` | `\bDOMPurify\.(?:sanitize\|setConfig)` | `sanitize-untrusted-html` |
| 16 | `innerhtml-assign` | `\.innerHTML\s*=\s*[^'\"]` | `sanitize-untrusted-html` |
| 17 | `duration-humanizer` | `\b(?:humanizeDuration\|prettyMs\|duration\()` | `calculate-event-differentials` |
| 18 | `moment-js` | `\bmoment\s*\(\|\bdayjs\s*\(` | *(no guide — finding only)* |
| 19 | `nouislider` | `\bnoUiSlider\b` | `slider` |
| 20 | `tippy` | `\btippy(?:\.js)?\b\|\bnew\s+Popper\b` | `interest-triggered-tooltips` |
| 21 | `aos-scrollreveal` | `\bAOS\.init\b\|\bScrollReveal\b\|\bnew\s+WOW\b` | `scroll-entry-exit-effects` |
| 22 | `fitty-balancer` | `\b(?:fitty\|fitText\|balanceText\|Balancer)\b` | `equal-width-text-lines` |
| 23 | `scrollspy-attrs` | `\b(?:data-bs-spy\|data-spy\|data-scrollspy)\b` | `scrollspy` |
| 24 | `async-hide` | `async-hide\|ab-loading` | `flicker-free-client-side-ab-testing` |
| 25 | `cdn-hosted-lib` | `https?://(?:cdnjs\.cloudflare\|cdn\.jsdelivr\|unpkg)\.com/` | `secure-external-subresources` |
| 26 | `progressbar-role` | `role=[\"']progressbar[\"']` | `progress` |
| 27 | `modal-click-listener` | `addEventListener\(\s*['\"`]click['\"`]` | `dialog` *(low confidence)* |
| 28 | `ime-keydown-enter` | `onKeyDown\|addEventListener\(\s*['\"`]keydown['\"`]` | `ime-safe-enter-submit` *(low confidence)* |
| 29 | `form-autosize-scroll` | `scrollHeight` | `form-fields-automatically-fit-contents` *(low confidence)* |
| 30 | `autofill-address` | `\b(?:autocomplete=[\"']?(?:street-address\|postal-code))` | `autofill-address-form` |

Coverage arithmetic: 26 of the 30 map to a guide id (2 are finding-only, 2 target overview guides); union with the Tier-A set = **28 guides = 13.5 % of 208**.
Rules 27–29 are kept but flagged `confidence: "low"` — they are the tier-B leftovers whose regex hit is a hint, not a
finding; shipping them without a confidence field would be dishonest.

Mechanism smoke test (synthetic HTML/CSS/JS fixture containing exactly these legacy patterns): **15 of 30 rules fired**
— all 15 Tier-A markers present in the fixture, zero false positives on the modern snippets included
(`scrollbar-width`, `:user-invalid`, `calc-size()`, `moveBefore()`, `popover`). The 15 non-firing rules were simply
absent from the fixture (CDN hosts, `role=progressbar`, `nth-child`, autofill attributes, …), which is the expected
behaviour and confirms the rules are marker-driven, not file-driven.

### 2.3 Why not mine rules from our own corpus instead

I tried: regexing the 208 guides for “instead of `X`”, “deprecated `X`”, “legacy” … yields only 34 candidate markers
across 35 guides (16.8 %), and most are prose artifacts (`Date`, `importance`, `true`, `document`) rather than
scannable legacy APIs. **The corpus is not a rule source.** Upstream's `fastTokens` + `summary` + `dropWhen` are the
only high-quality source, and they are extractable — which is precisely why the reduced scanner is worth building at
all.

---

## 3. Tool API and safety model

### 3.1 Proposed tool (5 lines)

```
web_guidance_legacy_scan({
  paths: ["src/", "app/layout.tsx"],      // explicit, cwd-relative; no globs, no absolute paths
  rules?: ["document-write", "webkit-scrollbar"],  // default: all enabled
  format?: "summary" | "json",            // default "summary"
})
→ { scanned: { files, bytes, skipped: [{ path, reason }] },
    findings: [{ path, line, column, rule, guideId, snippet, confidence }],
    guides:  [{ id, title, findings: n }] }   // ready for web_guidance_retrieve
```

Deliberately: **no content input** (we scan files, not pasted text — keeps one code path), **no glob expansion by the
agent** (we expand internally with an allowlist), **no fix mode** (report-only; the agent retrieves the guide and edits),
and findings are keyed to guide ids so the existing `web_guidance_retrieve` closes the loop.

### 3.2 Limits (hard-coded, not configurable upward)

| limit | value | why |
| --- | --- | --- |
| files per call | 200 | bounds response size and wall time |
| bytes per file | 512 KB | larger web sources are bundles, not hand-written code |
| total bytes per call | 8 MB | fits a 5 s budget on ordinary hardware |
| per-file extension allowlist | `.html .htm .css .js .jsx .mjs .cjs .ts .tsx .vue .svelte .astro` | keeps us in "web source" territory |
| skipped directories | `node_modules .git dist build out .next .nuxt coverage vendor` | noise + time |
| max findings returned | 200 (then `truncated: true` + counts per rule) | bounded context |
| snippet length | 160 chars, single line, HTML/JS escaped | no secret spillage, no injection |
| regex safety | no nested quantifiers, per-rule `lastIndex` reset, per-line matching | ReDoS is not reachable; every pattern is linear over one line |

### 3.3 What changes in the security model (this is the part that must be documented)

Today's invariant, stated in README and proven by the audit: *the plugin reads only its own `data/`; it never touches
user files, never writes, never makes a network call* (`README.md:163–175`, `audit/security.md`). A scanner breaks the
first clause by design. The new invariant must be stated just as crisply:

> **The scanner reads, never writes.** It opens only paths the agent names, only inside the session working directory,
> only allowlisted text extensions, only up to fixed byte/time caps. It returns short redacted snippets — never whole
> files — and it never executes, patches, uploads or shells out.

| threat | mitigation | test to add |
| --- | --- | --- |
| path traversal (`../../etc/passwd`) | reject absolute paths and any resolved path outside `realpath(cwd)`; compare with `path.relative` and reject `..` prefixes | `scan-refuse-outside-cwd` |
| symlink escape | resolve with `fs.realpath` *before* the containment check; skip escaping links in `skipped[]` | `scan-refuse-symlink-escape` |
| secret exfiltration | extension allowlist denies `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc` by construction; snippets capped at 160 chars; no whole-file echo; no file contents in logs | `scan-no-secret-extensions` |
| binary / huge files | NUL byte in first 8 KB → skip as `binary`; size cap → skip as `too-large` | `scan-skip-binary` |
| prompt injection inside scanned code | findings carry escaped single-line snippets only; the tool result is labelled data (same guardrail as guide text) | `scan-snippet-escaped` |
| unbounded traversal | explicit paths only, no `**`; directory walks bounded by file cap with `truncated` marker | `scan-file-cap` |
| ReDoS | fixed rule table, no user-supplied regex, per-line linear patterns | `scan-rules-fixed` |
| TOCTOU / mid-scan edits | each file read once, no second pass, no cache across calls | n/a (single read) |

Documentation deltas: a **“What the scanner may read”** subsection in README (next to the existing injection-safety
section), the invariant paragraph above, and one line in `AGENTS.md` under “Client half”/contract so future
contributors do not widen the reads casually. `audit/security.md` gains a section; `audit/repro/security/probes.mjs`
gains the traversal/symlink/enumeration probes.

### 3.4 Response shape rationale

`findings` answer “where is the legacy pattern”, `guides` answers “what do I read next” — the agent should do
`legacy_scan → retrieve(guides) → edit`, mirroring upstream's scan/verify/report/modernize flow but **without** the
verify step's LLM rubric pass (we drop `keepWhen`/`dropWhen` from the tool output and keep `confidence`, because a
regex cannot honestly adjudicate a rubric; the agent reads the guide instead).

---

## 4. What changes in the rest of the product

| area | file / line | change |
| --- | --- | --- |
| tool registration | `index.js` (~125–200), module docstring `index.js:4` | register 4th tool; “three offline tools” → “four” |
| counters map | `index.js:255–259` (`['web_guidance_search','search'] …`) | add `['web_guidance_legacy_scan','scan']` |
| telemetry | `lib/telemetry.js:2` (“three tools”), `:32–34` name→short map, `:37` `OUTCOMES`, `:167–188` classification | new outcome vocabulary: `findings`, `clean` (scan ran, nothing found), `error`; keep `hit/miss/unknown-id/list` untouched |
| `/guidance-stats` report | `lib/report.js` (per-tool rows, dead-guide section) | a scan row + “guides surfaced by scan but never retrieved” — reuses `retrieved[]` bookkeeping |
| panel | `client.js` (labels `:65`, `:105`; stats table) | one label pair per locale; panel already renders tool rows from payload |
| README ×3 | `README.md:13` (“3 tools”), `:46–48` tool table, `:82` “three ways”, `:181`, `:216` (“same three tools stay exactly three”) | 4 tools, new row, new numbered workflow, revised sentence at `:216` |
| glossary | `GLOSSARY.md` (call / outcome / dead guide vocabulary) | add *finding*, *confidence*, *scan target* |
| marketplace/publishing | `market/awesome-dsh-plugin.yml:10`, `PUBLISHING.md` (tool counts, test counts) | “three tools” → four |
| tests | `test/guidance.test.mjs`, `test/hardening.test.mjs` (193/208 counts), `test/plugin.test.mjs:80`, `test/report.test.mjs`, `test/stats.test.mjs` | 4th-tool registration test, refusals (§3.3), stats classification, report row; new `test/scan.test.mjs` |
| audit | `audit/security.md`, `audit/repro/security/probes.mjs`, `audit/corpus.md` (claims table) | new read-surface section + probes |
| version | `package.json` | 0.4.0 → **0.5.0** (new capability, no breaking change) |

Note on `/guidance-stats`: the counters currently assume “only `retrieve` marks a guide as used”
(`lib/telemetry.js:280–283`). A scan should **not** count as retrieval — it surfaces guides, and the honest metric is
“surfaced-by-scan vs later-retrieved”, which is exactly what the panel already has columns for.

---

## 5. Effort estimate

### (a) Data + regex, zero dependencies — recommended

| work item | size |
| --- | --- |
| `lib/scan.js` — path validation (realpath containment), enumeration with allowlist/skip/caps, binary+size guards, rule engine, snippet redaction, finding aggregation | ~220–260 LOC |
| `lib/scan-rules.js` (or JSON) — 30 rules `{id, regex, guideId, confidence, message}` | ~120 lines |
| tool registration + input validation in `index.js` | ~60 LOC |
| telemetry/report/panel classification | ~60 LOC |
| tests: `test/scan.test.mjs` (15 cases incl. all refusals) + adjustments in 5 existing test files | ~200 LOC |
| docs: README ×3 sections, AGENTS.md line, GLOSSARY, PUBLISHING, audit section | ~1 page each |
| **total** | **~700–900 LOC delta, ~1.5–2 focused days** |

Risk is concentrated in the *security surface*, not the rules: path containment + skip accounting is where review time
goes. Rules are mechanical and individually reviewable.

### (b) AST with dependencies — no-go

Would require vendoring TypeScript (`node_modules/typescript/lib` ≈ 4.5–5 MB) or adding a dependency, which breaks
three standing commitments at once: zero dependencies (`README`, audit), package size (our payload is ~2.0 MB; +5 MB
is a 3.5× blow-up), and “no network/no code execution in the scan path” (a compiler plus its module resolution is a
much larger attack surface than 30 regexes). It would buy Tier-B correctness (13 rules, +6.2 % coverage) at a cost
that is not defensible for a plugin whose core value is an offline corpus.

### (c) The middle path we should actually ship

Ship **(a) with an honest label**: `legacy_scan` is a *marker scanner for ~14 % of the catalog* that points at the
guide to read. Do not print “modernization complete”; print “N markers found in M files; read these guides”.
Upstream itself only claims ~20 %, and its findings need a verifier rubric pass to be actionable — we replace that
pass with “retrieve the guide and decide”.

---

## 6. Verdict

**GO — reduced set.** Rules are extractable data (35 rules / 33 guide ids / rubrics / marker vocabulary, 40 KB), but
their detectors are TypeScript-AST code inside a 4.99 MB bundle and cannot be reused. A zero-dependency regex scanner
with 30 rules covers 28 guides (13.5 %), fits in ~700–900 LOC, keeps the plugin's dependency story intact, and needs
the documented read-surface change in §3.3 to stay honest about what the plugin may touch.

Kill criteria (if any of these becomes true, stop and reconsider): product insists on AST-grade precision; product
wants the full 15.9 % with verifier rubrics rendered by the tool; or review of §3.3 concludes that any read of user
files is unacceptable for this plugin — in which case the tool must be dropped, because a scanner without file reads
has nothing to scan.

---

## 7. Artifacts (temp only, git-ignored)

| path | content |
| --- | --- |
| `.tmp/legacy-rules.json` | 35 extracted rules: `ruleId, guideId, guideHash, summary, keepWhen[], dropWhen[]` (40,350 B; 65 `keepWhen` + 118 `dropWhen` bullets) |
| `.tmp/legacy-rules-classified.json` | rules + `kind`, `usesAST`, `usesRegex`, `fastTokens`, `defBytes` |
| `.tmp/legacy-rules-engines.json` | rules + resolved engine kind (`fk-js` / `css` / `dom` / `unresolved`) and `fastTokens` |
| `.tmp/legacy-probe.py`, `.tmp/extract-rules*.py`, `.tmp/forensics.py`, `.tmp/factory.py`, `.tmp/classify.py`, `.tmp/engines.py` | extraction/forensics scripts |
| `.tmp/coverage.py` | tier classification, proposed-rule coverage arithmetic, fixture smoke test |

Every number in this note is reproducible from those scripts against
`.tmp/upstream-diff/pkg100/package/skills/modern-web-guidance/legacy-scan.mjs`.
