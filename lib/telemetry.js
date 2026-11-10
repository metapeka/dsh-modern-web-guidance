/**
 * Local usage counters for the plugin's four tools.
 *
 * The module is deliberately harness-free: it takes an injected store, clock and catalog, so the
 * counting rules can be tested without a filesystem, a profile or a running Harness. Nothing here
 * reaches the network; the state is one plain JSON document the host wiring owns.
 *
 * Counted vocabulary lives in `GLOSSARY.md`: a *call*, its *outcome* (hit, miss, unknown id, list,
 * findings, clean, error), and a *dead guide* (never retrieved). The fourth tool, `legacy-scan`,
 * also reports how many files it read, how many findings it raised, which reasons made the walk skip
 * paths and whether it stopped at a cap; those numbers are additive fields, so a state document
 * written by 0.4.x keeps loading as a document with no scans in it.
 *
 * @module lib/telemetry
 */

/** Shape of the persisted document; bumping it makes older state read as empty. */
const STATE_VERSION = 1

/** Report caps: what one chat message can show before it starts hiding rows. */
const MAX_TOP_QUERIES = 15
const MAX_MISSES = 10
const MAX_DEAD_SAMPLE = 20

/** A stored query is the agent's text, which can be long; the ring keeps a bounded slice. */
const MAX_QUERY_CHARS = 512

/** How many returned ids one ring entry keeps. */
const MAX_IDS = 20

/** How many distinct rule/guide ids one scan entry may name, and how many the report ranks. */
const MAX_SCAN_IDS = 40
const MAX_TOP_SCAN_IDS = 10
/** How many skip reasons one stored scan summary keeps; the panel prints the same four. */
const MAX_SKIP_REASONS = 4

const DAY_MS = 24 * 60 * 60 * 1000

/** Tool names as registered, mapped to the short name the report prints. */
const SHORT_TOOL = {
  web_guidance_search: 'search',
  web_guidance_retrieve: 'retrieve',
  web_guidance_list: 'list',
  web_guidance_legacy_scan: 'legacy-scan',
}

const OUTCOMES = new Set(['hit', 'miss', 'unknown-id', 'list', 'findings', 'clean', 'error'])

/** A finite number, or 0: counters come from JSON, so a corrupt field must read as zero. */
function toCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

/** A finite positive day count, clamped to a sane window. */
function toDays(value) {
  const number = toCount(value)
  return number > 0 ? Math.min(Math.floor(number), 3650) : 7
}

/** Epoch milliseconds as an ISO string; the report renders dates, not numbers. */
function iso(milliseconds) {
  return new Date(toCount(milliseconds)).toISOString()
}

