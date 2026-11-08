/**
 * dsh-modern-web-guidance — Google Chrome's modern web platform guidance for DSH agents.
 *
 * Registers two skills (`modern-web-guidance`, `chrome-extensions`) and three offline
 * tools that search and load the bundled guide corpus. Everything runs locally: the
 * plugin ships its data, never calls the network, and contains no telemetry.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGuidance } from './lib/guidance.js'
import { renderJson, renderReport } from './lib/report.js'
import { createFileStore, defaultStatePath } from './lib/store.js'
import { classifyCall, createTelemetry } from './lib/telemetry.js'

const here = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(here, 'data')
const SKILLS_DIR = join(DATA_DIR, 'skills')

const SEARCH_DESCRIPTION = [
  "Search Google Chrome's Modern Web Guidance catalog: 193 curated, token-efficient guides covering modern browser",
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
].join(' ')

const LIST_DESCRIPTION = [
  'Browse the Modern Web Guidance catalog without a search query: returns guide counts per category, or the guide ids,',
  'titles and short descriptions for one category (css, ui-behaviors, ui-atoms, ui-components, forms, html, js,',
  'accessibility, visual-design, security, performance, built-in-ai, pwa, wasm, webmcp, privacy, user-experience).',
  'Use it when search phrasing did not match and you want to see what the catalog covers.',
].join(' ')

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
  const lines = results.map((hit) => `- ${hit.id} (${hit.category}): ${hit.title} — ${hit.description}`)
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
    const limits = value?.limits ?? {}
    const maxGuides = limits.maxGuides ?? 10
    parts.push([
      `Not returned in this call (limit: ${maxGuides} guides / ${Math.round((limits.maxChars ?? 120000) / 1000)}k characters):`,
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
      "Google Chrome's curated modern web platform guidance: search 193 use-case guides before writing HTML, CSS or",
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

/** The three tools the counters track, and the short names the report prints. */
const TRACKED_TOOLS = new Map([
  ['web_guidance_search', 'search'],
  ['web_guidance_retrieve', 'retrieve'],
  ['web_guidance_list', 'list'],
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
 * Catalog metadata the report needs: per-category totals, the id list, and which category each
 * guide belongs to, so coverage counts guides rather than search hits.
 * @returns {object}
 */
function readCatalog() {
  const guides = JSON.parse(readFileSync(join(DATA_DIR, 'guides.json'), 'utf8'))
  const byCategory = Object.create(null)
  const categoryOf = Object.create(null)
  const ids = []
  for (const guide of guides) {
    const id = String(guide.id ?? '')
    if (id === '') continue
    const category = String(guide.category ?? 'uncategorised')
    ids.push(id)
    categoryOf[id] = category
    byCategory[category] = (byCategory[category] ?? 0) + 1
  }
  const meta = readCorpusMeta()
  return { total: ids.length, byCategory, categoryOf, ids, ...meta }
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
 * @returns {object} a CommandDefinition.
 */
function buildStatsCommand(telemetry) {
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
          ? JSON.stringify(renderJson(snapshot), null, 2)
          : renderReport(snapshot)
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: `Usage stats are unavailable: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

/**
 * Start the local counters: subscribe to finished tool calls, persist them on a short debounce, and
 * register the human command. Counting is best-effort by design — a broken counter must never
 * change what a tool returns.
 * @param {import('@deepseek-ai/cordis').Context} ctx host plugin context.
 * @param {{ enabled?: boolean, retentionDays?: number }} config plugin row configuration.
 * @returns {void}
 */
function startUsageCounters(ctx, config) {
  if (config?.enabled === false) return
  // A bare test context has no event bus; without it there is nothing to count.
  if (typeof ctx.on !== 'function') return

  let telemetry
  try {
    telemetry = createTelemetry({
      store: createFileStore({ file: defaultStatePath() }),
      clock: () => Date.now(),
      retentionDays: Number.isFinite(config?.retentionDays) ? config.retentionDays : DEFAULT_RETENTION_DAYS,
      ringLimit: 1000,
      catalog: readCatalog(),
    })
  } catch {
    return
  }

  const save = () => Promise.resolve(telemetry.flush()).catch(() => {})
  let pending

  ctx.effect(() => {
    const onResult = (exec, result) => {
      const tool = TRACKED_TOOLS.get(exec?.name)
      if (tool === undefined) return

      let entry
      try {
        const isError = result?.isError === true
        entry = classifyCall({
          tool: exec.name,
          args: exec.arguments,
          value: isError ? undefined : result?.value,
          isError,
        })
      } catch {
        return
      }

      void Promise.resolve()
        .then(() => telemetry.record({ at: Date.now(), tool, ...entry }))
        .catch(() => {})

      if (pending === undefined) {
        pending = setTimeout(() => {
          pending = undefined
          void save()
        }, SAVE_DEBOUNCE_MS)
        pending.unref?.()
      }
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
    const definition = buildStatsCommand(telemetry)
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

  startUsageCounters(ctx, config)
}

export const name = 'modern-web-guidance'
