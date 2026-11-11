/**
 * Suppression, end to end: the file the reader honours, what one scan reports about it, and what the
 * counters must never make of it.
 *
 * The rule these tests exist to protect is one sentence long: **a suppressed finding is muted, not
 * fixed**. So every scan assertion checks both halves — the finding is still in `findings`, still
 * counted, still in the counters' `sites`, and only its `suppressed` flag and the result's
 * `suppressed` count are new. The comparison tests come last because a mute that could read as a fix
 * would be the one failure no later layer could detect: phase B's numbers would simply be a lie.
 *
 * The file itself is pinned through `lib/suppress.js` (grammar, caps, canonical bytes), the wiring
 * through `lib/scan.js` (`siteId` on every finding, the reader's five failure modes, `.scanignore`
 * precedence), and the reporting through the tool's own renderer and `createTelemetry` — never a
 * copy of a message or a number that lives in the modules.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { RULES } from '../lib/scan-rules.js'
import { scan } from '../lib/scan.js'
import { siteId } from '../lib/site.js'
import {
  clampReason,
  MAX_REASON_CHARS,
  MAX_SUPPRESSIONS,
  MAX_SUPPRESS_BYTES,
  MAX_SUPPRESS_PROBLEMS,
  parseSuppressions,
  removeSuppression,
  reviewSuppressions,
  serializeSuppressions,
  SUPPRESS_FILE,
} from '../lib/suppress.js'
import { classifyCall, createTelemetry } from '../lib/telemetry.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

/** The marker `ls-17` exists to catch: one hit, one finding, one site. */
const WRITE = 'document.write("<p>hi</p>")'
/** The marker `ls-13` catches: same file, different rule, so "muted exactly one" is provable. */
const MODAL = '<div class="modal">hi</div>'
/** `ls-17` fires on this snippet, so a key built from it is a real finding's key. */
const WRITE_KEY = siteId('src/legacy.js', 'ls-17', WRITE)

const CATALOG = { total: 0, byCategory: {}, ids: [], categoryOf: {}, version: 'test', snapshotDate: '2026-11-08' }

/** The workspace the counters attribute these scans to; a bucket is what carries a history. */
const ALPHA = { id: 'aaaa1111', name: 'app' }

/** A throwaway workspace outside the package, removed when its test ends. */
async function workspace(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'suppress-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, contents, 'utf8')
  }
  return root
}

/** Write a `.suppress` document from entries, as the confirmed command would. */
async function writeSuppress(root, entries) {
  await writeFile(join(root, SUPPRESS_FILE), serializeSuppressions(entries), 'utf8')
}

/** A raw `.suppress`, for the files a writer must never produce. */
async function writeRawSuppress(root, contents) {
  await writeFile(join(root, SUPPRESS_FILE), contents, 'utf8')
}

/** Every file under `root`, with the digest and mtime a write would move. */
async function digestTree(root) {
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
      const bytes = await readFile(absolute)
      rows.push(`${relativePath} ${bytes.length} ${info.mtimeMs} ${createHash('sha256').update(bytes).digest('hex')}`)
    }
  }
  await visit(root, '')
  return rows
}

/** Apply the plugin once, so the renderer and the command under test are the ones the host receives. */
function host() {
  const tools = []
  const commands = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    skills: { register() { return () => {} } },
    get(service) { return service === 'commands' ? { register(definition) { commands.push(definition); return () => {} } } : undefined },
    effect(create) { return create() },
    on() {},
    off() {},
  }
  apply(ctx, { enabled: false })
  const tool = tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
  const command = commands.find((entry) => entry.name === 'guidance-suppress')
  const scanCommand = commands.find((entry) => entry.name === 'guidance-scan')
  assert.ok(tool !== undefined)
  assert.ok(command !== undefined)
  assert.ok(scanCommand !== undefined)
  return { tool, command, scanCommand }
}

/** Run the tool as the host would and hand back its value and its rendered text. */
async function runScan(cwd, args = {}) {
  const { tool } = host()
  const value = await tool.execute(args, { agent: { session: { header: { cwd } } } })
  return { value, text: tool.output.render(args, value)[0].text }
}

/** Run `/guidance-suppress` as the panel does, in one workspace. */
async function runSuppress(cwd, rawInput) {
  const { command } = host()
  return command.handler({ rawInput, agent: { session: { header: { cwd } } } })
}

/** An in-memory store for the counters, so no profile is touched. */
function memoryStore(seed = null) {
  const store = {
    state: seed,
    async load() { return store.state },
    async save(state) { store.state = JSON.parse(JSON.stringify(state)) },
  }
  return store
}

function telemetryWith(store = memoryStore()) {
  return { store, telemetry: createTelemetry({ store, clock: () => NOW, retentionDays: 90, ringLimit: 1000, catalog: CATALOG }) }
}

/** One completed scan as the host records it: the value, classified, stamped, attributed. */
function scanRecord(value, at = NOW, workspace = ALPHA) {
  return {
    at,
    tool: 'web_guidance_legacy_scan',
    workspace,
    ...classifyCall({ tool: 'web_guidance_legacy_scan', value }),
  }
}

// --- The file: grammar, caps, canonical bytes ------------------------------------------------

test('the documented document parses, and a hand-added member is not a problem', () => {
  const parsed = parseSuppressions(JSON.stringify({
    version: 1,
    entries: { '96cb61de': { reason: 'legacy demo page', at: '2026-11-11', extra: 'ignored' } },
  }))

  assert.deepEqual([...parsed.entries.keys()], ['96cb61de'])
  assert.deepEqual(parsed.entries.get('96cb61de'), { reason: 'legacy demo page', at: '2026-11-11' })
  assert.deepEqual(parsed.problems, [])
})

test('a valid key with a blank or missing member still mutes, because the key is the decision', () => {
  const parsed = parseSuppressions(JSON.stringify({
    version: 1,
    entries: { '96cb61de': {}, '0519e373': { reason: '   ', at: 'yesterday' } },
  }))

  assert.deepEqual([...parsed.entries.keys()], ['96cb61de', '0519e373'])
  assert.deepEqual(parsed.entries.get('96cb61de'), { reason: '', at: '' })
  // A reason is trimmed, an `at` left exactly as stored: it is commentary, not a matcher.
  assert.deepEqual(parsed.entries.get('0519e373'), { reason: '', at: 'yesterday' })
  assert.deepEqual(parsed.problems, [])
})