/** The local calendar day of a moment, `YYYY-MM-DD`. */
function dayKey(milliseconds) {
  const date = new Date(milliseconds)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * One day's slice of the aggregates. `files` and `findings` are scan-only, so they stay zero for a
 * day without a scan — and for every bucket in a document written by 0.4.x.
 */
function emptyDay() {
  return { calls: 0, byTool: {}, byOutcome: {}, files: 0, findings: 0 }
}

/** A fresh, empty document. */
function emptyState(now) {
  return {
    version: STATE_VERSION,
    since: now,
    calls: 0,
    byDay: {},
    byTool: {},
    byOutcome: {},
    byCategory: {},
    retrieved: {},
    // Per-rule and per-guide scan debt, plus the last scan summary. All three are additive in 0.6.0:
    // a document they never touched reads them as empty, so 0.5.x state keeps loading unchanged.
    scanRules: {},
    scanGuides: {},
    lastScan: null,
    recent: [],
  }
}

/** `map[key] += by`, ignoring keys that are not strings. */
function bump(map, key, by = 1) {
  if (typeof key !== 'string' || key === '') return
  map[key] = toCount(map[key]) + by
}

/** A plain object of counters, defensively rebuilt from whatever JSON produced. */
function counterMap(value) {
  const map = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return map
  for (const [key, amount] of Object.entries(value)) {
    const count = toCount(amount)
    if (count !== 0) map[key] = count
  }
  return map
}

/** Distinct non-empty string ids from a found list: sorted, deduped, capped for one scan entry. */
function scanIds(value) {
  if (!Array.isArray(value)) return []
  const ids = new Set()
  for (const id of value) if (typeof id === 'string' && id !== '') ids.add(id)
  return [...ids].sort().slice(0, MAX_SCAN_IDS)
}

/**
 * Per-id finding counts for one recorded scan.
 *
 * The exact channel is the counts map `classifyCall` derives from the findings, because one rule can
 * fire several times in a single scan and `scanRules` counts findings, not scans. A hand-written
 * entry that carries only an id list falls back to one finding per id occurrence, which is the most
 * such a caller can honestly claim.
 *
 * @param {unknown} ids
 * @param {unknown} counts
 * @returns {Record<string, number>}
 */
function scanCounts(ids, counts) {
  const result = {}
  if (counts !== null && typeof counts === 'object' && !Array.isArray(counts)) {
    for (const [id, amount] of Object.entries(counts)) {
      const count = Math.floor(toCount(amount))
      if (count > 0) bump(result, id, count)
    }
    return result
  }
  if (Array.isArray(ids)) {
    for (const id of ids) bump(result, id)
  }
  return result
}

/**
 * The top skip reasons of one scan, count desc then name asc, capped for the state document.
 *
 * Reason tokens pass through verbatim: they are the same words `/guidance-scan` and the panel
 * print, so a reader can match a summary against a scan without a translation table.
 *
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function topSkipReasons(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([reason, count]) => [reason, Math.max(0, Math.floor(toCount(count)))])
      .filter(([reason, count]) => reason !== '' && count > 0)
      .sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1]
        if (left[0] === right[0]) return 0
        return left[0] < right[0] ? -1 : 1
      })
      .slice(0, MAX_SKIP_REASONS),
  )
}

/**
 * A stored scan summary, defensively rebuilt. The date is an ISO string; a hand-edited document may
 * carry epoch milliseconds instead, which is accepted and re-serialised. Anything unusable — a
 * non-object, an unparsable date — reads as "no scan yet" rather than as a corrupt row.
 *
 * @param {unknown} value
 * @returns {{ at: string, files: number, findings: number, rules: string[], skipped: Record<string, number>, truncated: boolean } | null}
 */
function normalizeLastScan(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const at = typeof value.at === 'string' ? Date.parse(value.at) : Number(value.at)
  if (!Number.isFinite(at)) return null
  return {
    at: iso(at),
    files: Math.max(0, Math.floor(toCount(value.files))),
    findings: Math.max(0, Math.floor(toCount(value.findings))),
    rules: scanIds(value.rules),
    skipped: topSkipReasons(value.skipped),
    truncated: value.truncated === true,
  }
}

/** Top entries of one lifetime counter map: count desc, id asc, capped for the report. */
function topScanCounters(map, key) {
  return Object.entries(map)
    .map(([id, count]) => ({ [key]: id, count: toCount(count) }))
    .filter((row) => row.count > 0 && row[key] !== '')
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      if (left[key] === right[key]) return 0
      return left[key] < right[key] ? -1 : 1
    })
    .slice(0, MAX_TOP_SCAN_IDS)
}

/**
 * Coerce a loaded document into a usable state. Anything unrecognised — missing, a different
 * version, a truncated write — reads as an empty state, because a corrupt counter must never break
 * a tool call.
 *
 * @param {unknown} loaded
 * @param {number} now
 * @returns {object}
 */
