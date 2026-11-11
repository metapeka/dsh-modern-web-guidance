import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { renderJson, renderReport } from '../lib/report.js'
import { RULES } from '../lib/scan-rules.js'
import { createFileStore } from '../lib/store.js'
import { classifyCall, createTelemetry, workspaceId } from '../lib/telemetry.js'

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
  assert.deepEqual(registered.commands.map((command) => command.name), ['guidance-scan', 'guidance-stats'])
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

  assert.deepEqual(registered.commands.map((command) => command.name), ['guidance-scan'])
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
    assert.deepEqual(json.topRules, [
      {
        ruleId: 'ls-17',
        count: 1,
        message: rule.message,
        confidence: rule.confidence,
        guideId: rule.guideId,
      },
    ])
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
function scanAt(cwd, { files, findings }) {
  return { ...scanResult({ files, findings }), cwd }
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
