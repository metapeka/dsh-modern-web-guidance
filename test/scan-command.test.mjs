/**
 * Contract tests for the human command `/guidance-scan`.
 *
 * The command is a thin shell around the same scanner the model reaches through
 * `web_guidance_legacy_scan`: it parses one line of text, calls the scanner, and prints the tool's
 * own rendering. These tests pin that story from the outside — the fake context is the host
 * surface `apply` uses, and the assertions read the text a person would see. The JSON case compares
 * the command's payload to the tool's value directly, because the panel parses that shape and a
 * drifting second implementation would be invisible otherwise.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../index.js'
import { siteId } from '../lib/site.js'
import { PACKAGE_DIR } from './paths.mjs'
import { makeScratchDir, removeTree, settleCounters, sweepStale } from './tmp.mjs'

const DIRTY = 'test/fixtures/scan/dirty'
const CLEAN = 'test/fixtures/scan/clean'

/** Sweep the profiles an earlier failed run left behind, before this run creates any of its own. */
await sweepStale(['scan-command'])

// The counters are pointed at a throwaway profile by the tests that need them; put the environment
// back afterwards so this file cannot leak its profile into another file in the same process.
const ORIGINAL_ENV = { profile: process.env.DSH_PROFILE_DIR, home: process.env.DSH_HOME }

