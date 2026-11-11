/**
 * dsh-modern-web-guidance — Google Chrome's modern web platform guidance for DSH agents.
 *
 * Registers two skills (`modern-web-guidance`, `chrome-extensions`) and four offline
 * tools: three that search and load the bundled guide corpus, plus `web_guidance_legacy_scan`,
 * a marker scanner that points legacy patterns in the caller's own files at the guide that
 * replaces them. Everything runs locally: the plugin ships its data, never calls the network,
 * and contains no telemetry. The scanner reads only the relative paths it is given and never
 * leaves the session workspace.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGuidance } from './lib/guidance.js'
import { renderJson, renderReport, workspaceLabel } from './lib/report.js'
import { RULES, selectRules } from './lib/scan-rules.js'
import { ScanError, parseScanIgnore, scan } from './lib/scan.js'
import {
  clampReason,
  isSiteKey,
  MAX_SUPPRESSIONS,
  MAX_SUPPRESS_BYTES,
  parseSuppressions,
  serializeSuppressions,
  SUPPRESS_FILE,
} from './lib/suppress.js'
import { createFileStore, defaultStatePath } from './lib/store.js'
import { branchLabel, classifyCall, createTelemetry, workspaceId } from './lib/telemetry.js'

const here = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(here, 'data')
const SKILLS_DIR = join(DATA_DIR, 'skills')

const SEARCH_DESCRIPTION = [
  "Search Google Chrome's Modern Web Guidance catalog: 208 curated, token-efficient guides covering modern browser",
  'APIs and web best practices (dialogs, popovers, anchor positioning, container queries, view transitions,',
  'scroll-driven effects, forms and autofill, accessibility, passkeys, security, performance metrics such as LCP/INP/CLS,',
  'image and script prioritization, WebAssembly, built-in AI, WebMCP).',
  'Call this before writing HTML, CSS, or client-side JavaScript so the implementation uses the current platform instead of',
  'legacy patterns from training data. Queries are 2-5 action-oriented words about ONE capability, e.g. "light dismiss dialog",',
  '"responsive data table", "dark mode toggle", "anchor positioning". Omit framework names and app-specific nouns.',
  'Returns matching guide ids with descriptions; load the chosen ones with web_guidance_retrieve.',
].join(' ')

const RETRIEVE_DESCRIPTION = [
  'Load the full text of one or more Modern Web Guidance guides by id (ids come from web_guidance_search).',
  'Pass a comma-separated string or an array. Each guide is a complete markdown implementation guide with code,',
  'fallback policy, and Baseline compatibility notes. Retrieve the specific use-case guide plus any broader discipline',
  'guide that applies (html, css, forms, accessibility, performance, security).',
  'A guide whose platform feature is an Origin Trial or a volatile (single-engine) feature opens with a short',
  'experimental warning banner: respect it and confirm availability before relying on that API.',
].join(' ')

const LIST_DESCRIPTION = [
  'Browse the Modern Web Guidance catalog without a search query: returns guide counts per category, or the guide ids,',
  'titles and short descriptions for one category (css, ui-behaviors, ui-atoms, ui-components, forms, html, js,',
  'accessibility, visual-design, security, performance, built-in-ai, pwa, wasm, webmcp, privacy, user-experience).',
  'Use it when search phrasing did not match and you want to see what the catalog covers.',
].join(' ')

/**
 * The scanner's model-facing description. The rule count is interpolated rather than written
 * out: the table grows, and a hand-written number would quietly start lying about its width.
 * @param {number} ruleCount how many rules the table carries.
 * @returns {string} the description the tool registers with.
 */
function scanDescription(ruleCount) {
  return [
    'Scan the files you name for legacy web-platform patterns (jQuery-era DOM helpers, execCommand, document.write,',
    'deprecated APIs) and map every finding to the Modern Web Guidance guide that replaces it. Pass 1-16 relative paths',
    'inside the session workspace: directories are walked, and the scan stops at 200 files, 512 kB per file and 8 MB',
    `total. This is a line-based marker scanner over ${ruleCount} rules, not an AST analyzer, so treat each finding as a lead and`,
    'load the guide with web_guidance_retrieve before changing code. Report-only: it never writes, never spawns a',
    'process and never touches the network.',
  ].join(' ')
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

function renderSearch(args, value) {
  const results = Array.isArray(value?.results) ? value.results : []
  if (results.length === 0) {
    return textBlock([
      `No guide matched "${String(args?.query ?? '')}".`,
      'Try different wording (2-5 words, one capability per query), or call web_guidance_list to inspect the catalog.',
    ].join('\n'))
  }
  const lines = results.map((hit) => {
    const marker = hit.experimental === true ? ' [experimental]' : ''
    return `- ${hit.id}${marker} (${hit.category}): ${hit.title} — ${hit.description}`
  })
  return textBlock([
    `${results.length} matching guide(s) for "${String(args?.query ?? '')}":`,
    ...lines,
    'Load the relevant ones with web_guidance_retrieve before writing code.',
  ].join('\n'))
}

function renderRetrieve(_args, value) {
  const parts = []
  for (const guide of value?.guides ?? []) {
    parts.push(`--- Guide for ${guide.id} ---\n\n${guide.content.trim()}`)
  }
  const unknown = value?.unknown ?? []
  const unknownCount = Number(value?.unknownCount ?? unknown.length)
  if (unknown.length > 0) {
    const more = unknownCount > unknown.length ? ` (and ${unknownCount - unknown.length} more)` : ''
    parts.push(`Unknown guide id(s): ${unknown.join(', ')}${more}. Use web_guidance_search or web_guidance_list to find valid ids.`)
  }
  const skipped = value?.skipped ?? []
  if (skipped.length > 0) {
    // The bounds come from the retrieve payload (lib/guidance.js constants), never from a literal
    // copy here: a second source of truth would silently drift from what the tool enforces.
    const limits = value?.limits ?? {}
    const bounds = []
    if (Number.isFinite(limits.maxGuides)) bounds.push(`${limits.maxGuides} guides`)
    if (Number.isFinite(limits.maxChars)) bounds.push(`${Math.round(limits.maxChars / 1000)}k characters`)
    const limitText = bounds.length > 0 ? ` (limit: ${bounds.join(' / ')})` : ''
    parts.push([
      `Not returned in this call${limitText}:`,
      `${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? `, and ${skipped.length - 10} more` : ''}.`,
      'Request them in a separate call if you still need them.',
    ].join(' '))
  }
  if (parts.length === 0) parts.push('No guide content was returned.')
  return textBlock(parts.join('\n\n'))
}

function renderList(args, value) {
  const categories = value?.categories ?? []
  if (Array.isArray(value?.guides)) {
    if (value.guides.length === 0) {
      const known = categories.length > 0 ? `Known categories: ${categories.join(', ')}.` : ''
      return textBlock(`No guide has category "${String(args?.category ?? '')}". ${known}`.trim())
    }
    const lines = value.guides.map((guide) => `- ${guide.id}: ${guide.title} — ${guide.description}`)
    return textBlock([
      `${value.guides.length} guide(s) in category "${String(value.category ?? args?.category ?? '')}":`,
      ...lines,
    ].join('\n'))
  }
  const lines = categories.map((row) => `- ${row.category}: ${row.count} guide(s)`)
  return textBlock([
    `${value?.total ?? 0} guides in the Modern Web Guidance catalog:`,
    ...lines,
    'Call web_guidance_list with a category, or web_guidance_search with a capability query.',
  ].join('\n'))
}

/** How many findings and guides one rendered scan shows before it summarises the rest. */
const SCAN_RENDER_LIMIT = { findings: 20, guides: 12 }

/** Bytes as the short figure a report reads better with: `48 kB`, `1.7 MB`. */
function formatBytes(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The id range a report quotes as "valid ids run …". Derived from the tool's own rule list so a
 * new rule cannot leave a stale span in the text.
 * @param {readonly string[]} ids rule ids in table order.
 * @returns {string} `ls-01 … ls-33`, or an empty string when the list is empty.
 */
function ruleSpan(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return ''
  return `${ids[0]} … ${ids[ids.length - 1]}`
}

/** Fallback id list for a rendered refusal that arrived without one: the shipped table. */
const ALL_RULE_IDS = RULES.map((rule) => rule.id)

function renderScan(_args, value, ruleIds = ALL_RULE_IDS) {
  // A refusal is rendered as a result: the model needs the code and what to pass instead, not a stack.
  if (value?.error !== undefined) {
    if (value.error === 'unknown-rules') {
      const unknown = Array.isArray(value.unknown) ? value.unknown : []
      const ids = Array.isArray(value.rules) && value.rules.length > 0 ? value.rules : ruleIds
      const span = ruleSpan(ids)
      return textBlock([
        `Error: unknown-rules — unknown rule id(s): ${unknown.join(', ')}.`,
        `Valid ids run ${span}. Omit "rules" to apply every rule.`,
      ].join('\n'))
    }
    return textBlock([
      `Error: ${String(value.error)} — ${String(value.message ?? 'the scan could not run')}`,
      'Pass relative paths inside the session workspace; the scanner never resolves a path outside it.',
    ].join('\n'))
  }

  if (value?.format === 'json') return textBlock(JSON.stringify(value, null, 2))

  const scanned = value?.scanned ?? {}
  const findings = Array.isArray(value?.findings) ? value.findings : []
  const guides = Array.isArray(value?.guides) ? value.guides : []
  const files = Number(scanned.files) || 0
  // `skipped` is a capped sample, `skippedTotal` is the count. Prefer the count so a directory of a
  // thousand assets reads as "1000 skipped" instead of "100 skipped", which is what the array holds.
  const skipped = Number.isFinite(scanned.skippedTotal)
    ? Number(scanned.skippedTotal)
    : Array.isArray(scanned.skipped) ? scanned.skipped.length : 0
  const summary = `Scanned ${files} file(s) (${formatBytes(scanned.bytes)}) — ${findings.length} finding(s)`
  // The muted count rides on the summary only when it is positive, as the result's own number or —
  // for a hand-built value without one — the flags on the findings. It is a subset of the count
  // before it, never a subtraction from it: "85 findings, 3 suppressed" says three of the 85 are
  // muted and still findings, which is exactly what the counters' diff refuses to call a fix.
  const flagged = findings.filter((finding) => finding.suppressed === true).length
  const suppressed = Number.isFinite(value?.suppressed) ? Math.max(0, Math.floor(value.suppressed)) : flagged
  const lines = [`${summary}${suppressed > 0 ? `, ${suppressed} suppressed` : ''}.`]

  // Why the walk refused what it refused, counted per reason. `skipped` here is `skippedTotal`, not
  // the capped sample, so the number is true even when the sample truncated. Ordering is count desc
  // then name, so the same scan always renders the same line.
  if (skipped > 0) {
    const byReason = scanned.skippedByReason
    const counted = byReason !== null && typeof byReason === 'object'
      ? Object.entries(byReason)
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      : []
    lines.push(counted.length > 0
      ? `Skipped ${skipped} path(s): ${counted.map(([reason, count]) => `${count} ${reason}`).join(', ')}`
      : `Skipped ${skipped} path(s).`)
  }

  // `.scanignore` diagnostics are not file skips, so they are worded apart from the line above.
  const ignoreProblems = Array.isArray(scanned.ignoreProblems) ? scanned.ignoreProblems : []
  const badLines = ignoreProblems.filter((problem) => Number.isInteger(problem.line)).map((problem) => problem.line)
  if (badLines.length > 0) {
    const single = badLines.length === 1
    const which = single ? `line ${badLines[0]}` : `lines ${badLines.join(', ')}`
    lines.push(`Ignored ${badLines.length} ${single ? 'line' : 'lines'} in .scanignore (${which}: bad pattern)`)
  }
  if (ignoreProblems.some((problem) => !Number.isInteger(problem.line))) {
    lines.push('Could not read .scanignore; the scan ran without ignore patterns.')
  }

  // `.suppress` diagnostics, also not file skips. The file-level token prints raw like a skip reason —
  // a reader checks it against the contract's four (`unreadable`, `too-large`, `malformed`, `version`)
  // rather than against a translated phrase — and the entry-level line only counts what was dropped,
  // because "the rest applied" is the reassuring half and has to be true for the sentence to be used.
  const suppressProblems = Array.isArray(value?.suppressProblems) ? value.suppressProblems : []
  const fileProblem = suppressProblems.find((problem) => problem !== null && typeof problem === 'object' && problem.key === null)
  if (fileProblem !== undefined) {
    lines.push(`Suppression file: ${String(fileProblem.reason)}; nothing is muted this scan.`)
  }
  const ignoredEntries = suppressProblems.filter((problem) => problem !== null && typeof problem === 'object'
    && typeof problem.key === 'string').length
  if (ignoredEntries > 0) {
    lines.push(
      `Suppression file: ${ignoredEntries} ${ignoredEntries === 1 ? 'entry' : 'entries'} ignored; the rest applied.`,
    )
  }

  if (findings.length === 0) {
    lines.push('No rule in the table matched. That is not proof of modern code: the scanner works line by line and sees markers, not behaviour.')
  } else {
    for (const finding of findings.slice(0, SCAN_RENDER_LIMIT.findings)) {
      // A collapsed run prints its range; a single hit keeps the exact `path:line:column` it always
      // had. A run whose lines skip one prints the count too, because `110-112` alone would claim
      // three hits where there are two.
      const first = finding.lines[0]
      const last = finding.lines[finding.lines.length - 1]
      const dense = last - first + 1 === finding.lines.length
      const location = finding.occurrences > 1 && finding.lines.length > 1
        ? `${finding.path}:${first}-${last}${dense ? '' : ` (${finding.occurrences} hits)`}`
        : `${finding.path}:${finding.line}:${finding.column}`
      const muted = finding.suppressed === true ? ' (suppressed)' : ''
      lines.push(`- ${location} ${finding.ruleId} (${finding.confidence}) ${finding.message}${muted}`)
    }
    if (findings.length > SCAN_RENDER_LIMIT.findings) {
      lines.push(`… and ${findings.length - SCAN_RENDER_LIMIT.findings} more finding(s).`)
    }
  }

  if (guides.length > 0) {
    const shown = guides.slice(0, SCAN_RENDER_LIMIT.guides).map((guide) => `${guide.id} (${guide.findings})`)
    const rest = guides.length - shown.length
    const more = rest > 0 ? `, and ${rest} more` : ''
    lines.push(`Load with web_guidance_retrieve: ${shown.join(', ')}${more}.`)
  } else if (findings.length > 0) {
    lines.push('No guide id is attached to these findings.')
  }

  if (value?.truncated === true) {
    // The caps themselves are not repeated here: they live in lib/scan.js, and a literal copy in the
    // renderer would silently drift from what the scanner actually enforces.
    lines.push('Truncated: the scan stopped at one of its caps, so these findings are incomplete. Narrow the paths or the rules.')
  }

  return textBlock(lines.join('\n'))
}

function buildSearchTool(guidance) {
  return {
    name: 'web_guidance_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description: '2-5 action-oriented words describing one web capability, e.g. "light dismiss dialog".',
        },
        limit: { type: 'number', minimum: 1, maximum: 25, description: 'Maximum results, 1-25. Default 8.' },
        category: { type: 'string', maxLength: 40, description: 'Optional category filter, e.g. "css" or "ui-behaviors".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderSearch },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const results = await guidance.search(args?.query, {
        limit: args?.limit,
        category: args?.category,
      })
      return { query: String(args?.query ?? ''), results }
    },
  }
}

