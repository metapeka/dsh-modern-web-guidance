// Security probes: path traversal via tool args, prototype pollution, argument
// coercion, limit clamping, error-message disclosure.
// Run: node audit/repro/security/probes.mjs   (from the package root)
import { createGuidance } from '../../../lib/guidance.js'
import { DATA_DIR } from '../../../test/paths.mjs'

const g = createGuidance({ dataDir: DATA_DIR })
const line = (s) => console.log(s)

line('== 1. tool arguments cannot reach a filesystem path ==')
const traversal = [
  '../../../../Windows/win.ini',
  '..\\..\\..\\Windows\\win.ini',
  'guides/../../package.json',
  '../../../package.json',
  'C:\\Windows\\win.ini',
  '/etc/passwd',
  'dialog/../../index',
  '${DATA_DIR}/../../package',
]
const { guides, unknown } = await g.retrieve(traversal)
line(`retrieve(${traversal.length} hostile ids) -> guides=${guides.length} unknown=${unknown.length}`)
line(`all reported unknown: ${unknown.length === traversal.length}`)
line(`any content leaked: ${guides.some((d) => /root:|\[extensions\]|dsh-modern-web-guidance/.test(d.content))}`)

line('')
line('== 2. hostile category / query values are exact string compares, not paths ==')
for (const cat of ['../../etc', '..\\..\\Windows', '\0', '__proto__', 'constructor']) {
  const hits = await g.search('dialog', { limit: 3, category: cat })
  const listed = await g.list({ category: cat })
  line(`  category=${JSON.stringify(cat)} search=${hits.length} list=${listed.length}`)
}

line('')
line('== 3. prototype pollution attempts ==')
const probes = ['__proto__', 'constructor', 'constructor.prototype.polluted', 'prototype', 'toString', 'valueOf', '__defineGetter__']
for (const p of probes) await g.retrieve(p)
for (const p of probes) await g.search(p, { limit: 5 })
for (const p of probes) await g.list({ category: p })
line(`({}).polluted        = ${String({}.polluted)}`)
line(`Object.prototype.polluted = ${String(Object.prototype.polluted)}`)
line(`({}).toString is native   = ${String(({}).toString === Object.prototype.toString)}`)
line(`Object.getOwnPropertyNames(Object.prototype).length = ${Object.getOwnPropertyNames(Object.prototype).length}`)

line('')
line('== 4. limit clamping (schema has no minimum/maximum, code clamps to 1..25) ==')
for (const limit of [1e9, -5, 0, NaN, 'abc', 3.7, Infinity, -Infinity, '10', null]) {
  const hits = await g.search('dialog', { limit })
  line(`  limit=${String(limit).padEnd(10)} -> ${hits.length} hit(s)`)
}

line('')
line('== 5. id coercion from non-array/non-string arguments ==')
for (const ids of [undefined, null, 123, {}, [], ['   '], ['"dialog"']]) {
  const r = await g.retrieve(ids)
  line(`  ids=${JSON.stringify(ids)} -> guides=${r.guides.length} unknown=${JSON.stringify(r.unknown).slice(0, 40)}`)
}

line('')
line('== 6. error messages disclose absolute host paths ==')
const broken = createGuidance({ dataDir: 'C:\\definitely-not-here\\mwg\\data' })
try {
  await broken.search('dialog')
} catch (error) {
  line(`  code=${error.code} message=${error.message}`)
  line(`  path=${error.path}`)
}
try {
  await broken.list()
} catch (error) {
  line(`  list() code=${error.code} path=${error.path}`)
}

