/**
 * The `legacy-scan` core: validate explicit paths, walk them inside the workspace, and match
 * marker rules line by line.
 *
 * This is a marker scanner, not an analyzer. A rule is a RegExp source matched against one line,
 * so a hit says "this legacy marker appears here", never "this code is wrong". Upstream's scanner
 * is not reusable for the same reason: its detectors run over a bundled TypeScript compiler's AST
 * (see `docs/notes/legacy-scan-feasibility.md`). `docs/notes/legacy-scan-contract.md` is the
 * specification this module implements.
 *
 * Read-only by construction: the module imports `node:fs/promises` for `stat`, `readFile`,
 * `readdir` and `realpath` — never a write, a spawn or a socket. It opens only the paths the caller
 * names, only inside `realpath(cwd)`, only allowlisted code extensions, only up to fixed caps.
 *
 * Two things are refused before a byte is read. A directory whose name starts with `.` is never
 * entered — build output, scraped dumps and agent scratch space live there — and is skipped as
 * `dot-directory` whether the walk meets it or the caller names it. A path covered by `.scanignore`
 * is skipped as `scanignore`, files and directory subtrees alike.
 *
 * `.scanignore` is the one file the scanner reads without being asked. Its grammar is exactly this
 * subset, no more:
 *
 *   - The file is read as UTF-8; a leading BOM is dropped and CRLF is read as LF.
 *   - One pattern per line. A line whose first non-space character is `#` is a comment. A line that
 *     is empty after trimming is ignored. Every other line, trimmed, is one pattern.
 *   - A pattern of one segment matches that name at any depth: `report/` skips every directory
 *     called `report`, `*.min.js` skips every file ending that way. A pattern with a `/` inside it is
 *     anchored at the workspace root and matched against the whole workspace-relative POSIX path:
 *     `src/app.js` matches that file and nothing else. A leading `/` is allowed and ignored: every
 *     pattern is already relative to the workspace root.
 *   - A trailing `/` makes a directory pattern: it matches a directory only, and a match skips the
 *     whole subtree. Without the slash a pattern matches a file or a directory of that name.
 *   - `*` matches any run of characters inside one path segment and never crosses `/`. Everything
 *     else is literal: there is no negation, no `**`, no `?`, no character class, no escaping.
 *   - A line outside that subset is malformed. It is not an error: the scan continues and the line
 *     is reported in `scanned.ignoreProblems` as `{ line, reason: 'malformed' }`. A `.scanignore`
 *     that cannot be read is reported as `{ line: null, reason: 'unreadable' }`, and the scan runs
 *     without patterns. Neither ever aborts a scan, and neither is a file skip: `skipped`,
 *     `skippedTotal` and `skippedByReason` count files only, so their arithmetic stays true.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { RULES } from './scan-rules.js'

/**
 * Extension allowlist: source files where a line-by-line marker means something.
 *
 * Prose is deliberately absent. Markdown is documentation, and a Markdown file that *quotes* an
 * anti-pattern is not legacy code to modernize — allowlisting `.md`/`.mdx` made a clean project
 * report dozens of findings about its own README. Anything not listed is skipped with reason
 * `extension`, so the walk still says it saw the file.
 */
const EXTENSIONS = Object.freeze([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro',
  '.json',
])

/** Directory names never entered: noise, generated output, or the harness's own scratch space. */
const SKIP_DIRECTORIES = Object.freeze([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'vendor', 'target',
  '__pycache__', '.venv', 'venv', '.tmp', '.agents',
])

/** The ignore file the scanner looks for at the workspace root; its grammar is above. */
const SCAN_IGNORE_FILE = '.scanignore'

/** At most this many `.scanignore` diagnostics come back: a broken file cannot flood a report. */
const MAX_IGNORE_PROBLEMS = 20

/**
 * Two hits of one rule collapse into one finding while their line numbers differ by at most this,
 * which is "the next line" or "one blank line apart". A block of hits on neighbouring lines is one
 * thing a reader changes, not one thing per line; a wider gap means a new code site.
 */
