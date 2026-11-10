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

/**
 * A snapshot from a 0.6.0 state file: the scan totals plus per-rule counters, the top scan guides
 * and the last scan. The rules arrive unordered and longer than the five the text report shows, so
 * the tests prove the ranking and the cap instead of the fixture's own order.
 */
const RICH = {
  ...WITH_SCAN,
  topRules: [
    { ruleId: 'ls-08', count: 2 },
    { ruleId: 'ls-13', count: 4 },
    { ruleId: 'ls-21', count: 2 },
    { ruleId: 'ls-05', count: 1 },
    { ruleId: 'ls-17', count: 1 },
    { ruleId: 'ls-33', count: 1 },
  ],
  topScanGuides: [
    { guideId: 'dialog', count: 2 },
    { guideId: 'css-anchor', count: 3 },
  ],
  lastScan: {
    at: '2026-11-10T09:42:11.000Z',
    files: 12,
    findings: 4,
    rules: ['ls-05', 'ls-08', 'ls-13', 'ls-17', 'ls-21', 'ls-33'],
  },
}

/**
 * The exact text 0.6.0 produced for `SMALL`, captured before the scan detail lines were added. The
 * fixture has no scan counters at all, so nothing new may appear: not a line, not a blank line.
 */
const SMALL_GOLDEN = [
  'Guidance usage: 128 calls, 83% hit rate',
  'Calls by tool: web_guidance_search 96, web_guidance_retrieve 27, web_guidance_list 5',
  'Calls by outcome: hit 80, miss 13, list 5, unknown 3, error 1',
  '',
  'Queries that returned nothing:',
  '  1. scroll linked animation - 4 calls, last 2026-11-07',
  '  2. browser support for view transitions - 2 calls, last 2026-11-06',
  '',
  'Top queries:',
  '  1. light dismiss dialog - 9 calls, 9 hits, 0 misses, last 2026-11-08',
  '  2. responsive data table - 4 calls, 4 hits, 0 misses, last 2026-11-07',
  '',
  'Category coverage:',
  '  1. css: 12 of 58 retrieved',
  '  2. ui-components: 3 of 14 retrieved',
  '',
  'Dead guides: 171 of 193 guides have never been retrieved.',
  '  anchor-positioning-tab-underline',
  '  scroll-linked-effects',
  '  and 169 more',
  '',
  'Corpus: version 2026_10_30-58d055df, snapshot 2026-10-30, 193 guides',
  'Period: last 30 days (generated 2026-11-08T13:20:00.000Z)',
].join('\n')

/**
 * The same capture for `WITH_SCAN`, a 0.5.0-style state file: it has scan totals but no per-rule
 * detail, so it also must render exactly as it did before the detail lines existed.
 */
const WITH_SCAN_GOLDEN = [
  'Guidance usage: 10 calls, 60% hit rate',
  'Calls by tool: search 6, retrieve 2, legacy-scan 1, list 1',
  'Calls by outcome: hit 6, clean 1, list 1, miss 1, unknown-id 1',
  'Legacy scans: 1 call, 24 files scanned, 3 findings',
  '',
  'Queries that returned nothing:',
  '  1. scroll linked animation - 1 call, last 2026-11-10',
  '',
  'Top queries:',
  '  1. light dismiss dialog - 3 calls, 3 hits, 0 misses, last 2026-11-10',
  '  2. responsive data table - 2 calls, 2 hits, 0 misses, last 2026-11-10',
  '',
  'Category coverage:',
  '  1. css: 2 of 58 retrieved',
  '  2. ui-components: 1 of 14 retrieved',
  '',
  'Dead guides: 205 of 208 guides have never been retrieved.',
  '  anchor-positioning-tab-underline',
  '  and 204 more',
  '',
  'Corpus: version 2026_11_09-5bcc021b, snapshot 2026-11-09, 208 guides',
  'Period: last 7 days (generated 2026-11-10T12:00:00.000Z)',
].join('\n')