function buildRetrieveTool(guidance) {
  return {
    name: 'web_guidance_retrieve',
    description: RETRIEVE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        ids: {
          oneOf: [
            { type: 'string', maxLength: 900, description: 'One id, or several ids joined by commas.' },
            { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 80 }, description: 'Guide ids to load.' },
          ],
          description: 'Guide id(s) returned by web_guidance_search. One call returns at most 10 guides; request more in another call.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderRetrieve },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return guidance.retrieve(args?.ids)
    },
  }
}

function buildListTool(guidance) {
  return {
    name: 'web_guidance_list',
    description: LIST_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', maxLength: 40, description: 'Category to list. Omit for per-category counts.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderList },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const requested = typeof args?.category === 'string' ? args.category.trim() : ''
      const all = await guidance.list({ category: requested })
      if (requested === '') {
        const counts = new Map()
        for (const guide of all) counts.set(guide.category, (counts.get(guide.category) ?? 0) + 1)
        const categories = [...counts.entries()]
          .map(([category, count]) => ({ category, count }))
          .sort((left, right) => left.category.localeCompare(right.category))
        return { total: all.length, categories }
      }
      if (all.length === 0) {
        // A wrong or misspelled category should not look like an empty catalog.
        const known = [...new Set((await guidance.list({})).map((guide) => guide.category))].sort()
        return { category: requested, guides: [], categories: known }
      }
      return {
        category: String(args.category),
        guides: all.map((guide) => ({
          id: guide.id,
          title: guide.title,
          description: guide.description.length > 160 ? `${guide.description.slice(0, 157)}...` : guide.description,
        })),
      }
    },
  }
}

/**
 * Run one scan request and return the value the tool renders.
 *
 * This is the single place a refusal becomes a value instead of a throw: the model-facing tool and
 * the human command read the same shape and print the same text. Nothing here re-implements a path
 * check — resolution, containment and every cap belong to `lib/scan.js`, and its `ScanError` codes
 * are passed through verbatim.
 *
 * @param {{ scan: Function, ScanError: Function }} scanner the `lib/scan.js` module.
 * @param {{ RULES: readonly { id: string }[], selectRules: Function }} ruleSet the `lib/scan-rules.js` module.
 * @param {{ paths?: readonly string[], rules?: readonly string[], format?: string }} args the caller's arguments.
 * @param {string} cwd session workspace, already resolved by the caller.
 * @param {AbortSignal | undefined} signal optional cancellation.
 * @returns {Promise<object>} the tool's value, or an `{ error, subject, message }` refusal.
 */
async function runScanRequest(scanner, ruleSet, args, cwd, signal) {
  const allRuleIds = ruleSet.RULES.map((rule) => rule.id)
  const selected = ruleSet.selectRules(args?.rules)
  // Unknown ids are named back rather than thrown: a typo should cost one retry, and the scan
  // must not touch the filesystem at all when the rule set itself is wrong.
  if (selected.unknown.length > 0) {
    return { error: 'unknown-rules', unknown: selected.unknown, rules: allRuleIds }
  }
  try {
    const result = await scanner.scan({ cwd, paths: args?.paths, rules: selected.rules, signal })
    return { format: args?.format === 'json' ? 'json' : 'summary', cwd, ...result }
  } catch (error) {
    // A refusal (absolute path, escape, missing target, bad rule set) is an answer, not a crash.
    if (error instanceof scanner.ScanError) {
      return { error: error.code, subject: error.subject, message: error.message }
    }
    throw error
  }
}

/**
 * The fourth tool: an offline marker scanner over the caller's own files. The scanner and the rule
 * table arrive as arguments so this file states which implementations back the tool in one place
 * (`apply`), and a test can drive the tool without reaching into the modules directly.
 * @param {{ scan: Function, ScanError: Function }} scanner the `lib/scan.js` module.
 * @param {{ RULES: readonly { id: string }[], selectRules: Function }} ruleSet the `lib/scan-rules.js` module.
 * @returns {object} a tool definition.
 */
