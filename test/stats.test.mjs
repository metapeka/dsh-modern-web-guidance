import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { renderJson, renderReport } from '../lib/report.js'
import { createFileStore } from '../lib/store.js'
import { classifyCall, createTelemetry } from '../lib/telemetry.js'

const scratch = join(import.meta.dirname, '..', '.tmp')

/** Point the counters at a throwaway profile before the plugin resolves its state path. */
async function isolatedHome() {
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, 'stats-home-'))
  process.env.DSH_PROFILE_DIR = home
  process.env.DSH_HOME = home
  return home
}

/** A context with just enough of the host surface for the plugin: registry, events, command lookup. */
function createContext() {
  const registered = { tools: [], skills: [], commands: [], listeners: [] }
  const commands = {
    register: (definition) => {
      registered.commands.push(definition)
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register: (tool) => {
        registered.tools.push(tool)
        return () => {}
      },
    },
    skills: {
      register: (skill) => {
        registered.skills.push(skill)
        return () => {}
      },
    },
    get: (name) => (name === 'commands' ? commands : undefined),
    on: (event, handler) => {
      registered.listeners.push({ event, handler })
    },
    off: () => {},
    effect: (create) => create(),
  }
  return { ctx, registered }
}

/** Let the fire-and-forget recording chain settle before reading the counters. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('the plugin registers four tools, two skills and one human command', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})

  assert.deepEqual(registered.tools.map((tool) => tool.name), [
    'web_guidance_search',
    'web_guidance_retrieve',
    'web_guidance_list',
    'web_guidance_legacy_scan',
  ])
  assert.deepEqual(registered.skills.map((skill) => skill.name), ['modern-web-guidance', 'chrome-extensions'])
  assert.deepEqual(registered.commands.map((command) => command.name), ['guidance-stats'])
  assert.ok(registered.listeners.some((listener) => listener.event === 'tools/result'))

  await rm(home, { recursive: true, force: true })
})

test('a finished search is counted and the command renders the report', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})
  const listener = registered.listeners.find((entry) => entry.event === 'tools/result')

  listener.handler(
    { name: 'web_guidance_search', arguments: { query: 'dialog light dismiss' } },
    { isError: false, value: { results: [{ id: 'css-anchor', category: 'css' }] } },
  )
  await settle()

  const report = await registered.commands[0].handler({ rawInput: '' })

  assert.equal(report.kind, 'success')
  assert.match(report.text, /Guidance usage: 1 call/)
  assert.match(report.text, /dialog light dismiss/)
  assert.match(report.text, /Corpus: version 2026_11_09-5bcc021b/)
  assert.match(report.text, /Period: last 7 days/)

  await rm(home, { recursive: true, force: true })
})

test('the command honours --days and --json', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})
  const command = registered.commands[0]

  const wide = await command.handler({ rawInput: '--days 30' })
  assert.match(wide.text, /Period: last 30 days/)

  const json = await command.handler({ rawInput: '--json' })
  const payload = JSON.parse(json.text)
  assert.equal(payload.periodDays, 7)
  assert.equal(payload.corpus.total, 208)

  await rm(home, { recursive: true, force: true })
})

test('--reset asks for confirmation, then erases the counters', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})
  const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
  listener.handler(
    { name: 'web_guidance_search', arguments: { query: 'nothing matches this' } },
    { isError: false, value: { results: [] } },
  )
  await settle()

  const command = registered.commands[0]
  const refused = await command.handler({ rawInput: '--reset' })
  assert.match(refused.text, /Re-run \/guidance-stats --reset --yes/)

  const erased = await command.handler({ rawInput: '--reset --yes' })
  assert.match(erased.text, /Erased local usage counters \(1 call/)

  const empty = await command.handler({ rawInput: '' })
  assert.match(empty.text, /No calls recorded in the last 7 days/)

  await rm(home, { recursive: true, force: true })
})

test('enabled: false writes nothing and registers no command', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, { enabled: false })

  assert.equal(registered.commands.length, 0)
  assert.equal(registered.listeners.length, 0)
  assert.equal(registered.tools.length, 4)

  await rm(home, { recursive: true, force: true })
})

//#region 0.5.0: the fourth tool's counters

const DAY = 24 * 60 * 60 * 1000

/** A fixed moment, so day buckets and period windows are deterministic. */
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

