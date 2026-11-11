/**
 * End-to-end tests for `web_guidance_legacy_scan`, the fourth tool.
 *
 * These drive the tool the way the host does: `apply()` registers it, `execute()` runs it, and
 * `output.render()` produces the model-facing text. Nothing here re-implements a rule or the
 * renderer — the committed fixtures in `test/fixtures/scan/` carry the markers, the scanner
 * decides, and the assertions read the rendered report. A change in either the scanner or the
 * renderer therefore fails a test instead of being papered over.
 *
 * Refusal codes are the ones in `docs/notes/legacy-scan-contract.md`; the tool maps a `ScanError`
 * to `{ error, subject, message }` instead of throwing. Where a refusal must happen before the
 * filesystem is touched, the test proves it by handing the tool a cwd that does not exist: any
 * implementation that resolved the workspace first would fail with `path-missing` instead.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { SCAN_LIMITS, ScanError, scan } from '../lib/scan.js'
import { PACKAGE_DIR } from './paths.mjs'

/** Fixture roots, named as cwd-relative paths: the report echoes them back verbatim. */
const FIXTURES = 'test/fixtures/scan'
const DIRTY = `${FIXTURES}/dirty`
const CLEAN = `${FIXTURES}/clean`
const PROSE = `${FIXTURES}/prose`
const DOT_ROOT = `${FIXTURES}/dot-root`
const IGNORE_ROOT = `${FIXTURES}/ignore-root`

let registered

/** Apply the plugin once: the scanner tool is the same object the host would receive. */
function scanTool() {
  if (registered !== undefined) return registered
  const tools = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    skills: {
      register() {
        return () => {}
      },
    },
    effect(create) {
      return create()
    },
  }
  apply(ctx)
  registered = tools.find((tool) => tool.name === 'web_guidance_legacy_scan')
  assert.ok(registered !== undefined, 'apply() must register web_guidance_legacy_scan')
  return registered
}

/** The executor shape `execute()` reads: only the session cwd matters to the scanner. */
function execAt(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** Run the tool as the host would and hand back its value. */
function runScan(args, cwd = PACKAGE_DIR) {
  return scanTool().execute(args, execAt(cwd))
}

/** Render a value through the tool's own renderer, so no format is copied into this file. */
function render(args, value) {
  const blocks = scanTool().output.render(args, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  return blocks[0].text
}

/** A throwaway directory outside the package, removed when its test ends. */
async function tempDir(t, name = 'legacy-scan-') {
  const directory = await mkdtemp(join(tmpdir(), name))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

/** Every file under `root`, with the size and mtime a write would move. */
async function snapshot(root) {
  const rows = []
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(absolute, relativePath)
        continue
      }
      const info = await stat(absolute)
      rows.push(`${relativePath} ${info.size} ${info.mtimeMs}`)
    }
  }
  await visit(root, '')
  return rows
}

test('a directory scan reports several rules across three files, and the renderer summarises them', async () => {
  const args = { paths: [DIRTY] }
  const value = await runScan(args)

  assert.equal(value.error, undefined)
  assert.equal(value.format, 'summary')
  assert.equal(value.cwd, PACKAGE_DIR)
  assert.equal(value.scanned.files, 3)
  assert.equal(value.scanned.skipped.length, 0)
  assert.equal(value.truncated, false)

  const paths = [...new Set(value.findings.map((finding) => finding.path))].sort()
  assert.deepEqual(paths, [`${DIRTY}/page.html`, `${DIRTY}/page.jsx`, `${DIRTY}/styles.css`])

  // The fixtures deliberately carry eight markers spanning eight rules, across all three files.
  assert.equal(value.findings.length, 8)
  const ruleIds = [...new Set(value.findings.map((finding) => finding.ruleId))].sort()
  assert.deepEqual(ruleIds, ['ls-01', 'ls-12', 'ls-13', 'ls-14', 'ls-15', 'ls-31', 'ls-32', 'ls-33'])
  for (const finding of value.findings) {
    assert.ok(Number.isInteger(finding.line) && finding.line >= 1)
    assert.ok(Number.isInteger(finding.column) && finding.column >= 1)
    assert.match(finding.ruleId, /^ls-\d{2}$/)
    assert.ok(['high', 'medium', 'low'].includes(finding.confidence))
    assert.ok(finding.message.length > 0)
    assert.ok(finding.snippet.length > 0)
  }

  // Per-guide counts cover exactly the findings that carry a guide.
  const guided = value.findings.filter((finding) => finding.guideId !== null).length
  assert.equal(value.guides.reduce((sum, guide) => sum + guide.findings, 0), guided)
  for (const guide of value.guides) {
    assert.ok(value.findings.some((finding) => finding.guideId === guide.id))
  }

  const text = render(args, value)
  assert.match(text, /^Scanned 3 file\(s\) \(\d+ B\) — 8 finding\(s\)\./m)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/styles\.css:3:17 ls-01 \(high\) /)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/styles\.css:8:3 ls-12 \(high\) /)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/styles\.css:11:14 ls-31 \(high\) /)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/styles\.css:15:1 ls-33 \(high\) /)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/page\.jsx:3:10 ls-32 \(high\) /)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/page\.html:1:10 ls-13 \(low\) /)
  assert.match(text, /Load with web_guidance_retrieve: /)
})

