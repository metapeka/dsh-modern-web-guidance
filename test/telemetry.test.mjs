import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyCall, createTelemetry } from '../lib/telemetry.js'

const DAY = 24 * 60 * 60 * 1000

/** A fixed moment, so day buckets and period windows are deterministic. */
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

const CATALOG = {
  total: 4,
  byCategory: { css: 2, forms: 2 },
  ids: ['css-anchor', 'css-container', 'forms-autofill', 'forms-validation'],
  categoryOf: {
    'css-anchor': 'css',
    'css-container': 'css',
    'forms-autofill': 'forms',
    'forms-validation': 'forms',
  },
  version: '2026_10_30-58d055df',
  snapshotDate: '2026-10-30',
}

/** An in-memory store; `seed` fakes what a previous session left on disk. */
function memoryStore(seed = null) {
  const store = {
    state: seed,
    saves: 0,
    async load() {
      return store.state
    },
    async save(state) {
      store.saves += 1
      store.state = JSON.parse(JSON.stringify(state))
    },
  }
  return store
}

function telemetryWith(overrides = {}) {
  const store = overrides.store ?? memoryStore()
  const clock = overrides.clock ?? (() => NOW)
  return {
    store,
    telemetry: createTelemetry({
      store,
      clock,
      retentionDays: 90,
      ringLimit: 1000,
      catalog: CATALOG,
      ...overrides.options,
    }),
  }
}

const localDay = (milliseconds = NOW) => {
  const date = new Date(milliseconds)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

test('a search with results is a hit and carries the query and ids', () => {
  const classified = classifyCall({
    tool: 'web_guidance_search',
    args: { query: 'dialog light dismiss' },
    value: { results: [{ id: 'css-anchor', category: 'css' }] },
    isError: false,
  })

  assert.equal(classified.outcome, 'hit')
  assert.equal(classified.query, 'dialog light dismiss')
  assert.deepEqual(classified.ids, ['css-anchor'])
  assert.equal(classified.category, 'css')
  assert.equal(classified.count, 1)
})

test('a search with no results is a miss and keeps the query', () => {
  const classified = classifyCall({
    tool: 'web_guidance_search',
    args: { query: 'quantum flux capacitor' },
    value: { results: [] },
    isError: false,
  })

  assert.deepEqual(classified, { outcome: 'miss', query: 'quantum flux capacitor', count: 0 })
})

test('a retrieve of known ids is a hit, of unknown ids an unknown-id call', () => {
  assert.deepEqual(
    classifyCall({ tool: 'web_guidance_retrieve', args: { ids: ['css-anchor'] }, value: { guides: [{ id: 'css-anchor' }] } }),
    { outcome: 'hit', ids: ['css-anchor'], count: 1 },
  )
  assert.deepEqual(
    classifyCall({ tool: 'web_guidance_retrieve', args: { ids: ['nope'] }, value: { guides: [], unknown: ['nope'] } }),
    { outcome: 'unknown-id', ids: ['nope'], count: 1 },
  )
})

test('a list call and a failed call classify separately', () => {
  assert.equal(classifyCall({ tool: 'web_guidance_list', value: { guides: [{}, {}, {}] } }).outcome, 'list')
  assert.equal(classifyCall({ tool: 'web_guidance_search', isError: true }).outcome, 'error')
  assert.equal(classifyCall({ tool: 'some_other_tool', value: {} }).outcome, 'error')
})

test('recording accumulates lifetime counters and per-day buckets', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })
  await telemetry.record({ tool: 'search', outcome: 'miss', query: 'nothing here', at: NOW })
  await telemetry.record({ tool: 'retrieve', outcome: 'hit', ids: ['css-anchor'], at: NOW })
  await telemetry.record({ tool: 'list', outcome: 'list', at: NOW })

  const snapshot = await telemetry.snapshot({ days: 7 })

  assert.equal(snapshot.totals.calls, 4)
  assert.deepEqual(snapshot.totals.byTool, { search: 2, retrieve: 1, list: 1 })
  assert.equal(snapshot.totals.byOutcome.hit, 2)
  assert.equal(snapshot.totals.hitRate, 0.5)
  assert.deepEqual(snapshot.series.at(-1), { day: localDay(), calls: 4 })
  assert.equal(snapshot.series.length, 7)
  assert.equal(snapshot.generatedAt, new Date(NOW).toISOString())
})

