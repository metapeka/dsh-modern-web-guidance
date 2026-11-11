import assert from 'node:assert/strict'
import { test } from 'node:test'

import { branchLabel, classifyCall, createTelemetry, siteId, workspaceId } from '../lib/telemetry.js'

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

/**
 * The stored last scan with the audit defaults a state file written before 0.7.3 reads as, plus the
 * suppression count every completed scan writes from 0.12.0 on — `0` included, because the scan ran
 * and muted nothing. A positive count may carry its per-rule split.
 */
function lastScanOf({ at, files, findings, rules, skipped = {}, truncated = false, suppressed = 0, suppressedRules }) {
  const summary = { at, files, findings, rules, skipped, truncated, suppressed }
  if (suppressed > 0 && suppressedRules !== undefined) summary.suppressedRules = suppressedRules
  return summary
}

/**
 * A last scan as a document written before suppression normalises to: the six keys and no
 * `suppressed` member at all. There is no zero here to claim — nothing was muted because nothing could
 * be — and a report on this document must render exactly what it rendered before 0.12.0.
 */
function lastScanBefore({ at, files, findings, rules, skipped = {}, truncated = false }) {
  return { at, files, findings, rules, skipped, truncated }
}

/** One ranked rule row as the snapshot hands it out: the count plus the days the rule was seen. */
function ruleRow(ruleId, count, firstSeen = null, lastSeen = null) {
  return { ruleId, count, firstSeen, lastSeen }
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
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 3)])
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
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 3), ruleRow('ls-02', 1)])
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
    ruleRow('ls-10', 2),
    ruleRow('ls-20', 2),
    ruleRow('ls-30', 1),
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
    Array.from({ length: 10 }, (_, index) => ruleRow(`ls-${String(index + 1).padStart(2, '0')}`, 12 - index)),
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
    ruleRow('ls-02', 1),
    ruleRow('ls-13', 1),
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
  assert.deepEqual(after.topRules, [ruleRow('ls-13', 1)])
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
  assert.deepEqual(stale.topRules, [ruleRow('ls-13', 2)])

  await telemetry.record({ at: NOW, tool: 'legacy-scan', ...scanEntry([finding('ls-02', 'dialog')], 3) })
  const fresh = await telemetry.snapshot()
  assert.deepEqual(fresh.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 3, findings: 1, rules: ['ls-02'] }))
  assert.deepEqual(fresh.topRules, [
    ruleRow('ls-13', 2),
    ruleRow('ls-02', 1),
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
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-02', 2)])
  assert.deepEqual(snapshot.topScanGuides, [{ guideId: 'dialog', count: 1 }])
  assert.deepEqual(snapshot.lastScan, lastScanBefore({
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
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 2)])
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
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 1)])
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
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-02', 1)])
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
  assert.deepEqual(snapshot.lastScan, lastScanBefore({
    at: new Date(NOW - 1000).toISOString(),
    files: 70,
    findings: 97,
    rules: ['ls-02', 'ls-13'],
  }))
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 4)])
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

// --- Workspace attribution: whose scan debt is this? -----------------------------------------

/** Two workspaces as `index.js` resolves them: an id from the path, a name from the basename. */
const ALPHA = { id: workspaceId('C:\\proj\\app'), name: 'app' }
const BETA = { id: workspaceId('C:\\proj\\beta'), name: 'beta' }
/** The moment the seeded legacy root last scanned, before either workspace existed. */
const LEGACY_AT = new Date(NOW - 5000).toISOString()

/** A scan recorded in one workspace. */
function workspaceScan(workspace, findings, files = 1, at = NOW) {
  return { at, tool: 'legacy-scan', workspace, ...scanEntry(findings, files) }
}

/** A 0.9.0 document: scan counters at the root, no `workspaces` map at all. */
function legacyDocument() {
  return {
    version: 1,
    since: NOW - 10 * DAY,
    calls: 4,
    byDay: {},
    byTool: { 'legacy-scan': 1 },
    byOutcome: { findings: 1 },
    byCategory: {},
    retrieved: {},
    scanRules: { 'ls-13': 4, 'ls-02': 2 },
    scanGuides: { dialog: 4 },
    lastScan: lastScanBefore({ at: LEGACY_AT, files: 9, findings: 6, rules: ['ls-02', 'ls-13'] }),
    recent: [],
  }
}

test('a workspace id is a stable eight-hex hash of the path', () => {
  assert.equal(workspaceId('C:\\proj\\app'), '91a3a510')
  // The same path twice: a drifting id would orphan every bucket it ever keyed.
  assert.equal(workspaceId('C:\\proj\\app'), workspaceId('C:\\proj\\app'))
  assert.match(workspaceId(''), /^[0-9a-f]{8}$/)
  assert.notEqual(workspaceId('C:\\proj\\app'), workspaceId('C:\\proj\\app2'))
})

test('a document written before workspace scoping keeps every counter and its last scan', async () => {
  const { telemetry, store } = telemetryWith({ store: memoryStore(legacyDocument()) })

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.equal(snapshot.workspace, null)
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 4), ruleRow('ls-02', 2)])
  assert.deepEqual(snapshot.lastScan, lastScanBefore({ at: LEGACY_AT, files: 9, findings: 6, rules: ['ls-02', 'ls-13'] }))
  // The pre-partition numbers surface as one synthetic bucket instead of disappearing.
  assert.deepEqual(snapshot.workspaces, [
    { id: '_unattributed', name: '', findings: 6, rules: 2, lastScanAt: LEGACY_AT },
  ])

  // Nothing is moved or invented on disk: the root stays the legacy bucket, the map stays empty.
  await telemetry.flush()
  assert.equal(store.state.version, 1)
  assert.deepEqual(store.state.scanRules, { 'ls-13': 4, 'ls-02': 2 })
  assert.deepEqual(store.state.scanGuides, { dialog: 4 })
  assert.deepEqual(store.state.workspaces, {})
})

