// Resource-exhaustion probes reachable from tool arguments only:
//  - retrieve() accepts an unbounded number of ids and duplicates are not collapsed
//  - search() tokenizes an unbounded query; every term >=5 chars scans the whole
//    vocabulary in expand() (lib/guidance.js:187)
// Run: node audit/repro/security/resource.mjs   (from the package root)
import { createGuidance } from '../../../lib/guidance.js'
import { DATA_DIR } from '../../../test/paths.mjs'

const g = createGuidance({ dataDir: DATA_DIR })
const line = (s) => console.log(s)
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`

line('== 1. unbounded retrieve(): ids are not capped, deduped or truncated ==')
const single = await g.retrieve(['dialog'])
const singleBytes = JSON.stringify(single).length
line(`  baseline: 1 id -> ${singleBytes} bytes (dialog guide)`)

for (const repeats of [10, 100, 1000, 3000]) {
  const ids = Array.from({ length: repeats }, () => 'dialog')
  const t0 = performance.now()
  const value = await g.retrieve(ids)
  const bytes = JSON.stringify(value).length
  const ms = performance.now() - t0
  line(`  ${String(repeats).padStart(5)} duplicate ids -> ${mb(bytes)} output, ${ms.toFixed(0)} ms, guides=${value.guides.length}`)
}

const all = await g.list()
const full = await g.retrieve(all.map((doc) => doc.id))
line(`  every valid id (${all.length}) -> ${mb(JSON.stringify(full).length)} in one tool result`)

line('')
line('== 2. expand() scans the whole vocabulary per query term (lib/guidance.js:187) ==')
const terms = []
for (let i = 0; i < 60000; i += 1) terms.push(`a${i.toString(36).padStart(5, '0')}`) // unique, len>=6
line(`  synthetic vocabulary-unique query terms available: ${terms.length}`)

for (const n of [50, 200, 800, 3200]) {
  const query = terms.slice(0, n).join(' ')
  const t0 = performance.now()
  const hits = await g.search(query, { limit: 5 })
  const ms = performance.now() - t0
  line(`  query with ${String(n).padStart(5)} terms (${(query.length / 1024).toFixed(0)} KiB) -> ${ms.toFixed(0)} ms, ${hits.length} hit(s)`)
}

line('')
line('== 3. huge single-token query / huge substring needle ==')
for (const size of [60_000, 600_000]) {
  const query = 'z'.repeat(size)
  const t0 = performance.now()
  const hits = await g.search(query, { limit: 5 })
  line(`  single ${size}-char token -> ${(performance.now() - t0).toFixed(0)} ms, ${hits.length} hit(s)`)
}

line('')
line('== 4. raw memory after the biggest query ==')
const big = terms.slice(0, 8000).join(' ')
const t0 = performance.now()
await g.search(big, { limit: 5 })
const mu = process.memoryUsage()
line(`  8000-term query: ${(performance.now() - t0).toFixed(0)} ms, heapUsed=${mb(mu.heapUsed)}, rss=${mb(mu.rss)}`)
