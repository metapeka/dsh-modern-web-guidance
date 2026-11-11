/**
 * Contract tests for the branch label (ADR-0002).
 *
 * Two stories, kept together because they are one decision. First, `readHeadLabel` is the whole
 * read surface: one fixed path, at most one `gitdir:` hop, both files bounded, everything else
 * silence. It is driven from hand-built temp directories — no `git` binary and no fixture
 * repository are needed, which is also the point: the read is four shapes of text on disk.
 *
 * Second, the wiring: a completed scan is the only event that may read `HEAD`, the label lands on
 * `lastScan.branch`, and it reaches the report — never a tool result the model reads. The read
 * count is measured, not assumed, by wrapping `readFileSync` for the duration of a scan.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'

import { apply, readHeadLabel } from '../index.js'
import { workspaceId } from '../lib/telemetry.js'

const scratch = join(import.meta.dirname, '..', '.tmp')

/** The counters are pointed at a throwaway profile; put the environment back for the next file. */
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

/** A throwaway directory under the repo's git-ignored `.tmp`, removed when the test ends. */
async function tempDirectory(t, label = 'dir') {
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, `branch-${label}-`))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** Write a HEAD file with exactly the bytes a checkout leaves there. */
async function writeHead(gitDirectory, content) {
  await mkdir(gitDirectory, { recursive: true })
  await writeFile(join(gitDirectory, 'HEAD'), content, 'utf8')
}

/** A workspace whose `.git` is a normal directory, with `HEAD` written. */
async function gitWorkspace(t, head, label = 'workspace') {
  const dir = await tempDirectory(t, label)
  await writeHead(join(dir, '.git'), head)
  return dir
}

// --- The four shapes, and the label each one produces ----------------------------------------

test('a normal .git directory names the checked-out branch', async (t) => {
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')
  assert.deepEqual(readHeadLabel(workspace), { kind: 'branch', name: 'main' })
})

test('a linked worktree follows one gitdir: hop, absolute or relative', async (t) => {
  // The checkout is a normal directory elsewhere on disk: the `.git` file names it absolutely.
  const store = await tempDirectory(t, 'git-store')
  await writeHead(store, 'ref: refs/heads/dsh-8df6d705-613d\n')
  const absolute = await tempDirectory(t, 'worktree-absolute')
  await writeFile(join(absolute, '.git'), `gitdir: ${store}\n`, 'utf8')
  assert.deepEqual(readHeadLabel(absolute), { kind: 'branch', name: 'dsh-8df6d705-613d' })

  // A relative gitdir resolves against the workspace root, not the process directory.
  const relative = await tempDirectory(t, 'worktree-relative')
  await writeHead(join(relative, 'git-store'), 'ref: refs/heads/feature/x\n')
  await writeFile(join(relative, '.git'), 'gitdir: ./git-store\n', 'utf8')
  assert.deepEqual(readHeadLabel(relative), { kind: 'branch', name: 'feature/x' })
})