test('a bad key or a non-object entry is dropped with one problem, and the good entries apply', () => {
  const parsed = parseSuppressions(JSON.stringify({
    version: 1,
    entries: {
      '96cb61de': { reason: 'kept' },
      'not-a-key': { reason: 'dropped' },
      'ABCDEF12': { reason: 'uppercase is not a key' },
      '0519e373': 'just a string',
      'd41d8cd9': { reason: 'kept too' },
    },
  }))

  assert.deepEqual([...parsed.entries.keys()], ['96cb61de', 'd41d8cd9'])
  assert.deepEqual(parsed.problems, [
    { key: 'not-a-key', reason: 'invalid' },
    { key: 'ABCDEF12', reason: 'invalid' },
    { key: '0519e373', reason: 'invalid' },
  ])
})

test('a file-level failure mutes nothing and names one raw problem', () => {
  const cases = [
    ['', 'malformed'],
    ['not json at all', 'malformed'],
    ['null', 'malformed'],
    ['[]', 'malformed'],
    ['"a string"', 'malformed'],
    ['{"version":1}', 'malformed'],
    ['{"version":1,"entries":[]}', 'malformed'],
    ['{"version":1,"entries":{"96cb61de":{}}}', null],
  ]
  for (const [text, reason] of cases) {
    const parsed = parseSuppressions(text)
    if (reason === null) {
      assert.deepEqual([...parsed.entries.keys()], ['96cb61de'], text)
      assert.deepEqual(parsed.problems, [], text)
      continue
    }
    assert.equal(parsed.entries.size, 0, text)
    assert.deepEqual(parsed.problems, [{ key: null, reason }], text)
  }
})

test('any version but 1 mutes nothing and says version, before the entries are interpreted', () => {
  for (const document of [
    { version: 2, entries: { '96cb61de': {} } },
    { version: 0, entries: { '96cb61de': {} } },
    { version: '1', entries: { '96cb61de': {} } },
    { entries: { '96cb61de': {} } },
  ]) {
    const parsed = parseSuppressions(JSON.stringify(document))
    assert.equal(parsed.entries.size, 0, JSON.stringify(document))
    assert.deepEqual(parsed.problems, [{ key: null, reason: 'version' }], JSON.stringify(document))
  }
})

test('a leading BOM is stripped, and a CRLF file parses like the same document with LF', () => {
  const text = '\uFEFF{"version":1,"entries":{"96cb61de":{"reason":"a","at":"2026-11-11"}}}'
  assert.deepEqual([...parseSuppressions(text).entries.keys()], ['96cb61de'])
  const crlf = '{"version":1,\r\n"entries":{"96cb61de":{"reason":"a"}}}\r\n'
  assert.deepEqual(parseSuppressions(crlf).problems, [])
  assert.deepEqual([...parseSuppressions(crlf).entries.keys()], ['96cb61de'])
})

test('the problem list is capped, and a long invalid key is quoted clipped', () => {
  const entries = {}
  for (let index = 0; index < MAX_SUPPRESS_PROBLEMS + 5; index += 1) entries[`bad-key-${index}`] = {}
  entries['x'.repeat(300)] = {}

  const parsed = parseSuppressions(JSON.stringify({ version: 1, entries }))
  assert.equal(parsed.problems.length, MAX_SUPPRESS_PROBLEMS)
  assert.equal(parsed.entries.size, 0)
  const long = parseSuppressions(JSON.stringify({ version: 1, entries: { ['y'.repeat(300)]: {} } })).problems[0]
  assert.equal(long.reason, 'invalid')
  assert.ok(long.key.length < 80, 'a corrupt file must not echo its own size into a report')
  assert.match(long.key, /…$/)
})

test('serialize is canonical, sorted, two-space and newline-terminated, and round-trips', () => {
  const entries = new Map([
    ['d41d8cd9', { reason: 'second', at: '2026-11-11' }],
    ['0519e373', { reason: '', at: '' }],
  ])
  const text = serializeSuppressions(entries)

  assert.equal(text, [
    '{',
    '  "version": 1,',
    '  "entries": {',
    '    "0519e373": {',
    '      "reason": "",',
    '      "at": ""',
    '    },',
    '    "d41d8cd9": {',
    '      "reason": "second",',
    '      "at": "2026-11-11"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'))
  assert.equal(serializeSuppressions({}), '{\n  "version": 1,\n  "entries": {}\n}\n')
  const reparsed = parseSuppressions(text)
  assert.deepEqual(Object.fromEntries(reparsed.entries), Object.fromEntries(entries))
  assert.deepEqual(reparsed.problems, [])
  // The canonical form is a fixed point: writing it again changes nothing.
  assert.equal(serializeSuppressions(reparsed.entries), text)
})

test('a reason is one line and at most MAX_REASON_CHARS, clamped before it is shown', () => {
  assert.equal(clampReason('  two\nlines\tand spaces  '), 'two lines and spaces')
  assert.equal(clampReason('a'.repeat(MAX_REASON_CHARS + 50)).length, MAX_REASON_CHARS)
  assert.match(clampReason('a'.repeat(MAX_REASON_CHARS + 50)), /…$/)
  assert.equal(clampReason(undefined), '')
  assert.equal(clampReason('short'), 'short')
})

test('the caps are the contract\'s, and the site identity is the golden one', () => {
  assert.equal(MAX_SUPPRESSIONS, 200)
  assert.equal(MAX_REASON_CHARS, 200)
  assert.equal(MAX_SUPPRESS_BYTES, 256 * 1024)
  assert.equal(MAX_SUPPRESS_PROBLEMS, 20)
  assert.equal(SUPPRESS_FILE, '.suppress')
  assert.equal(siteId('src/app.css', 'ls-13', '::-webkit-scrollbar'), '96cb61de')
  assert.equal(WRITE_KEY, siteId('src/legacy.js', 'ls-17', WRITE))
})

// --- One scan: the two members, and nothing else --------------------------------------------

test('without the file a scan reports suppressed: 0, no problems and a siteId on every finding', async (t) => {
  const root = await workspace(t, {
    'src/legacy.js': `${WRITE}\n`,
    'src/styles.css': `${MODAL}\n`,
  })

  const first = await scan({ cwd: root, paths: ['src'] })
  assert.equal(first.suppressed, 0)
  assert.equal('suppressProblems' in first, false)
  for (const finding of first.findings) {
    assert.match(finding.siteId, /^[0-9a-f]{8}$/)
    assert.equal('suppressed' in finding, false, 'absent, not false')
  }

  // Writing a suppression file changes the scan only by the skip the walk now records for it.
  await writeSuppress(root, new Map([['deadbeef', { reason: 'nothing matches this', at: '2026-11-11' }]]))
  const second = await scan({ cwd: root, paths: ['src'] })
  assert.equal(second.suppressed, 0)
  assert.deepEqual(second.findings, first.findings)
  assert.deepEqual(second.guides, first.guides)
  assert.equal(second.scanned.files, first.scanned.files)
  assert.equal(second.scanned.bytes, first.scanned.bytes)
  assert.equal(second.truncated, first.truncated)
})