/**
 * A one-rule slice of the scanner's table (`RULES` in `lib/scan-rules.js`), copied exactly as that
 * table writes it. The enrichment tests feed this in instead of importing the real table: the
 * renderer's contract is "look the id up and pass the text through", and a local fixture keeps that
 * visible without pinning the test to a rule the scanner may retire.
 */
const RULE_TABLE = [
  {
    id: 'ls-17',
    guideId: 'html',
    confidence: 'medium',
    message: 'Build the DOM with createElement/append instead of document.write(), which discards the parsed document.',
    source: 'document\\.write(?:ln)?\\s*\\(',
  },
]

/**
 * The catalog's `guideId -> description` record as `readCatalog()` derives it from
 * `data/guides.json`. Two ids only: `dialog` is known, and every other id in `RICH` must read as an
 * unknown guide, which is the case worth proving.
 */
const GUIDE_DESCRIPTIONS = {
  dialog: 'Use the native dialog element with showModal() for modal and non-modal dialogs.',
  html: 'How a modern HTML page is structured: semantic elements, forms, and script loading.',
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
    topRules: [],
    topScanGuides: [],
    lastScan: null,
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
    topRules: [],
    topScanGuides: [],
    lastScan: null,
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
  for (const fixture of [SMALL, RICH]) {
    const snapshot = structuredClone(fixture)
    const before = structuredClone(snapshot)
    renderReport(snapshot)
    renderJson(snapshot)
    renderJson(snapshot, { rules: RULE_TABLE, guides: GUIDE_DESCRIPTIONS })
    assert.deepEqual(snapshot, before)
  }
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

test('a no-scan snapshot renders byte-identically to 0.6.0', () => {
  assert.equal(renderReport(SMALL), SMALL_GOLDEN)
})

test('a 0.5.0 snapshot with scan totals but no detail adds no lines', () => {
  assert.equal(renderReport(WITH_SCAN), WITH_SCAN_GOLDEN)
  assert.doesNotMatch(renderReport(WITH_SCAN), /Most matched rules|Last scan:/)
})

test('scan detail lines follow the scan KPI and precede the lists', () => {
  const text = renderReport(RICH)
  const rulesAt = text.indexOf('Most matched rules:')
  const lastAt = text.indexOf('Last scan:')
  assert.ok(rulesAt > text.indexOf('Legacy scans:'))
  assert.ok(lastAt > rulesAt)
  assert.ok(lastAt < text.indexOf('Queries that returned nothing:'))
  assert.match(text, /^Most matched rules: ls-13 4, ls-08 2, ls-21 2, ls-05 1, ls-17 1$/m)
  assert.match(
    text,
    /^Last scan: 2026-11-10, 12 files, 4 findings \(rules: ls-05, ls-08, ls-13, ls-17, ls-21\)$/m,
  )
})

test('the rules line stops at five, ranked by count then rule id', () => {
  // Six rules were recorded; the sixth is not named in the text.
  assert.doesNotMatch(renderReport(RICH), /ls-33/)

  const rules = renderReport({
    ...RICH,
    topRules: [
      { ruleId: 'ls-33', count: 1 },
      { ruleId: 'ls-09', count: 5 },
      { ruleId: 'ls-02', count: 3 },
      { ruleId: 'ls-07', count: 3 },
      { ruleId: 'ls-11', count: 2 },
      { ruleId: 'ls-14', count: 2 },
      { ruleId: 'ls-19', count: 2 },
    ],
  })
  assert.match(rules, /^Most matched rules: ls-09 5, ls-02 3, ls-07 3, ls-11 2, ls-14 2$/m)
})

test('lastScan: null keeps the rules line and omits only the last scan line', () => {
  const text = renderReport({ ...RICH, lastScan: null })
  assert.match(text, /^Most matched rules: /m)
  assert.doesNotMatch(text, /Last scan:/)
  assert.match(text, /Legacy scans: 1 call, 24 files scanned, 3 findings/)
})

test('the last scan date uses the date shape of the other timestamps', () => {
  const line = renderReport(RICH).split('\n').find((entry) => entry.startsWith('Last scan:'))
  assert.match(line, /^Last scan: 2026-11-10, /)
  assert.doesNotMatch(line, /T09:42/)
  // A date-only value renders the same way.
  const plain = renderReport({ ...RICH, lastScan: { ...RICH.lastScan, at: '2026-11-10' } })
  assert.match(plain, /^Last scan: 2026-11-10, /m)
})

test('the last scan appends rule ids only when present, at most five', () => {
  const none = renderReport({ ...RICH, lastScan: { ...RICH.lastScan, rules: [] } })
  assert.match(none, /^Last scan: 2026-11-10, 12 files, 4 findings$/m)
  assert.doesNotMatch(none, /\(rules:/)

  const capped = renderReport({
    ...RICH,
    lastScan: { ...RICH.lastScan, rules: ['ls-01', 'ls-02', 'ls-03', 'ls-04', 'ls-05', 'ls-06'] },
  })
  assert.match(capped, /\(rules: ls-01, ls-02, ls-03, ls-04, ls-05\)$/m)
  assert.doesNotMatch(capped, /ls-06/)
})

test('renderJson defaults the scan detail for a state that has none', () => {
  const json = renderJson(SMALL)
  assert.deepEqual(json.topRules, [])
  assert.deepEqual(json.topScanGuides, [])
  assert.equal(json.lastScan, null)

  // A 0.5.0 state has scan totals and still no per-rule detail.
  const older = renderJson(WITH_SCAN)
  assert.deepEqual(older.topRules, [])
  assert.deepEqual(older.topScanGuides, [])
  assert.equal(older.lastScan, null)

  // A last scan without a usable timestamp is not invented.
  assert.equal(renderJson({ ...RICH, lastScan: { files: 3, findings: 1 } }).lastScan, null)
})

test('renderJson passes the scan detail through under the snapshot names', () => {
  const json = renderJson(RICH)
  assert.deepEqual(json.topRules, RICH.topRules)
  assert.deepEqual(json.topScanGuides, RICH.topScanGuides)
  // RICH predates the audit fields, so the JSON defaults them instead of omitting them.
  assert.deepEqual(json.lastScan, { ...RICH.lastScan, skipped: {}, truncated: false })
  assert.deepEqual(Object.keys(json.lastScan), ['at', 'files', 'findings', 'rules', 'skipped', 'truncated'])
  assert.equal(json.findings, 3)
})

test('scan counters never leak paths or snippets into the report', () => {
  const leaky = {
    ...RICH,
    lastScan: {
      ...RICH.lastScan,
      path: 'C:/private/app/src/legacy.js',
      snippet: 'el.addEventListener("click", handler)',
    },
  }
  const text = renderReport(leaky)
  assert.doesNotMatch(text, /legacy\.js/)
  assert.doesNotMatch(text, /C:\/private/)
  assert.doesNotMatch(text, /addEventListener/)

  const json = renderJson(leaky)
  assert.deepEqual(Object.keys(json.lastScan), ['at', 'files', 'findings', 'rules', 'skipped', 'truncated'])
  assert.equal('path' in json.lastScan, false)
  assert.equal('snippet' in json.lastScan, false)
})

// --- The last scan's audit tails: skip counts and truncation ---------------------------------

test('the last scan line appends skip counts and a truncation flag', () => {
  const audited = renderReport({
    ...RICH,
    lastScan: { ...RICH.lastScan, skipped: { extension: 277, 'dot-directory': 2 }, truncated: true },
  })

  assert.match(
    audited,
    /^Last scan: 2026-11-10, 12 files, 4 findings \(rules: ls-05, ls-08, ls-13, ls-17, ls-21\); skipped 279 \(277 extension, 2 dot-directory\); truncated$/m,
  )
  // Both tails stay on the same line; the report does not grow a second row.
  assert.equal(audited.split('\n').filter((entry) => entry.startsWith('Last scan:')).length, 1)
})

test('each audit tail appears only when it has something to say', () => {
  const skippedOnly = renderReport({
    ...RICH,
    lastScan: { ...RICH.lastScan, skipped: { 'too-many': 3 }, truncated: false },
  })
  assert.match(skippedOnly, /; skipped 3 \(3 too-many\)$/m)
  assert.doesNotMatch(skippedOnly, /truncated/)

  const truncatedOnly = renderReport({
    ...RICH,
    lastScan: { ...RICH.lastScan, skipped: {}, truncated: true },
  })
  assert.match(truncatedOnly, /\(rules: [^)]*\); truncated$/m)
  assert.doesNotMatch(truncatedOnly, /skipped \d/)

  // The plain 0.7.2 line stays exactly as it was.
  assert.match(renderReport(RICH), /^Last scan: 2026-11-10, 12 files, 4 findings \(rules: .*\)$/m)
})

test('skip reasons keep the scan tokens and are ordered by count then name', () => {
  const text = renderReport({
    ...RICH,
    lastScan: {
      ...RICH.lastScan,
      rules: [],
      skipped: { extension: 5, 'dot-directory': 1, binary: 1 },
    },
  })

  assert.match(text, /^Last scan: 2026-11-10, 12 files, 4 findings; skipped 7 \(5 extension, 1 binary, 1 dot-directory\)$/m)
})

test('renderJson passes the audit fields through, trims them and defaults an old state', () => {
  const audited = renderJson({
    ...RICH,
    lastScan: { ...RICH.lastScan, skipped: { extension: 277, 'dot-directory': 2 }, truncated: true },
  })
  assert.deepEqual(audited.lastScan, {
    at: '2026-11-10T09:42:11.000Z',
    files: 12,
    findings: 4,
    rules: ['ls-05', 'ls-08', 'ls-13', 'ls-17', 'ls-21', 'ls-33'],
    skipped: { extension: 277, 'dot-directory': 2 },
    truncated: true,
  })

  // A snapshot written by 0.7.2 carries the four old keys; the new ones default instead of vanishing.
  const old = renderJson({ ...RICH, lastScan: { at: '2026-11-10T09:42:11.000Z', files: 12, findings: 4, rules: [] } })
  assert.deepEqual(old.lastScan.skipped, {})
  assert.equal(old.lastScan.truncated, false)

  // Malformed values and the fifth reason are dropped, never passed through.
  const junky = renderJson({
    ...RICH,
    lastScan: {
      ...RICH.lastScan,
      skipped: { extension: 5, binary: 2, 'dot-directory': 2, large: 1, unreadable: 1 },
      truncated: 'yes',
    },
  })
  assert.deepEqual(junky.lastScan.skipped, { extension: 5, binary: 2, 'dot-directory': 2, large: 1 })
  assert.equal(junky.lastScan.truncated, false)

  const malformed = renderJson({
    ...RICH,
    lastScan: { ...RICH.lastScan, skipped: { '': 4, binary: 'many' } },
  })
  assert.deepEqual(malformed.lastScan.skipped, {})
})

// --- The described scan rows: the message, confidence and guide behind every id -----------------

test('renderJson describes the scan rows it was given tables for', () => {
  const json = renderJson(RICH, { rules: RULE_TABLE, guides: GUIDE_DESCRIPTIONS })

  // The row is the same id and count, with the rule table's own sentence and confidence attached.
  assert.deepEqual(json.topRules.find((row) => row.ruleId === 'ls-17'), {
    ruleId: 'ls-17',
    count: 1,
    message: 'Build the DOM with createElement/append instead of document.write(), which discards the parsed document.',
    confidence: 'medium',
    guideId: 'html',
  })
  // A rule the slice does not contain is described as unknown, not described as a guess.
  assert.deepEqual(json.topRules.find((row) => row.ruleId === 'ls-13'), {
    ruleId: 'ls-13',
    count: 4,
    message: '',
    confidence: '',
    guideId: null,
  })

  // Every row survives the enrichment, in the snapshot's own order.
  assert.equal(json.topRules.length, RICH.topRules.length)
  assert.deepEqual(json.topRules.map((row) => row.ruleId), RICH.topRules.map((row) => row.ruleId))

  // The guide description comes from the catalog, and an id it does not know reads as empty.
  assert.deepEqual(json.topScanGuides, [
    { guideId: 'dialog', count: 2, description: GUIDE_DESCRIPTIONS.dialog },
    { guideId: 'css-anchor', count: 3, description: '' },
  ])
})

test('the guide table may arrive as the catalog entry array instead of a record', () => {
  const json = renderJson(RICH, {
    rules: RULE_TABLE,
    guides: [{ id: 'dialog', description: GUIDE_DESCRIPTIONS.dialog }],
  })
  assert.deepEqual(json.topScanGuides[0], {
    guideId: 'dialog',
    count: 2,
    description: GUIDE_DESCRIPTIONS.dialog,
  })
})

test('an unknown rule id keeps its row instead of losing a true count', () => {
  const json = renderJson(
    { ...RICH, topRules: [{ ruleId: 'ls-99', count: 121 }] },
    { rules: RULE_TABLE, guides: GUIDE_DESCRIPTIONS },
  )
  assert.deepEqual(json.topRules, [
    { ruleId: 'ls-99', count: 121, message: '', confidence: '', guideId: null },
  ])
})

test('a missing catalog reads as an empty description, never as a missing row', () => {
  const noGuides = renderJson(RICH, { rules: RULE_TABLE })
  assert.deepEqual(noGuides.topScanGuides, [
    { guideId: 'dialog', count: 2, description: '' },
    { guideId: 'css-anchor', count: 3, description: '' },
  ])

  // An empty options object describes nothing and still keeps both lists whole.
  const bare = renderJson(RICH, {})
  assert.equal(bare.topRules.length, RICH.topRules.length)
  assert.deepEqual(bare.topRules[0], {
    ruleId: 'ls-08',
    count: 2,
    message: '',
    confidence: '',
    guideId: null,
  })
})

test('scanCountsScope says the described lists are lifetime totals', () => {
  assert.equal(
    renderJson(RICH, { rules: RULE_TABLE, guides: GUIDE_DESCRIPTIONS }).scanCountsScope,
    'lifetime',
  )
  // The flag describes the lists, not the tables: it is there even when nothing can be looked up.
  assert.equal(renderJson(RICH, {}).scanCountsScope, 'lifetime')
  // A snapshot with no scans at all still carries it: the command's document is a lifetime document.
  assert.equal(renderJson(SMALL, {}).scanCountsScope, 'lifetime')
  // The frozen, no-options document predates the flag and must not grow it.
  assert.equal('scanCountsScope' in renderJson(RICH), false)
})

test('renderJson without options keeps the pre-enrichment document exactly', () => {
  const frozen = renderJson(RICH)
  assert.deepEqual(Object.keys(frozen), [
    'periodDays', 'corpus', 'totals', 'topQueries', 'misses', 'coverage', 'deadGuides', 'series',
    'tools', 'findings', 'topRules', 'topScanGuides', 'lastScan',
  ])
  // The rows are the snapshot's own `{ id, count }` pairs, with no meaning attached.
  assert.deepEqual(frozen.topRules, RICH.topRules)
  assert.deepEqual(frozen.topScanGuides, RICH.topScanGuides)

  // The described document differs only by the enriched rows and the scope flag above them.
  const described = renderJson(RICH, { rules: RULE_TABLE, guides: GUIDE_DESCRIPTIONS })
  assert.deepEqual(Object.keys(described), [
    'periodDays', 'corpus', 'totals', 'topQueries', 'misses', 'coverage', 'deadGuides', 'series',
    'tools', 'findings', 'scanCountsScope', 'topRules', 'topScanGuides', 'lastScan',
  ])
  for (const key of [
    'periodDays', 'corpus', 'totals', 'topQueries', 'misses', 'coverage', 'deadGuides', 'series',
    'tools', 'findings', 'lastScan',
  ]) {
    assert.deepEqual(described[key], frozen[key], `${key} must not change when rows are described`)
  }
})
