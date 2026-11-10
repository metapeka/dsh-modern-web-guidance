import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { RULES } from '../lib/scan-rules.js'
import { SCAN_LIMITS, ScanError, scan } from '../lib/scan.js'

const scratch = join(import.meta.dirname, '..', '.tmp')

/** Create a throwaway workspace tree from `{ 'relative/path': content }` pairs. */
async function makeWorkspace(files = {}) {
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'scan-core-'))
  for (const [name, content] of Object.entries(files)) {
    const absolute = join(root, name)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

/** Run a test body against a workspace, then remove it. */
async function withWorkspace(files, run) {
  const root = await makeWorkspace(files)
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** A marker rule with every field a real rule carries, so the scanner sees the production shape. */
const RULE_MODAL = {
  id: 'ls-test-modal',
  guideId: 'dialog',
  confidence: 'high',
  message: 'Use a native <dialog> with showModal() instead of a scripted modal class.',
  source: 'legacyModal',
}

/** Predicate helper: asserts a rejection is a ScanError with this code (and subject, when given). */
function isScanError(code, subject) {
  return (error) => {
    assert.ok(error instanceof ScanError, `expected a ScanError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code)
    if (subject !== undefined) assert.equal(error.subject, subject)
    assert.equal(typeof error.message, 'string')
    assert.ok(error.message.length > 0)
    return true
  }
}

test('SCAN_LIMITS is frozen and matches the published caps', () => {
  assert.equal(Object.isFrozen(SCAN_LIMITS), true)
  assert.deepEqual(
    {
      maxPaths: SCAN_LIMITS.maxPaths,
      maxFiles: SCAN_LIMITS.maxFiles,
      maxFileBytes: SCAN_LIMITS.maxFileBytes,
      maxTotalBytes: SCAN_LIMITS.maxTotalBytes,
      maxFindings: SCAN_LIMITS.maxFindings,
      maxSkipped: SCAN_LIMITS.maxSkipped,
      maxSnippetChars: SCAN_LIMITS.maxSnippetChars,
    },
    { maxPaths: 16, maxFiles: 200, maxFileBytes: 512 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxFindings: 200, maxSkipped: 100, maxSnippetChars: 160 },
  )
  assert.ok(SCAN_LIMITS.extensions.includes('.js'))
  assert.ok(SCAN_LIMITS.extensions.includes('.vue'))
  assert.ok(!SCAN_LIMITS.extensions.includes('.env'))
  assert.ok(SCAN_LIMITS.skipDirectories.includes('node_modules'))
  assert.ok(SCAN_LIMITS.skipDirectories.includes('.agents'))
})

test('a relative directory is walked and findings carry the contract shape', async () => {
  const line = 'const modal = legacyModal(el)\n'
  await withWorkspace({ 'src/app.js': line }, async (cwd) => {
    const result = await scan({ cwd, paths: ['src'], rules: [RULE_MODAL] })

    assert.deepEqual(result.scanned, {
      files: 1,
      bytes: Buffer.byteLength(line),
      skipped: [],
      skippedTotal: 0,
      skippedByReason: {},
      ignoreProblems: [],
      truncated: false,
    })
    assert.equal(result.truncated, false)
    assert.deepEqual(result.guides, [{ id: 'dialog', findings: 1 }])
    assert.equal(result.findings.length, 1)

    const [finding] = result.findings
    assert.deepEqual(Object.keys(finding).sort(), [
      'column', 'confidence', 'guideId', 'line', 'lines', 'message', 'occurrences', 'path', 'ruleId', 'snippet',
    ])
    assert.equal(finding.lines.length, 1)
    assert.equal(finding.occurrences, 1)
    assert.equal(finding.path, 'src/app.js')
    assert.equal(finding.path.includes('\\'), false, 'report paths always use forward slashes')
    assert.equal(finding.line, 1)
    assert.equal(finding.column, line.indexOf('legacyModal') + 1)
    assert.equal(finding.ruleId, RULE_MODAL.id)
    assert.equal(finding.guideId, 'dialog')
    assert.equal(finding.confidence, 'high')
    assert.equal(finding.message, RULE_MODAL.message)
    assert.equal(finding.snippet, line.trim())
  })
})

test('a file named directly is scanned, and naming the workspace itself works', async () => {
  await withWorkspace({ 'src/app.js': 'legacyModal(el)\n' }, async (cwd) => {
    const named = await scan({ cwd, paths: ['src/app.js'], rules: [RULE_MODAL] })
    assert.equal(named.scanned.files, 1)
    assert.equal(named.findings[0].path, 'src/app.js')

    const dotted = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    assert.equal(dotted.scanned.files, 1)
    assert.equal(dotted.findings[0].path, 'src/app.js')
  })
})

test('absolute path forms are refused before anything is read', async () => {
  await withWorkspace({ 'app.js': 'legacyModal\n' }, async (cwd) => {
    const forms = ['/etc/passwd', 'C:\\Windows\\app.js', '\\\\server\\share\\app.js', '~/app.js']
    for (const form of forms) {
      await assert.rejects(scan({ cwd, paths: [form], rules: [RULE_MODAL] }), isScanError('path-absolute', form))
    }
  })
})

test('a path that resolves outside the workspace is refused', async () => {
  const root = await makeWorkspace({ 'inner/app.js': 'legacyModal\n', 'outside.js': 'legacyModal\n' })
  try {
    const cwd = join(root, 'inner')
    await assert.rejects(
      scan({ cwd, paths: ['../outside.js'], rules: [RULE_MODAL] }),
      isScanError('path-outside', '../outside.js'),
    )
    await assert.rejects(
      scan({ cwd, paths: ['../'], rules: [RULE_MODAL] }),
      isScanError('path-outside', '../'),
    )
    // Inside is still fine, so the refusal is about containment, not about `..` as such.
    const result = await scan({ cwd, paths: ['./app.js'], rules: [RULE_MODAL] })
    assert.equal(result.findings.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing named path is an error, never silence', async () => {
  await withWorkspace({ 'app.js': 'legacyModal\n' }, async (cwd) => {
    await assert.rejects(scan({ cwd, paths: ['nope.js'], rules: [RULE_MODAL] }), isScanError('path-missing', 'nope.js'))
    await assert.rejects(scan({ cwd, paths: ['src'], rules: [RULE_MODAL] }), isScanError('path-missing', 'src'))
  })
})

test('the paths argument is validated as a non-empty relative list', async () => {
  await withWorkspace({ 'app.js': 'legacyModal\n' }, async (cwd) => {
    const cases = [undefined, null, 'app.js', [], [''], ['a\u0000b.js'], [42]]
    for (const paths of cases) {
      await assert.rejects(scan({ cwd, paths, rules: [RULE_MODAL] }), isScanError('paths'))
    }
    const tooMany = Array.from({ length: SCAN_LIMITS.maxPaths + 1 }, () => 'app.js')
    await assert.rejects(scan({ cwd, paths: tooMany, rules: [RULE_MODAL] }), isScanError('paths'))
  })
})

test('the extension allowlist skips everything else', async () => {
  await withWorkspace(
    { 'app.js': 'legacyModal\n', 'img.png': 'legacyModal', 'notes.txt': 'legacyModal', 'data.json': '{"legacyModal": true}' },
    async (cwd) => {
      const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
      assert.equal(result.scanned.files, 2)
      assert.deepEqual(
        result.scanned.skipped.sort((left, right) => left.path.localeCompare(right.path)),
        [
          { path: 'img.png', reason: 'extension' },
          { path: 'notes.txt', reason: 'extension' },
        ],
      )
      assert.deepEqual(result.findings.map((finding) => finding.path), ['app.js', 'data.json'])
    },
  )
})

test('the skipped list is capped while skippedTotal keeps counting', async () => {
  const files = {}
  for (let index = 0; index < 150; index += 1) {
    files[`asset-${String(index).padStart(3, '0')}.png`] = 'x'
  }
  await withWorkspace(files, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    assert.equal(result.scanned.files, 0)
    assert.equal(result.scanned.skipped.length, SCAN_LIMITS.maxSkipped)
    assert.equal(result.scanned.skippedTotal, 150)
    assert.ok(result.scanned.skipped.every((entry) => entry.reason === 'extension'))
  })
})

test('the skipped cap can be tightened through limits', async () => {
  const files = {}
  for (let index = 0; index < 10; index += 1) files[`asset-${index}.png`] = 'x'
  await withWorkspace(files, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxSkipped: 3 } })
    assert.equal(result.scanned.skipped.length, 3)
    assert.equal(result.scanned.skippedTotal, 10)
  })
})

test('skipDirectories are never entered', async () => {
  await withWorkspace(
    { 'src/app.js': 'legacyModal\n', 'node_modules/pkg/index.js': 'legacyModal\n', 'dist/out.js': 'legacyModal\n', '.git/hook.js': 'legacyModal\n' },
    async (cwd) => {
      const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
      assert.equal(result.scanned.files, 1)
      assert.deepEqual(result.findings.map((finding) => finding.path), ['src/app.js'])
      for (const entry of result.scanned.skipped) {
        assert.ok(!entry.path.includes('node_modules'))
        assert.ok(!entry.path.includes('dist'))
        assert.ok(!entry.path.includes('.git'))
      }
    },
  )
})

test('an oversized file is skipped as large', async () => {
  const content = 'legacyModal legacyModal\n'
  await withWorkspace({ 'big.js': content }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxFileBytes: 8 } })
    assert.equal(result.scanned.files, 0)
    assert.equal(result.scanned.bytes, 0)
    assert.deepEqual(result.scanned.skipped, [{ path: 'big.js', reason: 'large' }])
    assert.deepEqual(result.findings, [])
  })
})

test('a file with a NUL byte is skipped as binary', async () => {
  await withWorkspace({ 'blob.js': Buffer.from('legacyModal\u0000tail') }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    assert.equal(result.scanned.files, 0)
    assert.deepEqual(result.scanned.skipped, [{ path: 'blob.js', reason: 'binary' }])
  })
})

test('maxFindings caps the returned list and marks the result truncated', async () => {
  // Blocks of one hit, four lines apart: each block is its own run, so the cap sees ten findings.
  const lines = Array.from({ length: 10 }, (_, index) => `legacyModal ${index}`).join('\n\n\n\n')
  await withWorkspace({ 'many.js': lines }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxFindings: 3 } })
    assert.equal(result.findings.length, 3)
    assert.deepEqual(result.findings.map((finding) => finding.line), [1, 5, 9])
    assert.equal(result.truncated, true)
    assert.equal(result.scanned.truncated, false)
    assert.deepEqual(result.guides, [{ id: 'dialog', findings: 3 }])
  })
})

test('a run of adjacent hits costs one finding, so the cap is spent on code sites', async () => {
  // Forty consecutive hits are one block to change; four such blocks, two untouched lines apart, are
  // four findings, so a cap of three keeps three blocks and truncates — not three lines of one block.
  const block = Array.from({ length: 40 }, () => 'legacyModal').join('\n')
  const file = [block, '', '', block, '', '', block, '', '', block].join('\n')
  await withWorkspace({ 'many.js': file }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxFindings: 3 } })
    assert.equal(result.findings.length, 3)
    assert.deepEqual(result.findings.map((finding) => finding.occurrences), [40, 40, 40])
    assert.deepEqual(result.findings.map((finding) => finding.lines.length), [40, 40, 40])
    assert.equal(result.truncated, true)
  })
})

test('maxFiles stops enumeration and reports the first refused file', async () => {
  await withWorkspace({ 'a.js': 'legacyModal\n', 'b.js': 'legacyModal\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxFiles: 1 } })
    assert.equal(result.scanned.files, 1)
    assert.equal(result.scanned.truncated, true)
    assert.equal(result.truncated, true)
    assert.deepEqual(result.scanned.skipped, [{ path: 'b.js', reason: 'too-many' }])
  })
})

test('maxTotalBytes stops before reading a file that would overflow it', async () => {
  await withWorkspace({ 'big.js': 'legacyModal legacyModal\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxTotalBytes: 10 } })
    assert.equal(result.scanned.files, 0)
    assert.equal(result.scanned.bytes, 0)
    assert.equal(result.scanned.truncated, true)
    assert.deepEqual(result.scanned.skipped, [{ path: 'big.js', reason: 'too-many' }])
  })
})

test('findings are ordered by path, then line, then column, then rule id', async () => {
  const alphaA = { id: 'ls-test-a', guideId: 'css', confidence: 'medium', message: 'Alpha marker.', source: 'alphaMarker' }
  const alphaZ = { id: 'ls-test-z', guideId: 'css', confidence: 'medium', message: 'Alpha marker.', source: 'alphaMarker' }
  const beta = { id: 'ls-test-b', guideId: null, confidence: 'low', message: 'Beta marker.', source: 'betaMarker' }
  // Line 1 carries a column tie and a rule-id tie; line 4 is far enough from line 1 that its hits
  // are their own runs rather than continuations.
  const aLines = ['x betaMarker alphaMarker', '', '', 'alphaMarker']
  await withWorkspace({ 'a.js': `${aLines.join('\n')}\n`, 'b.js': 'alphaMarker\n' }, async (cwd) => {
    // Roots are listed in reverse on purpose: enumeration sorts, the report does not depend on argv.
    const result = await scan({ cwd, paths: ['b.js', 'a.js'], rules: [beta, alphaZ, alphaA] })
    assert.deepEqual(
      result.findings.map((finding) => `${finding.path}:${finding.line}:${finding.column}:${finding.ruleId}`),
      [
        `a.js:1:3:${beta.id}`,
        `a.js:1:${aLines[0].indexOf('alphaMarker') + 1}:${alphaA.id}`,
        `a.js:1:${aLines[0].indexOf('alphaMarker') + 1}:${alphaZ.id}`,
        `a.js:4:1:${alphaA.id}`,
        `a.js:4:1:${alphaZ.id}`,
        `b.js:1:1:${alphaA.id}`,
        `b.js:1:1:${alphaZ.id}`,
      ],
    )
  })
})

test('the snippet is trimmed and clipped to the limit with an ellipsis', async () => {
  const short = '   legacyModal(el)   '
  const long = `legacyModal ${'x'.repeat(400)}`
  await withWorkspace({ 'short.js': `${short}\n`, 'long.js': `${long}\n` }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    const byPath = new Map(result.findings.map((finding) => [finding.path, finding.snippet]))
    assert.equal(byPath.get('short.js'), 'legacyModal(el)')
    const clipped = byPath.get('long.js')
    assert.equal(clipped.length, SCAN_LIMITS.maxSnippetChars)
    assert.ok(clipped.endsWith('\u2026'))
    assert.equal(clipped, `${long.slice(0, SCAN_LIMITS.maxSnippetChars - 1)}\u2026`)
  })
})

test('the snippet cap can be tightened through limits', async () => {
  await withWorkspace({ 'app.js': 'legacyModal with a long tail of characters\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxSnippetChars: 12 } })
    assert.equal(result.findings[0].snippet.length, 12)
    assert.ok(result.findings[0].snippet.endsWith('\u2026'))
  })
})

test('snippets escape control characters instead of smuggling them', async () => {
  await withWorkspace({ 'controls.js': 'legacyModal \u0001\u0007 tail\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    const [snippet] = result.findings.map((finding) => finding.snippet)
    assert.equal(snippet, 'legacyModal \\u0001\\u0007 tail')
    assert.ok(!snippet.includes('\u0001'))
    assert.ok(!snippet.includes('\u0007'))
  })
})

test('one rule matched twice on a line yields one finding at the first match', async () => {
  await withWorkspace({ 'app.js': 'legacyModal legacyModal legacyModal\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].column, 1)
  })
})

test('the same rule passed twice still yields one finding per line', async () => {
  await withWorkspace({ 'app.js': 'legacyModal\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL, RULE_MODAL] })
    assert.equal(result.findings.length, 1)
  })
})

test('guides count only the returned findings, sorted by count then id, null guide ids dropped', async () => {
  const markA = { id: 'ls-test-mark-a', guideId: 'z-guide', confidence: 'high', message: 'A.', source: 'markA' }
  const markB = { id: 'ls-test-mark-b', guideId: 'a-guide', confidence: 'high', message: 'B.', source: 'markB' }
  const markD = { id: 'ls-test-mark-d', guideId: 'b-guide', confidence: 'high', message: 'D.', source: 'markD' }
  const markC = { id: 'ls-test-mark-c', guideId: null, confidence: 'low', message: 'C.', source: 'markC' }
  // The same three code sites per rule, four lines apart, so each stays its own finding and the
  // guide roll-up is counting findings rather than lines.
  const lines = ['markA markB markC markD', '', '', '', 'markA markB markD', '', '', '', 'markA']
  await withWorkspace({ 'app.js': `${lines.join('\n')}\n` }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'], rules: [markA, markB, markC, markD] })
    assert.equal(result.findings.length, 8)
    assert.deepEqual(result.guides, [
      { id: 'z-guide', findings: 3 },
      { id: 'a-guide', findings: 2 },
      { id: 'b-guide', findings: 2 },
    ])
  })
})

test('an aborted signal throws its own reason', async () => {
  await withWorkspace({ 'app.js': 'legacyModal\n' }, async (cwd) => {
    const reason = new Error('host cancelled the scan')
    const controller = new AbortController()
    controller.abort(reason)
    await assert.rejects(
      scan({ cwd, paths: ['.'], rules: [RULE_MODAL], signal: controller.signal }),
      (error) => error === reason,
    )
  })
})

test('bad rules and bad limits are refused with their own codes', async () => {
  await withWorkspace({ 'app.js': 'legacyModal\n' }, async (cwd) => {
    await assert.rejects(scan({ cwd, paths: ['.'], rules: 'nope' }), isScanError('rules'))
    await assert.rejects(scan({ cwd, paths: ['.'], rules: [{ id: 'ls-x' }] }), isScanError('rules', 'ls-x'))
    await assert.rejects(
      scan({ cwd, paths: ['.'], rules: [{ id: 'ls-x', source: '(', message: 'M.' }] }),
      isScanError('rules', 'ls-x'),
    )
    await assert.rejects(
      scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxFindings: SCAN_LIMITS.maxFindings + 1 } }),
      isScanError('limits', 'maxFindings'),
    )
    await assert.rejects(
      scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxSkipped: SCAN_LIMITS.maxSkipped + 1 } }),
      isScanError('limits', 'maxSkipped'),
    )
    await assert.rejects(
      scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { maxFiles: 'many' } }),
      isScanError('limits', 'maxFiles'),
    )
    await assert.rejects(
      scan({ cwd, paths: ['.'], rules: [RULE_MODAL], limits: { nope: 1 } }),
      isScanError('limits', 'nope'),
    )
  })
})

test('a symlink that leaves the workspace is skipped while walking', async (t) => {
  const root = await makeWorkspace({ 'inner/app.js': 'legacyModal\n', 'outside.js': 'legacyModal\n' })
  try {
    const cwd = join(root, 'inner')
    let linked = true
    try {
      await symlink('../outside.js', join(cwd, 'link.js'))
    } catch {
      linked = false
    }
    if (!linked) {
      t.skip('symlink creation is not permitted on this machine')
      return
    }

    const walked = await scan({ cwd, paths: ['.'], rules: [RULE_MODAL] })
    assert.equal(walked.scanned.files, 1)
    assert.deepEqual(walked.scanned.skipped, [{ path: 'link.js', reason: 'outside' }])
    assert.deepEqual(walked.findings.map((finding) => finding.path), ['app.js'])

    // A symlink *named* as a root is held to the stricter rule: an explicit escape is an error.
    await assert.rejects(scan({ cwd, paths: ['link.js'], rules: [RULE_MODAL] }), isScanError('path-outside', 'link.js'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('overlapping paths do not scan a file twice', async () => {
  await withWorkspace({ 'src/app.js': 'legacyModal\n' }, async (cwd) => {
    const result = await scan({ cwd, paths: ['src', 'src/app.js', './src'], rules: [RULE_MODAL] })
    assert.equal(result.scanned.files, 1)
    assert.equal(result.findings.length, 1)
  })
})

test('the real rule table drives a scan end to end', async () => {
  const sample = 'const x = document.write("<p>hi</p>")\n'
  const matching = RULES.find((rule) => new RegExp(rule.source).test(sample))
  assert.ok(matching !== undefined, 'the default table must know document.write')

  await withWorkspace({ 'page.js': sample }, async (cwd) => {
    const result = await scan({ cwd, paths: ['.'] })
    assert.equal(result.findings.length, 1)
    const [finding] = result.findings
    assert.equal(finding.ruleId, matching.id)
    assert.equal(finding.guideId, matching.guideId)
    assert.equal(finding.confidence, matching.confidence)
    assert.equal(finding.message, matching.message)
    assert.deepEqual(result.guides, [{ id: matching.guideId, findings: 1 }])
  })
})
