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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../index.js'
import { PACKAGE_DIR } from './paths.mjs'

const DIRTY = 'test/fixtures/scan/dirty'
const CLEAN = 'test/fixtures/scan/clean'

const scratch = join(import.meta.dirname, '..', '.tmp')

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

/** The fixture root under the temp directory a refusal test uses as its workspace. */
async function tempWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'scan-command-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

/**
 * Point the counters at a fresh profile directory. The file store under it is the fake the counting
 * tests read: a throwaway document written by the plugin itself, never the real profile.
 */
async function isolatedProfile(t, label = 'counters') {
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, `scan-command-${label}-`))
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
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
    ['guidance-scan'],
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
  assert.deepEqual(Object.keys(payload).sort(), ['cwd', 'findings', 'format', 'guides', 'scanned', 'truncated'])
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
    ['guidance-scan'],
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

  // And it survives a shutdown: the document on disk holds that one call.
  await flush()
  const stored = JSON.parse(await readFile(countersFile(home), 'utf8'))
  assert.equal(stored.byTool['legacy-scan'], 1)
  assert.equal(stored.byOutcome.findings, 1)
  assert.equal(stored.lastScan.files, scanned.scanned.files)
  assert.equal(stored.lastScan.findings, scanned.findings.length)
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