function normalizeState(loaded, now) {
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) return emptyState(now)
  if (loaded.version !== STATE_VERSION) return emptyState(now)

  const state = emptyState(now)
  state.since = toCount(loaded.since) || now
  state.calls = toCount(loaded.calls)
  state.byTool = counterMap(loaded.byTool)
  state.byOutcome = counterMap(loaded.byOutcome)
  state.byCategory = counterMap(loaded.byCategory)
  state.retrieved = counterMap(loaded.retrieved)
  // Additive 0.6.0 fields: a 0.5.x document has none of them and keeps loading as an empty aggregate.
  state.scanRules = counterMap(loaded.scanRules)
  state.scanGuides = counterMap(loaded.scanGuides)
  state.lastScan = normalizeLastScan(loaded.lastScan)

  if (loaded.byDay !== null && typeof loaded.byDay === 'object' && !Array.isArray(loaded.byDay)) {
    for (const [day, bucket] of Object.entries(loaded.byDay)) {
      if (bucket === null || typeof bucket !== 'object') continue
      state.byDay[day] = {
        calls: toCount(bucket.calls),
        byTool: counterMap(bucket.byTool),
        byOutcome: counterMap(bucket.byOutcome),
        files: toCount(bucket.files),
        findings: toCount(bucket.findings),
      }
    }
  }

  if (Array.isArray(loaded.recent)) {
    for (const entry of loaded.recent) {
      if (entry === null || typeof entry !== 'object') continue
      const tool = typeof entry.tool === 'string' ? entry.tool : ''
      if (tool === '') continue
      const call = { at: toCount(entry.at), tool, outcome: OUTCOMES.has(entry.outcome) ? entry.outcome : 'error' }
      if (typeof entry.query === 'string') call.query = entry.query
      if (Array.isArray(entry.ids)) call.ids = entry.ids.filter((id) => typeof id === 'string').slice(0, MAX_IDS)
      // 0.5.0 entries carry the scan volume; 0.4.x entries simply do not, and are read back as they
      // were written.
      if (Number.isFinite(entry.files) || Number.isFinite(entry.findings)) {
        call.files = toCount(entry.files)
        call.findings = toCount(entry.findings)
      }
      if (entry.isError === true) call.isError = true
      state.recent.push(call)
    }
  }

  return state
}

/**
 * Classify one finished tool call.
 *
 * `hit` means the call returned guide content (a search with results, a retrieve that resolved at
 * least one id); `miss` is a search that matched nothing; `unknown-id` is a retrieve whose ids the
 * corpus does not contain; `list` is a catalog browse; `findings` is a legacy scan that raised at
 * least one marker; `clean` is a legacy scan that raised none; `error` is any failed call.
 *
 * A legacy scan reports its refusals as values rather than thrown errors — an absolute path or an
 * escape is an answer, not a crash — so both `isError` and a value carrying `error` count as a
 * failed call. A failed scan is still a call: the counters count attempts, and the report says so.
 *
 * @param {{ tool: string, args?: unknown, value?: unknown, isError?: boolean }} call
 * @returns {{ outcome: string, query?: string, ids?: string[], category?: string, count?: number, files?: number, findings?: number, rules?: string[], guides?: string[], ruleCounts?: Record<string, number>, guideCounts?: Record<string, number>, skipped?: Record<string, number>, truncated?: boolean, isError?: boolean }}
 */
