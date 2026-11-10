import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

const scratch = join(import.meta.dirname, '..', '.tmp')

/** Minimal Cordis context: enough of the host surface for `apply` to register everything. */
function createContext() {
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
  return { ctx, tools }
}

/** Apply the plugin and hand back the registered scanner definition. */
function scanTool() {
  const { ctx, tools } = createContext()
  apply(ctx, {})
  const tool = tools.find((entry) => entry.name === 'web_guidance_legacy_scan')
  assert.ok(tool !== undefined, 'apply() must register web_guidance_legacy_scan')
  return tool
}

/** The `exec` a host hands a tool: a session cwd and an optional abort signal. */
function fakeExec(cwd, signal = undefined) {
  return { signal, agent: { session: { header: { cwd } } } }
}

/** Two markers the rule table knows, so a scan of this directory must find something. */
const CSS_FIXTURE = ['.card::-webkit-scrollbar {', '  width: 8px;', '}', ''].join('\n')
const JS_FIXTURE = ['export function copyText(text) {', "  document.execCommand('copy')", '  return text', '}', ''].join('\n')

/** A throwaway directory inside the repo's git-ignored `.tmp`, with both fixtures written into it. */
async function fixtureDirectory() {
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'scan-tool-'))
  await writeFile(join(dir, 'legacy.css'), CSS_FIXTURE, 'utf8')
  await writeFile(join(dir, 'legacy.js'), JS_FIXTURE, 'utf8')
  return dir
}

test('the scanner registers with the name and argument schema from the contract', () => {
  const tool = scanTool()
  assert.equal(tool.name, 'web_guidance_legacy_scan')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 100)
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: {
      paths: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 512 } },
      rules: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } },
      format: { type: 'string', enum: ['summary', 'json'] },
    },
    required: ['paths'],
    additionalProperties: false,
  })
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

test('an unknown rule id comes back as unknown-rules without scanning', async () => {
  const tool = scanTool()
  const dir = await fixtureDirectory()
  try {
    // `missing.css` does not exist: scanning it would be `path-missing`, so any filesystem work
    // would show up here as the wrong error code.
    const value = await tool.execute({ paths: ['missing.css'], rules: ['ls-01', 'nope'] }, fakeExec(dir))
    assert.equal(value.error, 'unknown-rules')
    assert.deepEqual(value.unknown, ['nope'])
    assert.equal(value.rules.length, 30)
    assert.equal(value.rules[0], 'ls-01')
    assert.equal(value.rules[29], 'ls-30')

    const rendered = tool.output.render({}, value)
    assert.match(rendered[0].text, /^Error: unknown-rules — unknown rule id\(s\): nope\./)
    assert.match(rendered[0].text, /Omit "rules" to apply every rule\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an absolute path is refused with a path-absolute result and a hint', async () => {
  const tool = scanTool()
  const dir = await fixtureDirectory()
  try {
    const absolute = join(dir, 'legacy.css')
    const value = await tool.execute({ paths: [absolute] }, fakeExec(dir))
    assert.equal(value.error, 'path-absolute')
    assert.equal(value.subject, absolute)
    assert.equal(typeof value.message, 'string')

    const rendered = tool.output.render({}, value)
    assert.match(rendered[0].text, /^Error: path-absolute — /)
    assert.match(rendered[0].text, /relative paths inside the session workspace/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing path is refused rather than reported as a clean scan', async () => {
  const tool = scanTool()
  const dir = await fixtureDirectory()
  try {
    const value = await tool.execute({ paths: ['not-there.css'] }, fakeExec(dir))
    assert.equal(value.error, 'path-missing')
    assert.equal(value.subject, 'not-there.css')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a scan over a temp directory reports findings, guides and one summary line', async () => {
  const tool = scanTool()
  const dir = await fixtureDirectory()
  try {
    const value = await tool.execute({ paths: ['legacy.css', 'legacy.js'] }, fakeExec(dir))

    assert.equal(value.error, undefined)
    assert.equal(value.format, 'summary')
    assert.equal(value.cwd, dir)
    assert.equal(value.scanned.files, 2)
    assert.equal(value.scanned.bytes > 0, true)
    assert.equal(value.truncated, false)

    assert.ok(value.findings.length >= 2, `expected at least two findings, got ${value.findings.length}`)
    const ruleIds = new Set(value.findings.map((finding) => finding.ruleId))
    assert.ok(ruleIds.size >= 2, 'the two fixtures should trip two different rules')
    for (const finding of value.findings) {
      assert.match(finding.ruleId, /^ls-\d{2}$/)
      assert.match(finding.confidence, /^(high|medium|low)$/)
      assert.equal(finding.line >= 1, true)
      assert.equal(finding.column >= 1, true)
      assert.equal(typeof finding.message, 'string')
    }

    // Ordering is part of the contract: path ascending, then line, then column.
    const paths = value.findings.map((finding) => finding.path)
    assert.deepEqual(paths, [...paths].sort())

    const guides = value.guides ?? []
    assert.equal(Array.isArray(guides), true)
    const withGuide = value.findings.filter((finding) => finding.guideId !== null).length
    assert.equal(
      guides.reduce((total, guide) => total + guide.findings, 0),
      withGuide,
      'guide counts must add up to the findings that name a guide',
    )

    const text = tool.output.render({}, value)[0].text
    assert.match(text, /^Scanned 2 file\(s\) \(.+\) — \d+ finding\(s\)\./)
    assert.match(text, /- legacy\.css:1:\d+ ls-\d{2} \((?:high|medium|low)\) /)
    assert.match(text, /- legacy\.js:2:\d+ ls-\d{2} \((?:high|medium|low)\) /)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("format: 'json' renders the payload as pretty-printed JSON", async () => {
  const tool = scanTool()
  const dir = await fixtureDirectory()
  try {
    const value = await tool.execute({ paths: ['legacy.css'], format: 'json' }, fakeExec(dir))
    assert.equal(value.format, 'json')
    assert.ok(value.findings.length >= 1)

    const text = tool.output.render({}, value)[0].text
    const parsed = JSON.parse(text)
    assert.equal(parsed.format, 'json')
    assert.equal(parsed.cwd, dir)
    assert.deepEqual(parsed.findings, value.findings)
    assert.equal(parsed.scanned.files, 1)
    assert.ok(text.includes('\n  "format": "json"'), 'the JSON block should be indented')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an aborted signal stops the call before any scanning starts', async () => {
  const tool = scanTool()
  const dir = await fixtureDirectory()
  try {
    const signal = {
      throwIfAborted() {
        throw new Error('aborted by the host')
      },
    }
    await assert.rejects(() => tool.execute({ paths: ['legacy.css'] }, fakeExec(dir, signal)), /aborted by the host/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