test('two workspaces keep their scan counters disjoint while calls stay profile-wide', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(workspaceScan(ALPHA, [finding('ls-13', 'guide-a')], 1, NOW - 1000))
  await telemetry.record(workspaceScan(BETA, [finding('ls-02', 'guide-b'), finding('ls-02', 'guide-b')], 4, NOW))

  const alpha = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.deepEqual(alpha.workspace, ALPHA)
  assert.deepEqual(alpha.topRules, [ruleRow('ls-13', 1, localDay(NOW - 1000), localDay(NOW - 1000))])
  assert.deepEqual(alpha.lastScan, lastScanOf({ at: new Date(NOW - 1000).toISOString(), files: 1, findings: 1, rules: ['ls-13'] }))
  // Guidance counters are profile-wide, so a selected workspace still sees every call.
  assert.equal(alpha.totals.calls, 2)
  assert.equal(alpha.totals.byTool['legacy-scan'], 2)

  const beta = await telemetry.snapshot({ days: 7, workspace: BETA.id })
  assert.deepEqual(beta.workspace, BETA)
  assert.deepEqual(beta.topRules, [ruleRow('ls-02', 2, localDay(NOW), localDay(NOW))])
  assert.deepEqual(beta.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 4, findings: 2, rules: ['ls-02'] }))

  // The roots that 0.9.0 read as its scan debt are untouched by attributed scans.
  await telemetry.flush()
  assert.deepEqual(store.state.scanRules, {})
  assert.deepEqual(store.state.scanGuides, {})
  assert.equal(store.state.lastScan, null)
  assert.deepEqual(store.state.workspaces[ALPHA.id], {
    name: 'app',
    since: NOW - 1000,
    scanRules: { 'ls-13': 1 },
    scanGuides: { 'guide-a': 1 },
    lastScan: lastScanOf({ at: new Date(NOW - 1000).toISOString(), files: 1, findings: 1, rules: ['ls-13'] }),
    // The 0.10.0 members are written by the same completed scan. These findings carry no path or
    // snippet (the helper reports ids only), so the site map is incomplete and nothing is compared.
    scanByDay: { [localDay(NOW - 1000)]: { scans: 1, files: 1, findings: 1 } },
    ruleFirstSeen: { 'ls-13': localDay(NOW - 1000) },
    ruleLastSeen: { 'ls-13': localDay(NOW - 1000) },
    scanHistory: [{
      at: new Date(NOW - 1000).toISOString(),
      outcome: 'findings',
      files: 1,
      findings: 1,
      rules: { 'ls-13': 1 },
      skipped: {},
      truncated: false,
      suppressed: 0,
    }],
    lastSites: null,
    scanDiff: { against: null, partial: 'sites-unknown' },
  })
  assert.deepEqual(store.state.workspaces[BETA.id].scanRules, { 'ls-02': 2 })
  assert.deepEqual(Object.keys(store.state.workspaces).sort(), [ALPHA.id, BETA.id].sort())

  // The ring entry keeps exactly the shape it had before partitioning: no workspace field.
  assert.deepEqual(store.state.recent.at(-1), {
    at: NOW,
    tool: 'legacy-scan',
    outcome: 'findings',
    files: 4,
    findings: 2,
  })
})

test("aggregating 'all' sums every bucket plus the legacy root counters", async () => {
  const { telemetry } = telemetryWith({ store: memoryStore(legacyDocument()) })

  // The seeded legacy root holds ls-13; the workspaces add their own, disjoint, debt.
  await telemetry.record(workspaceScan(ALPHA, [finding('ls-13', 'guide-a'), finding('ls-13', 'guide-a')], 3, NOW - 2000))
  await telemetry.record(workspaceScan(BETA, [finding('ls-02', 'guide-b')], 2, NOW))

  const all = await telemetry.snapshot({ days: 7 })
  assert.equal(all.workspace, null)
  // An aggregate takes the earliest and latest day of the buckets it sums; the legacy root's rows
  // carry no date of their own, so a rule only it knows reads as null.
  assert.deepEqual(all.topRules, [
    ruleRow('ls-13', 6, localDay(NOW - 2000), localDay(NOW - 2000)),
    ruleRow('ls-02', 3, localDay(NOW), localDay(NOW)),
  ])
  assert.deepEqual(all.topScanGuides, [{ guideId: 'dialog', count: 4 }, { guideId: 'guide-a', count: 2 }, { guideId: 'guide-b', count: 1 }])
  // A last scan cannot be summed, so the aggregate shows the newest one rather than the root's.
  assert.deepEqual(all.lastScan, lastScanOf({ at: new Date(NOW).toISOString(), files: 2, findings: 1, rules: ['ls-02'] }))
  // Newest last scan first, nulls last, then by name; the legacy root is one of the rows.
  assert.deepEqual(all.workspaces, [
    { id: BETA.id, name: 'beta', findings: 1, rules: 1, lastScanAt: new Date(NOW).toISOString() },
    { id: ALPHA.id, name: 'app', findings: 2, rules: 1, lastScanAt: new Date(NOW - 2000).toISOString() },
    { id: '_unattributed', name: '', findings: 6, rules: 2, lastScanAt: LEGACY_AT },
  ])

  // Omitted and 'all' are the same report, which is what the command's fallback relies on.
  assert.deepEqual(await telemetry.snapshot({ days: 7, workspace: 'all' }), all)
  assert.deepEqual(await telemetry.snapshot({ days: 7 }), all)
})

test("selecting '_unattributed' reads only the legacy root counters", async () => {
  const { telemetry } = telemetryWith({ store: memoryStore(legacyDocument()) })
  await telemetry.record(workspaceScan(ALPHA, [finding('ls-20', 'guide-c')], 1, NOW))

  const legacy = await telemetry.snapshot({ days: 7, workspace: '_unattributed' })
  assert.deepEqual(legacy.workspace, { id: '_unattributed', name: '' })
  // The root's rules, not the union with the bucket that exists beside it.
  assert.deepEqual(legacy.topRules, [ruleRow('ls-13', 4), ruleRow('ls-02', 2)])
  assert.deepEqual(legacy.lastScan, lastScanBefore({ at: LEGACY_AT, files: 9, findings: 6, rules: ['ls-02', 'ls-13'] }))
})

test('an unknown workspace id reads as the aggregate rather than as an empty report', async () => {
  const { telemetry } = telemetryWith()
  await telemetry.record(workspaceScan(ALPHA, [finding('ls-13', 'guide-a')]))

  assert.deepEqual(await telemetry.snapshot({ days: 7, workspace: 'deadbeef' }), await telemetry.snapshot({ days: 7 }))
})