test('the clean fixture reports no finding and says plainly what that does not prove', async () => {
  const args = { paths: [CLEAN] }
  const value = await runScan(args)

  assert.equal(value.scanned.files, 1)
  assert.deepEqual(value.findings, [])
  assert.deepEqual(value.guides, [])
  assert.equal(value.truncated, false)

  const text = render(args, value)
  assert.match(text, /^Scanned 1 file\(s\) \(\d+ B\) — 0 finding\(s\)\./m)
  assert.match(text, /No rule in the table matched\./)
})

test('an absolute path is refused as path-absolute before the workspace is resolved', async (t) => {
  const gone = join(await tempDir(t), 'no-such-workspace')
  const absolutes = [
    join(PACKAGE_DIR, DIRTY),
    '/etc/passwd',
    '~/notes.md',
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\app.js',
  ]

  for (const absolute of absolutes) {
    const args = { paths: [absolute] }
    const value = await runScan(args, gone)
    assert.equal(value.error, 'path-absolute', absolute)
    assert.equal(value.subject, absolute)
    assert.match(
      render(args, value),
      /^Error: path-absolute — ".*" is absolute; pass it relative to the session workspace instead\./m,
    )
  }
})

test('a ../ path that lands outside the workspace is refused as path-outside', async (t) => {
  const root = await tempDir(t)
  const workspace = join(root, 'workspace')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(workspace, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  await writeFile(join(elsewhere, 'app.js'), 'document.write("escaped")\n', 'utf8')

  const escape = '../elsewhere/app.js'
  const args = { paths: [escape] }
  const value = await runScan(args, workspace)
  assert.equal(value.error, 'path-outside')
  assert.equal(value.subject, escape)
  assert.match(render(args, value), /^Error: path-outside — "\.\.\/elsewhere\/app\.js" resolves outside/m)

  // The module boundary throws the same refusal as a ScanError; the tool only maps it.
  await assert.rejects(
    scan({ cwd: workspace, paths: [escape] }),
    (error) => error instanceof ScanError && error.code === 'path-outside' && error.subject === escape,
  )
})

test('a named path that does not exist is refused as path-missing rather than reported clean', async (t) => {
  const workspace = await tempDir(t)
  const args = { paths: ['src/typo.js'] }
  const value = await runScan(args, workspace)

  assert.equal(value.error, 'path-missing')
  assert.equal(value.subject, 'src/typo.js')
  assert.match(render(args, value), /^Error: path-missing — "src\/typo\.js" does not exist or cannot be read/m)
})

test('node_modules, .git and dist are never entered: no findings and not even a skip row', async (t) => {
  const workspace = await tempDir(t)
  await writeFile(join(workspace, 'app.js'), 'document.write("kept")\n', 'utf8')
  const hidden = [
    ['node_modules/pkg', 'index.js'],
    ['.git/hooks', 'pre-commit.js'],
    ['dist', 'bundle.js'],
  ]
  for (const [directory, name] of hidden) {
    await mkdir(join(workspace, directory), { recursive: true })
    await writeFile(join(workspace, directory, name), 'document.write("hidden")\n', 'utf8')
  }

  const args = { paths: ['.'] }
  const value = await runScan(args, workspace)
  assert.equal(value.scanned.files, 1)
  assert.deepEqual(value.findings.map((finding) => [finding.path, finding.ruleId]), [['app.js', 'ls-17']])
  // "Not entered" means not skipped either: a skip row would mean the walk looked inside.
  assert.deepEqual(value.scanned.skipped, [])
  assert.match(render(args, value), /^Scanned 1 file\(s\) .* — 1 finding\(s\)\./m)
})

test('a non-source extension is skipped as extension and NUL bytes as binary', async (t) => {
  const workspace = await tempDir(t)
  // A PNG header is enough: the extension allowlist decides before anything is read.
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
  await writeFile(join(workspace, 'photo.png'), pngHeader)
  await writeFile(join(workspace, 'broken.js'), Buffer.from('document.write("x")\u0000\n', 'utf8'))
  await writeFile(join(workspace, 'real.js'), 'document.write("kept")\n', 'utf8')

  const args = { paths: ['.'] }
  const value = await runScan(args, workspace)
  assert.equal(value.scanned.files, 1)
  const reasons = new Map(value.scanned.skipped.map((entry) => [entry.path, entry.reason]))
  assert.deepEqual([...reasons.keys()].sort(), ['broken.js', 'photo.png'])
  assert.equal(reasons.get('photo.png'), 'extension')
  assert.equal(reasons.get('broken.js'), 'binary')
  assert.deepEqual(value.findings.map((finding) => finding.path), ['real.js'])
  assert.deepEqual(value.scanned.skippedByReason, { binary: 1, extension: 1 })
  assert.match(render(args, value), /^Skipped 2 path\(s\): 1 binary, 1 extension$/m)
})

test('Markdown is prose, not code: the same marker inside it is skipped, not reported', async () => {
  const args = { paths: [PROSE] }
  const value = await runScan(args)

  // Only the code file was read. The Markdown file was met during the walk and skipped the ordinary
  // way: it is in `skipped` with the extension reason, and `skippedTotal` counts it.
  assert.equal(value.scanned.files, 1)
  assert.equal(value.scanned.skippedTotal, 1)
  assert.deepEqual(value.scanned.skipped, [{ path: `${PROSE}/legacy.md`, reason: 'extension' }])
  assert.deepEqual(
    value.findings.map((finding) => [finding.path, finding.ruleId]),
    [[`${PROSE}/legacy.js`, 'ls-17']],
  )

  const text = render(args, value)
  assert.match(text, /^Scanned 1 file\(s\) .* — 1 finding\(s\)\.$/m)
  assert.match(text, /^Skipped 1 path\(s\): 1 extension$/m)
  // A skipped path is a count in the summary, never a finding line.
  assert.ok(!text.includes('legacy.md'))

  // Naming the Markdown file directly is the same answer, not an error: the allowlist decides.
  const named = await runScan({ paths: [`${PROSE}/legacy.md`] })
  assert.equal(named.scanned.files, 0)
  assert.deepEqual(named.scanned.skipped, [{ path: `${PROSE}/legacy.md`, reason: 'extension' }])
  assert.deepEqual(named.findings, [])
})

test('a dot-directory is never walked, and naming one says the same thing', async () => {
  // `.hidden/marker.html` carries a marker and is still never read. One skip entry for the
  // directory, not one per file inside it: the count stays about directories, not their contents.
  const walked = await runScan({ paths: [DOT_ROOT] })
  assert.equal(walked.scanned.files, 0)
  assert.deepEqual(walked.scanned.skipped, [{ path: `${DOT_ROOT}/.hidden`, reason: 'dot-directory' }])
  assert.deepEqual(walked.scanned.skippedByReason, { 'dot-directory': 1 })
  assert.deepEqual(walked.findings, [])
  assert.match(render({ paths: [DOT_ROOT] }, walked), /^Skipped 1 path\(s\): 1 dot-directory$/m)

  // Naming the directory, or a file inside it, is the same refusal rather than an error: the caller
  // asked for something the scanner never reads, and is told so once.
  for (const named of [`${DOT_ROOT}/.hidden`, `${DOT_ROOT}/.hidden/marker.html`]) {
    const value = await runScan({ paths: [named] })
    assert.equal(value.error, undefined)
    assert.equal(value.scanned.files, 0)
    assert.deepEqual(value.scanned.skipped, [{ path: named, reason: 'dot-directory' }])
    assert.deepEqual(value.findings, [])
  }
})

test('.scanignore excludes a directory subtree, and the same page is scanned without it', async (t) => {
  const workspace = join(PACKAGE_DIR, IGNORE_ROOT)
  const ignored = await scan({ cwd: workspace, paths: ['.'] })

  assert.equal(ignored.scanned.files, 0)
  assert.deepEqual(ignored.findings, [])
  const reasons = new Map(ignored.scanned.skipped.map((entry) => [entry.path, entry.reason]))
  assert.equal(reasons.get('artifacts'), 'scanignore')
  // `.scanignore` itself is a dot *file*: it is walked, and the allowlist is what skips it.
  assert.equal(reasons.get('.scanignore'), 'extension')
  assert.deepEqual(ignored.scanned.skippedByReason, { extension: 1, scanignore: 1 })
  assert.deepEqual(ignored.scanned.ignoreProblems, [])

  // The same refusal covers a path named from inside the ignored subtree, so an explicit path cannot
  // read behind the ignore file's back.
  const named = await scan({ cwd: workspace, paths: ['artifacts/page.html'] })
  assert.equal(named.scanned.files, 0)
  assert.deepEqual(named.scanned.skipped, [{ path: 'artifacts/page.html', reason: 'scanignore' }])

  // The same bytes in a workspace with no ignore file: the page is scannable, so the skip above is
  // the pattern's doing and not the file's.
  const free = await tempDir(t)
  await writeFile(join(free, 'page.html'), await readFile(join(workspace, 'artifacts', 'page.html')))
  const found = await scan({ cwd: free, paths: ['.'] })
  assert.equal(found.scanned.files, 1)
  assert.deepEqual(found.findings.map((finding) => [finding.path, finding.ruleId]), [['page.html', 'ls-17']])
})

test('a one-line pattern parks one file and leaves its neighbours readable', async (t) => {
  const workspace = await tempDir(t)
  await mkdir(join(workspace, 'pages'), { recursive: true })
  // The live-bench shape: a styleguide page that shows the legacy form on purpose, next to pages that
  // must still be checked. Parking the file must not park the directory.
  await writeFile(join(workspace, 'pages/styleguide.astro'), 'transition: max-height 0.3s ease;\n', 'utf8')
  await writeFile(join(workspace, 'pages/index.astro'), 'transition: max-height 0.3s ease;\n', 'utf8')
  await writeFile(join(workspace, '.scanignore'), '# legacy demo\npages/styleguide.astro\n', 'utf8')

  const value = await scan({ cwd: workspace, paths: ['.'] })
  assert.deepEqual(value.scanned.skipped.map((entry) => [entry.path, entry.reason]), [
    ['.scanignore', 'extension'],
    ['pages/styleguide.astro', 'scanignore'],
  ])
  assert.deepEqual(value.scanned.skippedByReason, { extension: 1, scanignore: 1 })
  assert.deepEqual(value.scanned.ignoreProblems, [])
  assert.equal(value.scanned.files, 1)
  assert.deepEqual(value.findings.map((finding) => [finding.path, finding.ruleId]), [['pages/index.astro', 'ls-09']])

  // Naming the parked file does not un-park it: the ignore wins over an explicit path, and the
  // refusal is the same one-entry skip a walk records, not an error.
  const named = await scan({ cwd: workspace, paths: ['pages/styleguide.astro'] })
  assert.equal(named.scanned.files, 0)
  assert.deepEqual(named.scanned.skipped, [{ path: 'pages/styleguide.astro', reason: 'scanignore' }])
  assert.deepEqual(named.findings, [])
})

test('every skip is counted per reason, and the counts add up to skippedTotal', async (t) => {
  const workspace = await tempDir(t)
  await writeFile(join(workspace, '.scanignore'), 'artifacts/\n*.min.js\n!nope.js\n', 'utf8')
  await mkdir(join(workspace, '.hidden'), { recursive: true })
  await mkdir(join(workspace, 'artifacts'), { recursive: true })
  await writeFile(join(workspace, '.hidden/marker.html'), 'document.write("hidden")\n', 'utf8')
  await writeFile(join(workspace, 'artifacts/page.html'), 'document.write("artifact")\n', 'utf8')
  await writeFile(join(workspace, 'app.min.js'), 'document.write("minified")\n', 'utf8')
  await writeFile(join(workspace, 'notes.md'), 'document.write("prose")\n', 'utf8')
  await writeFile(join(workspace, 'app.js'), 'document.write("real")\n', 'utf8')

  const args = { paths: ['.'] }
  const value = await runScan(args, workspace)

  assert.equal(value.scanned.files, 1)
  assert.deepEqual(value.findings.map((finding) => finding.path), ['app.js'])
  assert.deepEqual(value.scanned.skippedByReason, {
    'dot-directory': 1,
    extension: 2,
    scanignore: 2,
  })
  const counted = Object.values(value.scanned.skippedByReason).reduce((sum, count) => sum + count, 0)
  assert.equal(counted, value.scanned.skippedTotal)
  // The sample is capped, so its length is only comparable while the total is under `maxSkipped`.
  assert.equal(value.scanned.skipped.length, value.scanned.skippedTotal)

  // A malformed line is a diagnostic, not a skip: it is visible, and it moves no counter.
  assert.deepEqual(value.scanned.ignoreProblems, [{ line: 3, reason: 'malformed' }])

  const text = render(args, value)
  assert.match(text, /^Skipped 5 path\(s\): 2 extension, 2 scanignore, 1 dot-directory$/m)
  assert.match(text, /^Ignored 1 line in \.scanignore \(line 3: bad pattern\)$/m)
})

test('an unreadable .scanignore is reported and never fails the scan', async (t) => {
  const workspace = await tempDir(t)
  // A directory of that name: reading it fails on every platform, which is the case a caller cannot
  // fix from the outside. The scan must still run, with no patterns.
  await mkdir(join(workspace, '.scanignore'), { recursive: true })
  await writeFile(join(workspace, 'app.js'), 'document.write("kept")\n', 'utf8')

  const args = { paths: ['.'] }
  const value = await runScan(args, workspace)

  assert.equal(value.scanned.files, 1)
  assert.deepEqual(value.findings.map((finding) => finding.path), ['app.js'])
  assert.deepEqual(value.scanned.ignoreProblems, [{ line: null, reason: 'unreadable' }])
  // The directory named `.scanignore` is still a dot-directory to the walk; diagnostics stay apart.
  assert.deepEqual(value.scanned.skippedByReason, { 'dot-directory': 1 })
  const text = render(args, value)
  assert.match(text, /^Could not read \.scanignore; the scan ran without ignore patterns\.$/m)
})

test('the hygiene rules did not move any cap', () => {
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
    {
      maxPaths: 16,
      maxFiles: 200,
      maxFileBytes: 512 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxFindings: 200,
      maxSkipped: 100,
      maxSnippetChars: 160,
    },
  )
})


