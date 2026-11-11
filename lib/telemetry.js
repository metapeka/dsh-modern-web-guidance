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
 * Scan debt is partitioned by workspace: `record()` takes an optional `{ id, name }` and keeps the
 * per-rule and per-guide counters in `workspaces[id]`, while every call counter stays profile-wide
 * because it measures the corpus rather than a directory. The partition is additive, so `version`
 * stays 1: a document written before it keeps its root scan counters, which are reported as the
 * synthetic `_unattributed` workspace instead of disappearing.
 *
 * One more label is additive the same way: a completed scan may carry `lastScan.branch`, either
 * `{ kind: 'branch', name }` or `{ kind: 'detached', sha }`, absent when no branch was read. It is a
 * label on one scan, never a counter key, and this module never reads `.git` — the host resolves the
 * label and passes the already-validated record in.
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

/**
 * The one branch-name shape a label may hold: ASCII letters, digits, `.`, `_`, `/` and `-`, at most
 * 80 of them. A name that fails this is not clipped or escaped — it is dropped — because the label
 * is printed verbatim on a report line and stored in JSON.
 */
const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,80}$/

/** A detached label is the first seven characters of an object id, and nothing else. */
const DETACHED_SHA = /^[0-9a-f]{7}$/

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
    // Per-workspace scan debt, keyed by `workspaceId`. Additive: a document without it reads as a
    // profile whose every scan predates partitioning, and those scans stay at the root above.
    workspaces: {},
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
 * Attach the scan's raw workspace path when the tool value carries one. It stays the string that
 * arrived: `classifyCall` is pure and never resolves or hashes a path, so no filesystem work happens
 * here and the caller decides what a workspace is.
 *
 * @param {object} entry the classified call
 * @param {object} payload the tool value
 * @returns {object} the same entry, with `workspacePath` when the value carried a non-empty cwd
 */
function withWorkspacePath(entry, payload) {
  if (typeof payload.cwd === 'string' && payload.cwd !== '') entry.workspacePath = payload.cwd
  return entry
}

/**
 * A stored scan summary, defensively rebuilt. The date is an ISO string; a hand-edited document may
 * carry epoch milliseconds instead, which is accepted and re-serialised. Anything unusable — a
 * non-object, an unparsable date — reads as "no scan yet" rather than as a corrupt row.
 *
 * `branch` is optional and validated here: only `{ kind: 'branch', name }` with a printable name or
 * `{ kind: 'detached', sha }` with seven hex characters survives, so a corrupt or hand-edited label
 * reads as "no label" instead of reaching a report half-built.
 *
 * @param {unknown} value
 * @returns {{ at: string, files: number, findings: number, rules: string[], skipped: Record<string, number>, truncated: boolean, branch?: { kind: 'branch', name: string } | { kind: 'detached', sha: string } } | null}
 */
