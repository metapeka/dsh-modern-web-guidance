import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const scratch = join(import.meta.dirname, '..', '.tmp')

/** Point the counters at a throwaway profile before the plugin resolves its state path. */
async function isolatedHome() {
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, 'stats-home-'))
  process.env.DSH_PROFILE_DIR = home
  process.env.DSH_HOME = home
  return home
}

/** A context with just enough of the host surface for the plugin: registry, events, command lookup. */
function createContext() {
  const registered = { tools: [], skills: [], commands: [], listeners: [] }
  const commands = {
    register: (definition) => {
      registered.commands.push(definition)
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register: (tool) => {
        registered.tools.push(tool)
        return () => {}
      },
    },
    skills: {
      register: (skill) => {
        registered.skills.push(skill)
        return () => {}
      },
    },
    get: (name) => (name === 'commands' ? commands : undefined),
    on: (event, handler) => {
      registered.listeners.push({ event, handler })
    },
    off: () => {},
    effect: (create) => create(),
  }
  return { ctx, registered }
}

/** Let the fire-and-forget recording chain settle before reading the counters. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('the plugin registers three tools, two skills and one human command', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})

  assert.deepEqual(registered.tools.map((tool) => tool.name), [
    'web_guidance_search',
    'web_guidance_retrieve',
    'web_guidance_list',
  ])
  assert.deepEqual(registered.skills.map((skill) => skill.name), ['modern-web-guidance', 'chrome-extensions'])
  assert.deepEqual(registered.commands.map((command) => command.name), ['guidance-stats'])
  assert.ok(registered.listeners.some((listener) => listener.event === 'tools/result'))

  await rm(home, { recursive: true, force: true })
})

test('a finished search is counted and the command renders the report', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})
  const listener = registered.listeners.find((entry) => entry.event === 'tools/result')

  listener.handler(
    { name: 'web_guidance_search', arguments: { query: 'dialog light dismiss' } },
    { isError: false, value: { results: [{ id: 'css-anchor', category: 'css' }] } },
  )
  await settle()

  const report = await registered.commands[0].handler({ rawInput: '' })

  assert.equal(report.kind, 'success')
  assert.match(report.text, /Guidance usage: 1 call/)
  assert.match(report.text, /dialog light dismiss/)
  assert.match(report.text, /Corpus: version 2026_11_09-5bcc021b/)
  assert.match(report.text, /Period: last 7 days/)

  await rm(home, { recursive: true, force: true })
})

test('the command honours --days and --json', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})
  const command = registered.commands[0]

  const wide = await command.handler({ rawInput: '--days 30' })
  assert.match(wide.text, /Period: last 30 days/)

  const json = await command.handler({ rawInput: '--json' })
  const payload = JSON.parse(json.text)
  assert.equal(payload.periodDays, 7)
  assert.equal(payload.corpus.total, 208)

  await rm(home, { recursive: true, force: true })
})

test('--reset asks for confirmation, then erases the counters', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, {})
  const listener = registered.listeners.find((entry) => entry.event === 'tools/result')
  listener.handler(
    { name: 'web_guidance_search', arguments: { query: 'nothing matches this' } },
    { isError: false, value: { results: [] } },
  )
  await settle()

  const command = registered.commands[0]
  const refused = await command.handler({ rawInput: '--reset' })
  assert.match(refused.text, /Re-run \/guidance-stats --reset --yes/)

  const erased = await command.handler({ rawInput: '--reset --yes' })
  assert.match(erased.text, /Erased local usage counters \(1 call/)

  const empty = await command.handler({ rawInput: '' })
  assert.match(empty.text, /No calls recorded in the last 7 days/)

  await rm(home, { recursive: true, force: true })
})

test('enabled: false writes nothing and registers no command', async () => {
  const home = await isolatedHome()
  const { apply } = await import('../index.js')
  const { ctx, registered } = createContext()

  apply(ctx, { enabled: false })

  assert.equal(registered.commands.length, 0)
  assert.equal(registered.listeners.length, 0)
  assert.equal(registered.tools.length, 3)

  await rm(home, { recursive: true, force: true })
})