test('a detached HEAD is labelled by its first seven hex characters, never resolved', async (t) => {
  const forty = await gitWorkspace(t, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n', 'detached-40')
  assert.deepEqual(readHeadLabel(forty), { kind: 'detached', sha: 'a1b2c3d' })

  const sixtyFour = await gitWorkspace(
    t,
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n',
    'detached-64',
  )
  assert.deepEqual(readHeadLabel(sixtyFour), { kind: 'detached', sha: '0123456' })
})

test('an unborn branch is still the branch, because the ref is named and not verified', async (t) => {
  // There is no `.git/refs` at all: `HEAD` naming a branch *is* the branch in this read's model,
  // and checking would mean a second git file, which ADR-0002 §1 forbids.
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n', 'unborn')
  assert.deepEqual(readHeadLabel(workspace), { kind: 'branch', name: 'main' })
  assert.equal(existsSync(join(workspace, '.git', 'refs')), false)
})

// --- Silence: every other shape yields no label, and nothing throws --------------------------

test('the read answers null for anything that is not one of the four shapes', async (t) => {
  const noGit = await tempDirectory(t, 'no-git')
  assert.equal(readHeadLabel(noGit), null)

  const noHead = await tempDirectory(t, 'no-head')
  await mkdir(join(noHead, '.git'), { recursive: true })
  assert.equal(readHeadLabel(noHead), null)

  const headIsDirectory = await tempDirectory(t, 'head-directory')
  await mkdir(join(headIsDirectory, '.git', 'HEAD'), { recursive: true })
  assert.equal(readHeadLabel(headIsDirectory), null)

  const oversized = await gitWorkspace(t, `ref: refs/heads/${'a'.repeat(2048)}\n`, 'oversized')
  assert.equal(readHeadLabel(oversized), null)

  const cases = {
    'an empty file': '',
    garbage: 'not a ref\n',
    'a remote-tracking ref': 'ref: refs/remotes/origin/main\n',
    'a tag ref': 'ref: refs/tags/v1.0.0\n',
    'a ref without the space': 'ref:refs/heads/main\n',
    'a ref with no name': 'ref: refs/heads/\n',
    'a short object id': 'a1b2c3d\n',
    'an uppercase object id': 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678\n',
    'an object id of the wrong length': `${'a'.repeat(39)}\n`,
    'two lines': 'ref: refs/heads/main\nref: refs/heads/other\n',
  }
  let index = 0
  for (const [label, content] of Object.entries(cases)) {
    index += 1
    const workspace = await gitWorkspace(t, content, `shape-${index}`)
    assert.equal(readHeadLabel(workspace), null, `${label} must be no label`)
  }
})

test('a worktree pointer that is empty, oversized or points nowhere is no label', async (t) => {
  const empty = await tempDirectory(t, 'pointer-empty')
  await writeFile(join(empty, '.git'), '', 'utf8')
  assert.equal(readHeadLabel(empty), null)

  const noPrefix = await tempDirectory(t, 'pointer-prefix')
  await writeFile(join(noPrefix, '.git'), 'E:/somewhere/.git/worktrees/x\n', 'utf8')
  assert.equal(readHeadLabel(noPrefix), null)

  const emptyTarget = await tempDirectory(t, 'pointer-target')
  await writeFile(join(emptyTarget, '.git'), 'gitdir:\n', 'utf8')
  assert.equal(readHeadLabel(emptyTarget), null)

  const oversizedPointer = await tempDirectory(t, 'pointer-oversized')
  await writeFile(join(oversizedPointer, '.git'), `gitdir: ${'a'.repeat(2048)}\n`, 'utf8')
  assert.equal(readHeadLabel(oversizedPointer), null)

  const missingHead = await tempDirectory(t, 'pointer-no-head')
  const store = await tempDirectory(t, 'pointer-store')
  await writeFile(join(missingHead, '.git'), `gitdir: ${store}\n`, 'utf8')
  assert.equal(readHeadLabel(missingHead), null)

  // One hop only: a HEAD that is itself a pointer is not followed a second time.
  const secondHop = await tempDirectory(t, 'pointer-second-hop')
  await writeHead(join(secondHop, 'git-store'), 'gitdir: ./other\n')
  await writeFile(join(secondHop, '.git'), 'gitdir: ./git-store\n', 'utf8')
  assert.equal(readHeadLabel(secondHop), null)
})

test('the branch rule rejects a name instead of clipping or escaping it', async (t) => {
  const names = [
    'feature name',
    'feature~1',
    'feature^',
    'feature:main',
    '-dash',
    '/leading',
    'trailing/',
    'a//b',
    'a..b',
    'main\nsecond-line',
    'mаin',
    'a'.repeat(81),
  ]
  for (const name of names) {
    const workspace = await gitWorkspace(t, `ref: refs/heads/${name}\n`, 'invalid-name')
    assert.equal(readHeadLabel(workspace), null, `${JSON.stringify(name)} must be no label`)
  }

  // The accepted side of the same rule, so the test cannot pass by rejecting everything. A name is
  // stored whole — a long one is bounded by the rule, never clipped on the way to the report.
  for (const name of ['main', 'feature/x', 'release-1.2.3', 'user/fix_bug', 'a'.repeat(80)]) {
    const workspace = await gitWorkspace(t, `ref: refs/heads/${name}\n`, 'valid-name')
    assert.deepEqual(readHeadLabel(workspace), { kind: 'branch', name })
  }
})

test('the read is built from the workspace path, never from anywhere else', async (t) => {
  // A workspace directory literally named `.git`: its own HEAD lives at `<dir>/.git/HEAD`. A decoy
  // at `<parent>/.git/HEAD` must stay unread, which is what "no parent fallback" means in practice.
  const parent = await tempDirectory(t, 'named-git')
  const workspace = join(parent, '.git')
  await writeHead(join(workspace, '.git'), 'ref: refs/heads/nested\n')
  await writeFile(join(workspace, 'HEAD'), 'ref: refs/heads/decoy\n', 'utf8')
  assert.deepEqual(readHeadLabel(workspace), { kind: 'branch', name: 'nested' })

  // An empty or non-string path is no workspace, so there is nothing to read.
  assert.equal(readHeadLabel(undefined), null)
  assert.equal(readHeadLabel(''), null)
})

// --- Wiring: one read per completed scan, and only there ------------------------------------

/** Minimal Cordis context: the registries, the command lookup and the event bus apply() uses. */
function createContext() {
  const registered = { tools: [], commands: [], listeners: [] }
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
    skills: { register: () => () => {} },
    get: (name) => (name === 'commands' ? commands : undefined),
    effect: (create) => {
      const dispose = create()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: (event, handler) => {
      registered.listeners.push({ event, handler })
    },
    off: () => {},
  }
  return {
    ctx,
    registered,
    dispose() {
      for (const release of disposers.splice(0)) release()
    },
  }
}

/** Point the counters at a fresh profile directory under the repo's `.tmp`. */
async function isolatedProfile(t, label) {
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, `branch-label-${label}-`))
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