export function classifyCall({ tool, args, value, isError }) {
  const toolName = typeof tool === 'string' ? tool : ''
  const short = SHORT_TOOL[toolName]

  if (short === 'legacy-scan') {
    const payload = value !== null && typeof value === 'object' ? value : {}
    if (isError === true || typeof payload.error === 'string') {
      return {
        outcome: 'error',
        isError: true,
        files: 0,
        findings: 0,
        rules: [],
        guides: [],
        ruleCounts: {},
        guideCounts: {},
        skipped: {},
        truncated: false,
      }
    }
    const scanned = payload.scanned !== null && typeof payload.scanned === 'object' ? payload.scanned : {}
    const findings = Array.isArray(payload.findings)
      ? payload.findings.filter((finding) => finding !== null && typeof finding === 'object')
      : []
    const ruleCounts = {}
    const guideCounts = {}
    for (const finding of findings) {
      if (typeof finding.ruleId === 'string' && finding.ruleId !== '') bump(ruleCounts, finding.ruleId)
      if (typeof finding.guideId === 'string' && finding.guideId !== '') bump(guideCounts, finding.guideId)
    }
    return {
      outcome: findings.length > 0 ? 'findings' : 'clean',
      files: toCount(scanned.files),
      findings: findings.length,
      // `rules`/`guides` are the present ids a panel can list; the counts say how many findings each
      // id accounted for, since one rule can fire several times inside one scan.
      rules: Object.keys(ruleCounts).sort().slice(0, MAX_SCAN_IDS),
      guides: Object.keys(guideCounts).sort().slice(0, MAX_SCAN_IDS),
      ruleCounts,
      guideCounts,
      // The audit trail: how many paths the walk refused and why, and whether it hit a cap. The scan
      // result carries both top-level `truncated` (any cap, findings included) and `scanned.truncated`.
      skipped: topSkipReasons(scanned.skippedByReason),
      truncated: payload.truncated === true || scanned.truncated === true,
    }
  }

  if (isError === true || short === undefined) return { outcome: 'error' }

  const input = args !== null && typeof args === 'object' ? args : {}
  const payload = value !== null && typeof value === 'object' ? value : {}

  if (short === 'search') {
    const results = Array.isArray(payload.results) ? payload.results.filter((hit) => hit !== null && typeof hit === 'object') : []
    const query = typeof input.query === 'string' ? input.query : ''
    if (results.length === 0) return { outcome: 'miss', query, count: 0 }
    const ids = results.map((hit) => String(hit.id ?? '')).filter((id) => id !== '')
    const category = typeof results[0].category === 'string' ? results[0].category : undefined
    const classified = { outcome: 'hit', query, ids, count: results.length }
    if (category !== undefined) classified.category = category
    return classified
  }

  if (short === 'retrieve') {
    const guides = Array.isArray(payload.guides) ? payload.guides.filter((guide) => guide !== null && typeof guide === 'object') : []
    const unknown = Array.isArray(payload.unknown) ? payload.unknown.filter((id) => typeof id === 'string') : []
    const retrievedIds = guides.map((guide) => String(guide.id ?? '')).filter((id) => id !== '')
    if (retrievedIds.length > 0) return { outcome: 'hit', ids: retrievedIds, count: retrievedIds.length }
    if (unknown.length > 0) return { outcome: 'unknown-id', ids: unknown.slice(0, MAX_IDS), count: unknown.length }
    return { outcome: 'unknown-id', ids: [], count: toCount(payload.unknownCount) }
  }

  const listed = Array.isArray(payload.guides) ? payload.guides.length : 0
  return { outcome: 'list', count: toCount(payload.total) || listed }
}

/**
 * Create the counters.
 *
 * @param {{
 *   store: { load: () => Promise<unknown>, save: (state: unknown) => Promise<void> },
 *   clock?: () => number,
 *   retentionDays?: number,
 *   ringLimit?: number,
 *   catalog?: { total?: number, byCategory?: Record<string, number>, ids?: string[], categoryOf?: Record<string, string>, version?: string, snapshotDate?: string },
 * }} options
 * @returns {{
 *   record: (entry: object) => Promise<void>,
 *   snapshot: (options?: { days?: number }) => Promise<object>,
 *   reset: () => Promise<void>,
 *   flush: () => Promise<void>,
 * }}
 */
