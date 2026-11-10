/**
 * Text rendering for the plugin's `/guidance-stats` command.
 *
 * `lib/telemetry.js` owns the counters; this module only turns one finished snapshot into the
 * text a human reads. It is deliberately pure — no profile storage, no clock, no network, no
 * dependencies — so the report is reproducible from its input and cheap to test.
 *
 * @module lib/report
 */

/** How many miss queries the chat report shows before saying how many it hid. */
const MAX_MISSES = 10

/** How many top queries the chat report shows before saying how many it hid. */
const MAX_TOP_QUERIES = 15

/** How many dead guide ids the chat report lists before saying how many it hid. */
const MAX_DEAD_GUIDE_SAMPLE = 20

/** Longest query text kept on one report line; a stored query can be much longer. */
const MAX_QUERY_DISPLAY = 120

/** How many rule ids the scan-detail lines name; the JSON keeps every row it was given. */
const MAX_SCAN_RULES_SHOWN = 5

/**
 * A finite number, or 0. Counts come from durable JSON, so a missing or corrupt field must read
 * as zero rather than put `NaN` in the report.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * A count as report text. Plain digits, never thousands separators: the report is read on narrow
 * chat surfaces, where grouping adds noise and breaks easy copying.
 *
 * @param {unknown} value
 * @returns {string}
 */
function digits(value) {
  return String(toCount(value))
}

/**
 * `3 calls` or `1 call`. Grammar is part of the product; mixing both reads like a bug.
 *
 * @param {unknown} count
 * @param {string} singular
 * @param {string} [pluralForm]
 * @returns {string}
 */
function plural(count, singular, pluralForm = `${singular}s`) {
  const number = toCount(count)
  return `${number} ${number === 1 ? singular : pluralForm}`
}

/**
 * A 0..1 ratio as a whole percentage, the only numeric format the report allows for rates.
 *
 * @param {unknown} ratio
 * @returns {string}
 */
function percent(ratio) {
  return `${Math.round(toCount(ratio) * 100)}%`
}

/**
 * The date part of an ISO timestamp, or the raw value when it is not a date.
 *
 * @param {unknown} value
 * @returns {string}
 */
function when(value) {
  if (typeof value !== 'string' || value === '') return 'unknown'
  const day = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : value
}

/**
 * One query on one line: whitespace folded, length capped. The ring buffer stores raw agent
 * queries, which may contain newlines and run to hundreds of characters.
 *
 * @param {unknown} value
 * @returns {string}
 */
function queryText(value) {
  const query = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (query === '') return '(empty query)'
  return query.length <= MAX_QUERY_DISPLAY ? query : `${query.slice(0, MAX_QUERY_DISPLAY - 3)}...`
}

/**
 * Splits rows into what the report shows and how many it hides, so truncation is stated
 * ("and 47 more") instead of silently dropping rows.
 *
 * @param {unknown} rows
 * @param {number} limit
 * @returns {{ shown: Array, hidden: number }}
 */
function truncate(rows, limit) {
  const list = Array.isArray(rows) ? rows : []
  return { shown: list.slice(0, limit), hidden: Math.max(list.length - limit, 0) }
}

/** Highest count first, ties broken by name. */
function byRank(left, right) {
  if (right[1] !== left[1]) return right[1] - left[1]
  if (left[0] === right[0]) return 0
  return left[0] < right[0] ? -1 : 1
}

/**
 * Entries of a counter object, highest first, ties broken by name so two runs over the same
 * snapshot always print the same lines.
 *
 * @param {unknown} counters
 * @returns {Array<[string, number]>}
 */
function rankedEntries(counters) {
  if (counters === null || typeof counters !== 'object') return []
  return Object.entries(counters)
    .map(([name, amount]) => [name, toCount(amount)])
    .sort(byRank)
}

/**
 * One titled block: a `title:` line, numbered rows, and the truncation note when rows were cut.
 *
 * @param {string} title
 * @param {string[]} rows
 * @param {number} hidden
 * @param {string} emptyText
 * @returns {string[]}
 */
function renderBlock(title, rows, hidden, emptyText) {
  if (rows.length === 0) return [`${title}: ${emptyText}`]
  const lines = [`${title}:`]
  rows.forEach((row, index) => lines.push(`  ${index + 1}. ${row}`))
  if (hidden > 0) lines.push(`  and ${hidden} more`)
  return lines
}