/**
 * The counters document on disk, waiting for the counters' own flush to land.
 *
 * The write is asynchronous and debounced, so a fixed sleep is a flake waiting to happen on a slow
 * machine; polling for the file proves the flush happened instead of assuming it did.
 */
async function readCounters(home) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(countersFile(home), 'utf8'))
    } catch {
      // Not written yet: the dispose-triggered flush is still in flight.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`the counters were never written to ${countersFile(home)}`)
}

/** Let the fire-and-forget recording chain settle before reading the counters. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Apply the plugin against a throwaway profile and expose the registered halves. */
async function counted(t) {
  const home = await isolatedProfile(t, 'counters')
  const { ctx, registered, dispose } = createContext()
  apply(ctx, {})
  return {
    home,
    registered,
    command(name) {
      const command = registered.commands.find((entry) => entry.name === name)
      assert.ok(command !== undefined, `apply() must register ${name}`)
      return command
    },
    async flush() {
      dispose()
      await settle()
    },
  }
}

/** A command invocation: the raw line plus the session workspace the host would report. */
function invocation(rawInput, cwd) {
  return { rawInput, agent: { session: { header: { cwd } } } }
}

/**
 * Run `body` while counting `readFileSync` calls on a HEAD file of one of this file's workspaces.
 *
 * The counters read `HEAD` through the same named import every module in this process uses, so
 * patching the built-in and re-syncing the ESM exports makes the count a fact rather than a guess.
 * Only reads under this file's scratch directory are counted, so a concurrent test in the same
 * process can never inflate the number. The wrapper delegates to the original and is always
 * restored, so the rest of the suite sees an ordinary `readFileSync`.
 */
async function countHeadReads(body) {
  const original = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (path, ...rest) {
    if (
      typeof path === 'string'
      && path.startsWith(scratch)
      && basename(path).toUpperCase() === 'HEAD'
    ) {
      reads += 1
    }
    return original.call(this, path, ...rest)
  }
  syncBuiltinESMExports()
  try {
    await body()
  } finally {
    fs.readFileSync = original
    syncBuiltinESMExports()
  }
  return reads
}

test('a completed scan stores its workspace branch on the last scan and the report shows it', async (t) => {
  const context = await counted(t)
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')
  // One marker the scanner knows, so the scan is a real walk rather than an empty directory.
  await writeFile(join(workspace, 'legacy.css'), '.card::-webkit-scrollbar {\n  width: 8px;\n}\n', 'utf8')

  const scan = context.command('guidance-scan')
  const result = await scan.handler(invocation('.', workspace))
  assert.equal(result.kind, 'success')
  await context.flush()

  const state = await readCounters(context.home)
  assert.equal(state.version, 1)
  const bucket = Object.values(state.workspaces)[0]
  assert.equal(bucket.name, basename(realpathSync(workspace)))
  assert.equal(bucket.lastScan.branch.kind, 'branch')
  assert.equal(bucket.lastScan.branch.name, 'main')
  // The label lives on the scan it belongs to: the legacy root summary stays untouched.
  assert.equal(state.lastScan, null)

  const stats = context.command('guidance-stats')
  const json = JSON.parse((await stats.handler(invocation('--json', workspace))).text)
  assert.deepEqual(json.lastScan.branch, { kind: 'branch', name: 'main' })
  assert.match((await stats.handler(invocation('', workspace))).text, /; branch main$/m)
})