function buildScanTool(scanner, ruleSet) {
  const allRuleIds = ruleSet.RULES.map((rule) => rule.id)
  return {
    name: 'web_guidance_legacy_scan',
    description: scanDescription(allRuleIds.length),
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', maxLength: 512 },
        },
        rules: { type: 'array', maxItems: allRuleIds.length, items: { type: 'string', maxLength: 40 } },
        format: { type: 'string', enum: ['summary', 'json'] },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (args, value) => renderScan(args, value, allRuleIds) },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      return runScanRequest(scanner, ruleSet, args, cwd, exec?.signal)
    },
  }
}

/**
 * Parse a `/guidance-scan` line: `<paths> [--rules ls-01,ls-13] [--format summary|json]`.
 *
 * Paths are positional and comma-separated (spaces work too); both flags accept `--flag value` and
 * `--flag=value`. Nothing here validates a path — an absolute or escaping path is refused by
 * `lib/scan.js` with its own code, so this parser must not grow a second opinion about it.
 *
 * @param {string} line raw arguments after the command name.
 * @returns {{ paths: string[], rules: string[] | undefined, format: 'summary' | 'json' }}
 */
function parseScanArguments(line) {
  const text = String(line ?? '')
  const formatMatch = text.match(/--format(?:\s+|=)(\S+)/)
  const rulesMatch = text.match(/--rules(?:\s+|=)(\S+)/)
  const paths = text
    .replace(/--format(?:\s+|=)\S+/g, ' ')
    .replace(/--rules(?:\s+|=)\S+/g, ' ')
    .split(/[\s,]+/)
    .map((token) => token.trim())
    // A bare flag left over by a missing value is not a path, and must not become a path refusal.
    .filter((token) => token.length > 0 && !token.startsWith('--'))
  const rules = rulesMatch === null
    ? undefined
    : rulesMatch[1].split(',').map((id) => id.trim()).filter((id) => id.length > 0)
  return { paths, rules, format: formatMatch?.[1] === 'json' ? 'json' : 'summary' }
}

/**
 * The session workspace a command runs in. A tool reads `exec.agent.session.header.cwd`; a command
 * invocation carries the same session header, so the field is read the same way and falls back to
 * the process directory exactly as the tool does.
 * @param {object} invocation the command invocation the host hands the handler.
 * @returns {string} an absolute workspace path.
 */
function commandCwd(invocation) {
  const header = invocation?.agent?.session?.header ?? invocation?.session?.header
  return header?.cwd ?? process.cwd()
}

/**
 * The resolved directory a workspace id hashes, or null when the caller named no usable path.
 *
 * `realpathSync` only sharpens the string — a path that cannot be resolved (yet) still has an
 * identity — and the raw string is what gets hashed if it fails. `null` means "there is no usable
 * path", never "use the process directory": the report must be able to say it does not know which
 * project it is showing, and `process.cwd()` posed as the project is exactly the lie this helper
 * exists to prevent.
 *
 * @param {unknown} cwd the workspace path, as the host reported it.
 * @param {string} [base] where a relative path is read from — the command passes the session
 *   directory, so `--workspace ../other` never resolves against the plugin process's own directory.
 * @returns {string | null}
 */
function workspaceDirectory(cwd, base) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (raw === '') return null
  const target = base !== undefined && base !== '' && !isAbsolute(raw) ? join(base, raw) : raw
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

/** The stored shape of one already-resolved directory: a stable id and a directory name. */
function workspaceOfDirectory(directory) {
  return { id: workspaceId(directory), name: basename(directory) || 'workspace' }
}

/**
 * A workspace as the counters store it: a stable id and a directory name, never a path.
 *
 * The id hashes the resolved path, so two sessions in one checkout land in one bucket and a renamed
 * directory starts a new one. The raw string is what gets hashed when the path cannot be resolved,
 * which is why `workspaceDirectory` keeps that fallback in one place.
 *
 * @param {unknown} cwd the workspace path, as the host reported it.
 * @param {string} [base] where a relative path is read from.
 * @returns {{ id: string, name: string } | null}
 */
function resolveWorkspace(cwd, base) {
  const directory = workspaceDirectory(cwd, base)
  return directory === null ? null : workspaceOfDirectory(directory)
}

/** Longest a `.git` pointer or a `HEAD` file may be before it is refused unread, in bytes. */
const MAX_HEAD_BYTES = 1024

/** The one ref namespace a branch label comes from; every other namespace is no label. */
const HEADS_PREFIX = 'refs/heads/'