test('garbage workspace entries are dropped and an incomplete bucket is completed', async () => {
  const seed = {
    version: 1,
    since: NOW,
    calls: 0,
    byDay: {},
    byTool: {},
    byOutcome: {},
    byCategory: {},
    retrieved: {},
    recent: [],
    workspaces: {
      aaaa1111: {
        name: 'kept',
        since: NOW - 5000,
        scanRules: { 'ls-13': 2 },
        scanGuides: { 'guide-a': 2 },
        lastScan: lastScanOf({ at: new Date(NOW - 4000).toISOString(), files: 3, findings: 2, rules: ['ls-13'] }),
      },
      bbbb2222: null,
      cccc3333: 'nope',
      dddd4444: ['nested'],
      '': { name: 'empty id' },
      eeee5555: {},
      ffff6666: { name: 'bad', since: 'never', scanRules: 'nope', scanGuides: { dialog: 1 }, lastScan: 'recently' },
    },
  }
  const { telemetry } = telemetryWith({ store: memoryStore(seed) })

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.deepEqual(snapshot.workspaces, [
    { id: 'aaaa1111', name: 'kept', findings: 2, rules: 1, lastScanAt: new Date(NOW - 4000).toISOString() },
    { id: 'ffff6666', name: 'bad', findings: 0, rules: 0, lastScanAt: null },
    { id: 'eeee5555', name: 'workspace', findings: 0, rules: 0, lastScanAt: null },
  ])
  // The aggregate only counted the readable bucket.
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 2)])
  assert.deepEqual(snapshot.topScanGuides, [{ guideId: 'guide-a', count: 2 }, { guideId: 'dialog', count: 1 }])
})

test('retention drops an expired workspace last scan but never the bucket or its counters', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(workspaceScan(ALPHA, [finding('ls-13', 'guide-a'), finding('ls-13', 'guide-a')], 5, NOW - 200 * DAY))

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.deepEqual(snapshot.workspaces, [{ id: ALPHA.id, name: 'app', findings: 2, rules: 1, lastScanAt: null }])
  // The bucket still knows when its rule was seen, so the row can be dated even though the last-scan
  // pointer expired with the window.
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 2, localDay(NOW - 200 * DAY), localDay(NOW - 200 * DAY))])
  assert.equal(snapshot.lastScan, null)

  await telemetry.flush()
  assert.deepEqual(Object.keys(store.state.workspaces), [ALPHA.id])
  assert.equal(store.state.workspaces[ALPHA.id].scanRules['ls-13'], 2)
  assert.equal(store.state.workspaces[ALPHA.id].lastScan, null)
})

test('an empty document reports no workspace and an empty switcher', async () => {
  const { telemetry } = telemetryWith()

  const snapshot = await telemetry.snapshot()
  assert.equal(snapshot.workspace, null)
  assert.deepEqual(snapshot.workspaces, [])
})

test('a scan carries its raw workspace path through classification, and nothing else grows one', () => {
  const entry = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { cwd: '/home/me/app', scanned: { files: 1 }, findings: [] },
  })
  // Raw and unresolved: hash and basename belong to the caller.
  assert.equal(entry.workspacePath, '/home/me/app')

  // The rule holds for a refused scan when the value happens to carry a cwd.
  const refused = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { cwd: '/work', error: 'path-absolute', subject: '/etc/passwd' },
  })
  assert.equal(refused.isError, true)
  assert.equal(refused.workspacePath, '/work')

  const without = classifyCall({ tool: 'web_guidance_legacy_scan', value: { scanned: {}, findings: [] } })
  assert.equal('workspacePath' in without, false)

  const search = classifyCall({ tool: 'web_guidance_search', args: { query: 'dialog' }, value: { cwd: '/work', results: [] } })
  assert.equal('workspacePath' in search, false)
})

test('partitioning keeps version 1, so a reload finds the buckets rather than erasing them', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(workspaceScan(ALPHA, [finding('ls-13', 'guide-a')]))
  await telemetry.flush()
  assert.equal(store.state.version, 1)

  const reloaded = createTelemetry({ store, clock: () => NOW, catalog: CATALOG })
  const snapshot = await reloaded.snapshot({ days: 7, workspace: ALPHA.id })
  assert.deepEqual(snapshot.workspace, ALPHA)
  assert.deepEqual(snapshot.topRules, [ruleRow('ls-13', 1, localDay(NOW), localDay(NOW))])
  assert.deepEqual(snapshot.workspaces, [
    { id: ALPHA.id, name: 'app', findings: 1, rules: 1, lastScanAt: new Date(NOW).toISOString() },
  ])
})

// --- The branch label: a label on one scan, never a counter key (ADR-0002) -------------------

/** A scan carrying a label, recorded exactly as `index.js` records one. */
function labelledScan(branch, findings = [finding('ls-13', 'guide-a')], files = 1, at = NOW) {
  return { ...workspaceScan(ALPHA, findings, files, at), branch }
}

/** A stored 0.10.x last scan with the label member added, as a hand-edited document would have it. */
function lastScanWith(branch) {
  return {
    ...lastScanOf({ at: LEGACY_AT, files: 9, findings: 6, rules: ['ls-02', 'ls-13'] }),
    branch,
  }
}

test('a branch label rides on the workspace last scan and survives a reload', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(labelledScan({ kind: 'branch', name: 'feature/branch-labels' }))
  await telemetry.flush()
  assert.equal(store.state.version, 1)
  assert.deepEqual(store.state.workspaces[ALPHA.id].lastScan.branch, { kind: 'branch', name: 'feature/branch-labels' })
  // The ring is untouched by the label: exactly the shape it had before ADR-0002.
  assert.deepEqual(store.state.recent.at(-1), { at: NOW, tool: 'legacy-scan', outcome: 'findings', files: 1, findings: 1 })

  // The document round-trips: a reload finds the same label, not a normalised-away member.
  const reloaded = createTelemetry({ store, clock: () => NOW, catalog: CATALOG })
  const snapshot = await reloaded.snapshot({ days: 7, workspace: ALPHA.id })
  assert.deepEqual(snapshot.lastScan.branch, { kind: 'branch', name: 'feature/branch-labels' })
})

test('a detached label stores only its seven validated hex characters', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(labelledScan({ kind: 'detached', sha: 'a1b2c3d' }))
  await telemetry.flush()
  assert.deepEqual(store.state.workspaces[ALPHA.id].lastScan.branch, { kind: 'detached', sha: 'a1b2c3d' })
})