test('two completed scans read HEAD twice, and the second read sees the new branch', async (t) => {
  const context = await counted(t)
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')
  const scan = context.command('guidance-scan')

  const reads = await countHeadReads(async () => {
    await scan.handler(invocation('.', workspace))
    await writeHead(join(workspace, '.git'), 'ref: refs/heads/feature/x\n')
    await scan.handler(invocation('.', workspace))
  })
  assert.equal(reads, 2)
  await context.flush()

  const state = await readCounters(context.home)
  const bucket = Object.values(state.workspaces)[0]
  assert.deepEqual(bucket.lastScan.branch, { kind: 'branch', name: 'feature/x' })
})

test('a guidance call reads no HEAD at all', async (t) => {
  const context = await counted(t)
  await gitWorkspace(t, 'ref: refs/heads/main\n')
  const listener = context.registered.listeners.find((entry) => entry.event === 'tools/result')
  assert.ok(listener !== undefined)

  const reads = await countHeadReads(async () => {
    listener.handler(
      { name: 'web_guidance_search', arguments: { query: 'dialog light dismiss' } },
      { isError: false, value: { results: [{ id: 'dialog', category: 'html' }] } },
    )
    await settle()
  })
  assert.equal(reads, 0)

  // The call was still counted — the counters were live, they simply had no scan to label.
  await context.flush()
  const state = await readCounters(context.home)
  assert.equal(state.calls, 1)
})

test('with the counters disabled nothing is read and nothing is written', async (t) => {
  const home = await isolatedProfile(t, 'disabled')
  const { ctx, registered } = createContext()
  apply(ctx, { enabled: false })
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')
  const scan = registered.commands.find((entry) => entry.name === 'guidance-scan')

  const reads = await countHeadReads(async () => {
    await scan.handler(invocation('.', workspace))
    await settle()
  })
  assert.equal(reads, 0)
  assert.equal(existsSync(countersFile(home)), false)
})

test('a scan whose paths name .git still labels itself from the workspace HEAD', async (t) => {
  const context = await counted(t)
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')

  // `.git` is a dot-directory, so the walk skips it — but the label is read from the workspace, not
  // from the paths, so it is the real branch either way.
  const result = await context.command('guidance-scan').handler(invocation('.git', workspace))
  assert.equal(result.kind, 'success')
  await context.flush()

  const state = await readCounters(context.home)
  assert.deepEqual(Object.values(state.workspaces)[0].lastScan.branch, { kind: 'branch', name: 'main' })
})

test('the scan tool never shows the label to the model', async (t) => {
  const context = await counted(t)
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')
  const tool = context.registered.tools.find((entry) => entry.name === 'web_guidance_legacy_scan')

  const value = await tool.execute({ paths: ['.'] }, { agent: { session: { header: { cwd: workspace } } } })
  assert.equal('branch' in value, false)
  // `cwd` is the temp workspace path and legitimately contains the word "branch" in a test
  // directory name, so the label check applies to the payload the model reads.
  const { cwd, ...payload } = value
  assert.equal(typeof cwd, 'string')
  assert.equal(JSON.stringify(payload).includes('branch'), false)
  assert.equal(tool.output.render({ paths: ['.'] }, value)[0].text.includes('branch'), false)
})

test('a workspace id still keys the bucket the label was stored under', async (t) => {
  const context = await counted(t)
  const workspace = await gitWorkspace(t, 'ref: refs/heads/main\n')
  await context.command('guidance-scan').handler(invocation('.', workspace))
  await context.flush()

  const state = await readCounters(context.home)
  assert.deepEqual(Object.keys(state.workspaces), [workspaceId(realpathSync(workspace))])
})