test('top queries rank by calls and misses keep only queries that returned nothing', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })
  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })
  await telemetry.record({ tool: 'search', outcome: 'miss', query: 'popover positioning', at: NOW })
  await telemetry.record({ tool: 'search', outcome: 'miss', query: 'popover positioning', at: NOW })

  const snapshot = await telemetry.snapshot({ days: 7 })

  assert.deepEqual(snapshot.topQueries.map((row) => row.query), ['dialog', 'popover positioning'])
  assert.deepEqual(snapshot.topQueries[0], { query: 'dialog', calls: 2, hits: 2, misses: 0, lastAt: new Date(NOW).toISOString() })
  assert.deepEqual(snapshot.misses, [
    { query: 'popover positioning', calls: 2, lastAt: new Date(NOW).toISOString() },
  ])
})

test('only retrieved guides count as used; the rest are dead guides', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'anchor', ids: ['css-anchor'], category: 'css', at: NOW })
  await telemetry.record({ tool: 'retrieve', outcome: 'hit', ids: ['css-anchor', 'forms-autofill'], at: NOW })

  const snapshot = await telemetry.snapshot({ days: 7 })

  assert.deepEqual(snapshot.coverage, [
    { category: 'css', retrieved: 1, total: 2 },
    { category: 'forms', retrieved: 1, total: 2 },
  ])
  assert.equal(snapshot.deadGuides.total, 2)
  assert.deepEqual(snapshot.deadGuides.sample, ['css-container', 'forms-validation'])
})

test('the snapshot reports the corpus identity it was counted against', async () => {
  const { telemetry } = telemetryWith()
  const snapshot = await telemetry.snapshot({ days: 30 })

  assert.equal(snapshot.periodDays, 30)
  assert.deepEqual(snapshot.corpus, { version: '2026_10_30-58d055df', snapshotDate: '2026-10-30', total: 4 })
})

test('an empty snapshot is well formed rather than missing fields', async () => {
  const { telemetry } = telemetryWith()
  const snapshot = await telemetry.snapshot()

  assert.equal(snapshot.periodDays, 7)
  assert.equal(snapshot.totals.calls, 0)
  assert.equal(snapshot.totals.hitRate, 0)
  assert.deepEqual(snapshot.topQueries, [])
  assert.deepEqual(snapshot.misses, [])
  assert.equal(snapshot.deadGuides.total, 4)
  assert.equal(snapshot.series.length, 7)
})

test('retention drops old day buckets and old ring entries, keeping lifetime totals', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({ tool: 'search', outcome: 'miss', query: 'ancient', at: NOW - 200 * DAY })
  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'fresh', at: NOW })

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.equal(snapshot.totals.calls, 1)
  assert.deepEqual(snapshot.topQueries.map((row) => row.query), ['fresh'])

  await telemetry.flush()
  assert.deepEqual(Object.keys(store.state.byDay), [localDay()])
  assert.equal(store.state.recent.length, 1)
  assert.equal(store.state.calls, 2)
})

test('a corrupt document reads as empty instead of throwing', async () => {
  const store = memoryStore({ version: 99, nonsense: true })
  const { telemetry } = telemetryWith({ store })

  const snapshot = await telemetry.snapshot()

  assert.equal(snapshot.totals.calls, 0)
  assert.equal(snapshot.corpus.total, 4)

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })
  assert.equal((await telemetry.snapshot()).totals.calls, 1)
})

test('a store whose load rejects still records', async () => {
  const store = {
    async load() {
      throw new Error('disk on fire')
    },
    async save() {},
  }
  const { telemetry } = telemetryWith({ store })

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })

  assert.equal((await telemetry.snapshot()).totals.calls, 1)
})

test('a failing save never rejects a record', async () => {
  const store = {
    async load() {
      return null
    },
    async save() {
      throw new Error('read-only profile')
    },
  }
  const { telemetry } = telemetryWith({ store })

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })
  await assert.rejects(telemetry.flush(), /read-only profile/)
})

test('the ring keeps only the newest calls', async () => {
  const { telemetry } = telemetryWith({ options: { ringLimit: 3 } })

  for (let index = 0; index < 6; index += 1) {
    await telemetry.record({ tool: 'search', outcome: 'miss', query: `query ${index}`, at: NOW + index })
  }

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topQueries.map((row) => row.query).sort(), ['query 3', 'query 4', 'query 5'])
})