const RUN_LINE_GAP = 2

/**
 * Hard caps for one scan. Frozen so a caller cannot widen them by mutating the table; the
 * `limits` argument may only tighten a numeric cap (see {@link scan}).
 */
export const SCAN_LIMITS = Object.freeze({
  maxPaths: 16,
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFindings: 200,
  maxSkipped: 100,
  maxSnippetChars: 160,
  extensions: EXTENSIONS,
  skipDirectories: SKIP_DIRECTORIES,
})

/** Numeric caps a caller may tighten through `limits`; arrays are replaced wholesale. */
const NUMERIC_LIMITS = Object.freeze([
  'maxPaths', 'maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxFindings', 'maxSkipped', 'maxSnippetChars',
])

/** Array caps a caller may replace through `limits`. */
const LIST_LIMITS = Object.freeze(['extensions', 'skipDirectories'])

/**
 * A refused scan request: a programming error in the tool call, not a failed file read.
 *
 * `code` is what the tool returns as `{ error }`; `subject` is the path or rule id the message is
 * about, when there is one. File-level problems never throw — they become `scanned.skipped` entries.
 */
export class ScanError extends Error {
  /**
   * @param {'paths' | 'path-absolute' | 'path-outside' | 'path-missing' | 'path-unreadable' | 'rules' | 'limits'} code
   * @param {string} [subject] the offending path or rule id
   * @param {string} [message] the model-facing explanation, naming what to pass instead
   */
  constructor(code, subject = '', message = '') {
    super(message || code)
    this.name = 'ScanError'
    this.code = code
    this.subject = subject
  }
}

/** Lexicographic ordering that does not depend on the host locale. */
function compare(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Report paths with forward slashes on every platform, so a report reads the same everywhere. */
function toPosix(value) {
  return sep === '/' ? value : value.split(sep).join('/')
}

/**
 * The workspace-relative form of `target`, or `null` when it is outside.
 *
 * Containment is a separator-aware prefix test: equal paths count as inside, and only a `..`
 * segment (or a different drive, which `relative` reports as absolute on Windows) is outside.
 */
function insideOf(realCwd, target) {
  const rel = relative(realCwd, target)
  if (rel === '') return ''
  if (isAbsolute(rel)) return null
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null
  return toPosix(rel)
}

/** Absolute-looking paths are refused before touching the filesystem, so typos stay visible. */
function looksAbsolute(value) {
  return value.startsWith('/')
    || value.startsWith('\\')
    || value.startsWith('~')
    || /^[A-Za-z]:/.test(value)
}

/** `signal.aborted` must surface as the host's own cancellation, so throw its reason untouched. */
function checkAbort(signal) {
  if (signal === undefined || signal === null || !signal.aborted) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  throw signal.reason instanceof Error ? signal.reason : new Error('The scan was cancelled.')
}

/**
 * Validate `limits`: numeric caps may only tighten the built-in ones, arrays are replaced.
 *
 * @param {object | undefined} limits
 * @returns {typeof SCAN_LIMITS} the effective caps
 */
function mergeLimits(limits) {
  if (limits === undefined || limits === null) return SCAN_LIMITS
  if (typeof limits !== 'object' || Array.isArray(limits)) {
    throw new ScanError('limits', '', 'Pass limits as an object such as { maxFiles: 20 }.')
  }

  const known = new Set([...NUMERIC_LIMITS, ...LIST_LIMITS])
  for (const key of Object.keys(limits)) {
    if (!known.has(key)) {
      throw new ScanError('limits', key, `Unknown limit "${key}"; the scanner knows ${[...known].join(', ')}.`)
    }
  }

  const active = { ...SCAN_LIMITS }
  for (const key of NUMERIC_LIMITS) {
    if (limits[key] === undefined) continue
    const value = limits[key]
    if (!Number.isInteger(value) || value <= 0) {
      throw new ScanError('limits', key, `limits.${key} must be a positive integer.`)
    }
    if (value > SCAN_LIMITS[key]) {
      throw new ScanError('limits', key, `limits.${key} may only tighten the built-in cap of ${SCAN_LIMITS[key]}.`)
    }
    active[key] = value
  }
  for (const key of LIST_LIMITS) {
    if (limits[key] === undefined) continue
    const value = limits[key]
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
      throw new ScanError('limits', key, `limits.${key} must be an array of non-empty strings.`)
    }
    active[key] = value
  }
  return active
}

