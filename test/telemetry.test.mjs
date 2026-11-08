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
