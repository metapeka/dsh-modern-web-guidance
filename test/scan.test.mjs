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
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { ScanError, scan } from '../lib/scan.js'
import { PACKAGE_DIR } from './paths.mjs'

/** Fixture roots, named as cwd-relative paths: the report echoes them back verbatim. */
const FIXTURES = 'test/fixtures/scan'
const DIRTY = `${FIXTURES}/dirty`
const CLEAN = `${FIXTURES}/clean`

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

test('a directory scan reports several rules across two files, and the renderer summarises them', async () => {
  const args = { paths: [DIRTY] }
  const value = await runScan(args)

  assert.equal(value.error, undefined)
  assert.equal(value.format, 'summary')
  assert.equal(value.cwd, PACKAGE_DIR)
  assert.equal(value.scanned.files, 2)
  assert.equal(value.scanned.skipped.length, 0)
  assert.equal(value.truncated, false)

  const paths = [...new Set(value.findings.map((finding) => finding.path))].sort()
  assert.deepEqual(paths, [`${DIRTY}/page.html`, `${DIRTY}/styles.css`])

  // The fixtures deliberately carry five markers spanning five rules, in both files.
  assert.equal(value.findings.length, 5)
  const ruleIds = [...new Set(value.findings.map((finding) => finding.ruleId))].sort()
  assert.deepEqual(ruleIds, ['ls-01', 'ls-12', 'ls-13', 'ls-14', 'ls-15'])
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
  assert.match(text, /^Scanned 2 file\(s\) \(\d+ B\) — 5 finding\(s\)\./m)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/styles\.css:2:17 ls-01 \(high\) /)
  assert.match(text, /- test\/fixtures\/scan\/dirty\/styles\.css:7:3 ls-12 \(high\) /)
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
  assert.match(render(args, value), /2 file\(s\) skipped/)
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
  assert.match(render(args, value), /1 file\(s\) skipped/)
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
  assert.deepEqual(filesCapped.scanned.skipped, [{ path: `${DIRTY}/styles.css`, reason: 'too-many' }])
})

test("rules: ['ls-01'] narrows the scan to that one rule", async () => {
  const args = { paths: [DIRTY], rules: ['ls-01'] }
  const value = await runScan(args)

  assert.equal(value.findings.length, 1)
  const [finding] = value.findings
  assert.equal(finding.ruleId, 'ls-01')
  assert.equal(finding.path, `${DIRTY}/styles.css`)
  assert.equal(finding.line, 2)

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
  assert.equal(value.rules.length, 30)
  assert.equal(value.rules[0], 'ls-01')
  assert.equal(value.rules.at(-1), 'ls-30')

  const text = render(args, value)
  assert.match(text, /^Error: unknown-rules — unknown rule id\(s\): ls-99\./)
  assert.match(text, /Valid ids run ls-01 … ls-30\./)

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
  assert.equal(value.scanned.files, 3)

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
