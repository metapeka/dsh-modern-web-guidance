# `legacy-scan` contract for 0.5.0

Authoritative interface the four 0.5.0 workstreams code against. Written by the Lead before the work
split, so the modules can be written in parallel without guessing each other's shapes. Rationale and
the upstream analysis live in [legacy-scan-feasibility.md](legacy-scan-feasibility.md).

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
    '.json', '.md', '.mdx',
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
  scanned: { files: number, bytes: number, skipped: { path: string, reason: 'outside'|'large'|'binary'|'extension'|'unreadable'|'too-many' }[], skippedTotal: number, truncated: boolean },
  findings: { path: string, line: number, column: number, ruleId: string, guideId: string | null, confidence: string, message: string, snippet: string }[],
  guides: { id: string, findings: number }[],
  truncated: boolean,
}
```

`skipped` is capped at `maxSkipped` entries and ordered by discovery; `skippedTotal` counts every skip,
so a directory of a thousand assets cannot turn the `json` format into a thousand-line dump while the
summary still tells the truth. Both counts are always consistent: `skippedTotal >= skipped.length`.

Rules of the road:

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
   directories whose name is in `skipDirectories` are not entered at all. Symlinked directories are not
   followed.
6. Per file: `stat` first; larger than `maxFileBytes` → `reason: 'large'`. Reading uses one `readFile`
   per file; a NUL byte inside the first 8000 bytes → `reason: 'binary'`. An unreadable file is skipped
   with `reason: 'unreadable'`, never fatal.
7. Totals: `maxFiles` files scanned or `maxTotalBytes` read → stop walking, `scanned.truncated = true`.
8. Matching: for each line, each selected rule's compiled regex; `lastIndex` reset before every line;
   only the first match per rule per line produces a finding (one finding per `ruleId + path + line`).
   `line` and `column` are 1-based, `column` is the match offset in the line.
9. `snippet` is the line with leading and trailing whitespace trimmed, then clipped to
   `maxSnippetChars` with a trailing `…` when it had to shrink. Control characters other than tab are
   replaced with `\u0000`-style escapes so a report cannot smuggle terminal control bytes.
10. Ordering: `path` ascending, then `line`, then `column`, then `ruleId`. `maxFindings` is a hard cap on
    the returned array; hitting it sets both `findings` length to the cap and `truncated = true`.
11. `guides` is the per-guide count over the **returned** findings, ordered by `findings` descending then
    `id` ascending; rules with a null `guideId` are excluded. `signal.aborted` →
    `ScanError('cancelled')` is **not** used: throw the abort reason itself (`signal.throwIfAborted()`)
    so the host renders it as a cancellation.

## `index.js` — the fourth tool

Registered exactly like the three existing tools (`ctx.tools.register(tool)` inside `ctx.effect`):

- `name: 'web_guidance_legacy_scan'`
- `parameters`: `{ type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 512 } }, rules: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } }, format: { type: 'string', enum: ['summary', 'json'] } }, required: ['paths'], additionalProperties: false }`
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
- `renderScan(args, value)` returns `textBlock([...])`: one summary line (`Scanned 12 files (48 kB) — 0 findings;
  3 files skipped.`, counting `scanned.skippedTotal` when present), then at most 20 findings as
  `- path:line:col ruleId (confidence) message`, then a guide-count line, then the truncation note.
  `format: 'json'` renders `JSON.stringify(value, null, 2)`. The renderer signature is `(args, value)`, the
  same shape `renderRetrieve` uses, because the host calls it that way when the tool runs.
- `classifyCall` in `lib/telemetry.js` gains the `legacy-scan` kind: `web_guidance_legacy_scan` counts under
  `tools['legacy-scan']`, with `scanned` files as the entry's `files` number and the finding count
  reported in the panel as a new column.

## Stats, report and panel

- `lib/telemetry.js`: the kind map grows to four (`search`, `retrieve`, `list`, `legacy-scan`). A call that
  errors is still counted, with `isError: true`.
- `lib/report.js`: the report gains `tools['legacy-scan']` and a `findings` total; the summary line keeps
  working when the fourth counter is zero (older state files).
- `client.js`: three new dictionary keys in `EN`, `RU` and `ZH` (`stats.legacyScan`, `stats.findings`,
  `tool.legacyScan`) — key order and placeholders identical, `test/client-locales.test.mjs` enforces it —
  and the KPI row shows the fourth tool plus the finding count.

## Release

`0.5.0`. `package.json` version, `docs/releases/v0.5.0.md` in house style, the three READMEs (tool tables,
"Which tool when", FAQ, counter names, the honest limits of a regex scan), `AGENTS.md`, `GLOSSARY.md`,
`PUBLISHING.md` test count, `audit/security.md` (new read surface: explicit paths, containment, caps,
report-only) and one `audit/repro/` entry that reproduces the containment refusal.