after(() => {
  for (const [name, value] of [
    ['DSH_PROFILE_DIR', ORIGINAL_ENV.profile],
    ['DSH_HOME', ORIGINAL_ENV.home],
  ]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/**
 * The plugin instances this file has applied and not closed yet.
 *
 * The plugin debounces its counters write and `void`s the promise, so an instance left open saves into
 * the profile directory its teardown removes and re-creates it two seconds later — one
 * `scan-command-counters-*` every run, from the one test that never called `flush()`. The profile's
 * teardown closes what is still open before removing the directory, which is the only order that
 * leaves nothing.
 */
const openInstances = []

/**
 * Minimal Cordis context: tool/skill/command registries, command lookup and effects. `events: true`
 * adds the event bus the usage counters subscribe to, which is how the `enabled: false` case proves
 * the counters were configured and still registered nothing.
 */
function createContext({ events = false } = {}) {
  const registered = { tools: [], skills: [], commands: [], listeners: [] }
  const disposers = []
  const commands = {
    register(definition) {
      registered.commands.push(definition)
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    skills: {
      register() {
        return () => {}
      },
    },
    get: (name) => (name === 'commands' ? commands : undefined),
    effect: (create) => {
      const dispose = create()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  if (events) {
    ctx.on = (event, handler) => {
      registered.listeners.push({ event, handler })
    }
    ctx.off = () => {}
  }
  // Disposing the plugin flushes the counters, which is how a test reads what was written down.
  const dispose = () => {
    for (const release of disposers.splice(0)) release()
  }
  openInstances.push(dispose)
  return { ctx, registered, dispose }
}

/** Apply the plugin with the given row config and hand back what it registered. */
function setup(config = {}, options = {}) {
  const { ctx, registered } = createContext(options)
  apply(ctx, config)
  return registered
}

/** The command invocation the host hands a handler: raw text plus the session workspace. */
function invocation(rawInput, cwd = PACKAGE_DIR) {
  return { rawInput, agent: { session: { header: { cwd } } } }
}

/** The scanner command, selected by name: the plugin registers more than one command. */
function scanCommand(registered) {
  const command = registered.commands.find((entry) => entry.name === 'guidance-scan')
  assert.ok(command !== undefined, 'apply() must register /guidance-scan')
  return command
}

/** The `.scanignore` writer, selected by name: the second and last write the product has. */
function scanIgnoreCommand(registered) {
  const command = registered.commands.find((entry) => entry.name === 'guidance-scanignore')
  assert.ok(command !== undefined, 'apply() must register /guidance-scanignore')
  return command
}

/** The fixture root under the temp directory a refusal test uses as its workspace. */
async function tempWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'scan-command-'))
  t.after(() => removeTree(root))
  return root
}

/**
 * Point the counters at a fresh profile directory. The file store under it is the fake the counting
 * tests read: a throwaway document written by the plugin itself, never the real profile.
 *
 * The label stays in the name: two tests read two profiles in one run, and a failure should say which.
 */
async function isolatedProfile(t, label = 'counters') {
  const home = await makeScratchDir(`scan-command-${label}`)
  t.after(async () => {
    // Close what the test left open, then let the flush land, then remove: a save that arrives after
    // the removal re-creates the very directory this hook exists to delete.
    for (const dispose of openInstances.splice(0)) dispose()
    await settleCounters(home)
    await removeTree(home)
  })
  process.env.DSH_PROFILE_DIR = home
  process.env.DSH_HOME = home
  return home
}

/** The counters document the plugin writes for the active profile. */
function countersFile(home) {
  return join(home, 'storage', 'modern-web-guidance', 'stats.json')
}

/** Let the fire-and-forget recording chain settle before reading the counters. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** The counters as the panel reads them: `/guidance-stats --json`. */
async function counters(stats) {
  return JSON.parse((await stats.handler({ rawInput: '--json' })).text)
}

/**
 * Apply the plugin with a live event bus against a throwaway profile, and expose both commands plus
 * a `flush()` that shuts the counters down so their document is on disk.
 */
async function counted(t, config = {}) {
  const home = await isolatedProfile(t)
  const { ctx, registered, dispose } = createContext({ events: true })
  apply(ctx, config)
  return {
    home,
    registered,
    scan: scanCommand(registered),
    stats: registered.commands.find((entry) => entry.name === 'guidance-stats'),
    async flush() {
      dispose()
      await settle()
    },
  }
}

/** The parts of a counters report that must not depend on how a scan was started. */
function comparable(report) {
  return {
    byTool: report.totals.byTool,
    byOutcome: report.totals.byOutcome,
    files: report.totals.files,
    findings: report.totals.findings,
    topRules: report.topRules,
    topScanGuides: report.topScanGuides,
    // Attribution is part of "counted exactly like": the two entry points must not merely add up the
    // same, they must land in the same workspace bucket (workspace-attribution contract §2-§3). Only
    // the ids and names are compared — the two runs happen at different instants, so `lastScanAt`
    // legitimately differs.
    workspaces: report.workspaces.map((row) => ({ id: row.id, name: row.name })),
    lastScan: {
      files: report.lastScan.files,
      findings: report.lastScan.findings,
      rules: report.lastScan.rules,
    },
  }
}

/** Start one scan through `drive` against a fresh profile, then read the counters it left behind. */
async function countersAfter(t, label, drive) {
  // The profile has to be in place before `apply`, which resolves the state file at that moment.
  await isolatedProfile(t, label)
  const { ctx, registered, dispose } = createContext({ events: true })
  apply(ctx, {})
  await drive({ registered, scan: scanCommand(registered) })
  await settle()
  const stats = registered.commands.find((entry) => entry.name === 'guidance-stats')
  const report = await counters(stats)
  dispose()
  await settle()
  return comparable(report)
}

test('registers /guidance-scan beside the tools, with the syntax in its hint', () => {
  const registered = setup()
  const command = scanCommand(registered)

  assert.deepEqual(
    registered.commands.map((entry) => entry.name),
    ['guidance-scan', 'guidance-suppress', 'guidance-scanignore'],
  )
  assert.equal(command.input.hint, '<paths> [--rules ls-01,ls-13] [--format summary|json]')
  assert.equal(command.recordInput, false)
  assert.equal(typeof command.description, 'string')
  assert.ok(command.description.length > 60)
  assert.equal(typeof command.handler, 'function')
})

test('refuses an empty path list instead of walking the workspace', async () => {
  const command = scanCommand(setup())

  for (const rawInput of ['', '   ', '\t']) {
    const result = await command.handler(invocation(rawInput))
    assert.equal(result.kind, 'error')
    // One sentence, naming an example: an unbounded walk must never be the silent default.
    assert.match(result.text, /^Pass at least one relative path, for example \/guidance-scan src\/app\.js,/)
    assert.match(result.text, /never scans the whole workspace on its own\.$/)
    assert.equal(result.text.match(/\.\s/g), null, 'the refusal is more than one sentence')
    assert.ok(!result.text.includes('Scanned'), 'the refusal must not scan anything')
  }
})

test('an absolute path is refused with the scanner own code, not a throw', async () => {
  const command = scanCommand(setup())
  const absolute = join(PACKAGE_DIR, DIRTY)

  const result = await command.handler(invocation(absolute))
  assert.equal(result.kind, 'error')
  assert.equal(result.text.split('\n')[0], `Error: path-absolute — "${absolute}" is absolute; pass it relative to the session workspace instead.`)
})

test('a path that escapes the workspace is refused as path-outside', async (t) => {
  const root = await tempWorkspace(t)
  const workspace = join(root, 'workspace')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(workspace, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  await writeFile(join(elsewhere, 'app.js'), 'document.write("escaped")\n', 'utf8')

  const command = scanCommand(setup())
  const result = await command.handler(invocation('../elsewhere/app.js', workspace))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^Error: path-outside — "\.\.\/elsewhere\/app\.js" resolves outside/)
})

test('a fixture scan prints the summary and the rule ids it found', async () => {
  const command = scanCommand(setup())

  const result = await command.handler(invocation(DIRTY))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^Scanned 3 file\(s\) \(\d+ B\) — 8 finding\(s\)\./)
  for (const id of ['ls-01', 'ls-13', 'ls-31', 'ls-32', 'ls-33']) {
    assert.ok(result.text.includes(id), `summary is missing ${id}`)
  }
  assert.match(result.text, /Load with web_guidance_retrieve: /)
})

test('--format json prints exactly the value the tool returns', async () => {
  const registered = setup()
  const command = scanCommand(registered)
  const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')

  const result = await command.handler(invocation(`${DIRTY} --format json`))
  assert.equal(result.kind, 'success')
  const payload = JSON.parse(result.text)
  assert.deepEqual(Object.keys(payload).sort(), [
    'cwd', 'findings', 'format', 'guides', 'scanned', 'suppressed', 'truncated',
  ])
  assert.equal(payload.format, 'json')
  assert.equal(payload.scanned.files, 3)
  assert.equal(payload.findings.length, 8)
  assert.ok(payload.findings.every((finding) => /^ls-\d{2}$/.test(finding.ruleId)))
  assert.ok(Array.isArray(payload.guides) && payload.guides.length > 0)
  assert.equal(payload.truncated, false)

  // The panel parses this payload: it has to be the tool's own value, key for key.
  const toolValue = await tool.execute({ paths: [DIRTY], format: 'json' }, invocation(''))
  assert.deepEqual(payload, JSON.parse(JSON.stringify(toolValue)))
})

test('--rules narrows the scan to the ids it names', async () => {
  const command = scanCommand(setup())

  const one = await command.handler(invocation(`${DIRTY} --rules ls-13`))
  assert.equal(one.kind, 'success')
  assert.match(one.text, /^Scanned 3 file\(s\) \(\d+ B\) — 1 finding\(s\)\./)
  assert.match(one.text, / ls-13 \(/)
  assert.ok(!one.text.includes('ls-01'), 'a narrowed scan must not report an excluded rule')

  // Both the comma-separated and the `=` spellings resolve to the same ids.
  const two = await command.handler(invocation(`${DIRTY} --rules=ls-13,ls-32`))
  assert.match(two.text, /2 finding\(s\)\./)
  const ids = [...two.text.matchAll(/ (ls-\d{2}) \(/g)].map((match) => match[1]).sort()
  assert.deepEqual(ids, ['ls-13', 'ls-32'])
})

test('an unknown rule id is named back rather than thrown', async () => {
  const command = scanCommand(setup())

  const result = await command.handler(invocation(`${DIRTY} --rules ls-13,ls-99`))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^Error: unknown-rules — unknown rule id\(s\): ls-99\./)
  assert.match(result.text, /Valid ids run ls-01 … ls-33\./)
  assert.ok(!result.text.includes('Scanned'), 'a bad rule set must not touch the filesystem')
})

test('a scan with no findings says so plainly', async () => {
  const command = scanCommand(setup())

  const result = await command.handler(invocation(CLEAN))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^Scanned 1 file\(s\) \(\d+ B\) — 0 finding\(s\)\./)
  assert.match(result.text, /No rule in the table matched\./)
})

test('a comma-separated path list scans every named root', async () => {
  const command = scanCommand(setup())

  const result = await command.handler(invocation(`${DIRTY},${CLEAN} --format json`))
  const payload = JSON.parse(result.text)
  assert.equal(payload.scanned.files, 4)
  assert.equal(payload.findings.length, 8)
})

test('enabled: false keeps /guidance-scan and drops the counting command', async () => {
  // The counters are configured (the event bus exists) and switched off, so the absence below is a
  // real decision about the counters, not a context too bare to register anything.
  const registered = setup({ enabled: false }, { events: true })
  const command = scanCommand(registered)

  assert.deepEqual(
    registered.commands.map((entry) => entry.name),
    ['guidance-scan', 'guidance-suppress', 'guidance-scanignore'],
  )
  assert.deepEqual(registered.listeners, [])
  assert.equal(registered.tools.length, 4)

  // Scanning is not a counting feature: the command still works with the counters switched off.
  const result = await command.handler(invocation(CLEAN))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /0 finding\(s\)\./)
})

test('a command scan is counted exactly like a tool scan', async (t) => {
  const { home, scan, stats, flush } = await counted(t)

  const result = await scan.handler(invocation(`${DIRTY} --format json`))
  assert.equal(result.kind, 'success')
  const scanned = JSON.parse(result.text)

  await settle()
  const report = await counters(stats)

  // One tool key, the same one the `tools/result` listener writes: the record does not say how the
  // scan was started, so nothing downstream can tell a button press from a model call.
  assert.deepEqual(Object.keys(report.totals.byTool), ['legacy-scan'])
  assert.equal(report.totals.byTool['legacy-scan'], 1)
  assert.equal(report.totals.byOutcome.findings, 1)
  assert.equal(report.totals.files, scanned.scanned.files)
  assert.equal(report.totals.findings, scanned.findings.length)

  // The per-rule and per-guide aggregates are the findings the command printed, counted once.
  const perRule = report.topRules.reduce((total, row) => total + row.count, 0)
  assert.equal(perRule, scanned.findings.length)
  assert.ok(report.topScanGuides.length > 0)

  // `lastScan` points at this scan, with the numbers the command itself showed.
  assert.equal(report.lastScan.files, scanned.scanned.files)
  assert.equal(report.lastScan.findings, scanned.findings.length)

  // And it survives a shutdown: the document on disk holds that one call. The scan is attributed to
  // the workspace the invocation named, so per the workspace-attribution contract §3 its last-scan
  // pointer lives in that workspace's bucket while the legacy root pointer stays null.
  await flush()
  const stored = JSON.parse(await readFile(countersFile(home), 'utf8'))
  assert.equal(stored.byTool['legacy-scan'], 1)
  assert.equal(stored.byOutcome.findings, 1)
  assert.equal(stored.lastScan, null)
  assert.equal(report.workspaces.length, 1)
  const bucket = stored.workspaces[report.workspaces[0].id]
  assert.equal(bucket.name, report.workspaces[0].name)
  assert.equal(bucket.lastScan.files, scanned.scanned.files)
  assert.equal(bucket.lastScan.findings, scanned.findings.length)
})

test('a refused command scan counts an error and leaves lastScan alone', async (t) => {
  const { scan, stats } = await counted(t)

  await scan.handler(invocation(DIRTY))
  await settle()
  const before = await counters(stats)
  assert.equal(before.totals.byOutcome.findings, 1)

  const refused = await scan.handler(invocation('/etc/passwd'))
  assert.equal(refused.kind, 'error')
  await settle()
  const after = await counters(stats)

  // The attempt is counted, exactly as a refused tool call is counted ...
  assert.equal(after.totals.byTool['legacy-scan'], 2)
  assert.equal(after.totals.byOutcome.error, 1)
  assert.deepEqual(after.lastScan, before.lastScan)
  // ... and it moved neither the scan pointer nor the rule aggregates.
  assert.deepEqual(after.topRules, before.topRules)
})

test('the counters cannot tell a command scan from a tool scan', async (t) => {
  const viaCommand = await countersAfter(t, 'via-command', async ({ scan }) => {
    await scan.handler(invocation(DIRTY))
  })

  const viaTool = await countersAfter(t, 'via-tool', async ({ registered }) => {
    const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
    const value = await tool.execute(
      { paths: [DIRTY] },
      { agent: { session: { header: { cwd: PACKAGE_DIR } } } },
    )
    const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
    listener.handler({ name: 'web_guidance_legacy_scan', arguments: { paths: [DIRTY] } }, { isError: false, value })
  })

  assert.deepEqual(viaCommand, viaTool)
})

test('with the counters off a command scan writes nothing', async (t) => {
  const home = await isolatedProfile(t, 'disabled')
  const { ctx, registered, dispose } = createContext({ events: true })
  apply(ctx, { enabled: false })
  const scan = scanCommand(registered)
  assert.equal(registered.commands.some((entry) => entry.name === 'guidance-stats'), false)

  const result = await scan.handler(invocation(DIRTY))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /8 finding\(s\)\./)

  await settle()
  dispose()
  await settle()
  await assert.rejects(readFile(countersFile(home), 'utf8'), { code: 'ENOENT' })
})

