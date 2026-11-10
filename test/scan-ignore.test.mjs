/**
 * Unit tests for the `.scanignore` grammar and matcher.
 *
 * A scan only reaches the parser through `<cwd>/.scanignore`, so the edge cases are pinned here,
 * directly on the two exported pieces: what counts as a pattern, what counts as a malformed line,
 * and what a pattern matches. `test/scan.test.mjs` covers the wiring — that the file is read, the
 * subtree is skipped, and the diagnostics reach the report.
 *
 * The subset documented at the top of `lib/scan.js` is the specification that will be copied into
 * `docs/notes/legacy-scan-contract.md`; if a test here has to change, that document has to change.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { matchesScanIgnore, parseScanIgnore } from '../lib/scan.js'

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
