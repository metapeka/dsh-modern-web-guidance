# The legacy scanner: our rule table measured against upstream's

Written 2026-11-10, against `dsh-modern-web-guidance@0.5.0` and upstream
`modern-web-guidance@1.0.0` (skill version `2026_11_09-5bcc021b`). Nothing here is planned work;
it is the ledger that says what the fourth tool covers, what it deliberately does not, and why —
so that a later release does not have to re-litigate it, and so that "we only cover a seventh of
the catalog" is an explained number instead of a surprise.

Companion documents: [legacy-scan-feasibility.md](legacy-scan-feasibility.md) (the verdict that
produced the rule set), [legacy-scan-contract.md](legacy-scan-contract.md) (the interface).
Related: [upstream-v1.0.0-code-impact.md](upstream-v1.0.0-code-impact.md) §D-3.

## 1. What was compared, and how

Upstream ships `legacy-scan.mjs`, a 4.99 MB bundle that carries its own TypeScript compiler and
decides findings by visiting `ts.SourceFile` nodes. Its rule *table*, however, is plain data: 35
self-contained object literals with `ruleId`, `guideId`, `guideHash`, `summary`, `keepWhen[]`,
`dropWhen[]`. [legacy-scan-feasibility.md](legacy-scan-feasibility.md) §1.3 extracted all 35 with a
brace-walking, string-aware lexer (40,350 B of JSON). This note diffs that extraction against
[`lib/scan-rules.js`](../../lib/scan-rules.js) — the 30 rules we ship — by `guideId`, and then reads
each unmatched rule's `summary` and `dropWhen` to decide whether a marker scanner can honestly
reproduce it.

The comparison is on **guides**, not rule ids: upstream's ids are file paths like
`select-menu-interaction/css-select-invalid`, ours are `ls-01` … `ls-30`. Two rule tables that point
at the same guide are the same coverage for a reader who follows the finding.

## 2. The accounting

| | upstream | this plugin |
| --- | ---: | ---: |
| rule objects | **35** | **30** |
| distinct guides they point at | **33** | **30** |
| share of the 208-guide corpus | 15.9 % | 14.4 % |
| rule ids that are `<guide>/<variant>` sub-rules | 12 | 0 (flat `ls-NN`) |
| guides we cover that upstream does not | — | 4 (`css-layout`, `html`, `copy-button`, `web-components`) |
| rules with a confidence field | 0 (a rubric instead) | 30 (15 high / 13 medium / 2 low) |
| rules that read a file other than source | 1 (`package.json`) | 0 |

So: 26 of our 30 rules address a guide upstream also has a rule for, and on those guides we reach
**27 of upstream's 35 rule objects**. Eight upstream rule objects, spread over seven guides, have no
one-to-one counterpart here — that is the whole of the gap, and it is not seven-eighths of the
catalog: upstream's own engine stops at 15.9 % of the corpus because only 33 of the 208 guides
describe a pattern you can recognise at all. The other 175 guides are about *adding* a capability
(view transitions, scroll-driven animation, passkeys, WebMCP) where there is no legacy twin to flag.

## 3. The eight rules we do not reach

| upstream rule | guide | verdict |
| --- | --- | --- |
| `autofill-address-form` | `autofill-address-form` | **refused**: needs to know the field is inside an address/billing/shipping form, not a search box — upstream's own `dropWhen` lists three such cases |
| `autofill-payment-form` | `autofill-payment-form` | **refused**: needs card-vs-routing-number context, plus `type="number"` vs `cc-number` semantics |
| `autofill-sign-in-form` | `autofill-sign-in-form` | **refused**: needs to tell sign-in from sign-up from a database-connection form |
| `autofill-sign-up-form` | `autofill-sign-up-form` | **refused**: the same, on the other side of that split |
| `improve-text-layout-and-legibility/package-text-balance` | `improve-text-layout-and-legibility` | **out of model**: it reads *declared dependencies* in `package.json`, not source lines |
| `styling-web-components` (`:host-context()`) | `styling-web-components` | **not taken, and could be**: a dead-standard pseudo-class is a mechanical marker |
| `improve-text-layout-and-legibility/js-text-balance` | `improve-text-layout-and-legibility` | **half-covered**: `ls-22` matches `balanceText(` but maps to `equal-width-text-lines`, and it misses the `<Balancer>` JSX form (the pattern requires a call parenthesis) |
| `select-menu-interaction/css-select-invalid` | `select-menu-interaction` | **half-covered**: `ls-08` matches bare `:invalid` and maps to `validate-input-after-interaction`; the select-specific reading is lost and the match is noisier than upstream's |

Six of the eight have no substitute at all; two fire the right kind of marker but send the reader to a
neighbouring guide. Both halves of that sentence matter: the first is a capability limit, the second
is a precision bug we can fix without any new machinery.

## 4. Where upstream is better

