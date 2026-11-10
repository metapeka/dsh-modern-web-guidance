# Security audit — `dsh-modern-web-guidance` 0.1.0

> **Snapshot qualifier.** Numbers in this document describe the 2026-10-30 snapshot and the 0.1.0 code;
> the corpus now ships 208 guides (upstream v1.0.0, 2026-11-09). Figures and repro assertions are left as
> recorded, so a rerun against the current tree will differ by design.

Target: `E:\0ai\dsh_mod_1\dsh-modern-web-guidance` (DSH / Cordis in-process plugin, zero dependencies).
Scope: `index.js` (253 lines), `lib/guidance.js` (319 lines), `package.json`, `cordis.patch.yml`,
install/publish surface, and the command-shaped strings inside the bundled corpus.
Method: full read of both source files, sink grep over code (not corpus), 3 repro programs exercised
against the real corpus, live npm-registry probe for the package the corpus names.
Every number below is output of a command recorded in `audit/repro/security/`.
Environment: Windows, Node v24.20.0, plugin sources unmodified.

**Position of the code under review:** an in-process ES module in the host. It imports `node:fs`
directly (`index.js:9`, `lib/guidance.js:9`), so it can read anything the host user can read, and
`inject` does not gate that. "Can read host files" is therefore not a finding; what matters is
whether *attacker- or model-controlled input* widens that, and whether the plugin adds
code-execution, network, write, or availability risk.

| # | Severity | Finding | Location |
|---|---|---|---|
| F1 | **Medium** | Bundled guides instruct the agent to run `npx -y modern-web-guidance@latest` — unpinned remote package execution, 121 times in 45/193 guides | `data/guides/security/passkeys.md:33-38` (etc.) |
| F2 | **Medium** | `retrieve()` has no cap on id count, duplicates, or output size — 3000 ids → 36.61 MiB in one tool result | `lib/guidance.js:295-311`, `index.js:139-142` |
| F3 | **Medium** | Query length is unbounded and every ≥5-char term scans the whole vocabulary synchronously — a 137 KiB query blocks the host event loop 6.85 s | `lib/guidance.js:187`, `lib/guidance.js:237-255` |
| F4 | **Low** | Catalog values are interpolated into a filesystem path with no containment check; a tampered `guides.json` reads any `*.md` on disk and returns it to the model | `lib/guidance.js:124-126` |
| F5 | **Low** | Tool failures surface Node errors verbatim, including the absolute install path | `lib/guidance.js:153`, `index.js:111` |
| F6 | Info | `inject: ['skills','tools']` declares dependencies, not capabilities; nothing requests or uses more, and no write/exec/network sink exists | `index.js:216,229,247` |
| F7 | Info | Warm-up failure comment says it is retried, but the rejected promise is cached forever | `index.js:225`, `lib/guidance.js:176` |

Counts: 0 critical, 0 high, 3 medium, 2 low, 2 info.

---

## F1 — Medium — corpus tells the agent to execute an unpinned npm package

**Location:** `data/guides/security/passkeys.md:33-38`, and 116 more occurrences across 44 other
guides (121 total, 45 of 193 guides). Example lines, verbatim from the shipped file:

```
33: *   **Passkey Registration**: `passkey-registration` (via `npx -y modern-web-guidance@latest retrieve "passkey-registration"`) ...
```

**Why it is a security problem here.** `web_guidance_retrieve` returns guide markdown verbatim
(`index.js:67`), so this text lands in the model's context as a ready-to-run shell command. Once the
agent runs it, `npx -y` (a) resolves `modern-web-guidance` from the network at whatever the current
`@latest` is, (b) auto-answers the install prompt, and (c) executes that package's lifecycle scripts
and CLI with the **host user's** privileges — completely outside this plugin, with no pinning to the
reviewed snapshot. The corpus *is* pinned to upstream `modern-web-guidance@0.0.197` (`README.md:86`),
but the command text is not: it says `@latest`.
The sandbox could reach the registry, so this path is live:

```
$ node -e "fetch('https://registry.npmjs.org/modern-web-guidance')..."
status 200   name modern-web-guidance   latest 0.0.197   desc: Keep your agent up to date on the latest web best practices.
```

`README.md:75-76` says the *skill body* was rewritten "to call this plugin's tools instead of the
`npx` CLI" — the 193 *guide bodies* were not, so the rewrite is incomplete. A model following the
guide text does redundant, remote, privileged work instead of calling the bundled `retrieve` tool.

