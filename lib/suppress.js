/**
 * The suppression file: one JSON document at `<workspace>/.suppress` that records a person's decision
 * to mute one code site.
 *
 * The grammar lives here, and only here, because three callers must agree on it: the scanner reads the
 * file with {@link parseSuppressions}, the confirmed write command validates with the same functions,
 * and the review/removal pair below joins and edits exactly what that parser honoured.
 * `docs/notes/suppression-contract.md` is the interface; this module is the pure half of it — no
 * filesystem, no clock and no environment.
 *
 * The file is exactly this, and nothing more:
 *
 *   {
 *     "version": 1,
 *     "entries": {
 *       "96cb61de": {
 *         "reason": "legacy demo page, tracked in #412 and kept until the redesign lands",
 *         "at": "2026-11-11"
 *       }
 *     }
 *   }
 *
 * The key is `siteId(path, ruleId, snippet)` (`lib/site.js`): the only matcher, and the only thing a
 * suppression may name. The reason and the date are commentary — they make the file reviewable, and
 * they never enter a report. An entry never carries a path, a snippet or a line number, because a
 * policy file is not a second copy of the evidence.
 *
 * The reader is forgiving in exactly one direction: a broken file costs suppressions, never a scan
 * and never a hidden finding. A bad entry is one entry — "ignore it, keep the good ones" — while a
 * file-level failure (unparsable, a version this reader does not know, no `entries` object) can mute
 * nothing, because there is no entry to trust. Nothing is ever repaired or guessed: the reader never
 * rewrites, and the writer refuses to rewrite a file it could not parse.
 *
 * The writer is strict and canonical: `version` first, `entries` sorted by key, two-space JSON and a
 * trailing newline, so a failed write can leave the original byte-identical and a diff is one line.
 * Unknown members survive a scan and are lost on the next write; that is safe because a format change
 * must bump `version`, and the writer refuses a version it does not know instead of rewriting it.
 *
 * A removal is the one edit that is not a rewrite: {@link removeSuppression} cuts the bytes of one
 * member out of the text it was given, so every other byte — the order, an unknown member, a
 * malformed entry the parser dropped, a hand-written comment in some later format — is preserved
 * exactly. The cut is verified by parsing the result with {@link parseSuppressions} before the caller
 * is allowed to write it, and a result that does not re-parse to the same set minus one entry, with
 * the same problems, is refused rather than written.
 */

import { SITE_KEY } from './site.js'

/** The one file, at the workspace root. A fabricated name would be a second write path. */
export const SUPPRESS_FILE = '.suppress'

/** The only format this product reads or writes; any other value mutes nothing and says `version`. */
export const SUPPRESS_VERSION = 1

/**
 * At most this many entries are writable. It equals the scanner's `maxFindings`, so one scan can
 * never display more muted sites than it can display findings. The reader has no entry cap — a
 * hand-edited list longer than this still mutes in full, because silently unmuting what is on disk
 * would be the one failure the reader must never cause.
 */
export const MAX_SUPPRESSIONS = 200

/** A reason is one line of at most this many characters: a review note, not a design document. */
export const MAX_REASON_CHARS = 200

/** The reader's only size guard, checked before the read: a file past this mutes nothing. */
export const MAX_SUPPRESS_BYTES = 256 * 1024

/** At most this many problems come back: a corrupt file must not flood a report. */
export const MAX_SUPPRESS_PROBLEMS = 20

/** An invalid key is echoed back clipped: the file may be 256 KiB, and a report is not its mirror. */
const MAX_PROBLEM_KEY_CHARS = 64

/** Plain object test, local so this module has no dependency but the site identity. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Is this a site key — eight lowercase hex characters and nothing else?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSiteKey(value) {
  return typeof value === 'string' && SITE_KEY.test(value)
}

/** The key as a problem row may quote it, clipped so a corrupt file cannot echo its own size. */
function problemKey(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length <= MAX_PROBLEM_KEY_CHARS ? text : `${text.slice(0, MAX_PROBLEM_KEY_CHARS - 1)}…`
}