test('the exported extension allowlist has no prose extensions and keeps the code ones', () => {
  for (const prose of ['.md', '.mdx']) {
    assert.ok(!SCAN_LIMITS.extensions.includes(prose), `${prose} must not be scanned as code`)
  }
  for (const code of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro', '.json']) {
    assert.ok(SCAN_LIMITS.extensions.includes(code), `${code} must stay allowlisted`)
  }
})

test('a file over the size cap is skipped as large, and the walk keeps going', async (t) => {
  const workspace = await tempDir(t)
  // 20 000 × 28 bytes ≈ 560 kB: over the 512 kB per-file cap, with no marker inside.
  const filler = 'const filler = 1 // padding\n'.repeat(20000)
  assert.ok(Buffer.byteLength(filler) > 512 * 1024)
  await writeFile(join(workspace, 'huge.js'), filler, 'utf8')
  await writeFile(join(workspace, 'small.js'), 'document.write("kept")\n', 'utf8')

  const args = { paths: ['.'] }
  const value = await runScan(args, workspace)
  assert.equal(value.scanned.files, 1)
  assert.deepEqual(value.scanned.skipped, [{ path: 'huge.js', reason: 'large' }])
  assert.deepEqual(value.findings.map((finding) => finding.path), ['small.js'])
  assert.match(render(args, value), /^Skipped 1 path\(s\): 1 large$/m)
})

