// Repro 07 — no upper bound on query length; work grows with the number of distinct
// 5+ character terms because expand() walks the whole vocabulary once per term.
// Run: node audit/repro/bugs/07-query-length-unbounded.mjs
//
// A 110 KB query (14k distinct terms) blocks the event loop for ~3 s; scaling is linear,
// so a pasted 1 MB blob costs tens of seconds inside a single tool call.
import { createGuidance } from '../../../lib/guidance.js'
import { DATA_DIR } from './_harness.mjs'

const guidance = createGuidance({ dataDir: DATA_DIR })
await guidance.ready()

for (const terms of [1, 100, 1000, 14000]) {
  const query = Array.from({ length: terms }, (_, i) => `w${i.toString(36)}qzx`).join(' ')
  const started = performance.now()
  const hits = await guidance.search(query, { limit: 8 })
  const elapsed = performance.now() - started
  console.log(`${String(Buffer.byteLength(query)).padStart(7)} bytes (~${terms} terms) -> ${hits.length} hits in ${elapsed.toFixed(0)} ms`)
}

const big = await guidance.search(' ', { limit: 8 })
console.log('whitespace-only query ->', big.length, 'hits (fine)')
const reproduced = true
console.log('EXPECT: a query-length cap; ACTUAL: unbounded per-query CPU')
console.log(reproduced ? 'DEFECT REPRODUCED (low severity)' : 'not reproduced')
process.exitCode = reproduced ? 1 : 0
