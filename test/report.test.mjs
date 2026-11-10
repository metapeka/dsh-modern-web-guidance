import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderJson, renderReport } from '../lib/report.js'

/**
 * A small hand-written snapshot, matching the contract `lib/telemetry.js` is expected to
 * produce. It is deliberately not imported from telemetry: the renderer must stay testable
 * without the counter store, and this file documents the exact input shape it relies on.
 */
const SMALL = {
  periodDays: 30,
  generatedAt: '2026-11-08T13:20:00.000Z',
  corpus: { version: '2026_10_30-58d055df', snapshotDate: '2026-10-30', total: 193 },
  totals: {
    calls: 128,
    hitRate: 0.8281,
    byTool: { web_guidance_search: 96, web_guidance_retrieve: 27, web_guidance_list: 5 },
    byOutcome: { hit: 80, miss: 13, unknown: 3, list: 5, error: 1 },
  },
  topQueries: [
    { query: 'light dismiss dialog', calls: 9, hits: 9, misses: 0, lastAt: '2026-11-08T09:12:00.000Z' },
    { query: 'responsive data table', calls: 4, hits: 4, misses: 0, lastAt: '2026-11-07T18:40:00.000Z' },
  ],
  misses: [
    { query: 'scroll linked animation', calls: 4, lastAt: '2026-11-07T11:02:00.000Z' },
    { query: 'browser support for view transitions', calls: 2, lastAt: '2026-11-06T08:30:00.000Z' },
  ],
  coverage: [
    { category: 'css', retrieved: 12, total: 58 },
    { category: 'ui-components', retrieved: 3, total: 14 },
  ],
  deadGuides: { total: 171, sample: ['anchor-positioning-tab-underline', 'scroll-linked-effects'] },
  series: [
    { day: '2026-11-07', calls: 40 },
    { day: '2026-11-08', calls: 88 },
  ],
}

/**
 * The same shape once the fourth tool has been counted: one scan that read 24 files and raised
 * three findings. The numbers add up (6 search + 2 retrieve + 1 list + 1 scan = 10 calls) so the
 * fixture reads like a real week rather than a bag of fields.
 */
const WITH_SCAN = {
  periodDays: 7,
  generatedAt: '2026-11-10T12:00:00.000Z',
  corpus: { version: '2026_11_09-5bcc021b', snapshotDate: '2026-11-09', total: 208 },
  totals: {
    calls: 10,
    hitRate: 0.6,
    byTool: { search: 6, retrieve: 2, list: 1, 'legacy-scan': 1 },
    byOutcome: { hit: 6, miss: 1, list: 1, 'unknown-id': 1, clean: 1 },
    files: 24,
    findings: 3,
  },
  topQueries: [
    { query: 'light dismiss dialog', calls: 3, hits: 3, misses: 0, lastAt: '2026-11-10T09:12:00.000Z' },
    { query: 'responsive data table', calls: 2, hits: 2, misses: 0, lastAt: '2026-11-10T08:40:00.000Z' },
  ],
  misses: [{ query: 'scroll linked animation', calls: 1, lastAt: '2026-11-10T07:02:00.000Z' }],
  coverage: [
    { category: 'css', retrieved: 2, total: 58 },
    { category: 'ui-components', retrieved: 1, total: 14 },
  ],
  deadGuides: { total: 205, sample: ['anchor-positioning-tab-underline'] },
  series: [{ day: '2026-11-10', calls: 10 }],
}

test('renders every section in the documented order', () => {
  const text = renderReport(SMALL)
  const markers = [
    'Guidance usage:',
    'Queries that returned nothing:',
    'Top queries:',
    'Category coverage:',
    'Dead guides:',
    'Corpus:',
    'Period:',
  ]
  const positions = markers.map((marker) => text.indexOf(marker))
  for (const [index, position] of positions.entries()) {
    assert.ok(position >= 0, `missing section: ${markers[index]}`)
  }
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index] > positions[index - 1],
      `${markers[index]} must come after ${markers[index - 1]}`,
    )
  }
})

test('KPI block reports calls, hit rate, and tool and outcome splits', () => {
  const text = renderReport(SMALL)
  assert.match(text, /Guidance usage: 128 calls, 83% hit rate/)
  assert.match(text, /Calls by tool: web_guidance_search 96, web_guidance_retrieve 27, web_guidance_list 5/)
  assert.match(text, /Calls by outcome: hit 80, miss 13, list 5, unknown 3, error 1/)
})