test('the command prints the same skip and ignore lines as the tool, from one renderer', async (t) => {
  const workspace = await tempWorkspace(t)
  await mkdir(join(workspace, '.firecrawl'), { recursive: true })
  await mkdir(join(workspace, 'artifacts'), { recursive: true })
  await writeFile(join(workspace, 'app.js'), 'document.write("kept")\n', 'utf8')
  await writeFile(join(workspace, '.firecrawl/page.html'), 'document.write("scraped")\n', 'utf8')
  await writeFile(join(workspace, 'artifacts/report.html'), 'document.write("generated")\n', 'utf8')
  await writeFile(join(workspace, 'notes.md'), 'document.write("prose")\n', 'utf8')
  await writeFile(join(workspace, '.scanignore'), 'artifacts/\nbad/**/*.js\n', 'utf8')

  const registered = setup()
  const result = await scanCommand(registered).handler(invocation('.', workspace))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^Scanned 1 file\(s\) .* — 1 finding\(s\)\.$/m)
  assert.match(result.text, /^Skipped 4 path\(s\): 2 extension, 1 dot-directory, 1 scanignore$/m)
  assert.match(result.text, /^Ignored 1 line in \.scanignore \(line 2: bad pattern\)$/m)

  // The same scan through the tool: both surfaces share `renderScan`, so the text is equal rather
  // than merely similar. A second renderer would show up right here.
  const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
  assert.ok(tool !== undefined, 'apply() must register web_guidance_legacy_scan')
  const value = await tool.execute({ paths: ['.'] }, invocation('.', workspace))
  assert.equal(result.text, tool.output.render({ paths: ['.'] }, value)[0].text)
})

