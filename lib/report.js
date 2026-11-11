/**
 * Text rendering for the plugin's `/guidance-stats` command.
 *
 * `lib/telemetry.js` owns the counters; this module only turns one finished snapshot into the
 * text a human reads. It is deliberately pure — no profile storage, no clock, no network, no
 * external dependencies — so the report is reproducible from its input and cheap to test.
 *
 * @module lib/report
 */

import { branchLabel } from './telemetry.js'

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

/** How many recent-scan rows the text report shows before saying how many it hid. */
const MAX_SCAN_HISTORY_SHOWN = 5

/** How many skip reasons the last-scan line names; the state document already keeps at most four. */
const MAX_SKIP_REASONS_SHOWN = 4

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
 * A date and a time (`YYYY-MM-DD HH:MM`) from an ISO timestamp, or the raw value when it is not one.
 *
 * Both halves are cut out of the stored string, so the report prints UTC — the values it is handed
 * are the ISO timestamps the counters write — and never consults the machine's clock or time zone,
 * exactly like `when()` for the date-only lines. The scan history is the one place the report needs
 * minutes: two scans of one day would otherwise read as the same scan.
 *
 * @param {unknown} value
 * @returns {string}
 */
function whenDateTime(value) {
  if (typeof value !== 'string' || value === '') return 'unknown'
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return when(value)
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`
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
 * The rule table as a `ruleId -> rule` lookup. `options.rules` is `RULES` from `lib/scan-rules.js`
 * (or any array of `{ id, guideId, confidence, message }` entries). The first entry for a repeated
 * id wins, so a malformed table cannot make one id read two ways.
 *
 * @param {unknown} rules
 * @returns {Map<string, object>}
 */
function ruleIndex(rules) {
  const index = new Map()
  if (!Array.isArray(rules)) return index
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object') continue
    if (typeof rule.id !== 'string' || rule.id === '' || index.has(rule.id)) continue
    index.set(rule.id, rule)
  }
  return index
}

/**
 * The catalog's `guideId -> description` lookup. Either shape works: the `{ id, description }`
 * entry array `data/guides.json` holds, or the plain id-to-description record `readCatalog()`
 * derives from it. An entry without a string description is skipped, so a lookup can only ever
 * yield a sentence or nothing.
 *
 * @param {unknown} guides
 * @returns {Map<string, string>}
 */
function guideIndex(guides) {
  const index = new Map()
  if (Array.isArray(guides)) {
    for (const guide of guides) {
      if (guide === null || typeof guide !== 'object') continue
      if (typeof guide.id !== 'string' || guide.id === '' || typeof guide.description !== 'string') continue
      if (!index.has(guide.id)) index.set(guide.id, guide.description)
    }
    return index
  }
  if (guides === null || typeof guides !== 'object') return index
  for (const [id, description] of Object.entries(guides)) {
    if (id !== '' && typeof description === 'string') index.set(id, description)
  }
  return index
}

/**
 * A stored day (`YYYY-MM-DD`), or null. The counters write a day per rule and the panel prints it
 * where it has one; a row without a date stays null so the consumer renders nothing rather than a
 * fabricated day (the 0.7.3 rule, applied to a date).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function scanDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * The first and last day each rule of a scan row list was seen, keyed by rule id. The counters put
 * them on the row; `scanRows()` keeps only the id and the count, so the described path reads them
 * from the raw rows it was handed. The first row for a repeated id wins, like `ruleIndex()`.
 *
 * @param {unknown} rows
 * @returns {Map<string, { firstSeen: string | null, lastSeen: string | null }>}
 */
function scanRuleDays(rows) {
  const days = new Map()
  if (!Array.isArray(rows)) return days
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = row.ruleId
    if (typeof id !== 'string' || id === '' || days.has(id)) continue
    days.set(id, { firstSeen: scanDay(row.firstSeen), lastSeen: scanDay(row.lastSeen) })
  }
  return days
}

/**
 * Scan rows plus the meaning behind each rule id: the rule's own sentence, its confidence and the
 * guide it points at. A scan counts ids, but `ls-17 121` tells a person nothing; the table already
 * writes the sentence, so this is where it reaches the JSON. An id the table does not know keeps
 * its row — the count is still true — and reads as an empty message, an empty confidence and no
 * guide, so a stale id never hides a real hit or invents one.
 *
 * The row also carries the days the counters first and last saw the rule, because "when" is half of
 * what a reader asks of a counter. They are read from the snapshot, not from the rule table: a rule
 * the table does not know still carries its dates, and one without a date reads as null.
 *
 * @param {unknown} rows
 * @param {Map<string, object>} rules
 * @returns {Array<{ ruleId: string, count: number, message: string, confidence: string, guideId: string | null, firstSeen: string | null, lastSeen: string | null }>}
 */
function describeScanRules(rows, rules) {
  const days = scanRuleDays(rows)
  return scanRows(rows, 'ruleId').map((row) => {
    const rule = rules.get(row.ruleId)
    const seen = days.get(row.ruleId) ?? { firstSeen: null, lastSeen: null }
    return {
      ruleId: row.ruleId,
      count: row.count,
      message: typeof rule?.message === 'string' ? rule.message : '',
      confidence: typeof rule?.confidence === 'string' ? rule.confidence : '',
      guideId: typeof rule?.guideId === 'string' ? rule.guideId : null,
      firstSeen: seen.firstSeen,
      lastSeen: seen.lastSeen,
    }
  })
}

/**
 * Scan rows plus the catalog's one-line description of each guide. An id the catalog does not know
 * — a guide retired between two corpus snapshots, say — keeps its row and reads as an empty
 * description, for the same reason a missing rule keeps its count.
 *
 * @param {unknown} rows
 * @param {Map<string, string>} guides
 * @returns {Array<{ guideId: string, count: number, description: string }>}
 */
function describeScanGuides(rows, guides) {
  return scanRows(rows, 'guideId').map((row) => {
    const description = guides.get(row.guideId)
    return {
      guideId: row.guideId,
      count: row.count,
      description: typeof description === 'string' ? description : '',
    }
  })
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
 * The skip reasons of the last scan, count desc then name asc, malformed rows dropped. Reason tokens
 * pass through verbatim — they are the same words `/guidance-scan` prints, never translated — and the
 * panel parses them out of the JSON, so this function must not rename them either.
 *
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function scanSkipReasons(value) {
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
      .slice(0, MAX_SKIP_REASONS_SHOWN),
  )
}

/**
 * The stored last scan, or null. Only the documented members survive: an ISO timestamp, two
 * counts, the distinct rule ids, the per-reason skip counts, the truncation flag and the optional
 * branch label. A value without a usable timestamp reads as null — the text report then says
 * nothing rather than "Last scan: unknown" — and a state file written before the skip fields simply
 * reads as "nothing was skipped". The label is validated again here, because this module is handed
 * a snapshot rather than the state document: a hand-built or edited value cannot get an unprintable
 * branch name onto a report line.
 *
 * @param {unknown} value
 * @returns {{ at: string, files: number, findings: number, rules: string[], skipped: Record<string, number>, truncated: boolean, branch?: { kind: 'branch', name: string } | { kind: 'detached', sha: string }, suppressed?: number, suppressedRules?: Record<string, number>, suppressions?: { entries: number, matching: number, unused: string[] | null }, ignoreUsage?: { patterns: number, idle: number } } | null}
 */
function normalizeLastScan(value) {
  if (value === null || typeof value !== 'object') return null
  const at = typeof value.at === 'string' ? value.at.trim() : ''
  if (at === '') return null
  const rules = Array.isArray(value.rules)
    ? [...new Set(value.rules.filter((id) => typeof id === 'string' && id !== ''))]
    : []
  const summary = {
    at,
    files: toCount(value.files),
    findings: toCount(value.findings),
    rules,
    skipped: scanSkipReasons(value.skipped),
    truncated: value.truncated === true,
  }
  const branch = branchLabel(value.branch)
  if (branch !== null) summary.branch = branch
  // The suppression count is a subset of `findings`, so it is clamped to them: a stored 300 on a
  // 12-finding scan is a broken number, not a bigger mute. A non-number is dropped and the report
  // then says nothing — a pre-C document must render exactly what it rendered before the member
  // existed, and "0 muted" is a claim this value never made.
  if (typeof value.suppressed === 'number' && Number.isFinite(value.suppressed)) {
    summary.suppressed = Math.min(summary.findings, Math.max(0, Math.floor(value.suppressed)))
    if (summary.suppressed > 0) {
      const split = suppressedRuleSplit(value.suppressedRules)
      // Each muted finding is filed under at most one rule, so the split cannot add up to more than
      // the total. A map that does is corrupt, and the line then prints the count without a split
      // rather than a breakdown that contradicts it.
      const total = split.reduce((sum, [, count]) => sum + count, 0)
      if (total > 0 && total <= summary.suppressed) summary.suppressedRules = Object.fromEntries(split)
    }
  }
  // The review of the suppression file that scan read, additive and last. This is also where the
  // panel's row will read it from, so the block is clamped here rather than trusted: three counts
  // that agree with each other, or nothing. `unused: null` — "this scan could not prove absence" —
  // is a value and survives as null; a missing member renders exactly as 0.11.0 did.
  const review = suppressionReview(value.suppressions)
  if (review !== null) summary.suppressions = review
  // What the ignore file's own lines did, as the two counts the counters keep — never the rows, which
  // name the patterns and therefore the project's layout. Absent when the file held no pattern or could
  // not be read, and absent must stay absent: rendering "0 patterns, 0 matched nothing" for a scan that
  // never saw a file would be a claim about evidence that does not exist.
  const usage = ignoreUsageCounts(value.ignoreUsage)
  if (usage !== null) summary.ignoreUsage = usage
  return summary
}

/**
 * The `.scanignore` usage summary, clamped into the two integers a report may print.
 *
 * `idle` counts patterns that matched nothing, so it can never exceed `patterns`; a pair that claims
 * otherwise is dropped whole rather than flattened to zeros, which is the same rule the review above
 * follows and the reason a hand-edited document cannot make a report say "everything is idle".
 *
 * @param {unknown} value
 * @returns {{ patterns: number, idle: number } | null}
 */
function ignoreUsageCounts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.patterns !== 'number' || !Number.isFinite(value.patterns)) return null
  if (typeof value.idle !== 'number' || !Number.isFinite(value.idle)) return null
  const patterns = Math.max(0, Math.floor(value.patterns))
  const idle = Math.max(0, Math.floor(value.idle))
  if (patterns === 0 || idle > patterns) return null
  return { patterns, idle }
}

/**
 * The review block, clamped into the one shape a report may carry.
 *
 * Mirrors the counters' own rule on purpose: the report re-validates whatever snapshot it was handed,
 * and a contradiction between the three members resolves towards the counts and away from the ids.
 * `matching` is a subset of `entries`; a complete review's `unused` list is exactly the difference.
 * Anything that cannot be made to agree is dropped whole — never flattened to zeros.
 *
 * @param {unknown} value
 * @returns {{ entries: number, matching: number, unused: string[] | null } | null}
 */
function suppressionReview(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.entries !== 'number' || !Number.isFinite(value.entries)) return null
  if (typeof value.matching !== 'number' || !Number.isFinite(value.matching)) return null
  const entries = Math.max(0, Math.floor(value.entries))
  const matching = Math.min(entries, Math.max(0, Math.floor(value.matching)))
  if (value.unused === null) return { entries, matching, unused: null }
  if (!Array.isArray(value.unused)) return null
  const unused = [...new Set(value.unused.filter((id) => typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)))]
  return { entries, matching, unused: unused.length === entries - matching ? unused.sort() : null }
}

/**
 * The one sentence about the ignore file: how many lines it holds and how many of them excluded
 * nothing.
 *
 * Both numbers always print when the block is present, so a healthy file says "0 matched nothing"
 * instead of going quiet: silent and healthy would otherwise be the same report, and the reader could
 * not tell whether the audit ran. The shape is pinned by `test/report.test.mjs`.
 *
 * @param {{ patterns: number, idle: number }} usage
 * @returns {string}
 */
function ignoreUsageLine(usage) {
  return `.scanignore: ${plural(usage.patterns, 'pattern')}, ${digits(usage.idle)} matched nothing.`
}

/**
 * The per-rule split of the muted count, as ranked `[ruleId, count]` pairs. Same rules as every other
 * per-rule map here: ids verbatim, counts positive, ranked by count then id, capped at what one report
 * line can show. A value that is not an object yields no split, and the suppressed line then prints
 * without one rather than with an empty parenthesis.
 *
 * @param {unknown} value
 * @returns {Array<[string, number]>}
 */
function suppressedRuleSplit(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
    .map(([ruleId, count]) => [ruleId, toCount(count)])
    .filter(([ruleId, count]) => ruleId !== '' && count > 0)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      if (left[0] === right[0]) return 0
      return left[0] < right[0] ? -1 : 1
    })
    .slice(0, MAX_SCAN_RULES_SHOWN)
}

/**
 * The comparison line: the latest completed scan against the one before it, as the counters proved
 * it. Two shapes, both after the last-scan line:
 *
 *   Since the scan of 2026-11-09 08:12: 3 no longer present, 82 still open, 1 new
 *   Since the scan of 2026-11-09 08:12: not comparable (fewer-files)
 *
 * "No longer present" is deliberate: the counters can prove a site was absent from one scan and
 * present in the one before, never that a fix landed, so the report never says "fixed". The block
 * reason is the counters' own token, printed raw like a skip reason. A first scan has nothing to
 * compare with and says what happens next instead. An aggregate snapshot carries no `scanDiff` at
 * all — a comparison across workspaces compares two projects — so nothing is printed there.
 *
 * @param {unknown} diff the snapshot's `scanDiff`.
 * @returns {string} the line, or an empty string when there is no comparison to print.
 */
function diffLine(diff) {
  if (diff === null || typeof diff !== 'object' || Array.isArray(diff)) return ''
  const reason = typeof diff.partial === 'string' && diff.partial !== '' ? diff.partial : ''
  if (reason === 'no-baseline') return 'No earlier scan to compare with; the next scan will be compared.'
  const since = typeof diff.against === 'string' && diff.against !== ''
    ? `Since the scan of ${whenDateTime(diff.against)}`
    : 'Since the previous scan'
  if (reason !== '') return `${since}: not comparable (${reason})`
  // A comparison that ran carries three numbers. One that does not is malformed, and printing three
  // zeros would claim a clean comparison the counters never made: print nothing, like an absent slice.
  const counts = [diff.resolved, diff.stillOpen, diff.new]
  if (!counts.every((count) => typeof count === 'number' && Number.isFinite(count))) return ''
  return `${since}: ${digits(diff.resolved)} no longer present, ${digits(diff.stillOpen)} still open, ` +
    `${digits(diff.new)} new`
}

/**
 * The per-rule counts of one history entry as ranked `[ruleId, count]` pairs, or null when the entry
 * carries no usable map. The entry's map is the scanner's own per-rule count, capped on the counters'
 * side; ids pass through verbatim, like every other rule id the report prints.
 *
 * @param {unknown} value
 * @returns {Array<[string, number]> | null}
 */
function scanRuleCounts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.entries(value)
    .map(([id, count]) => [id, toCount(count)])
    .filter(([id, count]) => id !== '' && count > 0)
    .sort(byRank)
}

/**
 * One `Recent scans` row: when, how much, which rules — and, on a merged row, whose scan it was.
 *
 *   `2026-11-10 22:27 - 70 files, 85 findings, rules 2 (ls-13 4, ls-02 2)`
 *
 * `rules N` counts the distinct ids the entry kept and the parenthetical names at most
 * `MAX_SCAN_RULES_SHOWN` of them, like every other scan list the report prints. A clean scan's empty
 * map reads as `rules 0` because that zero is real, while an entry with no usable map says nothing
 * about rules at all (the 0.7.3 rule: a missing field renders shorter, it never becomes a zero). A
 * workspace label appears only when the row carries one, which the snapshot does only when it merged
 * several buckets; the label is the footer's own `workspaceLabel()` so the two cannot read
 * differently.
 *
 * @param {object} entry one `scanHistory` row.
 * @returns {string}
 */
function historyRow(entry) {
  let row = `${whenDateTime(entry.at)} - ${plural(entry.files, 'file')}, ` +
    `${plural(entry.findings, 'finding')}`
  const rules = scanRuleCounts(entry.rules)
  if (rules !== null) {
    row += rules.length === 0
      ? ', rules 0'
      : `, rules ${digits(rules.length)} (${rules.slice(0, MAX_SCAN_RULES_SHOWN)
        .map(([id, count]) => `${id} ${digits(count)}`).join(', ')})`
  }
  const label = entry.workspace !== null && typeof entry.workspace === 'object'
    ? workspaceLabel(entry.workspace)
    : ''
  if (label !== '') row += ` [${label}]`
  return row
}

/**
 * The `Recent scans` block: the scan ring newest first, five rows at most, then how many older scans
 * the block hid. It is not a window: the ring is bounded by depth, not by `--days`, and the rows say
 * so by naming their own timestamps.
 *
 * A pre-B document has no `scanHistory` key and an unscanned workspace has an empty list, so both
 * render no block at all rather than an empty one.
 *
 * @param {unknown} history the snapshot's `scanHistory`.
 * @returns {string[]}
 */
function scanHistoryBlock(history) {
  if (!Array.isArray(history)) return []
  const rows = history.filter((entry) =>
    entry !== null && typeof entry === 'object' &&
    typeof entry.at === 'string' && entry.at.trim() !== '')
  if (rows.length === 0) return []
  const shown = rows.slice(0, MAX_SCAN_HISTORY_SHOWN)
  const hidden = rows.length - shown.length
  const title = hidden > 0
    ? `Recent scans (last ${digits(shown.length)} of ${digits(rows.length)})`
    : 'Recent scans'
  const lines = [`${title}:`]
  for (const entry of shown) lines.push(`  ${historyRow(entry)}`)
  if (hidden > 0) lines.push(`  +${digits(hidden)} earlier`)
  return lines
}

/**
 * A workspace as one line of text: `my-app (a1b2c3d4)`, or the id alone when the counters know no
 * name for it (`_unattributed`, the legacy bucket). The id is printed beside the name because
 * `--workspace` accepts it and two checkouts of one project share a directory name; the one case
 * where only the id is printed is the id-only bucket, whose name is empty by contract.
 *
 * @param {{ id?: unknown, name?: unknown }} workspace
 * @returns {string} a printable label, or an empty string for an unusable value.
 */
export function workspaceLabel(workspace) {
  const id = typeof workspace?.id === 'string' ? workspace.id : ''
  const name = typeof workspace?.name === 'string' ? workspace.name : ''
  if (id === '') return name
  // An empty name is the legacy bucket's contract, and a name that repeats the id is not worth
  // printing twice.
  if (name === '' || name === id) return id
  return `${name} (${id})`
}

/**
 * The report's workspace line: which workspace the scan figures belong to, or that every workspace
 * is counted. It is part of the footer because it says what was measured, next to the corpus and the
 * period. A snapshot that carries no `workspaces` key at all predates per-workspace counters — a
 * hand-built 0.8.x snapshot, or a caller that never opted in — and renders no line, so an older
 * report is reproduced byte for byte.
 *
 * @param {object} snapshot
 * @param {string} [note] why the aggregate was chosen, when the caller knows (a session workspace
 *   that could not be resolved); the report never guesses one.
 * @returns {string} the line, or an empty string when the snapshot says nothing about workspaces.
 */
function workspaceFooterLine(snapshot, note) {
  const selected = snapshot.workspace
  const labelled = selected !== null && typeof selected === 'object'
    && typeof selected.id === 'string' && selected.id !== ''
  if (!labelled && !('workspaces' in snapshot)) return ''
  const line = labelled ? `Workspace: ${workspaceLabel(selected)}` : 'Workspace: all workspaces'
  return typeof note === 'string' && note !== '' ? `${line} (${note})` : line
}

/**
 * Renders the chat report for one telemetry snapshot.
 *
 * Section order is fixed: KPIs, then the queries that returned nothing (the actionable part),
 * then top queries, category coverage, dead guides, and finally the workspace, corpus and period
 * lines that say what was measured. A snapshot with no calls renders the empty state instead of
 * empty tables, because a wall of zeroes hides the actual instruction: search something first.
 * When the snapshot counted legacy scans, one more KPI line reports the fourth tool's calls, files
 * read and findings raised; and when that scan data also carries per-rule counters, two more KPI
 * lines name the most matched rules and the last scan. Both are counters, not evidence: ids and
 * numbers only, never a path, a snippet or a per-file row. A snapshot without them reproduces the
 * 0.4.x report unchanged, and `lastScan: null` with scans recorded simply omits the second line.
 *
 * The scan block also answers *when*: the comparison line sits under the last-scan line when the
 * snapshot carries one, and a `Recent scans` block lists the ring between the counters and the
 * queries. Both read their data from the snapshot and neither is invented: a document written before
 * the history existed has no `scanDiff` and no `scanHistory`, so both are absent and such a snapshot
 * renders exactly as it did.
 *
 * Which workspace those scan lines describe is stated once, in the footer: `renderReport` reads it
 * from the snapshot's own `workspace`, and a snapshot that has none renders exactly as before.
 *
 * @param {object} snapshot Aggregated usage snapshot from `lib/telemetry.js`.
 * @param {{ workspaceNote?: string }} [options] the reason for aggregating, when the caller knows it
 *   — a session workspace the host did not name. Omit it for an aggregate the caller asked for.
 * @returns {string} Plain text, markdown-friendly, no colours and no emoji.
 */
export function renderReport(snapshot, options) {
  const source = snapshot ?? {}
  const corpus = source.corpus ?? {}
  const totals = source.totals ?? {}
  const periodDays = toCount(source.periodDays)
  const calls = toCount(totals.calls)
  const footer = [
    workspaceFooterLine(source, options?.workspaceNote),
    corpusLine(corpus),
    periodLine(periodDays, source.generatedAt),
  ].filter((line) => line !== '')

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
      let dated = `Last scan: ${when(lastScan.at)}, ${plural(lastScan.files, 'file')}, ` +
        `${plural(lastScan.findings, 'finding')}`
      const lastRules = lastScan.rules.slice(0, MAX_SCAN_RULES_SHOWN)
      if (lastRules.length > 0) dated += ` (rules: ${lastRules.join(', ')})`
      // The audit tails: what the walk refused and whether it hit a cap. Both are counts with the
      // scan's own reason tokens, so the line can be checked against the scan text word for word.
      const skipped = Object.entries(lastScan.skipped)
      if (skipped.length > 0) {
        const total = skipped.reduce((sum, [, count]) => sum + count, 0)
        dated += `; skipped ${digits(total)} (${skipped.map(([reason, count]) => `${digits(count)} ${reason}`).join(', ')})`
      }
      if (lastScan.truncated) dated += '; truncated'
      // The one fact on this line that is not a count: the tree the scan measured. It is appended
      // last, only when the scan carried one, so a project with no label — or a document written
      // before labels existed — keeps today's line character for character.
      if (lastScan.branch !== undefined) {
        dated += lastScan.branch.kind === 'branch'
          ? `; branch ${lastScan.branch.name}`
          : `; detached at ${lastScan.branch.sha}`
      }
      kpi.push(dated)
      // The muted count is its own line, never folded into the numbers above and never placed beside
      // the comparison's three: it counts a subset of the findings on the line above, and one scan's
      // count is not a total. "muted, still findings" says in words what the diff already guarantees —
      // a muted site stays in `stillOpen`, so a mute can never be printed as a fix. Absent for a
      // document written before the field existed, and never printed as a zero.
      if (lastScan.suppressed > 0) {
        const split = Object.entries(lastScan.suppressedRules ?? {})
          .slice(0, MAX_SCAN_RULES_SHOWN)
          .map(([ruleId, count]) => `${ruleId} ${digits(count)}`)
        kpi.push(split.length > 0
          ? `Suppressed: ${digits(lastScan.suppressed)} in the last scan (${split.join(', ')}) - muted, still findings`
          : `Suppressed: ${digits(lastScan.suppressed)} in the last scan - muted, still findings`)
      }
      // The comparison line rides immediately under the scan it describes. Both it and the block
      // below are absent for a document written before 0.10.0: the snapshot then has no `scanDiff`
      // and no `scanHistory`, so nothing is printed and the old report is reproduced byte for byte.
      const comparison = diffLine(source.scanDiff)
      if (comparison !== '') kpi.push(comparison)
      // What the ignore file's own lines did, last in the block and only when the counters kept it.
      // This is the one sentence in the product allowed to call a line of `.scanignore` idle, and it
      // never suggests an edit: the walk cannot change the file, so dropping the line stays a job for
      // the editor it was written in. `patterns` counts lines, never files — a directory pattern is
      // one line and one skip — which is why the second number can be read as "lines to look at".
      if (lastScan.ignoreUsage !== undefined) kpi.push(ignoreUsageLine(lastScan.ignoreUsage))
    }
  }

  const historyBlock = scanHistoryBlock(source.scanHistory)

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
    historyBlock,
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
 * either `{ at, files, findings, rules, skipped, truncated, branch }` or null. The names are the
 * snapshot's own and are not renamed here; the panel parses this object, so they are part of the
 * contract. `skipped` defaults to `{}`, `truncated` to `false` and `branch` to null, so a state
 * written before those fields existed still gives the panel a guard-free read.
 *
 * A caller that knows the rule table and the catalog can ask for the meaning behind the ids:
 * `renderJson(snapshot, { rules, guides })` adds `message`, `confidence` and `guideId` to every
 * `topRules` row, `description` to every `topScanGuides` row, and the top-level
 * `scanCountsScope: 'lifetime'`. That flag is ours, not the snapshot's: it says both lists are
 * lifetime totals that `periodDays` never filtered, which a reader of the JSON cannot otherwise
 * tell. `rules` is the `RULES` table from `lib/scan-rules.js` and `guides` is either the catalog's
 * entry array or its id-to-description record. Unknown ids keep their rows — the counts are still
 * true — and read as empty text (and a null guide), so a stale id never hides a real hit.
 *
 * `scanCountsSince` is the other half of that sentence, and it is passed through, not derived: the
 * snapshot decided which day the ranked counters began, because only it knows which bucket or buckets
 * produced them. It is emitted beside the scope flag and only when the snapshot carries a non-empty
 * date — an unrecorded origin stays absent, so a pre-E document prints the 0.11.0 JSON byte for byte
 * rather than a blank, a dash or an invented "today".
 *
 * Called with no options the document is the pre-enrichment one, byte for byte, flag included: an
 * older consumer that pipes this JSON must not be able to tell the enrichment exists. The
 * `/guidance-stats --json` command always passes both tables, so the command — and the panel that
 * reads it — gets the described rows.
 *
 * Per-workspace scan counters are additive the same way, and the same freeze applies: `workspace`
 * (the selection, `{ id, name }`, or null when aggregating) and `workspaces` (the switcher's rows)
 * are emitted only when the snapshot carries them. A hand-built 0.8.x snapshot has no `workspaces`
 * key, so it renders the document it always did; a snapshot from the per-workspace counters always
 * has it, which is what lets the panel tell "this counter is this project's" from "this host cannot
 * tell me".
 *
 * @param {object} snapshot Aggregated usage snapshot from `lib/telemetry.js`.
 * @param {{ rules?: unknown, guides?: unknown }} [options] the rule table and the guide descriptions;
 *   omit them to keep the frozen shape.
 * @returns {{
 *   periodDays: number,
 *   corpus: { version: string, snapshotDate: string, total: number },
 *   totals: { calls: number, hitRate: number, byTool: object, byOutcome: object, files: number, findings: number },
 *   topQueries: Array<object>,
 *   misses: Array<object>,
 *   coverage: Array<object>,
 *   deadGuides: { total: number, sample: string[] },
 *   series: Array<object>,
 *   topRules: Array<{ ruleId: string, count: number } | { ruleId: string, count: number, message: string, confidence: string, guideId: string | null }>,
 *   topScanGuides: Array<{ guideId: string, count: number } | { guideId: string, count: number, description: string }>,
 *   lastScan: { at: string, files: number, findings: number, rules: string[], skipped: Record<string, number>, truncated: boolean, branch: { kind: 'branch', name: string } | { kind: 'detached', sha: string } | null, suppressed?: number, suppressedRules?: Record<string, number>, suppressions?: { entries: number, matching: number, unused: string[] | null }, ignoreUsage?: { patterns: number, idle: number } } | null,
 *   scanCountsScope?: 'lifetime',
 *   scanCountsSince?: string,
 *   tools?: { 'legacy-scan': { total: number, files: number, findings: number } },
 *   findings?: number,
 *   workspace?: { id: string, name: string } | null,
 *   workspaces?: Array<{ id: string, name: string, findings: number, rules: number, lastScanAt: string | null }>,
 *   scanSeries?: Array<{ day: string, scans: number, files: number, findings: number }>,
 *   scanHistory?: Array<object>,
 *   scanDiff?: object | null,
 * }}
 */
export function renderJson(snapshot, options) {
  const source = snapshot ?? {}
  const withDetail = options !== undefined && options !== null
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
  // `scanCountsScope` belongs to the described document, and the flag sits above the two lists it
  // describes: it says those totals are lifetime, never filtered by `periodDays`.
  if (withDetail) json.scanCountsScope = 'lifetime'
  // The origin sits beside the flag it qualifies, and only when the document recorded one. `null`, a
  // missing key and an empty string are the same answer — no date — and all three render as 0.11.0:
  // a consumer must never see a placeholder where the counters have no provable start.
  if (withDetail && typeof source.scanCountsSince === 'string' && source.scanCountsSince !== '') {
    json.scanCountsSince = source.scanCountsSince
  }
  // The scan detail is always present, defaulted for a state that has none: a consumer can read
  // `.length` and `.at` without a guard, and a 0.4.x/0.5.0 state simply reads as "no scans yet".
  json.topRules = withDetail
    ? describeScanRules(source.topRules, ruleIndex(options.rules))
    : scanRows(source.topRules, 'ruleId')
  json.topScanGuides = withDetail
    ? describeScanGuides(source.topScanGuides, guideIndex(options.guides))
    : scanRows(source.topScanGuides, 'guideId')
  // The label is defaulted the way the rest of the scan detail is: a consumer reads `.branch`
  // without a guard, and null is this document's word for "the scan carried no label".
  const lastScan = normalizeLastScan(source.lastScan)
  json.lastScan = lastScan === null ? null : { ...lastScan, branch: lastScan.branch ?? null }
  // Additive per-workspace keys, last so the frozen document above keeps its order. They are
  // passed through as the snapshot built them: the ids and rows are the counters' own, and the panel
  // parses this object. A snapshot without the key renders exactly what it rendered before.
  if ('workspaces' in source) {
    json.workspace = source.workspace ?? null
    json.workspaces = Array.isArray(source.workspaces) ? source.workspaces : []
  }
  // The scan history keys follow the workspace keys, the same additive precedent. They are snapshot
  // data, not report enrichment, so they are passed through unchanged whenever the snapshot carries
  // them, and a snapshot that does not renders exactly the document it always did.
  if ('scanSeries' in source) {
    json.scanSeries = Array.isArray(source.scanSeries) ? source.scanSeries : []
  }
  if ('scanHistory' in source) {
    json.scanHistory = Array.isArray(source.scanHistory) ? source.scanHistory : []
  }
  if ('scanDiff' in source) {
    json.scanDiff = source.scanDiff ?? null
  }
  return json
}