/**
 * Validate `paths`: a non-empty array of relative path strings, at most `maxPaths` of them.
 *
 * @param {unknown} paths
 * @param {number} maxPaths
 * @returns {string[]} the paths, verbatim
 */
function validatePathsArgument(paths, maxPaths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ScanError('paths', '', `Pass one to ${maxPaths} explicit relative paths (files or directories) inside the session workspace.`)
  }
  if (paths.length > maxPaths) {
    throw new ScanError('paths', '', `Pass at most ${maxPaths} paths per call (got ${paths.length}).`)
  }

  for (const value of paths) {
    if (typeof value !== 'string') {
      throw new ScanError('paths', String(value), 'Every path must be a string.')
    }
    if (value === '' || value.includes('\u0000')) {
      throw new ScanError('paths', value, 'Pass a non-empty path without NUL bytes.')
    }
    if (looksAbsolute(value)) {
      throw new ScanError(
        'path-absolute',
        value,
        `"${value}" is absolute; pass it relative to the session workspace instead.`,
      )
    }
  }

  return [...paths]
}

/**
 * Compile and normalise the selected rules. One compiled regex per rule, ids deduped so
 * `one finding per ruleId + path + line` holds even if a caller passes the same rule twice.
 *
 * @param {unknown} rules
 * @returns {{ rule: { id: string, guideId: string | null, confidence: string, message: string }, regex: RegExp }[]}
 */
function compileRules(rules) {
  if (!Array.isArray(rules)) {
    throw new ScanError('rules', '', 'Pass the selected rules as an array; resolve ids with selectRules().')
  }

  const compiled = []
  const seen = new Set()

  for (const [index, rule] of rules.entries()) {
    if (rule === null || typeof rule !== 'object') {
      throw new ScanError('rules', `#${index}`, 'Every rule must be an object with an id, source and message.')
    }
    const { id, source, guideId = null, confidence = 'medium', message = '' } = rule
    if (typeof id !== 'string' || id === '') {
      throw new ScanError('rules', `#${index}`, 'Every rule needs a non-empty string id.')
    }
    if (seen.has(id)) continue
    if (typeof source !== 'string' || source === '') {
      throw new ScanError('rules', id, `Rule "${id}" needs a non-empty source string.`)
    }
    if (guideId !== null && typeof guideId !== 'string') {
      throw new ScanError('rules', id, `Rule "${id}" has a guideId that is neither a string nor null.`)
    }
    if (typeof confidence !== 'string' || typeof message !== 'string') {
      throw new ScanError('rules', id, `Rule "${id}" needs a string confidence and message.`)
    }

    seen.add(id)
    try {
      compiled.push({ rule: { id, guideId, confidence, message }, regex: new RegExp(source, 'g') })
    } catch {
      throw new ScanError('rules', id, `Rule "${id}" does not compile as a regular expression.`)
    }
  }

  return compiled.sort((left, right) => compare(left.rule.id, right.rule.id))
}

/** The allowlist applies to the file actually opened, so a symlink cannot smuggle another suffix. */
function isAllowedExtension(realPath, extensions) {
  return extensions.includes(extname(realPath).toLowerCase())
}

/** Escape one literal character for a RegExp; `*` stays with the caller because it is the wildcard. */
function escapeRegExpCharacter(character) {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character
}