/** A detached `HEAD` holds a bare object id: 40 hex characters, or 64 for a wider hash. */
const DETACHED_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Read one small file, or null. The size is checked before the read, so an oversized path costs a
 * `stat` rather than a read, and every failure — a missing file, a directory, a permission error, a
 * link loop — answers null instead of throwing.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readSmallFile(path) {
  try {
    if (statSync(path).size > MAX_HEAD_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The path of the `HEAD` file that belongs to a workspace, or null when there is no usable `.git`.
 *
 * `.git` is usually a directory, but a linked worktree makes it a one-line `gitdir: <path>` file
 * whose target may be absolute or relative to the workspace root. Exactly one hop is followed, and
 * nothing else about the repository is read.
 *
 * @param {string} workspacePath
 * @returns {string | null}
 */
function gitHeadPath(workspacePath) {
  const dotGit = join(workspacePath, '.git')
  let isDirectory
  try {
    isDirectory = statSync(dotGit).isDirectory()
  } catch {
    return null
  }
  if (isDirectory) return join(dotGit, 'HEAD')
  const pointer = readSmallFile(dotGit)
  if (typeof pointer !== 'string') return null
  const lines = pointer
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.trim() !== '')
  // A worktree pointer is one line. A file with more lines is not one, and guessing which line
  // matters is the enumeration this read deliberately does not do.
  if (lines.length !== 1) return null
  const line = lines[0]
  if (!line.startsWith('gitdir:')) return null
  const target = line.slice('gitdir:'.length).trim()
  if (target === '') return null
  return join(isAbsolute(target) ? target : join(workspacePath, target), 'HEAD')
}

/**
 * The single line of a HEAD file, or null when the file is not one line of text.
 * @param {unknown} content
 * @returns {string | null}
 */
function headLine(content) {
  if (typeof content !== 'string' || content === '') return null
  const line = content.endsWith('\n') ? content.slice(0, -1) : content
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line
  if (bare === '' || bare.includes('\n') || bare.includes('\r')) return null
  return bare
}

/**
 * Parse one HEAD file's text into a validated label, or null.
 *
 * `ref: refs/heads/<name>` is a branch, whether or not the ref resolves: verifying it would mean
 * reading `.git/refs` or `packed-refs`, which this read does not do. A bare object id is a detached
 * checkout, labelled by its first seven characters and never resolved. Everything else is silence.
 *
 * @param {unknown} content
 * @returns {{ kind: 'branch', name: string } | { kind: 'detached', sha: string } | null}
 */
function labelFromHead(content) {
  const line = headLine(content)
  if (line === null) return null
  if (line.startsWith('ref: ')) {
    const ref = line.slice('ref: '.length)
    if (!ref.startsWith(HEADS_PREFIX)) return null
    return branchLabel({ kind: 'branch', name: ref.slice(HEADS_PREFIX.length) })
  }
  if (DETACHED_HEAD.test(line)) return branchLabel({ kind: 'detached', sha: line.slice(0, 7) })
  return null
}

/**
 * The branch label a completed scan may carry, read from `<workspacePath>/.git/HEAD`.
 *
 * The read is deliberately tiny: one fixed path derived only from the resolved session workspace,
 * one hop through a worktree's `gitdir:` pointer, both files refused above 1 KiB, and no
 * enumeration, no subprocess and no other git file. Every failure — no repository, an unreadable
 * file, garbage content, a name the branch rule rejects — is silence: the caller records no label,
 * because a missing label costs one report suffix while a guessed one would be a lie.
 *
 * @param {string} workspacePath the resolved directory whose realpath produced the workspace id
 * @returns {{ kind: 'branch', name: string } | { kind: 'detached', sha: string } | null}
 */
export function readHeadLabel(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath === '') return null
  const headPath = gitHeadPath(workspacePath)
  if (headPath === null) return null
  return labelFromHead(readSmallFile(headPath))
}

/**
 * The workspace a command was invoked in, or `undefined` when the host handed it no session header.
 *
 * Deliberately header-only, unlike `commandCwd`: a scan needs a directory to resolve its relative
 * paths against, so it must fall back to something, while a report must be able to admit that the
 * project is unknown rather than attribute a profile's counters to the plugin's own directory.
 *
 * @param {object} invocation the command invocation the host hands the handler.
 * @returns {string | undefined} an absolute path, or undefined when the host named none.
 */
function sessionCwd(invocation) {
  const header = invocation?.agent?.session?.header ?? invocation?.session?.header
  const cwd = typeof header?.cwd === 'string' ? header.cwd.trim() : ''
  return cwd === '' ? undefined : cwd
}

/**
 * The text a command prints: exactly what the tool's renderer produces, joined into one string.
 * A second renderer would drift from the tool, and the panel parses this JSON — so the command
 * reuses `renderScan` rather than formatting findings itself.
 * @param {object} args the parsed command arguments.
 * @param {object} value the value `runScanRequest` returned.
 * @param {readonly string[]} ruleIds rule ids in table order, for the refusal hint.
 * @returns {string} the rendered result.
 */
function renderScanText(args, value, ruleIds) {
  return renderScan(args, value, ruleIds).map((block) => block.text).join('\n')
}

/**
 * The human command that runs the same scan the model gets from the tool. It exists because the
 * panel can execute commands and nothing else, so this is the only entry point a person has.
 * @param {{ scan: Function, ScanError: Function }} scanner the `lib/scan.js` module.
 * @param {{ RULES: readonly { id: string }[], selectRules: Function }} ruleSet the `lib/scan-rules.js` module.
 * @param {ReturnType<typeof createUsageRecorder>} usage the counters' recorder, a no-op while they are off.
 * @returns {object} a CommandDefinition.
 */
function buildScanCommand(scanner, ruleSet, usage) {
  const allRuleIds = ruleSet.RULES.map((rule) => rule.id)
  return {
    name: 'guidance-scan',
    description: 'Scan explicit workspace paths for legacy web-platform marker patterns and point every finding at the Modern Web Guidance guide that replaces it.',
    input: { hint: '<paths> [--rules ls-01,ls-13] [--format summary|json]' },
    recordInput: false,
    async handler(invocation) {
      const args = parseScanArguments(invocation?.rawInput)
      if (args.paths.length === 0) {
        // Never fall back to `.`: an unexpected walk over the whole workspace is worse than an error.
        // This is a usage mistake before any call, so it is not counted as one.
        return {
          kind: 'error',
          text: 'Pass at least one relative path, for example /guidance-scan src/app.js, because the command never scans the whole workspace on its own.',
        }
      }
      try {
        // Same pre-flight as the tool: an aborted call must not touch the filesystem.
        invocation?.signal?.throwIfAborted?.()
        const value = await runScanRequest(scanner, ruleSet, args, commandCwd(invocation), invocation?.signal)
        // A command scan is a scan: it goes through the same reporter the `tools/result` listener
        // uses, with the same tool name and the same payload, so the counters cannot tell the two
        // apart. A refusal arrives as a value with an `error` key, which the classifier counts as an
        // error call without touching `lastScan` — exactly as it does for a refused tool call.
        usage.record('web_guidance_legacy_scan', { paths: args.paths, rules: args.rules, format: args.format }, value, false)
        return {
          kind: value.error === undefined ? 'success' : 'error',
          text: renderScanText(args, value, allRuleIds),
        }
      } catch (error) {
        // A thrown scan is a failed call, counted the way a host-marked failed result is counted.
        usage.record('web_guidance_legacy_scan', { paths: args.paths, rules: args.rules, format: args.format }, undefined, true)
        // The scanner's own refusals already came back as values; this is the unexpected case.
        return { kind: 'error', text: `The scan could not run: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

/**
 * Parse a `/guidance-suppress` line: `<siteId> [--dry-run] [--reason <text>]`.
 *
 * The site id is positional and there is exactly one; `--dry-run` may appear anywhere; `--reason`
 * takes the rest of its token, quoted or not. Nothing here checks that the id names a real finding:
 * the id is a hash of a site the caller was shown, and the file only ever gains one key.
 *
 * @param {string} line raw arguments after the command name.
 * @returns {{ siteId: string, dryRun: boolean, reason: string }}
 */
function parseSuppressArguments(line) {
  const text = String(line ?? '')
  const dryRun = /(?:^|\s)--dry-run(?:\s|$)/.test(text)
  const reasonMatch = text.match(/--reason(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/)
  const siteId = text
    .replace(/(?:^|\s)--dry-run(?=\s|$)/g, ' ')
    .replace(/--reason(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+)/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !token.startsWith('--'))
    .join(' ')
  const reason = reasonMatch === null ? '' : clampReason(reasonMatch[1] ?? reasonMatch[2] ?? reasonMatch[3] ?? '')
  return { siteId, dryRun, reason }
}

/** Today's date as the suppression file records it: the day the mute was confirmed, in UTC. */
function suppressDate() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Read the suppression file for the one command that may extend it.
 *
 * Stricter than the scan's reader on purpose: a scan degrades to *more* findings and never repairs
 * anything, while a writer that parsed a broken file and serialised it again would delete entries the
 * user wrote. So any problem here is a refusal, and the file is left exactly as it is.
 *
 * @param {string} file absolute path of the workspace suppression file.
 * @returns {Promise<{ entries: Map<string, {reason: string, at: string}> } | { refusal: string, token: string }>}
 */
async function readSuppressionsForWrite(file) {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: new Map() }
    return { refusal: `Refused: ${file} could not be read.`, token: 'unreadable' }
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { refusal: `Refused: ${file} is not a regular file.`, token: 'unreadable' }
  }
  if (info.size > MAX_SUPPRESS_BYTES) {
    return { refusal: `Refused: ${file} is larger than the ${MAX_SUPPRESS_BYTES}-byte limit.`, token: 'too-large' }
  }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { refusal: `Refused: ${file} could not be read.`, token: 'unreadable' }
  }
  const parsed = parseSuppressions(text)
  const fileProblem = parsed.problems.find((problem) => problem.key === null)
  if (fileProblem !== undefined) {
    return {
      refusal: `Refused (${fileProblem.reason}): ${file} has to be fixed by hand before another entry can be added.`,
      token: fileProblem.reason,
    }
  }
  if (parsed.problems.length > 0) {
    const count = parsed.problems.length
    return {
      refusal: `Refused (invalid): ${file} has ${count} ${count === 1 ? 'entry' : 'entries'} that cannot be read; remove ${count === 1 ? 'it' : 'them'} by hand first.`,
      token: 'invalid',
    }
  }
  return { entries: parsed.entries }
}

/**
 * The human command that mutes one scanned site. It is the product's only writer, which is why it
 * has two forms: `--dry-run` prints the plan — the absolute file, the exact entry and the count —
 * and the same line without the flag applies it. The panel calls the first, shows it, and calls the
 * second only after a distinct confirmation, so no single action can write.
 *
 * Every outcome is a complete sentence the caller renders verbatim, and only a write that did not
 * happen reports `kind: 'error'`: an entry that is already there is a named no-op, not a failure.
 *
 * @returns {object} a CommandDefinition.
 */
function buildSuppressCommand() {
  return {
    name: 'guidance-suppress',
    description: 'Mute one code site by its siteId so later scans report it as suppressed instead of counting it as fixed. Shows the plan with --dry-run and writes only without it.',
    input: { hint: '<siteId> [--dry-run] [--reason <text>]' },
    recordInput: false,
    async handler(invocation) {
      const args = parseSuppressArguments(invocation?.rawInput)
      const id = args.siteId.trim().toLowerCase()
      if (id === '') {
        return {
          kind: 'error',
          text: 'No site id: pass the 8-character id a scan result shows after the rule id, for example /guidance-suppress 96cb61de --dry-run.',
        }
      }
      if (!isSiteKey(id)) {
        return {
          kind: 'error',
          text: `Not a site id: "${args.siteId}" must be 8 lowercase hex characters, exactly as a scan result prints it after the rule id.`,
        }
      }

      const directory = workspaceDirectory(commandCwd(invocation))
      const file = join(directory, SUPPRESS_FILE)
      const current = await readSuppressionsForWrite(file)
      if (!(current.entries instanceof Map)) {
        return { kind: 'error', text: current.refusal }
      }
      if (current.entries.has(id)) {
        return {
          kind: 'success',
          text: args.dryRun
            ? `Already present: ${id} is already in ${file}, so this line would write nothing.`
            : `Already present: ${id} is in ${file}; nothing was written.`,
        }
      }

      const entry = { reason: args.reason, at: suppressDate() }
      const count = current.entries.size
      // The plan is one paragraph rather than a block of labelled lines, because the panel renders the
      // host's text verbatim in a single node — a folded line there, a run-on sentence here — and both
      // surfaces must read the same. It carries the three facts ADR-0003 asks for: the absolute file,
      // the exact entry (reason and date included, so the confirmation is of a payload and not of an
      // intention) and the current count against the cap.
      const payload = JSON.stringify(entry)
      const full = count >= MAX_SUPPRESSIONS
      if (args.dryRun) {
        return {
          kind: 'success',
          text: full
            ? `Suppression plan for ${id}: append ${payload} to ${file}, which already holds the cap of ${MAX_SUPPRESSIONS} entries, so this write would be refused and nothing has been written.`
            : `Suppression plan for ${id}: append ${payload} to ${file}, which would go from ${count} to ${count + 1} ${count + 1 === 1 ? 'entry' : 'entries'} (cap ${MAX_SUPPRESSIONS}). Nothing has been written; run the same line without --dry-run to write it.`,
        }
      }
      if (full) {
        return {
          kind: 'error',
          text: `Refused: ${file} already holds the maximum of ${MAX_SUPPRESSIONS} entries; remove one before adding another.`,
        }
      }

      const entries = new Map(current.entries)
      entries.set(id, entry)
      const temporary = `${file}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(temporary, serializeSuppressions(entries), 'utf8')
        await rename(temporary, file)
      } catch (error) {
        return {
          kind: 'error',
          text: `Refused: the write to ${file} failed (${error instanceof Error ? error.message : String(error)}).`,
        }
      }
      return {
        kind: 'success',
        text: `Suppressed ${id} in ${file}; the file now holds ${count + 1} ${count + 1 === 1 ? 'entry' : 'entries'}. The site is muted, not fixed: the next scan still counts it as a finding and reports it as suppressed.`,
      }
    },
  }
}

/** The ignore file the scanner reads at the workspace root; its grammar is `lib/scan.js`'s header. */
const SCAN_IGNORE_FILE = '.scanignore'

/**
 * Split one command line into tokens.
 *
 * Whitespace separates tokens, `"..."` and `'...'` group one, and a backslash escapes the next
 * character inside a quoted token. A `.scanignore` pattern is a path, and a path can contain a space
 * or a quote, so a bare `split(/\s+/)` cannot carry it. The tokens are returned as written otherwise:
 * this function interprets nothing, and the handler decides what one pattern is.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitArguments(text) {
  const tokens = []
  let current = ''
  let quoted = null
  let escaped = false
  let started = false
  for (const character of text) {
    if (escaped) {
      current += character
      escaped = false
      started = true
      continue
    }
    if (quoted !== null) {
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === quoted) {
        quoted = null
        continue
      }
      current += character
      continue
    }
    if (character === '"' || character === "'") {
      quoted = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * Parse a `/guidance-scanignore` line: `<pattern> [--dry-run]`.
 *
 * The pattern is exactly one token and may be quoted, because a pattern is one line of the file and a
 * path may contain a space. Two tokens are two patterns, and this command adds one: joining them into
 * a line that matches nothing would be the silent write ADR-0003 forbids.
 *
 * @param {string} line raw arguments after the command name.
 * @returns {{ tokens: string[], pattern: string, dryRun: boolean }}
 */
function parseScanIgnoreArguments(line) {
  const text = String(line ?? '')
  const dryRun = /(?:^|\s)--dry-run(?=\s|$)/.test(text)
  const tokens = splitArguments(text.replace(/(?:^|\s)--dry-run(?=\s|$)/g, ' '))
  return { tokens, pattern: tokens.length === 1 ? tokens[0] : '', dryRun }
}

/**
 * What a compiled pattern means, independent of how it was spelled.
 *
 * The identity is the match, not the text: `/report/` and `report/` are one pattern with two
 * spellings, so the no-op is named for the pattern that would change nothing rather than for the
 * string the caller happened to type. `*` is compiled per segment, so the sources compare equal only
 * when the patterns would skip the same paths.
 *
 * @param {{ segments: RegExp[], directoriesOnly: boolean }} pattern a `parseScanIgnore` entry.
 * @returns {string}
 */
function ignoreSignature(pattern) {
  const kind = pattern.directoriesOnly === true ? 'directory' : 'any'
  return `${kind}:${pattern.segments.map((segment) => segment.source).join('/')}`
}

/**
 * What one pattern will cover, in the words the plan can stand behind.
 *
 * The plan must not promise less than the reader does: a one-segment pattern matches that name at
 * any depth, and a trailing slash skips a whole subtree, so both say so before the confirmation.
 *
 * @param {{ segments: RegExp[], directoriesOnly: boolean }} pattern
 * @returns {string}
 */
function ignoreBreadth(pattern) {
  if (pattern.directoriesOnly === true) {
    return 'A trailing slash makes it a directory pattern, so the next scan skips that whole subtree.'
  }
  if (pattern.segments.length > 1) {
    return 'The pattern has a slash, so it is anchored at the workspace root and the next scan skips exactly that path.'
  }
  return 'A one-segment pattern matches that name at any depth, so the next scan skips every path with that name.'
}

/**
 * Read the ignore file for the one command that may extend it.
 *
 * The scan is forgiving about a broken `.scanignore`; the writer is not. Appending a valid line to a
 * file whose own grammar the reader rejected would leave the file exactly as broken and add a line
 * whose neighbours are still reported as malformed, so a problem here is a refusal and the file is
 * left byte for byte as it is ([ADR-0003](docs/adr/0003-write-surface.md) §6).
 *
 * @param {string} file absolute path of the workspace ignore file.
 * @returns {Promise<{ text: string, patterns: Array<object>, exists: boolean } | { refusal: string }>}
 */
async function readScanIgnoreForWrite(file) {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', patterns: [], exists: false }
    return { refusal: `Refused: ${file} could not be read.` }
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { refusal: `Refused: ${file} is not a regular file.` }
  }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { refusal: `Refused: ${file} could not be read.` }
  }
  const parsed = parseScanIgnore(text)
  if (parsed.problems.length > 0) {
    const count = parsed.problems.length
    const lines = parsed.problems.map((problem) => problem.line).join(', ')
    return {
      refusal: `Refused (malformed): ${file} has ${count} ${count === 1 ? 'line' : 'lines'} outside the .scanignore grammar (line ${lines}); fix ${count === 1 ? 'it' : 'them'} by hand before another pattern is added.`,
    }
  }
  return { text, patterns: parsed.patterns, exists: true }
}