test('maxFindings and maxFiles tighten through limits and mark the result truncated', async () => {
  // The tool does not take limits, so the caps are checked on the module the tool calls.
  const full = await scan({ cwd: PACKAGE_DIR, paths: [DIRTY] })
  assert.equal(full.truncated, false)

  const findingsCapped = await scan({ cwd: PACKAGE_DIR, paths: [DIRTY], limits: { maxFindings: 2 } })
  assert.equal(findingsCapped.findings.length, 2)
  assert.equal(findingsCapped.truncated, true)
  // Enumeration is sorted first, so the cap keeps the lexicographically first findings.
  assert.deepEqual(findingsCapped.findings, full.findings.slice(0, 2))

  const filesCapped = await scan({ cwd: PACKAGE_DIR, paths: [DIRTY], limits: { maxFiles: 1 } })
  assert.equal(filesCapped.scanned.files, 1)
  assert.equal(filesCapped.scanned.truncated, true)
  assert.equal(filesCapped.truncated, true)
  assert.deepEqual(filesCapped.scanned.skipped, [{ path: `${DIRTY}/page.jsx`, reason: 'too-many' }])
})

test("rules: ['ls-01'] narrows the scan to that one rule", async () => {
  const args = { paths: [DIRTY], rules: ['ls-01'] }
  const value = await runScan(args)

  assert.equal(value.findings.length, 1)
  const [finding] = value.findings
  assert.equal(finding.ruleId, 'ls-01')
  assert.equal(finding.path, `${DIRTY}/styles.css`)
  assert.equal(finding.line, 3)

  const text = render(args, value)
  assert.match(text, /— 1 finding\(s\)/)
  assert.ok(!text.includes('ls-12'))
})

