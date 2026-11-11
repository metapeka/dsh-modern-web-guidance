/**
 * Site identity: what `siteId` hashes, and what `classifyCall` refuses to hash.
 *
 * A site is the unit the "did the fix land" comparison speaks about, so these tests pin the two
 * properties the comparison depends on: a line is not part of the id (inserting one changes nothing)
 * and a changed snippet is a different site (editing the code is not the same site staying open).
 * They also pin what never leaves the function: the path and the snippet are inputs, not members.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyCall, siteId } from '../lib/telemetry.js'

/** One finding as `lib/scan.js` reports it: the first hit's snippet, plus the file it is in. */
const hit = (path, ruleId, snippet = '::-webkit-scrollbar') => ({
  path,
  ruleId,
  guideId: 'customize-scrollbar',
  snippet,
})

/** A completed scan classified exactly the way `index.js` classifies a real tool result. */
function classifyScan(findings, { files = 1, truncated = false } = {}) {
  return classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { cwd: '/work/app', scanned: { files }, findings, truncated },
  })
}

test('a site id is the frozen eight-hex hash of path, rule id and snippet', () => {
  // Golden: the key algorithm is stored in state, so changing it would orphan every baseline.
  assert.equal(siteId('src/app.css', 'ls-13', '::-webkit-scrollbar'), '96cb61de')
  assert.match(siteId('', '', ''), /^[0-9a-f]{8}$/)
  assert.equal(siteId('src/app.css', 'ls-13', '::-webkit-scrollbar'), siteId('src/app.css', 'ls-13', '::-webkit-scrollbar'))
})

test('the id ignores the line and changes when the code does', () => {
  const key = siteId('src/app.css', 'ls-13', '::-webkit-scrollbar')

  // There is no line argument at all: re-running a scan after an insertion yields the same key.
  assert.equal(siteId('src/app.css', 'ls-13', '::-webkit-scrollbar'), key)

  // A one-character code change is a different site: that is the "you edited it" edge, and it must
  // read as a resolved site plus a new one rather than as a fix.
  assert.notEqual(siteId('src/app.css', 'ls-13', '::-webkit-scrollbar {'), key)

  // The same snippet in another file, or under another rule, is not the same site either.
  assert.notEqual(siteId('src/other.css', 'ls-13', '::-webkit-scrollbar'), key)
  assert.notEqual(siteId('src/app.css', 'ls-02', '::-webkit-scrollbar'), key)
})

test('classifyCall hashes every finding into its rule, deduplicated and sorted', () => {
  const classified = classifyScan([
    hit('src/b.css', 'ls-13'),
    hit('src/a.css', 'ls-13'),
    hit('src/a.css', 'ls-02'),
    // The same path, rule and snippet twice is one site, not two.
    hit('src/b.css', 'ls-13'),
  ])

  assert.equal(classified.sitesComplete, true)
  assert.deepEqual(Object.keys(classified.sites), ['ls-02', 'ls-13'])
  assert.deepEqual(classified.sites['ls-13'], [
    siteId('src/a.css', 'ls-13', '::-webkit-scrollbar'),
    siteId('src/b.css', 'ls-13', '::-webkit-scrollbar'),
  ])
  assert.deepEqual(classified.sites['ls-02'], [siteId('src/a.css', 'ls-02', '::-webkit-scrollbar')])
})

test('only the hash leaves classifyCall, never the path and never the snippet', () => {
  const classified = classifyScan([hit('src/secret/premium.css', 'ls-13', 'PROPRIETARY-CODE-HERE')])
  const serialized = JSON.stringify(classified)

  assert.equal(serialized.includes('src/secret'), false)
  assert.equal(serialized.includes('premium'), false)
  assert.equal(serialized.includes('PROPRIETARY'), false)
  assert.match(classified.sites['ls-13'][0], /^[0-9a-f]{8}$/)
  // The workspace path is a different thing and does travel: it names the bucket, not the finding.
  assert.equal(classified.workspacePath, '/work/app')
})

test('a finding without a path, rule id or snippet makes the map incomplete', () => {
  const broken = [
    { ruleId: 'ls-13', snippet: 'x' },
    { path: 'src/a.css', snippet: 'x' },
    { path: 'src/a.css', ruleId: 'ls-13' },
    { path: 'src/a.css', ruleId: 'ls-13', snippet: '' },
  ]
  for (const missing of broken) {
    const classified = classifyScan([hit('src/b.css', 'ls-02'), missing])
    assert.equal(classified.sitesComplete, false, JSON.stringify(missing))
    // The usable finding is still hashed; the other one is absent on purpose, hence incomplete.
    assert.deepEqual(Object.keys(classified.sites), ['ls-02'])
  }

  // A scan that found nothing has nothing missing, so its empty map is complete.
  const clean = classifyScan([])
  assert.deepEqual(clean.sites, {})
  assert.equal(clean.sitesComplete, true)
})

test('a refusal has no sites and can testify about nothing', () => {
  const refused = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { error: 'path-outside', subject: '../outside', message: 'outside the workspace' },
  })
  assert.deepEqual(refused.sites, {})
  assert.equal(refused.sitesComplete, false)

  const hostError = classifyCall({ tool: 'web_guidance_legacy_scan', isError: true })
  assert.equal(hostError.sitesComplete, false)
})

test('the site map stops at the scanner cap and says that it did', () => {
  const findings = []
  for (let index = 0; index < 250; index += 1) findings.push(hit(`src/f${index}.css`, 'ls-13', `snippet ${index}`))

  const classified = classifyScan(findings, { files: 250 })
  const total = Object.values(classified.sites).reduce((sum, keys) => sum + keys.length, 0)

  assert.equal(total, 200)
  assert.equal(classified.sitesComplete, false)
})