/**
 * Joins blocks with blank lines, skipping blocks that rendered nothing.
 *
 * @param {string[][]} blocks
 * @returns {string}
 */
function joinBlocks(blocks) {
  const lines = []
  for (const block of blocks) {
    if (block.length === 0) continue
    if (lines.length > 0) lines.push('')
    lines.push(...block)
  }
  return lines.join('\n')
}

/**
 * The corpus line: which snapshot the numbers were counted against.
 *
 * @param {object} corpus
 * @returns {string}
 */
function corpusLine(corpus) {
  const version = typeof corpus.version === 'string' && corpus.version !== '' ? corpus.version : 'unknown'
  const snapshotDate = typeof corpus.snapshotDate === 'string' && corpus.snapshotDate !== ''
    ? when(corpus.snapshotDate)
    : 'unknown'
  const total = Number.isFinite(corpus.total) ? plural(corpus.total, 'guide') : 'unknown guides'
  return `Corpus: version ${version}, snapshot ${snapshotDate}, ${total}`
}

/**
 * The period line, with the generation time when the snapshot carries one.
 *
 * @param {number} periodDays
 * @param {unknown} generatedAt
 * @returns {string}
 */
function periodLine(periodDays, generatedAt) {
  const line = `Period: last ${digits(periodDays)} days`
  return typeof generatedAt === 'string' && generatedAt !== '' ? `${line} (generated ${generatedAt})` : line
}

/**
 * The hit rate of the snapshot, read from `totals.hitRate` and only derived from the outcome
 * counters when that field is missing or corrupt.
 *
 * @param {object} totals
 * @returns {number}
 */
function hitRate(totals) {
  if (Number.isFinite(totals.hitRate)) return totals.hitRate
  const calls = toCount(totals.calls)
  if (calls === 0) return 0
  return toCount((totals.byOutcome ?? {}).hit) / calls
}

/**
 * The fourth tool's counters. A snapshot built from a 0.4.x state file has no scan data at all, so
 * every member reads as zero and the report simply says nothing about scans — the 0.4.x text is
 * reproduced byte for byte rather than gaining a zero-filled row.
 *
 * @param {object} snapshot
 * @returns {{ calls: number, files: number, findings: number }}
 */
function scanTotals(snapshot) {
  const totals = snapshot.totals ?? {}
  const byTool = totals.byTool ?? {}
  return {
    calls: toCount(byTool['legacy-scan']),
    files: toCount(totals.files),
    findings: toCount(totals.findings),
  }
}

/**
 * The `{ ruleId, count }` / `{ guideId, count }` rows of a snapshot, with junk dropped: the report
 * only ever shows a name and a number, never a path or a snippet. Names pass through verbatim;
 * counts come from durable JSON, so a missing or corrupt one reads as zero.
 *
 * @param {unknown} rows
 * @param {'ruleId' | 'guideId'} key
 * @returns {Array<Record<string, string | number>>}
 */
function scanRows(rows, key) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = row[key]
    if (typeof id !== 'string' || id === '') continue
    out.push({ [key]: id, count: toCount(row.count) })
  }
  return out
}

/**
 * Scan rows aggregated into ranked `[id, count]` pairs: highest count first, ties by id, so two
 * runs over the same snapshot always print the same line. A repeated id is summed rather than
 * shown twice.
 *
 * @param {unknown} rows
 * @param {'ruleId' | 'guideId'} key
 * @returns {Array<[string, number]>}
 */
function rankedScanIds(rows, key) {
  const counts = new Map()
  for (const row of scanRows(rows, key)) {
    const id = row[key]
    counts.set(id, (counts.get(id) ?? 0) + row.count)
  }
  return [...counts.entries()].sort(byRank)
}

/**
 * The stored last scan, or null. Only the four documented members survive: an ISO timestamp, two
 * counts and the distinct rule ids. A value without a usable timestamp reads as null — the text
 * report then says nothing rather than "Last scan: unknown".
 *
 * @param {unknown} value
 * @returns {{ at: string, files: number, findings: number, rules: string[] } | null}
 */
function normalizeLastScan(value) {
  if (value === null || typeof value !== 'object') return null
  const at = typeof value.at === 'string' ? value.at.trim() : ''
  if (at === '') return null
  const rules = Array.isArray(value.rules)
    ? [...new Set(value.rules.filter((id) => typeof id === 'string' && id !== ''))]
    : []
  return { at, files: toCount(value.files), findings: toCount(value.findings), rules }
}