/**
 * The human command that adds one pattern to the workspace `.scanignore`.
 *
 * The product's second and last write ([ADR-0003](docs/adr/0003-write-surface.md)), obeying the
 * suppression command's protocol exactly: `--dry-run` prints the plan and writes nothing, the same
 * line without it appends the one line, an already-present pattern is a named no-op, and every
 * refusal is `kind: 'error'` with its reason. What differs is what it writes and what that means: an
 * ignore makes the next scan read less, so the outcome says "reads less" and never "muted".
 *
 * @returns {object} a CommandDefinition.
 */
function buildScanIgnoreCommand() {
  return {
    name: 'guidance-scanignore',
    description: 'Add one pattern to the workspace .scanignore so later scans read that path no more. Shows the plan with --dry-run and appends the line only without it.',
    input: { hint: '<pattern> [--dry-run]' },
    recordInput: false,
    async handler(invocation) {
      const args = parseScanIgnoreArguments(invocation?.rawInput)
      if (args.tokens.length === 0) {
        return {
          kind: 'error',
          text: 'No pattern: pass the one workspace-relative path or name to add, for example /guidance-scanignore src/app.css --dry-run.',
        }
      }
      // A flag this line does not know is a mistake, never a pattern: writing `--all` as a line would
      // put a token in the file that matches nothing and is not the exclusion anyone asked for.
      const unknown = args.tokens.filter((token) => token.startsWith('--'))
      if (unknown.length > 0) {
        return {
          kind: 'error',
          text: `Unknown option: ${unknown.join(', ')}. The only option this line takes is --dry-run; a path whose name begins with "--" has to be added to ${SCAN_IGNORE_FILE} by hand.`,
        }
      }
      // A line the reader would treat as a comment excludes nothing, so it is refused as a pattern
      // rather than written into the file where it would silently do nothing.
      if (args.tokens[0].startsWith('#')) {
        return {
          kind: 'error',
          text: 'Not a .scanignore pattern: a line that starts with "#" is a comment, and a comment excludes nothing.',
        }
      }
      if (args.tokens.length > 1) {
        return {
          kind: 'error',
          text: `One pattern at a time: "${args.tokens.join(' ')}" is ${args.tokens.length} arguments, and a path containing a space has to be quoted, for example /guidance-scanignore "src/my page.astro" --dry-run.`,
        }
      }

      // Only what the reader accepts is written, so the next scan never reports the writer's own line
      // as malformed (§6).
      const parsed = parseScanIgnore(args.pattern)
      if (parsed.patterns.length !== 1 || parsed.problems.length > 0) {
        return {
          kind: 'error',
          text: `Not a .scanignore pattern: "${args.pattern}" is outside the grammar, which is one workspace-relative path per line, an optional trailing "/" for a directory, and "*" inside one segment — no "**", no "?" and no "!".`,
        }
      }
      const pattern = parsed.patterns[0]
      const written = pattern.source

      const directory = workspaceDirectory(commandCwd(invocation))
      if (directory === null) {
        return { kind: 'error', text: 'Refused: this session reports no workspace directory, so there is nowhere to append a pattern.' }
      }
      const file = join(directory, SCAN_IGNORE_FILE)
      const current = await readScanIgnoreForWrite(file)
      if (current.refusal !== undefined) return { kind: 'error', text: current.refusal }

      const signature = ignoreSignature(pattern)
      const existing = current.patterns.find((entry) => ignoreSignature(entry) === signature)
      if (existing !== undefined) {
        // The no-op names the line the file holds, not the spelling that was typed: `/report/` and
        // `report/` are one pattern, and the answer should point at what is there.
        return {
          kind: 'success',
          text: args.dryRun
            ? `Already present: ${existing.source} is in ${file}, so this line would write nothing.`
            : `Already present: ${existing.source} is in ${file}; nothing was written.`,
        }
      }

      const count = current.patterns.length
      const patterns = (value) => `${value} ${value === 1 ? 'pattern' : 'patterns'}`
      // The plan is one paragraph, like the suppression plan, because the panel renders the host's
      // text verbatim in one node: the absolute file, the exact line, the count it would reach and
      // what the pattern covers, all before the confirmation.
      if (args.dryRun) {
        const state = current.exists
          ? `which would go from ${patterns(count)} to ${patterns(count + 1)}`
          : 'which does not exist yet, so it would be created with that one pattern'
        return {
          kind: 'success',
          text: `Ignore plan for ${written}: append ${written} to ${file}, ${state}. ${ignoreBreadth(pattern)} Nothing has been written; run the same line without --dry-run to write it.`,
        }
      }

      // Append one line and nothing else: the separator is added when the file does not end with one,
      // so two patterns never silently become one, and no line the user wrote is ever rewritten. The
      // new line uses the file's own ending, so a CRLF file stays uniformly CRLF.
      const ending = current.text.includes('\r\n') ? '\r\n' : '\n'
      const separator = current.text === '' || current.text.endsWith('\n') ? '' : ending
      const next = `${current.text}${separator}${written}${ending}`
      // The result is put back through the reader before it is written (ADR-0003 §6): the file may not
      // gain a line the next scan would report as malformed, and it may not gain two patterns when one
      // was asked for. A file this command cannot write correctly is not written at all.
      const checked = parseScanIgnore(next)
      if (checked.problems.length > 0 || checked.patterns.length !== count + 1) {
        return {
          kind: 'error',
          text: `Refused: the line this would append does not read back as one pattern in ${file}, so nothing was written. Add it by hand if it is the pattern you meant.`,
        }
      }
      const temporary = `${file}.tmp`
      try {
        await writeFile(temporary, next, 'utf8')
        await rename(temporary, file)
      } catch (error) {
        return {
          kind: 'error',
          text: `Refused: the write to ${file} failed (${error instanceof Error ? error.message : String(error)}).`,
        }
      }
      return {
        kind: 'success',
        text: `Appended to ${file}: ${written}. The file now holds ${patterns(count + 1)}. The next scan reads less because of it: an ignore excludes a path from the walk, it does not fix or mute a finding, and no counter moves.`,
      }
    },
  }
}

