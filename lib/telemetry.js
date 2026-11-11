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
 * Scan history is additive on the same terms (0.10.0): a workspace bucket may carry `scanByDay`,
 * `ruleFirstSeen`, `ruleLastSeen`, `scanHistory`, `lastSites` and `scanDiff`, and only a completed
 * scan writes them. `version` stays 1, a document without them reads them as empty, and the
 * comparison they support answers "did the fix land" with the two scans it actually compared — never
 * a lifetime total. Nothing here stores a path or a snippet: a site is eight hex characters derived
 * from all three (`siteId`), and a collision can hide a fix but never invent one.
 *
 * Suppression counts are additive the same way (0.12.0): a completed scan may report how many of
 * its findings are muted, so `lastScan` and each history row gain `suppressed`, and `lastScan` also
 * gains `suppressedRules` when there are any. They are a subset of `findings`, never a subtraction
 * from it: a muted site stays in `sites` and therefore in `stillOpen`, so the diff can never count a
 * mute as a fix. A document without the members still loads, and a scan that reported none writes
 * `0` — the number is a claim, and the diff is what never learns it.
 *
 * @module lib/telemetry
 */

import { fnv1a, siteId, SITE_KEY } from './site.js'

// Re-exported so every existing consumer of this module keeps its import, while the scanner, the
// suppression file and the counters are guaranteed to hash a site the same way.
export { siteId }

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

/** How many completed scans one workspace's history keeps: the "did my fix land" horizon. */
const MAX_HISTORY_SCANS = 20

/** How many rule counts one history entry keeps; the panel shows the same ten. */
const MAX_HISTORY_RULES = 10

/** How many site keys a baseline may hold: the scanner's own `maxFindings`. */
const MAX_SITE_KEYS = 200

/** How many comparison rows one `scanDiff` keeps. */
const MAX_DIFF_ROWS = 40

/**
 * Why a comparison was not made. Raw tokens, like a skip reason: the report and the panel print them
 * verbatim, so they are never a locale key and never a translation.
 */
const PARTIAL_REASONS = new Set([
  'sites-unknown',
  'truncated',
  'no-files',
  'no-baseline',
  'fewer-files',
  'branch-changed',
  'rule-table-changed',
])

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

/** A plain object as JSON produces it: not null, not an array, not a primitive. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A finite non-negative integer, or null when the value is absent: 0 and "missing" differ. */
function toCountOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}

/** A stored `YYYY-MM-DD` day key, or null when the value is not one. */
function dayOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return Number.isFinite(Date.parse(value)) ? value : null
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

/** `map[key] += by`, ignoring keys that are not strings or would rewrite the map's prototype. */
function bump(map, key, by = 1) {
  if (typeof key !== 'string' || key === '' || key === '__proto__') return
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
 * `suppressed` is optional the same way and clamped to `findings`, because it counts a subset of
 * them: a stored 300 on a 12-finding scan is a corrupt number, not a bigger mute. A non-number is
 * dropped rather than read as zero — a pre-C document has no member, and "no claim" must not become
 * "nothing was muted". `suppressedRules` rides along only when the count is positive, so the two
 * members can never disagree in a report.
 *
 * @param {unknown} value
 * @returns {{ at: string, files: number, findings: number, rules: string[], skipped: Record<string, number>, truncated: boolean, branch?: { kind: 'branch', name: string } | { kind: 'detached', sha: string }, suppressed?: number, suppressedRules?: Record<string, number> } | null}
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
  if (typeof value.suppressed === 'number' && Number.isFinite(value.suppressed)) {
    summary.suppressed = Math.min(summary.findings, Math.max(0, Math.floor(value.suppressed)))
    if (summary.suppressed > 0) {
      const suppressedRules = topRuleCounts(value.suppressedRules)
      // The split files each muted finding under at most one rule, so its sum is never larger than
      // the total; a map that claims more is corrupt, and printing it would show more per-rule mutes
      // than mutes. Drop it and keep the number, which is the claim the counters actually made.
      const sum = Object.values(suppressedRules).reduce((total, count) => total + count, 0)
      if (sum > 0 && sum <= summary.suppressed) summary.suppressedRules = suppressedRules
    }
  }
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

// --- Scan history: when a scan happened, and whether the sites it found are still there ---------

/** One per-rule count map as a history entry keeps it: count desc, id asc, capped. */
function topRuleCounts(value) {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, count]) => [id, Math.max(0, Math.floor(toCount(count)))])
      .filter(([id, count]) => id !== '' && count > 0)
      .sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1]
        if (left[0] === right[0]) return 0
        return left[0] < right[0] ? -1 : 1
      })
      .slice(0, MAX_HISTORY_RULES),
  )
}

/**
 * One per-rule site map as state keeps it, plus whether the value could be represented exactly.
 *
 * Keys are eight hex characters; duplicates collapse (two byte-identical sites are one site) and the
 * total is capped at the scanner's own `maxFindings`. `complete` is false when anything was dropped —
 * an invalid key, or the cap — because a map that lost a key would let the next comparison read a
 * present site as absent, which is the one claim this data must never produce.
 *
 * @param {unknown} value
 * @returns {{ sites: Record<string, string[]>, complete: boolean }}
 */
function normalizeSiteSet(value) {
  const sites = {}
  if (!isPlainObject(value)) return { sites, complete: value === undefined || value === null }
  const entries = []
  let complete = true
  let total = 0
  for (const ruleId of Object.keys(value).sort()) {
    if (ruleId === '') {
      complete = false
      continue
    }
    const list = value[ruleId]
    if (!Array.isArray(list)) {
      complete = false
      continue
    }
    const keys = new Set()
    for (const key of list) {
      if (typeof key !== 'string' || !SITE_KEY.test(key)) {
        complete = false
        continue
      }
      if (keys.has(key)) continue
      if (total >= MAX_SITE_KEYS) {
        complete = false
        continue
      }
      keys.add(key)
      total += 1
    }
    if (keys.size > 0) entries.push([ruleId, [...keys].sort()])
  }
  return { sites: Object.fromEntries(entries), complete }
}

