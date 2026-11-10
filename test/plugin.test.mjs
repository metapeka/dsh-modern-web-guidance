import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { apply } from '../index.js'

/** Minimal Cordis context: records tool/skill registrations and runs effects. */
function createContext() {
  const tools = []
  const skills = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    skills: {
      register(registration) {
        skills.push(registration)
        return () => {}
      },
    },
    effect(create) {
      return create()
    },
  }
  return { ctx, tools, skills }
}

test('apply registers the three tools and two skills', () => {
  const { ctx, tools, skills } = createContext()
  apply(ctx)
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['web_guidance_list', 'web_guidance_retrieve', 'web_guidance_search'],
  )
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ['chrome-extensions', 'modern-web-guidance'])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.parameters !== undefined)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  for (const skill of skills) {
    assert.ok(skill.content.length > 1000)
    assert.equal(skill.source, 'bundled')
    assert.equal(typeof skill.path, 'string')
    assert.equal(skill.resourceBase?.kind, 'directory')
    assert.ok(existsSync(skill.resourceBase.path))
    assert.equal(skill.invocation.modelInvocable, true)
  }
})

test('search tool executes and renders', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const search = tools.find((tool) => tool.name === 'web_guidance_search')
  const value = await search.execute({ query: 'light dismiss dialog' }, {})
  assert.equal(value.results[0].id, 'light-dismiss-a-dialog')
  const rendered = search.output.render({ query: 'light dismiss dialog' }, value)
  assert.match(rendered[0].text, /light-dismiss-a-dialog/)
})

test('retrieve tool returns guide markdown', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const retrieve = tools.find((tool) => tool.name === 'web_guidance_retrieve')
  const value = await retrieve.execute({ ids: ['dialog'] }, {})
  assert.match(value.guides[0].content, /# Dialog/)
  const rendered = retrieve.output.render({ ids: ['dialog'] }, value)
  assert.match(rendered[0].text, /--- Guide for dialog ---/)
})

test('experimental guides are flagged in search and open with a warning banner', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)

  const search = tools.find((tool) => tool.name === 'web_guidance_search')
  const found = await search.execute({ query: 'webmcp' }, {})
  assert.equal(found.results[0].id, 'webmcp')
  assert.equal(found.results[0].experimental, true)
  const renderedSearch = search.output.render({ query: 'webmcp' }, found)
  assert.match(renderedSearch[0].text, /- webmcp \[experimental\] \(webmcp\):/)

  const retrieve = tools.find((tool) => tool.name === 'web_guidance_retrieve')
  const value = await retrieve.execute({ ids: ['webmcp'] }, {})
  assert.equal(value.guides[0].experimental, true)
  assert.match(value.guides[0].content, /^> \[!WARNING\]\n> Experimental: Origin Trial feature\(s\) `declarative-webmcp`, `document-modelcontext`\./)
})

test('list tool groups categories and lists one category', async () => {
  const { ctx, tools } = createContext()
  apply(ctx)
  const list = tools.find((tool) => tool.name === 'web_guidance_list')
  const grouped = await list.execute({}, {})
  assert.equal(grouped.total, 208)
  assert.ok(grouped.categories.some((row) => row.category === 'css'))
  const oneCategory = await list.execute({ category: 'ui-atoms' }, {})
  assert.ok(oneCategory.guides.length > 0)
  assert.ok(oneCategory.guides.every((guide) => guide.id.length > 0))
})