function normalizeLastScan(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const at = typeof value.at === 'string' ? Date.parse(value.at) : Number(value.at)
  if (!Number.isFinite(at)) return null
  const summary = {
    at: iso(at),
    files: Math.max(0, Math.floor(toCount(value.files))),
    findings: Math.max(0, Math.floor(toCount(value.findings))),
    rules: scanIds(value.rules),
    skipped: topSkipReasons(value.skipped),
    truncated: value.truncated === true,
  }
  const branch = branchLabel(value.branch)
  if (branch !== null) summary.branch = branch
  return summary
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
 * Stable id for a resolved workspace path: FNV-1a 32-bit over the string, 8 lowercase hex chars.
 *
 * The caller resolves the path first (`realpathSync` in `index.js`), so the id is only as stable as
 * that resolution: a moved or renamed directory is a new workspace. The hash is frozen on purpose —
 * the id is a key in the state document, so changing the algorithm would orphan every existing
 * bucket. No path is stored beside it.
 *
 * @param {unknown} path a resolved workspace path
 * @returns {string} eight lowercase hex characters
 */
export function workspaceId(path) {
  const text = typeof path === 'string' ? path : ''
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Validate a stored branch label, or return null when it is not one of the two exact shapes.
 *
 * A label is data read from a repository, so it is rebuilt into a new object instead of passed
 * through: extra members are dropped, and a name that fails the branch-name rule is rejected rather
 * than clipped or escaped, because the label is printed on a report line. A malformed value reads as
 * "no label", never as a half-label with an empty name or a short hash.
 *
 * @param {unknown} value the candidate, as it arrived from state or from the host's read
 * @returns {{ kind: 'branch', name: string } | { kind: 'detached', sha: string } | null}
 */
export function branchLabel(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.kind === 'branch') {
    const name = typeof value.name === 'string' ? value.name : ''
    if (!BRANCH_NAME.test(name)) return null
    if (name.includes('..') || name.includes('//')) return null
    if (name.startsWith('/') || name.endsWith('/') || name.startsWith('-')) return null
    return { kind: 'branch', name }
  }
  if (value.kind === 'detached') {
    const sha = typeof value.sha === 'string' ? value.sha : ''
    if (!DETACHED_SHA.test(sha)) return null
    return { kind: 'detached', sha }
  }
  return null
}

/**
 * The `{ id, name }` a caller attributed a call to, or null when it gave none. A malformed pair is
 * treated as no attribution rather than as an error: a caller that cannot resolve a workspace still
 * records its call, at the root where a pre-partition caller's scans already live.
 *
 * @param {unknown} value
 * @returns {{ id: string, name: string } | null}
 */
function workspaceOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.id !== 'string' || value.id === '') return null
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name !== '' ? value.name : 'workspace',
  }
}

/**
 * Rebuild the per-workspace scan buckets from whatever JSON produced. A missing map reads as empty,
 * an entry that is not an object (or has no id) is dropped rather than thrown, and a bucket that is
 * merely incomplete is completed: a missing name reads as `workspace`, missing counters as empty.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {Record<string, { name: string, since: number, scanRules: Record<string, number>, scanGuides: Record<string, number>, lastScan: object | null }>}
 */