export function createTelemetry({ store, clock = () => Date.now(), retentionDays = 90, ringLimit = 1000, catalog = {} } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('createTelemetry requires a store with load() and save()')
  }

  const retention = toDays(retentionDays) === 7 ? (toCount(retentionDays) > 0 ? toDays(retentionDays) : 90) : toDays(retentionDays)
  const ring = toCount(ringLimit) > 0 ? Math.floor(toCount(ringLimit)) : 1000
  const corpus = {
    version: typeof catalog.version === 'string' && catalog.version !== '' ? catalog.version : 'unknown',
    snapshotDate: typeof catalog.snapshotDate === 'string' && catalog.snapshotDate !== '' ? catalog.snapshotDate : 'unknown',
    total: toCount(catalog.total) || (Array.isArray(catalog.ids) ? catalog.ids.length : 0),
  }
  const ids = Array.isArray(catalog.ids) ? catalog.ids.filter((id) => typeof id === 'string') : []
  const categoryOf = catalog.categoryOf !== null && typeof catalog.categoryOf === 'object' ? catalog.categoryOf : {}
  const byCategoryTotal = counterMap(catalog.byCategory)

  let state
  let loading

  /** Load the document once, lazily: the host may call record() before any await. */
  async function ensure() {
    if (state !== undefined) return state
    loading ??= store
      .load()
      .then((loaded) => {
        state = normalizeState(loaded, clock())
        return state
      })
      .catch(() => {
        state = emptyState(clock())
        return state
      })
    return loading
  }

  /** Forget day buckets and ring entries older than the retention window. */
  function prune(current, now) {
    const cutoff = now - retention * DAY_MS
    const oldestDay = dayKey(cutoff)
    for (const day of Object.keys(current.byDay)) {
      if (day < oldestDay) delete current.byDay[day]
    }
    if (current.recent.length > 0) {
      current.recent = current.recent.filter((entry) => toCount(entry.at) >= cutoff)
    }
    // The scan summary is a timestamped pointer, not a counter: once it is older than the window it
    // would only tell the panel about a scan nobody can place in time. The rule/guide aggregates stay.
    if (current.lastScan !== null && Date.parse(current.lastScan.at) < cutoff) current.lastScan = null
  }

  /**
   * Record one finished call.
   * @param {{ at?: number, tool: string, outcome: string, query?: string, ids?: string[], category?: string, count?: number, files?: number, findings?: number, rules?: string[], guides?: string[], ruleCounts?: Record<string, number>, guideCounts?: Record<string, number>, skipped?: Record<string, number>, truncated?: boolean, isError?: boolean }} entry
   * @returns {Promise<void>}
   */
  async function record(entry) {
    if (entry === null || typeof entry !== 'object') return
    const tool = SHORT_TOOL[entry.tool] ?? (typeof entry.tool === 'string' ? entry.tool : '')
    if (tool === '') return
    const outcome = OUTCOMES.has(entry.outcome) ? entry.outcome : 'error'
    const at = toCount(entry.at) || clock()
    const files = tool === 'legacy-scan' ? Math.max(0, Math.floor(toCount(entry.files))) : 0
    const findings = tool === 'legacy-scan' ? Math.max(0, Math.floor(toCount(entry.findings))) : 0

    const current = await ensure()
    current.calls += 1
    bump(current.byTool, tool)
    bump(current.byOutcome, outcome)

    const day = dayKey(at)
    const bucket = current.byDay[day] ?? (current.byDay[day] = emptyDay())
    bucket.calls += 1
    bump(bucket.byTool, tool)
    bump(bucket.byOutcome, outcome)
    bucket.files += files
    bucket.findings += findings

    if (outcome === 'hit' && typeof entry.category === 'string') bump(current.byCategory, entry.category)

    // Only a retrieve marks guides as used: a guide that merely appeared in search results has not
    // been read, and counting it would make dead-guide reporting meaningless.
    if (tool === 'retrieve' && outcome === 'hit' && Array.isArray(entry.ids)) {
      for (const id of entry.ids) bump(current.retrieved, id)
    }

    // Per-rule and per-guide debt: lifetime finding counts, never pruned. A rule that fired three
    // times in this scan adds three, while `lastScan.rules` names it once — presence and volume are
    // different questions, and the panel asks both.
    if (tool === 'legacy-scan') {
      for (const [id, amount] of Object.entries(scanCounts(entry.rules, entry.ruleCounts))) {
        bump(current.scanRules, id, amount)
      }
      for (const [id, amount] of Object.entries(scanCounts(entry.guides, entry.guideCounts))) {
        bump(current.scanGuides, id, amount)
      }
      // Only a completed scan becomes the last scan: a refusal (absolute path, escape) is an error
      // call, and letting it overwrite the summary would show a fresh "0 files, 0 findings" scan
      // that reads as a clean project. The call itself is still counted, ring entry and all.
      if (outcome === 'findings' || outcome === 'clean') {
        current.lastScan = {
          at: iso(at),
          files,
          findings,
          rules: scanIds(entry.rules),
          skipped: topSkipReasons(entry.skipped),
          truncated: entry.truncated === true,
        }
      }
    }

    const call = { at, tool, outcome }
    if (typeof entry.query === 'string' && entry.query !== '') call.query = entry.query.slice(0, MAX_QUERY_CHARS)
    if (Array.isArray(entry.ids) && entry.ids.length > 0) call.ids = entry.ids.slice(0, MAX_IDS)
    if (tool === 'legacy-scan') {
      call.files = files
      call.findings = findings
    }
    if (entry.isError === true) call.isError = true
    current.recent.push(call)
    if (current.recent.length > ring) current.recent = current.recent.slice(-ring)

    prune(current, at)
  }

  /**
   * Aggregate the last `days` days into the report snapshot.
   * @param {{ days?: number }} [options]
   * @returns {Promise<object>}
   */
  async function snapshot({ days = 7 } = {}) {
    const current = await ensure()
    const now = clock()
    prune(current, now)
    const period = toDays(days)

    const days7 = []
    for (let index = period - 1; index >= 0; index -= 1) days7.push(dayKey(now - index * DAY_MS))

    const byTool = {}
    const byOutcome = {}
    const series = []
    let calls = 0
    let files = 0
    let findings = 0
    for (const day of days7) {
      const bucket = current.byDay[day]
      const amount = bucket === undefined ? 0 : toCount(bucket.calls)
      calls += amount
      series.push({ day, calls: amount })
      if (bucket === undefined) continue
      for (const [name, count] of Object.entries(bucket.byTool)) bump(byTool, name, toCount(count))
      for (const [name, count] of Object.entries(bucket.byOutcome)) bump(byOutcome, name, toCount(count))
      files += toCount(bucket.files)
      findings += toCount(bucket.findings)
    }

    const cutoff = now - period * DAY_MS
    const rows = new Map()
    for (const call of current.recent) {
      if (toCount(call.at) < cutoff) continue
      const query = typeof call.query === 'string' ? call.query.trim() : ''
      if (query === '') continue
      const row = rows.get(query) ?? { query, calls: 0, hits: 0, misses: 0, lastAt: 0 }
      row.calls += 1
      if (call.outcome === 'hit') row.hits += 1
      if (call.outcome === 'miss') row.misses += 1
      row.lastAt = Math.max(row.lastAt, toCount(call.at))
      rows.set(query, row)
    }

    const ranked = [...rows.values()].sort((left, right) => {
      if (right.calls !== left.calls) return right.calls - left.calls
      return left.query < right.query ? -1 : left.query > right.query ? 1 : 0
    })

    const topQueries = ranked.slice(0, MAX_TOP_QUERIES).map((row) => ({
      query: row.query,
      calls: row.calls,
      hits: row.hits,
      misses: row.misses,
      lastAt: iso(row.lastAt),
    }))

    const misses = ranked
      .filter((row) => row.misses > 0)
      .sort((left, right) => {
        if (right.misses !== left.misses) return right.misses - left.misses
        if (right.calls !== left.calls) return right.calls - left.calls
        return left.query < right.query ? -1 : 1
      })
      .slice(0, MAX_MISSES)
      .map((row) => ({ query: row.query, calls: row.misses, lastAt: iso(row.lastAt) }))

    const categories = Object.keys(byCategoryTotal)
    const coverage = categories
      .map((category) => ({
        category,
        retrieved: ids.filter((id) => categoryOf[id] === category && toCount(current.retrieved[id]) > 0).length,
        total: toCount(byCategoryTotal[category]),
      }))
      .sort((left, right) => {
        if (right.retrieved !== left.retrieved) return right.retrieved - left.retrieved
        return left.category.localeCompare(right.category)
      })

    const dead = ids.filter((id) => toCount(current.retrieved[id]) === 0).sort()

    return {
      periodDays: period,
      generatedAt: iso(now),
      corpus,
      totals: {
        calls,
        hitRate: calls === 0 ? 0 : toCount(byOutcome.hit) / calls,
        byTool,
        byOutcome,
        // Scan-only aggregates, additive in 0.5.0: absent from a 0.4.x document, where they read
        // as zero because no scan was ever counted.
        files,
        findings,
      },
      topQueries,
      misses,
      coverage,
      deadGuides: { total: dead.length, sample: dead.slice(0, MAX_DEAD_SAMPLE) },
      // The scan debt map: which rules and guides the findings belong to, plus the latest scan
      // summary. Ids and numbers only — never a path, a snippet or a file name.
      topRules: topScanCounters(current.scanRules, 'ruleId'),
      topScanGuides: topScanCounters(current.scanGuides, 'guideId'),
      lastScan: current.lastScan === null ? null : { ...current.lastScan, rules: [...current.lastScan.rules] },
      series,
    }
  }

  /** Erase every counter, keeping the document's version. */
  async function reset() {
    state = emptyState(clock())
    loading = Promise.resolve(state)
    await flush()
  }

  /** Persist the current document; a failed write is the caller's to ignore. */
  async function flush() {
    const current = await ensure()
    prune(current, clock())
    await store.save(current)
  }

  return { record, snapshot, reset, flush }
}
