# The legacy scanner: our rule table measured against upstream's

Written 2026-11-10, against `dsh-modern-web-guidance@0.6.0` and upstream
`modern-web-guidance@1.0.0` (skill version `2026_11_09-5bcc021b`). Nothing here is planned work;
it is the ledger that says what the fourth tool covers, what it deliberately does not, and why —
so that a later release does not have to re-litigate it, and so that "we only cover a sixth of
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
[`lib/scan-rules.js`](../../lib/scan-rules.js) — the 33 rules we ship — by `guideId`, and then reads
each unmatched rule's `summary` and `dropWhen` to decide whether a marker scanner can honestly
reproduce it.

The comparison is on **guides**, not rule ids: upstream's ids are file paths like
`select-menu-interaction/css-select-invalid`, ours are `ls-01` … `ls-33`. Two rule tables that point
at the same guide are the same coverage for a reader who follows the finding.

## 2. The accounting

| | upstream | this plugin |
| --- | ---: | ---: |
| rule objects | **35** | **33** |
| distinct guides they point at | **33** | **33** |
| share of the 208-guide corpus | 15.9 % | 15.9 % |
| rule ids that are `<guide>/<variant>` sub-rules | 12 | 0 (flat `ls-NN`) |
| guides we cover that upstream does not | — | 4 (`css-layout`, `html`, `copy-button`, `web-components`) |
| rules with a confidence field | 0 (a rubric instead) | 33 (18 high / 13 medium / 2 low) |
| rules that read a file other than source | 1 (`package.json`) | 0 |

So: 29 of our 33 rules address a guide upstream also has a rule for, and the other four
(`css-layout`, `html`, `copy-button`, `web-components`) are ours alone. On the shared guides we reach
**30 of upstream's 35 rule objects**; five remain — the four `autofill-*` rules and
`improve-text-layout-and-legibility/package-text-balance`. The count is by *rule*, not by guide: treat
a shared guide as covering every upstream rule on it and it would read 31, because
`package-text-balance` sits on a guide we do cover through `ls-32` without having a rule that does its
job.

That gap is the whole of the difference, and it is not seven-eighths of the catalog: both sides stop
at 15.9 % of the corpus because only 33 of the 208 guides describe a pattern you can recognise at all.
The other 175 guides are about *adding* a capability (view transitions, scroll-driven animation,
passkeys, WebMCP) where there is no legacy twin to flag.

## 3. The five rules we do not reach

| upstream rule | guide | verdict |
| --- | --- | --- |
| `autofill-address-form` | `autofill-address-form` | **refused**: needs to know the field is inside an address/billing/shipping form, not a search box — upstream's own `dropWhen` lists three such cases |
| `autofill-payment-form` | `autofill-payment-form` | **refused**: needs card-vs-routing-number context, plus `type="number"` vs `cc-number` semantics |
| `autofill-sign-in-form` | `autofill-sign-in-form` | **refused**: needs to tell sign-in from sign-up from a database-connection form |
| `autofill-sign-up-form` | `autofill-sign-up-form` | **refused**: the same, on the other side of that split |
| `improve-text-layout-and-legibility/package-text-balance` | `improve-text-layout-and-legibility` | **out of model**: it reads *declared dependencies* in `package.json`, not source lines |

Three of the original eight gap rows are closed in 0.6.0, and the history stays here so nobody reopens
them: `styling-web-components` (`:host-context()`, now `ls-31`, high confidence),
`improve-text-layout-and-legibility/js-text-balance` (now `ls-32`, which also catches the `<Balancer>`
JSX form; `ls-22` keeps `fitty`/`fitText` for sizing), and
`select-menu-interaction/css-select-invalid` (now `ls-33`, leaving `ls-08` for `input:invalid` and
`textarea:invalid`). All three are mechanical markers — no DOM context needed — which is why they
were the ones that could be closed without a parser.

The remaining five split cleanly: four need to know what a form is *for*, and one needs a different
file kind. None of them is a regex problem, so none is a to-do disguised as one.

## 4. Where upstream is better

| | what it buys | evidence |
| --- | --- | --- |
| **Parses instead of matching** | It can decide that a `click` listener opens a dialog, that a password input belongs to sign-in, that a `:invalid` selector targets a `<select>`. Those are exactly the rules we refuse. | feasibility §1.2, §2.1 |
| **A verify stage with rubrics** | Every rule ships `keepWhen[]`/`dropWhen[]` (65 `keepWhen` bullets across 35 rules) and the workflow runs findings through them. Our findings carry a `confidence` label and nothing else — a promise, not a check. | feasibility §1.3, §1.4 |
| **A modernize stage** | After reporting, it can rewrite the caller's code. We never write. | feasibility §1.1, §2.2 |
| **Guide-hash invalidation** | Each rule stores `guideHash` (35/35), so when Google edits the guide the rule can be marked stale. 0.6.0 adds our own guard — `scripts/hash-guides.mjs` plus `test/scan-guides.test.mjs` — which catches a guide that moved, not a message that drifted; see §7. | feasibility §1.3 |
| **Reach** | 35 rules / 33 guides against our 33 / 33. | §2 above |
| **Distribution** | An npm CLI any agent with a shell can run; we need the DSH host. | `README.md` comparison table |

## 5. Where this plugin is better