/**
 * Renders the chat report for one telemetry snapshot.
 *
 * Section order is fixed: KPIs, then the queries that returned nothing (the actionable part),
 * then top queries, category coverage, dead guides, and finally the corpus and period lines that
 * say what was measured. A snapshot with no calls renders the empty state instead of empty
 * tables, because a wall of zeroes hides the actual instruction: search something first. When the
 * snapshot counted legacy scans, one more KPI line reports the fourth tool's calls, files read and
 * findings raised; and when that scan data also carries per-rule counters, two more KPI lines name
 * the most matched rules and the last scan. Both are counters, not evidence: ids and numbers only,
 * never a path, a snippet or a per-file row. A snapshot without them reproduces the 0.4.x report
 * unchanged, and `lastScan: null` with scans recorded simply omits the second line.
 *
 * @param {object} snapshot Aggregated usage snapshot from `lib/telemetry.js`.
 * @returns {string} Plain text, markdown-friendly, no colours and no emoji.
 */
export function renderReport(snapshot) {
  const source = snapshot ?? {}
  const corpus = source.corpus ?? {}
  const totals = source.totals ?? {}
  const periodDays = toCount(source.periodDays)
  const calls = toCount(totals.calls)
  const footer = [corpusLine(corpus), periodLine(periodDays, source.generatedAt)]

  if (calls === 0) {
    return joinBlocks([
      [`No calls recorded in the last ${digits(periodDays)} days. Search a guide first, then run /guidance-stats again.`],
      footer,
    ])
  }

  const tools = rankedEntries(totals.byTool)
  const outcomes = rankedEntries(totals.byOutcome)
  const kpi = [`Guidance usage: ${plural(calls, 'call')}, ${percent(hitRate(totals))} hit rate`]
  if (tools.length > 0) {
    kpi.push(`Calls by tool: ${tools.map(([name, amount]) => `${name} ${digits(amount)}`).join(', ')}`)
  }
  if (outcomes.length > 0) {
    kpi.push(`Calls by outcome: ${outcomes.map(([name, amount]) => `${name} ${digits(amount)}`).join(', ')}`)
  }
  // The scan row is additive: 0.4.x state files have no scan counters, so the line simply does not
  // appear and the rest of the report is unchanged.
  const scan = scanTotals(source)
  if (scan.calls > 0) {
    kpi.push(
      `Legacy scans: ${plural(scan.calls, 'call')}, ${plural(scan.files, 'file')} scanned, ` +
      `${plural(scan.findings, 'finding')}`,
    )
    // The detail lines are a counter, not evidence: rule and guide ids with counts, never a path,
    // a snippet or a per-file row. A 0.5.0 state file has scan totals but neither detail, so both
    // lines stay silent there and such a snapshot still renders exactly as it did.
    const rules = rankedScanIds(source.topRules, 'ruleId')
    if (rules.length > 0) {
      const pairs = rules.slice(0, MAX_SCAN_RULES_SHOWN).map(([id, count]) => `${id} ${digits(count)}`)
      kpi.push(`Most matched rules: ${pairs.join(', ')}`)
    }
    const lastScan = normalizeLastScan(source.lastScan)
    if (lastScan !== null) {
      const dated = `Last scan: ${when(lastScan.at)}, ${plural(lastScan.files, 'file')}, ` +
        `${plural(lastScan.findings, 'finding')}`
      const lastRules = lastScan.rules.slice(0, MAX_SCAN_RULES_SHOWN)
      kpi.push(lastRules.length > 0 ? `${dated} (rules: ${lastRules.join(', ')})` : dated)
    }
  }

  const misses = truncate(source.misses, MAX_MISSES)
  const queries = truncate(source.topQueries, MAX_TOP_QUERIES)
  const coverage = (Array.isArray(source.coverage) ? source.coverage : [])
    .filter((row) => row !== null && typeof row === 'object' && typeof row.category === 'string')
    .map((row) => `${row.category}: ${digits(row.retrieved)} of ${digits(row.total)} retrieved`)
  const dead = source.deadGuides ?? {}
  const deadTotal = toCount(dead.total)
  const deadSample = truncate(dead.sample, MAX_DEAD_GUIDE_SAMPLE)

  const deadBlock = []
  if (deadTotal === 0 && deadSample.shown.length === 0) {
    deadBlock.push('Dead guides: none; every guide in the corpus has been retrieved at least once.')
  } else {
    const corpusTotal = toCount(corpus.total)
    deadBlock.push(corpusTotal > 0
      ? `Dead guides: ${digits(deadTotal)} of ${digits(corpusTotal)} guides have never been retrieved.`
      : `Dead guides: ${plural(deadTotal, 'guide')} never retrieved.`)
    if (deadSample.shown.length > 0) {
      deadBlock.push(...deadSample.shown.map((id) => `  ${String(id)}`))
      const hiddenDead = Math.max(deadTotal - deadSample.shown.length, 0)
      if (hiddenDead > 0) deadBlock.push(`  and ${hiddenDead} more`)
    }
  }

  return joinBlocks([
    kpi,
    renderBlock(
      'Queries that returned nothing',
      misses.shown.map((row) => `${queryText(row?.query)} - ${plural(row?.calls, 'call')}, last ${when(row?.lastAt)}`),
      misses.hidden,
      'none this period.',
    ),
    renderBlock(
      'Top queries',
      queries.shown.map((row) =>
        `${queryText(row?.query)} - ${plural(row?.calls, 'call')}, ${plural(row?.hits, 'hit')}, ` +
        `${plural(row?.misses, 'miss', 'misses')}, last ${when(row?.lastAt)}`),
      queries.hidden,
      'none this period.',
    ),
    renderBlock('Category coverage', coverage, 0, 'none in this snapshot.'),
    deadBlock,
    footer,
  ])
}