| | what it buys | evidence |
| --- | --- | --- |
| **Parses instead of matching** | It can decide that a `click` listener opens a dialog, that a password input belongs to sign-in, that a `:invalid` selector targets a `<select>`. Those are exactly the rules we refuse. | feasibility §1.2, §2.1 |
| **A verify stage with rubrics** | Every rule ships `keepWhen[]`/`dropWhen[]` (65 `keepWhen` bullets across 35 rules) and the workflow runs findings through them. Our findings carry a `confidence` label and nothing else — a promise, not a check. | feasibility §1.3, §1.4 |
| **A modernize stage** | After reporting, it can rewrite the caller's code. We never write. | feasibility §1.1, §2.2 |
| **Guide-hash invalidation** | Each rule stores `guideHash` (35/35), so when Google edits the guide the rule can be marked stale. We have no such link — see §7. | feasibility §1.3 |
| **Reach** | 35 rules / 33 guides against our 30 / 30. | §2 above |
| **Distribution** | An npm CLI any agent with a shell can run; we need the DSH host. | `README.md` comparison table |

## 5. Where this plugin is better

| | what it buys | evidence |
| --- | --- | --- |
| **Zero dependencies** | ~32 kB of scanner and rule table (`lib/scan.js` 20,956 B + `lib/scan-rules.js` 11,397 B) against a 4.99 MB bundle with a bundled TypeScript compiler. `dependencies` and `devDependencies` are both empty. | `package.json` |
| **Cannot damage the tree** | Read-only by construction: explicit relative paths only, `realpath` containment against the session cwd, hard caps on paths/files/bytes/findings/skips, no `exec`, no network, no code generation. The refusal is reproduced in [audit/security.md](../../audit/security.md) §F8. | `lib/scan.js`, `audit/repro/security/scan-containment.mjs` |
| **It sits where the work happens** | One session: scan → finding with `guideId` → `web_guidance_retrieve` on that guide → implement. Upstream's CLI sits outside the agent's context. | `index.js`, `README.md` |
| **Same corpus, without the lookup assets** | The same 208 byte-identical guides, ranked by BM25 in-process (29/30 top-1 on the probe) instead of 9.16 MB of quantized word vectors and chunk embeddings. | `README.md` comparison table |
| **Honest about its own noise** | Two rules are shipped `low`, thirteen `medium`, and the four rules that would be noise are absent rather than shipped with a disclaimer. | `lib/scan-rules.js` |
| **Three languages** | Docs and panel in EN/RU/ZH; upstream is English-only. | `client.js`, `README.*.md` |

## 6. What could be closed, and what will not

Cheap, marker-shaped, no new machinery — each is a rule entry plus its planted/clean test pair:

1. `:host-context(` → `styling-web-components` (`ls-31`), confidence high: a removed CSS feature.
2. `balanceText(` / `<Balancer` split out of `ls-22` and pointed at
   `improve-text-layout-and-legibility` (`ls-32`), keeping `fitty`/`fitText` on
   `equal-width-text-lines`.
3. `select:invalid` as its own rule (`ls-33`) pointed at `select-menu-interaction`, leaving `ls-08`
   for `input:invalid`.

Not worth it: the four `autofill-*` rules. A pattern that fires on every password field in the world
and is right a fraction of the time is worse than a missing rule; that is why the tier split in the
feasibility note exists at all.

Different shape, not refused: a `package.json` rule. It would have to read a manifest the caller
names and check a declared dependency, which is a second file kind for a scanner that is
deliberately file-agnostic. Feasible, but it belongs to a manifest-checking tool.

## 7. Debts

- **No guide-hash invalidation — the real one.** Upstream ties every rule to the hash of the guide it
  points at. Ours ties a rule to a guide *id*; `test/scan-rules.test.mjs` proves the id still exists,
  but nothing proves the guide still recommends what the rule's message says. A corpus refresh can
  therefore leave a rule's `message` describing a replacement Google has since changed, and no test
  goes red. Until that is fixed, a corpus refresh must include a manual re-read of all 30 rules'
  message lines against their guides. That step belongs in the refresh checklist, not in a
  reviewer's memory.
- **Confidence is not verification.** `low` means "we know this marker is only a hint"; it does not
  mean the finding was checked. Only a verify stage (upstream's rubrics) would change that.
- **Two rules route to a neighbouring guide.** See §3; cosmetic for search, real for the reader who
  lands on `equal-width-text-lines` while looking for `text-wrap: balance`.

## 8. What this decides

- The rule table is **30 of upstream's 35**, and that is a design point, not an unfinished port.
- The gap is **six rules with no substitute and two with a wrong address** — nothing else.
- Growth beyond 30 is allowed, but it is our own work, not a port: a new rule earns its place with a
  planted case, a clean case, and a `guideId` that exists in `data/guides.json`.
- The one debt to carry into any future corpus refresh is the missing guide-hash check.

## 9. Reproduce

```bash
# our side: 30 rules, 30 distinct guides
node -e "import('./lib/scan-rules.js').then(m => console.log(m.RULES.length, new Set(m.RULES.map(r => r.guideId)).size))"

# upstream side: 35 rules, 33 distinct guides (artifact rebuilt per the feasibility note's lexer)
node -e "const r = require('./.tmp/legacy-rules.json'); console.log(r.length, new Set(r.map(x => x.guideId)).size)"

# the gap: which upstream guides our table does not address (expect 7)
node -e "const up = require('./.tmp/legacy-rules.json'); import('./lib/scan-rules.js').then(m => { const ours = new Set(m.RULES.map(r => r.guideId)); const gap = [...new Set(up.map(r => r.guideId))].filter(g => !ours.has(g)); console.log(gap.length, gap.join(' ')); })"
```

The extracted artifact is temp-only and git-ignored by design — rebuild it with the feasibility
note's lexer rather than trusting a committed JSON of someone else's rules.