test('a matching key mutes exactly that finding: flagged, still listed, counted, and rendered apart', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n`, 'src/styles.css': `${MODAL}\n` })
  const before = await scan({ cwd: root, paths: ['src'] })
  const muted = before.findings.find((finding) => finding.ruleId === 'ls-17')
  assert.ok(muted !== undefined)
  await writeSuppress(root, new Map([[muted.siteId, { reason: 'legacy page, tracked in #412', at: '2026-11-11' }]]))

  const { value, text } = await runScan(root, { paths: ['src'] })
  assert.equal(value.suppressed, 1)
  assert.equal('suppressProblems' in value, false)
  // The list is unchanged, member for member: the only difference is one added flag.
  assert.equal(value.findings.length, before.findings.length)
  assert.deepEqual(value.findings.map((finding) => finding.siteId), before.findings.map((finding) => finding.siteId))
  assert.deepEqual(value.guides, before.guides)
  const flagged = value.findings.filter((finding) => finding.suppressed === true)
  assert.deepEqual(flagged.map((finding) => finding.siteId), [muted.siteId])
  assert.equal(flagged[0].message, muted.message)

  // The summary keeps the finding count and adds the subset; the muted row says so after its message.
  assert.match(text, /^Scanned 2 file\(s\) \(\d+ B\) — 2 finding\(s\), 1 suppressed\./m)
  const row = text.split('\n').find((line) => line.includes(muted.siteId) === false && line.startsWith(`- ${muted.path}:`))
  assert.ok(row.endsWith(' (suppressed)'), row)
  assert.equal(text.includes('Suppression file:'), false)
})

test('the mute is the site, not the rule and not the file', async (t) => {
  const root = await workspace(t, {
    'src/legacy.js': `${WRITE}\n`,
    'src/other.js': `${WRITE}\n`,
    'src/mixed.js': `${WRITE}\n${MODAL}\n`,
  })
  const twoRules = RULES.filter((rule) => rule.id === 'ls-17' || rule.id === 'ls-13')
  const before = await scan({ cwd: root, paths: ['src'], rules: twoRules })
  const target = before.findings.find((finding) => finding.path === 'src/legacy.js' && finding.ruleId === 'ls-17')
  await writeSuppress(root, new Map([[target.siteId, { reason: 'one page only', at: '2026-11-11' }]]))

  const after = await scan({ cwd: root, paths: ['src'], rules: twoRules })
  const muted = after.findings.filter((finding) => finding.suppressed === true)
  assert.equal(after.suppressed, 1)
  assert.deepEqual(muted.map((finding) => [finding.path, finding.ruleId]), [['src/legacy.js', 'ls-17']])
  // The same rule in another file is not muted, and the other rule in the same file is not muted.
  assert.equal(after.findings.some((finding) => finding.path === 'src/other.js' && finding.suppressed === true), false)
  assert.equal(
    after.findings.some((finding) => finding.path === 'src/mixed.js' && finding.ruleId === 'ls-13' && finding.suppressed === true),
    false,
  )
})

test('two good entries and one bad one: both mute, the bad one is a problem, the rest apply', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n`, 'src/styles.css': `${MODAL}\n` })
  const before = await scan({ cwd: root, paths: ['src'] })
  const keys = before.findings.map((finding) => finding.siteId)
  await writeSuppress(root, new Map([
    [keys[0], { reason: 'first', at: '2026-11-11' }],
    [keys[1], { reason: 'second', at: '2026-11-11' }],
  ]))
  // Hand-edit one bad entry into `entries`, as a reviewer might.
  const text = await readFile(join(root, SUPPRESS_FILE), 'utf8')
  await writeRawSuppress(root, text.replace('"entries": {', '"entries": {\n    "not-a-key": {},', 1))

  const { value, text: rendered } = await runScan(root, { paths: ['src'] })
  assert.equal(value.suppressed, 2)
  assert.deepEqual(value.suppressProblems, [{ key: 'not-a-key', reason: 'invalid' }])
  assert.match(rendered, /^Suppression file: 1 entry ignored; the rest applied\.$/m)
})

test('every file-level failure leaves the findings exactly as they were and prints one token', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const before = await scan({ cwd: root, paths: ['src'] })
  const key = before.findings[0].siteId

  const cases = [
    ['{ not json', 'malformed'],
    ['{"version":2,"entries":{}}', 'version'],
    [JSON.stringify({ version: 1, entries: { [key]: { reason: 'x' } } }).slice(0, 12), 'malformed'],
  ]
  for (const [contents, token] of cases) {
    await writeRawSuppress(root, contents)
    const { value, text } = await runScan(root, { paths: ['src'] })
    assert.equal(value.suppressed, 0, contents)
    assert.deepEqual(value.suppressProblems, [{ key: null, reason: token }], contents)
    assert.deepEqual(value.findings.map((finding) => finding.siteId), before.findings.map((finding) => finding.siteId))
    assert.deepEqual(value.findings.map((finding) => finding.message), before.findings.map((finding) => finding.message))
    assert.match(text, new RegExp(`^Suppression file: ${token}; nothing is muted this scan\\.$`, 'm'))
  }
})

test('a file over the size guard mutes nothing, and no byte of it is trusted', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const raw = Buffer.alloc(MAX_SUPPRESS_BYTES + 1, 0x20)
  await writeFile(join(root, SUPPRESS_FILE), raw)

  const { value } = await runScan(root, { paths: ['src'] })
  assert.equal(value.suppressed, 0)
  assert.deepEqual(value.suppressProblems, [{ key: null, reason: 'too-large' }])
})

test('a file that is not valid UTF-8 is malformed, not a mangled mute', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  await writeFile(join(root, SUPPRESS_FILE), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]))

  const { value } = await runScan(root, { paths: ['src'] })
  assert.equal(value.suppressed, 0)
  assert.deepEqual(value.suppressProblems, [{ key: null, reason: 'malformed' }])
})

test('a symlinked suppression file is refused rather than followed', async (t) => {
  const outside = await workspace(t, { 'real.suppress': serializeSuppressions({ deadbeef: { reason: 'x', at: '' } }) })
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  try {
    await symlink(join(outside, 'real.suppress'), join(root, SUPPRESS_FILE), 'file')
  } catch (error) {
    // Creating a symlink needs a privilege a plain Windows account does not have. The refusal is
    // still the behaviour under test, so the case is skipped rather than silently dropped.
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('this account cannot create a symlink')
      return
    }
    throw error
  }

  const { value } = await runScan(root, { paths: ['src'] })
  assert.equal(value.suppressed, 0)
  assert.deepEqual(value.suppressProblems, [{ key: null, reason: 'unreadable' }])
})