test('a collapsed run prints its range through both surfaces', async (t) => {
  const workspace = await tempWorkspace(t)
  // Eight ladder hits starting at line 306: one finding, printed as the range the bench reported.
  const ladder = Array.from({ length: 8 }, (_, index) => `:nth-child(${index + 1}) { animation-delay: ${index * 40}ms }`)
  const report = [...Array.from({ length: 305 }, () => ''), ...ladder].join('\n')
  await writeFile(join(workspace, 'report-template.css'), report, 'utf8')

  const registered = setup()
  const result = await scanCommand(registered).handler(invocation('.', workspace))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^- report-template\.css:306-313 ls-05 \(/m)

  // One renderer, two surfaces: the command prints exactly the text the tool's own render returns.
  const tool = registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
  assert.ok(tool !== undefined, 'apply() must register web_guidance_legacy_scan')
  const value = await tool.execute({ paths: ['.'] }, invocation('.', workspace))
  assert.equal(value.findings.length, 1)
  assert.deepEqual(value.findings[0].lines, [306, 307, 308, 309, 310, 311, 312, 313])
  assert.equal(value.findings[0].occurrences, 8)
  assert.equal(result.text, tool.output.render({ paths: ['.'] }, value)[0].text)
})

// --- The second write: one `.scanignore` line ------------------------------------------------

