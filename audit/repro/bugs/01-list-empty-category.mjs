// Repro 01 — web_guidance_list({category: ""}) reports an empty catalog.
// Run: node audit/repro/bugs/01-list-empty-category.mjs
//
// EXPECT: category "" (or " ") is treated like an omitted category -> 193 guides, 17 categories.
// ACTUAL: the filter runs before the empty-string check, so total is 0 and categories is empty.
import { apply } from '../../../index.js'
import { createContext } from './_harness.mjs'

const { ctx, tools } = createContext()
apply(ctx)
const list = tools.find((tool) => tool.name === 'web_guidance_list')

const omitted = await list.execute({}, {})
const empty = await list.execute({ category: '' }, {})
const blank = await list.execute({ category: '   ' }, {})

const render = (value, args) => list.output.render(args, value)[0].text.split('\n')[0]

console.log('omitted          ->', JSON.stringify({ total: omitted.total, categories: omitted.categories.length }))
console.log('category ""      ->', JSON.stringify({ total: empty.total, categories: empty.categories.length }))
console.log('category "   "   ->', JSON.stringify({ category: blank.category, guides: blank.guides?.length }))
console.log('rendered ""      ->', render(empty, { category: '' }))
console.log('EXPECT: 193 / 17 for "" (and the blank string), ACTUAL:', empty.total, '/', empty.categories.length)

const reproduced = empty.total === 0 && omitted.total === 193
console.log(reproduced ? 'DEFECT REPRODUCED' : 'not reproduced')
process.exitCode = reproduced ? 1 : 0
