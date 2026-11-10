# `legacy-scan` contract for 0.5.0

Authoritative interface the four 0.5.0 workstreams code against. Written by the Lead before the work
split, so the modules can be written in parallel without guessing each other's shapes. Rationale and
the upstream analysis live in [legacy-scan-feasibility.md](legacy-scan-feasibility.md).

Revised in 0.7.1: `.md` and `.mdx` left the extension allowlist, so prose is now skipped rather than
scanned — see the allowlist under `lib/scan.js` and the self-scan caveat below. Everything else below is
unchanged.

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
   followed. **Markdown is prose, not code**: `.md` and `.mdx` are not in the allowlist (0.7.1), so every
   Markdown file met while walking is skipped with `reason: 'extension'` and counted in `skippedTotal`,
   and a `.md` path named **explicitly** gets that same skip instead of an error — the answer "this is
   documentation, I did not read it" is the useful one, and a report on a project whose only defect is
   its prose must come back empty rather than full of quoted anti-patterns.
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

## What a self-scan looks like (measured on this tree, 0.7.1)

This repository stores the rule table, so a scan of it reports the rule table's own markers as findings.
`scan({ cwd, paths: ['.'] })` here returns **68 files scanned, 82 findings, 0 of them in Markdown,
`truncated: false`**, with `skippedTotal: 277` (100 of those entries returned, which is the cap). That is
expected, not a bug: 61 of the 82 are `lib/scan-rules.js` (18) and `test/scan-rules.test.mjs` (43), where
every marker lives as data. Of the remaining 21: 9 are the fixtures under `test/fixtures/scan/`, 10 come
from four other test files that assert on findings, 1 from `audit/repro/security/scan-containment.mjs`,
and 1 from `data/guides.json`.

The count went **up** in 0.7.1 — 73 findings to 82 — for a reason worth keeping in mind when reading any
scan of this repo: while `.md` was allowlisted, the 200-file cap was consumed by `data/guides/*.md` (208
files, 66 findings already), so the walk never reached `lib/` or `test/`. Removing prose from the
allowlist did not make the code worse; it made the scan the size of the code.

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
- `renderScan(args, value)` returns `textBlock([...])`: one summary line (`Scanned 12 files (48 kB) — 0 findings;
  3 files skipped.`, counting `scanned.skippedTotal` when present), then at most 20 findings as
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
