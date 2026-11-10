#!/usr/bin/env node
/**
 * Regenerate, or check, `test/scan-guide-hashes.json` — the guide-hash guard for the rule table.
 *
 * A rule's `message` describes what the guide recommends *instead of* the marker it detects, but
 * nothing structural ties the two together: a corpus refresh can leave a message describing advice
 * Google has since changed and no test goes red. This script pins the sha256 of the guide body
 * behind every rule; `test/scan-guides.test.mjs` compares that file with the current corpus, so a
 * changed guide fails the suite with the rule id and what to re-read. Upstream solves the same
 * problem with a per-rule `guideHash`; this is the static, zero-runtime-cost equivalent.
 *
 * Dev-only: `scripts/` and `test/` are outside package.json `files`, so neither this script nor the
 * hash file ships in the tarball. Zero dependencies — node:fs/promises, node:crypto, node:path.
 *
 * Usage:
 *   node scripts/hash-guides.mjs            # rewrite test/scan-guide-hashes.json
 *   node scripts/hash-guides.mjs --check    # write nothing; exit 1 when the recorded hashes drift
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULES } from '../lib/scan-rules.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_PATH = join(ROOT, 'data', 'guides.json')
const HASH_PATH = join(ROOT, 'test', 'scan-guide-hashes.json')
const PARITY_NOTE = 'docs/notes/legacy-scan-parity.md §7'
const REGENERATE = 'node scripts/hash-guides.mjs'

/** Repo-relative, forward-slashed path: messages stay portable and never leak the install location. */
function shown(absolute) {
  return relative(ROOT, absolute).split(sep).join('/')
}

/** guide id → category, from the same catalog `lib/guidance.js` reads. */
async function readCatalog() {
  let entries
  try {
    entries = JSON.parse(await readFile(CATALOG_PATH, 'utf8'))
  } catch (cause) {
    throw new Error(`the bundled catalog ${shown(CATALOG_PATH)} could not be read or parsed`, { cause })
  }
  if (!Array.isArray(entries)) throw new Error(`${shown(CATALOG_PATH)} is not a JSON array`)
  const categoryOf = new Map()
  for (const entry of entries) {
    if (typeof entry?.id === 'string' && typeof entry?.category === 'string') {
      categoryOf.set(entry.id, entry.category)
    }
  }
  return categoryOf
}

/** Keys in rule-id order, so the file has one stable shape and regenerating it is idempotent. */
function sortedById(entries) {
  const sorted = {}
  for (const ruleId of Object.keys(entries).sort()) sorted[ruleId] = entries[ruleId]
  return sorted
}

/**
 * The sha256 of the markdown body behind every rule.
 *
 * The guide file is resolved the way `lib/guidance.js` does: the catalog gives the category, and the
 * body lives at `data/guides/<category>/<guideId>.md`. Bytes are hashed as read — no newline
 * normalisation — so a checkout with different line endings shows up instead of hiding.
 *
 * @param {{ rules?: readonly { id: string, guideId: string | null }[] }} [options]
 * @returns {Promise<{ entries: Record<string, { guide: string, sha256: string }>, guides: number }>}
 */
export async function collectGuideHashes({ rules = RULES } = {}) {
  const categoryOf = await readCatalog()
  const entries = {}
  const seen = new Set()

  for (const rule of rules) {
    const ruleId = String(rule?.id)
    const guideId = rule?.guideId
    if (typeof guideId !== 'string' || guideId === '') {
      throw new Error(
        `rule ${ruleId} has no guideId, so there is no guide body to hash: a rule without a guide cannot be guarded. ` +
          'Give it a guideId in lib/scan-rules.js, or drop the rule.',
      )
    }
    const category = categoryOf.get(guideId)
    if (category === undefined) {
      throw new Error(`rule ${ruleId} points at guide "${guideId}", which is not in ${shown(CATALOG_PATH)}`)
    }
    const absolute = join(ROOT, 'data', 'guides', category, `${guideId}.md`)
    let bytes
    try {
      bytes = await readFile(absolute)
    } catch (cause) {
      throw new Error(`rule ${ruleId} points at guide "${guideId}", but ${shown(absolute)} could not be read`, { cause })
    }
    entries[ruleId] = { guide: guideId, sha256: createHash('sha256').update(bytes).digest('hex') }
    seen.add(guideId)
  }

  return { entries: sortedById(entries), guides: seen.size }
}