test('a scanignore plan writes nothing, and the apply appends the one line it showed', async (t) => {
  const workspace = await tempWorkspace(t)
  await writeFile(join(workspace, 'app.js'), 'document.write("kept")\n', 'utf8')
  const command = scanIgnoreCommand(setup())
  const file = join(workspace, '.scanignore')

  const planned = await command.handler(invocation('app.js --dry-run', workspace))
  assert.equal(planned.kind, 'success')
  // One paragraph, because the panel renders the host's text verbatim in a single node: the absolute
  // file, the exact line, whether it exists and what the pattern covers, then the promise.
  assert.equal(planned.text.includes('\n'), false)
  assert.ok(planned.text.startsWith('Ignore plan for app.js: append app.js to '), planned.text)
  assert.ok(
    planned.text.includes(` to ${file}, which does not exist yet, so it would be created with that one pattern.`),
    planned.text,
  )
  // A one-segment pattern is not anchored, and the plan says so rather than promising less than the
  // reader does.
  assert.match(planned.text, /A one-segment pattern matches that name at any depth/)
  assert.match(planned.text, /Nothing has been written; run the same line without --dry-run to write it\.$/)
  assert.deepEqual(await readdir(workspace), ['app.js'], 'a dry run created the file')

  const applied = await command.handler(invocation('app.js', workspace))
  assert.equal(applied.kind, 'success')
  assert.ok(applied.text.startsWith(`Appended to ${file}: app.js. The file now holds 1 pattern.`), applied.text)
  // The outcome is about the walk reading less — never the suppression's "muted, not fixed".
  assert.match(applied.text, /The next scan reads less because of it/)
  assert.equal(applied.text.includes('muted'), false, 'an exclusion is described as a mute')
  assert.equal(await readFile(file, 'utf8'), 'app.js\n')
})

