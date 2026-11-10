import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { RULES } from '../lib/scan-rules.js'
import { collectGuideHashes, compareHashes, serializeEntries } from '../scripts/hash-guides.mjs'

const HASH_PATH = join(import.meta.dirname, 'scan-guide-hashes.json')
const HASH_FILE = 'test/scan-guide-hashes.json'
const REGENERATE = 'node scripts/hash-guides.mjs'
const PARITY = 'docs/notes/legacy-scan-parity.md §7'

/**
 * The sentence CI must print when a guide moved under a rule. It is an instruction, not a status
 * line: the rule's `message` describes advice the guide no longer gives, and only a human re-reading
 * both can decide what the rule should say now.
 */
function drift(ruleId, guideId) {
  return (
    `the guide behind ${ruleId} (guide id: ${guideId}) changed — re-read that rule's message against the guide, ` +
    `then regenerate with \`${REGENERATE}\`; see ${PARITY}`
  )
}

/** The committed guard file, parsed. */
async function readRecorded() {
  let raw
  try {
    raw = await readFile(HASH_PATH, 'utf8')
  } catch (cause) {
    throw new Error(`${HASH_FILE} is missing — generate it with \`${REGENERATE}\` (see ${PARITY})`, { cause })
  }
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new Error(`${HASH_FILE} is not valid JSON — regenerate it with \`${REGENERATE}\` (see ${PARITY})`, { cause })
  }
}

test('the guard lists exactly one entry per rule, sorted by rule id, and nothing else', async () => {
  const recorded = await readRecorded()
  const ids = Object.keys(recorded)

  assert.deepEqual(ids, [...ids].sort(), `${HASH_FILE} must be sorted by rule id — regenerate with \`${REGENERATE}\``)
  assert.deepEqual(
    ids,
    RULES.map((rule) => String(rule.id)).sort(),
    `${HASH_FILE} lists ${ids.length} rule(s) but lib/scan-rules.js has ${RULES.length} — regenerate with \`${REGENERATE}\` (see ${PARITY})`,
  )
  assert.equal(
    ids.length,
    RULES.length,
    `the entry count ${ids.length} must equal RULES.length ${RULES.length} — regenerate with \`${REGENERATE}\``,
  )

  for (const [ruleId, entry] of Object.entries(recorded)) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['guide', 'sha256'],
      `${ruleId} must hold exactly \`guide\` and \`sha256\` (no timestamps, nothing else) — regenerate with \`${REGENERATE}\``,
    )
    assert.equal(typeof entry.guide, 'string', `${ruleId}: guide must be a string`)
    assert.match(
      entry.sha256,
      /^[0-9a-f]{64}$/,
      `${ruleId}: sha256 must be 64 lowercase hex characters — regenerate with \`${REGENERATE}\``,
    )
  }
})

test("every rule's guide still has the body the guard recorded", async () => {
  const recorded = await readRecorded()
  const { entries } = await collectGuideHashes()

  for (const rule of RULES) {
    const ruleId = String(rule.id)
    const have = recorded[ruleId]
    assert.ok(
      have !== null && have !== undefined,
      `rule ${ruleId} has no recorded guide hash — regenerate with \`${REGENERATE}\` (see ${PARITY})`,
    )
    assert.equal(
      have.guide,
      rule.guideId,
      `rule ${ruleId} now points at guide "${rule.guideId}" but the guard records "${have.guide}" — ` +
        `re-read that rule's message against the guide, then regenerate with \`${REGENERATE}\`; see ${PARITY}`,
    )
    assert.equal(have.sha256, entries[ruleId].sha256, drift(ruleId, rule.guideId))
  }
})

test('the guard reports no drift, and the committed file is exactly what the script writes', async () => {
  const recorded = await readRecorded()
  const { entries, guides } = await collectGuideHashes()

  assert.deepEqual(compareHashes(entries, recorded), [], 'the committed hashes must match the current corpus')
  assert.equal(guides, new Set(RULES.map((rule) => rule.guideId)).size, 'each rule must hash the guide it names')

  const raw = await readFile(HASH_PATH, 'utf8')
  assert.equal(
    raw,
    serializeEntries(entries),
    `${HASH_FILE} is not byte-identical to the script's own output — key order, indentation or a timestamp drifted; ` +
      `regenerate with \`${REGENERATE}\` (see ${PARITY})`,
  )
  assert.equal(raw.includes('generatedAt'), false, 'the guard file carries no timestamps, so regenerating it is a no-op')
})

test('the guard goes red when a guide hash is mutated in memory', async () => {
  const { entries } = await collectGuideHashes()
  const target = RULES[Math.floor(RULES.length / 2)]
  const targetId = String(target.id)

  // A plausible wrong hash: flip one hex digit of the real value, so the guard cannot pass by merely
  // noticing that the string looks malformed.
  const mutated = structuredClone(entries)
  const real = mutated[targetId].sha256
  mutated[targetId].sha256 = `${real[0] === '0' ? '1' : '0'}${real.slice(1)}`
  assert.notEqual(mutated[targetId].sha256, real)

  const problems = compareHashes(entries, mutated)
  assert.equal(
    problems.length,
    1,
    `mutating one hash must produce exactly one problem, got ${problems.length}: ${problems.join(' | ')}`,
  )
  assert.equal(problems[0], drift(targetId, target.guideId))
  assert.match(problems[0], new RegExp(`the guide behind ${targetId}`))
  assert.match(problems[0], /re-read that rule's message against the guide/)
  assert.match(problems[0], /node scripts\/hash-guides\.mjs/)
  assert.match(problems[0], /docs\/notes\/legacy-scan-parity\.md §7/)

  // The control: an unmutated map reports nothing, so the red above came from the mutation alone.
  assert.deepEqual(compareHashes(entries, entries), [])
})

test('a rule pointed at a different guide is reported, not silently accepted', async () => {
  const { entries } = await collectGuideHashes()
  const targetId = String(RULES[0].id)

  const mutated = structuredClone(entries)
  mutated[targetId].guide = 'some-other-guide'

  const problems = compareHashes(entries, mutated)
  assert.equal(problems.length, 1)
  assert.equal(
    problems[0],
    `rule ${targetId} now points at guide "${RULES[0].guideId}" but the hash file records "some-other-guide" — ` +
      `re-read that rule's message against the guide, then regenerate with \`${REGENERATE}\`; see ${PARITY}`,
  )
})

test('a missing entry, an orphan entry and an unreadable map are each reported', async () => {
  const { entries } = await collectGuideHashes()

  const missing = structuredClone(entries)
  const droppedId = String(RULES[RULES.length - 1].id)
  delete missing[droppedId]
  const missingProblems = compareHashes(entries, missing)
  assert.equal(missingProblems.length, 1)
  assert.match(missingProblems[0], new RegExp(`rule ${droppedId} has no recorded guide hash`))
  assert.match(missingProblems[0], new RegExp(REGENERATE))

  const orphaned = structuredClone(entries)
  orphaned['ls-99'] = { guide: 'ghost', sha256: '0'.repeat(64) }
  const orphanProblems = compareHashes(entries, orphaned)
  assert.equal(orphanProblems.length, 1)
  assert.match(orphanProblems[0], /the hash file lists ls-99, which is not a rule any more/)

  const unreadable = compareHashes(entries, undefined)
  assert.equal(unreadable.length, 1)
  assert.match(unreadable[0], /does not hold a JSON object/)
})
