# `legacy-scan` contract for 0.5.0

Authoritative interface the four 0.5.0 workstreams code against. Written by the Lead before the work
split, so the modules can be written in parallel without guessing each other's shapes. Rationale and
the upstream analysis live in [legacy-scan-feasibility.md](legacy-scan-feasibility.md).

Revised in 0.7.1: `.md` and `.mdx` left the extension allowlist, so prose is now skipped rather than
scanned — see the allowlist under `lib/scan.js` and the self-scan caveat below. Revised again in 0.7.2:
dot-directories are never entered, `.scanignore` at the workspace root is honoured, and skips are counted
per reason in `scanned.skippedByReason`. Revised again in 0.8.0: a finding is one **code site** rather than
one line, so every finding carries `lines` and `occurrences`, runs of neighbouring hits collapse, and
`maxFindings` counts findings. Everything else below is unchanged.

## Non-negotiables

- Zero runtime dependencies. `lib/scan.js` and `lib/scan-rules.js` import only Node built-ins
  (`node:fs`, `node:path`, `node:fs/promises`, `node:buffer`).
- Read-only. The tool never writes, never spawns a process, never touches the network.
- Explicit paths only. The caller names files or directories; there is no default target, no "scan the
  repo", no glob expansion by us.
- No upstream parity claims anywhere: this is a marker scanner, not an AST analyzer.
- Host style: prose first, `/** … */` on exported API, no semicolons, two-space indent, single quotes.

## `lib/scan-rules.js`

```js
/** @typedef {{ id: string, guideId: string | null, confidence: 'high' | 'medium' | 'low', message: string, source: string }} ScanRule */

/** Ordered rule table. Ids are `ls-01` … `ls-33`. */
export const RULES: readonly ScanRule[]

/** Query selectors, `['high', 'medium', 'low']` — for sorting and for the panel's confidence column. */
export const CONFIDENCE_ORDER: readonly string[]

/** Resolve the `rules` argument: unknown ids are reported, not thrown. `undefined` means every rule. */
export function selectRules(ids?: readonly string[]): { rules: ScanRule[], unknown: string[] }

/** One rule by id, or undefined. */
export function ruleById(id: string): ScanRule | undefined
```

- `source` is a **RegExp source string without flags**: the scanner compiles `new RegExp(source, 'g')`
  and matches line by line, so anchors behave per line and no flag may be baked in.