test('hit rate is a whole percentage and counts carry no thousands separators', () => {
  const snapshot = {
    ...SMALL,
    totals: {
      calls: 1284,
      hitRate: 0.5,
      byTool: { web_guidance_search: 1284 },
      byOutcome: { hit: 642, miss: 642 },
    },
  }
  const text = renderReport(snapshot)
  assert.match(text, /Guidance usage: 1284 calls, 50% hit rate/)
  assert.doesNotMatch(text, /1,284/)

  for (const [ratio, expected] of [[0.004, '0%'], [0.5, '50%'], [0.826, '83%'], [1, '100%']]) {
    const rendered = renderReport({ ...snapshot, totals: { ...snapshot.totals, hitRate: ratio } })
    assert.match(rendered, new RegExp(`${expected} hit rate`))
  }
})

test('hit rate falls back to outcome counters when the field is missing', () => {
  const text = renderReport({ ...SMALL, totals: { calls: 10, byOutcome: { hit: 7, miss: 3 } } })
  assert.match(text, /Guidance usage: 10 calls, 70% hit rate/)
})

test('numbered rows show counts and the date part of lastAt', () => {
  const text = renderReport(SMALL)
  assert.match(text, /^ {2}1\. scroll linked animation - 4 calls, last 2026-11-07$/m)
  assert.match(
    text,
    /^ {2}1\. light dismiss dialog - 9 calls, 9 hits, 0 misses, last 2026-11-08$/m,
  )
  assert.match(text, /^ {2}1\. css: 12 of 58 retrieved$/m)
})

test('truncated sections state how many rows they hid', () => {
  const misses = Array.from({ length: 12 }, (_, index) => ({
    query: `miss ${index + 1}`,
    calls: 12 - index,
    lastAt: '2026-11-07T00:00:00.000Z',
  }))
  const topQueries = Array.from({ length: 20 }, (_, index) => ({
    query: `query ${index + 1}`,
    calls: 20 - index,
    hits: 20 - index,
    misses: 0,
    lastAt: '2026-11-07T00:00:00.000Z',
  }))
  const sample = Array.from({ length: 25 }, (_, index) => `guide-${index + 1}`)
  const text = renderReport({ ...SMALL, misses, topQueries, deadGuides: { total: 40, sample } })

  assert.match(text, /and 2 more/)
  assert.match(text, /and 5 more/)
  assert.match(text, /and 20 more/)

  assert.match(text, /^ {2}10\. miss 10 - 3 calls, last 2026-11-07$/m)
  assert.doesNotMatch(text, /miss 11/)
  assert.match(text, /^ {2}15\. query 15 - 6 calls, 6 hits, 0 misses, last 2026-11-07$/m)
  assert.doesNotMatch(text, /query 16 -/)
  assert.match(text, /^ {2}guide-1$/m)
  assert.match(text, /^ {2}guide-20$/m)
  assert.doesNotMatch(text, /^ {2}guide-21$/m)
})

test('no calls renders the empty state instead of zero-filled tables', () => {
  const text = renderReport({
    ...SMALL,
    totals: { calls: 0, hitRate: 0, byTool: {}, byOutcome: {} },
    topQueries: [],
    misses: [],
    coverage: [],
    deadGuides: { total: 193, sample: [] },
    series: [],
  })

  assert.ok(
    text.includes(
      'No calls recorded in the last 30 days. ' +
      'Search a guide first, then run /guidance-stats again.',
    ),
  )
  assert.match(text, /Corpus: version 2026_10_30-58d055df, snapshot 2026-10-30, 193 guides/)
  assert.match(text, /Period: last 30 days \(generated 2026-11-08T13:20:00\.000Z\)/)

  for (const heading of [
    'Guidance usage:',
    'Calls by tool:',
    'Calls by outcome:',
    'Queries that returned nothing',
    'Top queries',
    'Category coverage',
    'Dead guides',
  ]) {
    assert.ok(!text.includes(heading), `empty state must not render "${heading}"`)
  }
})

test('an empty dead guide set renders a sensible line', () => {
  const text = renderReport({ ...SMALL, deadGuides: { total: 0, sample: [] } })
  assert.match(
    text,
    /^Dead guides: none; every guide in the corpus has been retrieved at least once\.$/m,
  )
  assert.doesNotMatch(text, /never been retrieved/)
  assert.doesNotMatch(text, /and \d+ more/)
})

test('renderJson passes the snapshot through unchanged', () => {
  const json = renderJson(SMALL)
  assert.deepEqual(json, {
    periodDays: SMALL.periodDays,
    corpus: SMALL.corpus,
    totals: SMALL.totals,
    topQueries: SMALL.topQueries,
    misses: SMALL.misses,
    coverage: SMALL.coverage,
    deadGuides: SMALL.deadGuides,
    series: SMALL.series,
  })
  assert.equal('generatedAt' in json, false)
  assert.equal(json.totals.hitRate, 0.8281)
  assert.equal(json.totals.byTool.web_guidance_search, 96)
  assert.equal(json.series, SMALL.series)
  assert.equal(json.misses, SMALL.misses)
})