function normalizeWorkspaces(value, now) {
  const workspaces = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return workspaces
  for (const [id, bucket] of Object.entries(value)) {
    if (id === '' || id === '__proto__') continue
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
    workspaces[id] = {
      name: typeof bucket.name === 'string' && bucket.name !== '' ? bucket.name : 'workspace',
      since: toCount(bucket.since) || now,
      scanRules: counterMap(bucket.scanRules),
      scanGuides: counterMap(bucket.scanGuides),
      lastScan: normalizeLastScan(bucket.lastScan),
    }
  }
  return workspaces
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
  // Additive phase D map: a 0.9.0 document has no buckets, and its root scan counters stay the
  // unattributed ones a report shows beside the workspaces that exist now.
  state.workspaces = normalizeWorkspaces(loaded.workspaces, now)

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
 * A legacy scan value also carries the workspace it ran in (`runScanRequest` returns
 * `{ format, cwd, ...result }`). The classification keeps that string as `workspacePath`, raw and
 * unresolved, for the caller that turns it into a workspace id.
 *
 * @param {{ tool: string, args?: unknown, value?: unknown, isError?: boolean }} call
 * @returns {{ outcome: string, query?: string, ids?: string[], category?: string, count?: number, files?: number, findings?: number, rules?: string[], guides?: string[], ruleCounts?: Record<string, number>, guideCounts?: Record<string, number>, skipped?: Record<string, number>, truncated?: boolean, workspacePath?: string, isError?: boolean }}
 */
export function classifyCall({ tool, args, value, isError }) {
  const toolName = typeof tool === 'string' ? tool : ''
  const short = SHORT_TOOL[toolName]

  if (short === 'legacy-scan') {
    const payload = value !== null && typeof value === 'object' ? value : {}
    if (isError === true || typeof payload.error === 'string') {
      return withWorkspacePath({
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
      }, payload)
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
    return withWorkspacePath({
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
    }, payload)
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
 * The scan bucket for one workspace, created on first sight. Call counters, day buckets and the
 * ring stay at the root: only scan debt is workspace-scoped. An existing bucket keeps the name it
 * was created with, so a later call cannot silently rename a workspace.
 *
 * @param {object} state the current document, already normalised
 * @param {{ id: string, name: string }} workspace
 * @param {number} at when the workspace was first seen
 * @returns {object} the bucket to write to
 */
function workspaceBlock(state, workspace, at) {
  if (Object.hasOwn(state.workspaces, workspace.id)) return state.workspaces[workspace.id]
  const bucket = { name: workspace.name, since: at, scanRules: {}, scanGuides: {}, lastScan: null }
  // A workspace id is caller-supplied data: define the property instead of assigning it, so an id
  // such as `__proto__` adds an entry rather than rewriting the map's prototype.
  Object.defineProperty(state.workspaces, workspace.id, { value: bucket, enumerable: true, writable: true, configurable: true })
  return bucket
}

/**
 * Sum two or more scan blocks — the legacy root counters and one block per workspace — so an
 * aggregate view keeps every finding. The last-scan summary cannot be summed, so the newest one wins;
 * a block without one contributes nothing.
 *
 * @param {object[]} blocks objects carrying `scanRules`, `scanGuides` and `lastScan`
 * @returns {{ scanRules: Record<string, number>, scanGuides: Record<string, number>, lastScan: object | null }}
 */
function aggregateScanBlocks(blocks) {
  const scanRules = {}
  const scanGuides = {}
  let lastScan = null
  for (const block of blocks) {
    for (const [id, amount] of Object.entries(block.scanRules)) bump(scanRules, id, toCount(amount))
    for (const [id, amount] of Object.entries(block.scanGuides)) bump(scanGuides, id, toCount(amount))
    if (block.lastScan === null) continue
    if (lastScan === null || Date.parse(block.lastScan.at) > Date.parse(lastScan.at)) lastScan = block.lastScan
  }
  return { scanRules, scanGuides, lastScan }
}

/** One row of the snapshot's workspace list: lifetime findings, distinct rules and last scan. */
function workspaceSummary(id, name, block) {
  let findings = 0
  for (const count of Object.values(block.scanRules)) findings += toCount(count)
  return {
    id,
    name,
    findings,
    rules: Object.keys(block.scanRules).length,
    lastScanAt: block.lastScan === null ? null : block.lastScan.at,
  }
}

/** Newest last scan first, then name; a workspace that was never successfully scanned sorts last. */
function compareWorkspaces(left, right) {
  const leftAt = left.lastScanAt === null ? -Infinity : Date.parse(left.lastScanAt)
  const rightAt = right.lastScanAt === null ? -Infinity : Date.parse(right.lastScanAt)
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
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
 *   snapshot: (options?: { days?: number, workspace?: string }) => Promise<object>,
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
    // A workspace bucket is never dropped and its lifetime counters are never pruned: it is the
    // workspace's identity, not a day's slice. Only its last-scan pointer expires, like the root's.
    for (const bucket of Object.values(current.workspaces)) {
      if (bucket.lastScan !== null && Date.parse(bucket.lastScan.at) < cutoff) bucket.lastScan = null
    }
  }

  /**
   * Record one finished call.
   *
   * `workspace` is the resolved `{ id, name }` the call belongs to, or absent when the caller could
   * not resolve one. Only a legacy scan's rule and guide debt is written to the bucket; every call
   * still counts at the root, and the ring entry is the same shape it has always been.
   *
   * `branch` is the label the host read for this scan — one of the two shapes `branchLabel` accepts —
   * and it is written only onto a completed scan's summary. An absent or malformed label leaves the
   * member unwritten, so a document without one keeps exactly its old shape.
   *
   * @param {{ at?: number, tool: string, outcome: string, workspace?: { id: string, name: string }, branch?: unknown, query?: string, ids?: string[], category?: string, count?: number, files?: number, findings?: number, rules?: string[], guides?: string[], ruleCounts?: Record<string, number>, guideCounts?: Record<string, number>, skipped?: Record<string, number>, truncated?: boolean, isError?: boolean }} entry
   * @returns {Promise<void>}
   */
  async function record(entry) {
    if (entry === null || typeof entry !== 'object') return
    const tool = SHORT_TOOL[entry.tool] ?? (typeof entry.tool === 'string' ? entry.tool : '')
    if (tool === '') return
    const workspace = workspaceOf(entry.workspace)
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
    // different questions, and the panel asks both. A workspace is created on first sight even by a
    // scan that writes no counters, so the switcher can name every workspace the profile has seen.
    if (tool === 'legacy-scan') {
      const debt = workspace === null ? current : workspaceBlock(current, workspace, at)
      for (const [id, amount] of Object.entries(scanCounts(entry.rules, entry.ruleCounts))) {
        bump(debt.scanRules, id, amount)
      }
      for (const [id, amount] of Object.entries(scanCounts(entry.guides, entry.guideCounts))) {
        bump(debt.scanGuides, id, amount)
      }
      // Only a completed scan becomes the last scan: a refusal (absolute path, escape) is an error
      // call, and letting it overwrite the summary would show a fresh "0 files, 0 findings" scan
      // that reads as a clean project. The call itself is still counted, ring entry and all.
      if (outcome === 'findings' || outcome === 'clean') {
        const summary = {
          at: iso(at),
          files,
          findings,
          rules: scanIds(entry.rules),
          skipped: topSkipReasons(entry.skipped),
          truncated: entry.truncated === true,
        }
        // The label is repository data, so it is re-validated at the door: a caller that hands over
        // a half-built record gets a summary with no member at all, never a member a renderer would
        // print verbatim.
        const branch = branchLabel(entry.branch)
        if (branch !== null) summary.branch = branch
        debt.lastScan = summary
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
   *
   * `workspace` selects whose scan debt the report shows: a bucket id, `'_unattributed'` for the
   * root counters a pre-partition document left behind, or `'all'` / omitted for the sum of every
   * bucket. An unknown id is not an error here — the command validates before calling, and a stale
   * id reads as the aggregate rather than as an empty report. Call counters stay profile-wide in
   * every selection, because they measure the corpus rather than a directory.
   *
   * @param {{ days?: number, workspace?: string }} [options]
   * @returns {Promise<object>}
   */
  async function snapshot({ days = 7, workspace } = {}) {
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

    // The legacy root counters, plus one block per workspace. A workspace with no scan debt yet is
    // still a row in the switcher; only the root is conditional, because an empty root is not a
    // workspace anybody recorded into — it is where pre-partition scans happen to live.
    const rootBlock = { scanRules: current.scanRules, scanGuides: current.scanGuides, lastScan: current.lastScan }
    const bucketBlocks = Object.entries(current.workspaces).map(([id, bucket]) => ({ id, name: bucket.name, block: bucket }))
    const legacyRoot = Object.keys(current.scanRules).length > 0
      || Object.keys(current.scanGuides).length > 0
      || current.lastScan !== null

    const selector = typeof workspace === 'string' && workspace !== '' ? workspace : 'all'
    let shown = null
    let block
    if (selector === '_unattributed') {
      shown = { id: '_unattributed', name: '' }
      block = rootBlock
    } else if (selector !== 'all' && Object.hasOwn(current.workspaces, selector)) {
      shown = { id: selector, name: current.workspaces[selector].name }
      block = current.workspaces[selector]
    } else {
      block = aggregateScanBlocks([rootBlock, ...bucketBlocks.map((entry) => entry.block)])
    }

    const workspaces = bucketBlocks.map((entry) => workspaceSummary(entry.id, entry.name, entry.block))
    if (legacyRoot) workspaces.push(workspaceSummary('_unattributed', '', rootBlock))
    workspaces.sort(compareWorkspaces)

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
      topRules: topScanCounters(block.scanRules, 'ruleId'),
      topScanGuides: topScanCounters(block.scanGuides, 'guideId'),
      lastScan: block.lastScan === null ? null : { ...block.lastScan, rules: [...block.lastScan.rules] },
      series,
      // Whose numbers these are: null while aggregating, and the switcher's rows either way.
      workspace: shown,
      workspaces,
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