test('the pattern the command writes is the pattern the next scan honours', async (t) => {
  const workspace = await tempWorkspace(t)
  await writeFile(join(workspace, 'app.js'), 'document.write("kept")\n', 'utf8')
  await writeFile(join(workspace, 'other.js'), 'document.write("kept")\n', 'utf8')
  const registered = setup()

  const applied = await scanIgnoreCommand(registered).handler(invocation('app.js', workspace))
  assert.equal(applied.kind, 'success')
  assert.equal(await readFile(join(workspace, '.scanignore'), 'utf8'), 'app.js\n')

  // The exclusion takes effect on the next scan and only there: the write itself scanned nothing.
  const after = await scanCommand(registered).handler(invocation('.', workspace))
  assert.match(after.text, /^Skipped \d+ path\(s\): .*1 scanignore/m)
  assert.match(after.text, /other\.js/, 'the neighbour was not read')
  assert.equal(after.text.includes('- app.js'), false, 'the excluded file was still reported')
})

test('a pattern with a slash skips exactly one path, which the plan says out loud', async (t) => {
  const workspace = await tempWorkspace(t)
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src/app.js'), 'document.write("kept")\n', 'utf8')
  await writeFile(join(workspace, 'src/parked.js'), 'document.write("parked")\n', 'utf8')
  const registered = setup()

  const planned = await scanIgnoreCommand(registered).handler(invocation('src/parked.js --dry-run', workspace))
  assert.match(
    planned.text,
    /The pattern has a slash, so it is anchored at the workspace root and the next scan skips exactly that path\./,
  )
  await scanIgnoreCommand(registered).handler(invocation('src/parked.js', workspace))

  const after = await scanCommand(registered).handler(invocation('src', workspace))
  assert.match(after.text, /src\/app\.js/)
  assert.equal(after.text.includes('src/parked.js'), false, 'the parked file was still read')
})

test('a directory pattern says it skips the subtree, and an existing file reports its count', async (t) => {
  const workspace = await tempWorkspace(t)
  const file = join(workspace, '.scanignore')
  await writeFile(file, '# keep build output out\ntmp-deploy/\n', 'utf8')
  const command = scanIgnoreCommand(setup())

  const planned = await command.handler(invocation('report/ --dry-run', workspace))
  assert.ok(planned.text.includes(` to ${file}, which would go from 1 pattern to 2 patterns.`), planned.text)
  assert.match(
    planned.text,
    /A trailing slash makes it a directory pattern, so the next scan skips that whole subtree\./,
  )

  await command.handler(invocation('report/', workspace))
  // Appended after the user's own comment, byte for byte: nothing is reformatted or reordered.
  assert.equal(await readFile(file, 'utf8'), '# keep build output out\ntmp-deploy/\nreport/\n')
})

