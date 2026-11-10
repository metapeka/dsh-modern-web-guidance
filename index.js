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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGuidance } from './lib/guidance.js'
import { renderJson, renderReport } from './lib/report.js'
import { RULES, selectRules } from './lib/scan-rules.js'
import { ScanError, scan } from './lib/scan.js'
import { createFileStore, defaultStatePath } from './lib/store.js'
import { classifyCall, createTelemetry } from './lib/telemetry.js'

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
  const lines = [`${summary}.`]

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
      lines.push(`- ${location} ${finding.ruleId} (${finding.confidence}) ${finding.message}`)
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
 * Parse a `/guidance-stats` line. Anything unparsable falls back to the default period, because a
 * malformed argument should still show the report rather than an error.
 * @param {string} line raw arguments after the command name.
 * @returns {{ days: number, json: boolean, reset: boolean, yes: boolean }}
 */
function parseStatsArguments(line) {
  const text = String(line ?? '')
  const matched = text.match(/--days(?:\s+|=)(\d+)/)
  const days = matched === null ? DEFAULT_PERIOD_DAYS : Number(matched[1])
  return {
    days: Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : DEFAULT_PERIOD_DAYS,
    json: /--json\b/.test(text),
    reset: /--reset\b/.test(text),
    yes: /--yes\b/.test(text),
  }
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
    description: 'Local usage counters for the guidance tools: calls, outcomes, missed queries, category coverage and dead guides.',
    input: { hint: '[--days N] [--json] [--reset --yes]' },
    recordInput: false,
    async handler(invocation) {
      try {
        const options = parseStatsArguments(invocation?.rawInput)
        if (options.reset) {
          const before = await telemetry.snapshot({ days: options.days })
          const calls = before?.totals?.calls ?? 0
          if (!options.yes) {
            return { kind: 'success', text: `This would erase counters covering ${calls} call(s). Re-run /guidance-stats --reset --yes to erase them.` }
          }
          await telemetry.reset()
          return { kind: 'success', text: `Erased local usage counters (${calls} call(s) in the last ${options.days} day(s)). Tool behaviour is unchanged.` }
        }

        const snapshot = await telemetry.snapshot({ days: options.days })
        const text = options.json
          ? JSON.stringify(renderJson(snapshot, detail), null, 2)
          : renderReport(snapshot)
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

    void Promise.resolve()
      .then(() => telemetry.record({ at: Date.now(), tool, ...entry }))
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
