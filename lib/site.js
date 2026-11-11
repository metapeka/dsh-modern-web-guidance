/**
 * The site identity: one hash that names one code site, shared by the scanner, the counters and
 * the suppression file.
 *
 * It lives here, not in `lib/telemetry.js`, because three callers need it and only one of them may
 * touch the filesystem: `lib/scan.js` computes it for every finding it returns, the counters compute
 * it as a fallback for a hand-built value, and the suppression file matches on it. A second, almost
 * identical implementation would let "suppressed" and "still open" disagree about the same site,
 * which is the one bug this identity exists to prevent — so there is exactly one function, and
 * `lib/telemetry.js` re-exports it to keep its public API unchanged.
 *
 * Nothing in this module touches the filesystem.
 */

/**
 * FNV-1a 32-bit over a string's UTF-16 code units, as eight lowercase hex characters.
 *
 * Frozen on purpose: it keys the state document (a workspace bucket, a site baseline) and the
 * suppression file, so changing the algorithm would orphan every id already stored. Both ids this
 * product exports — `workspaceId` and `siteId` — are this hash.
 *
 * @param {string} text
 * @returns {string} eight lowercase hex characters
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Stable id for one code site: FNV-1a 32-bit over `path`, `ruleId` and `snippet`, joined with NUL.
 *
 * A site is a finding — one run of one rule's hits in one file — never a line: the line moves when
 * anything above it changes, so including it would turn an insertion into a false "resolved + new"
 * pair. Hashing the three together is what keeps two files with the same one-line snippet apart.
 * Only the hash is stored; the path and the snippet never enter the state document or the
 * suppression file, and the key cannot be printed, matched or browsed back into either.
 *
 * A collision is conservative by construction: a shared key reads as "still open", so it can hide a
 * fix but cannot invent one. A false "resolved" needs the key absent from the scan and present in the
 * baseline — the opposite of colliding.
 *
 * @param {unknown} path the workspace-relative path of the file the finding is in
 * @param {unknown} ruleId the marker rule that fired
 * @param {unknown} snippet the finding's first-hit snippet
 * @returns {string} eight lowercase hex characters
 */
export function siteId(path, ruleId, snippet) {
  return fnv1a([
    typeof path === 'string' ? path : '',
    typeof ruleId === 'string' ? ruleId : '',
    typeof snippet === 'string' ? snippet : '',
  ].join('\u0000'))
}

/** One site key: eight lowercase hex characters, and nothing else. */
export const SITE_KEY = /^[0-9a-f]{8}$/