test('reset erases the counters and persists the empty document', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({ tool: 'search', outcome: 'hit', query: 'dialog', at: NOW })
  await telemetry.reset()

  assert.equal((await telemetry.snapshot()).totals.calls, 0)
  assert.equal(store.state.calls, 0)
  assert.deepEqual(store.state.recent, [])
})

test('flush persists what a later instance can read back', async () => {
  const store = memoryStore()
  const first = createTelemetry({ store, clock: () => NOW, catalog: CATALOG })

  await first.record({ tool: 'retrieve', outcome: 'hit', ids: ['css-anchor'], at: NOW })
  await first.flush()

  const second = createTelemetry({ store, clock: () => NOW, catalog: CATALOG })
  const snapshot = await second.snapshot()

  assert.equal(snapshot.totals.calls, 1)
  assert.deepEqual(snapshot.coverage.map((row) => row.retrieved), [1, 0])
})

// --- Scan debt: which rules and guides the findings belong to -------------------------------

/** One finding as the scan tool reports it: ids only, never a path or a snippet. */
const finding = (ruleId, guideId = null) => ({ ruleId, guideId })

/** A scan call classified exactly the way `index.js` classifies a real tool result. */
function scanEntry(findings, files = 1, scanned = {}, truncated = false) {
  return classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { scanned: { files, ...scanned }, findings, truncated },
  })
}

/** The stored last scan with the audit defaults a state file written before 0.7.3 reads as. */
function lastScanOf({ at, files, findings, rules, skipped = {}, truncated = false }) {
  return { at, files, findings, rules, skipped, truncated }
}

test('a scan classifies which rules and guides fired, deduped and sorted', () => {
  const entry = scanEntry([
    finding('ls-13', 'customize-scrollbar'),
    finding('ls-13', 'customize-scrollbar'),
    finding('ls-02', 'dialog'),
    finding('ls-02'),
  ])

  assert.equal(entry.outcome, 'findings')
  assert.equal(entry.findings, 4)
  assert.deepEqual(entry.rules, ['ls-02', 'ls-13'])
  assert.deepEqual(entry.guides, ['customize-scrollbar', 'dialog'])
  assert.deepEqual(entry.ruleCounts, { 'ls-02': 2, 'ls-13': 2 })
  assert.deepEqual(entry.guideCounts, { 'customize-scrollbar': 2, dialog: 1 })

  const clean = scanEntry([], 3)
  assert.equal(clean.outcome, 'clean')
  assert.deepEqual(clean.rules, [])
  assert.deepEqual(clean.guides, [])
  // Nothing skipped and no cap hit reads as the audit defaults, not as missing fields.
  assert.deepEqual(clean.skipped, {})
  assert.equal(clean.truncated, false)

  const failed = classifyCall({ tool: 'web_guidance_legacy_scan', isError: true })
  assert.equal(failed.outcome, 'error')
  assert.deepEqual(failed.rules, [])
  assert.deepEqual(failed.guides, [])
  assert.deepEqual(failed.skipped, {})
  assert.equal(failed.truncated, false)
})

test('a scan carries the skip reasons and the truncation flag through classification', () => {
  const entry = scanEntry(
    [finding('ls-13', 'customize-scrollbar')],
    70,
    { skippedByReason: { extension: 277, 'dot-directory': 2 }, skippedTotal: 279, truncated: false },
    true,
  )

  assert.equal(entry.files, 70)
  assert.deepEqual(entry.skipped, { extension: 277, 'dot-directory': 2 })
  assert.equal(entry.truncated, true)

  // A truncated walk is also flagged when only the scan-level field says so.
  const walkOnly = scanEntry([], 1, { truncated: true })
  assert.equal(walkOnly.truncated, true)
  assert.deepEqual(walkOnly.skipped, {})
})