test('renderJson of an empty report still carries the shape', () => {
  const empty = {
    periodDays: 30,
    generatedAt: '2026-11-08T13:20:00.000Z',
    corpus: SMALL.corpus,
    totals: { calls: 0, hitRate: 0, byTool: {}, byOutcome: {} },
    topQueries: [],
    misses: [],
    coverage: [],
    deadGuides: { total: 0, sample: [] },
    series: [],
  }
  assert.deepEqual(renderJson(empty), {
    periodDays: 30,
    corpus: SMALL.corpus,
    totals: empty.totals,
    topQueries: [],
    misses: [],
    coverage: [],
    deadGuides: empty.deadGuides,
    series: [],
  })
})

test('report is plain text with no colours or emoji', () => {
  const text = renderReport(SMALL)
  assert.doesNotMatch(text, /\u001b\[/)
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
})

test('query text stays on one line and is capped', () => {
  const long = 'a'.repeat(200)
  const text = renderReport({
    ...SMALL,
    misses: [
      { query: 'scroll\nlinked   animation', calls: 1, lastAt: '2026-11-07' },
      { query: long, calls: 1, lastAt: '2026-11-07' },
    ],
  })
  assert.match(text, /^ {2}1\. scroll linked animation - 1 call, last 2026-11-07$/m)
  assert.match(text, /a{117}\.\.\./)
})

test('a sparse snapshot degrades instead of throwing', () => {
  const text = renderReport({ periodDays: 7, totals: { calls: 2, hitRate: 1 } })
  assert.match(text, /Guidance usage: 2 calls, 100% hit rate/)
  assert.match(text, /Queries that returned nothing: none this period\./)
  assert.match(text, /Top queries: none this period\./)
  assert.match(text, /Category coverage: none in this snapshot\./)
  assert.match(text, /Corpus: version unknown, snapshot unknown, unknown guides/)
  assert.match(text, /Period: last 7 days/)
})

test('rendering never mutates the snapshot', () => {
  const snapshot = structuredClone(SMALL)
  const before = structuredClone(snapshot)
  renderReport(snapshot)
  renderJson(snapshot)
  assert.deepEqual(snapshot, before)
})

test('a counted legacy scan adds one KPI line with files and findings', () => {
  const text = renderReport(WITH_SCAN)
  assert.match(text, /^Legacy scans: 1 call, 24 files scanned, 3 findings$/m)
  assert.match(text, /Calls by tool: search 6, retrieve 2, legacy-scan 1, list 1/)
  // The scan line belongs to the KPI block, before the lists.
  const scanAt = text.indexOf('Legacy scans:')
  assert.ok(scanAt > text.indexOf('Calls by outcome:'))
  assert.ok(scanAt < text.indexOf('Queries that returned nothing:'))
})

test('plural scan counts read like prose', () => {
  const text = renderReport({
    ...WITH_SCAN,
    totals: {
      ...WITH_SCAN.totals,
      calls: 20,
      byTool: { ...WITH_SCAN.totals.byTool, 'legacy-scan': 2 },
      files: 40,
      findings: 7,
    },
  })
  assert.match(text, /^Legacy scans: 2 calls, 40 files scanned, 7 findings$/m)
})

test('a clean scan reports its files even with no findings', () => {
  const text = renderReport({
    ...WITH_SCAN,
    totals: { ...WITH_SCAN.totals, findings: 0 },
  })
  assert.match(text, /^Legacy scans: 1 call, 24 files scanned, 0 findings$/m)
})

test('renderJson carries tools[legacy-scan] and the findings total', () => {
  const json = renderJson(WITH_SCAN)
  assert.deepEqual(json.tools, {
    'legacy-scan': { total: 1, files: 24, findings: 3 },
  })
  assert.equal(json.findings, 3)
  assert.equal(json.totals, WITH_SCAN.totals)
  assert.equal(json.totals.findings, 3)
  assert.equal(json.series, WITH_SCAN.series)
})

test('a snapshot from a 0.4.x state file renders no scan section', () => {
  const text = renderReport(SMALL)
  assert.doesNotMatch(text, /legacy-scan/)
  assert.doesNotMatch(text, /Legacy scans/)
  assert.doesNotMatch(text, /files scanned/)

  const json = renderJson(SMALL)
  assert.equal('tools' in json, false)
  assert.equal('findings' in json, false)
})

test('the empty state stays scan-free even when totals are sparse', () => {
  const text = renderReport({
    ...WITH_SCAN,
    totals: { calls: 0, hitRate: 0, byTool: {}, byOutcome: {}, files: 0, findings: 0 },
    topQueries: [],
    misses: [],
    coverage: [],
  })
  assert.match(text, /No calls recorded in the last 7 days/)
  assert.doesNotMatch(text, /Legacy scans/)
  assert.equal('tools' in renderJson({ ...WITH_SCAN, totals: { calls: 0, byTool: {} } }), false)
})