/** Read a skill body from the package; a missing file disables only that skill. */
function readSkillBody(relativePath) {
  try {
    return readFileSync(join(SKILLS_DIR, relativePath), 'utf8')
  } catch {
    return undefined
  }
}

const SKILL_DEFINITIONS = [
  {
    name: 'modern-web-guidance',
    bodyPath: join('modern-web-guidance', 'SKILL.md'),
    description: [
      "Google Chrome's curated modern web platform guidance: search 208 use-case guides before writing HTML, CSS or",
      'client-side JavaScript, then apply their Baseline-aware fallbacks. Covers dialogs and popovers, anchor positioning,',
      'container queries, view transitions, scroll-driven effects, forms and autofill, accessibility, passkeys, performance',
      '(LCP/INP/CLS), image/script priority, WebAssembly, built-in AI and WebMCP.',
    ].join(' '),
    whenToUse: 'Any web UI, CSS layout/animation, or client-side JS task: search the catalog first, retrieve the matching guide, then implement.',
    resourceBase: { kind: 'directory', path: DATA_DIR },
  },
  {
    name: 'chrome-extensions',
    bodyPath: join('chrome-extensions', 'SKILL.md'),
    description: [
      'Chrome extension engineering guidance for Manifest V3: service workers, content scripts, message passing, permissions,',
      'storage, side panel, popup UI, DevTools, CSP and sandboxing, declarative net request, plus Chrome Web Store listing,',
      'privacy-policy and review requirements. Use when building, reviewing or debugging a Chrome extension.',
    ].join(' '),
    whenToUse: 'Building, reviewing or debugging a Chrome extension (MV3), or preparing a Chrome Web Store submission.',
    resourceBase: { kind: 'directory', path: join(SKILLS_DIR, 'chrome-extensions') },
  },
]

/** The four tools the counters track, and the short names the report prints. */
const TRACKED_TOOLS = new Map([
  ['web_guidance_search', 'search'],
  ['web_guidance_retrieve', 'retrieve'],
  ['web_guidance_list', 'list'],
  ['web_guidance_legacy_scan', 'legacy-scan'],
])

/** Defaults for the counters; the plugin row can override both. */
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_PERIOD_DAYS = 7

/** How long a burst of calls is coalesced into one write of the counters document. */
const SAVE_DEBOUNCE_MS = 2000

/**
 * The corpus identity recorded in `data/corpus.json`; the refresh procedure updates it together
 * with the guides, so the report can say which snapshot the numbers describe.
 * @returns {{ version: string, snapshotDate: string }}
 */
function readCorpusMeta() {
  try {
    const meta = JSON.parse(readFileSync(join(DATA_DIR, 'corpus.json'), 'utf8'))
    return {
      version: typeof meta.version === 'string' ? meta.version : 'unknown',
      snapshotDate: typeof meta.snapshotDate === 'string' ? meta.snapshotDate : 'unknown',
    }
  } catch {
    return { version: 'unknown', snapshotDate: 'unknown' }
  }
}

/**
 * Catalog metadata the report needs: per-category totals, the id list, which category each guide
 * belongs to (so coverage counts guides rather than search hits), and each guide's one-line
 * description, so the JSON report can name what a counted guide is about instead of only its id.
 * @returns {object}
 */
function readCatalog() {
  const guides = JSON.parse(readFileSync(join(DATA_DIR, 'guides.json'), 'utf8'))
  const byCategory = Object.create(null)
  const categoryOf = Object.create(null)
  const descriptionOf = Object.create(null)
  const ids = []
  const seen = new Set()
  for (const guide of guides) {
    const id = String(guide.id ?? '')
    if (id === '') continue
    // A duplicate id would otherwise inflate `total` and the per-category counts while the search
    // index reports the guide once (lib/guidance.js rejects duplicates outright), so the report
    // would disagree with the tools. First occurrence wins.
    if (seen.has(id)) continue
    seen.add(id)
    const category = String(guide.category ?? 'uncategorised')
    ids.push(id)
    categoryOf[id] = category
    if (typeof guide.description === 'string') descriptionOf[id] = guide.description
    byCategory[category] = (byCategory[category] ?? 0) + 1
  }
  const meta = readCorpusMeta()
  return { total: ids.length, byCategory, categoryOf, descriptionOf, ids, ...meta }
}

/**
 * Parse a `/guidance-stats` line:
 * `[--days N] [--json] [--reset --yes] [--scan-only] [--workspace <name|id|path>] [--all]`.
 *
 * Anything unparsable falls back to the default period, because a malformed argument should still
 * show the report rather than an error. The selector flags are the exception: half a flag, or two
 * contradictory ones, would otherwise quietly read as "count everything", so they travel out as an
 * `error` string the handler returns before it takes a snapshot.
 *
 * `daysRaw` is the number as typed, before the period fallback: a reset may not widen a window the
 * caller wrote as zero, so the reset branch needs to know the difference between `--days 7` and a
 * malformed `--days 0` that the report path would silently read as the default week.
 *
 * @param {string} line raw arguments after the command name.
 * @returns {{ days: number, daysRaw: number | undefined, daysDeclared: boolean, json: boolean, reset: boolean, yes: boolean, scanOnly: boolean, workspace: string | undefined, all: boolean, error: string | undefined }}
 */
function parseStatsArguments(line) {
  const text = String(line ?? '')
  const matched = text.match(/--days(?:\s+|=)(\d+)/)
  const days = matched === null ? DEFAULT_PERIOD_DAYS : Number(matched[1])
  const declared = /--workspace\b/.test(text)
  // A selector never starts with `-`: `--workspace --json` is a missing value, not a workspace
  // called "--json", and the next flag must not be swallowed as one.
  const workspaceMatch = text.match(/--workspace(?:\s+|=)([^\s-]\S*)/)
  const all = /--all\b/.test(text)
  const workspace = workspaceMatch === null ? undefined : workspaceMatch[1]
  return {
    days: Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : DEFAULT_PERIOD_DAYS,
    daysRaw: matched === null ? undefined : Number(matched[1]),
    daysDeclared: /--days\b/.test(text),
    json: /--json\b/.test(text),
    reset: /--reset\b/.test(text),
    yes: /--yes\b/.test(text),
    scanOnly: /--scan-only\b/.test(text),
    workspace,
    all,
    error: statsSelectorError({ declared, workspace, all }),
  }
}

/**
 * Why a selector cannot be used, or undefined when the flags are coherent. Checked before any
 * snapshot: a contradictory line must cost nothing and touch nothing.
 *
 * @param {{ declared: boolean, workspace: string | undefined, all: boolean }} flags
 * @returns {string | undefined}
 */
function statsSelectorError({ declared, workspace, all }) {
  if (declared && workspace === undefined) {
    return 'Error: --workspace needs a workspace name, id or path, for example /guidance-stats --workspace my-app.'
  }
  if (declared && all) {
    return 'Error: --workspace and --all cannot be combined. Pass one of them, or neither to show the session workspace.'
  }
  return undefined
}

/** Why a report covers every workspace: the text says it, so the aggregate never passes as a project. */
const NO_SESSION_WORKSPACE_NOTE = 'no session workspace could be resolved, so every workspace is counted'

/**
 * Which workspace's scan detail the report shows.
 *
 * With no selector it is the session's own workspace — the whole point of the partition — and when
 * the host named no path the report aggregates and the reason travels to the text. `--all` asks for
 * the aggregate explicitly, so it explains nothing. A `--workspace` value is validated against the
 * list the snapshot already carries: a typo must be an error naming what exists, never a quiet
 * aggregate that reads like "this project has no scans".
 *
 * @param {{ workspace: string | undefined, all: boolean }} options parsed flags.
 * @param {string | undefined} sessionPath the session header's cwd, when the host gave one.
 * @param {object} overview an aggregate snapshot, for its `workspaces` list.
 * @returns {{ workspace?: { id: string, name: string }, note?: string, error?: string }}
 */
function selectWorkspace(options, sessionPath, overview) {
  const known = Array.isArray(overview?.workspaces) ? overview.workspaces : []
  if (options.all) return {}
  if (options.workspace !== undefined) {
    const match = matchWorkspace(options.workspace, known, sessionPath)
    return match.error === undefined ? { workspace: match.workspace } : { error: match.error }
  }
  const session = resolveWorkspace(sessionPath)
  return session === null ? { note: NO_SESSION_WORKSPACE_NOTE } : { workspace: session }
}

/**
 * Resolve one `--workspace` selector against the workspaces the counters know: an id, an exact
 * name, or a path that hashes to a recorded id. The order matters — an id is what `--workspace`
 * prints in its refusals, a name is what a person types, and a path is the only form that has to be
 * resolved before it can match.
 *
 * Two workspaces can share a name (two checkouts of one project), and guessing between them would
 * attach numbers to the wrong project, so an ambiguous name is refused with their ids instead.
 *
 * @param {string} selector the raw `--workspace` value.
 * @param {Array<object>} known the snapshot's `workspaces` rows.
 * @param {string | undefined} base the session directory, for a relative path.
 * @returns {{ workspace?: { id: string, name: string }, error?: string }}
 */
