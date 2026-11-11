import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm as remove, stat as statFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

import { renderJson, renderReport } from '../lib/report.js'
import { RULES } from '../lib/scan-rules.js'
import { createFileStore } from '../lib/store.js'
import { classifyCall, createTelemetry, workspaceId } from '../lib/telemetry.js'

const scratch = join(import.meta.dirname, '..', '.tmp')

/**
 * How many times a teardown retries, and the pause before the next attempt: 25, 50, 75, 100 ms.
 *
 * Five attempts and a quarter of a second of patience covers the whole class this fixed — a Windows
 * handle released a moment late — without turning a genuinely broken teardown into a four-second
 * stall that hides the real error.
 */
const CLEAN_ATTEMPTS = 5
const CLEAN_PAUSE_MS = 25
/** The codes a retry can win: the handle is released and the directory goes. Others are raised at once. */
const CLEAN_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
/** The throwaway roots this file owns in `.tmp`, by the prefixes its own `mkdtemp` calls use. */
const OWNED_PREFIXES = ['stats-home-', 'stats-legacy-']
/** How long `settle` keeps watching a write in flight: 25 polls of 10 ms after the debounce's window. */
const SETTLE_POLLS = 25
const SETTLE_POLL_MS = 10

/**
 * Remove one throwaway path, retrying the way Windows needs.
 *
 * `rm -rf` is not one atomic step on this platform: after a write or a rename a directory can stay
 * busy for a moment — the OS indexer, a virus scanner, or a handle the previous `rename` has not
 * released yet — so a single attempt fails with `EBUSY` on a path that is gone a millisecond later.
 * That is exactly how one full-suite run in twenty went red, inside a teardown, with the product
 * assertions underneath it green.
 *
 * The retry lives here, in the harness, and nowhere else: `lib/` must not grow retry logic to make a
 * test happy. A code that cannot heal (`ENOENT` is already swallowed by `force`) is raised on the
 * first attempt, and the final failure names the path that stayed locked, so a red run says which
 * directory to look at instead of only which line.
 */
async function removeTree(path, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(path, { recursive: true, force: true, ...options })
      return
    } catch (error) {
      if (!CLEAN_RETRY_CODES.has(error.code)) throw error
      if (attempt >= CLEAN_ATTEMPTS) {
        throw new Error(
          `the temp path ${path} stayed locked (${error.code}) after ${CLEAN_ATTEMPTS} attempts`,
          { cause: error },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, CLEAN_PAUSE_MS * attempt))
    }
  }
}

/** `rm -rf` with that retry: every teardown in this file goes through one implementation. */
const rm = (path, options) => removeTree(path, options)

/**
 * Sweep what an earlier failed teardown left behind, before any test in this file makes a root.
 *
 * A directory that survived a flake must not be inherited by the next run: it is a phantom profile,
 * and the counters hash real paths, so it would quietly join a run it has nothing to do with. Only
 * the prefixes this file's own `mkdtemp` calls use are swept — `.tmp` also holds `store-test-*` roots
 * from `store.test.mjs` and files that belong to other tests, and a wildcard over `.tmp` is not this
 * file's to run.
 */
async function sweepOwnedRoots() {
  await mkdir(scratch, { recursive: true })
  const entries = await readdir(scratch, { withFileTypes: true })
  const stale = entries
    .filter((entry) => entry.isDirectory() && OWNED_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => join(scratch, entry.name))
  for (const path of stale) await removeTree(path)
  return stale.length
}

await sweepOwnedRoots()

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
  const registered = { tools: [], skills: [], commands: [], listeners: [], disposers: [] }
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
    effect: (create) => {
      // Disposing the plugin flushes the counters, which is how a test reads what was written down.
      const dispose = create()
      if (typeof dispose === 'function') registered.disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, registered }
}

/**
 * Let the fire-and-forget recording chain settle before reading the counters.
 *
 * The plugin debounces its write and `void`s the promise (`scheduleSave` in `index.js`), so nothing in
 * a test can await the flush — a fixed sleep is a guess, and at suite load it lost about once in
 * twenty runs: the read found no `stats.json` yet, or the teardown raced the write's `rename` and
 * answered `EBUSY`. So the wait is adaptive rather than a guess. It still gives the debounce its
 * window, then stops as soon as the counters file has stopped changing; while the write is in flight
 * (its `storage` directory already made, its file not yet renamed into place) it keeps waiting, and a
 * profile that is never written returns at once instead of burning the deadline.
 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
  const home = process.env.DSH_PROFILE_DIR
  if (typeof home !== 'string' || home === '') return
  const file = countersFile(home)
  let previous = null
  for (let attempt = 0; attempt < SETTLE_POLLS; attempt += 1) {
    const size = await sizeOf(file)
    if (size !== null && size === previous) return
    // A save makes the directory before it renames the file into place, so a missing file beside an
    // existing `storage/` is a write in progress; a missing `storage/` is a write that never came.
    if (size === null && !(await exists(dirname(file)))) return
    previous = size
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
  }
}

/** One path's size, or null when it does not exist — the one fact `settle` compares between polls. */
async function sizeOf(path) {
  try {
    return (await statFile(path)).size
  } catch {
    return null
  }
}