/** One entry's advisory members, rebuilt: an unusable member reads as `''`, never as an error. */
function entryOf(value) {
  return {
    reason: typeof value.reason === 'string' ? value.reason.trim() : '',
    at: typeof value.at === 'string' ? value.at : '',
  }
}

/**
 * Parse `.suppress` text into the entries it honours and the problems it found.
 *
 * The problem list is capped at {@link MAX_SUPPRESS_PROBLEMS} and never touches a scan's skip
 * counters. A file-level failure is a single problem with `key: null`; an entry-level one names the
 * key it dropped. A leading BOM is stripped, like the ignore file's text, and the parse is total:
 * nothing here throws on any input.
 *
 * @param {unknown} text the file's contents, already decoded
 * @returns {{ entries: Map<string, { reason: string, at: string }>, problems: { key: string | null, reason: string }[] }}
 */
export function parseSuppressions(text) {
  const problems = []
  const entries = new Map()
  const record = (key, reason) => {
    if (problems.length < MAX_SUPPRESS_PROBLEMS) problems.push({ key, reason })
  }

  let source = typeof text === 'string' ? text : ''
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)

  let document
  try {
    document = JSON.parse(source)
  } catch {
    record(null, 'malformed')
    return { entries, problems }
  }
  if (!isPlainObject(document)) {
    record(null, 'malformed')
    return { entries, problems }
  }
  // The version is checked before the entries: a document from a future format is not this reader's
  // to interpret, and guessing at its shape is the "repair" the write surface forbids.
  if (document.version !== SUPPRESS_VERSION) {
    record(null, 'version')
    return { entries, problems }
  }
  if (!isPlainObject(document.entries)) {
    record(null, 'malformed')
    return { entries, problems }
  }

  for (const [key, value] of Object.entries(document.entries)) {
    if (!isSiteKey(key)) {
      record(problemKey(key), 'invalid')
      continue
    }
    if (!isPlainObject(value)) {
      record(key, 'invalid')
      continue
    }
    // A valid key with a blank member still mutes: the identity is the decision, the prose is the
    // note. The reader never rejects on reason length — that cap belongs to the writer.
    entries.set(key, entryOf(value))
  }
  return { entries, problems }
}

/**
 * Clamp a reason to what the writer may store: one line, at most {@link MAX_REASON_CHARS}
 * characters.
 *
 * Called when the entry is composed — before the plan is shown — so the confirmed entry is the
 * stored one and nothing is shortened behind the user's back. Newlines become spaces rather than
 * being dropped, so a pasted paragraph stays readable as a summary instead of losing its words.
 *
 * @param {unknown} text what the person typed
 * @param {number} [max] the cap, overridable only downward by a caller that wants tighter output
 * @returns {string}
 */