test('.scanignore wins by running first: an ignored file has no finding left to mute', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n`, 'src/styles.css': `${MODAL}\n` })
  const before = await scan({ cwd: root, paths: ['src'] })
  const muted = before.findings.find((finding) => finding.ruleId === 'ls-17')
  await writeSuppress(root, new Map([[muted.siteId, { reason: 'ignored anyway', at: '2026-11-11' }]]))
  assert.equal((await scan({ cwd: root, paths: ['src'] })).suppressed, 1)

  await writeFile(join(root, '.scanignore'), 'src/legacy.js\n', 'utf8')
  const after = await scan({ cwd: root, paths: ['src'] })
  assert.equal(after.findings.some((finding) => finding.path === 'src/legacy.js'), false)
  assert.equal(after.suppressed, 0)
  // The entry is still there, still valid and still inert: precedence is execution order, not policy.
  assert.deepEqual(after.suppressProblems ?? [], [])
})

test('a truncated scan counts only the findings it returned', async (t) => {
  const root = await workspace(t, { 'src/a.js': `${WRITE}\n`, 'src/b.js': `${WRITE}\n` })
  const before = await scan({ cwd: root, paths: ['src'] })
  await writeSuppress(root, new Map(before.findings.map((finding) => [finding.siteId, { reason: 'both', at: '2026-11-11' }])))

  const capped = await scan({ cwd: root, paths: ['src'], limits: { maxFindings: 1 } })
  assert.equal(capped.findings.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.suppressed, 1)
  assert.ok(capped.suppressed <= capped.findings.length)
})

test('a scan reads the file and writes nothing: bytes, mtime and the tree are unchanged', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const before = await scan({ cwd: root, paths: ['.'] })
  await writeSuppress(root, new Map([[before.findings[0].siteId, { reason: 'kept', at: '2026-11-11' }]]))
  const snapshot = await digestTree(root)

  const first = await scan({ cwd: root, paths: ['.'] })
  const second = await scan({ cwd: root, paths: ['.'] })
  assert.equal(first.suppressed, 1)
  assert.equal(second.suppressed, 1)
  assert.deepEqual(await digestTree(root), snapshot, 'a scan must never write, move or create a file')
})

// --- The counters: a mute is never a fix ----------------------------------------------------

test('classifyCall counts muted findings and their rules while keeping every site', () => {
  const id = siteId('src/app.css', 'ls-13', '::-webkit-scrollbar')
  const other = siteId('src/other.css', 'ls-08', 'color-scheme: dark')
  const classified = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: {
      scanned: { files: 2 },
      findings: [
        { path: 'src/app.css', ruleId: 'ls-13', guideId: 'css', snippet: '::-webkit-scrollbar', suppressed: true },
        { path: 'src/app.css', ruleId: 'ls-13', guideId: 'css', snippet: '::-webkit-scrollbar' },
        { path: 'src/other.css', ruleId: 'ls-08', guideId: 'css', snippet: 'color-scheme: dark' },
      ],
    },
  })

  assert.equal(classified.findings, 3, 'a muted finding is still a finding')
  assert.equal(classified.suppressed, 1)
  assert.deepEqual(classified.suppressedRules, { 'ls-13': 1 })
  // Both of these are the diff's guarantee: the muted site is in the map like any other.
  assert.deepEqual(classified.sites, { 'ls-08': [other], 'ls-13': [id] })
  assert.equal(classified.sitesComplete, true)
  assert.deepEqual(classified.ruleCounts, { 'ls-13': 2, 'ls-08': 1 })
})

test('a muted site is still open in the comparison, never resolved', async () => {
  const { telemetry } = telemetryWith()
  const baseline = {
    scanned: { files: 2 },
    findings: [
      { path: 'src/a.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' },
      { path: 'src/b.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' },
    ],
  }
  await telemetry.record(scanRecord(baseline, NOW - DAY))

  const muted = {
    scanned: { files: 2 },
    findings: [
      { path: 'src/a.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar', suppressed: true },
      { path: 'src/b.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' },
    ],
    suppressed: 1,
  }
  await telemetry.record(scanRecord(muted, NOW))

  const snapshot = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(snapshot.lastScan.suppressed, 1)
  assert.deepEqual(snapshot.lastScan.suppressedRules, { 'ls-13': 1 })
  assert.equal(snapshot.lastScan.findings, 2)
  // The whole point: 0 no longer present, 2 still open. A mute is not a disappearance.
  assert.deepEqual(snapshot.scanDiff.resolved, 0)
  assert.deepEqual(snapshot.scanDiff.stillOpen, 2)
  assert.deepEqual(snapshot.scanDiff.new, 0)
  assert.equal(snapshot.scanHistory.at(0).suppressed, 1)
  assert.equal(snapshot.scanHistory.at(1).suppressed, 0)
})

test('a suppressed site that also disappeared resolves like any other site, never resurrected', async () => {
  const { telemetry } = telemetryWith()
  await telemetry.record(scanRecord({
    scanned: { files: 2 },
    findings: [
      { path: 'src/a.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' },
      { path: 'src/b.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' },
    ],
  }, NOW - DAY))

  // Both baseline sites are gone from this scan: one was really fixed, one was muted and then fixed.
  // The muted one resolves like any other absent site; nothing is resurrected from the baseline.
  await telemetry.record(scanRecord({
    scanned: { files: 2 },
    findings: [
      { path: 'src/c.css', ruleId: 'ls-08', snippet: 'color-scheme: dark' },
    ],
    suppressed: 1,
  }, NOW))

  const snapshot = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(snapshot.scanDiff.resolved, 2)
  assert.equal(snapshot.scanDiff.stillOpen, 0)
  assert.equal(snapshot.scanDiff.new, 1)
})

test('suppression never becomes a lifetime counter, and scanByDay keeps its three numbers', async () => {
  const { telemetry, store } = telemetryWith()
  await telemetry.record(scanRecord({
    scanned: { files: 1 },
    findings: [
      { path: 'src/a.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar', suppressed: true },
      { path: 'src/b.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' },
    ],
    suppressed: 1,
  }))

  await telemetry.flush()
  const bucket = Object.values(store.state.workspaces)[0]
  assert.deepEqual(bucket.scanByDay[Object.keys(bucket.scanByDay)[0]], { scans: 1, files: 1, findings: 2 })
  // The muted finding still adds to the lifetime rule debt: it is a finding, so it is counted once.
  assert.equal(bucket.scanRules['ls-13'], 2)
  assert.equal('scanSuppressed' in bucket, false)
  assert.equal('suppression' in bucket, false)
})

test('normalizeState drops a malformed count and clamps one that exceeds its findings', async () => {
  const seed = {
    version: 1,
    since: NOW,
    calls: 0,
    byDay: {},
    byTool: {},
    byOutcome: {},
    byCategory: {},
    retrieved: {},
    scanRules: { 'ls-13': 2 },
    scanGuides: {},
    lastScan: {
      at: new Date(NOW - 1000).toISOString(),
      files: 1,
      findings: 3,
      rules: ['ls-13'],
      suppressed: 500,
      suppressedRules: { 'ls-13': 500, bad: 2, '': 1 },
    },
    workspaces: {
      aaaa1111: {
        name: 'app',
        since: NOW,
        scanRules: {},
        scanGuides: {},
        lastScan: { at: new Date(NOW - 1000).toISOString(), files: 1, findings: 2, rules: [], suppressed: 'lots' },
        scanByDay: {},
        ruleFirstSeen: {},
        ruleLastSeen: {},
        scanHistory: [{ at: new Date(NOW - 1000).toISOString(), outcome: 'findings', files: 1, findings: 2, suppressed: 99, ruleFirstSeen: {} }],
        lastSites: null,
        scanDiff: { against: null, partial: 'no-baseline' },
      },
    },
    recent: [],
  }
  const { telemetry, store } = telemetryWith(memoryStore(seed))

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.equal(snapshot.lastScan.suppressed, 3, 'a subset cannot exceed its whole')
  // The split adds up to 502 mutes for a 3-finding scan: it contradicts the count, so it is dropped
  // and only the claim the counters can defend survives.
  assert.equal('suppressedRules' in snapshot.lastScan, false)

  await telemetry.flush()
  assert.equal(store.state.version, 1)
  assert.equal('suppressed' in Object.values(store.state.workspaces)[0].lastScan, false)
  assert.equal(store.state.workspaces.aaaa1111.scanHistory[0].suppressed, 2)
})

test('a consistent split survives normalisation, and a zero count never gains one', async () => {
  const seed = {
    version: 1,
    since: NOW,
    calls: 0,
    byDay: {},
    byTool: {},
    byOutcome: {},
    byCategory: {},
    retrieved: {},
    scanRules: {},
    scanGuides: {},
    lastScan: {
      at: new Date(NOW - 1000).toISOString(),
      files: 2,
      findings: 4,
      rules: ['ls-13'],
      suppressed: 2,
      suppressedRules: { 'ls-08': 1, 'ls-13': 1, '': 4 },
    },
    recent: [],
  }
  const { telemetry } = telemetryWith(memoryStore(seed))

  const snapshot = await telemetry.snapshot({ days: 7 })
  assert.equal(snapshot.lastScan.suppressed, 2)
  assert.deepEqual(snapshot.lastScan.suppressedRules, { 'ls-08': 1, 'ls-13': 1 })

  const zero = { ...seed, lastScan: { ...seed.lastScan, suppressed: 0 } }
  const clean = await telemetryWith(memoryStore(zero)).telemetry.snapshot({ days: 7 })
  assert.equal(clean.lastScan.suppressed, 0)
  assert.equal('suppressedRules' in clean.lastScan, false)
})

test('an aggregate shows one bucket\'s own last scan and never adds suppressed counts up', async () => {
  const { telemetry } = telemetryWith()
  const scanWithOneMute = (path, snippet) => ({
    scanned: { files: 1 },
    findings: [
      { path, ruleId: 'ls-13', snippet, suppressed: true },
      { path: '.strip{}', ruleId: 'ls-13', snippet: 'one' },
    ],
    suppressed: 1,
  })
  await telemetry.record({ ...scanRecord(scanWithOneMute('src/a.css', '::-webkit-scrollbar'), NOW - DAY), workspace: { id: 'aaaa1111', name: 'app' } })
  await telemetry.record({ ...scanRecord(scanWithOneMute('src/b.css', '::-webkit-scrollbar'), NOW), workspace: { id: 'bbbb2222', name: 'site' } })

  const all = await telemetry.snapshot({ days: 7 })
  assert.equal(all.workspace, null)
  assert.equal(all.lastScan.suppressed, 1, 'one scan\'s count is not a total')
  assert.equal(all.lastScan.findings, 2)
})

test('a refused scan writes nothing: no suppressed count appears from a refusal', async () => {
  const { telemetry } = telemetryWith()
  await telemetry.record(scanRecord({ scanned: { files: 1 }, findings: [{ path: 'src/a.css', ruleId: 'ls-13', snippet: '::-webkit-scrollbar' }], suppressed: 0 }))
  const refused = classifyCall({
    tool: 'web_guidance_legacy_scan',
    value: { error: 'path-absolute', subject: '/etc/passwd', message: 'Use paths relative to the workspace.' },
  })
  await telemetry.record({ at: NOW + DAY, tool: 'web_guidance_legacy_scan', ...refused })

  const snapshot = await telemetry.snapshot({ days: 7, workspace: ALPHA.id })
  assert.equal(snapshot.lastScan.suppressed, 0)
  assert.equal(snapshot.scanHistory.length, 1)
})

// --- The command: two lines, one plan and one write ------------------------------------------

test('the panel\'s two lines exist, and --dry-run prints the plan and writes nothing', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const { value } = await runScan(root, { paths: ['src'] })
  const id = value.findings[0].siteId
  const file = join(root, SUPPRESS_FILE)

  const planned = await runSuppress(root, `${id} --dry-run`)
  assert.equal(planned.kind, 'success')
  // One paragraph, because the panel renders this text verbatim in one node: file, payload, counts,
  // and the promise that nothing was written all in complete sentences.
  assert.equal(planned.text.includes('\n'), false)
  assert.match(planned.text, new RegExp(`^Suppression plan for ${id}: append \\{"reason":"","at":"\\d{4}-\\d{2}-\\d{2}"\\} to `))
  assert.ok(planned.text.includes(` to ${file}, which would go from 0 to 1 entry (cap 200).`), 'the plan names the absolute file and the headroom')
  assert.match(planned.text, /Nothing has been written; run the same line without --dry-run to write it\.$/)
  assert.equal(await readdir(root).then((entries) => entries.includes(SUPPRESS_FILE)), false)

  const applied = await runSuppress(root, id)
  assert.equal(applied.kind, 'success')
  assert.match(applied.text, new RegExp(`Suppressed ${id} in `))
  assert.match(applied.text, /muted, not fixed/)
  const written = parseSuppressions(await readFile(file, 'utf8'))
  assert.deepEqual([...written.entries.keys()], [id])
  assert.deepEqual(written.problems, [])

  const again = await runSuppress(root, id)
  assert.equal(again.kind, 'success', 'already present is the named no-op, not an error')
  assert.match(again.text, new RegExp(`Already present: ${id} is in .*nothing was written\\.`))
  assert.deepEqual([...parseSuppressions(await readFile(file, 'utf8')).entries.keys()], [id])
})

test('the plan is the payload, and the confirmation writes exactly that: a mute takes effect on the next scan', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n`, 'src/styles.css': `${MODAL}\n` })
  const first = await scan({ cwd: root, paths: ['src'] })
  const target = first.findings.find((finding) => finding.ruleId === 'ls-17')
  const reason = 'legacy page, tracked in #412'
  const planned = await runSuppress(root, `${target.siteId} --dry-run --reason "${reason}"`)
  assert.ok(planned.text.includes(`append {"reason":"${reason}","at":"${new Date().toISOString().slice(0, 10)}"}`))

  await runSuppress(root, `${target.siteId} --reason "${reason}"`)
  const next = await scan({ cwd: root, paths: ['src'] })
  assert.equal(next.suppressed, 1)
  assert.deepEqual(next.findings.filter((finding) => finding.suppressed === true).map((finding) => finding.siteId), [target.siteId])
  // The mute is a consequence of a scan, never of the write: the write itself reports no findings.
  assert.equal(first.suppressed, 0)
})