test('a scan with no workspace labels the legacy root last scan instead of inventing a bucket', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    ...scanEntry([finding('ls-13', 'guide-a')]),
    branch: { kind: 'branch', name: 'main' },
  })
  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.deepEqual(snapshot.lastScan.branch, { kind: 'branch', name: 'main' })
  assert.equal(snapshot.workspace, null)

  await telemetry.flush()
  assert.deepEqual(store.state.workspaces, {})
  assert.deepEqual(store.state.lastScan.branch, { kind: 'branch', name: 'main' })
})

test('a refused scan records no label, because it records no last scan at all', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record({
    ...classifyCall({ tool: 'web_guidance_legacy_scan', isError: true }),
    branch: { kind: 'branch', name: 'main' },
  })
  await telemetry.flush()
  assert.equal(store.state.lastScan, null)
  assert.deepEqual(store.state.workspaces, {})
})

test('a malformed stored label reads as absent, never as a half-label', async () => {
  const malformed = [
    { kind: 'nope', name: 'main' },
    { kind: 'branch' },
    { kind: 'branch', name: '' },
    { kind: 'branch', name: 'main\nsecond line' },
    { kind: 'branch', name: 'feature name' },
    { kind: 'branch', name: 'x'.repeat(81) },
    { kind: 'detached', sha: 'abc' },
    { kind: 'detached', sha: 'A1B2C3D' },
    'main',
    null,
  ]
  for (const branch of malformed) {
    const { telemetry } = telemetryWith({
      store: memoryStore({ ...legacyDocument(), lastScan: lastScanWith(branch) }),
    })
    const snapshot = await telemetry.snapshot({ days: 7 })
    assert.equal('branch' in snapshot.lastScan, false, `${JSON.stringify(branch)} must read as absent`)
  }
})

test('a valid stored label keeps its shape and drops every extra member', async () => {
  const { telemetry } = telemetryWith({
    store: memoryStore({
      ...legacyDocument(),
      lastScan: lastScanWith({ kind: 'branch', name: 'release/1.2', extra: 'not part of the label' }),
    }),
  })
  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.deepEqual(snapshot.lastScan.branch, { kind: 'branch', name: 'release/1.2' })
})

test('a document written before labels keeps its six-key last scan and version 1', async () => {
  const { telemetry, store } = telemetryWith({ store: memoryStore(legacyDocument()) })

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.deepEqual(Object.keys(snapshot.lastScan), ['at', 'files', 'findings', 'rules', 'skipped', 'truncated'])
  assert.equal('branch' in snapshot.lastScan, false)

  await telemetry.flush()
  assert.equal(store.state.version, 1)
  assert.equal('branch' in store.state.lastScan, false)
})

test('branchLabel accepts exactly the two shapes and rebuilds them', () => {
  assert.deepEqual(branchLabel({ kind: 'branch', name: 'main' }), { kind: 'branch', name: 'main' })
  assert.deepEqual(branchLabel({ kind: 'detached', sha: 'a1b2c3d' }), { kind: 'detached', sha: 'a1b2c3d' })
  // Extra members are not part of the label: the returned object is rebuilt, not passed through.
  assert.deepEqual(
    branchLabel({ kind: 'branch', name: 'feature/x', extra: 'x' }),
    { kind: 'branch', name: 'feature/x' },
  )

  for (const name of ['..', 'a..b', 'a//b', '/main', 'main/', '-main', 'feature name', 'feature~1', 'mаin', 'a'.repeat(81)]) {
    assert.equal(branchLabel({ kind: 'branch', name }), null, `${JSON.stringify(name)} must be rejected`)
  }
  assert.equal(branchLabel({ kind: 'branch' }), null)
  assert.equal(branchLabel({ kind: 'detached', sha: 'a1b2c3' }), null)
  assert.equal(branchLabel({ kind: 'detached', sha: 'A1B2C3D' }), null)
  assert.equal(branchLabel({ kind: 'detached', sha: 1234567 }), null)
  assert.equal(branchLabel('main'), null)
  assert.equal(branchLabel(null), null)
  assert.equal(branchLabel([]), null)
})

// --- Scan history (0.10.0): when a scan ran, and whether the sites it found are still there -------

/** One finding with everything a site key needs: a path, a rule id and a snippet. */
function site(ruleId = 'ls-13', snippet = '::-webkit-scrollbar', path = 'src/app.css') {
  return { path, ruleId, snippet }
}

/** A scan entry as the tool path builds it: classified, with real site identity. */
function recordedScan({ at = NOW, files = 4, truncated = false, branch = null, findings = [], workspace = ALPHA } = {}) {
  const classified = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { cwd: '/work/app', scanned: { files }, truncated, findings },
  })
  return {
    at,
    tool: 'legacy-scan',
    workspace,
    ...(branch === null ? {} : { branch }),
    ...classified,
  }
}

/** A refusal, classified: a call that ran no scan and can testify about nothing. */
function refusedScan(at = NOW, workspace = ALPHA) {
  return {
    at,
    tool: 'legacy-scan',
    workspace,
    ...classifyCall({ tool: 'web_guidance_legacy_scan', value: { error: 'path-absolute', message: 'absolute path' } }),
  }
}

test('scanByDay counts completed scans only, one row per local day', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(recordedScan({ at: NOW, files: 4, findings: [site()] }))
  await telemetry.record(recordedScan({ at: NOW + 1000, files: 2 }))
  // A refusal is a call, never a scan: it appends no row and no history entry.
  await telemetry.record(refusedScan(NOW + 2000))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.deepEqual(bucket.scanByDay, { [localDay(NOW)]: { scans: 2, files: 6, findings: 1 } })
  assert.equal(bucket.scanHistory.length, 2)
  // The call series at the root still counts all three calls; the scan series is additive.
  assert.equal(store.state.byDay[localDay(NOW)].calls, 3)
})

test('each workspace keeps its own scan series and history', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(recordedScan({ at: NOW, files: 4, findings: [site()] }))
  await telemetry.record(recordedScan({ at: NOW, files: 1, findings: [site('ls-02', 'dialog', 'src/b.css')], workspace: BETA }))
  await telemetry.flush()

  assert.deepEqual(store.state.workspaces[ALPHA.id].scanByDay, { [localDay(NOW)]: { scans: 1, files: 4, findings: 1 } })
  assert.deepEqual(store.state.workspaces[BETA.id].scanByDay, { [localDay(NOW)]: { scans: 1, files: 1, findings: 1 } })
  assert.equal(store.state.workspaces[ALPHA.id].scanHistory.length, 1)
  assert.deepEqual(store.state.workspaces[ALPHA.id].ruleFirstSeen, { 'ls-13': localDay(NOW) })
  assert.deepEqual(store.state.workspaces[BETA.id].ruleFirstSeen, { 'ls-02': localDay(NOW) })
})