test('one scan counts findings while the id list names each rule once', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...scanEntry([
      finding('ls-13', 'customize-scrollbar'),
      finding('ls-13', 'customize-scrollbar'),
      finding('ls-13', 'customize-scrollbar'),
    ]),
  })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-13', count: 3 }])
  assert.deepEqual(snapshot.topScanGuides, [{ guideId: 'customize-scrollbar', count: 3 }])
  // The last-scan summary lists presence once, even though the counter saw three findings.
  assert.deepEqual(snapshot.lastScan, lastScanOf({
    at: new Date(NOW).toISOString(),
    files: 1,
    findings: 3,
    rules: ['ls-13'],
  }))

  await telemetry.flush()
  assert.equal(store.state.scanRules['ls-13'], 3)
  assert.equal(store.state.scanGuides['customize-scrollbar'], 3)
  assert.deepEqual(store.state.lastScan.rules, ['ls-13'])
})

test('the same rule accumulates across scans while the last scan is replaced', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW - 2000,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-13', 'customize-scrollbar'), finding('ls-13', 'customize-scrollbar'), finding('ls-02', 'dialog')], 5),
  })
  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry([finding('ls-13', 'customize-scrollbar')], 2) })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-13', count: 3 }, { ruleId: 'ls-02', count: 1 }])
  assert.deepEqual(snapshot.topScanGuides, [
    { guideId: 'customize-scrollbar', count: 3 },
    { guideId: 'dialog', count: 1 },
  ])
  assert.deepEqual(snapshot.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 2, findings: 1, rules: ['ls-13'] }))
})

test('the top lists rank by findings and break ties by id', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...scanEntry([
      finding('ls-20', 'guide-b'),
      finding('ls-20', 'guide-b'),
      finding('ls-10', 'guide-a'),
      finding('ls-10', 'guide-a'),
      finding('ls-30', 'guide-c'),
    ]),
  })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [
    { ruleId: 'ls-10', count: 2 },
    { ruleId: 'ls-20', count: 2 },
    { ruleId: 'ls-30', count: 1 },
  ])
  assert.deepEqual(snapshot.topScanGuides, [
    { guideId: 'guide-a', count: 2 },
    { guideId: 'guide-b', count: 2 },
    { guideId: 'guide-c', count: 1 },
  ])
})

test('the top lists show ten rows no matter how many rules fired', async () => {
  const findings = []
  for (let index = 1; index <= 12; index += 1) {
    for (let repetition = 0; repetition < 13 - index; repetition += 1) {
      findings.push(finding(`ls-${String(index).padStart(2, '0')}`, `guide-${String(index).padStart(2, '0')}`))
    }
  }

  const { telemetry } = telemetryWith()
  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry(findings) })

  const snapshot = await telemetry.snapshot()
  assert.equal(snapshot.topRules.length, 10)
  assert.equal(snapshot.topScanGuides.length, 10)
  assert.deepEqual(
    snapshot.topRules,
    Array.from({ length: 10 }, (_, index) => ({
      ruleId: `ls-${String(index + 1).padStart(2, '0')}`,
      count: 12 - index,
    })),
  )
  assert.deepEqual(
    snapshot.topScanGuides.map((row) => row.count),
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
  )
})

test('the per-scan id lists cap at forty while the counters keep every rule', async () => {
  const findings = []
  for (let index = 1; index <= 45; index += 1) {
    const id = String(index).padStart(2, '0')
    findings.push(finding(`ls-${id}`, `guide-${id}`))
  }

  const entry = scanEntry(findings)
  assert.equal(entry.rules.length, 40)
  assert.equal(entry.rules[0], 'ls-01')
  assert.equal(entry.rules.at(-1), 'ls-40')
  assert.equal(entry.guides.length, 40)

  const { telemetry, store } = telemetryWith()
  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...entry })
  const snapshot = await telemetry.snapshot()
  assert.equal(snapshot.lastScan.rules.length, 40)

  await telemetry.flush()
  assert.equal(Object.keys(store.state.scanRules).length, 45)
  assert.equal(store.state.scanRules['ls-45'], 1)
  assert.equal(Object.keys(store.state.scanGuides).length, 45)
})

test('a scan with no findings keeps the counters and records an empty rule list', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW - 1000,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-13', 'customize-scrollbar'), finding('ls-02', 'dialog')], 4),
  })
  // No `at` on purpose: the stored summary falls back to the injected clock.
  await telemetry.record({ tool: 'legacy-scan', ...scanEntry([], 2) })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [
    { ruleId: 'ls-02', count: 1 },
    { ruleId: 'ls-13', count: 1 },
  ])
  assert.deepEqual(snapshot.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 2, findings: 0, rules: [] }))
})