/** One per-workspace day series: completed scans only, keyed like the call series. */
function normalizeScanByDay(value) {
  const days = {}
  if (!isPlainObject(value)) return days
  for (const [day, row] of Object.entries(value)) {
    const key = dayOf(day)
    if (key === null || !isPlainObject(row)) continue
    const scans = Math.max(0, Math.floor(toCount(row.scans)))
    // A row for a day without a completed scan is not a row this data writes: read it as absent
    // rather than as an invented "0 scans".
    if (scans === 0) continue
    days[key] = {
      scans,
      files: Math.max(0, Math.floor(toCount(row.files))),
      findings: Math.max(0, Math.floor(toCount(row.findings))),
    }
  }
  return days
}

/** A per-rule day map (`ruleFirstSeen` / `ruleLastSeen`), defensively rebuilt. */
function normalizeSeenMap(value) {
  const map = {}
  if (!isPlainObject(value)) return map
  for (const [id, day] of Object.entries(value)) {
    const key = dayOf(day)
    if (id === '' || id === '__proto__' || key === null) continue
    map[id] = key
  }
  return map
}

/** The three-number copy a history entry keeps of its comparison, or null when it has none. */
function normalizeDiffTotals(value) {
  if (!isPlainObject(value)) return null
  const resolved = toCountOrNull(value.resolved)
  const stillOpen = toCountOrNull(value.stillOpen)
  const added = toCountOrNull(value.new)
  if (resolved === null || stillOpen === null || added === null) return null
  return { resolved, stillOpen, new: added }
}

/**
 * One scan-history entry, defensively rebuilt. Only a completed scan is an entry, so anything else
 * (an error outcome, an unusable timestamp) is dropped rather than shown as a scan that found
 * nothing. The branch label is validated on the way in, like the last scan's.
 *
 * `suppressed` follows the last scan's rules — a number clamped to `findings`, a non-number dropped —
 * but it never gains a rule map: a row answers "when did the muting start", and the per-rule split
 * belongs to the newest scan alone.
 *
 * @param {unknown} value
 * @returns {object | null}
 */
function normalizeHistoryEntry(value) {
  if (!isPlainObject(value)) return null
  const at = typeof value.at === 'string' ? Date.parse(value.at) : Number(value.at)
  if (!Number.isFinite(at)) return null
  const outcome = value.outcome === 'clean' ? 'clean' : value.outcome === 'findings' ? 'findings' : null
  if (outcome === null) return null
  const entry = {
    at: iso(at),
    outcome,
    files: Math.max(0, Math.floor(toCount(value.files))),
    findings: Math.max(0, Math.floor(toCount(value.findings))),
    rules: topRuleCounts(value.rules),
    skipped: topSkipReasons(value.skipped),
    truncated: value.truncated === true,
  }
  const branch = branchLabel(value.branch)
  if (branch !== null) entry.branch = branch
  const diff = normalizeDiffTotals(value.diff)
  if (diff !== null) entry.diff = diff
  if (typeof value.suppressed === 'number' && Number.isFinite(value.suppressed)) {
    entry.suppressed = Math.min(entry.findings, Math.max(0, Math.floor(value.suppressed)))
  }
  return entry
}

/** The per-workspace ring: oldest first, invalid entries dropped, capped at the stored depth. */
function normalizeScanHistory(value) {
  if (!Array.isArray(value)) return []
  const entries = []
  for (const item of value) {
    const entry = normalizeHistoryEntry(item)
    if (entry !== null) entries.push(entry)
  }
  entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  return entries.slice(-MAX_HISTORY_SCANS)
}

/**
 * The per-workspace baseline of site keys, or null. `rules` is rebuilt key by key; a document whose
 * keys no longer validate reads as no baseline at all, which is silence rather than a comparison
 * against half a scan.
 *
 * `branch` is the label of the scan the keys came from: the `branch-changed` guard needs it even
 * when the scan that produced the baseline is older than the latest history entry.
 *
 * @param {unknown} value
 * @returns {{ at: string, files: number, ruleCount: number, rules: Record<string, string[]>, branch?: object } | null}
 */
function normalizeLastSites(value) {
  if (!isPlainObject(value)) return null
  const at = typeof value.at === 'string' ? Date.parse(value.at) : Number(value.at)
  if (!Number.isFinite(at)) return null
  const baseline = {
    at: iso(at),
    files: Math.max(0, Math.floor(toCount(value.files))),
    ruleCount: Math.max(0, Math.floor(toCount(value.ruleCount))),
    rules: normalizeSiteSet(value.rules).sites,
  }
  const branch = branchLabel(value.branch)
  if (branch !== null) baseline.branch = branch
  return baseline
}

/** One comparison row, defensively rebuilt: only rules with a number to show survive. */
function normalizeDiffRows(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  for (const row of value) {
    if (!isPlainObject(row)) continue
    const ruleId = typeof row.ruleId === 'string' ? row.ruleId : ''
    if (ruleId === '') continue
    const resolved = toCountOrNull(row.resolved)
    const stillOpen = toCountOrNull(row.stillOpen)
    const added = toCountOrNull(row.new)
    if (resolved === null || stillOpen === null || added === null) continue
    if (resolved + stillOpen + added === 0) continue
    rows.push({ ruleId, resolved, stillOpen, new: added })
  }
  rows.sort((left, right) => {
    const leftChanged = left.resolved + left.new
    const rightChanged = right.resolved + right.new
    if (rightChanged !== leftChanged) return rightChanged - leftChanged
    if (left.ruleId === right.ruleId) return 0
    return left.ruleId < right.ruleId ? -1 : 1
  })
  return rows.slice(0, MAX_DIFF_ROWS)
}

/**
 * One stored comparison, or null. A partial comparison keeps only `against` and its reason token:
 * "no numbers, never zeros" — the report names why it could not compare instead of drawing an empty
 * diff. A comparison that ran keeps its four numbers and its rows.
 *
 * @param {unknown} value
 * @returns {object | null}
 */
function normalizeScanDiff(value) {
  if (!isPlainObject(value)) return null
  const against = typeof value.against === 'string' && Number.isFinite(Date.parse(value.against))
    ? iso(Date.parse(value.against))
    : null
  if (typeof value.partial === 'string') {
    return PARTIAL_REASONS.has(value.partial) ? { against, partial: value.partial } : null
  }
  if (value.partial !== null && value.partial !== undefined) return null
  const numbers = ['resolved', 'stillOpen', 'new', 'retired'].map((key) => toCountOrNull(value[key]))
  if (numbers.some((number) => number === null)) return null
  const [resolved, stillOpen, added, retired] = numbers
  return {
    against,
    resolved,
    stillOpen,
    new: added,
    retired,
    partial: null,
    rows: normalizeDiffRows(value.rows),
  }
}