test('the scan series is pruned with the call series', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(recordedScan({ at: NOW - 200 * DAY, files: 4, findings: [site()] }))
  await telemetry.record(recordedScan({ at: NOW, files: 4, findings: [site()] }))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.deepEqual(Object.keys(bucket.scanByDay), [localDay(NOW)])
  assert.equal(bucket.scanHistory.length, 1)
  // The lifetime bounds are not a window: the earliest day a rule was ever seen survives the prune.
  assert.equal(bucket.ruleFirstSeen['ls-13'], localDay(NOW - 200 * DAY))
  assert.equal(bucket.ruleLastSeen['ls-13'], localDay(NOW))
})

test('ruleFirstSeen only moves earlier and ruleLastSeen only later', async () => {
  const { telemetry, store } = telemetryWith({ options: { ruleIds: ['ls-02', 'ls-13'] } })

  await telemetry.record(recordedScan({ at: NOW - 5 * DAY, findings: [site('ls-13'), site('ls-13', 'other-code', 'src/b.css')] }))
  await telemetry.record(recordedScan({ at: NOW, findings: [site('ls-13')] }))
  // A clock that jumped backwards must not rewind either bound.
  await telemetry.record(recordedScan({ at: NOW - 2 * DAY, findings: [site('ls-13')] }))
  await telemetry.record(recordedScan({ at: NOW, findings: [site('ls-02')] }))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.equal(bucket.ruleFirstSeen['ls-13'], localDay(NOW - 5 * DAY))
  assert.equal(bucket.ruleLastSeen['ls-13'], localDay(NOW))
  assert.equal(bucket.ruleFirstSeen['ls-02'], localDay(NOW))
  // The key set is the lifetime counter's, so the three views of one rule agree.
  assert.deepEqual(Object.keys(bucket.ruleFirstSeen).sort(), Object.keys(bucket.scanRules).sort())
})

test('a bucket written before scan history loads with every new member empty', async () => {
  const seed = legacyDocument()
  seed.workspaces = {
    [ALPHA.id]: { name: 'app', since: NOW - 10 * DAY, scanRules: { 'ls-13': 2 }, scanGuides: { dialog: 2 }, lastScan: null },
  }
  const { telemetry, store } = telemetryWith({ store: memoryStore(seed) })

  await telemetry.flush()

  assert.equal(store.state.version, 1)
  const bucket = store.state.workspaces[ALPHA.id]
  // Member order is the writer's: the six history fields follow the five attribution ones.
  assert.deepEqual(Object.keys(bucket), [
    'name', 'since', 'scanRules', 'scanGuides', 'lastScan',
    'scanByDay', 'ruleFirstSeen', 'ruleLastSeen', 'scanHistory', 'lastSites', 'scanDiff',
  ])
  assert.deepEqual(bucket.scanByDay, {})
  assert.deepEqual(bucket.ruleFirstSeen, {})
  assert.deepEqual(bucket.ruleLastSeen, {})
  assert.deepEqual(bucket.scanHistory, [])
  assert.equal(bucket.lastSites, null)
  assert.equal(bucket.scanDiff, null)
  assert.deepEqual(bucket.scanRules, { 'ls-13': 2 })

  // The root is not a bucket: the legacy counters gain no scan-history member.
  for (const key of ['scanByDay', 'ruleFirstSeen', 'ruleLastSeen', 'scanHistory', 'lastSites', 'scanDiff']) {
    assert.equal(key in store.state, false, `${key} must not appear at the root`)
  }
})

test('corrupt scan-history members are dropped or rebuilt instead of shown', async () => {
  const seed = legacyDocument()
  seed.workspaces = {
    [ALPHA.id]: {
      name: 'app',
      since: NOW,
      scanRules: {},
      scanGuides: {},
      lastScan: null,
      scanByDay: {
        [localDay(NOW)]: { scans: 2, files: 'many', findings: 3 },
        'not-a-day': { scans: 9 },
        [localDay(NOW - DAY)]: { scans: 0 },
      },
      ruleFirstSeen: { 'ls-13': localDay(NOW), '': localDay(NOW), 'ls-02': 'nope' },
      ruleLastSeen: { 'ls-13': localDay(NOW - 3 * DAY) },
      scanHistory: [
        {
          at: new Date(NOW).toISOString(),
          outcome: 'findings',
          files: 1,
          findings: 2,
          rules: { 'ls-01': 12, 'ls-02': 11, 'ls-03': 10, 'ls-04': 9, 'ls-05': 8, 'ls-06': 7, 'ls-07': 6, 'ls-08': 5, 'ls-09': 4, 'ls-10': 3, 'ls-11': 2, 'ls-12': 1 },
          skipped: { extension: 9, binary: 2, large: 1, fifth: 1 },
          truncated: false,
          branch: { kind: 'branch', name: 'main' },
          diff: { resolved: 2, stillOpen: 1, new: 0 },
        },
        { at: 'not a date', outcome: 'findings' },
        { at: NOW, outcome: 'error' },
        'nonsense',
      ],
      lastSites: {
        at: new Date(NOW).toISOString(),
        files: 4,
        ruleCount: 2,
        rules: { 'ls-13': ['96cb61de', '96cb61de', 'not-a-key', 7], 'ls-02': ['0519e373'] },
      },
      scanDiff: { against: new Date(NOW - DAY).toISOString(), partial: 'not-a-token', resolved: 1 },
    },
  }
  const { telemetry, store } = telemetryWith({ store: memoryStore(seed) })

  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.deepEqual(bucket.scanByDay, { [localDay(NOW)]: { scans: 2, files: 0, findings: 3 } })
  assert.deepEqual(bucket.ruleFirstSeen, { 'ls-13': localDay(NOW) })
  assert.deepEqual(bucket.ruleLastSeen, { 'ls-13': localDay(NOW - 3 * DAY) })

  // Only the completed scan survives; its rule map and skip reasons are re-capped on the way in.
  assert.equal(bucket.scanHistory.length, 1)
  const entry = bucket.scanHistory[0]
  assert.equal(Object.keys(entry.rules).length, 10)
  assert.deepEqual(entry.skipped, { extension: 9, binary: 2, fifth: 1, large: 1 })
  assert.deepEqual(entry.branch, { kind: 'branch', name: 'main' })
  assert.deepEqual(entry.diff, { resolved: 2, stillOpen: 1, new: 0 })

  // An unrepresentable key is dropped, not guessed at; a duplicate is one site.
  assert.deepEqual(bucket.lastSites.rules, {
    'ls-02': ['0519e373'],
    'ls-13': ['96cb61de'],
  })
  // An unknown partial token makes the whole comparison unreadable: no numbers, no rows, nothing.
  assert.equal(bucket.scanDiff, null)
})