/**
 * The value `/guidance-stats --json` prints.
 *
 * Every field is passed through exactly as it arrived — same numbers, same shape, same array
 * references — so a script piping the output can depend on the snapshot contract. `generatedAt`
 * is deliberately absent: it belongs to the text report's footer, not to the data.
 *
 * The fourth tool is additive. Once a legacy scan has been counted, the report also carries
 * `tools['legacy-scan']` (its call count as `total`, plus the files it read and the findings it
 * raised) and the `findings` total; a report built from a 0.4.x state file carries neither, which
 * is exactly what the panel's reader treats as zero.
 *
 * The scan detail is passed through normalized and defaulted: `topRules` and `topScanGuides` are
 * arrays of `{ ruleId | guideId, count }` rows (empty when the state has none) and `lastScan` is
 * either `{ at, files, findings, rules }` or null. The names are the snapshot's own and are not
 * renamed here; the panel parses this object, so they are part of the contract.
 *
 * @param {object} snapshot Aggregated usage snapshot from `lib/telemetry.js`.
 * @returns {{
 *   periodDays: number,
 *   corpus: { version: string, snapshotDate: string, total: number },
 *   totals: { calls: number, hitRate: number, byTool: object, byOutcome: object, files: number, findings: number },
 *   topQueries: Array<object>,
 *   misses: Array<object>,
 *   coverage: Array<object>,
 *   deadGuides: { total: number, sample: string[] },
 *   series: Array<object>,
 *   topRules: Array<{ ruleId: string, count: number }>,
 *   topScanGuides: Array<{ guideId: string, count: number }>,
 *   lastScan: { at: string, files: number, findings: number, rules: string[] } | null,
 *   tools?: { 'legacy-scan': { total: number, files: number, findings: number } },
 *   findings?: number,
 * }}
 */
export function renderJson(snapshot) {
  const source = snapshot ?? {}
  const json = {
    periodDays: source.periodDays,
    corpus: source.corpus,
    totals: source.totals,
    topQueries: source.topQueries,
    misses: source.misses,
    coverage: source.coverage,
    deadGuides: source.deadGuides,
    series: source.series,
  }
  const scan = scanTotals(source)
  if (scan.calls > 0) {
    json.tools = { 'legacy-scan': { total: scan.calls, files: scan.files, findings: scan.findings } }
    json.findings = scan.findings
  }
  // The scan detail is always present, defaulted for a state that has none: a consumer can read
  // `.length` and `.at` without a guard, and a 0.4.x/0.5.0 state simply reads as "no scans yet".
  json.topRules = scanRows(source.topRules, 'ruleId')
  json.topScanGuides = scanRows(source.topScanGuides, 'guideId')
  json.lastScan = normalizeLastScan(source.lastScan)
  return json
}