- `message` is one imperative sentence naming the modern replacement ("Use dialog.showModal() instead of
  the jQuery-style $.fn.modal helper."), not a restatement of the marker.
- `guideId` must exist in `data/guides.json`; `test/scan-rules.test.mjs` asserts every non-null one does,
  that ids are unique and ordered, that `RULES.length === 33`, that every `source` compiles and is not
  null-matched on an empty string, and that every rule carries a non-empty `message`.
- Coverage: the 33 rules point at 33 distinct guides, one rule per guide. Confidence is `high` when
  the marker alone is conclusive, `medium` when it is strong in context, `low` when a false positive is likely.

## `lib/scan.js`

```js
export const SCAN_LIMITS = Object.freeze({
  maxPaths: 16,
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFindings: 200,
  maxSnippetChars: 160,
  maxSkipped: 100,
  extensions: [
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
    '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro',
    '.json',
  ],
  skipDirectories: [
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
    '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'vendor', 'target',
    '__pycache__', '.venv', 'venv', '.tmp', '.agents',
  ],
})

export class ScanError extends Error {
  /** @type {'paths' | 'path-absolute' | 'path-outside' | 'path-missing' | 'path-unreadable' | 'rules' | 'limits'} */
  code
  /** The path or rule id the message is about, when there is one. */
  subject
}

export async function scan({ cwd, paths, rules = RULES, signal, limits = SCAN_LIMITS }) → ScanResult
```

`ScanResult`:

```js
{
  scanned: {
    files: number,
    bytes: number,
    skipped: { path: string, reason: 'outside'|'large'|'binary'|'extension'|'unreadable'|'too-many'|'dot-directory'|'scanignore' }[],
    skippedTotal: number,
    skippedByReason: Record<string, number>,
    ignoreProblems: { line: number | null, reason: 'malformed'|'unreadable' }[],
    truncated: boolean,
  },
  findings: { path: string, line: number, column: number, ruleId: string, guideId: string | null, confidence: string, message: string, snippet: string, lines: number[], occurrences: number }[],
  guides: { id: string, findings: number }[],
  truncated: boolean,
}
```

`skipped` is capped at `maxSkipped` entries and ordered by discovery; `skippedTotal` counts every skip,
so a directory of a thousand assets cannot turn the `json` format into a thousand-line dump while the
summary still tells the truth. Both counts are always consistent: `skippedTotal >= skipped.length`.

`skippedByReason` counts **every** skip, per reason, so a truncated sample still explains itself; its keys
are the eight reason tokens above and a reason that never fired is absent, not zero. `ignoreProblems` is a
**separate** field: `.scanignore` diagnostics are not file skips and never enter `skipped`,
`skippedTotal` or `skippedByReason`, so those three keep counting files only and their arithmetic stays
true. At most 20 problems come back, and either kind of problem — a malformed line or an unreadable
file — is reported without aborting the scan.

The skip reasons, all eight: `extension` (not an allowlisted code extension, including every Markdown
file), `binary` (a NUL byte in the head), `large` (over `maxFileBytes`), `too-many` (the walk stopped
before this path), `unreadable` (the file could not be read), `outside` (a symlink leaving the
workspace), `dot-directory` (a directory whose name starts with `.`, one entry per directory), and
`scanignore` (covered by a pattern, one entry per skipped file or subtree root).

## A finding is a code site (0.8.0)

One rule on one run of neighbouring lines is **one** finding — the thing a reader opens the file to change,
not one thing per line. Everything below follows from that sentence.

- **The run rule.** Hits of one rule in one file stay in the same run while the next hit's line is at most
  `RUN_LINE_GAP = 2` lines after the previous one: the next line, or one blank line later. A wider gap, a
  different file or a different rule starts a new finding. A run is per rule and per file, so two rules
  interleaving on the same lines stay two findings.
- **`lines` and `occurrences` are always present.** A single hit is `lines: [154]` with `occurrences: 1`,
  so no consumer needs a fallback branch for the new fields. `lines` holds the exact line numbers, in
  order, and `occurrences` is their count (and therefore `lines.length`).
- **`line`, `column`, `snippet` and `message` describe the first hit** and keep their old meaning. The
  range belongs to the finding: rule messages are not rewritten to mention it, and `snippet` is the first
  hit's line, never a concatenation of the run.
- **`maxFindings` counts findings, not hits.** A 40-line ladder is one finding against a cap of 200
  findings, so the same `SCAN_LIMITS` now admits far more code than it did. No cap was widened.
- **Ordering**: `path`, then first line, then column, then `ruleId`.
- **Measured on the bench project's `src`** (58 files): **22 → 10 findings**, `ls-05` **13 → 2**, no
  truncation, and **22 line references before, 22 after** — `report-template.css:306-313` with 8 hits and
  `:347-351` with 5 are now two findings instead of thirteen, and no line number was lost.

### How to read one

Use `lines[0]` and `lines.at(-1)` for the range and `occurrences` for how many hits it stands for. `line`
and `column` still point at the first hit, so code that printed `path:line:column` keeps printing something
true — it just names the start of the site rather than claiming to be the whole of it.

### The rendered form

```text
- src/components/Header.astro:642:5 ls-09 (medium)
- src/components/ui/PostCard.astro:110-112 (2 hits) ls-12 (high)
- src/styles/report-template.css:306-313 ls-05 (medium)
```

A single hit renders `path:line:column`, byte for byte as before. A run renders `path:first-last`, and
`(N hits)` is appended **only** when the run is not dense — because `110-112` would otherwise claim three
hits where there are two. A dense run such as `306-313` needs no count: eight hits on eight lines. Both the
tool's summary text and `/guidance-scan` render from this one rule, and the JSON never formats a string at
all — the fields are the truth.

## Rules of the road

1. `paths` is a non-empty array of strings, at most `maxPaths`. Anything else is `ScanError('paths')`.
2. Relative only: an absolute path (POSIX `/`, Windows drive letter, UNC `\\`, or a leading `~`) is
   `ScanError('path-absolute')` with that path as `subject`. Empty strings and NUL bytes are `'paths'`.
3. Containment: resolve against `cwd`, then `realpath` both the target and `cwd`; if the real target is
   not inside the real `cwd` (separator-aware prefix, equal counts as inside) it is `ScanError('path-outside')`.
   A symlink encountered **while walking** that leaves `cwd` is not an error: that entry is skipped with
   `reason: 'outside'`.
4. A named path that does not exist is `ScanError('path-missing')` — explicit paths only, silence would
   hide a typo.
5. Walking: files whose extension is not in `extensions` are skipped with `reason: 'extension'`;
   directories whose name is in `skipDirectories` are not entered at all, and a directory whose name
   starts with `.` is never entered either — it is skipped with `reason: 'dot-directory'`, **one entry per
   directory**, not one per file inside, and the same refusal applies when the caller names it explicitly
   (`paths: ['.github']` returns 0 files and one `dot-directory` skip, not an error). Symlinked
   directories are not followed. **Markdown is prose, not code**: `.md` and `.mdx` are not in the
   allowlist (0.7.1), so every Markdown file met while walking is skipped with `reason: 'extension'` and
   counted in `skippedTotal`, and a `.md` path named **explicitly** gets that same skip instead of an
   error — the answer "this is documentation, I did not read it" is the useful one, and a report on a
   project whose only defect is its prose must come back empty rather than full of quoted anti-patterns.
6. Per file: `stat` first; larger than `maxFileBytes` → `reason: 'large'`. Reading uses one `readFile`
   per file; a NUL byte inside the first 8000 bytes → `reason: 'binary'`. An unreadable file is skipped
   with `reason: 'unreadable'`, never fatal.
7. Totals: `maxFiles` files scanned or `maxTotalBytes` read → stop walking, `scanned.truncated = true`.
8. Matching: for each line, each selected rule's compiled regex; `lastIndex` reset before every line;
   only the first match per rule per line is a **hit**. Hits are grouped into runs and a run is one
   finding, so the pre-0.8.0 rule "one finding per `ruleId + path + line`" is gone: neighbouring lines of
   one rule collapse into a single finding with `lines` and `occurrences`. `line` and `column` are
   1-based, and `column` is the match offset of the run's first hit.
9. `snippet` is the **first hit's** line with leading and trailing whitespace trimmed, then clipped to
   `maxSnippetChars` with a trailing `…` when it had to shrink. Control characters other than tab are
   replaced with `\u0000`-style escapes so a report cannot smuggle terminal control bytes.
10. Ordering: `path` ascending, then first line, then `column`, then `ruleId`. `maxFindings` is a hard cap
    on the returned array of **findings** — 40 hits in one ladder consume one slot — and hitting it sets
    both `findings` length to the cap and `truncated = true`.
11. `guides` is the per-guide count over the **returned** findings, ordered by `findings` descending then
    `id` ascending; rules with a null `guideId` are excluded. `signal.aborted` →
    `ScanError('cancelled')` is **not** used: throw the abort reason itself (`signal.throwIfAborted()`)
    so the host renders it as a cancellation.

## `.scanignore` (0.7.2)

`<cwd>/.scanignore` — at the workspace root, never in a subdirectory — is the one file the scanner reads
without being asked. It is read at the start of every scan, so an edit takes effect on the next scan. The
grammar below is **quoted verbatim from the module header of `lib/scan.js`**, which is the normative
copy; if the two ever disagree, the header wins and this file is a bug.

```text
`.scanignore` is the one file the scanner reads without being asked. Its grammar is exactly this
subset, no more:

  - The file is read as UTF-8; a leading BOM is dropped and CRLF is read as LF.
  - One pattern per line. A line whose first non-space character is `#` is a comment. A line that
    is empty after trimming is ignored. Every other line, trimmed, is one pattern.
  - A pattern of one segment matches that name at any depth: `report/` skips every directory
    called `report`, `*.min.js` skips every file ending that way. A pattern with a `/` inside it is
    anchored at the workspace root and matched against the whole workspace-relative POSIX path:
    `src/app.js` matches that file and nothing else. A leading `/` is allowed and ignored: every
    pattern is already relative to the workspace root.
  - A trailing `/` makes a directory pattern: it matches a directory only, and a match skips the
    whole subtree. Without the slash a pattern matches a file or a directory of that name.
  - `*` matches any run of characters inside one path segment and never crosses `/`. Everything
    else is literal: there is no negation, no `**`, no `?`, no character class, no escaping.
  - A line outside that subset is malformed. It is not an error: the scan continues and the line
    is reported in `scanned.ignoreProblems` as `{ line, reason: 'malformed' }`. A `.scanignore`
    that cannot be read is reported as `{ line: null, reason: 'unreadable' }`, and the scan runs
    without patterns. Neither ever aborts a scan, and neither is a file skip: `skipped`,
    `skippedTotal` and `skippedByReason` count files only, so their arithmetic stays true.
```

Excluding an artifacts directory — the worked case this release was built for: a real Astro project holds
**241** candidate files outside its dot-directories, of which `tmp-deploy` holds 82 and `report` 66, so
`src`'s 58 sit past the 200-file cap and the scan came back truncated with 41 findings.

```text
# .scanignore — keep build output, scraped dumps and backups out of the walk
tmp-deploy/
report/
backups/
seed/
tasks/
plugins/
*.min.js
```

Those six directory patterns turn a `scan({ cwd, paths: ['.'] })` that returned 200 files (the cap),
41 findings and `truncated: true` into **77 files, 22 findings**, all of them in `src`, with
`skippedByReason: { scanignore: 6, extension: 1 }` and no truncation. A directory pattern is one skip for
the subtree root, not one per file inside it.

**A pattern may name one file, not only a directory.** The same mechanism parks a single page instead of a
subtree: with a project whose `src/pages/` holds three pages that each trigger one rule, adding a line for
one of them keeps that page in the repository while the walk reads past it.

```text
# .scanignore — park the demo page that shows the legacy form on purpose
src/pages/styleguide.astro
```

Measured on exactly that workspace: `scan({ cwd, paths: ['.'] })` reports **2 files and 2 findings**
(`src/pages/about.astro` and `src/pages/index.astro`), with `src/pages/styleguide.astro` returned as one
`scanignore` skip; `skippedByReason` is `{ scanignore: 1, extension: 1 }`, the second being the ignore file
itself, which is not code. The parked page contributes no finding and its siblings are untouched — the
directory is not pruned, only the named file is. Naming the directory instead (`src/pages/`) reads the same
two pages, so the two forms differ only in breadth.

Two precedence rules, both from the same module header. A pattern covers the path itself **and every
ancestor**, so a file named explicitly inside an ignored directory is skipped as `scanignore` rather than
read behind the ignore file's back. And a path that is both inside a dot-directory and matched by a pattern
is reported **once**, as `dot-directory`, because that check runs first.

The same holds for a file pattern, and this is the part a user does not expect: naming the parked file
explicitly, `scan({ cwd, paths: ['src/pages/styleguide.astro'] })`, returns **0 files and 0 findings** with
the same single `scanignore` skip — the ignore wins over an explicit path instead of the path overriding the
ignore. That is deliberate, not an oversight: `.scanignore` exists to make a scan read **less**, and an
explicit path able to switch it off would turn the ignore file into a suggestion. Delete the line when you
want the page read.

`.scanignore` is **not a security boundary**. It is a convenience for a project that knows what it means by
"here"; the scanner is already confined to `realpath(cwd)` by containment, so an ignore file can only make
a scan read less than it was already allowed to read, never more.

## What a self-scan looks like (measured on this tree)

This repository stores the rule table, so a scan of it reports the rule table's own markers as findings.
`scan({ cwd, paths: ['.'] })` here returns **70 files scanned, 85 findings, 0 of them in Markdown,
`truncated: false`**, with `skippedTotal: 284` (`skippedByReason: { extension: 281, dot-directory: 2 }`,
100 of those entries returned, which is the cap). The skip total is a moving figure and moves by one for
every Markdown document added to the tree — `.md` is skipped as `extension` — so read it as a snapshot
rather than a constant. `scan({ cwd, paths: ['lib'] })` returns **6 files and 16
findings**. The 85 is expected, not a bug: 56 of them are the rule table stored as data —
`test/scan-rules.test.mjs` (40) and `lib/scan-rules.js` (16). Of the remaining 29: 10 are the fixtures under
`test/fixtures/scan/`, 17 come from the four other test files that assert on findings (`scan.test` 11,
`scan-tool` 3, `scan-command` 2, `scan-core` 1), 1 from `audit/repro/security/scan-containment.mjs` and 1
from `data/guides.json`. The two `dot-directory` skips are `.github` at the root and the `.hidden` fixture
directory the ignore tests need. No finding here is truncated and none is lost: 109 hits land in 85 findings
because eleven of them are runs holding 35 hits between them.

Three releases moved these numbers, and no move was a regression:

- **0.7.1** took Markdown out of the allowlist, so findings went 73 → 82. While `.md` was allowlisted the
  200-file cap was consumed by `data/guides/*.md` (208 files, 66 findings already), so the walk never
  reached `lib/` or `test/`. Removing prose made the scan the size of the code.
- **0.7.2** stopped entering dot-directories and added an ignore file, so the same probe then reported 70
  files and 97 findings. Both deltas were inside `test/`, not in shipped code: two more scanned files
  (`test/scan-ignore.test.mjs` and the `artifacts/page.html` fixture the ignore tests need) and 15 more
  findings, of which 1 was that fixture file and 14 were marker-bearing lines added to three existing test
  files as the new cases were written (`scan.test` 6 → 12, `scan-tool` 2 → 6, `scan-command` 1 → 5).
  `.git`, `.agents` and `.tmp` are still not walked — they were in `skipDirectories` before there was a
  `dot-directory` rule — and nothing inside `.github` is read at all any more.
- **0.8.0** made a finding a code site, so the same tree reports **85** findings from the same 70 files. The
  97 became 85 because neighbouring hits of one rule collapsed, not because anything was fixed: ten runs
  absorbed 17 hits, and `lib` went 18 → 16 the same way. The number is a property of this tree, not a target:
  it moves whenever a test adds a marker line, which is why it is quoted with the command that measured it.

## `index.js` — the fourth tool

Registered exactly like the three existing tools (`ctx.tools.register(tool)` inside `ctx.effect`):

- `name: 'web_guidance_legacy_scan'`
- `parameters`: `{ type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 512 } }, rules: { type: 'array', maxItems: allRuleIds.length, items: { type: 'string', maxLength: 40 } }, format: { type: 'string', enum: ['summary', 'json'] } }, required: ['paths'], additionalProperties: false }` — the `rules` cap is the rule table's own length (33 since 0.6.0), not a fixed number.
- `output: { schema: { type: 'object' }, render: renderScan }`
- `execute(args, exec)`: `signal` check, then

  ```js
  const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
  const selected = selectRules(args?.rules)
  if (selected.unknown.length > 0) return { error: 'unknown-rules', unknown: selected.unknown, rules: allIds }
  const result = await scan({ cwd, paths: args?.paths, rules: selected.rules, signal: exec?.signal })
  return { format: args?.format === 'json' ? 'json' : 'summary', cwd, ...result }
  ```

- A `ScanError` is caught and returned as `{ error: error.code, subject: error.subject, message: error.message }`
  **with `isError`-shaped rendering**: `renderScan` prints `Error: <code> — <message>` and the model-facing
  text says what to pass instead (`relative paths inside the session workspace`). Throwing is reserved for
  real bugs.
- `renderScan(args, value)` returns `textBlock([...])`: one summary line
  (`Scanned 12 file(s) (48 kB) — 0 finding(s).`), then — only when something was skipped —
  `Skipped 279 path(s): 277 extension, 2 dot-directory`, counted over `scanned.skippedTotal` and ordered by
  count descending then name, so the same scan always renders the same line. It says **`path(s)`**, not
  `file(s)`, because a skipped directory is one entry rather than its contents. Then, apart from that line
  and never counted in it: `Ignored 1 line in .scanignore (line 7: bad pattern)` for malformed patterns, and
  with several the numbers are listed — `Ignored 2 lines in .scanignore (lines 7, 9: bad pattern)` — plus
  `Could not read .scanignore; the scan ran without ignore patterns.` for an unreadable file. Then at most 20
  findings as
  `- path:line:col ruleId (confidence) message`, then a guide-count line, then the truncation note.
  `format: 'json'` renders `JSON.stringify(value, null, 2)`. The renderer signature is `(args, value)`, the
  same shape `renderRetrieve` uses, because the host calls it that way when the tool runs.
- `classifyCall` in `lib/telemetry.js` gains the `legacy-scan` kind: `web_guidance_legacy_scan` counts under
  `tools['legacy-scan']`, with `scanned` files as the entry's `files` number and the finding count
  reported in the panel as a new column.

## `index.js` — the `/guidance-scan` command (0.7.0)

The human twin of the tool. It exists because the panel can execute commands and nothing else, and it is
not a second scanner: it calls the same `runScanRequest` and renders with the same `renderScan`, joined
into one string.

```text
/guidance-scan <paths> [--rules ls-01,ls-13] [--format summary|json]
```

- **Paths are positional**, comma- or space-separated. No path at all is a usage mistake, not a scan of
  the workspace: the command answers one sentence with an example (`Pass at least one relative path, for
  example /guidance-scan src/app.js, because the command never scans the whole workspace on its own.`)
  and never falls back to `.`. That answer is not counted as a call.
- Both flags accept `--flag value` and `--flag=value`. A flag left without a value is dropped rather
  than read as a path, so `--rules` alone cannot turn into a `path-absolute` refusal.
- `--rules` is a comma-separated id list resolved by `selectRules`; `--format` only picks the rendering
  and defaults to `summary`.
- **The command validates nothing itself.** Absolute, escaping and missing paths are refused by
  `lib/scan.js` with the same codes the tool returns — `path-absolute`, `path-outside`, `path-missing` —
  and unknown rule ids are refused with `unknown-rules` plus the valid span, rendered by `renderScan`
  exactly as the tool renders them. The command's result kind is `error` for a usage mistake or a refused
  scan, and `success` otherwise.
- **JSON contract**: with `--format json` the command prints `JSON.stringify(value, null, 2)` of the
  value `runScanRequest` returned — `{ format: 'json', cwd, scanned, findings, guides, truncated }` —
  i.e. the tool's own value, not a re-serialisation of it. A refusal is rendered as text even when
  `--format json` is passed, because `renderScan` answers the `error` branch before the `format` branch:
  a refused scan never masquerades as a scan that found nothing.
- **Registration**: the command is registered beside the tools, not with the counters, so it exists
  whether or not telemetry is on. `enabled: false` keeps `/guidance-scan` and it still scans and still
  prints; `/guidance-stats` is the one that disappears.
- **Counting**: a command scan is a scan. Both surfaces record through one `createUsageRecorder`, with
  the same tool name and the same `classifyCall` entry, so `byTool`, `byOutcome`, the daily bucket,
  `scanRules`, `scanGuides` and `lastScan` move identically. A refusal is counted as an error call and
  leaves `lastScan` alone, exactly as a refused tool call does. Nobody reading the counters can tell
  which surface started the scan; that is the contract, not an accident. With the counters off the
  recorder's sink is a no-op, so the command runs and records nothing.

## `lastScan` — the stored scan summary (0.7.3)

`stats.json` keeps one scan summary, so the report and the panel can say what the last scan did without
re-running it. Six keys, and `version` stays `1` — the two new fields are additive:

```js
lastScan: {
  at: '2026-11-10T21:26:09.000Z',                    // ISO 8601, replaced by every completed scan
  files: 70,
  findings: 85,
  rules: ['ls-13', 'ls-21'],                         // distinct ids, capped for display
  skipped: { extension: 281, 'dot-directory': 2 },   // top FOUR reasons, count desc then name
  truncated: false,                                  // true when the run stopped at any cap
}
```

- **Written only by a completed scan** — outcome `findings` or `clean`. A refusal (`error`) leaves the
  previous `lastScan` untouched, on the tool and on the command alike, so the counters never claim a scan
  that did not happen.
- **`skipped` is a reduction, and its sum can be smaller than the scan's own total.** The map keeps the
  **top four** reasons (count descending, then name ascending; zero and negative counts dropped; `{}` when
  nothing was skipped, never a map of zeros), while one run can skip for up to eight reasons. With five or
  more, the printed `skipped N (…)` sums only what the state kept and is therefore lower than
  `scanned.skippedTotal`. Measured: the map `{ extension: 100, binary: 50, large: 20, scanignore: 9,
  unreadable: 1 }` is stored as four rows summing to **179** while the scan's own total was **180**. That is
  the contract, not a bug: the state document is a summary, and the fresh scan result — the panel's button,
  the chat row, the tool's own text — carries every reason and its own `Skipped N path(s)` total.
- **`truncated` is a fact about that run, not about the project.** It is true when the scan stopped at
  **any** cap — files, bytes or findings (`payload.truncated === true || scanned.truncated === true`).
- **An old state file upgrades silently.** A 0.7.2 document has neither field: `skipped` reads as `{}` and
  `truncated` as `false`, so the first report after upgrading renders the shorter line — no `skipped 0`,
  no invented `truncated` — and the next completed scan rewrites the file with six keys. No migration
  step, no `version` bump, nothing to run by hand. Malformed values are dropped in the same spirit: a
  `lastScan` whose `at` the state reader cannot parse is dropped and reads as `null` — the report then omits
  its `Last scan:` line rather than printing "unknown" — and non-numeric counts read as zero.
- **`prune` is unchanged**: it still nulls only a stale `lastScan`. The lifetime counters, `scanRules`,
  `scanGuides` and `reset` behave exactly as in 0.7.0.

The text tails are fixed strings, one per surface, and the panel keys below are named so this contract and
`client.js` cannot drift. Measured, not paraphrased — `renderReport` with a six-key `lastScan` prints:

```text
Last scan: 2026-11-10, 70 files, 85 findings (rules: ls-13); skipped 284 (282 extension, 2 dot-directory)
```

- report text — that line: the date, two counts, then ` (rules: …)` (up to five ids, omitted when none),
  then `; skipped N (…)` when the map is non-empty, then `; truncated` when the flag is set. The `N` is the
  sum of the stored map, so it obeys the top-four caveat above.
- panel, last-scan line — `Last scan: 2026-11-10 · 70 files · 85 findings · skipped 284`, built
  from `scanner.last`, `file`/`finding` plurals, `scanner.skipped` and `scanner.cut`, joined with ` · `; the
  date is the `YYYY-MM-DD` part, and each later fact is omitted when absent.
- panel, button result — `Scanned 70 files, 85 findings` (`scan.summary`) then `Skipped 284 (282 extension,
  2 dot-directory)` (`scan.skipped`), with at most **three** reasons named and `+N more` (`scan.skippedMore`)
  inside the parentheses beyond that; its count is the fresh scan's own total. Truncation reuses the 0.7.0
  string `scan.truncated` — `Truncated: the scan hit a cap, so this list is incomplete.` — so there is no
  fifth key.
- chat tool row — the same `Skipped …` line under the table, for a JSON **and** a summary answer: the
  summary format prints `Skipped 284 path(s): 282 extension, 2 dot-directory` as prose and the row parses
  that line back, so one reader serves both formats.
- Reason tokens are **never translated**, on any of those surfaces: `dot-directory` stays `dot-directory`
  in EN, RU and ZH, exactly as a rule id stays `ls-13`. They are values a reader matches against a scan,
  not UI words.

## Stats, report and panel

- `lib/telemetry.js`: the kind map grows to four (`search`, `retrieve`, `list`, `legacy-scan`). A call that
  errors is still counted, with `isError: true`.
- `lib/report.js`: the report gains `tools['legacy-scan']` and a `findings` total; the summary line keeps
  working when the fourth counter is zero (older state files).
- `client.js`: three new dictionary keys in `EN`, `RU` and `ZH` (`stats.legacyScan`, `stats.findings`,
  `tool.legacyScan`) — key order and placeholders identical, `test/client-locales.test.mjs` enforces it —
  and the KPI row shows the fourth tool plus the finding count.
- **0.7.3 — both caveats on every surface.** `lib/report.js` passes `skipped` and `truncated` through with
  the `{}` / `false` defaults and appends the two tails described above, and the panel reads the same
  fields in three places: the button result (`scan.summary` → `scan.skipped` → `scan.truncated`), the
  last-scan line (`scanner.last` → `scanner.skipped` → `scanner.cut`) and the chat tool row, which adds
  the skip line under its table for JSON and summary answers alike. Four new keys per language —
  `scan.skipped`, `scan.skippedMore`, `scanner.skipped`, `scanner.cut` — and the fifth string is the
  existing `scan.truncated`. No path and no snippet appears on any of the three: these are counters, and
  the chat table is where files and lines belong.
- **0.9.0 — a counter explains itself.** `renderJson(snapshot, { rules, guides })` joins the rule table
  and the catalog onto the ranked counters: `topRules` becomes `{ ruleId, count, message, confidence,
  guideId }` and `topScanGuides` becomes `{ guideId, count, description }`, both described by a new
  top-level `scanCountsScope: 'lifetime'` — the ranked counters are lifetime totals that `periodDays`
  never filtered. Everything is additive and defensive: an id the table or the catalog no longer knows
  keeps its row and reads as `''` (and `null` for `guideId`), because its count is still true. Called
  with **no options** `renderJson` emits exactly the 0.8.x document, byte for byte, so an older consumer
  cannot tell the enrichment exists; `/guidance-stats --json` always passes both tables, so the command
  and the panel always get the described rows.

- **0.10.0 — scan counters are per workspace.** `stats.json` gains an additive `workspaces` subtree while
  `version` stays `1` (a bump would erase the file), one bucket per workspace holding `name`, `since`,
  `scanRules`, `scanGuides` and `lastScan`. Counters written before this release stay at the root and are
  surfaced as `_unattributed`. `classifyCall()` adds `workspacePath` (the raw `value.cwd`) for scans only,
  `snapshot({ days, workspace })` selects a bucket, and `/guidance-stats` grows `--workspace` and `--all`.
  The scanner itself is untouched: the same `runScanRequest`, the same findings, the same caps. Shapes:
  [workspace-attribution-contract.md](workspace-attribution-contract.md).

## Release

`0.5.0`. `package.json` version, `docs/releases/v0.5.0.md` in house style, the three READMEs (tool tables,
"Which tool when", FAQ, counter names, the honest limits of a regex scan), `AGENTS.md`, `GLOSSARY.md`,
`PUBLISHING.md` test count, `audit/security.md` (new read surface: explicit paths, containment, caps,
report-only) and one `audit/repro/` entry that reproduces the containment refusal.
