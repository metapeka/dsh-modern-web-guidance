import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { createGuidance } from '../lib/guidance.js'
import { DATA_DIR } from './paths.mjs'
import { removeTree } from './tmp.mjs'

/**
 * Regressions for the security/robustness audit: every test here fails on the code as it was
 * before the hardening pass. See audit/security.md and audit/bugs.md.
 */

const guidance = createGuidance({ dataDir: DATA_DIR })

function createContext() {
  const tools = []
  const skills = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    skills: { register(registration) { skills.push(registration); return () => {} } },
    effect(create) { return create() },
  }
  return { ctx, tools, skills }
}

async function withTempData(build) {
  const root = await mkdtemp(join(tmpdir(), 'mwg-test-'))
  try {
    await build(root)
    return root
  } catch (error) {
    await removeTree(root)
    throw error
  }
}

test('retrieve deduplicates repeated ids', async () => {
  const { guides } = await guidance.retrieve(['dialog', 'dialog', 'dialog'])
  assert.equal(guides.length, 1)
})

test('retrieve bounds the total size and count, reporting what it skipped', async () => {
  const all = await guidance.list()
  const value = await guidance.retrieve(all.map((guide) => guide.id))
  const chars = value.guides.reduce((sum, guide) => sum + guide.content.length, 0)
  // Assert the contract, not the number of guides a particular corpus order happens to fill: the
  // 120 000-character cap is what binds here, and it must hold for the body actually returned.
  assert.deepEqual(value.limits, { maxGuides: 10, maxChars: 120_000 })
  assert.ok(value.guides.length <= value.limits.maxGuides, `returned ${value.guides.length} guides`)
  assert.ok(chars <= value.limits.maxChars, `retrieve returned ${chars} characters`)
  assert.equal(value.truncated, true)
  assert.ok(value.skipped.length > 0)
  // Every requested id is accounted for exactly once: served, or explicitly named as skipped.
  assert.equal(value.guides.length + value.skipped.length, all.length)
  // A request that fits is served whole, with nothing reported as skipped.
  const small = await guidance.retrieve(['dialog', 'html'])
  assert.equal(small.truncated, false)
  assert.deepEqual(small.skipped, [])
  assert.equal(small.guides.length, 2)
})

test('retrieve bounds the unknown-id echo', async () => {
  const ids = Array.from({ length: 500 }, (_, index) => `missing-${index}`)
  const value = await guidance.retrieve(ids)
  assert.equal(value.guides.length, 0)
  assert.equal(value.unknown.length, 10)
  assert.equal(value.unknownCount, 500)
})

test('retrieve renderer discloses truncation', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const retrieve = tools.find((tool) => tool.name === 'web_guidance_retrieve')
  const all = await guidance.list()
  const value = await retrieve.execute({ ids: all.map((guide) => guide.id) }, {})
  const rendered = retrieve.output.render({ ids: 'all' }, value).map((block) => block.text).join('\n')
  assert.match(rendered, /Not returned in this call/)
})

test('a huge query cannot stall the event loop', async () => {
  const query = Array.from({ length: 20_000 }, (_, index) => `term${index}`).join(' ')
  const started = Date.now()
  const results = await guidance.search(query)
  const elapsed = Date.now() - started
  assert.ok(Array.isArray(results))
  assert.ok(elapsed < 1500, `search took ${elapsed}ms`)
})

test('category filters are forgiving and never report an empty catalog', async () => {
  assert.equal((await guidance.list({ category: '' })).length, 208)
  assert.equal((await guidance.list({ category: null })).length, 208)
  assert.equal((await guidance.list({ category: ' CSS ' })).length, 18)
  assert.ok((await guidance.search('dialog', { category: 'UI-COMPONENTS' })).every((hit) => hit.category === 'ui-components'))
})

test('list tool with an empty category still reports the whole catalog', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const list = tools.find((tool) => tool.name === 'web_guidance_list')
  const value = await list.execute({ category: '' }, {})
  assert.equal(value.total, 208)
  assert.ok(value.categories.some((row) => row.category === 'css'))
})