/** A copy of a site map, so the baseline cannot share arrays with the scan that produced it. */
function cloneSites(sites) {
  return Object.fromEntries(Object.entries(sites).map(([ruleId, keys]) => [ruleId, [...keys]]))
}

/** A copy of a stored comparison, so a snapshot cannot hand out the live document's rows. */
function cloneScanDiff(diff) {
  if (!isPlainObject(diff)) return null
  const copy = { ...diff }
  if (Array.isArray(diff.rows)) copy.rows = diff.rows.map((row) => ({ ...row }))
  return copy
}

/** Whether two present labels name different checkouts: comparing across them is a tree difference. */
function labelsDiffer(baselineLabel, currentLabel) {
  if (baselineLabel === undefined || baselineLabel === null || currentLabel === null) return false
  if (baselineLabel.kind !== currentLabel.kind) return true
  return baselineLabel.kind === 'branch'
    ? baselineLabel.name !== currentLabel.name
    : baselineLabel.sha !== currentLabel.sha
}

/**
 * Why this scan cannot be compared with a workspace's baseline, or null when it can.
 *
 * The first three guards ask whether *this scan* can testify at all; the rest ask whether the
 * comparison itself is fair. First match wins, so the most fundamental reason is the one named.
 * Tokens are frozen: they are printed verbatim, like a skip reason.
 *
 * @param {{ sitesComplete: boolean, truncated: boolean, files: number, baseline: object | null, branch: object | null, ruleTable: string[] }} scan
 * @returns {string | null}
 */
function comparisonRefusal({ sitesComplete, truncated, files, baseline, branch, ruleTable }) {
  if (!sitesComplete) return 'sites-unknown'
  if (truncated) return 'truncated'
  if (files === 0) return 'no-files'
  if (baseline === null) return 'no-baseline'
  // A scan that read fewer files cannot prove absence: scanning a narrower path on purpose suppresses
  // the comparison, which is an absence of a claim rather than a wrong one.
  if (files < baseline.files) return 'fewer-files'
  if (labelsDiffer(baseline.branch, branch)) return 'branch-changed'
  // A rule table that changed size would report a new rule's sites as "new" and a removed one's as
  // "resolved"; the retired bucket covers the second half, this guard covers the first.
  if (ruleTable.length > 0 && ruleTable.length !== baseline.ruleCount) return 'rule-table-changed'
  return null
}

/**
 * Compare one scan's site map with a baseline, per rule id present in either side.
 *
 * `resolved` is only ever "the key was in the previous scan and is not in this one", and only for
 * rules the current table still ships: a rule that retired takes its keys to `retired`, never to
 * `resolved`. Two invariants follow, and the tests pin them: `resolved + stillOpen + retired` equals
 * the baseline's key count, and `stillOpen + new` equals the scan's.
 *
 * @param {{ rules: Record<string, string[]> }} baseline
 * @param {Record<string, string[]>} current
 * @param {string[]} ruleTable the current rule ids, or empty when this telemetry was told none
 * @returns {{ resolved: number, stillOpen: number, new: number, retired: number, rows: object[] }}
 */
function compareSites(baseline, current, ruleTable) {
  const shipped = ruleTable.length > 0 ? new Set(ruleTable) : null
  const ruleIds = new Set([...Object.keys(baseline.rules), ...Object.keys(current)])
  const rows = []
  let resolved = 0
  let stillOpen = 0
  let added = 0
  let retired = 0
  for (const ruleId of [...ruleIds].sort()) {
    const before = new Set(baseline.rules[ruleId] ?? [])
    const after = new Set(current[ruleId] ?? [])
    let rowResolved = 0
    let rowStillOpen = 0
    let rowAdded = 0
    if (shipped !== null && !shipped.has(ruleId)) {
      // The rule left the table: its baseline sites are retired, never resolved. A site still reported
      // under that id is new, which keeps the second invariant true even for a table we were not told.
      retired += before.size
      rowAdded = after.size
    } else {
      for (const key of before) {
        if (after.has(key)) rowStillOpen += 1
        else rowResolved += 1
      }
      for (const key of after) {
        if (!before.has(key)) rowAdded += 1
      }
    }
    resolved += rowResolved
    stillOpen += rowStillOpen
    added += rowAdded
    if (rowResolved > 0 || rowStillOpen > 0 || rowAdded > 0) {
      rows.push({ ruleId, resolved: rowResolved, stillOpen: rowStillOpen, new: rowAdded })
    }
  }
  rows.sort((left, right) => {
    const leftChanged = left.resolved + left.new
    const rightChanged = right.resolved + right.new
    if (rightChanged !== leftChanged) return rightChanged - leftChanged
    if (left.ruleId === right.ruleId) return 0
    return left.ruleId < right.ruleId ? -1 : 1
  })
  return { resolved, stillOpen, new: added, retired, rows: rows.slice(0, MAX_DIFF_ROWS) }
}

/**
 * Stable id for a resolved workspace path: FNV-1a 32-bit over the string, 8 lowercase hex chars.
 *
 * The caller resolves the path first (`realpathSync` in `index.js`), so the id is only as stable as
 * that resolution: a moved or renamed directory is a new workspace. The hash is frozen on purpose —
 * the id is a key in the state document, so changing the algorithm would orphan every existing
 * bucket. No path is stored beside it. The hash itself lives in `lib/site.js`, because the scanner
 * and the suppression file share it with `siteId`.
 *
 * @param {unknown} path a resolved workspace path
 * @returns {string} eight lowercase hex characters
 */