| | what it buys | evidence |
| --- | --- | --- |
| **Zero dependencies** | ~33 kB of scanner and rule table (`lib/scan.js` 20,956 B + `lib/scan-rules.js` 12,257 B) against a 4.99 MB bundle with a bundled TypeScript compiler. `dependencies` and `devDependencies` are both empty. | `package.json` |
| **Cannot damage the tree** | Read-only by construction: explicit relative paths only, `realpath` containment against the session cwd, hard caps on paths/files/bytes/findings/skips, no `exec`, no network, no code generation. The refusal is reproduced in [audit/security.md](../../audit/security.md) §F8. | `lib/scan.js`, `audit/repro/security/scan-containment.mjs` |
| **It sits where the work happens** | One session: scan → finding with `guideId` → `web_guidance_retrieve` on that guide → implement. Upstream's CLI sits outside the agent's context. | `index.js`, `README.md` |
| **Same corpus, without the lookup assets** | The same 208 byte-identical guides, ranked by BM25 in-process (29/30 top-1 on the probe) instead of 9.16 MB of quantized word vectors and chunk embeddings. | `README.md` comparison table |
| **Honest about its own noise** | Eighteen rules are shipped `high`, thirteen `medium` and two `low`, and the four rules that would be noise are absent rather than shipped with a disclaimer. | `lib/scan-rules.js` |
| **Three languages** | Docs and panel in EN/RU/ZH; upstream is English-only. | `client.js`, `README.*.md` |

## 6. Closed in 0.6.0, and what remains

Closed, each with its planted and clean test pair:

1. `:host-context()` as `ls-31` → `styling-web-components`, confidence high: a removed CSS feature is
   a mechanical marker.
2. `balanceText()` / `<Balancer>` as `ls-32` → `improve-text-layout-and-legibility`, split out of
   `ls-22`, which keeps `fitty`/`fitText` on `equal-width-text-lines`.
3. `select:invalid` as `ls-33` → `select-menu-interaction`, leaving `ls-08` for `input:invalid` and
   `textarea:invalid`.

Not closed, deliberately: the four `autofill-*` rules. A pattern that fires on every password field in
the world and is right a fraction of the time is worse than a missing rule; that is why the tier split
in the feasibility note exists at all.

Different shape, not refused: a `package.json` rule. It would have to read a manifest the caller
names and check a declared dependency, which is a second file kind for a scanner that is deliberately
file-agnostic. Feasible, but it belongs to a manifest-checking tool.

## 7. Debts

- **Guide-hash invalidation — closed in 0.6.0, with a caveat.** Upstream ties every rule to the hash
  of the guide it points at. Ours keeps a guide *id*; 0.6.0 adds `scripts/hash-guides.mjs` and
  `test/scan-guides.test.mjs`, so a corpus refresh that changes a covered guide turns a test red
  instead of shipping a rule whose guide moved out from under it. The caveat: the guard proves the
  guide changed, not that the rule's `message` still describes its replacement — step 2 of the
  checklist below is still a human read.
- **Confidence is not verification.** `low` means "we know this marker is only a hint"; it does not
  mean the finding was checked. Only a verify stage (upstream's rubrics) would change that.

### Corpus refresh checklist

1. Re-run the parity audit in §9 against the refreshed corpus, so a guide that vanished or moved is a
   failure before any doc claims otherwise.
2. Re-read the `message` of every rule whose guide changed: the marker may still match, while the
   replacement it names has moved on.
3. Regenerate the guide hashes with `node scripts/hash-guides.mjs`; the guard that fails on a stale
   record is `node --test test/scan-guides.test.mjs`.

## 8. What this decides

- The rule table is **33 rules, 30 of upstream's 35**, and that is a design point, not an unfinished port.
- The gap is **four `autofill-*` markers that need DOM context plus one `package.json` rule** — nothing else.
- Growth beyond 33 is allowed, but it is our own work, not a port: a new rule earns its place with a
  planted case, a clean case, and a `guideId` that exists in `data/guides.json`.
- The one debt to carry into any future corpus refresh is the message-level check, not the hash (§7).

## 9. Reproduce

```bash
# our side: 33 rules, 33 distinct guides
node -e "import('./lib/scan-rules.js').then(m => console.log(m.RULES.length, new Set(m.RULES.map(r => r.guideId)).size))"

# upstream side: 35 rules, 33 distinct guides (artifact rebuilt per the feasibility note's lexer)
node -e "const r = require('./.tmp/legacy-rules.json'); console.log(r.length, new Set(r.map(x => x.guideId)).size)"

# the reach: 31 upstream rules sit on guides we cover; one of them, package-text-balance,
# has no counterpart here — so the ledger says 30 of 35
node -e "const up = require('./.tmp/legacy-rules.json'); import('./lib/scan-rules.js').then(m => { const ours = new Set(m.RULES.map(r => r.guideId)); const shared = up.filter(u => ours.has(u.guideId)); console.log(shared.length, shared.filter(u => u.guideId === 'improve-text-layout-and-legibility').map(u => u.ruleId).join(' ')); })"

# the remaining gap: which upstream guides our table does not address (expect 4, all autofill-*)
node -e "const up = require('./.tmp/legacy-rules.json'); import('./lib/scan-rules.js').then(m => { const ours = new Set(m.RULES.map(r => r.guideId)); const gap = [...new Set(up.map(r => r.guideId))].filter(g => !ours.has(g)); console.log(gap.length, gap.join(' ')); })"
```

The extracted artifact is temp-only and git-ignored by design — rebuild it with the feasibility
note's lexer rather than trusting a committed JSON of someone else's rules.