/** A catalog small enough to reason about; only the report's corpus and coverage lines read it. */
const CATALOG = {
  total: 2,
  byCategory: { css: 2 },
  ids: ['css-anchor', 'css-container'],
  categoryOf: { 'css-anchor': 'css', 'css-container': 'css' },
  version: '2026_11_09-5bcc021b',
  snapshotDate: '2026-11-09',
}

/** The local calendar day of a moment, `YYYY-MM-DD`, matching the counters' own day keys. */
function localDay(milliseconds = NOW) {
  const date = new Date(milliseconds)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** An in-memory store, so a test can inspect exactly what was persisted. */
function memoryStore(seed = null) {
  const store = {
    state: seed,
    async load() {
      return store.state
    },
    async save(state) {
      store.state = JSON.parse(JSON.stringify(state))
    },
  }
  return store
}

/** The document 0.4.x wrote: three tool counters, no scan volume anywhere. */
function legacyDocument() {
  return {
    version: 1,
    since: NOW - 30 * DAY,
    calls: 5,
    byDay: {
      [localDay()]: {
        calls: 5,
        byTool: { search: 4, retrieve: 1 },
        byOutcome: { hit: 4, miss: 1 },
      },
    },
    byTool: { search: 4, retrieve: 1 },
    byOutcome: { hit: 4, miss: 1 },
    byCategory: { css: 4 },
    retrieved: { 'css-anchor': 1 },
    recent: [{ at: NOW, tool: 'search', outcome: 'hit', query: 'dialog' }],
  }
}

/** A successful scan result, shaped like `lib/scan.js` returns it. */
function scanResult({ files, findings }) {
  return {
    format: 'summary',
    cwd: 'C:/work',
    scanned: { files, bytes: files * 512, skipped: [], truncated: false },
    findings: Array.from({ length: findings }, (_, index) => ({
      path: `src/file-${index + 1}.js`,
      line: index + 1,
      column: 1,
      ruleId: `ls-0${index + 1}`,
      guideId: 'css-anchor',
      confidence: 'high',
      message: 'Use the modern API instead.',
      snippet: 'legacy()',
    })),
    guides: [{ id: 'css-anchor', findings }],
    truncated: false,
  }
}

test('a 0.4.x state file without the fourth counter still loads and renders', async () => {
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, 'stats-legacy-'))
  const file = join(home, 'stats.json')
  await writeFile(file, JSON.stringify(legacyDocument()), 'utf8')

  try {
    const telemetry = createTelemetry({
      store: createFileStore({ file }),
      clock: () => NOW,
      retentionDays: 90,
      ringLimit: 1000,
      catalog: CATALOG,
    })

    const snapshot = await telemetry.snapshot({ days: 7 })
    assert.equal(snapshot.totals.calls, 5)
    assert.equal(snapshot.totals.byTool['legacy-scan'], undefined)
    assert.equal(snapshot.totals.files, 0)
    assert.equal(snapshot.totals.findings, 0)

    const text = renderReport(snapshot)
    assert.match(text, /Guidance usage: 5 calls/)
    assert.doesNotMatch(text, /legacy-scan/)
    assert.doesNotMatch(text, /Legacy scans/)

    const json = renderJson(snapshot)
    assert.equal('tools' in json, false)
    assert.equal('findings' in json, false)

    // Recording a new call on top of the old document must not invent scan counters either.
    await telemetry.record({ at: NOW, tool: 'search', outcome: 'hit', query: 'dialog' })
    const grown = await telemetry.snapshot({ days: 7 })
    assert.equal(grown.totals.calls, 6)
    assert.equal(grown.totals.files, 0)
    assert.equal(grown.totals.findings, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a legacy-scan call with findings is counted and rendered', async () => {
  const store = memoryStore()
  const telemetry = createTelemetry({
    store,
    clock: () => NOW,
    retentionDays: 90,
    ringLimit: 1000,
    catalog: CATALOG,
  })

  const classified = classifyCall({
    tool: 'web_guidance_legacy_scan',
    args: { paths: ['src'] },
    value: scanResult({ files: 12, findings: 2 }),
    isError: false,
  })
  assert.equal(classified.outcome, 'findings')
  assert.equal(classified.files, 12)
  assert.equal(classified.findings, 2)

  await telemetry.record({ at: NOW, tool: 'web_guidance_legacy_scan', ...classified })
  const snapshot = await telemetry.snapshot({ days: 7 })

  assert.equal(snapshot.totals.calls, 1)
  assert.equal(snapshot.totals.byTool['legacy-scan'], 1)
  assert.equal(snapshot.totals.byOutcome.findings, 1)
  assert.equal(snapshot.totals.files, 12)
  assert.equal(snapshot.totals.findings, 2)

  const text = renderReport(snapshot)
  assert.match(text, /Calls by tool: legacy-scan 1/)
  assert.match(text, /Legacy scans: 1 call, 12 files scanned, 2 findings/)

  const json = renderJson(snapshot)
  assert.deepEqual(json.tools, { 'legacy-scan': { total: 1, files: 12, findings: 2 } })
  assert.equal(json.findings, 2)
  assert.equal(json.totals.findings, 2)

  // The ring entry carries the scan volume, so a later analytics pass sees per-call detail.
  await telemetry.flush()
  assert.deepEqual(store.state.recent.at(-1), {
    at: NOW,
    tool: 'legacy-scan',
    outcome: 'findings',
    files: 12,
    findings: 2,
  })
})

test('a clean scan is clean, and a refused scan is still a counted error', async () => {
  const store = memoryStore()
  const telemetry = createTelemetry({
    store,
    clock: () => NOW,
    retentionDays: 90,
    ringLimit: 1000,
    catalog: CATALOG,
  })

  const clean = classifyCall({ tool: 'web_guidance_legacy_scan', value: scanResult({ files: 3, findings: 0 }) })
  assert.deepEqual(clean, { outcome: 'clean', files: 3, findings: 0 })

  // A ScanError comes back as a value, not a thrown error — the attempt must still count.
  const refused = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { error: 'path-outside', subject: '../outside', message: 'outside the workspace' },
  })
  assert.equal(refused.outcome, 'error')
  assert.equal(refused.isError, true)

  // The host may also mark the result itself as failed.
  const hostError = classifyCall({ tool: 'web_guidance_legacy_scan', isError: true })
  assert.equal(hostError.outcome, 'error')
  assert.equal(hostError.isError, true)

  await telemetry.record({ at: NOW, tool: 'web_guidance_legacy_scan', ...clean })
  await telemetry.record({ at: NOW, tool: 'web_guidance_legacy_scan', ...refused })

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.equal(snapshot.totals.calls, 2)
  assert.equal(snapshot.totals.byTool['legacy-scan'], 2)
  assert.equal(snapshot.totals.byOutcome.clean, 1)
  assert.equal(snapshot.totals.byOutcome.error, 1)
  assert.equal(snapshot.totals.files, 3)
  assert.equal(snapshot.totals.findings, 0)

  const text = renderReport(snapshot)
  assert.match(text, /Legacy scans: 2 calls, 3 files scanned, 0 findings/)

  await telemetry.flush()
  assert.equal(store.state.recent[1].isError, true)
  assert.equal(store.state.recent[1].files, 0)
  assert.equal(store.state.recent[1].findings, 0)
})

test('a legacy-scan result is counted through the plugin listener', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
    listener.handler(
      { name: 'web_guidance_legacy_scan', arguments: { paths: ['src'] } },
      { isError: false, value: scanResult({ files: 12, findings: 2 }) },
    )
    await settle()

    const command = registered.commands[0]
    const report = await command.handler({ rawInput: '' })
    assert.match(report.text, /Calls by tool: legacy-scan 1/)
    assert.match(report.text, /Legacy scans: 1 call, 12 files scanned, 2 findings/)

    const json = JSON.parse((await command.handler({ rawInput: '--json' })).text)
    assert.deepEqual(json.tools, { 'legacy-scan': { total: 1, files: 12, findings: 2 } })
    assert.equal(json.findings, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

//#endregion
