// Repro 05 — category matching is exact and unnormalized: "CSS", "css " and a bogus
// category all silently return an empty result instead of the valid category or an error.
// Run: node audit/repro/bugs/05-category-not-normalized.mjs
//
// EXPECT: category values are trimmed/compared case-insensitively (or rejected with a hint
//         listing the 17 valid categories). ACTUAL: exact string compare, empty result.
import { createGuidance } from '../../../lib/guidance.js'
import { apply } from '../../../index.js'
import { createContext, DATA_DIR } from './_harness.mjs'

const guidance = createGuidance({ dataDir: DATA_DIR })
const { ctx, tools } = createContext()
apply(ctx)
const search = tools.find((tool) => tool.name === 'web_guidance_search')
const list = tools.find((tool) => tool.name === 'web_guidance_list')

for (const category of ['css', 'CSS', 'Css', 'css ', ' css', 'ui-behavior', null]) {
  const hits = await search.execute({ query: 'color', category }, {})
  const rows = await list.execute({ category }, {})
  console.log(
    `category=${JSON.stringify(category).padEnd(9)} search hits=${String(hits.results.length).padEnd(2)} list rows=${rows.guides?.length ?? rows.total}`,
  )
}

const lower = await search.execute({ query: 'color', category: 'css' }, {})
const upper = await search.execute({ query: 'color', category: 'CSS' }, {})
const reproduced = lower.results.length > 0 && upper.results.length === 0
console.log('EXPECT: "CSS" behaves like "css"; ACTUAL: "css" ->', lower.results.length, 'hits, "CSS" ->', upper.results.length, 'hits with no diagnostic')
console.log(reproduced ? 'DEFECT REPRODUCED' : 'not reproduced')
process.exitCode = reproduced ? 1 : 0