test('an unknown rule id is refused as unknown-rules without any filesystem work', async (t) => {
  const gone = join(await tempDir(t), 'no-such-workspace')
  const args = { paths: [DIRTY], rules: ['ls-01', 'ls-99'] }
  const value = await runScan(args, gone)

  assert.equal(value.error, 'unknown-rules')
  assert.deepEqual(value.unknown, ['ls-99'])
  assert.equal(value.rules.length, 33)
  assert.equal(value.rules[0], 'ls-01')
  assert.equal(value.rules.at(-1), 'ls-33')

  const text = render(args, value)
  assert.match(text, /^Error: unknown-rules — unknown rule id\(s\): ls-99\./)
  assert.match(text, /Valid ids run ls-01 … ls-33\./)

  // Control: the same unusable cwd with a valid rule set is a path-missing, so the refusal above
  // happened before the workspace was resolved.
  const control = await runScan({ paths: [DIRTY], rules: ['ls-01'] }, gone)
  assert.equal(control.error, 'path-missing')
})

test('two runs produce byte-identical findings, whatever order the roots are named in', async () => {
  const first = await runScan({ paths: [DIRTY, CLEAN] })
  const second = await runScan({ paths: [DIRTY, CLEAN] })
  assert.equal(JSON.stringify(first.findings), JSON.stringify(second.findings))

  const reversed = await runScan({ paths: [CLEAN, DIRTY] })
  assert.deepEqual(reversed.findings, first.findings)
  assert.equal(reversed.scanned.files, first.scanned.files)
})