function matchWorkspace(selector, known, base) {
  const wanted = String(selector ?? '').trim()
  const usable = known.filter((row) => row !== null && typeof row === 'object'
    && typeof row.id === 'string' && row.id !== '')
  const asWorkspace = (row) => ({ id: row.id, name: typeof row.name === 'string' ? row.name : '' })

  const byId = usable.find((row) => row.id === wanted)
  if (byId !== undefined) return { workspace: asWorkspace(byId) }

  const byName = usable.filter((row) => typeof row.name === 'string' && row.name !== '' && row.name === wanted)
  if (byName.length === 1) return { workspace: asWorkspace(byName[0]) }
  if (byName.length > 1) {
    return {
      error: `Error: "${wanted}" names ${byName.length} workspaces. Pass one of their ids: ${byName.map(workspaceLabel).join(', ')}.`,
    }
  }

  // A path selects by identity. A relative path is only read from a base the host actually gave:
  // resolving it against `process.cwd()` could select the plugin's own directory.
  if (isAbsolute(wanted) || base !== undefined) {
    const resolved = resolveWorkspace(wanted, base)
    const byPath = resolved === null ? undefined : usable.find((row) => row.id === resolved.id)
    if (byPath !== undefined) return { workspace: asWorkspace(byPath) }
  }

  const labelled = usable.map(workspaceLabel)
  const list = labelled.length === 0
    ? 'No workspace has a recorded scan yet.'
    : `Known workspaces: ${labelled.join(', ')}.`
  return { error: `Error: unknown workspace "${wanted}". ${list} Omit --workspace to count every workspace.` }
}

/**
 * Show one workspace's scan detail, and name it.
 *
 * Two things the counters cannot do for the command. First, the counters aggregate an id they hold
 * no bucket for — that is their contract, because the command validates selectors — but a workspace
 * that has never been scanned has *no* scan debt: rendering the aggregate under its name would
 * attribute somebody else's findings to this project, which is the exact lie this phase removes. So
 * an absent bucket is drawn as empty. Second, the counters only know the names of workspaces they
 * hold a bucket for, so a fresh checkout would otherwise report anonymously while the command knows
 * exactly which directory it selected; the command stamps the name it resolved.
 *
 * @param {object} snapshot the snapshot the counters returned for this id.
 * @param {{ id: string, name: string }} workspace the workspace the command selected.
 * @returns {object} the same snapshot, or a copy scoped and named for the selection.
 */
function scopeWorkspace(snapshot, workspace) {
  if (snapshot === null || typeof snapshot !== 'object' || !('workspaces' in snapshot)) return snapshot
  const rows = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : []
  const known = rows.some((row) => row !== null && typeof row === 'object' && row.id === workspace.id)
  if (!known) {
    return {
      ...snapshot,
      workspace: { id: workspace.id, name: workspace.name },
      topRules: [],
      topScanGuides: [],
      lastScan: null,
    }
  }
  const current = snapshot.workspace
  const named = current !== null && typeof current === 'object' && current.id === workspace.id
    && typeof current.name === 'string' && current.name !== ''
  return named ? snapshot : { ...snapshot, workspace: { id: workspace.id, name: workspace.name } }
}

/**
 * Why a reset line cannot be honoured, or undefined when it can.
 *
 * A reset erases exactly one slice at a time. Two selectors would make the sentence describe
 * something narrower than the erasure — `--scan-only --workspace app` reads as "one workspace" but
 * `--scan-only` names every one — so the combination is refused and the known selectors are
 * listed, the same way an unknown `--workspace` lists the known names. `--days 0` is refused for
 * the same reason: the report path reads a non-positive period as the default week, and a reset
 * must never widen a window the caller wrote as nothing.
 *
 * @param {{ scanOnly: boolean, workspace: string | undefined, daysDeclared: boolean, daysRaw: number | undefined }} options
 * @returns {string | undefined}
 */
function resetScopeError({ scanOnly, workspace, daysDeclared, daysRaw }) {
  const chosen = [scanOnly ? '--scan-only' : '', workspace === undefined ? '' : '--workspace', daysDeclared ? '--days' : '']
    .filter((flag) => flag !== '')
  if (chosen.length > 1) {
    return `Error: a reset erases one slice at a time, and ${chosen.join(', ')} cannot be combined. Pass one of --scan-only, --workspace or --days, or none to erase every counter.`
  }
  if (daysDeclared && !(Number.isFinite(daysRaw) && daysRaw >= 1)) {
    return 'Error: --days needs a whole number of days, at least 1, for example /guidance-stats --reset --yes --days 30.'
  }
  return undefined
}

/**
 * The erasure one `--reset` line asks for, as the counters' own scope object.
 *
 * With no selector this is the whole document — a bare `--reset --yes` must keep erasing exactly
 * what it always erased, because narrowing a default is a silent behaviour change. A
 * `--workspace` value is validated against the same list the report validates against, so a typo is
 * an error naming what exists rather than a reset of nothing.
 *
 * @param {object} options parsed flags.
 * @param {object} overview an aggregate snapshot, for its `workspaces` list.
 * @param {string | undefined} sessionPath the session header's cwd, for a relative `--workspace` path.
 * @returns {{ request: { scope: string, workspace?: string, days?: number }, workspace?: { id: string, name: string }, error?: string }}
 */
function resetTarget(options, overview, sessionPath) {
  if (options.scanOnly) return { request: { scope: 'scans' } }
  if (options.workspace !== undefined) {
    const known = Array.isArray(overview?.workspaces) ? overview.workspaces : []
    const match = matchWorkspace(options.workspace, known, sessionPath)
    if (match.error !== undefined) return { error: match.error }
    return { request: { scope: 'workspace', workspace: match.workspace.id }, workspace: match.workspace }
  }
  if (options.daysDeclared) return { request: { scope: 'window', days: options.days } }
  return { request: { scope: 'all' } }
}

/**
 * What a scoped reset would erase, before it happens: `/guidance-stats` has no undo, so the plan is
 * the only chance to see the target and the selector that would erase it. The bare form keeps its
 * own sentence, byte for byte.
 *
 * @param {{ request: { scope: string } }} target
 * @param {object} options parsed flags.
 * @param {object} overview an aggregate snapshot, for its `workspaces` list.
 * @returns {string}
 */
function resetPlanText(target, options, overview) {
  if (target.request.scope === 'scans') {
    const scope = Array.isArray(overview?.workspaces) ? `of ${overview.workspaces.length} workspace(s)` : 'of every workspace'
    return `This would erase the scan counters ${scope}: findings, rules, guides, history and baselines. Every call counter stays. Re-run /guidance-stats --reset --yes --scan-only to erase them.`
  }
  if (target.request.scope === 'workspace') {
    return `This would erase the scan counters of ${workspaceLabel(target.workspace)}: its findings, rules, guides, history and baseline. Every other workspace and every call counter stays. Re-run /guidance-stats --reset --yes --workspace ${target.workspace.id} to erase them.`
  }
  return `This would erase the counters recorded in the last ${options.days} day(s), for every workspace. Lifetime rule and guide totals carry no day, so they stay. Re-run /guidance-stats --reset --yes --days ${options.days} to erase them.`
}

/**
 * What a scoped reset erased, and what it left: a reset that reported only its own success would
 * make "narrowed" and "everything" look the same.
 *
 * @param {{ scope: string, calls: number, findings: number, scans: number, workspaces: number }} tally
 *   what the counters removed.
 * @param {{ request: { scope: string }, workspace?: { id: string, name: string } }} target
 * @param {object} options parsed flags.
 * @returns {string}
 */
function resetDoneText(tally, target, options) {
  // The suppression list lives in a workspace file, not in this state, and it must survive every
  // reset: "muted" is a claim about intent, and erasing the numbers that show it would not unmute
  // anything. Saying so is the only way the report can be trusted about the file it did not read.
  const untouched = 'The suppression file was not touched: muting is not a counter.'
  if (tally.scope === 'scans') {
    return `Erased the scan counters of ${tally.workspaces} workspace(s): ${tally.findings} finding(s) and ${tally.scans} scan(s) of history. Every call counter, including how many scans were run, stays. ${untouched}`
  }
  if (tally.scope === 'workspace') {
    return `Erased the scan counters of ${workspaceLabel(target.workspace)}: ${tally.findings} finding(s) and ${tally.scans} scan(s) of history. Every other workspace and every call counter stays. ${untouched}`
  }
  return `Erased the counters recorded in the last ${options.days} day(s): ${tally.calls} call(s), ${tally.findings} finding(s) and ${tally.scans} scan(s) of history. Lifetime rule and guide totals carry no day, so they stay. ${untouched}`
}

/**
 * The human command that reads the counters. It never becomes a tool: the numbers serve the
 * maintainer, not the model.
 * @param {object} telemetry counters instance from `lib/telemetry.js`.
 * @param {{ rules?: readonly object[], guides?: Record<string, string> }} [detail] the rule table
 *   and the guide descriptions the `--json` output needs to explain its ids. They are passed in
 *   rather than loaded here: the counters already hold the catalog, and there is one loader.
 * @returns {object} a CommandDefinition.
 */