/**
 * Compile one trimmed, non-empty `.scanignore` line, or `null` when it is outside the grammar.
 *
 * One anchored RegExp per path segment: `*` is the only wildcard, and it cannot cross a `/` because
 * segments are compiled and matched separately.
 *
 * @param {string} line
 * @returns {{ source: string, segments: RegExp[], directoriesOnly: boolean } | null}
 */
function compileIgnorePattern(line) {
  // A leading slash only says "from the workspace root", which every pattern already means.
  let body = line.startsWith('/') ? line.slice(1) : line
  const directoriesOnly = body.endsWith('/')
  if (directoriesOnly) body = body.slice(0, -1)
  if (body === '' || body.startsWith('!')) return null
  // `**`, `?`, a character class, a backslash or a NUL are all outside the documented subset, and
  // guessing at them would hide the guess. A malformed line is reported instead (see the header).
  if (body.includes('**') || body.includes('?') || /[\\[\]\u0000]/.test(body)) return null

  const segments = body.split('/')
  if (segments.some((segment) => segment === '')) return null

  return {
    source: line,
    directoriesOnly,
    segments: segments.map((segment) => {
      const source = [...segment]
        .map((character) => (character === '*' ? '.*' : escapeRegExpCharacter(character)))
        .join('')
      return new RegExp(`^${source}$`)
    }),
  }
}

/**
 * Parse `.scanignore` text into patterns and diagnostics.
 *
 * Exported because the grammar has to be unit-tested directly: a scan only reaches it through the
 * workspace file, and the parser is the part whose edge cases are worth pinning.
 *
 * @param {string} text
 * @returns {{
 *   patterns: { source: string, segments: RegExp[], directoriesOnly: boolean }[],
 *   problems: { line: number, reason: string }[],
 * }} `problems` carry a 1-based line number; a scan reports their count, never their text
 */
export function parseScanIgnore(text) {
  const patterns = []
  const problems = []
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const pattern = compileIgnorePattern(line)
    if (pattern === null) {
      problems.push({ line: index + 1, reason: 'malformed' })
      continue
    }
    patterns.push(pattern)
  }
  return { patterns, problems }
}

/**
 * Does one parsed `.scanignore` cover this workspace-relative path?
 *
 * Only the path itself is asked about, never its ancestors: the walk prunes an ignored directory
 * before descending, and the scan repeats the question for every ancestor when the caller names a
 * path deep inside one.
 *
 * @param {{ patterns: { segments: RegExp[], directoriesOnly: boolean }[] }} ignore
 * @param {string} relativePath forward-slash path relative to the workspace root
 * @param {boolean} isDirectory
 * @returns {boolean}
 */