test('the history ring keeps the newest twenty completed scans', async () => {
  const { telemetry, store } = telemetryWith()

  for (let index = 0; index < 25; index += 1) {
    await telemetry.record(recordedScan({ at: NOW + index * 1000 }))
  }
  await telemetry.flush()

  const history = store.state.workspaces[ALPHA.id].scanHistory
  assert.equal(history.length, 20)
  assert.equal(history[0].at, new Date(NOW + 5 * 1000).toISOString())
  assert.equal(history.at(-1).at, new Date(NOW + 24 * 1000).toISOString())
})

test('one history entry keeps the top ten rules, count desc then id', async () => {
  const { telemetry, store } = telemetryWith()

  const findings = []
  for (let index = 1; index <= 12; index += 1) {
    const ruleId = `ls-${String(index).padStart(2, '0')}`
    for (let repetition = 0; repetition < 13 - index; repetition += 1) {
      findings.push(site(ruleId, `snippet ${index}-${repetition}`, `src/f${index}-${repetition}.css`))
    }
  }
  await telemetry.record(recordedScan({ files: 12, findings }))
  await telemetry.flush()

  const entry = store.state.workspaces[ALPHA.id].scanHistory[0]
  assert.deepEqual(entry.rules, {
    'ls-01': 12, 'ls-02': 11, 'ls-03': 10, 'ls-04': 9, 'ls-05': 8,
    'ls-06': 7, 'ls-07': 6, 'ls-08': 5, 'ls-09': 4, 'ls-10': 3,
  })
  assert.equal(entry.findings, findings.length)
})

test('a clean scan is a history entry with no rules and no findings', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(recordedScan({ findings: [] }))
  await telemetry.flush()

  const entry = store.state.workspaces[ALPHA.id].scanHistory[0]
  assert.equal(entry.outcome, 'clean')
  assert.deepEqual(entry.rules, {})
  assert.equal(entry.findings, 0)
})

test('each history entry carries the branch label of its own scan', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(recordedScan({ at: NOW, branch: { kind: 'branch', name: 'main' } }))
  await telemetry.record(recordedScan({ at: NOW + 1000, branch: { kind: 'detached', sha: 'a1b2c3d' } }))
  await telemetry.record(recordedScan({ at: NOW + 2000 }))
  await telemetry.flush()

  const history = store.state.workspaces[ALPHA.id].scanHistory
  assert.deepEqual(history[0].branch, { kind: 'branch', name: 'main' })
  assert.deepEqual(history[1].branch, { kind: 'detached', sha: 'a1b2c3d' })
  assert.equal('branch' in history[2], false)
  // The last scan has no label either: the member is absent, never a placeholder.
  assert.equal('branch' in store.state.workspaces[ALPHA.id].lastScan, false)
})

test('the first completed scan stores a baseline and reports nothing to compare', async () => {
  const { telemetry, store } = telemetryWith({ options: { ruleIds: ['ls-13'] } })

  await telemetry.record(recordedScan({ files: 4, findings: [site()] }))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.deepEqual(bucket.scanDiff, { against: null, partial: 'no-baseline' })
  assert.deepEqual(bucket.lastSites, {
    at: new Date(NOW).toISOString(),
    files: 4,
    ruleCount: 1,
    rules: { 'ls-13': [siteId('src/app.css', 'ls-13', '::-webkit-scrollbar')] },
  })
  // A skipped comparison stores no numbers and no diff on the entry: never zeros.
  assert.equal('diff' in bucket.scanHistory[0], false)
  for (const key of ['resolved', 'stillOpen', 'new', 'retired', 'rows']) {
    assert.equal(key in bucket.scanDiff, false, `${key} must not appear on a partial comparison`)
  }
})

test('a repaired site is resolved, a survivor is still open, and a new hit is new', async () => {
  const { telemetry, store } = telemetryWith({ options: { ruleIds: ['ls-02', 'ls-13'] } })

  const survives = siteId('src/b.css', 'ls-02', 'dialog')
  const added = siteId('src/app.css', 'ls-13', '::-webkit-scrollbar {')

  await telemetry.record(recordedScan({
    at: NOW,
    files: 4,
    findings: [site('ls-13', '::-webkit-scrollbar'), site('ls-02', 'dialog', 'src/b.css')],
  }))
  await telemetry.record(recordedScan({
    at: NOW + 1000,
    files: 4,
    findings: [site('ls-02', 'dialog', 'src/b.css'), site('ls-13', '::-webkit-scrollbar {')],
  }))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.deepEqual(bucket.scanDiff, {
    against: new Date(NOW).toISOString(),
    resolved: 1,
    stillOpen: 1,
    new: 1,
    retired: 0,
    partial: null,
    rows: [
      { ruleId: 'ls-13', resolved: 1, stillOpen: 0, new: 1 },
      { ruleId: 'ls-02', resolved: 0, stillOpen: 1, new: 0 },
    ],
  })
  // The numbers describe two scans, not a lifetime: 2 previous sites in, 2 current sites out.
  assert.equal(bucket.scanDiff.resolved + bucket.scanDiff.stillOpen + bucket.scanDiff.retired, 2)
  assert.equal(bucket.scanDiff.stillOpen + bucket.scanDiff.new, 2)
  // The entry keeps the compact copy; the first entry had no baseline so it has none.
  assert.deepEqual(bucket.scanHistory.at(-1).diff, { resolved: 1, stillOpen: 1, new: 1 })
  assert.equal('diff' in bucket.scanHistory[0], false)
  // And the baseline is now the current scan, not the previous one.
  assert.equal(bucket.lastSites.at, new Date(NOW + 1000).toISOString())
  assert.deepEqual(bucket.lastSites.rules, {
    'ls-02': [survives],
    'ls-13': [added],
  })
})

