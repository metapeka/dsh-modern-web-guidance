// Repro 06 — tool-level limit handling: 0 silently becomes the default 8, -1 becomes 1,
// and the JSON Schema declares no minimum/maximum, so the host cannot catch either before
// the call lands.
// Run: node audit/repro/bugs/06-limit-values.mjs
//
// EXPECT: documented range is 1-25 (index.js:102). limit 0 -> 8 results and limit -1 -> 1
//         result are both outside the contract and neither is reported to the model.
import { apply } from '../../../index.js'
import { createContext } from './_harness.mjs'

const { ctx, tools } = createContext()
apply(ctx)
const search = tools.find((tool) => tool.name === 'web_guidance_search')
const schema = search.parameters.properties.limit

for (const limit of [undefined, 0, -1, 1, 2.7, 25, 26, 1e9, '5', null, Number.NaN, Number.POSITIVE_INFINITY]) {
  const value = await search.execute({ query: 'dialog', limit }, {})
  console.log(`limit=${String(limit).padEnd(10)} -> ${value.results.length} results`)
}
console.log('schema for limit:', JSON.stringify(schema))
const zero = await search.execute({ query: 'dialog', limit: 0 }, {})
const negative = await search.execute({ query: 'dialog', limit: -1 }, {})
const reproduced = zero.results.length === 8 && negative.results.length === 1
console.log('EXPECT: 0 and -1 rejected or clamped to 1 without contradicting the docs; ACTUAL:', zero.results.length, '/', negative.results.length)
console.log(reproduced ? 'DEFECT REPRODUCED (low severity)' : 'not reproduced')
process.exitCode = reproduced ? 1 : 0