test('a document written before the scan counters loads and starts its blocks empty', async () => {
  const seed = {
    version: 1,
    since: NOW - 10 * DAY,
    calls: 2,
    byDay: {},
    byTool: { search: 2 },
    byOutcome: { hit: 2 },
    byCategory: {},
    retrieved: {},
    recent: [],
  }
  const { telemetry } = telemetryWith({ store: memoryStore(seed) })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [])
  assert.deepEqual(snapshot.topScanGuides, [])
  assert.equal(snapshot.lastScan, null)

  // The old counters still load, and the first scan counted after the upgrade lands in the new maps.
  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry([finding('ls-13', 'customize-scrollbar')]) })
  const after = await telemetry.snapshot()
  assert.equal(after.totals.byTool['legacy-scan'], 1)
  assert.deepEqual(after.topRules, [{ ruleId: 'ls-13', count: 1 }])
})

test('a last scan older than the window is dropped while the lifetime counters stay', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW - 200 * DAY,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-13', 'customize-scrollbar'), finding('ls-13', 'customize-scrollbar')]),
  })

  const stale = await telemetry.snapshot()
  assert.equal(stale.lastScan, null)
  assert.deepEqual(stale.topRules, [{ ruleId: 'ls-13', count: 2 }])

  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry([finding('ls-02', 'dialog')], 3) })
  const fresh = await telemetry.snapshot()
  assert.deepEqual(fresh.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 3, findings: 1, rules: ['ls-02'] }))
  assert.deepEqual(fresh.topRules, [
    { ruleId: 'ls-13', count: 2 },
    { ruleId: 'ls-02', count: 1 },
  ])
})

test('the stored scan block is rebuilt defensively from a hand-edited document', async () => {
  const seed = {
    version: 1,
    since: NOW,
    calls: 0,
    byDay: {},
    byTool: {},
    byOutcome: {},
    byCategory: {},
    retrieved: {},
    scanRules: { 'ls-13': 'seven', 'ls-02': 2, '': 9 },
    scanGuides: { dialog: 1 },
    lastScan: { at: NOW - 1000, files: 'lots', findings: -3, rules: ['ls-b', 7, '', 'ls-a', 'ls-a'] },
    recent: [],
  }
  const { telemetry } = telemetryWith({ store: memoryStore(seed) })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-02', count: 2 }])
  assert.deepEqual(snapshot.topScanGuides, [{ guideId: 'dialog', count: 1 }])
  assert.deepEqual(snapshot.lastScan, lastScanOf({
    at: new Date(NOW - 1000).toISOString(),
    files: 0,
    findings: 0,
    rules: ['ls-a', 'ls-b'],
  }))

  const unreadable = telemetryWith({ store: memoryStore({ version: 1, since: NOW, calls: 0, byDay: {}, recent: [], lastScan: { at: 'not a date' } }) })
  assert.equal((await unreadable.telemetry.snapshot()).lastScan, null)

  const wrongShape = telemetryWith({ store: memoryStore({ version: 1, since: NOW, calls: 0, byDay: {}, recent: [], lastScan: 'recently' }) })
  assert.equal((await wrongShape.telemetry.snapshot()).lastScan, null)
})

test('aggregation ignores a garbage scan entry instead of throwing', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    outcome: 'findings',
    rules: 'nope',
    guides: [null, 7, 'ok-guide'],
    ruleCounts: { 'ls-13': 2, '': 5, bogus: 'x' },
  })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-13', count: 2 }])
  assert.deepEqual(snapshot.topScanGuides, [{ guideId: 'ok-guide', count: 1 }])
  assert.deepEqual(snapshot.lastScan.rules, [])
})

test('a failed scan is counted but does not become the last scan', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW - 1000,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-13', 'customize-scrollbar')], 3),
  })
  // A refusal is a value, not a thrown error: `index.js` still classifies it as a failed call.
  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...classifyCall({
      tool: 'web_guidance_legacy_scan',
      value: { error: 'path-absolute', subject: '/etc/passwd', message: 'Use paths relative to the workspace.' },
    }),
  })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.lastScan, lastScanOf({
    at: new Date(NOW - 1000).toISOString(),
    files: 3,
    findings: 1,
    rules: ['ls-13'],
  }))
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-13', count: 1 }])
  assert.equal(snapshot.totals.byTool['legacy-scan'], 2)
})