test('the tool never writes: the fixture tree is identical after a scan', async () => {
  const root = join(PACKAGE_DIR, 'test', 'fixtures', 'scan')
  const before = await snapshot(root)
  assert.ok(before.length >= 3)

  const value = await runScan({ paths: [FIXTURES] })
  assert.ok(value.findings.length > 0)
  // Six code files: `dirty/` three, `clean/` one, `prose/legacy.js`, and `ignore-root/artifacts/page.html`.
  // The Markdown and the dot-directory are both skipped, which is what their fixtures exist to pin.
  assert.equal(value.scanned.files, 6)
  assert.deepEqual(
    value.scanned.skipped.map((entry) => [entry.path, entry.reason]),
    [
      [`${DOT_ROOT}/.hidden`, 'dot-directory'],
      [`${IGNORE_ROOT}/.scanignore`, 'extension'],
      [`${PROSE}/legacy.md`, 'extension'],
    ],
  )
  assert.deepEqual(value.scanned.skippedByReason, { 'dot-directory': 1, extension: 2 })

  const after = await snapshot(root)
  assert.deepEqual(after, before)
})

test('an empty paths array is refused as paths before the cwd is resolved', async (t) => {
  const gone = join(await tempDir(t), 'no-such-workspace')

  const args = { paths: [] }
  const value = await runScan(args, gone)
  assert.equal(value.error, 'paths')
  assert.match(render(args, value), /^Error: paths — Pass one to 16 explicit relative paths/m)

  // More paths than one call may carry is the same refusal, with the same lack of filesystem work.
  const tooMany = Array.from({ length: 17 }, (_, index) => `src/file-${index}.js`)
  const second = await runScan({ paths: tooMany }, gone)
  assert.equal(second.error, 'paths')
})