export function matchesScanIgnore(ignore, relativePath, isDirectory) {
  if (relativePath === '' || ignore.patterns.length === 0) return false
  const segments = relativePath.split('/')
  for (const pattern of ignore.patterns) {
    if (pattern.directoriesOnly && !isDirectory) continue
    if (pattern.segments.length === 1) {
      // A one-segment pattern matches that name at any depth, the way `.gitignore` reads, so a nested
      // artifact directory cannot hide from a plain name the caller wrote.
      const [matcher] = pattern.segments
      if (segments.some((segment) => matcher.test(segment))) return true
      continue
    }
    // More than one segment means the pattern is a path from the workspace root, and every segment
    // has to line up: `*` never crosses a `/`, so there is no depth-independent form.
    if (pattern.segments.length !== segments.length) continue
    let matched = true
    for (const [index, matcher] of pattern.segments.entries()) {
      if (!matcher.test(segments[index])) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/**
 * Read `<cwd>/.scanignore`, if there is one.
 *
 * A missing file is the normal case: no patterns, no diagnostics. Anything else that goes wrong
 * (permissions, a directory of that name) is reported once and the scan runs without patterns,
 * because an unreadable ignore file must never break a scan.
 *
 * @param {string} realCwd resolved workspace root
 * @param {(line: number | null, reason: string) => void} recordProblem
 * @returns {Promise<{ patterns: object[], problems: { line: number, reason: string }[] }>} the parsed file or an empty one
 */
async function readScanIgnore(realCwd, recordProblem) {
  let text
  try {
    text = await readFile(join(realCwd, SCAN_IGNORE_FILE), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') recordProblem(null, 'unreadable')
    return { patterns: [], problems: [] }
  }
  const parsed = parseScanIgnore(text)
  for (const problem of parsed.problems) recordProblem(problem.line, problem.reason)
  return parsed
}

/** Decode one file: strip a UTF-8 BOM and normalise line endings before matching. */
function decodeText(buffer) {
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n?/g, '\n')
}

/** `\u0007`-style escapes for C0/C1 controls, so a snippet cannot smuggle terminal bytes. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * One-line snippet: trimmed, control characters escaped, then clipped to `maxChars` with a
 * trailing `…` when it had to shrink. Escaping happens before clipping so no raw control byte can
 * survive a clip boundary, and the ellipsis counts toward the cap.
 */
function makeSnippet(line, maxChars) {
  const escaped = line.trim().replace(CONTROL_CHARACTERS, (character) => {
    return `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
  })
  if (escaped.length <= maxChars) return escaped
  return `${escaped.slice(0, maxChars - 1)}…`
}

/** Per-guide counts over the findings actually returned, null guide ids excluded. */
function summarizeGuides(findings) {
  const counts = new Map()
  for (const finding of findings) {
    if (finding.guideId === null) continue
    counts.set(finding.guideId, (counts.get(finding.guideId) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, findings: count }))
    .sort((left, right) => right.findings - left.findings || compare(left.id, right.id))
}

/**
 * Scan explicit paths inside `cwd` for legacy markers.
 *
 * `paths` must be relative to `cwd`; there is no default target and no glob expansion. Paths are
 * resolved with `realpath` and must stay inside `realpath(cwd)` — a named path that resolves
 * outside is refused (`path-outside`), while a symlink found *during* a walk is skipped as
 * `outside` instead of aborting the scan. Everything read is capped by {@link SCAN_LIMITS}: file
 * count, per-file and total bytes, findings, snippet length. Nothing is written.
 *
 * Result paths are canonical and cwd-relative with forward slashes (`src/app.js`). Findings are
 * ordered by path, line, column, rule id; enumeration is sorted first, so the `maxFindings` cap
 * keeps the lexicographically first findings and `truncated` is honest. `scanned.skipped` is capped
 * at `maxSkipped` entries while `scanned.skippedTotal` and `scanned.skippedByReason` count every
 * skip, per reason, so a truncated sample still explains itself. `.scanignore` diagnostics are not
 * skips and live apart in `scanned.ignoreProblems`.
 *
 * A run of one rule's hits in one file on the next line or one blank line later is one finding, not
 * one per line: a block of repeated code is a single thing to change. The finding keeps the first
 * hit's `line`, `column`, `snippet` and the rule's own `message`, and carries the whole range as
 * `lines`, with `occurrences` equal to its length — always present, `1` for an uncollapsed hit, so
 * every consumer has one shape. Runs never cross a file, a rule, or a gap wider than one line, and
 * `maxFindings` caps runs rather than hits.
 *
 * @param {object} options
 * @param {string} [options.cwd] directory the paths resolve against; defaults to `process.cwd()`
 * @param {string[]} options.paths explicit relative files or directories
 * @param {readonly object[]} [options.rules] selected rules; defaults to the whole table
 * @param {AbortSignal} [options.signal] aborts during enumeration and between files; its reason is thrown untouched
 * @param {object} [options.limits] caps that may only tighten {@link SCAN_LIMITS}
 * @returns {Promise<{
 *   scanned: {
 *     files: number,
 *     bytes: number,
 *     skipped: { path: string, reason: string }[],
 *     skippedTotal: number,
 *     skippedByReason: Record<string, number>,
 *     ignoreProblems: { line: number | null, reason: string }[],
 *     truncated: boolean,
 *   },
 *   findings: { path: string, line: number, column: number, ruleId: string, guideId: string | null, confidence: string, message: string, snippet: string, lines: number[], occurrences: number }[],
 *   guides: { id: string, findings: number }[],
 *   truncated: boolean,
 * }>}
 */
export async function scan({ cwd, paths, rules = RULES, signal, limits } = {}) {
  checkAbort(signal)
  const active = mergeLimits(limits)
  const givenPaths = validatePathsArgument(paths, active.maxPaths)
  const compiled = compileRules(rules)

  const requestedCwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  let realCwd
  try {
    realCwd = await realpath(resolve(requestedCwd))
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'path-missing' : 'path-unreadable'
    throw new ScanError(code, requestedCwd, `The working directory "${requestedCwd}" cannot be resolved.`)
  }

  // Rule 3 of the contract: a *named* path that escapes the workspace is an error, unlike a
  // symlink met while walking (rule 3, second sentence), which is a skip.
  const roots = []
  for (const given of givenPaths) {
    let real
    try {
      real = await realpath(resolve(realCwd, given))
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'path-missing' : 'path-unreadable'
      throw new ScanError(code, given, `"${given}" does not exist or cannot be read; check the spelling or pass its parent directory.`)
    }
    const rel = insideOf(realCwd, real)
    if (rel === null) {
      throw new ScanError(
        'path-outside',
        given,
        `"${given}" resolves outside the session workspace; the scanner only reads inside it.`,
      )
    }
    roots.push({ real, rel })
  }

  const skipped = []
  const skippedByReason = {}
  const ignoreProblems = []
  const candidates = []
  const seenFiles = new Set()
  const visitedDirs = new Set()
  let skippedTotal = 0
  let scanTruncated = false

  /**
   * Record one skipped file or directory. `skipped` is a capped sample of `maxSkipped` entries so a
   * directory full of assets cannot flood the response; `skippedTotal` and `skippedByReason` count
   * every skip, so the report can still say what the walk refused after the sample truncates.
   */
  function recordSkip(path, reason) {
    skippedTotal += 1
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1
    if (skipped.length < active.maxSkipped) skipped.push({ path, reason })
  }

  /** Record one `.scanignore` diagnostic. It is not a file skip, so the skip counters stay honest. */
  function recordIgnoreProblem(line, reason) {
    if (ignoreProblems.length < MAX_IGNORE_PROBLEMS) ignoreProblems.push({ line, reason })
  }

  const ignore = await readScanIgnore(realCwd, recordIgnoreProblem)

  /**
   * Why a path is refused before it is read, or `null`.
   *
   * A dot-directory segment refuses the path whether the walk meets it or the caller names it, so
   * `paths: ['.firecrawl']` and `paths: ['.firecrawl/page.html']` say the same thing as the walk
   * would. `.scanignore` covers the path itself and every ancestor, so naming a file inside an
   * ignored directory is ignored too instead of being read behind the ignore file's back.
   */
  function skipReasonForPath(relativePath, isDirectory) {
    if (relativePath === '') return null
    const segments = relativePath.split('/')
    const directories = isDirectory ? segments : segments.slice(0, -1)
    if (directories.some((segment) => segment.startsWith('.'))) return 'dot-directory'
    for (let end = segments.length; end >= 1; end -= 1) {
      const prefix = segments.slice(0, end).join('/')
      const prefixIsDirectory = end < segments.length || isDirectory
      if (matchesScanIgnore(ignore, prefix, prefixIsDirectory)) return 'scanignore'
    }
    return null
  }

  /** Add one file to the work list; `false` means a cap stopped enumeration. */
  function addCandidate(absolute, reportPath) {
    // The ignore file wins over the allowlist: a caller who excluded a path does not want it read
    // for any reason, not even to report its extension.
    if (matchesScanIgnore(ignore, reportPath, false)) {
      recordSkip(reportPath, 'scanignore')
      return true
    }
    if (!isAllowedExtension(absolute, active.extensions)) {
      recordSkip(reportPath, 'extension')
      return true
    }
    if (seenFiles.has(absolute)) return true
    if (candidates.length >= active.maxFiles) {
      scanTruncated = true
      recordSkip(reportPath, 'too-many')
      return false
    }
    seenFiles.add(absolute)
    candidates.push({ absolute, path: reportPath })
    return true
  }

  /** Walk one named root. Returns `false` when enumeration must stop. */
  async function walk(realRoot, rootRel) {
    const rootPath = rootRel === '' ? '.' : rootRel
    let info
    try {
      info = await stat(realRoot)
    } catch {
      recordSkip(rootPath, 'unreadable')
      return true
    }
    if (info.isFile()) {
      const refusal = skipReasonForPath(rootRel, false)
      if (refusal !== null) {
        recordSkip(rootPath, refusal)
        return true
      }
      return addCandidate(realRoot, rootPath)
    }
    if (!info.isDirectory()) {
      recordSkip(rootPath, 'unreadable')
      return true
    }
    // A named dot-directory or an ignored one is skipped as a whole, exactly as the walk would.
    const refusal = skipReasonForPath(rootRel, true)
    if (refusal !== null) {
      recordSkip(rootPath, refusal)
      return true
    }

    const stack = [{ absolute: realRoot, path: rootRel }]
    while (stack.length > 0) {
      checkAbort(signal)
      const directory = stack.pop()
      if (visitedDirs.has(directory.absolute)) continue
      visitedDirs.add(directory.absolute)

      let entries
      try {
        entries = await readdir(directory.absolute, { withFileTypes: true })
      } catch {
        recordSkip(directory.path === '' ? '.' : directory.path, 'unreadable')
        continue
      }
      entries.sort((left, right) => compare(left.name, right.name))

      const subdirectories = []
      for (const entry of entries) {
        const absolute = join(directory.absolute, entry.name)
        const reportPath = directory.path === '' ? entry.name : `${directory.path}/${entry.name}`

        if (entry.isDirectory()) {
          if (active.skipDirectories.includes(entry.name)) continue
          // Dot-directories are where build output and scraped dumps hide; one skip entry for the
          // directory itself, never one per file inside it.
          if (entry.name.startsWith('.')) {
            recordSkip(reportPath, 'dot-directory')
            continue
          }
          if (matchesScanIgnore(ignore, reportPath, true)) {
            recordSkip(reportPath, 'scanignore')
            continue
          }
          subdirectories.push({ absolute, path: reportPath })
          continue
        }
        if (entry.isFile()) {
          if (!addCandidate(absolute, reportPath)) return false
          continue
        }
        if (!entry.isSymbolicLink()) continue

        let target
        try {
          target = await realpath(absolute)
        } catch {
          recordSkip(reportPath, 'unreadable')
          continue
        }
        if (insideOf(realCwd, target) === null) {
          recordSkip(reportPath, 'outside')
          continue
        }
        let targetInfo
        try {
          targetInfo = await stat(target)
        } catch {
          recordSkip(reportPath, 'unreadable')
          continue
        }
        // Symlinked directories are deliberately not entered, even inside the workspace: they can
        // form cycles, and the contract says the walk does not follow them. A dot name is still
        // reported, so the reason a path was not read is the same whichever kind of entry it is.
        if (targetInfo.isDirectory()) {
          if (entry.name.startsWith('.')) recordSkip(reportPath, 'dot-directory')
          continue
        }
        if (targetInfo.isFile() && !addCandidate(target, reportPath)) return false
      }

      // Depth-first in sorted order, so the first path over a cap is deterministic.
      for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
        stack.push(subdirectories[index])
      }
    }
    return true
  }

  for (const root of roots) {
    if (!(await walk(root.real, root.rel))) break
  }

  // Enumeration order decides which files win the caps; sorting it makes findings and the finding
  // cap deterministic no matter how the roots were listed.
  candidates.sort((left, right) => compare(left.path, right.path))

  const findings = []
  let files = 0
  let bytes = 0
  let findingsTruncated = false

  scanFiles: for (const candidate of candidates) {
    checkAbort(signal)

    let info
    try {
      info = await stat(candidate.absolute)
    } catch {
      recordSkip(candidate.path, 'unreadable')
      continue
    }
    if (!info.isFile()) {
      recordSkip(candidate.path, 'unreadable')
      continue
    }
    if (info.size > active.maxFileBytes) {
      recordSkip(candidate.path, 'large')
      continue
    }
    if (bytes + info.size > active.maxTotalBytes) {
      scanTruncated = true
      recordSkip(candidate.path, 'too-many')
      break
    }

    let buffer
    try {
      buffer = await readFile(candidate.absolute)
    } catch {
      recordSkip(candidate.path, 'unreadable')
      continue
    }
    // The file may have grown between `stat` and `readFile`; re-check the caps on what we hold.
    if (buffer.length > active.maxFileBytes) {
      recordSkip(candidate.path, 'large')
      continue
    }
    if (bytes + buffer.length > active.maxTotalBytes) {
      scanTruncated = true
      recordSkip(candidate.path, 'too-many')
      break
    }
    // A NUL byte in the first 8 000 bytes is the binary heuristic the tool documents.
    if (buffer.subarray(0, 8000).includes(0)) {
      recordSkip(candidate.path, 'binary')
      continue
    }

    files += 1
    bytes += buffer.length

    const lines = decodeText(buffer).split('\n')
    // Hits from one rule on neighbouring lines are one code site, so a file is assembled into runs
    // first, and only runs — findings — are capped and returned.
    const runsByRule = new Map()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === '') continue

      // One hit per rule per line: only the first match, at its offset in the line.
      const hits = []
      for (const { rule, regex } of compiled) {
        regex.lastIndex = 0
        const match = regex.exec(line)
        if (match === null || match[0].length === 0) continue
        hits.push({ rule, column: match.index + 1 })
      }
      if (hits.length === 0) continue

      const snippet = makeSnippet(line, active.maxSnippetChars)
      hits.sort((left, right) => left.column - right.column || compare(left.rule.id, right.rule.id))
      for (const hit of hits) {
        const lineNumber = index + 1
        const runs = runsByRule.get(hit.rule.id)
        const open = runs === undefined ? undefined : runs[runs.length - 1]
        // Close enough to continue the open run: the next line, or one blank line later.
        if (open !== undefined && lineNumber - open.lines[open.lines.length - 1] <= RUN_LINE_GAP) {
          open.lines.push(lineNumber)
          open.occurrences += 1
          continue
        }
        const finding = {
          path: candidate.path,
          line: lineNumber,
          column: hit.column,
          ruleId: hit.rule.id,
          guideId: hit.rule.guideId,
          confidence: hit.rule.confidence,
          message: hit.rule.message,
          snippet,
          lines: [lineNumber],
          occurrences: 1,
        }
        if (runs === undefined) runsByRule.set(hit.rule.id, [finding])
        else runs.push(finding)
      }
    }

    // Report order inside a file: first line, then column, then rule id.
    const fileFindings = [...runsByRule.values()].flat()
    fileFindings.sort((left, right) =>
      left.line - right.line || left.column - right.column || compare(left.ruleId, right.ruleId))
    for (const finding of fileFindings) {
      findings.push(finding)
      if (findings.length >= active.maxFindings) {
        findingsTruncated = true
        break scanFiles
      }
    }
  }

  return {
    scanned: {
      files,
      bytes,
      skipped,
      skippedTotal,
      skippedByReason,
      ignoreProblems,
      truncated: scanTruncated,
    },
    findings,
    guides: summarizeGuides(findings),
    truncated: scanTruncated || findingsTruncated,
  }
}