test('reset clears the rule and guide counters and the last scan', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry([finding('ls-13', 'customize-scrollbar')]) })
  await telemetry.reset()

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.topRules, [])
  assert.deepEqual(snapshot.topScanGuides, [])
  assert.equal(snapshot.lastScan, null)
  assert.deepEqual(store.state.scanRules, {})
  assert.deepEqual(store.state.scanGuides, {})
  assert.equal(store.state.lastScan, null)
})

// --- The last scan's audit trail: skipped reasons and truncation ------------------------------

test('a scan with skips records them in the last scan', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-13', 'customize-scrollbar')], 70, {
      skippedByReason: { extension: 277, 'dot-directory': 2 },
      skippedTotal: 279,
    }),
  })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.lastScan, lastScanOf({
    at: new Date(NOW).toISOString(),
    files: 70,
    findings: 1,
    rules: ['ls-13'],
    skipped: { extension: 277, 'dot-directory': 2 },
  }))

  await telemetry.flush()
  assert.deepEqual(store.state.lastScan.skipped, { extension: 277, 'dot-directory': 2 })
  assert.equal(store.state.lastScan.truncated, false)
})

test('a truncated scan is stored as such and survives a reload', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-02', 'dialog')], 200, { skippedByReason: { 'too-many': 341 }, skippedTotal: 341 }, true),
  })

  const snapshot = await telemetry.snapshot()
  assert.equal(snapshot.lastScan.truncated, true)
  assert.deepEqual(snapshot.lastScan.skipped, { 'too-many': 341 })
  // The lifetime counters are untouched by truncation: they count what the scan did see.
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-02', count: 1 }])
})

test('the last scan keeps the top four skip reasons, ranked by count then name', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...scanEntry([], 12, {
      skippedByReason: {
        extension: 277,
        'dot-directory': 2,
        binary: 2,
        large: 1,
        unreadable: 1,
        outside: 1,
      },
    }),
  })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.lastScan.skipped, {
    extension: 277,
    binary: 2,
    'dot-directory': 2,
    large: 1,
  })
  assert.deepEqual(Object.keys(snapshot.lastScan.skipped), ['extension', 'binary', 'dot-directory', 'large'])
})

test('a clean scan records empty skips and no truncation', async () => {
  const { telemetry } = telemetryWith()

  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry([], 3) })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 3, findings: 0, rules: [] }))
})

test('a last scan stored before the audit fields existed normalises without loss', async () => {
  const seed = {
    version: 1,
    since: NOW,
    calls: 1,
    byDay: {},
    byTool: {},
    byOutcome: {},
    byCategory: {},
    retrieved: {},
    scanRules: { 'ls-13': 4 },
    scanGuides: { 'customize-scrollbar': 4 },
    lastScan: {
      at: new Date(NOW - 1000).toISOString(),
      files: 70,
      findings: 97,
      rules: ['ls-13', 'ls-02'],
    },
    recent: [],
  }
  const { telemetry } = telemetryWith({ store: memoryStore(seed) })

  const snapshot = await telemetry.snapshot()
  // Exactly the six documented keys, with the audit fields defaulted rather than absent.
  assert.deepEqual(Object.keys(snapshot.lastScan), ['at', 'files', 'findings', 'rules', 'skipped', 'truncated'])
  assert.deepEqual(snapshot.lastScan, lastScanOf({
    at: new Date(NOW - 1000).toISOString(),
    files: 70,
    findings: 97,
    rules: ['ls-02', 'ls-13'],
  }))
  assert.deepEqual(snapshot.topRules, [{ ruleId: 'ls-13', count: 4 }])
})

test('malformed skip fields are dropped instead of reaching the snapshot', async () => {
  const seed = {
    version: 1,
    since: NOW,
    calls: 1,
    byDay: {},
    recent: [],
    lastScan: {
      at: new Date(NOW).toISOString(),
      files: 1,
      findings: 1,
      rules: ['ls-13'],
      skipped: { extension: 'many', '': 3, binary: -2, 'dot-directory': 2 },
      truncated: 'yes',
    },
  }
  const { telemetry } = telemetryWith({ store: memoryStore(seed) })

  const snapshot = await telemetry.snapshot()
  assert.deepEqual(snapshot.lastScan.skipped, { 'dot-directory': 2 })
  assert.equal(snapshot.lastScan.truncated, false)
})