/** Two rules of this file's own, so a workspace can hold a run and a pair on the same line. */
const RUN_A = { id: 'ls-run-a', guideId: 'css', confidence: 'medium', message: 'Marker A.', source: 'runMarkerA' }
const RUN_B = { id: 'ls-run-b', guideId: 'css', confidence: 'medium', message: 'Marker B.', source: 'runMarkerB' }

test('a run of hits on neighbouring lines is one finding that carries the whole range', async (t) => {
  const workspace = await tempDir(t)
  await writeFile(join(workspace, 'ladder.css'), 'runMarkerA\nrunMarkerA\nrunMarkerA\n', 'utf8')

  const value = await scan({ cwd: workspace, paths: ['ladder.css'], rules: [RUN_A] })
  assert.equal(value.findings.length, 1)
  const [finding] = value.findings
  assert.equal(finding.line, 1)
  assert.deepEqual(finding.lines, [1, 2, 3])
  assert.equal(finding.occurrences, 3)
  // The range belongs to the finding, not to the text of the rule: the first hit keeps the wording.
  assert.equal(finding.snippet, 'runMarkerA')
  assert.equal(finding.message, RUN_A.message)
})

test('a blank line inside a block keeps the run, two untouched lines end it', async (t) => {
  const workspace = await tempDir(t)
  const file = [
    'runMarkerA', // 1
    'runMarkerA', // 2
    '', // 3
    'runMarkerA', // 4 — one line after line 2, still the same block
    '', // 5
    '', // 6
    'runMarkerA', // 7 — three lines after line 4, a new block
    'runMarkerA', // 8
    '',
  ].join('\n')
  await writeFile(join(workspace, 'ladder.css'), file, 'utf8')

  const value = await scan({ cwd: workspace, paths: ['ladder.css'], rules: [RUN_A] })
  assert.deepEqual(value.findings.map((finding) => finding.line), [1, 7])
  assert.deepEqual(value.findings.map((finding) => finding.lines), [[1, 2, 4], [7, 8]])
  assert.deepEqual(value.findings.map((finding) => finding.occurrences), [3, 2])
})