test('an appended line matches the file it lands in: its ending, its comment, its last newline', async (t) => {
  const workspace = await tempWorkspace(t)
  const file = join(workspace, '.scanignore')
  const command = scanIgnoreCommand(setup())

  // No trailing newline: the separator is added, so two patterns never silently become one.
  await writeFile(file, 'tmp-deploy/', 'utf8')
  await command.handler(invocation('report/', workspace))
  assert.equal(await readFile(file, 'utf8'), 'tmp-deploy/\nreport/\n')

  // A CRLF file stays uniformly CRLF: the append does not introduce a second line ending.
  await writeFile(file, 'legacy/\r\nnotes/\r\n', 'utf8')
  await command.handler(invocation('src/app.css', workspace))
  assert.equal(await readFile(file, 'utf8'), 'legacy/\r\nnotes/\r\nsrc/app.css\r\n')
})

test('a pattern already in the file is a named no-op, whatever its spelling', async (t) => {
  const workspace = await tempWorkspace(t)
  const file = join(workspace, '.scanignore')
  await writeFile(file, 'report/\n', 'utf8')
  const command = scanIgnoreCommand(setup())

  for (const line of ['report/', '/report/', 'report/ --dry-run']) {
    const answer = await command.handler(invocation(line, workspace))
    assert.equal(answer.kind, 'success', line)
    assert.match(answer.text, /^Already present: report\/ /, line)
    assert.match(answer.text, /nothing was written|write nothing/, line)
  }
  // The identity is the effect, not the text: nothing was appended for the alternate spelling.
  assert.equal(await readFile(file, 'utf8'), 'report/\n')
})

test('a path with a space is quoted, and the file keeps the space', async (t) => {
  const workspace = await tempWorkspace(t)
  const command = scanIgnoreCommand(setup())
  const planned = await command.handler(invocation('"src/my page.astro" --dry-run', workspace))
  assert.equal(planned.kind, 'success')
  assert.ok(planned.text.startsWith('Ignore plan for src/my page.astro: append src/my page.astro to '), planned.text)
  await command.handler(invocation('"src/my page.astro"', workspace))
  assert.equal(await readFile(join(workspace, '.scanignore'), 'utf8'), 'src/my page.astro\n')
})

test('the command refuses what it cannot write, and a refusal leaves the file alone', async (t) => {
  const workspace = await tempWorkspace(t)
  const command = scanIgnoreCommand(setup())
  const file = join(workspace, '.scanignore')

  const refused = [
    ['', /^No pattern:/],
    ['--all', /^Unknown option: --all/],
    ['# a note', /^Not a \.scanignore pattern: a line that starts with "#" is a comment/],
    ['src/a.css src/b.css', /^One pattern at a time:/],
    ['**/*.js', /^Not a \.scanignore pattern:/],
    ['src//app.css', /^Not a \.scanignore pattern:/],
    ['src/a?.css', /^Not a \.scanignore pattern:/],
    ['src/app.css --force', /^Unknown option: --force/],
  ]
  for (const [line, pattern] of refused) {
    const answer = await command.handler(invocation(line, workspace))
    assert.equal(answer.kind, 'error', line)
    assert.match(answer.text, pattern, line)
  }
  assert.deepEqual(await readdir(workspace), [], 'a refusal created the file')

  // A file this command did not write, and must not extend: one bad line is reported by the scan, and
  // the writer refuses rather than hiding it beside a new one.
  await writeFile(file, 'src/legacy.css\nbad?line\n', 'utf8')
  const broken = await command.handler(invocation('src/app.css', workspace))
  assert.equal(broken.kind, 'error')
  assert.match(broken.text, /^Refused \(malformed\): .* has 1 line outside the \.scanignore grammar \(line 2\)/)
  assert.equal(await readFile(file, 'utf8'), 'src/legacy.css\nbad?line\n', 'a refusal wrote to the file')
})

