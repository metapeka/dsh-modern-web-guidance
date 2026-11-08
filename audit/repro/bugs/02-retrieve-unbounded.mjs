// Repro 02 — web_guidance_retrieve has no bound on ids, guides or bytes.
// Run: node audit/repro/bugs/02-retrieve-unbounded.mjs
//
// EXPECT: some cap (max guides, or truncation / a "too large" error) so one tool call
//         cannot exceed the model's context.
// ACTUAL: 193 ids = the entire 1.5 MB corpus (~447k tokens) in one result. Duplicate
//         ids are not de-duplicated, so 386 ids = 3.1 MB. A 10k-id unknown list is echoed
//         back verbatim (109 KB).
import { createGuidance } from '../../../lib/guidance.js'
import { apply } from '../../../index.js'
import { createContext, DATA_DIR } from './_harness.mjs'

const guidance = createGuidance({ dataDir: DATA_DIR })
const { ctx, tools } = createContext()
apply(ctx)
const retrieve = tools.find((tool) => tool.name === 'web_guidance_retrieve')

const all = await guidance.list()
const ids = all.map((guide) => guide.id)

const value = await guidance.retrieve(ids)
const rendered = retrieve.output.render({ ids }, value)[0].text
const bytes = Buffer.byteLength(rendered, 'utf8')
console.log(`all ${ids.length} ids -> ${value.guides.length} guides, ${bytes} bytes (~${Math.round(bytes / 3.5)} tokens)`)

const doubled = [...ids, ...ids]
const value2 = await guidance.retrieve(doubled)
const rendered2 = retrieve.output.render({ ids: doubled }, value2)[0].text
console.log(`same ids twice (${doubled.length}) -> ${value2.guides.length} guides, ${Buffer.byteLength(rendered2, 'utf8')} bytes`)

const unknown = Array.from({ length: 10000 }, (_, i) => `nope-${i}`)
const value3 = await guidance.retrieve(unknown)
const rendered3 = retrieve.output.render({ ids: unknown }, value3)[0].text
console.log(`10000 unknown ids -> ${value3.unknown.length} echoed, ${Buffer.byteLength(rendered3, 'utf8')} bytes`)

const reproduced = bytes > 1_000_000 && value2.guides.length === doubled.length
console.log('EXPECT: a bound (cap / truncation); ACTUAL:', bytes, 'bytes, no dedupe ->', value2.guides.length, 'guides')
console.log(reproduced ? 'DEFECT REPRODUCED' : 'not reproduced')
process.exitCode = reproduced ? 1 : 0
