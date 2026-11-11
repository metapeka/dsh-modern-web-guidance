/**
 * The suppression file: one JSON document at `<workspace>/.suppress` that records a person's decision
 * to mute one code site.
 *
 * The grammar lives here, and only here, because two callers must agree on it: the scanner reads the
 * file with {@link parseSuppressions} and the confirmed write command validates with the same
 * functions. `docs/notes/suppression-contract.md` is the interface; this module is one half of it —
 * the pure half, with no filesystem, no clock and no environment.
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