test('runs never cross a file or a rule, and a single hit keeps the same shape', async (t) => {
  const workspace = await tempDir(t)
  await writeFile(join(workspace, 'one.css'), 'runMarkerA\n', 'utf8')
  await writeFile(join(workspace, 'two.css'), 'runMarkerA\n', 'utf8')
  // Same line pair, different rules: one finding each, not a run of two.
  await writeFile(join(workspace, 'pair.css'), 'runMarkerA\nrunMarkerB\n', 'utf8')

  const value = await scan({ cwd: workspace, paths: ['.'], rules: [RUN_A, RUN_B] })
  assert.deepEqual(
    value.findings.map((finding) => [finding.path, finding.line, finding.occurrences]),
    [
      ['one.css', 1, 1],
      ['pair.css', 1, 1],
      ['pair.css', 2, 1],
      ['two.css', 1, 1],
    ],
  )
  assert.deepEqual(value.findings.map((finding) => finding.lines), [[1], [1], [2], [1]])
})

test('the renderer prints a range for a run and the old triple for a single hit', async (t) => {
  const workspace = await tempDir(t)
  // The ladder starts at line 306, the shape the live bench reported: eight hits, one finding.
  const ladder = Array.from({ length: 8 }, (_, index) => `:nth-child(${index + 1}) { animation-delay: ${index * 40}ms }`)
  const report = [...Array.from({ length: 305 }, () => ''), ...ladder].join('\n')
  await writeFile(join(workspace, 'report-template.css'), report, 'utf8')
  await writeFile(join(workspace, 'single.css'), 'a {\n  :nth-child(9) { color: red }\n}\n', 'utf8')

  const args = { paths: ['.'] }
  const value = await scan({ cwd: workspace, paths: ['.'] })
  assert.equal(value.findings.length, 2)
  assert.deepEqual(value.findings.map((finding) => finding.lines.length), [8, 1])

  const text = render(args, value)
  assert.match(text, /^- report-template\.css:306-313 ls-05 \(/m)
  assert.match(text, /^- single\.css:2:3 ls-05 \(/m)
})

test('a run with a gap prints its hit count, because the range would overclaim', async (t) => {
  const workspace = await tempDir(t)
  // Two hits with an untouched line between them: `110-112` alone would read as three hits. This is
  // the live bench shape — `display: -webkit-box` and `-webkit-box-orient` around a line-clamp line.
  await writeFile(
    join(workspace, 'card.css'),
    ['a {', '  :nth-child(1) { color: red }', '  -webkit-line-clamp: 3;', '  :nth-child(2) { color: blue }', '}', ''].join('\n'),
    'utf8',
  )

  const args = { paths: ['card.css'] }
  const value = await scan({ cwd: workspace, paths: ['card.css'] })
  assert.equal(value.findings.length, 1)
  assert.deepEqual(value.findings[0].lines, [2, 4])
  assert.equal(value.findings[0].occurrences, 2)

  const text = render(args, value)
  assert.match(text, /^- card\.css:2-4 \(2 hits\) ls-05 \(/m)
})

test('the suppression file is read only at the workspace root, never from a scanned path', async (t) => {
  // The read path is fixed by the contract, not steered by the caller: a `.suppress` a scan happens
  // to walk past is an ordinary skipped file, and one inside the scanned directory must never mute
  // anything. Otherwise "pass a different path" would change which mutes apply.
  const root = await tempDir(t, 'legacy-suppress-root-')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'legacy.js'), 'document.write("<p>hi</p>")\n', 'utf8')
  const before = await scan({ cwd: root, paths: ['src'] })
  const id = before.findings[0].siteId

  await writeFile(join(root, 'src', '.suppress'), JSON.stringify({ version: 1, entries: { [id]: { reason: 'nested', at: '2026-11-11' } } }), 'utf8')
  const inner = await scan({ cwd: root, paths: ['src'] })
  assert.equal(inner.suppressed, 0, 'a nested .suppress is not the suppression file')
  assert.equal(inner.findings[0].suppressed, undefined)
  assert.equal(inner.scanned.skippedByReason.dot ?? 0, 0)

  await writeFile(join(root, '.suppress'), JSON.stringify({ version: 1, entries: { [id]: { reason: 'root', at: '2026-11-11' } } }), 'utf8')
  const outer = await scan({ cwd: root, paths: ['src'] })
  assert.equal(outer.suppressed, 1, 'the workspace-root file is the one that mutes')
})
