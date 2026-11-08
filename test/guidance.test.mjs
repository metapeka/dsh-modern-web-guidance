import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGuidance, stem } from '../lib/guidance.js'
import { DATA_DIR } from './paths.mjs'

const guidance = createGuidance({ dataDir: DATA_DIR })

test('catalog is complete and loadable', async () => {
  const guides = await guidance.list()
  assert.equal(guides.length, 193)
  assert.ok(guides.every((guide) => typeof guide.id === 'string' && guide.id.length > 0))
  assert.equal(new Set(guides.map((guide) => guide.id)).size, guides.length)
})

test('search ranks the specific guide first for a capability query', async () => {
  const cases = [
    ['light dismiss dialog', 'light-dismiss-a-dialog'],
    ['responsive data table', 'responsive-table'],
    ['dark mode toggle', 'dark-mode-toggle'],
    ['anchor positioning', 'anchor-positioning-tab-underline'],
    ['form validation after interaction', 'validate-input-after-interaction'],
    ['prevent page scroll under modal', 'prevent-page-scroll-under-modal-dialog'],
    ['passkey sign in', 'passkey-registration'],
  ]
  for (const [query, expected] of cases) {
    const results = await guidance.search(query, { limit: 3 })
    assert.ok(results.length > 0, `no results for "${query}"`)
    assert.equal(results[0].id, expected, `top result for "${query}" was ${results[0].id}`)
  }
})

test('search result shape and category filter', async () => {
  const results = await guidance.search('dialog', { limit: 5, category: 'ui-components' })
  assert.ok(results.length > 0)
  for (const hit of results) {
    assert.equal(hit.category, 'ui-components')
    assert.equal(typeof hit.title, 'string')
    assert.equal(typeof hit.description, 'string')
    assert.ok(hit.score > 0)
  }
})

test('unknown queries fall back instead of throwing', async () => {
  const results = await guidance.search('xyzzyplugh')
  assert.deepEqual(results, [])
  const empty = await guidance.search('')
  assert.deepEqual(empty, [])
})

test('retrieve returns full guide content and reports unknown ids', async () => {
  const { guides, unknown } = await guidance.retrieve('light-dismiss-a-dialog, does-not-exist')
  assert.equal(guides.length, 1)
  assert.equal(guides[0].id, 'light-dismiss-a-dialog')
  assert.match(guides[0].content, /^# /)
  assert.deepEqual(unknown, ['does-not-exist'])
})

test('retrieve accepts an array of ids', async () => {
  const { guides } = await guidance.retrieve(['dialog', 'html'])
  assert.deepEqual(guides.map((guide) => guide.id).sort(), ['dialog', 'html'])
})

test('stemmer folds common suffixes', () => {
  assert.equal(stem('validation'), stem('validate'))
  assert.equal(stem('transitions'), stem('transition'))
  assert.equal(stem('animations'), stem('animate'))
  assert.equal(stem('css'), 'css')
})