**Repro:** `node -e` count in the transcript above; or
`Select-String -Path data\guides\*\*.md -Pattern 'npx -y modern-web-guidance' -AllMatches`.

**Fix:** add a corpus lint test that fails on `npx`, `npm i`, `curl`, `git clone` inside
`data/guides/**`; reword the cross-references to `web_guidance_retrieve("passkey-registration")`
(the shape the skill body already uses). Do not keep a network fallback in content.

---

## F2 — Medium — `retrieve()` output is unbounded in count, size and duplicates

**Location:** `lib/guidance.js:295-311` (no cap, no dedupe, `docs.find` linear scan per id),
`index.js:139-142` (passes `args.ids` straight through), `index.js:64-75` (renders every hit, no
truncation).

The `ids` schema (`index.js:127-134`) has no `maxItems` and no length limit, and the implementation
neither dedupes nor caps. Measured:

```
== 1. unbounded retrieve(): ids are not capped, deduped or truncated ==
  baseline: 1 id -> 12820 bytes (dialog guide)
     10 duplicate ids -> 0.12 MiB output, 1 ms, guides=10
    100 duplicate ids -> 1.22 MiB output, 5 ms, guides=100
   1000 duplicate ids -> 12.20 MiB output, 71 ms, guides=1000
   3000 duplicate ids -> 36.61 MiB output, 206 ms, guides=3000
  every valid id (193) -> 1.54 MiB in one tool result
```

**Why it matters:** a single tool call — trivially reachable by a prompt-injected model or a buggy
retry loop — materialises tens of MB of strings inside the host process and hands the same bytes to
the context. That is host memory pressure plus context exhaustion, not "big output". The loop is
also O(requested_ids × 193) because of `docs.find(...)` on the miss path.

**Repro:** `node audit/repro/security/resource.mjs`.

**Fix:** in `retrieve()`, dedupe with a `Set`, cap at a small n (e.g. 10), reject/ignore ids longer
than ~80 chars, and add `maxItems: 10` + `maxLength` to the schema so the host validates before
`execute`. Optionally report `truncated: n`.

---

## F3 — Medium — unbounded query length × full-vocabulary scan blocks the host

**Location:** `lib/guidance.js:187` (`for (const candidate of byTerm.keys())` — the whole vocabulary
is walked for every query term of length ≥ 5), driven by `lib/guidance.js:194-196` and
`lib/guidance.js:237-238`; the `query` schema (`index.js:101`) has no `maxLength`.

The work is synchronous inside an `async` function, so it runs on the host's event loop and stalls
every session sharing the process. Measured against the real corpus:

```
  query with    50 terms -> 71 ms
  query with   200 terms -> 204 ms
  query with   800 terms -> 767 ms
  query with  3200 terms (22 KiB) -> 1971 ms
  8000-term query (8 KiB of distinct words): 3783 ms, heapUsed=39.31 MiB, rss=132.36 MiB
 12000 terms (82 KiB) -> 5324 ms; per-term 0.444 ms
 20000 terms (137 KiB) -> 6850 ms; per-term 0.343 ms
```

Extrapolation is unflattering: a 500 KiB query is ~25 s of blocked event loop, repeatable per call.
Note the distinction that makes this finding specific rather than generic — **one** long token is
cheap (600 000-char token: 7 ms, `String.includes` path), so a naive "cap total bytes" test would
miss it; the cost is `#distinct ≥5-char terms × vocabulary size`.

**Repro:** `node audit/repro/security/resource.mjs` (sections 2 and 4).

**Fix:** clamp in `search()` before `prepare()`: normalize once, reject/reduce to at most ~12 terms
and ~256 characters, and skip `expand()`'s prefix sweep for the tail terms. Also cheap: build a
sorted term array once so prefix lookup is a binary search instead of a full scan.

---

## F4 — Low — data-driven path, no containment check (defence in depth)

**Location:** `lib/guidance.js:124-126`

```js
const relative = join('guides', entry.category, `${entry.id}.md`)
const markdown = await readFile(join(dataDir, relative), 'utf8')
```

**Tool arguments cannot reach this.** Proven: eight hostile ids
(`../../../../Windows/win.ini`, `..\..\..\Windows\win.ini`, `C:\Windows\win.ini`, `/etc/passwd`,
`guides/../../package.json`, …) all come back as unknown, `guides=0 unknown=8`, no content leaked;
`category`/`query` are exact string comparisons, so `../../etc`, `..\..\Windows`, `\0`,
`__proto__`, `constructor` all yield 0 hits (`node audit/repro/security/probes.mjs`).