export function clampReason(text, max = MAX_REASON_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const limit = Math.max(1, Math.floor(max))
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

/**
 * Serialise entries into the file's exact bytes: two-space JSON, `version` first, keys sorted, one
 * trailing newline.
 *
 * This is the writer's only serialiser, and it refuses nothing: validation and the caps happen before
 * the plan, so what reaches here is already writable. Entry members are rebuilt in their documented
 * order, which is what makes "a failed write leaves the file byte-identical" checkable and drops any
 * member an older or hand-edited file carried.
 *
 * @param {Map<string, { reason: string, at: string }> | Record<string, { reason: string, at: string }>} entries
 * @returns {string} the file's contents, never empty
 */
export function serializeSuppressions(entries) {
  const source = entries instanceof Map ? entries : new Map(Object.entries(entries ?? {}))
  const sorted = [...source.entries()].sort(([left], [right]) => {
    if (left === right) return 0
    return left < right ? -1 : 1
  })
  const document = {
    version: SUPPRESS_VERSION,
    entries: Object.fromEntries(sorted.map(([key, entry]) => [key, entryOf(entry ?? {})])),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * The review: join the entries a file honours against the sites one scan produced.
 *
 * `matching` counts entries whose site this scan saw; `unused` lists the rest — and is `null`, never
 * `[]`, when the scan cannot prove absence. `[]` is the claim "every entry still matches", and only a
 * complete scan may make it: a truncated scan, a scan that read no files, a scan that read fewer files
 * than its predecessor or one whose findings carried no identity all say *unknown*. The caller decides
 * that (`complete`), because only it knows what the scan was told to walk.
 *
 * A malformed entry is not here at all: {@link parseSuppressions} reports it as a problem and never as
 * an entry, so no review can call it unused. Ids are returned sorted, so the same file and the same
 * scan always print the same list.
 *
 * @param {Map<string, unknown> | Record<string, unknown>} entries the entries the file honours.
 * @param {Set<string> | string[] | Record<string, string[]>} seen the site ids this scan produced, as a
 *   set, an array, or the `sites` map `classifyCall` builds (rule id to site ids).
 * @param {{ complete?: boolean }} [options] `complete: false` when the scan cannot prove absence.
 * @returns {{ entries: number, matching: number, unused: string[] | null }}
 */
export function reviewSuppressions(entries, seen, { complete = true } = {}) {
  const keys = entries instanceof Map ? [...entries.keys()] : Object.keys(entries ?? {})
  const found = new Set()
  if (seen instanceof Set) {
    for (const key of seen) if (typeof key === 'string') found.add(key)
  } else if (Array.isArray(seen)) {
    for (const key of seen) if (typeof key === 'string') found.add(key)
  } else if (isPlainObject(seen)) {
    for (const list of Object.values(seen)) {
      if (!Array.isArray(list)) continue
      for (const key of list) if (typeof key === 'string') found.add(key)
    }
  }
  const unused = []
  let matching = 0
  for (const key of keys.sort()) {
    if (found.has(key)) matching += 1
    else unused.push(key)
  }
  return { entries: keys.length, matching, unused: complete ? unused : null }
}

/** Whitespace as JSON defines it, so a cut never eats a byte that mattered. */
function skipSpace(source, index) {
  let at = index
  while (at < source.length) {
    const char = source[at]
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break
    at += 1
  }
  return at
}

/**
 * The index just past the string literal that starts at `index`, or -1 when there is none.
 * Escape-aware, because a reason is prose and may hold anything JSON allows.
 */
function stringEnd(source, index) {
  if (source[index] !== '"') return -1
  let at = index + 1
  while (at < source.length) {
    const char = source[at]
    if (char === '\\') {
      at += 2
      continue
    }
    if (char === '"') return at + 1
    at += 1
  }
  return -1
}

/** The index just past the JSON value that starts at `index`, or -1 when the text is not a value. */
function valueEnd(source, index) {
  const start = skipSpace(source, index)
  const char = source[start]
  if (char === '"') return stringEnd(source, start)
  if (char === '{' || char === '[') {
    let depth = 0
    let at = start
    while (at < source.length) {
      const current = source[at]
      if (current === '"') {
        const end = stringEnd(source, at)
        if (end < 0) return -1
        at = end
        continue
      }
      if (current === '{' || current === '[') depth += 1
      else if (current === '}' || current === ']') {
        depth -= 1
        if (depth === 0) return at + 1
      }
      at += 1
    }
    return -1
  }
  let at = start
  while (at < source.length && !',}] \t\n\r'.includes(source[at])) at += 1
  return at > start ? at : -1
}

/**
 * The members of the object whose `{` is at `open`, with the byte span of each.
 *
 * Deliberately a scanner and not `JSON.parse`: a removal has to know where a member *is* in the text
 * it came from, because the file is edited by cutting those bytes rather than by writing a new
 * document from a parsed model. `prevComma`/`commaAfter` are what let the cut take the separator with
 * the member, so the result stays valid JSON without reformatting anything else.
 *
 * @returns {{ members: { key: string, start: number, end: number, prevComma: number, commaAfter: number }[], close: number } | null}
 */
function objectMembers(source, open) {
  const members = []
  let index = open + 1
  let prevComma = -1
  while (index < source.length) {
    index = skipSpace(source, index)
    if (source[index] === '}') return { members, close: index }
    const keyStart = index
    const keyEnd = stringEnd(source, keyStart)
    if (keyEnd < 0) return null
    let key
    try {
      key = JSON.parse(source.slice(keyStart, keyEnd))
    } catch {
      return null
    }
    if (typeof key !== 'string') return null
    index = skipSpace(source, keyEnd)
    if (source[index] !== ':') return null
    index = skipSpace(source, index + 1)
    const valueStart = index
    const end = valueEnd(source, valueStart)
    if (end < 0) return null
    index = skipSpace(source, end)
    let commaAfter = -1
    if (source[index] === ',') {
      commaAfter = index
      index += 1
    } else if (source[index] !== '}') {
      return null
    }
    members.push({ key, start: keyStart, valueStart, end, prevComma, commaAfter })
    prevComma = commaAfter
  }
  return null
}

/** Where the bytes of one `entries` member start and stop, separator included, or null. */
function memberCut(source, siteId) {
  const root = skipSpace(source, 0)
  if (source[root] !== '{') return null
  const top = objectMembers(source, root)
  if (top === null) return null
  const entriesMember = top.members.find((member) => member.key === 'entries')
  if (entriesMember === undefined) return null
  const open = entriesMember.valueStart
  if (source[open] !== '{') return null
  const table = objectMembers(source, open)
  if (table === null) return null
  const at = table.members.findIndex((member) => member.key === siteId)
  if (at < 0) return null
  const member = table.members[at]
  // The separator goes with the member exactly once: the comma that precedes it when there is one
  // (which leaves the comma after it as the next member's separator), and otherwise the one that
  // follows, with the object's opening whitespace. The only member takes the object's interior with
  // it, which leaves `{}`.
  if (member.prevComma >= 0) return { start: member.prevComma, end: member.end }
  if (member.commaAfter >= 0) return { start: open + 1, end: member.commaAfter + 1 }
  return { start: open + 1, end: table.close }
}

/**
 * Remove exactly one entry by cutting it out of the text, or say why not.
 *
 * The three answers are the contract's, and the caller reports each as itself:
 *
 * - `{ kind: 'removed', text, entry }` — the new file contents, with every byte outside one member
 *   preserved: order, unknown members, hand formatting and entries the parser dropped all survive.
 * - `{ kind: 'absent' }` — the entry is not in the file. Not an error: a removal naming something
 *   already gone wrote nothing, and saying so is the honest report.
 * - `{ kind: 'refused', code }` — nothing may be written. `code` is a file-level problem's token when
 *   the file cannot be read at all, or `unwritable` when the cut did not survive its own re-parse: the
 *   result is parsed with {@link parseSuppressions} and must equal the old set minus exactly this
 *   entry, with the old problem list unchanged. A mismatch means the cut touched a byte it did not
 *   own, and the original is then the only thing still worth having.
 *
 * @param {unknown} text the file's contents, already decoded.
 * @param {string} siteId the entry to remove.
 * @returns {{ kind: 'removed', text: string, entry: { reason: string, at: string } } | { kind: 'absent' } | { kind: 'refused', code: string }}
 */
export function removeSuppression(text, siteId) {
  const source = typeof text === 'string' ? text : ''
  const parsed = parseSuppressions(source)
  const fatal = parsed.problems.find((problem) => problem.key === null)
  if (fatal !== undefined) return { kind: 'refused', code: fatal.reason }
  if (!parsed.entries.has(siteId)) return { kind: 'absent' }
  const entry = parsed.entries.get(siteId)
  const cut = memberCut(source, siteId)
  if (cut === null) return { kind: 'refused', code: 'unwritable' }
  const next = `${source.slice(0, cut.start)}${source.slice(cut.end)}`
  const after = parseSuppressions(next)
  const sameProblems = after.problems.length === parsed.problems.length
    && after.problems.every((problem, index) => problem.key === parsed.problems[index].key
      && problem.reason === parsed.problems[index].reason)
  const sameEntries = after.entries.size === parsed.entries.size - 1
    && !after.entries.has(siteId)
    && [...parsed.entries.keys()].every((key) => key === siteId
      || (after.entries.has(key)
        && after.entries.get(key).reason === parsed.entries.get(key).reason
        && after.entries.get(key).at === parsed.entries.get(key).at))
  if (!sameProblems || !sameEntries) return { kind: 'refused', code: 'unwritable' }
  return { kind: 'removed', text: next, entry }
}