test('a duplicate or moved site stays open instead of inventing a fix', async () => {
  const { telemetry, store } = telemetryWith({ options: { ruleIds: ['ls-13'] } })

  // Two byte-identical sites are one site, and a re-run after a line insertion is the same site.
  await telemetry.record(recordedScan({ at: NOW, files: 4, findings: [site(), site()] }))
  await telemetry.record(recordedScan({ at: NOW + 1000, files: 4, findings: [site()] }))
  await telemetry.flush()

  const diff = store.state.workspaces[ALPHA.id].scanDiff
  assert.equal(diff.resolved, 0)
  assert.equal(diff.stillOpen, 1)
  assert.equal(diff.new, 0)
  assert.deepEqual(diff.rows, [{ ruleId: 'ls-13', resolved: 0, stillOpen: 1, new: 0 }])
})

test('a rule the current table no longer ships is retired, never resolved', async () => {
  const store = memoryStore()
  const before = createTelemetry({ store, clock: () => NOW, retentionDays: 90, catalog: CATALOG, ruleIds: ['ls-02', 'ls-13'] })
  await before.record(recordedScan({ at: NOW, files: 4, findings: [site('ls-13'), site('ls-02', 'dialog', 'src/b.css')] }))
  await before.flush()

  // Same rule count, one id swapped: the table guard passes, so the comparison runs and retires ls-13.
  const after = createTelemetry({ store, clock: () => NOW, retentionDays: 90, catalog: CATALOG, ruleIds: ['ls-02', 'ls-33'] })
  await after.record(recordedScan({ at: NOW + 1000, files: 4, findings: [site('ls-02', 'dialog', 'src/b.css')] }))
  await after.flush()

  const diff = store.state.workspaces[ALPHA.id].scanDiff
  assert.equal(diff.resolved, 0)
  assert.equal(diff.retired, 1)
  assert.equal(diff.stillOpen, 1)
  assert.equal(diff.new, 0)
  // A retired rule's row is all zeros, so it is not a row at all.
  assert.deepEqual(diff.rows, [{ ruleId: 'ls-02', resolved: 0, stillOpen: 1, new: 0 }])
})

test('every comparison refusal is stored as its token with no numbers', async () => {
  const rules = ['ls-02', 'ls-13']

  // sites-unknown: a finding without a snippet cannot be hashed, so nothing may be compared.
  const unknown = telemetryWith({ options: { ruleIds: rules } })
  await unknown.telemetry.record(recordedScan({ findings: [site('ls-13'), { path: 'src/a.css', ruleId: 'ls-02' }] }))
  await unknown.telemetry.flush()
  assert.deepEqual(unknown.store.state.workspaces[ALPHA.id].scanDiff, { against: null, partial: 'sites-unknown' })

  // truncated: the cap cut the finding list, so sites past the cut would read as fixed.
  const truncated = telemetryWith({ options: { ruleIds: rules } })
  await truncated.telemetry.record(recordedScan({ truncated: true, findings: [site('ls-13')] }))
  await truncated.telemetry.flush()
  assert.deepEqual(truncated.store.state.workspaces[ALPHA.id].scanDiff, { against: null, partial: 'truncated' })

  // no-files: an empty walk proves nothing about absence.
  const empty = telemetryWith({ options: { ruleIds: rules } })
  await empty.telemetry.record(recordedScan({ files: 0 }))
  await empty.telemetry.flush()
  assert.deepEqual(empty.store.state.workspaces[ALPHA.id].scanDiff, { against: null, partial: 'no-files' })

  // fewer-files: a narrower scan cannot prove the missing sites were fixed, and keeps the old baseline.
  const narrower = telemetryWith({ options: { ruleIds: rules } })
  await narrower.telemetry.record(recordedScan({ at: NOW, files: 4, findings: [site('ls-13')] }))
  await narrower.telemetry.record(recordedScan({ at: NOW + 1000, files: 2 }))
  await narrower.telemetry.flush()
  const narrowBucket = narrower.store.state.workspaces[ALPHA.id]
  assert.deepEqual(narrowBucket.scanDiff, { against: new Date(NOW).toISOString(), partial: 'fewer-files' })
  assert.equal(narrowBucket.lastSites.files, 4)

  // branch-changed: two checkouts differ by their tree, not by a fix, and the new branch is the baseline.
  const branched = telemetryWith({ options: { ruleIds: rules } })
  await branched.telemetry.record(recordedScan({ at: NOW, files: 4, branch: { kind: 'branch', name: 'main' }, findings: [site('ls-13')] }))
  await branched.telemetry.record(recordedScan({ at: NOW + 1000, files: 4, branch: { kind: 'branch', name: 'feature/x' } }))
  await branched.telemetry.flush()
  assert.deepEqual(branched.store.state.workspaces[ALPHA.id].scanDiff, {
    against: new Date(NOW).toISOString(),
    partial: 'branch-changed',
  })
  assert.deepEqual(branched.store.state.workspaces[ALPHA.id].lastSites.branch, { kind: 'branch', name: 'feature/x' })

  // rule-table-changed: a release added a rule, so this comparison would call every new id new.
  const store = memoryStore()
  const before = createTelemetry({ store, clock: () => NOW, retentionDays: 90, catalog: CATALOG, ruleIds: rules })
  await before.record(recordedScan({ at: NOW, files: 4, findings: [site('ls-13')] }))
  await before.flush()
  const after = createTelemetry({ store, clock: () => NOW, retentionDays: 90, catalog: CATALOG, ruleIds: [...rules, 'ls-33'] })
  await after.record(recordedScan({ at: NOW + 1000, files: 4, findings: [site('ls-13')] }))
  await after.flush()
  assert.deepEqual(store.state.workspaces[ALPHA.id].scanDiff, {
    against: new Date(NOW).toISOString(),
    partial: 'rule-table-changed',
  })
  assert.equal(store.state.workspaces[ALPHA.id].lastSites.ruleCount, 3)
})

test('a truncated or empty scan never becomes the next comparison yardstick', async () => {
  const { telemetry, store } = telemetryWith({ options: { ruleIds: ['ls-13'] } })

  await telemetry.record(recordedScan({ at: NOW, files: 4, findings: [site()] }))
  await telemetry.record(recordedScan({ at: NOW + 1000, files: 9, truncated: true, findings: [site('ls-13', 'other', 'src/b.css')] }))
  await telemetry.record(recordedScan({ at: NOW + 2000, files: 0 }))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  // The baseline is still the first scan: neither later scan may testify.
  assert.equal(bucket.lastSites.at, new Date(NOW).toISOString())
  assert.deepEqual(bucket.lastSites.rules, { 'ls-13': [siteId('src/app.css', 'ls-13', '::-webkit-scrollbar')] })
  // The refusals are named on their own scans, in order.
  const history = bucket.scanHistory
  assert.equal(history.length, 3)
  assert.deepEqual(bucket.scanDiff, { against: new Date(NOW).toISOString(), partial: 'no-files' })
})

