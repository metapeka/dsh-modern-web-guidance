/**
 * Unit tests for the `.scanignore` grammar, its matcher and what each line did.
 *
 * A scan only reaches the parser through `<cwd>/.scanignore`, so the edge cases are pinned here,
 * directly on the two exported pieces: what counts as a pattern, what counts as a malformed line,
 * and what a pattern matches. The second half drives `scan()` itself, because usage is a fact about
 * the walk — `test/scan.test.mjs` covers the rest of the wiring (the subtree is skipped, the
 * diagnostics reach the report).
 *
 * The subset documented at the top of `lib/scan.js` is the specification that will be copied into
 * `docs/notes/legacy-scan-contract.md`; if a test here has to change, that document has to change.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { matchesScanIgnore, parseScanIgnore, scan } from '../lib/scan.js'

/**
 * A throwaway workspace: each key is a cwd-relative path, `null` meaning "make this directory".
 *
 * The walk tests need files that a committed fixture cannot carry — an unreadable `.scanignore` is a
 * directory, and a file with twenty-one patterns is a file nobody wants in `test/fixtures/` — so the
 * ones that must be created are created here and removed again.
 *
 * @param {Record<string, string | null>} entries
 * @returns {Promise<string>}
 */
async function workspace(entries) {
  const cwd = await mkdtemp(join(tmpdir(), 'scanignore-'))
  for (const [path, content] of Object.entries(entries)) {
    const target = join(cwd, path)
    if (content === null) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return cwd
}

test('comments, blank lines and CRLF are not patterns', () => {
  const parsed = parseScanIgnore('# generated output\r\n\r\nartifacts/\r\n   \r\n   # indented comment\r\n')

  assert.deepEqual(parsed.patterns.map((pattern) => pattern.source), ['artifacts/'])
  assert.equal(parsed.patterns[0].directoriesOnly, true)
  assert.deepEqual(parsed.problems, [])
})

test('a line outside the documented subset is a problem with its line number, not a pattern', () => {
  const parsed = parseScanIgnore(
    [
      'artifacts/',
      '!keep.js',
      'assets/**/*.js',
      'file?.js',
      'name[0].js',
      'back\\slash.js',
      'src/vendor/*.js',
      '/',
    ].join('\n'),
  )

  assert.deepEqual(parsed.patterns.map((pattern) => pattern.source), ['artifacts/', 'src/vendor/*.js'])
  assert.deepEqual(parsed.problems, [
    { line: 2, reason: 'malformed' },
    { line: 3, reason: 'malformed' },
    { line: 4, reason: 'malformed' },
    { line: 5, reason: 'malformed' },
    { line: 6, reason: 'malformed' },
    { line: 8, reason: 'malformed' },
  ])
})

test('a leading slash is allowed and ignored, and a trailing slash marks a directory pattern', () => {
  const parsed = parseScanIgnore('/report/\n/report.html\nlib/\n')

  assert.deepEqual(parsed.patterns.map((pattern) => pattern.source), ['/report/', '/report.html', 'lib/'])
  assert.deepEqual(parsed.patterns.map((pattern) => pattern.directoriesOnly), [true, false, true])
  assert.deepEqual(parsed.problems, [])
})

test('a one-segment pattern matches that name at any depth', () => {
  const ignore = parseScanIgnore('report/\n*.min.js\n')

  assert.equal(matchesScanIgnore(ignore, 'report', true), true)
  assert.equal(matchesScanIgnore(ignore, 'src/report', true), true)
  assert.equal(matchesScanIgnore(ignore, 'app.min.js', false), true)
  assert.equal(matchesScanIgnore(ignore, 'assets/app.min.js', false), true)
})

test('a directory pattern never matches a file, so the subtree is pruned rather than filtered', () => {
  const ignore = parseScanIgnore('artifacts/\n')

  assert.equal(matchesScanIgnore(ignore, 'artifacts', true), true)
  // The walk prunes the directory; a file check only ever sees paths outside it.
  assert.equal(matchesScanIgnore(ignore, 'artifacts', false), false)
  assert.equal(matchesScanIgnore(ignore, 'artifacts/page.html', false), false)
})

test('a multi-segment pattern is anchored at the root and * never crosses a slash', () => {
  const ignore = parseScanIgnore('src/vendor/*.js\npublic/index.html\n')

  assert.equal(matchesScanIgnore(ignore, 'src/vendor/lib.js', false), true)
  assert.equal(matchesScanIgnore(ignore, 'src/vendor/deep/lib.js', false), false)
  assert.equal(matchesScanIgnore(ignore, 'app/src/vendor/lib.js', false), false)
  assert.equal(matchesScanIgnore(ignore, 'public/index.html', false), true)
  assert.equal(matchesScanIgnore(ignore, 'src/public/index.html', false), false)
})

test('a pattern that matches nothing, and an empty file, match nothing at all', () => {
  const never = parseScanIgnore('never/there.js\n')
  assert.equal(matchesScanIgnore(never, 'src/app.js', false), false)
  assert.equal(matchesScanIgnore(never, '', true), false)

  const empty = parseScanIgnore('')
  assert.deepEqual(empty.patterns, [])
  assert.deepEqual(empty.problems, [])
  assert.equal(matchesScanIgnore(empty, 'app.js', false), false)
})

// --- What each line did: `scanned.ignoreUsage` -----------------------------------------------
//
// The walk half. Every pattern is one row carrying the source line it came from, and `matched` says
// whether the walk met a path that pattern covers — which is a question about the *match*, not about
// the reason the walk printed. The unreadable case comes first because it is the one a careless
// implementation gets wrong: an absent list must never be read as "every pattern is idle".

test('an unreadable .scanignore reports no usage at all, never an empty list', async () => {
  // A directory where the file should be is the cheapest way to make the read fail without changing
  // permissions, which a test cannot rely on across platforms.
  const cwd = await workspace({ 'src/app.js': 'export const x = 1\n', '.scanignore': null })
  try {
    const value = await scan({ cwd, paths: ['.'] })
    assert.deepEqual(value.scanned.ignoreProblems, [{ line: null, reason: 'unreadable' }])
    // Absent, not `[]`: the report then renders no sentence at all. "3 patterns, 3 matched nothing"
    // about a file nobody read is the exact lie this field exists to prevent.
    assert.equal('ignoreUsage' in value.scanned, false, 'an unreadable file produced a usage list')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a file with no valid pattern reports no usage, and its malformed lines stay diagnostics', async () => {
  const cwd = await workspace({ 'src/app.js': 'export const x = 1\n', '.scanignore': '!keep.js\n' })
  try {
    const value = await scan({ cwd, paths: ['.'] })
    // A malformed line is a diagnostic, never a pattern with `matched: false` — otherwise "one pattern
    // matched nothing" would describe a line the scanner already told the user to fix.
    assert.deepEqual(value.scanned.ignoreProblems, [{ line: 1, reason: 'malformed' }])
    assert.equal('ignoreUsage' in value.scanned, false, 'a malformed line became a usage row')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('every pattern is one row with its source line, and only the lines that excluded something are credited', async () => {
  const cwd = await workspace({
    'src/app.js': 'export const x = 1\n',
    'tmp-deploy/old.js': 'export const y = 2\n',
    '.hidden/junk.js': 'export const z = 3\n',
    '.scanignore': [
      '# artifacts',
      'tmp-deploy/',
      '/tmp-deploy/',
      'gone/',
      '*.min.js',
      '.hidden/',
    ].join('\n') + '\n',
  })
  try {
    const value = await scan({ cwd, paths: ['.'] })
    // Per source line, never per effect: two lines that mean the same thing are two rows, because the
    // duplicate a reader may now delete is the point of the exercise. `.hidden/` is credited although
    // the walk refused that directory as `dot-directory` before it ever asked about the ignore file —
    // a pattern is never called idle because the path it covers was skipped for another reason first.
    assert.deepEqual(value.scanned.ignoreUsage, [
      { line: 2, pattern: 'tmp-deploy/', matched: true },
      { line: 3, pattern: '/tmp-deploy/', matched: true },
      { line: 4, pattern: 'gone/', matched: false },
      { line: 5, pattern: '*.min.js', matched: false },
      { line: 6, pattern: '.hidden/', matched: true },
    ])
    // The walk still behaved exactly as before: one subtree pruned as a scanignore skip, one
    // dot-directory refused, and the three patterns that hit nothing changed nothing.
    assert.deepEqual(value.scanned.skippedByReason, { 'dot-directory': 1, scanignore: 1, extension: 1 })
    assert.equal(value.scanned.files, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a directory pattern is credited once for the subtree, not once per file inside it', async () => {
  const cwd = await workspace({
    'src/app.js': 'export const x = 1\n',
    'artifacts/one.js': 'export const a = 1\n',
    'artifacts/two.js': 'export const b = 2\n',
    'artifacts/three.js': 'export const c = 3\n',
    '.scanignore': 'artifacts/\n',
  })
  try {
    const value = await scan({ cwd, paths: ['.'] })
    assert.deepEqual(value.scanned.ignoreUsage, [{ line: 1, pattern: 'artifacts/', matched: true }])
    // One skip for the subtree root, which is why "one row, one skip" is the honest reading.
    assert.deepEqual(value.scanned.skippedByReason, { scanignore: 1, extension: 1 })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a pattern that only covers a dot-directory is credited, and no scanignore skip exists to credit it', async () => {
  const cwd = await workspace({
    'src/app.js': 'export const x = 1\n',
    '.hidden/junk.js': 'export const z = 3\n',
    '.scanignore': '.hidden/\n',
  })
  try {
    const value = await scan({ cwd, paths: ['.'] })
    // The subtle one: `.hidden` is refused by the dot-directory rule, so nothing was ever skipped *as*
    // `scanignore` — and the pattern must still read as used. Crediting only the skips the ignore
    // itself caused would call this line idle, and a reader would delete a line that is doing work.
    assert.deepEqual(value.scanned.skippedByReason, { 'dot-directory': 1, extension: 1 })
    assert.deepEqual(value.scanned.ignoreUsage, [{ line: 1, pattern: '.hidden/', matched: true }])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the usage list is capped, and the rows past the cap are simply not reported', async () => {
  const patterns = Array.from({ length: 21 }, (_, index) => `never-${index + 1}/`)
  const cwd = await workspace({ 'src/app.js': 'export const x = 1\n', '.scanignore': `${patterns.join('\n')}\n` })
  try {
    const value = await scan({ cwd, paths: ['.'] })
    // Twenty rows, the same cap as the diagnostics, and every one of them names a line that matched
    // nothing: a report that counts the rows it was given under-reports rather than inventing.
    assert.equal(value.scanned.ignoreUsage.length, 20)
    assert.deepEqual(value.scanned.ignoreUsage[0], { line: 1, pattern: 'never-1/', matched: false })
    assert.deepEqual(value.scanned.ignoreUsage.at(-1), { line: 20, pattern: 'never-20/', matched: false })
    assert.deepEqual(value.scanned.ignoreProblems, [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