export function workspaceId(path) {
  return fnv1a(typeof path === 'string' ? path : '')
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
 * The stored shape of one workspace bucket: the attribution members plus the history members. A bucket
 * is created on first sight and completed here, so every bucket the counters write has the same
 * members in the same order.
 *
 * @param {string} name
 * @param {number} since when the workspace was first seen
 * @returns {object}
 */
function emptyBucket(name, since) {
  return {
    name,
    since,
    scanRules: {},
    scanGuides: {},
    lastScan: null,
    scanByDay: {},
    ruleFirstSeen: {},
    ruleLastSeen: {},
    scanHistory: [],
    lastSites: null,
    scanDiff: null,
  }
}

/**
 * Rebuild the per-workspace scan buckets from whatever JSON produced. A missing map reads as empty,
 * an entry that is not an object (or has no id) is dropped rather than thrown, and a bucket that is
 * merely incomplete is completed: a missing name reads as `workspace`, missing counters as empty,
 * and the six history members as their empty values — an attribution-only bucket is upgraded in place.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {Record<string, object>}
 */
function normalizeWorkspaces(value, now) {
  const workspaces = {}
  if (!isPlainObject(value)) return workspaces
  for (const [id, bucket] of Object.entries(value)) {
    if (id === '' || id === '__proto__') continue
    if (!isPlainObject(bucket)) continue
    const name = typeof bucket.name === 'string' && bucket.name !== '' ? bucket.name : 'workspace'
    const normalized = emptyBucket(name, toCount(bucket.since) || now)
    normalized.scanRules = counterMap(bucket.scanRules)
    normalized.scanGuides = counterMap(bucket.scanGuides)
    normalized.lastScan = normalizeLastScan(bucket.lastScan)
    normalized.scanByDay = normalizeScanByDay(bucket.scanByDay)
    normalized.ruleFirstSeen = normalizeSeenMap(bucket.ruleFirstSeen)
    normalized.ruleLastSeen = normalizeSeenMap(bucket.ruleLastSeen)
    normalized.scanHistory = normalizeScanHistory(bucket.scanHistory)
    normalized.lastSites = normalizeLastSites(bucket.lastSites)
    normalized.scanDiff = normalizeScanDiff(bucket.scanDiff)
    workspaces[id] = normalized
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
 * The instant a `YYYY-MM-DD` calendar day starts, in the same local calendar `dayKey()` buckets
 * days with. An unparsable key yields 0, which no timestamp test treats as "inside the window" —
 * a row that cannot be placed in time is kept rather than guessed away.
 *
 * @param {string} day
 * @returns {number}
 */
function dayStart(day) {
  const parts = String(day).split('-').map((part) => Number(part))
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/**
 * The day keys a report of the last `days` days covers, oldest first — the same window
 * `snapshot()` sums, so "the window I erased" and "the window I show" cannot mean two things.
 *
 * @param {number} now
 * @param {number} days
 * @returns {string[]}
 */
function windowDays(now, days) {
  const keys = []
  for (let index = days - 1; index >= 0; index -= 1) keys.push(dayKey(now - index * DAY_MS))
  return keys
}

/**
 * Erase one named slice of a counter document in place, and report what was removed.
 *
 * Every member the scope does not name is left exactly as it was found — same values, same keys,
 * same order — because a partial reset that normalised the rest would be a silent second rewrite.
 * A day or a bucket that does not exist is a no-op, not an error: the caller validates the names a
 * person typed, and a stale name still has to mean "nothing to erase" rather than "erase anything".
 *
 * @param {object} current a document `normalizeState()` produced.
 * @param {number} now the clock reading the window is measured back from.
 * @param {'scans' | 'workspace' | 'window'} scope
 * @param {string | undefined} workspace the bucket id, for the `workspace` scope.
 * @param {number} days the window length, for the `window` scope.
 * @returns {{ scope: string, calls: number, files: number, findings: number, scans: number, workspaces: number }}
 */
function eraseCounters(current, now, scope, workspace, days) {
  const tally = { scope, calls: 0, files: 0, findings: 0, scans: 0, workspaces: 0 }

  if (scope === 'scans') {
    // The day rows keep their calls and their outcome/tool split: those count calls, not findings.
    // Only the scan volume they carry is debt, so it is zeroed rather than the row being dropped.
    for (const row of Object.values(current.byDay)) {
      tally.files += toCount(row.files)
      tally.findings += toCount(row.findings)
      row.files = 0
      row.findings = 0
    }
    // A pre-partition document keeps its scan debt at the root, and the report lists that root as the
    // `_unattributed` row — so it is one more workspace here, not a silent extra erasure. Measured
    // before the members are cleared, because clearing them is what makes it invisible.
    const legacyRoot = Object.keys(current.scanRules).length > 0
      || Object.keys(current.scanGuides).length > 0
      || current.lastScan !== null
    current.scanRules = {}
    current.scanGuides = {}
    current.lastScan = null
    if (legacyRoot) tally.workspaces += 1
    for (const bucket of Object.values(current.workspaces)) {
      tally.scans += bucket.scanHistory.length
      tally.workspaces += 1
    }
    current.workspaces = {}
    // The ring records what a call was, and a scan's `files`/`findings` are its debt: the call stays,
    // the debt does not. Dropping the whole row would erase a call counter to erase a scan counter.
    for (const call of current.recent) {
      if (call.tool !== 'legacy-scan') continue
      delete call.files
      delete call.findings
    }
    return tally
  }

  if (scope === 'workspace') {
    if (workspace === '_unattributed') {
      // The legacy root is a synthetic bucket: a pre-partition document left its scan debt at the
      // top level, and that is what selecting it erases.
      current.scanRules = {}
      current.scanGuides = {}
      current.lastScan = null
      tally.workspaces = 1
      return tally
    }
    const bucket = current.workspaces[workspace]
    if (bucket === undefined) return tally
    // A bucket's own day series is where its scan volume lives, so the tally can name it exactly;
    // the profile-wide `byDay` rows stay, because they count every workspace together and cannot be
    // narrowed after the fact.
    for (const row of Object.values(bucket.scanByDay)) {
      tally.files += toCount(row.files)
      tally.findings += toCount(row.findings)
    }
    tally.scans += bucket.scanHistory.length
    tally.workspaces = 1
    delete current.workspaces[workspace]
    return tally
  }

  // `window`: everything dated at or after the first instant of the oldest day in the window. Days
  // sort lexicographically (`YYYY-MM-DD`), so the comparison is the calendar's. The root day rows
  // carry the profile-wide volume — they are the sum of every workspace — so the tally reads them
  // and the per-bucket rows below only lose their rows, never add to the count.
  const oldest = windowDays(now, days)[0]
  const cutoff = dayStart(oldest)
  for (const [day, row] of Object.entries(current.byDay)) {
    if (day < oldest) continue
    tally.calls += toCount(row.calls)
    tally.files += toCount(row.files)
    tally.findings += toCount(row.findings)
    delete current.byDay[day]
  }
  current.recent = current.recent.filter((entry) => toCount(entry.at) < cutoff)
  // The root summary is a pointer into the window like a bucket's: once its scan is erased, keeping
  // it would print a last scan whose days are gone.
  if (current.lastScan !== null && Date.parse(current.lastScan.at) >= cutoff) current.lastScan = null
  for (const bucket of Object.values(current.workspaces)) {
    let touched = false
    for (const day of Object.keys(bucket.scanByDay)) {
      if (day < oldest) continue
      delete bucket.scanByDay[day]
      touched = true
    }
    const kept = bucket.scanHistory.filter((entry) => Date.parse(entry.at) < cutoff)
    tally.scans += bucket.scanHistory.length - kept.length
    if (kept.length !== bucket.scanHistory.length) {
      bucket.scanHistory = kept
      touched = true
    }
    if (bucket.lastScan !== null && Date.parse(bucket.lastScan.at) >= cutoff) {
      bucket.lastScan = null
      bucket.scanDiff = null
      touched = true
    }
    if (bucket.lastSites !== null && Date.parse(bucket.lastSites.at) >= cutoff) {
      bucket.lastSites = null
      touched = true
    }
    if (touched) tally.workspaces += 1
  }
  return tally
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
 * A completed scan also yields the site identity of every finding: a per-rule map of eight-hex keys
 * (`siteId`) and whether that map represents the whole scan. A finding without a non-empty `path`,
 * `ruleId` or `snippet` makes the map incomplete — an empty snippet would collapse every such site of
 * one rule in one file into one key — and an incomplete map compares with nothing. Only hashes leave
 * this function; no path or snippet does.
 *
 * @param {{ tool: string, args?: unknown, value?: unknown, isError?: boolean }} call
 * @returns {{ outcome: string, query?: string, ids?: string[], category?: string, count?: number, files?: number, findings?: number, rules?: string[], guides?: string[], ruleCounts?: Record<string, number>, guideCounts?: Record<string, number>, suppressed?: number, suppressedRules?: Record<string, number>, skipped?: Record<string, number>, truncated?: boolean, sites?: Record<string, string[]>, sitesComplete?: boolean, workspacePath?: string, isError?: boolean }}
 */
export function classifyCall({ tool, args, value, isError }) {
  const toolName = typeof tool === 'string' ? tool : ''
  const short = SHORT_TOOL[toolName]

  if (short === 'legacy-scan') {
    const payload = isPlainObject(value) ? value : {}
    if (isError === true || typeof payload.error === 'string') {
      // A refusal ran no scan, so it has no sites and can testify about nothing: the same shape a
      // hand-built value gets, and the reason a refused call never becomes a baseline.
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
        sites: {},
        sitesComplete: false,
      }, payload)
    }
    const scanned = isPlainObject(payload.scanned) ? payload.scanned : {}
    const findings = Array.isArray(payload.findings)
      ? payload.findings.filter((finding) => finding !== null && typeof finding === 'object')
      : []
    const ruleCounts = {}
    const guideCounts = {}
    const suppressedRules = {}
    const siteMap = new Map()
    const siteKeys = new Set()
    let suppressed = 0
    let sitesComplete = true
    for (const finding of findings) {
      const ruleId = typeof finding.ruleId === 'string' ? finding.ruleId : ''
      if (ruleId !== '') bump(ruleCounts, ruleId)
      if (typeof finding.guideId === 'string' && finding.guideId !== '') bump(guideCounts, finding.guideId)
      // A muted finding is a subset count, never a subtraction: `findings` below includes it, and the
      // site map below keeps it, which is why a suppression can never read as a fix in a comparison.
      if (finding.suppressed === true) {
        suppressed += 1
        if (ruleId !== '') bump(suppressedRules, ruleId)
      }
      const path = typeof finding.path === 'string' ? finding.path : ''
      const snippet = typeof finding.snippet === 'string' ? finding.snippet : ''
      // The scanner ships the key it matched against, so it wins when present; a hand-built value
      // carries only the three parts and is hashed here by the same function (`lib/site.js`). A
      // finding with neither usable identity cannot be compared, so the map is marked incomplete.
      const shipped = typeof finding.siteId === 'string' && SITE_KEY.test(finding.siteId) ? finding.siteId : null
      let key = shipped
      if (key === null) {
        if (path === '' || ruleId === '' || snippet === '') {
          sitesComplete = false
          continue
        }
        key = siteId(path, ruleId, snippet)
      }
      // One rule can fire the same site twice in a hand-built value; byte-identical sites are one key.
      if (siteKeys.has(key)) continue
      if (siteKeys.size >= MAX_SITE_KEYS) {
        sitesComplete = false
        continue
      }
      siteKeys.add(key)
      if (!siteMap.has(ruleId)) siteMap.set(ruleId, [])
      siteMap.get(ruleId).push(key)
    }
    const sites = Object.fromEntries(
      [...siteMap.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([ruleId, keys]) => [ruleId, keys.sort()]),
    )
    const classified = {
      outcome: findings.length > 0 ? 'findings' : 'clean',
      files: toCount(scanned.files),
      findings: findings.length,
      // `rules`/`guides` are the present ids a panel can list; the counts say how many findings each
      // id accounted for, since one rule can fire several times inside one scan.
      rules: Object.keys(ruleCounts).sort().slice(0, MAX_SCAN_IDS),
      guides: Object.keys(guideCounts).sort().slice(0, MAX_SCAN_IDS),
      ruleCounts,
      guideCounts,
      // How many of those findings came back muted, and which rules they belong to. Both are subsets
      // of the numbers above, so a renderer must never add or subtract them.
      suppressed,
      // The audit trail: how many paths the walk refused and why, and whether it hit a cap. The scan
      // result carries both top-level `truncated` (any cap, findings included) and `scanned.truncated`.
      skipped: topSkipReasons(scanned.skippedByReason),
      truncated: payload.truncated === true || scanned.truncated === true,
      sites,
      sitesComplete,
    }
    if (Object.keys(suppressedRules).length > 0) classified.suppressedRules = suppressedRules
    return withWorkspacePath(classified, payload)
  }

  if (isError === true || short === undefined) return { outcome: 'error' }

  const input = isPlainObject(args) ? args : {}
  const payload = isPlainObject(value) ? value : {}

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
  const bucket = emptyBucket(workspace.name, at)
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
 * The windowed scan series of a scope: one row per day, zeros included (a chart has no holes), summed
 * across every bucket the scope covers.
 *
 * `null` when the scope has no `scanByDay` row at all: a document written before this series existed
 * has none anywhere, so the snapshot omits the key and the consumer renders no block, rather than a
 * flat zero line that would claim scans were counted and found none.
 *
 * @param {object[]} blocks the buckets the scope covers
 * @param {string[]} days the window's day keys, oldest first
 * @returns {Array<{ day: string, scans: number, files: number, findings: number }> | null}
 */
function scanSeriesOf(blocks, days) {
  const byDay = {}
  let seen = false
  for (const block of blocks) {
    for (const [day, row] of Object.entries(block.scanByDay ?? {})) {
      seen = true
      const target = byDay[day] ?? (byDay[day] = { scans: 0, files: 0, findings: 0 })
      target.scans += toCount(row.scans)
      target.files += toCount(row.files)
      target.findings += toCount(row.findings)
    }
  }
  if (!seen) return null
  return days.map((day) => ({
    day,
    scans: byDay[day]?.scans ?? 0,
    files: byDay[day]?.files ?? 0,
    findings: byDay[day]?.findings ?? 0,
  }))
}

/**
 * A stored last scan as a snapshot hands it out: the `rules` array and the `suppressedRules` map are
 * copied, never aliased into the live document.
 *
 * @param {object} stored
 * @returns {object}
 */
function copyLastScan(stored) {
  const copy = { ...stored, rules: [...stored.rules] }
  if (stored.suppressedRules !== undefined) copy.suppressedRules = { ...stored.suppressedRules }
  return copy
}

/**
 * The scope's completed scans, newest first. An aggregate merges every bucket's ring and labels each
 * row with the workspace it came from — the only place a merged row needs the label, because
 * `snapshot.workspace` is null there; a single workspace keeps the rows as stored, since the
 * snapshot already names the scope. Rows are copied, never aliased into the live document.
 *
 * @param {{ id: string, name: string, block: object }[]} scope
 * @param {boolean} merged whether this is an aggregate across buckets
 * @returns {object[]}
 */
function scanHistoryOf(scope, merged) {
  const rows = []
  for (const entry of scope) {
    for (const stored of entry.block.scanHistory ?? []) {
      const row = {
        at: stored.at,
        outcome: stored.outcome,
        files: stored.files,
        findings: stored.findings,
        rules: { ...stored.rules },
        skipped: { ...stored.skipped },
        truncated: stored.truncated,
      }
      if (typeof stored.suppressed === 'number') row.suppressed = stored.suppressed
      if (stored.branch !== undefined) row.branch = { ...stored.branch }
      if (stored.diff !== undefined) row.diff = { ...stored.diff }
      if (merged) row.workspace = { id: entry.id, name: entry.name }
      rows.push(row)
    }
  }
  rows.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
  return rows.slice(0, MAX_HISTORY_SCANS)
}

/**
 * The first and last day each rule was seen across a scope, for the ranked `topRules` rows. An
 * aggregate takes the earliest and latest day of every bucket it sums; a rule without a date in the
 * scope — a pre-B document, or a legacy root row that no bucket covers — reads as null, not a guess.
 *
 * @param {{ block: object }[]} scope
 * @returns {{ first: Record<string, string>, last: Record<string, string> }}
 */
function ruleDaysOf(scope) {
  const first = {}
  const last = {}
  for (const entry of scope) {
    for (const [id, day] of Object.entries(entry.block.ruleFirstSeen ?? {})) {
      if (first[id] === undefined || day < first[id]) first[id] = day
    }
    for (const [id, day] of Object.entries(entry.block.ruleLastSeen ?? {})) {
      if (last[id] === undefined || day > last[id]) last[id] = day
    }
  }
  return { first, last }
}

/**
 * Create the counters.
 *
 * `ruleIds` is the current rule table's ids, and it is optional on purpose: this module must not
 * import `lib/scan-rules.js` (it stays free of the scanner), so the host passes the ids once. A
 * telemetry built without them behaves as if every rule id were known — it never reports a `retired`
 * site and never refuses a comparison with `rule-table-changed` — which keeps hand-built fixtures
 * working and makes the dependency explicit.
 *
 * @param {{
 *   store: { load: () => Promise<unknown>, save: (state: unknown) => Promise<void> },
 *   clock?: () => number,
 *   retentionDays?: number,
 *   ringLimit?: number,
 *   catalog?: { total?: number, byCategory?: Record<string, number>, ids?: string[], categoryOf?: Record<string, string>, version?: string, snapshotDate?: string },
 *   ruleIds?: string[],
 * }} options
 * @returns {{
 *   record: (entry: object) => Promise<void>,
 *   snapshot: (options?: { days?: number, workspace?: string }) => Promise<object>,
 *   reset: (options?: { scope?: 'all' | 'scans' | 'workspace' | 'window', workspace?: string, days?: number }) => Promise<object>,
 *   flush: () => Promise<void>,
 * }}
 */
export function createTelemetry({ store, clock = () => Date.now(), retentionDays = 90, ringLimit = 1000, catalog = {}, ruleIds = [] } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('createTelemetry requires a store with load() and save()')
  }

  const retention = toDays(retentionDays) === 7 ? (toCount(retentionDays) > 0 ? toDays(retentionDays) : 90) : toDays(retentionDays)
  const ring = toCount(ringLimit) > 0 ? Math.floor(toCount(ringLimit)) : 1000
  const ruleTable = Array.isArray(ruleIds)
    ? [...new Set(ruleIds.filter((id) => typeof id === 'string' && id !== ''))]
    : []
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
      // The comparison describes the latest completed scan; once that scan leaves the window there is
      // no row to print it under, so it goes with the pointer rather than outliving it.
      if (bucket.lastScan === null) bucket.scanDiff = null
      // The day series is pruned with the call series, so a day means the same thing in both.
      for (const day of Object.keys(bucket.scanByDay)) {
        if (day < oldestDay) delete bucket.scanByDay[day]
      }
      // The ring is depth-bounded and also window-bounded: a pruned ring is shorter, never padded.
      if (bucket.scanHistory.length > 0) {
        bucket.scanHistory = bucket.scanHistory.filter((entry) => Date.parse(entry.at) >= cutoff)
      }
      // The baseline is a yardstick, not a lifetime record: an expired one cannot defend a comparison.
      if (bucket.lastSites !== null && Date.parse(bucket.lastSites.at) < cutoff) bucket.lastSites = null
    }
  }

  /**
   * Append one completed scan to a workspace's history and compare it with that workspace's baseline.
   *
   * Only a completed scan reaches here, so the ring never holds a refusal (the `lastScan` precedent:
   * a refused scan found nothing and must not read as a clean project). The baseline is refreshed
   * only when this scan is allowed to become a yardstick — complete sites, untruncated, at least one
   * file read — and the comparison is stored either way: a skipped one keeps its reason token and no
   * numbers, because "0 resolved" would be a claim this data cannot defend.
   *
   * @param {object} target the workspace bucket
   * @param {{ at: number, day: string, outcome: string, files: number, findings: number, suppressed: number, ruleCounts: Record<string, number>, skipped: unknown, truncated: boolean, branch: object | null, sites: Record<string, string[]>, sitesComplete: boolean }} scan
   */
  function recordScan(target, scan) {
    const row = target.scanByDay[scan.day] ?? (target.scanByDay[scan.day] = { scans: 0, files: 0, findings: 0 })
    row.scans += 1
    row.files += scan.files
    row.findings += scan.findings

    const entry = {
      at: iso(scan.at),
      outcome: scan.outcome,
      files: scan.files,
      findings: scan.findings,
      rules: topRuleCounts(scan.ruleCounts),
      skipped: topSkipReasons(scan.skipped),
      truncated: scan.truncated,
      // The row's own muted count, so "when did the muting start" is answerable from the ring. It is
      // a subset of `findings` above, never a subtraction from it, and the ring stores no per-rule
      // split — that belongs to the newest scan only.
      suppressed: scan.suppressed,
    }
    if (scan.branch !== null) entry.branch = scan.branch

    const baseline = target.lastSites
    const partial = comparisonRefusal({
      sitesComplete: scan.sitesComplete,
      truncated: scan.truncated,
      files: scan.files,
      baseline,
      branch: scan.branch,
      ruleTable,
    })
    if (partial === null) {
      const compared = compareSites(baseline, scan.sites, ruleTable)
      entry.diff = { resolved: compared.resolved, stillOpen: compared.stillOpen, new: compared.new }
      target.scanDiff = {
        against: baseline.at,
        resolved: compared.resolved,
        stillOpen: compared.stillOpen,
        new: compared.new,
        retired: compared.retired,
        partial: null,
        rows: compared.rows,
      }
    } else {
      target.scanDiff = { against: baseline === null ? null : baseline.at, partial }
    }

    target.scanHistory.push(entry)
    if (target.scanHistory.length > MAX_HISTORY_SCANS) {
      target.scanHistory = target.scanHistory.slice(-MAX_HISTORY_SCANS)
    }

    // A scan that cannot testify never becomes the next comparison's yardstick, and neither does one
    // that is allowed to testify but would compare against itself. `fewer-files` is the one refusal
    // that keeps the old baseline: the scan is suspected narrower, not wrong.
    const mayReplace = scan.sitesComplete && !scan.truncated && scan.files > 0
    if (mayReplace && partial !== 'fewer-files') {
      target.lastSites = {
        at: iso(scan.at),
        files: scan.files,
        ruleCount: ruleTable.length,
        rules: cloneSites(scan.sites),
      }
      if (scan.branch !== null) target.lastSites.branch = scan.branch
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
   * `sites`/`sitesComplete` come from `classifyCall` for a completed scan: the hashed site identity of
   * every finding, and whether that map represents the whole scan. A hand-built entry with findings
   * and no map is recorded as sites-unknown rather than compared; one with no findings is complete,
   * because a scan that found nothing has nothing missing.
   *
   * @param {{ at?: number, tool: string, outcome: string, workspace?: { id: string, name: string }, branch?: unknown, query?: string, ids?: string[], category?: string, count?: number, files?: number, findings?: number, rules?: string[], guides?: string[], ruleCounts?: Record<string, number>, guideCounts?: Record<string, number>, suppressed?: number, suppressedRules?: Record<string, number>, skipped?: Record<string, number>, truncated?: boolean, sites?: Record<string, string[]>, sitesComplete?: boolean, isError?: boolean }} entry
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
      const target = workspace === null ? null : workspaceBlock(current, workspace, at)
      const debt = target ?? current
      const ruleAmounts = scanCounts(entry.rules, entry.ruleCounts)
      for (const [id, amount] of Object.entries(ruleAmounts)) bump(debt.scanRules, id, amount)
      for (const [id, amount] of Object.entries(scanCounts(entry.guides, entry.guideCounts))) {
        bump(debt.scanGuides, id, amount)
      }
      // First and last seen are day keys, not counters: the earliest and latest day the rule had a
      // positive count, written from the same map the lifetime counters use. They only move outward,
      // so a clock that jumps backwards can never rewind "first seen" past a real one.
      if (target !== null) {
        for (const [id, amount] of Object.entries(ruleAmounts)) {
          if (amount <= 0 || id === '__proto__') continue
          const first = target.ruleFirstSeen[id]
          if (first === undefined || day < first) target.ruleFirstSeen[id] = day
          const last = target.ruleLastSeen[id]
          if (last === undefined || day > last) target.ruleLastSeen[id] = day
        }
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
        // A muted finding is a subset of `findings`, so the count is clamped to it here as well as on
        // read: no stored number may claim more mutes than the scan returned findings. A caller with
        // no suppression member (a host from before 0.12.0) records 0 — the scan ran and muted nothing.
        const suppressed = Math.min(findings, Math.max(0, Math.floor(toCount(entry.suppressed))))
        summary.suppressed = suppressed
        // Written only when there is a split to show, so a scan that muted nothing carries one extra
        // number and no empty map, and a pre-C document still reads as shorter.
        const suppressedRules = topRuleCounts(entry.suppressedRules)
        if (suppressed > 0 && Object.keys(suppressedRules).length > 0) {
          summary.suppressedRules = suppressedRules
        }
        debt.lastScan = summary
        if (target !== null) {
          // The site map is re-validated for the same reason the label is: whatever a caller handed
          // over, only a map this module can represent exactly is allowed to testify. An entry with
          // no findings is complete by definition; one with findings and no map is not.
          const siteSet = normalizeSiteSet(entry.sites)
          recordScan(target, {
            at,
            day,
            outcome,
            files,
            findings,
            ruleCounts: ruleAmounts,
            suppressed,
            suppressedRules,
            skipped: entry.skipped,
            truncated: entry.truncated === true,
            branch,
            sites: siteSet.sites,
            sitesComplete: siteSet.complete
              && (entry.sitesComplete === true || (entry.sitesComplete === undefined && findings === 0)),
          })
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
    // The buckets the scope covers for the history members. The legacy root is never one of them: it
    // has no scan history, no baseline and no day series, so `_unattributed` answers empty and a
    // legacy root row's dates read as null.
    let scope = []
    let merged = false
    if (selector === '_unattributed') {
      shown = { id: '_unattributed', name: '' }
      block = rootBlock
    } else if (selector !== 'all' && Object.hasOwn(current.workspaces, selector)) {
      const bucket = current.workspaces[selector]
      shown = { id: selector, name: bucket.name }
      block = bucket
      scope = [{ id: selector, name: bucket.name, block: bucket }]
    } else {
      block = aggregateScanBlocks([rootBlock, ...bucketBlocks.map((entry) => entry.block)])
      scope = bucketBlocks
      merged = true
    }

    const workspaces = bucketBlocks.map((entry) => workspaceSummary(entry.id, entry.name, entry.block))
    if (legacyRoot) workspaces.push(workspaceSummary('_unattributed', '', rootBlock))
    workspaces.sort(compareWorkspaces)

    // 0.10.0: the scan series, history and comparison of the selected scope. The comparison is
    // single-bucket only — comparing two projects would compare two trees — so an aggregate returns
    // null and the report prints nothing there.
    const scanSeries = scanSeriesOf(scope.map((entry) => entry.block), days7)
    const scanHistory = scanHistoryOf(scope, merged)
    const single = scope.length === 1 && !merged ? scope[0].block : null
    const scanDiff = single === null ? null : cloneScanDiff(single.scanDiff)
    const ruleDays = ruleDaysOf(scope)
    const topRules = topScanCounters(block.scanRules, 'ruleId').map((row) => ({
      ...row,
      firstSeen: ruleDays.first[row.ruleId] ?? null,
      lastSeen: ruleDays.last[row.ruleId] ?? null,
    }))

    const snapshot = {
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
      topRules,
      topScanGuides: topScanCounters(block.scanGuides, 'guideId'),
      lastScan: block.lastScan === null ? null : copyLastScan(block.lastScan),
      series,
      // Whose numbers these are: null while aggregating, and the switcher's rows either way.
      workspace: shown,
      workspaces,
    }
    // `scanSeries` is the one member that can be absent: a document written before the series existed
    // has no row anywhere, and an absent key renders no block, while an empty series would draw a
    // flat line that claims scans were counted and found none.
    if (scanSeries !== null) snapshot.scanSeries = scanSeries
    snapshot.scanHistory = scanHistory
    snapshot.scanDiff = scanDiff
    return snapshot
  }

  /**
   * Erase counters: all of them, or one named slice of them.
   *
   * The default, `{ scope: 'all' }`, is what a bare `--reset --yes` has always done: a fresh
   * document. The other three scopes name what goes and, by implication, what stays — and the
   * returned tally is what was removed, so a caller reports an erasure instead of implying one.
   *
   * - `scans` erases the scan debt: the rule and guide totals, the last scan, every workspace
   *   bucket (its own counters, history, baseline and comparison) and the scan volume in the day
   *   rows. Every call counter stays, including how many scans were run: a call happened, and the
   *   counters' job is to count calls.
   * - `workspace` erases one bucket, and nothing else: no other workspace, no call counter.
   *   `'_unattributed'` is the legacy root, whose scan debt lives at the document's top level.
   * - `window` erases what is dated inside the last `days` days: those day rows, the call ring
   *   entries, each bucket's day rows, history rows, baseline and pointers from the window's first
   *   instant onward. Members a day cannot be attributed to — lifetime rule/guide totals, first and
   *   last seen, coverage and retrieved guides — stay, because erasing them would be a guess about
   *   which days they came from.
   *
   * `version` is untouched in every scope, and a partial scope mutates the document in place rather
   * than rebuilding it: every member that survives must survive byte-identically, and normalising
   * the rest would be a second, silent rewrite.
   *
   * @param {{ scope?: 'all' | 'scans' | 'workspace' | 'window', workspace?: string, days?: number }} [options]
   * @returns {Promise<{ scope: string, calls: number, files: number, findings: number, scans: number, workspaces: number }>}
   */
  async function reset({ scope = 'all', workspace = undefined, days = undefined } = {}) {
    if (scope !== 'all' && scope !== 'scans' && scope !== 'workspace' && scope !== 'window') {
      throw new TypeError(`reset: unknown scope ${JSON.stringify(scope)}; pass 'all', 'scans', 'workspace' or 'window'.`)
    }
    if (scope === 'workspace' && (typeof workspace !== 'string' || workspace === '')) {
      throw new TypeError("reset: scope 'workspace' needs a workspace id.")
    }
    const period = scope === 'window' ? Math.floor(toCount(days)) : 0
    if (scope === 'window' && period < 1) {
      throw new TypeError("reset: scope 'window' needs a whole number of days, at least 1.")
    }

    const current = await ensure()
    const now = clock()
    if (scope === 'all') {
      const tally = { scope, calls: 0, files: 0, findings: 0, scans: 0, workspaces: 0 }
      for (const row of Object.values(current.byDay)) {
        tally.calls += toCount(row.calls)
        tally.files += toCount(row.files)
        tally.findings += toCount(row.findings)
      }
      for (const bucket of Object.values(current.workspaces)) {
        tally.scans += bucket.scanHistory.length
        tally.workspaces += 1
      }
      state = emptyState(now)
      loading = Promise.resolve(state)
      await flush()
      return tally
    }

    const tally = eraseCounters(current, now, scope, workspace, period)
    state = current
    loading = Promise.resolve(state)
    await flush()
    return tally
  }

  /** Persist the current document; a failed write is the caller's to ignore. */
  async function flush() {
    const current = await ensure()
    prune(current, clock())
    await store.save(current)
  }

  return { record, snapshot, reset, flush }
}