test('a reason is clamped before the plan, so no entry is longer than the cap on screen', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const { value } = await runScan(root, { paths: ['src'] })
  const id = value.findings[0].siteId
  const planned = await runSuppress(root, `${id} --dry-run --reason ${'x'.repeat(MAX_REASON_CHARS + 40)}`)
  const payload = JSON.parse(planned.text.match(/append (\{[^}]*\}) to /)[1])
  assert.equal(payload.reason.length, MAX_REASON_CHARS)
  assert.match(payload.reason, /…$/)
})

test('the command refuses what it cannot finish, and every refusal says so as an error', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const { value } = await runScan(root, { paths: ['src'] })
  const id = value.findings[0].siteId

  const cases = [
    ['', /No site id/],
    ['not-a-site', /Not a site id/],
    ['deadbeef01 --dry-run', /Not a site id/],
  ]
  for (const [line, pattern] of cases) {
    const answer = await runSuppress(root, line)
    assert.equal(answer.kind, 'error', line)
    assert.match(answer.text, pattern, line)
  }

  // An id typed in upper case names the same site, because the key the scan prints is lowercase and
  // normalising cannot retarget it; what the file gains is always the lowercase key.
  const upper = await runSuppress(root, `${id.toUpperCase()} --dry-run`)
  assert.equal(upper.kind, 'success')
  assert.ok(upper.text.startsWith(`Suppression plan for ${id}: append `))

  // A file this command did not write, and must not repair or extend.
  await writeRawSuppress(root, '{ not json')
  const broken = await runSuppress(root, id)
  assert.equal(broken.kind, 'error')
  assert.match(broken.text, /^Refused \(malformed\)/)
  assert.equal(await readFile(join(root, SUPPRESS_FILE), 'utf8'), '{ not json', 'a refusal writes nothing')

  await writeRawSuppress(root, JSON.stringify({ version: 2, entries: {} }))
  assert.match((await runSuppress(root, id)).text, /^Refused \(version\)/)

  await writeRawSuppress(root, serializeSuppressions(new Map([['deadbeef', { reason: 'x', at: '2026-11-11' }]])))
  const tooLarge = Buffer.alloc(MAX_SUPPRESS_BYTES + 1, 0x20)
  await writeFile(join(root, SUPPRESS_FILE), tooLarge)
  assert.match((await runSuppress(root, id)).text, /^Refused: .*byte limit/)
})