function buildStatsCommand(telemetry, detail = {}) {
  return {
    name: 'guidance-stats',
    description: 'Local usage counters for the guidance tools: calls, outcomes, missed queries, category coverage and dead guides, plus the scan findings and rules of the workspace you ask for.',
    input: { hint: '[--days N] [--json] [--workspace <name|id>] [--all] [--reset [--yes]] [--scan-only]' },
    recordInput: false,
    async handler(invocation) {
      try {
        const options = parseStatsArguments(invocation?.rawInput)
        if (options.error !== undefined) return { kind: 'error', text: options.error }
        if (options.reset) {
          const conflict = resetScopeError(options)
          if (conflict !== undefined) return { kind: 'error', text: conflict }
          // One aggregate snapshot answers both halves of the reset: it lists the workspaces a
          // selector is validated against, and its windowed call count is what the plan promises to
          // erase. It is read before any write, so a refusal costs a read and touches nothing.
          const overview = await telemetry.snapshot({ days: options.days, workspace: 'all' })
          const target = resetTarget(options, overview, sessionCwd(invocation))
          if (target.error !== undefined) return { kind: 'error', text: target.error }
          const calls = overview?.totals?.calls ?? 0
          if (!options.yes) {
            // The bare plan is the 0.4.0 sentence, unchanged: its wording is the promise that a
            // reset without a selector still erases everything.
            return {
              kind: 'success',
              text: target.request.scope === 'all'
                ? `This would erase counters covering ${calls} call(s). Re-run /guidance-stats --reset --yes to erase them.`
                : resetPlanText(target, options, overview),
            }
          }
          const tally = await telemetry.reset(target.request)
          return {
            kind: 'success',
            text: target.request.scope === 'all'
              ? `Erased local usage counters (${calls} call(s) in the last ${options.days} day(s)). Tool behaviour is unchanged.`
              : resetDoneText(tally, target, options),
          }
        }

        // One aggregate snapshot answers both questions: it lists the workspaces a selector can be
        // validated against, and it *is* the report when no workspace is selected.
        const overview = await telemetry.snapshot({ days: options.days, workspace: 'all' })
        const selection = selectWorkspace(options, sessionCwd(invocation), overview)
        if (selection.error !== undefined) return { kind: 'error', text: selection.error }

        let snapshot = overview
        if (selection.workspace !== undefined) {
          snapshot = scopeWorkspace(
            await telemetry.snapshot({ days: options.days, workspace: selection.workspace.id }),
            selection.workspace,
          )
        }

        const text = options.json
          ? JSON.stringify(renderJson(snapshot, detail), null, 2)
          : renderReport(snapshot, { workspaceNote: selection.note })
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: `Usage stats are unavailable: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

/**
 * The counters' single recording surface.
 *
 * It starts as a no-op so `apply` can hand it to the scan command before the counters exist;
 * `startUsageCounters` swaps in the real sink once telemetry is up, and `enabled: false` simply
 * leaves the no-op in place. Both entry points therefore call the same `record` with the same
 * arguments, and nothing downstream can tell a command scan from a tool scan.
 * @returns {{ record: (toolName: string, args: unknown, value: unknown, isError: boolean) => void, start: (sink: Function) => void }}
 */
function createUsageRecorder() {
  let sink = () => {}
  return {
    record(toolName, args, value, isError) {
      sink(toolName, args, value, isError)
    },
    /** Install the real recording function once a telemetry instance exists. */
    start(next) {
      if (typeof next === 'function') sink = next
    },
  }
}

/**
 * Start the local counters: subscribe to finished tool calls, persist them on a short debounce, and
 * register the human command. Counting is best-effort by design — a broken counter must never
 * change what a tool returns.
 * @param {import('@deepseek-ai/cordis').Context} ctx host plugin context.
 * @param {{ enabled?: boolean, retentionDays?: number }} config plugin row configuration.
 * @param {ReturnType<typeof createUsageRecorder>} usage the recorder both entry points share.
 * @returns {void}
 */
function startUsageCounters(ctx, config, usage) {
  if (config?.enabled === false) return
  // A bare test context has no event bus; without it there is nothing to count.
  if (typeof ctx.on !== 'function') return

  let telemetry
  let catalog
  try {
    catalog = readCatalog()
    telemetry = createTelemetry({
      store: createFileStore({ file: defaultStatePath() }),
      clock: () => Date.now(),
      retentionDays: Number.isFinite(config?.retentionDays) ? config.retentionDays : DEFAULT_RETENTION_DAYS,
      ringLimit: 1000,
      catalog,
      // The counters never import the rule table: they cannot tell a retired rule from a typo
      // without it, so the ids the scan can select are given once, at construction. A telemetry
      // built without them (a test fixture) treats every rule as known and simply makes no claim.
      ruleIds: ALL_RULE_IDS,
    })
  } catch {
    return
  }

  const save = () => Promise.resolve(telemetry.flush()).catch(() => {})
  let pending

  /** Coalesce a burst of calls into one write of the counters document. */
  const scheduleSave = () => {
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      void save()
    }, SAVE_DEBOUNCE_MS)
    pending.unref?.()
  }

  // The one place a finished call is classified and recorded. A tool result and a command scan both
  // arrive here with the tool's own name and payload, so the numbers cannot reveal which raised it.
  usage.start((toolName, args, value, isError) => {
    const tool = TRACKED_TOOLS.get(toolName)
    if (tool === undefined) return

    let entry
    try {
      entry = classifyCall({ tool: toolName, args, value, isError })
    } catch {
      return
    }

    // A scan names the workspace it read as the raw `cwd` in its value; the counters store an id and
    // a name, so the path is resolved here and never reaches the document. A call with no path — a
    // guidance call, or a scan whose value carries none — records no workspace and its scan debt
    // stays in the legacy root counters.
    const { workspacePath, ...classified } = entry
    // One resolution serves both: the branch label is read in the very directory whose realpath
    // produced the workspace id, so the two can never name different trees.
    const directory = workspaceDirectory(workspacePath)
    const workspace = directory === null ? null : workspaceOfDirectory(directory)
    // Only a completed scan has a last scan to label; a refusal writes no summary, so reading for it
    // would be a read nobody uses. A guidance call never takes this branch.
    const scanCompleted = tool === 'legacy-scan'
      && (classified.outcome === 'findings' || classified.outcome === 'clean')
    const branch = scanCompleted && directory !== null ? readHeadLabel(directory) : null

    void Promise.resolve()
      .then(() => telemetry.record({
        at: Date.now(),
        tool,
        ...classified,
        ...(workspace === null ? {} : { workspace }),
        ...(branch === null ? {} : { branch }),
      }))
      .catch(() => {})

    scheduleSave()
  })

  ctx.effect(() => {
    const onResult = (exec, result) => {
      const isError = result?.isError === true
      usage.record(exec?.name, exec?.arguments, isError ? undefined : result?.value, isError)
    }

    ctx.on('tools/result', onResult)
    return () => {
      ctx.off?.('tools/result', onResult)
      if (pending !== undefined) {
        clearTimeout(pending)
        pending = undefined
      }
      void save()
    }
  }, 'modern-web-guidance usage counters')

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands !== undefined && commands !== null && typeof commands.register === 'function') {
    const definition = buildStatsCommand(telemetry, { rules: RULES, guides: catalog.descriptionOf })
    ctx.effect(() => commands.register(definition), 'modern-web-guidance /guidance-stats')
  }
}

export const inject = ['skills', 'tools']

/**
 * Register the guidance tools and skills, then start the local usage counters.
 * @param {import('@deepseek-ai/cordis').Context} ctx host plugin context.
 * @param {{ enabled?: boolean, retentionDays?: number }} [config] plugin row configuration.
 */
export function apply(ctx, config = {}) {
  const guidance = createGuidance({ dataDir: DATA_DIR })
  // Warm the index in the background; a failed warm-up is retried by the first tool call.
  void guidance.ready().catch(() => {})

  for (const build of [buildSearchTool, buildRetrieveTool, buildListTool]) {
    const tool = build(guidance)
    ctx.effect(() => ctx.tools.register(tool), `modern-web-guidance ${tool.name}`)
  }

  // The scanner is registered beside the loop rather than through it: its two modules are injected
  // explicitly instead of being derived from `guidance`.
  const scanTool = buildScanTool({ scan, ScanError }, { RULES, selectRules })
  ctx.effect(() => ctx.tools.register(scanTool), `modern-web-guidance ${scanTool.name}`)

  // A person gets the same scan through a command, because the panel can only execute commands.
  // It is registered here, not with the counters below: scanning is not a counting feature, and
  // the command must exist whether or not the counters are enabled.
  const usage = createUsageRecorder()
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands !== undefined && commands !== null && typeof commands.register === 'function') {
    const scanCommand = buildScanCommand({ scan, ScanError }, { RULES, selectRules }, usage)
    ctx.effect(() => commands.register(scanCommand), `modern-web-guidance /${scanCommand.name}`)
    // The one writer in the product, and the only way the panel can mute a finding: two lines, one
    // plan and one apply, so a single click can never write.
    const suppressCommand = buildSuppressCommand()
    ctx.effect(() => commands.register(suppressCommand), `modern-web-guidance /${suppressCommand.name}`)
    // The second and last write: one `.scanignore` line, under the same plan-then-apply protocol, so
    // an exclusion cannot be added by a single click either.
    const scanIgnoreCommand = buildScanIgnoreCommand()
    ctx.effect(() => commands.register(scanIgnoreCommand), `modern-web-guidance /${scanIgnoreCommand.name}`)
  }

  for (const definition of SKILL_DEFINITIONS) {
    const content = readSkillBody(definition.bodyPath)
    if (content === undefined) continue
    const registration = {
      name: definition.name,
      description: definition.description,
      content,
      // `source` is required by SkillRegistration (SkillSummary.source) and must be a string.
      source: 'bundled',
      path: join(SKILLS_DIR, definition.bodyPath),
      resourceBase: definition.resourceBase,
      invocation: { modelInvocable: true, userInvocable: true },
    }
    if (definition.whenToUse !== undefined) registration.whenToUse = definition.whenToUse
    ctx.effect(
      () => ctx.skills.register(registration),
      `modern-web-guidance skill ${definition.name}`,
    )
  }

  // Last, so the counters can reuse the recorder the scan command already holds: the command is
  // registered before them, and both write through one sink.
  startUsageCounters(ctx, config, usage)
}

export const name = 'modern-web-guidance'