What *can* reach it is the catalog file itself, i.e. the corpus-contribution / supply-chain surface.
With a `guides.json` entry `{id: "../outside-fixture", category: ".."}` the join collapses
`data/guides` and reads outside the package:

```
guides=1 unknown=[]
leaked content: "# planted fixture\n\nPLANTED_MARKER=this-file-lives-outside-the-data-directory\n"
```

(`node audit/repro/security/data-trust.mjs`; the tampered doc is also returned by `search()`.) The
fixture is generated at run time and cleaned up: it is not committed, and its marker is deliberately
not credential-shaped so that secret scanners do not flag this public repo. The suffix is fixed to
`.md`, which limits usefulness, but `.md` files are exactly where agent memory, `AGENTS.md` and repo
notes live, and the content is returned to the model verbatim.

**Fix:** validate `entry.category`/`entry.id` against `/^[a-z0-9][a-z0-9-]*$/` while building the
index, and assert `resolve(path).startsWith(resolve(dataDir) + sep)` before reading. Fail the build
with the offending entry id.

---

## F5 — Low — absolute host paths disclosed through tool errors

**Location:** `lib/guidance.js:153` (`readFile(join(dataDir,'guides.json'))` rejects uncaught),
surfaced by `index.js:111/141/160`.

```
code=ENOENT message=ENOENT: no such file or directory, open 'C:\definitely-not-here\mwg\data\guides.json'
list() code=ENOENT path=C:\definitely-not-here\mwg\data\guides.json
```

Only matters if the data dir is moved/broken (packaging bug, partial install), but then the model
receives the host's install path and username. Low, because it needs a broken install to fire and
discloses no secret.

**Fix:** catch inside `buildIndex()` and throw
`new Error('modern-web-guidance: bundled guide data could not be read')` with a `cause` kept for logs.

---

## F6 — Info — privilege surface is what it claims

`inject = ['skills','tools']` (`index.js:216`) matches the only two services touched:
`ctx.tools.register` (`:229`) and `ctx.skills.register` (`:247`); nothing else is requested or used.
`inject` is a cordis dependency declaration, not a sandbox: the plugin imports `node:fs` directly
without asking any service for it (`index.js:9`, `lib/guidance.js:9`). That is normal for an
in-process host plugin and is not itself a finding, but it means F2/F3/F4 cannot be mitigated by
tightening `inject` — they need code-level limits. Confirmed minimal: a full grep of the two source
files for `eval|Function(|child_process|spawn|exec|fetch|http|https|net|tls|dns|WebSocket|process.env|
write|unlink|rm|rename|mkdir|symlink|import(` returns no sink — the only imports are
`node:fs` read APIs, `node:path`, `node:url` (`index.js:9-13`, `lib/guidance.js:9-10`).

## F7 — Info — stale rejected index promise

`index.js:225` runs `void guidance.ready().catch(() => {})` with the comment "a failed warm-up is
retried by the first tool call". It is not: `indexPromise ??= buildIndex()`
(`lib/guidance.js:176`) caches the rejected promise, so after any transient read failure all three
tools reject until the host restarts. Availability nit, no security impact; fix by clearing
`indexPromise` on rejection.

---

## Areas verified clean (what I checked, not a checklist)

- **Code execution:** no `eval`, `new Function`, `vm`, `require`, dynamic `import()` of non-literals,
  `child_process`, or shell in `index.js`/`lib/guidance.js` — grep above, plus a read of both files.
  (`eval`/`import()` hits exist only as *examples inside* the markdown corpus.)
- **Network:** no `fetch`, `undici`, `http`/`https`/`net`/`tls`/`dns`, `WebSocket` in plugin code;
  the plugin's only I/O is `readFile`/`readFileSync` on the package itself. Matches the header claim
  at `index.js:5-6`.
- **Filesystem writes:** none. No `writeFile`, `appendFile`, `unlink`, `rm`, `rename`, `mkdir`,
  `chmod`, `symlink`, stream writes anywhere in code — the audit repro scripts are the only writers,
  and only under `audit/repro/security/`.
- **Path traversal from tool args:** proven blocked (F4 above); `retrieve` resolves ids against the
  in-memory `byId`/`docs` only, `search`/`list` compare `category` with `===`.