/** Whether a path exists, without caring what it is. */
async function exists(path) {
  return (await sizeOf(path)) !== null
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
  assert.deepEqual(registered.commands.map((command) => command.name), ['guidance-scan', 'guidance-suppress', 'guidance-scanignore', 'guidance-stats'])
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

  const report = await registered.commands.find((command) => command.name === 'guidance-stats').handler({ rawInput: '' })

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
  const command = registered.commands.find((entry) => entry.name === 'guidance-stats')

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

  const command = registered.commands.find((entry) => entry.name === 'guidance-stats')
  const refused = await command.handler({ rawInput: '--reset' })
  assert.match(refused.text, /Re-run \/guidance-stats --reset --yes/)

  const erased = await command.handler({ rawInput: '--reset --yes' })
  assert.match(erased.text, /Erased local usage counters \(1 call/)

  const empty = await command.handler({ rawInput: '' })
  assert.match(empty.text, /No calls recorded in the last 7 days/)

  await rm(home, { recursive: true, force: true })
})

test('enabled: false writes nothing and leaves only the scanner command', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, { enabled: false })

  assert.deepEqual(registered.commands.map((command) => command.name), ['guidance-scan', 'guidance-suppress', 'guidance-scanignore'])
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
function scanResult({ files, findings, muted = 0 }) {
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
      // A muted finding is still a finding: only the flag differs, which is what makes the
      // "a removal moves no counter" test meaningful — the counters counted it either way.
      ...(index >= findings - muted ? { suppressed: true } : {}),
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
  // Asserted field by field, not as the whole object: 0.6.0 added the per-rule and per-guide id
  // lists to the scan classification, and a clean scan names none of them.
  assert.equal(clean.outcome, 'clean')
  assert.equal(clean.files, 3)
  assert.equal(clean.findings, 0)
  assert.deepEqual(clean.rules, [])
  assert.deepEqual(clean.guides, [])

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

    const command = registered.commands.find((entry) => entry.name === 'guidance-stats')
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

test('/guidance-stats --json describes the scan ids the host knows', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
    // A finding naming a real rule and a real guide, so the command can describe both from the
    // tables the plugin already loads: the rule table it registers and the catalog it counts against.
    listener.handler(
      { name: 'web_guidance_legacy_scan', arguments: { paths: ['src'] } },
      {
        isError: false,
        value: {
          ...scanResult({ files: 4, findings: 0 }),
          findings: [
            {
              path: 'src/legacy.js',
              line: 12,
              column: 3,
              ruleId: 'ls-17',
              guideId: 'html',
              confidence: 'medium',
              message: 'the finding message is the scanner\'s, not the report\'s',
              snippet: 'document.write("<p>")',
            },
          ],
          guides: [{ id: 'html', findings: 1 }],
        },
      },
    )
    await settle()

    const command = registered.commands.find((entry) => entry.name === 'guidance-stats')
    const json = JSON.parse((await command.handler({ rawInput: '--json' })).text)
    const rule = RULES.find((entry) => entry.id === 'ls-17')
    const catalog = JSON.parse(await readFile(new URL('../data/guides.json', import.meta.url), 'utf8'))
    const guide = catalog.find((entry) => entry.id === 'html')

    // The flag documents that both lists are lifetime totals, not filtered by --days.
    assert.equal(json.scanCountsScope, 'lifetime')
    // The sentence and confidence come from the rule table, not from the finding the scan raised.
    const [ruleRow] = json.topRules
    assert.deepEqual(
      { ...ruleRow, firstSeen: '<day>', lastSeen: '<day>' },
      {
        ruleId: 'ls-17',
        count: 1,
        message: rule.message,
        confidence: rule.confidence,
        guideId: rule.guideId,
        firstSeen: '<day>',
        lastSeen: '<day>',
      },
    )
    // One scan saw the rule once, so both days are that scan's day — a real date, not a guess.
    assert.match(ruleRow.firstSeen, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(ruleRow.firstSeen, ruleRow.lastSeen)
    assert.deepEqual(json.topScanGuides, [
      { guideId: 'html', count: 1, description: guide.description },
    ])

    // The text report is a counter, not evidence: it names ids and numbers only, as before.
    const text = await command.handler({ rawInput: '' })
    assert.match(text.text, /^Most matched rules: ls-17 1$/m)
    assert.doesNotMatch(text.text, /createElement/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

//#endregion

//#region 0.10.0: which workspace the numbers belong to

/**
 * A throwaway directory to act as one session workspace. The counters hash the `realpath` of a path,
 * so these are real directories that both the scan and the command can be pointed at.
 */
async function workspaceDir(prefix) {
  await mkdir(scratch, { recursive: true })
  return mkdtemp(join(scratch, `${prefix}-`))
}

/** The session header a host hands a tool and a command for one workspace. */
function headerAt(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** A scan value as `runScanRequest` returns it, attributed to one real workspace. */
function scanAt(cwd, options) {
  return { ...scanResult(options), cwd }
}

/** Raise one finished scan the way the host does, so the counters record it. */
function raiseScan(registered, value) {
  const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
  listener.handler(
    { name: 'web_guidance_legacy_scan', arguments: { paths: ['src'] } },
    { isError: false, value },
  )
}

/** The stats command of a context that has had `apply()` run on it. */
function statsCommand(registered) {
  return registered.commands.find((entry) => entry.name === 'guidance-stats')
}

test('the default report is the session workspace, and --workspace switches it by name and id', async () => {
  const home = await isolatedHome()
  const first = await workspaceDir('app')
  const second = await workspaceDir('site')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    // The value carries the workspace that was read: that is the only attribution path there is.
    raiseScan(registered, scanAt(first, { files: 3, findings: 2 }))
    raiseScan(registered, scanAt(second, { files: 4, findings: 1 }))
    await settle()

    const command = statsCommand(registered)
    // No selector: the session header's workspace, not the aggregate and not the process directory.
    const report = await command.handler({ rawInput: '', ...headerAt(first) })
    assert.ok(report.text.includes(`Workspace: ${basename(first)} (${workspaceId(realpathSync(first))})`),
      'the default report does not name the session workspace')
    assert.match(report.text, /^Last scan: \d{4}-\d{2}-\d{2}, 3 files, 2 findings/m)
    // The other workspace's scan is not in this report.
    assert.doesNotMatch(report.text, /4 files, 1 finding/)

    // By exact name — what a person types.
    const byName = await command.handler({ rawInput: `--workspace ${basename(second)}` })
    assert.match(byName.text, /^Workspace: /m)
    assert.ok(byName.text.includes(basename(second)))
    assert.match(byName.text, /^Last scan: \d{4}-\d{2}-\d{2}, 4 files, 1 finding \(rules: ls-01\)$/m)

    // By id — what a refusal prints and what the panel's switcher sends.
    const listed = JSON.parse((await command.handler({ rawInput: '--json', ...headerAt(first) })).text)
    const secondRow = listed.workspaces.find((row) => row.name === basename(second))
    assert.ok(secondRow !== undefined, 'the switcher list does not carry the second workspace')
    const byId = await command.handler({ rawInput: `--workspace ${secondRow.id}` })
    assert.ok(byId.text.includes(`Workspace: ${basename(second)} (${secondRow.id})`))
    assert.match(byId.text, /^Last scan: \d{4}-\d{2}-\d{2}, 4 files, 1 finding \(rules: ls-01\)$/m)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('a workspace with no scans yet is named, not silently aggregated', async () => {
  const home = await isolatedHome()
  const dir = await workspaceDir('fresh')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const command = statsCommand(registered)
    const report = await command.handler({ rawInput: '', ...headerAt(dir) })
    const id = workspaceId(realpathSync(dir))

    assert.ok(report.text.includes(`Workspace: ${basename(dir)} (${id})`))
    assert.doesNotMatch(report.text, /all workspaces/)

    // The counters hold no bucket, but the report still says whose empty report it is — and the
    // switcher honestly lists nothing, because nothing has been scanned.
    const json = JSON.parse((await command.handler({ rawInput: '--json', ...headerAt(dir) })).text)
    assert.deepEqual(json.workspace, { id, name: basename(dir) })
    assert.deepEqual(json.workspaces, [])
    assert.equal(json.workspace.id, id)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a session header the report aggregates and says why', async () => {
  const home = await isolatedHome()
  const dir = await workspaceDir('headerless')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    raiseScan(registered, scanAt(dir, { files: 2, findings: 1 }))
    await settle()

    const command = statsCommand(registered)
    // The invocation carries no header at all: process.cwd() must not stand in for the project.
    const report = await command.handler({ rawInput: '' })
    assert.match(report.text, /^Workspace: all workspaces \(no session workspace could be resolved, so every workspace is counted\)$/m)
    assert.doesNotMatch(report.text, new RegExp(`Workspace: ${basename(dir)}`))

    // An explicit --all is the reader's own choice and needs no excuse.
    const explicit = await command.handler({ rawInput: '--all', ...headerAt(dir) })
    assert.match(explicit.text, /^Workspace: all workspaces$/m)
    assert.doesNotMatch(explicit.text, /could not be resolved/)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown or ambiguous selector is an error that lists what exists', async () => {
  const home = await isolatedHome()
  const first = await workspaceDir('known')
  const second = await workspaceDir('other')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    raiseScan(registered, scanAt(first, { files: 1, findings: 1 }))
    await settle()

    const command = statsCommand(registered)
    const unknown = await command.handler({ rawInput: '--workspace no-such-project', ...headerAt(second) })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /Error: unknown workspace "no-such-project"/)
    // Not a silent aggregate: the error names the workspace that exists, with its id.
    assert.ok(unknown.text.includes(`${basename(first)} (${workspaceId(realpathSync(first))})`))
    assert.match(unknown.text, /Omit --workspace to count every workspace\./)

    // A path selects by identity, and an absolute one needs no session header to resolve.
    const byPath = await command.handler({ rawInput: `--workspace ${realpathSync(first)}`, ...headerAt(second) })
    assert.equal(byPath.kind, 'success')
    assert.match(byPath.text, /^Last scan: \d{4}-\d{2}-\d{2}, 1 file, 1 finding \(rules: ls-01\)$/m)

    // A bare --workspace is half a flag, not "count everything".
    const bare = await command.handler({ rawInput: '--workspace', ...headerAt(first) })
    assert.equal(bare.kind, 'error')
    assert.match(bare.text, /^Error: --workspace needs a workspace name, id or path/m)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('--workspace and --all together are refused before anything is read', async () => {
  const home = await isolatedHome()
  const dir = await workspaceDir('both')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    raiseScan(registered, scanAt(dir, { files: 1, findings: 1 }))
    await settle()

    const command = statsCommand(registered)
    for (const rawInput of [`--workspace ${basename(dir)} --all`, `--all --workspace=${basename(dir)}`]) {
      const refused = await command.handler({ rawInput, ...headerAt(dir) })
      assert.equal(refused.kind, 'error', `${rawInput} was not refused`)
      assert.match(refused.text, /--workspace and --all cannot be combined/)
    }
    // Nothing was rendered as a report, and --json does not soften the refusal either.
    const json = await command.handler({ rawInput: `--workspace ${basename(dir)} --all --json` })
    assert.equal(json.kind, 'error')
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a scan run through the tool is attributed to the workspace it read', async () => {
  const home = await isolatedHome()
  const dir = await workspaceDir('tool-ws')
  await writeFile(join(dir, 'legacy.js'), 'document.write("<p>hi</p>")\n', 'utf8')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    const value = await tool.execute({ paths: ['legacy.js'] }, headerAt(dir))
    assert.equal(value.cwd, dir)

    // The tool's return value is not the counters' trigger in this fake host: raise the event the
    // host raises, exactly as test/scan-command.test.mjs does.
    raiseScan(registered, value)
    await settle()

    const command = statsCommand(registered)
    const report = await command.handler({ rawInput: '', ...headerAt(dir) })
    assert.ok(report.text.includes(`Workspace: ${basename(dir)} (${workspaceId(realpathSync(dir))})`))
    assert.match(report.text, /^Most matched rules: ls-17 1$/m)

    // The same numbers are the aggregate's, and no other workspace exists.
    const json = JSON.parse((await command.handler({ rawInput: '--json', ...headerAt(dir) })).text)
    assert.equal(json.workspace.name, basename(dir))
    assert.equal(json.workspaces.length, 1)
    assert.equal(json.workspaces[0].findings, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('the legacy root counters appear as the _unattributed workspace and stay selectable', async () => {
  const home = await isolatedHome()
  const dir = await workspaceDir('legacy-root')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    // A scan whose value carries no cwd is a pre-D caller: its debt stays in the root counters.
    const { cwd: _ignored, ...headerless } = scanResult({ files: 6, findings: 3 })
    raiseScan(registered, headerless)
    await settle()

    const command = statsCommand(registered)
    // The aggregate carries the legacy last scan; the session's own scoped report below must not.
    const json = JSON.parse((await command.handler({ rawInput: '--json --all' })).text)
    const legacy = json.workspaces.find((row) => row.id === '_unattributed')
    assert.deepEqual(legacy, {
      id: '_unattributed',
      name: '',
      findings: 3,
      rules: 3,
      lastScanAt: json.lastScan.at,
    })

    // The synthetic bucket is selectable like any other workspace, and it is not the session's.
    const report = await command.handler({ rawInput: '--workspace _unattributed', ...headerAt(dir) })
    assert.match(report.text, /^Workspace: _unattributed$/m)
    assert.match(report.text, /^Last scan: \d{4}-\d{2}-\d{2}, 6 files, 3 findings/m)

    // The session workspace itself has no bucket: it is named, and its detail is empty, not the
    // legacy numbers copied into it.
    const session = await command.handler({ rawInput: '', ...headerAt(dir) })
    assert.ok(session.text.includes(`Workspace: ${basename(dir)}`))
    assert.doesNotMatch(session.text, /Last scan:/)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('two checkouts with one name are refused by name and selected by id or relative path', async () => {
  const home = await isolatedHome()
  const leftParent = await workspaceDir('checkout')
  const rightParent = await workspaceDir('checkout')
  const left = join(leftParent, 'app')
  const right = join(rightParent, 'app')
  await mkdir(left, { recursive: true })
  await mkdir(right, { recursive: true })
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    raiseScan(registered, scanAt(left, { files: 2, findings: 1 }))
    raiseScan(registered, scanAt(right, { files: 5, findings: 2 }))
    await settle()

    const command = statsCommand(registered)
    const leftId = workspaceId(realpathSync(left))
    const rightId = workspaceId(realpathSync(right))

    // Two checkouts of one project share a directory name. Guessing would attach one project's
    // numbers to the other, so the name is refused and both ids are named instead.
    const ambiguous = await command.handler({ rawInput: '--workspace app', ...headerAt(left) })
    assert.equal(ambiguous.kind, 'error')
    assert.match(ambiguous.text, /names 2 workspaces/)
    assert.ok(ambiguous.text.includes(leftId))
    assert.ok(ambiguous.text.includes(rightId))

    // A path is unambiguous, and a relative one is read from the session directory — never from the
    // plugin process's own working directory.
    const relative = await command.handler({ rawInput: '--workspace ./app', ...headerAt(leftParent) })
    assert.equal(relative.kind, 'success')
    assert.ok(relative.text.includes(`Workspace: app (${leftId})`))
    assert.match(relative.text, /^Last scan: \d{4}-\d{2}-\d{2}, 2 files, 1 finding/m)

    // The other checkout, by the id a refusal prints.
    const byId = await command.handler({ rawInput: `--workspace ${rightId}` })
    assert.ok(byId.text.includes(`Workspace: app (${rightId})`))
    assert.match(byId.text, /^Last scan: \d{4}-\d{2}-\d{2}, 5 files, 2 findings/m)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(leftParent, { recursive: true, force: true })
    await rm(rightParent, { recursive: true, force: true })
  }
})

//#endregion

//#region 0.10.0: what the report says about when a scan happened

/** The state document the counters write for the active profile. */
function countersFile(home) {
  return join(home, 'storage', 'modern-web-guidance', 'stats.json')
}

/** The ring rows of a text report, so a block can be compared as rows rather than as a substring. */
function historyRowsOf(text) {
  return text.split('\n').filter((line) => /^ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} - /.test(line))
}

test('a scan call still returns the value and the text it always did, byte for byte', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('scan-shape')
  await writeFile(join(workspace, 'legacy.js'), 'document.write("<p>hi</p>")\n', 'utf8')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    const value = await tool.execute({ paths: ['.'] }, headerAt(workspace))

    // The whole value, member for member: a member gained, lost or renamed by a surface change fails
    // here rather than at a user's scan. 0.12.0 adds exactly two: every finding carries its `siteId`
    // (a mute target, even when no suppression file exists) and the result carries `suppressed: 0`.
    assert.deepEqual({ ...value, cwd: '<workspace>' }, {
      format: 'summary',
      cwd: '<workspace>',
      scanned: {
        files: 1,
        bytes: 28,
        skipped: [],
        skippedTotal: 0,
        skippedByReason: {},
        ignoreProblems: [],
        truncated: false,
      },
      findings: [{
        path: 'legacy.js',
        line: 1,
        column: 1,
        ruleId: 'ls-17',
        guideId: 'html',
        confidence: 'medium',
        message: 'Build the DOM with createElement/append instead of document.write(), which discards the parsed document.',
        snippet: 'document.write("<p>hi</p>")',
        lines: [1],
        occurrences: 1,
        siteId: '3b21c842',
      }],
      guides: [{ id: 'html', findings: 1 }],
      truncated: false,
      suppressed: 0,
    })

    // And the rendered text, character for character, through the one renderer both surfaces share.
    assert.equal(
      tool.output.render({ paths: ['.'] }, value)[0].text,
      'Scanned 1 file(s) (28 B) — 1 finding(s).\n' +
      '- legacy.js:1:1 ls-17 (medium) Build the DOM with createElement/append instead of document.write(), which discards the parsed document.\n' +
      'Load with web_guidance_retrieve: html (1).',
    )
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('the ignore audit is stored as two counts, and no pattern text reaches stats.json', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('ignore-audit')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'app.js'), 'document.write("<p>hi</p>")\n', 'utf8')
  // The distinctive line is the whole point of this test: a `.scanignore` entry is a path fragment
  // from one project, and `stats.json` is one profile-wide file serving every project.
  const DISTINCTIVE = 'src/very-specific-path/'
  await writeFile(join(workspace, '.scanignore'), `${DISTINCTIVE}\ngone/\n`, 'utf8')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    const value = await tool.execute({ paths: ['.'] }, headerAt(workspace))
    // The scan value carries the rows, patterns and all: they are what the session that ran the scan
    // sees, and they never leave it.
    assert.deepEqual(value.scanned.ignoreUsage, [
      { line: 1, pattern: DISTINCTIVE, matched: false },
      { line: 2, pattern: 'gone/', matched: false },
    ])

    raiseScan(registered, value)
    await settle()
    // Disposing the plugin flushes the counters, which is the only way to read what was written down.
    for (const dispose of registered.disposers) dispose()
    await settle()

    const raw = await readFile(countersFile(home), 'utf8')
    assert.equal(raw.includes('very-specific-path'), false, 'stats.json kept a .scanignore pattern')
    assert.equal(raw.includes('gone/'), false, 'stats.json kept a .scanignore pattern')
    const document = JSON.parse(raw)
    const bucket = Object.values(document.workspaces).find((entry) => entry.lastScan !== undefined)
    assert.deepEqual(bucket.lastScan.ignoreUsage, { patterns: 2, idle: 2 })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('two scans of one workspace produce the comparison line and a two-row ring', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('scan-story')
  const file = join(workspace, 'legacy.js')
  await writeFile(file, 'document.write("<p>hi</p>")\n', 'utf8')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    const command = statsCommand(registered)
    const header = headerAt(workspace)
    // Each scan is the tool's own value raised through the host's event, so the counters see exactly
    // what a real scan call produces — nothing is fabricated for the history.
    const scan = async () => {
      raiseScan(registered, await tool.execute({ paths: ['.'] }, header))
      await settle()
    }
    const report = async (rawInput = '') => (await command.handler({ rawInput, ...header })).text

    await scan()
    const first = await report()
    // A first scan has no baseline, so the report promises the comparison instead of showing zeroes.
    assert.match(first, /^No earlier scan to compare with; the next scan will be compared\.$/m)
    assert.match(first, /^Recent scans:$/m)
    assert.equal(historyRowsOf(first).length, 1)
    assert.doesNotMatch(first, /no longer present/)

    // The fix that lands: the site is gone, the file is still there and still the only file read.
    await writeFile(file, 'const p = document.createElement("p")\n', 'utf8')
    await scan()
    const second = await report()
    assert.match(second, /^Since the scan of \d{4}-\d{2}-\d{2} \d{2}:\d{2}: 1 no longer present, 0 still open, 0 new$/m)
    assert.equal(historyRowsOf(second).length, 2)
    assert.doesNotMatch(second, /\bfixed\b/i)

    const json = JSON.parse(await report('--json'))
    assert.equal(json.scanHistory.length, 2)
    // Newest first: the clean scan is the one that resolved the site.
    assert.equal(json.scanHistory[0].outcome, 'clean')
    assert.deepEqual(json.scanHistory[0].diff, { resolved: 1, stillOpen: 0, new: 0 })
    assert.equal(json.scanDiff.partial, null)
    assert.equal(json.scanDiff.resolved, 1)
    assert.equal(json.scanDiff.stillOpen, 0)
    assert.equal(json.scanDiff.new, 0)
    assert.equal(json.scanCountsScope, 'lifetime')
    // The series is windowed data, the ring is not: the report keeps the ring across the 7/30 switch.
    assert.ok(Array.isArray(json.scanSeries))
    const wider = JSON.parse(await report('--days 30 --json'))
    assert.equal(wider.scanHistory.length, 2)
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('the counters are given the rule table, so a table change can be detected', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('scan-rules')
  await writeFile(join(workspace, 'legacy.js'), 'document.write("<p>hi</p>")\n', 'utf8')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    raiseScan(registered, await tool.execute({ paths: ['.'] }, headerAt(workspace)))
    await settle()

    // The baseline records the size of the table at scan time. Without `ruleIds` the counters would
    // claim no table at all, and a plugin upgrade that adds a rule would report every site of it as
    // new instead of suppressing the comparison.
    for (const dispose of registered.disposers) dispose()
    await settle()
    const stored = JSON.parse(await readFile(countersFile(home), 'utf8'))
    const buckets = Object.values(stored.workspaces)
    assert.equal(buckets.length, 1)
    assert.equal(buckets[0].lastSites.ruleCount, RULES.length)
    assert.equal(buckets[0].scanHistory.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

//#endregion


test('a suppressed finding reaches the report as its own line and never as a fix', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('scan-suppressed')
  await writeFile(join(workspace, 'legacy.js'), 'document.write("<p>hi</p>")\n', 'utf8')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    const command = statsCommand(registered)
    const header = headerAt(workspace)
    const scan = async () => {
      // The value is shaped once and raised through the host event, exactly as a real call would be.
      const value = await tool.execute({ paths: ['.'] }, header)
      raiseScan(registered, value)
      await settle()
      return value
    }
    const report = async (rawInput = '') => (await command.handler({ rawInput, ...header })).text

    await scan()
    assert.doesNotMatch(await report(), /Suppressed:/)

    const value = await tool.execute({ paths: ['.'] }, header)
    const id = value.findings[0].siteId
    const suppress = registered.commands.find((entry) => entry.name === 'guidance-suppress')
    assert.ok(suppress !== undefined)
    // The panel's two lines: the plan, then the write.
    const planned = await suppress.handler({ rawInput: `${id} --dry-run`, ...header })
    assert.equal(planned.kind, 'success')
    assert.match(planned.text, /Nothing has been written/)
    const applied = await suppress.handler({ rawInput: id, ...header })
    assert.equal(applied.kind, 'success')

    const muted = await scan()
    assert.equal(muted.suppressed, 1)

    const text = await report()
    assert.match(text, /^Suppressed: 1 in the last scan \(ls-17 1\) - muted, still findings$/m)
    // The same scan, same site, same finding count: one is muted and nothing was fixed.
    assert.match(text, /^Last scan: \d{4}-\d{2}-\d{2}, 1 file, 1 finding \(rules: ls-17\)/m)
    assert.match(text, /^Since the scan of \d{4}-\d{2}-\d{2} \d{2}:\d{2}: 0 no longer present, 1 still open, 0 new$/m)

    const json = JSON.parse(await report('--json'))
    assert.equal(json.lastScan.suppressed, 1)
    assert.deepEqual(json.lastScan.suppressedRules, { 'ls-17': 1 })
    assert.equal(json.lastScan.findings, 1)
    assert.equal('suppressed' in json, false)
    assert.equal(json.scanHistory[0].suppressed, 1)
    assert.equal(json.scanDiff.resolved, 0)
    assert.equal(json.scanDiff.stillOpen, 1)
    assert.equal(json.scanDiff.new, 0)
    assert.equal(json.scanDiff.partial, null)
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

//#region 0.12.0: a reset erases a named slice, and the suppression file is never a counter

/**
 * The suppression file a workspace may carry: a real one, with real bytes, so "no reset touches it"
 * is a byte comparison and not a claim about a path the test never wrote.
 */
const SUPPRESS_BYTES = `{
  "version": 1,
  "entries": {
    "96cb61de": { "reason": "legacy page, tracked in #412", "at": "2026-11-11" }
  }
}
`

test('a scans reset keeps every call counter, and never touches the suppression file', async () => {
  const home = await isolatedHome()
  const alpha = await workspaceDir('reset-app')
  const beta = await workspaceDir('reset-site')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
    listener.handler(
      { name: 'web_guidance_search', arguments: { query: 'dialog light dismiss' } },
      { isError: false, value: { results: [{ id: 'css-anchor', category: 'css' }] } },
    )
    raiseScan(registered, scanAt(alpha, { files: 4, findings: 2 }))
    raiseScan(registered, scanAt(beta, { files: 1, findings: 1 }))
    await settle()
    await writeFile(join(alpha, '.suppress'), SUPPRESS_BYTES, 'utf8')

    const command = statsCommand(registered)
    const planned = await command.handler({ rawInput: '--reset --scan-only', ...headerAt(alpha) })
    assert.equal(planned.kind, 'success')
    // A plan, not a write: the selector travels in its own sentence so the confirmation is exact.
    assert.match(planned.text, /^This would erase the scan counters of 2 workspace\(s\): findings, rules, guides, history and baselines\./)
    assert.match(planned.text, /Re-run \/guidance-stats --reset --yes --scan-only to erase them\.$/)
    assert.equal(await readFile(join(alpha, '.suppress'), 'utf8'), SUPPRESS_BYTES)

    const erased = await command.handler({ rawInput: '--reset --yes --scan-only', ...headerAt(alpha) })
    assert.equal(erased.kind, 'success')
    assert.match(erased.text, /^Erased the scan counters of 2 workspace\(s\): 3 finding\(s\) and 2 scan\(s\) of history\./)
    assert.match(erased.text, /Every call counter, including how many scans were run, stays\./)
    assert.match(erased.text, /The suppression file was not touched: muting is not a counter\.$/)
    assert.equal(await readFile(join(alpha, '.suppress'), 'utf8'), SUPPRESS_BYTES, 'the list survives the erasure')

    const document = JSON.parse(await readFile(countersFile(home), 'utf8'))
    assert.equal(document.version, 1, 'additive only: the document keeps its version')
    assert.deepEqual(document.workspaces, {})
    assert.deepEqual(document.scanRules, {})
    assert.deepEqual(document.byCategory, { css: 1 }, 'lifetime category coverage is a guidance counter')
    assert.ok(document.calls > 0, 'the call counter survives a scan reset')

    // The report still counts the calls; only the findings are gone.
    const report = await command.handler({ rawInput: '', ...headerAt(alpha) })
    assert.match(report.text, /1 call/)
    assert.match(report.text, /0 finding/)
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
    await rm(beta, { recursive: true, force: true })
  }
})

test('a workspace reset erases one bucket and leaves the other workspace standing', async () => {
  const home = await isolatedHome()
  const alpha = await workspaceDir('reset-only-app')
  const beta = await workspaceDir('reset-only-site')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
    listener.handler(
      { name: 'web_guidance_search', arguments: { query: 'dialog light dismiss' } },
      { isError: false, value: { results: [{ id: 'css-anchor', category: 'css' }] } },
    )
    raiseScan(registered, scanAt(alpha, { files: 4, findings: 2 }))
    raiseScan(registered, scanAt(beta, { files: 1, findings: 1 }))
    await settle()
    await writeFile(join(alpha, '.suppress'), SUPPRESS_BYTES, 'utf8')

    const command = statsCommand(registered)
    // The name is what a person types; the refusal below proves the list it is checked against.
    const alphaName = basename(alpha)
    const erased = await command.handler({ rawInput: `--reset --yes --workspace ${alphaName}`, ...headerAt(alpha) })
    assert.equal(erased.kind, 'success')
    assert.match(erased.text, new RegExp(`^Erased the scan counters of ${alphaName} \\([0-9a-f]{8}\\): 2 finding\\(s\\) and 1 scan\\(s\\) of history\\.`))
    assert.match(erased.text, /Every other workspace and every call counter stays\./)
    assert.equal(await readFile(join(alpha, '.suppress'), 'utf8'), SUPPRESS_BYTES)

    const document = JSON.parse(await readFile(countersFile(home), 'utf8'))
    assert.equal(document.workspaces[workspaceId(realpathSync(alpha))], undefined)
    assert.ok(document.workspaces[workspaceId(realpathSync(beta))] !== undefined, 'the other bucket is untouched')

    // The surviving workspace still reports its own findings, and its name is still what it was.
    const report = await command.handler({ rawInput: `--workspace ${basename(beta)}`, ...headerAt(alpha) })
    assert.match(report.text, new RegExp(`Workspace: ${basename(beta)} \\([0-9a-f]{8}\\)`))
    assert.match(report.text, /1 finding/)
    // The erased workspace is not a row any more, so asking for it is the same refusal a workspace
    // that never scanned gets — never a report that borrows somebody else's numbers.
    const gone = await command.handler({ rawInput: `--workspace ${alphaName}`, ...headerAt(alpha) })
    assert.equal(gone.kind, 'error')
    assert.match(gone.text, /^Error: unknown workspace /)
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
    await rm(beta, { recursive: true, force: true })
  }
})

test('a bare --reset --yes still wipes exactly what it always wiped, and only the counters', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('reset-all')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
    listener.handler(
      { name: 'web_guidance_search', arguments: { query: 'nothing matches this' } },
      { isError: false, value: { results: [] } },
    )
    raiseScan(registered, scanAt(workspace, { files: 3, findings: 2 }))
    await settle()
    await writeFile(join(workspace, '.suppress'), SUPPRESS_BYTES, 'utf8')

    const command = statsCommand(registered)
    const erased = await command.handler({ rawInput: '--reset --yes', ...headerAt(workspace) })
    // The 0.4.0 sentence, unchanged: a narrower default would be a silent behaviour change.
    assert.match(erased.text, /^Erased local usage counters \(2 call\(s\) in the last 7 day\(s\)\)\. Tool behaviour is unchanged\.$/)
    assert.equal(await readFile(join(workspace, '.suppress'), 'utf8'), SUPPRESS_BYTES)

    const document = JSON.parse(await readFile(countersFile(home), 'utf8'))
    assert.equal(document.version, 1)
    assert.equal(document.calls, 0)
    assert.deepEqual(document.byDay, {})
    assert.deepEqual(document.scanRules, {})
    assert.deepEqual(document.workspaces, {})
    assert.deepEqual(document.recent, [])

    const empty = await command.handler({ rawInput: '', ...headerAt(workspace) })
    assert.match(empty.text, /No calls recorded in the last 7 days/)
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a reset names one slice, and a selector it cannot honour is refused before anything is erased', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('reset-refuse')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    raiseScan(registered, scanAt(workspace, { files: 2, findings: 1 }))
    await settle()

    const command = statsCommand(registered)
    const conflict = await command.handler({ rawInput: '--reset --yes --scan-only --workspace app', ...headerAt(workspace) })
    assert.equal(conflict.kind, 'error')
    assert.match(conflict.text, /^Error: a reset erases one slice at a time, and --scan-only, --workspace cannot be combined\./)
    assert.match(conflict.text, /Pass one of --scan-only, --workspace or --days, or none to erase every counter\.$/)

    const zero = await command.handler({ rawInput: '--reset --yes --days 0', ...headerAt(workspace) })
    assert.equal(zero.kind, 'error')
    assert.match(zero.text, /^Error: --days needs a whole number of days, at least 1,/)

    const unknown = await command.handler({ rawInput: '--reset --yes --workspace nope', ...headerAt(workspace) })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /^Error: unknown workspace "nope"\. Known workspaces: /)
    assert.match(unknown.text, /Omit --workspace to count every workspace\.$/)

    // Nothing was erased: the report still counts the scan the three refusals were asked to remove.
    const report = await command.handler({ rawInput: '', ...headerAt(workspace) })
    assert.match(report.text, /1 call/)
    assert.match(report.text, /1 finding/)
    assert.match(report.text, new RegExp(`Workspace: ${basename(workspace)} \\([0-9a-f]{8}\\)`))
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a window reset through the command erases the window and keeps the lifetime totals', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('reset-window')
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  try {
    apply(ctx, {})
    raiseScan(registered, scanAt(workspace, { files: 2, findings: 2 }))
    await settle()
    await writeFile(join(workspace, '.suppress'), SUPPRESS_BYTES, 'utf8')

    const command = statsCommand(registered)
    const erased = await command.handler({ rawInput: '--reset --yes --days 7', ...headerAt(workspace) })
    assert.equal(erased.kind, 'success')
    assert.match(erased.text, /^Erased the counters recorded in the last 7 day\(s\): 1 call\(s\), 2 finding\(s\) and 1 scan\(s\) of history\./)
    assert.match(erased.text, /Lifetime rule and guide totals carry no day, so they stay\./)
    assert.equal(await readFile(join(workspace, '.suppress'), 'utf8'), SUPPRESS_BYTES)

    const document = JSON.parse(await readFile(countersFile(home), 'utf8'))
    assert.equal(document.version, 1)
    assert.deepEqual(Object.keys(document.byDay), [], 'the window row is gone')
    const bucket = document.workspaces[workspaceId(realpathSync(workspace))]
    assert.deepEqual(bucket.scanByDay, {})
    assert.equal(bucket.lastScan, null)
    // Lifetime members carry no day, so a window cannot claim them: the rule totals are still exact.
    assert.deepEqual(bucket.scanRules, { 'ls-01': 1, 'ls-02': 1 })
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

//#endregion

//#region 0.12.0 / ADR-0004: a removal is not a fix, and it moves no counter

/**
 * The test ADR-0004 §5 exists for. A removal edits one file and one file only: the `.suppress` it
 * was told to shrink. Every number the product keeps must survive it untouched — the lifetime
 * counters, the last-scan block, the history rings, the site baseline — because "the entry is gone"
 * is a statement about a mute, never about a finding.
 *
 * It is a *file* test, not a return-value test: the counters are flushed to disk before and after the
 * removal, across a wait long enough for the debounced save to have fired either way, so a removal
 * that quietly recorded an event would be visible as a byte. The report is compared too, because the
 * document is what a person reads.
 */
test('a removal changes the suppression file and no counter anywhere else', async () => {
  const home = await isolatedHome()
  const workspace = await workspaceDir('remove-counters')
  const { apply } = await import('../index.js')
  const { serializeSuppressions } = await import('../lib/suppress.js')
  const { ctx, registered } = createContext()
  // Longer than the counters' own save debounce, so a write that was going to happen has happened.
  const pastDebounce = () => new Promise((resolve) => setTimeout(resolve, 2200))

  try {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src/legacy.js'), 'document.write("<p>hi</p>")\n', 'utf8')
    const suppressionFile = join(workspace, '.suppress')
    await writeFile(suppressionFile, serializeSuppressions({
      aaaaaaaa: { reason: 'stale', at: '2026-02-02' },
      bbbbbbbb: { reason: 'kept', at: '2026-03-03' },
    }), 'utf8')

    apply(ctx, {})
    // One completed scan, muted or not: the counters now hold a last scan, a history row, a day row
    // and a site baseline, which is every member a removal could conceivably disturb.
    raiseScan(registered, scanAt(workspace, { files: 1, findings: 1, muted: 1 }))
    await settle()
    const command = statsCommand(registered)
    const suppress = registered.commands.find((entry) => entry.name === 'guidance-suppress')

    const reportBefore = (await command.handler({ rawInput: '--json', ...headerAt(workspace) })).text
    const textBefore = (await command.handler({ rawInput: '', ...headerAt(workspace) })).text
    await pastDebounce()
    const bytesBefore = await readFile(countersFile(home), 'utf8')

    // The removal itself: one entry, confirmed, no --dry-run.
    const removed = await suppress.handler({ rawInput: '--remove aaaaaaaa', ...headerAt(workspace) })
    assert.equal(removed.kind, 'success')
    assert.match(removed.text, /A removal is not a fix: it does not mean the finding went away, and no counter has changed\.$/)
    // The one file that was allowed to change, changed — so the assertions below are about a real
    // removal and not about a refusal that never ran.
    const after = await readFile(suppressionFile, 'utf8')
    assert.ok(!after.includes('aaaaaaaa'))
    assert.ok(after.includes('bbbbbbbb'))

    // The report is the document a person reads. The JSON is compared byte for byte; the text has
    // exactly one member that moves on its own — the generation stamp on the period line — so only
    // that fragment is masked, and everything else must still be character-identical.
    assert.equal((await command.handler({ rawInput: '--json', ...headerAt(workspace) })).text, reportBefore)
    const undated = (text) => text.replace(/\(generated [^)]*\)/, '(generated …)')
    const textAfter = (await command.handler({ rawInput: '', ...headerAt(workspace) })).text
    assert.equal(undated(textAfter), undated(textBefore))

    // And the bytes on disk are the same bytes, after long enough for any save to have fired.
    await pastDebounce()
    assert.equal(await readFile(countersFile(home), 'utf8'), bytesBefore)

    // The last scan still claims its mute: the anchor, in case the byte comparison ever gets
    // normalised into meaninglessness by a future format change.
    const document = JSON.parse(bytesBefore)
    assert.equal(document.version, 1)
    const bucket = document.workspaces[workspaceId(realpathSync(workspace))]
    assert.equal(bucket.lastScan.suppressed, 1)
    assert.equal(bucket.lastScan.suppressions, undefined)
  } finally {
    for (const dispose of registered.disposers) dispose()
    await settle()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

//#endregion