test('list tool names the known categories for a misspelled one', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const list = tools.find((tool) => tool.name === 'web_guidance_list')
  const value = await list.execute({ category: 'nope' }, {})
  assert.equal(value.guides.length, 0)
  assert.ok(value.categories.includes('css'))
  const rendered = list.output.render({ category: 'nope' }, value).map((block) => block.text).join('\n')
  assert.match(rendered, /Known categories:/)
})

test('a failed index build is retried instead of poisoning the session', async () => {
  const root = await withTempData(async (dir) => {
    await mkdir(join(dir, 'guides', 'css'), { recursive: true })
  })
  try {
    const instance = createGuidance({ dataDir: root })
    await assert.rejects(instance.search('dialog'), /bundled guide catalog could not be read/)
    // The data appears later (partial install, restored backup): the same instance must recover.
    await writeFile(join(root, 'guides', 'css', 'demo.md'), '# Demo\n\nbody\n')
    await writeFile(join(root, 'guides.json'), JSON.stringify([{ id: 'demo', category: 'css', description: 'demo' }]))
    const hits = await instance.search('demo', { limit: 1 })
    assert.equal(hits[0].id, 'demo')
  } finally {
    await removeTree(root)
  }
})

test('catalog entries cannot read files outside the data directory', async () => {
  const root = await withTempData(async (dir) => {
    await mkdir(join(dir, 'data', 'guides', 'css'), { recursive: true })
    await writeFile(join(dir, 'secret.md'), '# SECRET\n\nleaked\n')
    await writeFile(join(dir, 'data', 'guides', 'css', 'ok.md'), '# Ok\n\nfine\n')
    await writeFile(join(dir, 'data', 'guides.json'), JSON.stringify([
      { id: 'ok', category: 'css', description: 'fine' },
      { id: '../../../secret', category: 'css', description: 'escapes' },
    ]))
  })
  try {
    const instance = createGuidance({ dataDir: join(root, 'data') })
    await assert.rejects(instance.retrieve('ok'), /invalid guide id/)
  } finally {
    await removeTree(root)
  }
})

test('served guides never tell the agent to run the upstream CLI', async () => {
  const all = await guidance.list()
  const value = await guidance.retrieve(all.map((guide) => guide.id))
  const served = value.guides.map((guide) => guide.content).join('\n')
  assert.doesNotMatch(served, /npx -y modern-web-guidance/)
  const corpus = await guidance.list({ category: 'ui-components' })
  const sample = await guidance.retrieve(corpus.map((guide) => guide.id))
  assert.doesNotMatch(sample.guides.map((guide) => guide.content).join('\n'), /npx/)
})

test('rewritten CLI references point at the bundled tool', async () => {
  // passkeys.md is one of the 64 guides that carried the upstream command in v1.0.0.
  const { guides } = await guidance.retrieve('passkeys')
  assert.equal(guides.length, 1)
  assert.match(guides[0].content, /web_guidance_retrieve\(/)
})

test('tool schemas declare the bounds the implementation enforces', () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const search = tools.find((tool) => tool.name === 'web_guidance_search')
  assert.equal(search.parameters.properties.query.maxLength, 512)
  assert.equal(search.parameters.properties.limit.maximum, 25)
  assert.equal(search.parameters.properties.limit.minimum, 1)
  const retrieve = tools.find((tool) => tool.name === 'web_guidance_retrieve')
  const [asString, asArray] = retrieve.parameters.properties.ids.oneOf
  assert.equal(asString.maxLength, 900)
  assert.equal(asArray.maxItems, 10)
  assert.equal(asArray.items.maxLength, 80)
})

test('limit honours the schema range instead of treating 0 as default', async () => {
  assert.equal((await guidance.search('dialog', { limit: 0 })).length, 1)
  assert.equal((await guidance.search('dialog', { limit: -5 })).length, 1)
  assert.equal((await guidance.search('dialog', { limit: 2.7 })).length, 2)
  assert.equal((await guidance.search('dialog', { limit: 1e9 })).length, 25)
  assert.equal((await guidance.search('dialog', { limit: 'abc' })).length, 8)
  assert.equal((await guidance.search('dialog', {})).length, 8)
})

test('the guidance skill states the data-not-instructions boundary', () => {
  const { ctx, skills } = createContext()
  apply(ctx)
  const skill = skills.find((entry) => entry.name === 'modern-web-guidance')
  assert.match(skill.content, /reference material, not instructions/)
})