- **Prototype pollution:** all indexing uses `Map`; `JSON.parse` output is read through fixed
  property names; no bracket-assignment with untrusted keys, no `Object.assign`/merge of args.
  Probes with `__proto__`, `constructor`, `constructor.prototype.polluted`, `prototype`, `toString`,
  `valueOf`, `__defineGetter__` through all three entry points left `({}).polluted === undefined`,
  `Object.prototype.polluted === undefined`, and `Object.getOwnPropertyNames(Object.prototype).length === 12`.
- **Argument coercion:** `limit` is clamped `1..25` in code (`lib/guidance.js:230`) despite the loose
  schema — measured `1e9 → 25`, `Infinity → 25`, `-Infinity/-5 → 1`, `NaN/'abc'/null/0 → 8`,
  `3.7 → 3`. `ids` handles `undefined/null/123/{}` without throwing and reports them as unknown.
- **ReDoS:** no user-supplied `RegExp` anywhere. The three regexes (`tokenize` `lib/guidance.js:57`,
  `titleOf:87`, `headingsOf:95`, `slugFromPhrase:107`) are linear and applied to bounded package
  text; the model-controlled needle in `substringFallback:218` goes to `String.includes`, not a
  regex — a 600 000-char needle costs 7 ms. `retrieve`'s quote-stripper (`:298`) is
  `^['"]|['"]$`, anchored on both branches, no nesting.
- **Supply chain:** `package.json` has **no `dependencies`/`devDependencies`/`optionalDependencies`
  and no `postinstall`/`preinstall`/`prepare`** — the only script is `"test": "node --test test/"`
  (`package.json:56`). Nothing is fetched at install time. `files` whitelists
  `index.js, lib, data, locale, cordis.patch.yml, README.md, LICENSE, NOTICE, icon.svg`
  (`package.json:12-22`), which excludes `test/`, `market/`, `.git/` **and `audit/`** — audit
  artifacts cannot ship in the tarball. `cordis.patch.yml` is a plain 4-line `insert` with
  `config: {}`: no `!!js` tags, no inline JS, no overrides of other plugins.
- **Secrets:** no `process.env` read, no key handling, no logging of host state, no telemetry (a
  grep for `console.` in code returns nothing outside comments).
- **Packaged corpus integrity:** 193 entries in `data/guides.json`, 193 unique ids, 17 categories,
  193/193 markdown files present, 0 duplicate `category/id` pairs, 0 entries with `/`, `\` or `..`
  in `id`/`category`, 0 non-string ids, 0 symlinks/junctions in the package, 1 557 860 bytes of
  markdown total.

## Not covered / limits of this audit

- **Host-side caps are unknown to me.** Whether DSH truncates tool results, validates `maxItems`, or
  kills a slow `execute` changes F2/F3 severity from "medium" to "low". I did not audit the host.
- No live host session: I exercised `createGuidance()` and `apply()` directly with the same mocked
  ctx as `test/plugin.test.mjs`; I did not run `plugin_manager` install or a real model turn, so
  "the model obeys the `npx` line in F1" is inference from prompt-injection behaviour, not observed.
- Corpus content audited only for command-shaped strings (`npx`, `npm i -g`, `curl`, `git clone`,
  `iwr`). No exhaustive prose prompt-injection or misinformation review of 193 guides.
- Supply-chain conclusions are static (no `npm pack`/`npm install` run, per task constraints), so
  how the host actually resolves `dsh.bundle.patch` at install time was not verified.
- Windows only; `join()` semantics checked on `win32` only.
- Did not verify whether skill `resourceBase` reads are confined by the host: `index.js:201`
  declares `{kind:'directory', path: DATA_DIR}` for `modern-web-guidance`, i.e. the whole data dir
  (all 193 guides + skills). Non-sensitive by design, but if the host enforces containment only via
  `resourceBase`, that base is broader than the skill body needs.

## Repro artifacts

- `audit/repro/security/probes.mjs` — traversal, prototype pollution, limit clamping, id coercion,
  error disclosure.
- `audit/repro/security/resource.mjs` — unbounded `retrieve()`, `expand()` blowup, memory.
- `audit/repro/security/data-trust.mjs` — tampered `guides.json` → read outside `data/`
  (self-contained; creates and removes its own temp dir).
- Run each from the package root with `node audit\repro\security\<name>.mjs`.