test('a target that is not a regular file is refused, and a symlink is never followed', async (t) => {
  const workspace = await tempWorkspace(t)
  const command = scanIgnoreCommand(setup())
  await mkdir(join(workspace, '.scanignore'))
  const directory = await command.handler(invocation('src/app.css', workspace))
  assert.equal(directory.kind, 'error')
  assert.match(directory.text, /^Refused: .*\.scanignore is not a regular file\./)
  await removeTree(join(workspace, '.scanignore'))

  const outside = await tempWorkspace(t)
  const target = join(outside, 'real.scanignore')
  await writeFile(target, 'kept/\n', 'utf8')
  try {
    await symlink(target, join(workspace, '.scanignore'), 'file')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('this account cannot create a symlink')
      return
    }
    throw error
  }
  const refused = await command.handler(invocation('src/app.css', workspace))
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /^Refused: .*is not a regular file\./)
  assert.equal(await readFile(target, 'utf8'), 'kept/\n', 'a symlinked target was written through')
})

test('a narrower scan calls nothing unused, and the counters keep that answer with the counts', async (t) => {
  await isolatedProfile(t, 'suppress-review')
  const workspace = await tempWorkspace(t)
  await mkdir(join(workspace, 'src'), { recursive: true })
  const write = 'document.write("<p>hi</p>")'
  await writeFile(join(workspace, 'src/legacy.js'), `${write}\n`, 'utf8')
  await writeFile(join(workspace, 'src/page.html'), '<marquee>hi</marquee>\n', 'utf8')
  // One entry this workspace's only muted site produces, and one key nothing can: the pair a review
  // exists to tell apart.
  const muted = siteId('src/legacy.js', 'ls-17', write)
  await writeFile(
    join(workspace, '.suppress'),
    `${JSON.stringify({ version: 1, entries: { aaaaaaaa: { reason: 'stale', at: '2026-02-02' }, [muted]: { reason: 'one page only', at: '2026-11-01' } } }, null, 2)}\n`,
    'utf8',
  )

  const { ctx, registered, dispose } = createContext({ events: true })
  apply(ctx, {})
  const scan = scanCommand(registered)
  const stats = registered.commands.find((entry) => entry.name === 'guidance-stats')
  const suppress = registered.commands.find((entry) => entry.name === 'guidance-suppress')

  // A wide scan proves the stale key is dead, and the counters store that proof — not a list the
  // report would have to recompute from numbers that cannot carry ids.
  assert.equal((await scan.handler(invocation('src', workspace))).kind, 'success')
  await settle()
  const wide = (await counters(stats)).lastScan.suppressions
  assert.deepEqual(wide, {
    entries: 2,
    matching: 1,
    unused: ['aaaaaaaa'],
    // The rows a panel draws: both entries with what the file stores, and the verdict this scan
    // earned. The matching one is listed too — it is the entry a person reconsiders.
    items: [
      { siteId: muted, reason: 'one page only', date: '2026-11-01', matched: true },
      { siteId: 'aaaaaaaa', reason: 'stale', date: '2026-02-02', matched: false },
    ],
  })

  // One file of two is the narrower scan B refuses to compare with, so the review inherits the rule:
  // the stale key is NOT called unused, because this scan saw less than the one before it.
  assert.equal((await scan.handler(invocation('src/legacy.js', workspace))).kind, 'success')
  await settle()
  const narrow = (await counters(stats)).lastScan.suppressions
  assert.deepEqual(narrow, {
    entries: 2,
    matching: 1,
    unused: null,
    // The row-level form of the same refusal: `null`, never `false`, for a site this scan may simply
    // not have walked past.
    items: [
      { siteId: muted, reason: 'one page only', date: '2026-11-01', matched: null },
      { siteId: 'aaaaaaaa', reason: 'stale', date: '2026-02-02', matched: null },
    ],
  })

  // And `--review` reads that stored block: a matching count, then the absence said in so many words,
  // never a list of entries the scan could not clear.
  const review = await suppress.handler(invocation('--review', workspace))
  assert.equal(review.kind, 'success')
  assert.match(review.text, /^Suppression review for .*\.suppress: 2 entries, of which the last scan matched 1\./)
  assert.match(review.text, /That scan could not prove which of the others it did not see, so this review reports none of them unused\./)
  assert.ok(review.text.includes(muted))
  assert.ok(review.text.includes('aaaaaaaa'))
  assert.ok(review.text.endsWith('Nothing was written.'))
  dispose()
  await settle()
})
