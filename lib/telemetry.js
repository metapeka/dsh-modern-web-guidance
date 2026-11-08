/**
 * Local usage counters for the plugin's three tools.
 *
 * The module is deliberately harness-free: it takes an injected store, clock and catalog, so the
 * counting rules can be tested without a filesystem, a profile or a running Harness. Nothing here
 * reaches the network; the state is one plain JSON document the host wiring owns.
 *
 * Counted vocabulary lives in `GLOSSARY.md`: a *call*, its *outcome* (hit, miss, unknown id, list,
 * error), and a *dead guide* (never retrieved).
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

const DAY_MS = 24 * 60 * 60 * 1000

/** Tool names as registered, mapped to the short name the report prints. */
const SHORT_TOOL = {
  web_guidance_search: 'search',
  web_guidance_retrieve: 'retrieve',
  web_guidance_list: 'list',
}

const OUTCOMES = new Set(['hit', 'miss', 'unknown-id', 'list', 'error'])

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

/** One day's slice of the aggregates. */
function emptyDay() {
  return { calls: 0, byTool: {}, byOutcome: {} }
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

  if (loaded.byDay !== null && typeof loaded.byDay === 'object' && !Array.isArray(loaded.byDay)) {
    for (const [day, bucket] of Object.entries(loaded.byDay)) {
      if (bucket === null || typeof bucket !== 'object') continue
      state.byDay[day] = {
        calls: toCount(bucket.calls),
        byTool: counterMap(bucket.byTool),
        byOutcome: counterMap(bucket.byOutcome),
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
 * corpus does not contain; `list` is a catalog browse; `error` is any failed call.
 *
 * @param {{ tool: string, args?: unknown, value?: unknown, isError?: boolean }} call
 * @returns {{ outcome: string, query?: string, ids?: string[], category?: string, count?: number }}
 */
export function classifyCall({ tool, args, value, isError }) {
  const toolName = typeof tool === 'string' ? tool : ''
  const short = SHORT_TOOL[toolName]

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
  }

  /**
   * Record one finished call.
   * @param {{ at?: number, tool: string, outcome: string, query?: string, ids?: string[], category?: string, count?: number }} entry
   * @returns {Promise<void>}
   */
  async function record(entry) {
    if (entry === null || typeof entry !== 'object') return
    const tool = SHORT_TOOL[entry.tool] ?? (typeof entry.tool === 'string' ? entry.tool : '')
    if (tool === '') return
    const outcome = OUTCOMES.has(entry.outcome) ? entry.outcome : 'error'
    const at = toCount(entry.at) || clock()

    const current = await ensure()
    current.calls += 1
    bump(current.byTool, tool)
    bump(current.byOutcome, outcome)

    const day = dayKey(at)
    const bucket = current.byDay[day] ?? (current.byDay[day] = emptyDay())
    bucket.calls += 1
    bump(bucket.byTool, tool)
    bump(bucket.byOutcome, outcome)

    if (outcome === 'hit' && typeof entry.category === 'string') bump(current.byCategory, entry.category)

    // Only a retrieve marks guides as used: a guide that merely appeared in search results has not
    // been read, and counting it would make dead-guide reporting meaningless.
    if (tool === 'retrieve' && outcome === 'hit' && Array.isArray(entry.ids)) {
      for (const id of entry.ids) bump(current.retrieved, id)
    }

    const call = { at, tool, outcome }
    if (typeof entry.query === 'string' && entry.query !== '') call.query = entry.query.slice(0, MAX_QUERY_CHARS)
    if (Array.isArray(entry.ids) && entry.ids.length > 0) call.ids = entry.ids.slice(0, MAX_IDS)
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
    for (const day of days7) {
      const bucket = current.byDay[day]
      const amount = bucket === undefined ? 0 : toCount(bucket.calls)
      calls += amount
      series.push({ day, calls: amount })
      if (bucket === undefined) continue
      for (const [name, count] of Object.entries(bucket.byTool)) bump(byTool, name, toCount(count))
      for (const [name, count] of Object.entries(bucket.byOutcome)) bump(byOutcome, name, toCount(count))
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
      },
      topQueries,
      misses,
      coverage,
      deadGuides: { total: dead.length, sample: dead.slice(0, MAX_DEAD_SAMPLE) },
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