test('a baseline and comparison older than the window read as absent', async () => {
  const { telemetry, store } = telemetryWith()

  await telemetry.record(recordedScan({ at: NOW - 200 * DAY, files: 4, findings: [site()] }))
  await telemetry.flush()

  const bucket = store.state.workspaces[ALPHA.id]
  assert.equal(bucket.lastScan, null)
  assert.equal(bucket.lastSites, null)
  assert.equal(bucket.scanDiff, null)
  assert.deepEqual(bucket.scanByDay, {})
  assert.deepEqual(bucket.scanHistory, [])
  // The lifetime counters are not a window: they keep the scan the window forgot.
  assert.deepEqual(bucket.scanRules, { 'ls-13': 1 })
  assert.equal(bucket.ruleFirstSeen['ls-13'], localDay(NOW - 200 * DAY))
})

// --- What the snapshot exposes: series, history, comparison and the dates on a rule row ----------

test('the snapshot series covers the window with zeros and is absent for a pre-B document', async () => {
  const preB = telemetryWith({ store: memoryStore(legacyDocument()) })
  // No `scanByDay` anywhere: the key is absent, so a consumer draws no chart rather than a flat line.
  assert.equal('scanSeries' in (await preB.telemetry.snapshot({ days: 7 })), false)

  const { telemetry } = telemetryWith()
  await telemetry.record(recordedScan({ at: NOW - 2 * DAY, files: 4, findings: [site()] }))
  await telemetry.record(recordedScan({ at: NOW, files: 2 }))

  const snapshot = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(snapshot.scanSeries.length, 7)
  assert.deepEqual(snapshot.scanSeries[0], { day: localDay(NOW - 6 * DAY), scans: 0, files: 0, findings: 0 })
  assert.deepEqual(snapshot.scanSeries.at(-3), { day: localDay(NOW - 2 * DAY), scans: 1, files: 4, findings: 1 })
  assert.deepEqual(snapshot.scanSeries.at(-1), { day: localDay(NOW), scans: 1, files: 2, findings: 0 })
})

test('history is newest first, labelled only when the aggregate merges buckets', async () => {
  const { telemetry } = telemetryWith()
  await telemetry.record(recordedScan({ at: NOW - 1000, findings: [site()] }))
  await telemetry.record(recordedScan({ at: NOW, files: 2, findings: [site()], workspace: BETA }))

  // A selected bucket keeps the rows as stored and names the scope once, in `workspace`.
  const alpha = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(alpha.scanHistory.length, 1)
  assert.equal('workspace' in alpha.scanHistory[0], false)
  assert.equal(alpha.scanDiff.partial, 'no-baseline')

  const all = await telemetry.snapshot({ days: 7 })
  assert.deepEqual(all.scanHistory.map((row) => row.at), [
    new Date(NOW).toISOString(),
    new Date(NOW - 1000).toISOString(),
  ])
  assert.deepEqual(all.scanHistory.map((row) => row.workspace), [BETA, ALPHA])
  // Comparing two projects would compare two trees, so an aggregate carries no comparison at all.
  assert.equal(all.scanDiff, null)

  // The legacy root is not a bucket: it answers empty rather than borrowing a workspace's history.
  const root = await telemetry.snapshot({ days: 7, workspace: '_unattributed' })
  assert.deepEqual(root.scanHistory, [])
  assert.equal(root.scanDiff, null)
  assert.equal('scanSeries' in root, false)
})

test('ranked rule rows carry the days the rule was seen, null when the scope has none', async () => {
  const { telemetry } = telemetryWith({ store: memoryStore(legacyDocument()) })

  // The legacy root's rules have no bucket behind them, so their dates are unknown, never invented.
  const root = await telemetry.snapshot({ days: 7, workspace: '_unattributed' })
  assert.deepEqual(root.topRules, [ruleRow('ls-13', 4), ruleRow('ls-02', 2)])

  await telemetry.record(recordedScan({ at: NOW - 3 * DAY, findings: [site('ls-13')] }))
  await telemetry.record(recordedScan({ at: NOW, findings: [site('ls-13')] }))

  const bucket = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.deepEqual(bucket.topRules, [ruleRow('ls-13', 2, localDay(NOW - 3 * DAY), localDay(NOW))])
})

test('a muted count is written by a scan, clamped to its findings, and never by another call', async () => {
  const { telemetry, store } = telemetryWith()

  // A guidance call that happens to carry the member must not mint one: only a completed scan can
  // claim what it muted, because only a completed scan had findings to mute.
  await telemetry.record({ at: NOW, tool: 'search', outcome: 'hit', query: 'dialog', suppressed: 5 })
  await telemetry.record({
    at: NOW,
    tool: 'legacy-scan',
    workspace: ALPHA,
    ...scanEntry([finding('ls-13', 'guide-a'), finding('ls-17', 'guide-b')], 2),
  })

  const clean = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(clean.lastScan.suppressed, 0, 'the scan ran and muted nothing, so it says 0')
  assert.equal('suppressedRules' in clean.lastScan, false, 'a split with nothing in it is not written')
  assert.equal(clean.scanHistory[0].suppressed, 0)
  await telemetry.flush()
  assert.equal('suppressed' in store.state, false, 'one scan is never a lifetime total')

  // A muted pair, and a caller that claims more mutes than the scan returned findings.
  await telemetry.record({
    at: NOW + DAY,
    tool: 'legacy-scan',
    workspace: ALPHA,
    ...scanEntry([
      { ...finding('ls-13', 'guide-a'), suppressed: true },
      { ...finding('ls-13', 'guide-a', 'src/other.css'), suppressed: true },
    ], 2),
    suppressed: 99,
  })

  const muted = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(muted.lastScan.suppressed, 2, 'a subset can never exceed its whole')
  assert.deepEqual(muted.lastScan.suppressedRules, { 'ls-13': 2 })
  assert.equal(muted.lastScan.findings, 2, 'the muted findings are still findings')
  assert.equal(muted.scanHistory[0].suppressed, 2)
  assert.equal(muted.scanHistory[1].suppressed, 0)
})