/**
 * The exact bytes `test/scan-guide-hashes.json` should hold: two-space JSON, one entry per rule,
 * keys in rule-id order, a trailing newline and no timestamps — so a second run is a no-op and a
 * diff means a guide really moved.
 *
 * @param {Record<string, { guide: string, sha256: string }>} entries
 * @returns {string}
 */
export function serializeEntries(entries) {
  return `${JSON.stringify(sortedById(entries), null, 2)}\n`
}

/**
 * Compare freshly computed hashes with what the guard file records.
 *
 * Every message is an instruction rather than a status line: it names the rule id and says what to
 * do next, because the maintainer reading CI has to re-decide whether the rule still describes the
 * guide's advice.
 *
 * @param {Record<string, { guide: string, sha256: string }>} expected hashes of the current corpus.
 * @param {unknown} recorded parsed contents of `test/scan-guide-hashes.json`.
 * @returns {string[]} empty when the guard is satisfied, otherwise one line per problem.
 */
export function compareHashes(expected, recorded) {
  if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) {
    return [`${shown(HASH_PATH)} does not hold a JSON object — regenerate it with \`${REGENERATE}\`; see ${PARITY_NOTE}`]
  }

  const problems = []
  for (const [ruleId, want] of Object.entries(expected)) {
    const have = recorded[ruleId]
    if (have === null || typeof have !== 'object') {
      problems.push(`rule ${ruleId} has no recorded guide hash — regenerate with \`${REGENERATE}\`; see ${PARITY_NOTE}`)
      continue
    }
    if (have.guide !== want.guide) {
      problems.push(
        `rule ${ruleId} now points at guide "${want.guide}" but the hash file records "${String(have.guide)}" — ` +
          `re-read that rule's message against the guide, then regenerate with \`${REGENERATE}\`; see ${PARITY_NOTE}`,
      )
      continue
    }
    if (have.sha256 !== want.sha256) {
      problems.push(
        `the guide behind ${ruleId} (guide id: ${want.guide}) changed — re-read that rule's message against the guide, ` +
          `then regenerate with \`${REGENERATE}\`; see ${PARITY_NOTE}`,
      )
    }
  }

  for (const ruleId of Object.keys(recorded).sort()) {
    if (expected[ruleId] === undefined) {
      problems.push(
        `the hash file lists ${ruleId}, which is not a rule any more — regenerate with \`${REGENERATE}\`; see ${PARITY_NOTE}`,
      )
    }
  }

  return problems
}

/** Write the file, or compare it with the corpus. Exported for the test; also the CLI body. */
async function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--check')
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: ${REGENERATE} [--check]`)
    return 2
  }
  const check = argv.includes('--check')
  const { entries, guides } = await collectGuideHashes()
  const count = Object.keys(entries).length

  if (!check) {
    const next = serializeEntries(entries)
    let current
    try {
      current = await readFile(HASH_PATH, 'utf8')
    } catch {
      current = undefined
    }
    if (current === next) {
      console.log(`${shown(HASH_PATH)} is already current: ${count} rules over ${guides} guides.`)
      return 0
    }
    await writeFile(HASH_PATH, next, 'utf8')
    console.log(`Wrote ${shown(HASH_PATH)}: ${count} rules over ${guides} guides.`)
    return 0
  }

  let raw
  try {
    raw = await readFile(HASH_PATH, 'utf8')
  } catch {
    raw = undefined
  }
  let recorded
  try {
    recorded = raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    recorded = undefined
  }

  const problems = compareHashes(entries, recorded)
  if (problems.length === 0 && raw !== serializeEntries(entries)) {
    problems.push(`${shown(HASH_PATH)} is not in the shape this script writes — regenerate with \`${REGENERATE}\`; see ${PARITY_NOTE}`)
  }
  if (problems.length === 0) {
    console.log(`${shown(HASH_PATH)} is current: ${count} rules over ${guides} guides, no drift.`)
    return 0
  }

  console.error(`${shown(HASH_PATH)} is stale — ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`- ${problem}`)
  return 1
}

// Run only when invoked as a program: `test/scan-guides.test.mjs` imports the functions above and
// must not trigger a write.
const invokedDirectly =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`hash-guides: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