test('the cap is refused rather than truncated, and the plan reports the headroom', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const full = new Map()
  for (let index = 0; index < MAX_SUPPRESSIONS; index += 1) full.set(String(index).padStart(8, '0'), { reason: '', at: '' })
  await writeSuppress(root, full)

  const planned = await runSuppress(root, 'abcdef12 --dry-run')
  assert.match(planned.text, /which already holds the cap of 200 entries, so this write would be refused and nothing has been written\.$/)
  assert.equal(planned.text.includes('without --dry-run'), false, 'the plan must not offer a write that would be refused')
  const refused = await runSuppress(root, 'abcdef12')
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /already holds the maximum of 200 entries/)
  assert.equal(parseSuppressions(await readFile(join(root, SUPPRESS_FILE), 'utf8')).entries.size, MAX_SUPPRESSIONS)
})

test('a symlinked suppression file is refused by the writer too, so no write escapes the workspace', async (t) => {
  const outside = await workspace(t, { 'real.suppress': serializeSuppressions({}) })
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  try {
    await symlink(join(outside, 'real.suppress'), join(root, SUPPRESS_FILE), 'file')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('this account cannot create a symlink')
      return
    }
    throw error
  }

  const answer = await runSuppress(root, 'abcdef12')
  assert.equal(answer.kind, 'error')
  assert.match(answer.text, /not a regular file/)
  assert.equal(await readFile(join(outside, 'real.suppress'), 'utf8'), serializeSuppressions({}))
})

test('the tool and the command render one suppressed scan identically', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n`, 'src/styles.css': `${MODAL}\n` })
  const first = await scan({ cwd: root, paths: ['src'] })
  const target = first.findings.find((finding) => finding.ruleId === 'ls-17')
  await writeSuppress(root, new Map([[target.siteId, { reason: 'one page only', at: '2026-11-11' }]]))

  const toolText = (await runScan(root, { paths: ['src'] })).text
  const { scanCommand } = host()
  const answer = await scanCommand.handler({ rawInput: 'src', agent: { session: { header: { cwd: root } } } })
  assert.equal(answer.text, toolText)
  assert.ok(toolText.includes(', 1 suppressed'))
})

// ---------------------------------------------------------------------------------------------
// ADR-0004: the review that joins the file against one scan, and the one confirmed removal.
// ---------------------------------------------------------------------------------------------

/** A key no fixture site can produce: the entry a review exists to find, and a removal to retire. */
const STALE_KEY = siteId('src/legacy.js', 'ls-17', `${WRITE} // edited since`)

/** The three-entry canonical document the removal tests cut, in map order. */
function threeEntries() {
  return new Map([
    ['aaaaaaaa', { reason: 'first', at: '2026-01-01' }],
    ['bbbbbbbb', { reason: 'middle', at: '2026-01-02' }],
    ['cccccccc', { reason: 'last', at: '2026-01-03' }],
  ])
}

test('a review joins one scan against the file, and an incomplete scan claims nothing', () => {
  const entries = new Map([
    [WRITE_KEY, { reason: 'muted on purpose', at: '2026-11-01' }],
    [STALE_KEY, { reason: 'stale', at: '2026-02-02' }],
  ])

  // The shape ADR-0004 fixes: three numbers, and the ids of the entries this scan did not see.
  assert.deepEqual(reviewSuppressions(entries, new Set([WRITE_KEY]), { complete: true }), {
    entries: 2,
    matching: 1,
    unused: [STALE_KEY],
  })
  // Every way of saying "these are the sites I saw" joins the same.
  assert.deepEqual(reviewSuppressions(entries, [WRITE_KEY], { complete: true }), {
    entries: 2,
    matching: 1,
    unused: [STALE_KEY],
  })
  assert.deepEqual(reviewSuppressions(entries, { 'ls-17': [WRITE_KEY] }, { complete: true }), {
    entries: 2,
    matching: 1,
    unused: [STALE_KEY],
  })

  // The invariant a careless implementation breaks: `null`, never `[]`, when absence is unproven.
  // `[]` would say "every entry still matches", which is a claim no incomplete scan has earned.
  for (const seen of [new Set([WRITE_KEY]), [WRITE_KEY], { 'ls-17': [WRITE_KEY] }]) {
    assert.deepEqual(reviewSuppressions(entries, seen, { complete: false }), {
      entries: 2,
      matching: 1,
      unused: null,
    })
  }

  // A malformed entry never reaches a review: the parser drops it and reports it, so no code path
  // can ever call it unused — the second lie the phase exists to prevent.
  const parsed = parseSuppressions('{"version":1,"entries":{"not-a-key":{"reason":"x","at":"y"},"aaaaaaaa":{"reason":"r","at":"d"}}}')
  assert.equal(parsed.problems.length, 1)
  assert.deepEqual(reviewSuppressions(parsed.entries, new Set(), { complete: true }), {
    entries: 1,
    matching: 0,
    unused: ['aaaaaaaa'],
  })
})

test('a removal cuts one member out of the text and keeps the canonical bytes around it', () => {
  const canonical = serializeSuppressions(threeEntries())
  for (const [id, rest] of [
    ['aaaaaaaa', new Map([['bbbbbbbb', threeEntries().get('bbbbbbbb')], ['cccccccc', threeEntries().get('cccccccc')]])],
    ['bbbbbbbb', new Map([['aaaaaaaa', threeEntries().get('aaaaaaaa')], ['cccccccc', threeEntries().get('cccccccc')]])],
    ['cccccccc', new Map([['aaaaaaaa', threeEntries().get('aaaaaaaa')], ['bbbbbbbb', threeEntries().get('bbbbbbbb')]])],
  ]) {
    const answer = removeSuppression(canonical, id)
    assert.equal(answer.kind, 'removed', id)
    // Byte equality with the file the serialiser would have written: a cut, not a rewrite.
    assert.equal(answer.text, serializeSuppressions(rest), id)
    assert.deepEqual(answer.entry, threeEntries().get(id))
  }

  // The only entry: the object's interior goes with it, and the document stays canonical.
  const single = serializeSuppressions(new Map([['aaaaaaaa', { reason: 'only', at: '2026-01-01' }]]))
  assert.equal(removeSuppression(single, 'aaaaaaaa').text, serializeSuppressions(new Map()))

  // A hand-formatted file keeps its formatting, its unknown member and its malformed entry: the
  // removal owns one member's bytes and nothing else (ADR-0003 §6, applied to a cut).
  const hand = '{"version":1,"generator":"hand","entries":{"aaaaaaaa":{"reason":"r","at":"d"},"bbbbbbbb":{"reason":"s","at":"e"},"not-a-key":{}}}'
  const cut = removeSuppression(hand, 'aaaaaaaa')
  assert.equal(cut.kind, 'removed')
  assert.equal(cut.text, '{"version":1,"generator":"hand","entries":{"bbbbbbbb":{"reason":"s","at":"e"},"not-a-key":{}}}')
  assert.deepEqual(parseSuppressions(cut.text).problems, [{ key: 'not-a-key', reason: 'invalid' }])
})

test('a removal names its three answers: removed, absent, and refused', () => {
  const canonical = serializeSuppressions(threeEntries())
  assert.equal(removeSuppression(canonical, 'dddddddd').kind, 'absent')
  // A file-level failure is a refusal with its own token: there is no structure to cut.
  for (const [text, code] of [
    ['{"version":2,"entries":{}}', 'version'],
    ['not json at all', 'malformed'],
    ['{"version":1,"entries":[]}', 'malformed'],
  ]) {
    assert.deepEqual(removeSuppression(text, 'aaaaaaaa'), { kind: 'refused', code })
  }
})

test('every scan carries the review it can prove, and the scan text stays about the scan', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n`, 'src/styles.css': `${MODAL}\n` })
  const first = await scan({ cwd: root, paths: ['src'] })
  const target = first.findings.find((finding) => finding.ruleId === 'ls-17')
  await writeSuppress(root, new Map([
    [target.siteId, { reason: 'one page only', at: '2026-11-11' }],
    [STALE_KEY, { reason: 'stale', at: '2026-02-02' }],
  ]))

  const { value, text } = await runScan(root, { paths: ['src'] })
  assert.deepEqual(value.suppressions, { entries: 2, matching: 1, unused: [STALE_KEY] })
  // The review is a statement about the file, not about this scan, so it is carried in the value the
  // counters store and the panel reads — and the scan's own text does not grow a line for it.
  assert.ok(!text.includes('Suppressions:'), text)

  // The other half of the same rule lives in `test/scan-command.test.mjs`, where the counters give
  // a scan a baseline to be narrower than: there, one file of two must report unknown instead.
  // A workspace with no file at all carries no block: there is nothing to review, and a zero would
  // ride on every scan of every project that never muted anything.
  const noFile = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const bare = await runScan(noFile, { paths: ['src'] })
  assert.equal(bare.value.suppressions, undefined)
  assert.ok(!bare.text.includes('Suppressions:'))
})

test('--review lists every entry, says what it cannot prove, and never writes', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  await writeSuppress(root, new Map([
    [WRITE_KEY, { reason: 'one page only', at: '2026-11-11' }],
    [STALE_KEY, { reason: 'stale', at: '2026-02-02' }],
  ]))
  const before = await digestTree(root)

  const answer = await runSuppress(root, '--review')
  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /^Suppression review for .*\.suppress: 2 entries\./)
  assert.ok(answer.text.includes(WRITE_KEY))
  assert.ok(answer.text.includes('one page only'))
  assert.ok(answer.text.includes(STALE_KEY))
  assert.ok(answer.text.includes('2026-02-02'))
  // No counters in this host, so there is no evidence at all — and no entry is called unused.
  assert.match(answer.text, /No completed scan is recorded for this workspace/)
  assert.match(answer.text, /none is reported unused/)
  assert.ok(answer.text.endsWith('Nothing was written.'))

  // The read half, proven by the tree: no write, no temp file, no mtime moved.
  assert.deepEqual(await digestTree(root), before)
})

test('--review reports a file it cannot parse, and never calls the unreadable entries unused', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  await writeRawSuppress(root, '{"version":1,"entries":{"not-a-key":{"reason":"x","at":"y"},"aaaaaaaa":{"reason":"kept","at":"2026-01-01"}}}')
  const before = await digestTree(root)

  const answer = await runSuppress(root, '--review')
  assert.equal(answer.kind, 'success')
  assert.ok(answer.text.includes('1 entry in the file cannot be read (not-a-key)'), answer.text)
  assert.ok(answer.text.includes('never as unused'))
  assert.deepEqual(await digestTree(root), before)

  await writeRawSuppress(root, 'not json')
  const broken = await runSuppress(root, '--review')
  assert.equal(broken.kind, 'success')
  assert.match(broken.text, /cannot be read \(malformed\)/)
  assert.match(broken.text, /no entry in it can be judged/)
})

test('a removal is planned first, and the plan alone writes nothing', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  await writeSuppress(root, new Map([
    ['aaaaaaaa', { reason: 'first', at: '2026-01-01' }],
    ['bbbbbbbb', { reason: 'middle', at: '2026-01-02' }],
  ]))
  const before = await digestTree(root)

  const plan = await runSuppress(root, '--remove bbbbbbbb --dry-run')
  assert.equal(plan.kind, 'success')
  assert.match(plan.text, /^Removal plan for bbbbbbbb: remove 1 entry from .*\.suppress, which would go from 2 to 1 entry, dropping the entry it recorded \(reason "middle", recorded 2026-01-02\)\./)
  assert.match(plan.text, /Nothing has been written; run the same line without --dry-run to remove it\.$/)
  assert.deepEqual(await digestTree(root), before)
})

test('the confirmation removes exactly one entry, and the next scan counts the site again', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  const first = await scan({ cwd: root, paths: ['src'] })
  const target = first.findings.find((finding) => finding.ruleId === 'ls-17')
  await writeSuppress(root, new Map([
    [target.siteId, { reason: 'one page only', at: '2026-11-11' }],
    [STALE_KEY, { reason: 'stale', at: '2026-02-02' }],
  ]))
  const muted = await runScan(root, { paths: ['src'] })
  assert.equal(muted.value.suppressed, 1)

  const applied = await runSuppress(root, `--remove ${STALE_KEY}`)
  assert.equal(applied.kind, 'success')
  assert.match(applied.text, /^Removed [0-9a-f]{8} from .*\.suppress; the file now holds 1 entry\./)
  // The sentence the ADR requires: un-muted, never "fixed".
  assert.match(applied.text, /The site is no longer muted, so the next scan counts it as a finding again/)
  assert.match(applied.text, /A removal is not a fix: it does not mean the finding went away, and no counter has changed\.$/)

  // The other entry is byte-identical, and the removed one is gone from the parsed file.
  const left = parseSuppressions(await readFile(join(root, SUPPRESS_FILE), 'utf8'))
  assert.deepEqual([...left.entries.keys()], [target.siteId])
  assert.deepEqual(left.entries.get(target.siteId), { reason: 'one page only', at: '2026-11-11' })

  // Removing the mute that was still matching un-mutes the finding: same site id, no suppressed flag,
  // and the outcome says "no longer muted", never "fixed".
  const unmuted = await runSuppress(root, `--remove ${target.siteId}`)
  assert.equal(unmuted.kind, 'success')
  assert.match(unmuted.text, /The site is no longer muted, so the next scan counts it as a finding again/)
  const after = await runScan(root, { paths: ['src'] })
  assert.equal(after.value.suppressed, 0)
  const finding = after.value.findings.find((entry) => entry.ruleId === 'ls-17')
  assert.equal(finding.siteId, target.siteId)
  assert.notEqual(finding.suppressed, true)
})

test('an absent entry is a named no-op, and a removal it cannot finish writes nothing', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  await writeSuppress(root, new Map([['aaaaaaaa', { reason: 'first', at: '2026-01-01' }]]))
  const before = await digestTree(root)

  const absent = await runSuppress(root, '--remove bbbbbbbb')
  assert.equal(absent.kind, 'success')
  assert.match(absent.text, /^Nothing to remove: bbbbbbbb is not in .*\.suppress, which holds 1 entry; nothing was written\.$/)
  assert.deepEqual(await digestTree(root), before)

  // Refusals: an id that is not a site id, a file whose structure cannot be cut, a target that is
  // not a regular file. Each is an error, and each leaves the tree exactly as it found it.
  const notAnId = await runSuppress(root, '--remove nope')
  assert.equal(notAnId.kind, 'error')
  assert.match(notAnId.text, /^Not a site id: "nope"/)

  await writeRawSuppress(root, '{"version":2,"entries":{"aaaaaaaa":{"reason":"x","at":"y"}}}')
  const future = await digestTree(root)
  const refused = await runSuppress(root, '--remove aaaaaaaa')
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /^Refused \(version\): .* cannot be read as a suppression file/)
  assert.deepEqual(await digestTree(root), future)

  // A missing file is a no-op too: there is nothing to remove, and the answer says which file.
  await rm(join(root, SUPPRESS_FILE))
  const missing = await runSuppress(root, '--remove aaaaaaaa')
  assert.equal(missing.kind, 'success')
  assert.match(missing.text, /^Nothing to remove: .*\.suppress does not exist, so aaaaaaaa is not in it; nothing was written\.$/)
  assert.deepEqual(await readdir(root), ['src'])
})

test('the two new forms refuse every ambiguous line, each with its own sentence', async (t) => {
  const root = await workspace(t, { 'src/legacy.js': `${WRITE}\n` })
  await writeSuppress(root, new Map([['aaaaaaaa', { reason: 'first', at: '2026-01-01' }]]))
  const before = await digestTree(root)

  for (const [line, pattern] of [
    ['--review --remove aaaaaaaa', /^Refused: --review and --remove are two different actions/],
    ['--review aaaaaaaa', /^Refused: --review takes no site id/],
    ['--review --reason nope', /^Refused: --review takes no --reason/],
    ['--review --dry-run', /^Refused: --review writes nothing, so --dry-run is not a mode to ask for/],
    ['--remove aaaaaaaa --reason nope', /^Refused: --remove takes no --reason/],
    ['--remove aaaaaaaa bbbbbbbb', /^Refused: --remove takes one site id/],
    ['--remove', /^No site id after --remove/],
  ]) {
    const answer = await runSuppress(root, line)
    assert.equal(answer.kind, 'error', line)
    assert.match(answer.text, pattern, line)
  }
  // A refusal is a refusal: not one byte moved between the first line and the last.
  assert.deepEqual(await digestTree(root), before)
})
