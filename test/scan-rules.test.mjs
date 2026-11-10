/**
 * Contract tests for `lib/scan-rules.js`.
 *
 * These pin the parts other 0.5.0 workstreams depend on: the table shape, the ordering of
 * ids, that every guide pointer still resolves in the catalog, that each `source` is a
 * clean flag-free RegExp source, and that the marker vocabulary actually fires on legacy
 * code while staying quiet on its modern replacement. A rule that cannot pass its own
 * sample does not belong in the table.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONFIDENCE_ORDER, RULES, ruleById, selectRules } from '../lib/scan-rules.js'
import { DATA_DIR } from './paths.mjs'

const GUIDES = JSON.parse(await readFile(join(DATA_DIR, 'guides.json'), 'utf8'))
const GUIDE_IDS = new Set(GUIDES.map((guide) => guide.id))

/** A line the rule must match, and a modern counterpart it must leave alone. */
const SAMPLES = {
  'ls-01': ['.x::-webkit-scrollbar { width: 8px }', '.x { scrollbar-width: thin; scrollbar-color: #999 #eee }'],
  'ls-02': ['.x { background-image: -webkit-image-set("a.png" 1x) }', '.x { background-image: image-set("a.png" 1x, "a@2x.png" 2x) }'],
  'ls-03': ['.x { -webkit-mask-image: linear-gradient(black, transparent) }', '.x { mask-image: linear-gradient(black, transparent) }'],
  'ls-04': ['a { -webkit-text-emphasis: dot }', 'a { text-decoration: underline; text-underline-offset: 2px }'],
  'ls-05': ['.row:nth-child(3) { animation-delay: 60ms }', '.row { animation-delay: calc(sibling-index() * 20ms) }'],
  'ls-06': ['.icon { filter: invert(1) sepia(1) hue-rotate(90deg) }', '.icon { mask: url(star.svg) center/1em; background-color: currentColor }'],
  'ls-07': ['input[type="checkbox"] + span { background: url(check.svg) }', 'input[type="checkbox"] { accent-color: #06c }'],
  'ls-08': ['input:invalid { border-color: red }', 'input:user-invalid { border-color: red }'],
  'ls-09': ['.panel { transition: max-height 0.3s ease }', '.panel { interpolate-size: allow-keywords; transition: height 0.3s }'],
  'ls-10': ['@media (prefers-color-scheme: dark) { body { background: #111 } }', 'body { color-scheme: light dark; background: light-dark(#fff, #111) }'],
  'ls-11': ["root.classList.toggle('dark')", "document.querySelector('meta[name=color-scheme]').content = 'dark'"],
  'ls-12': ['.row { display: -webkit-box; -webkit-box-orient: horizontal }', '.row { display: flex; gap: 8px }'],
  'ls-13': ['<div class="modal" id="m">…</div>', '<dialog id="m" closedby="any">…</dialog>'],
  'ls-14': ['<button data-bs-toggle="modal" data-bs-target="#m">Open</button>', '<button commandfor="m" command="show-modal">Open</button>'],
  'ls-15': ['<div role="progressbar" aria-valuenow="40"></div>', '<progress value="40" max="100"></progress>'],
  'ls-16': ['el.innerHTML = userInput', 'el.setHTML(userInput)'],
  'ls-17': ["document.write('<p>hi</p>')", "document.body.append(Object.assign(document.createElement('p'), { textContent: 'hi' }))"],
  'ls-18': ["document.execCommand('copy')", 'await navigator.clipboard.writeText(text)'],
  'ls-19': ['noUiSlider.create(el, { start: 50, range: { min: 0, max: 100 } })', '<input type="range" min="0" max="100" value="50">'],
  'ls-20': ['tippy(el, { content: "Hi" })', '<button popovertarget="tip">…</button><div popover id="tip">Hi</div>'],
  'ls-21': ['AOS.init({ duration: 400 })', '.x { animation-timeline: view(); animation-range: entry, exit }'],
  'ls-22': ['fitty(el, { minSize: 12 })', '.x { text-wrap: balance }'],
  'ls-23': ['<nav data-bs-spy="scroll" data-bs-target="#toc">', '<nav>{ scroll-target-group: auto }'],
  'ls-24': ['<style>.async-hide { opacity: 0 !important }</style>', '<script async blocking="render" src="ab.js"></script>'],
  'ls-25': ['<script src="https://cdn.jsdelivr.net/npm/lib@1/lib.js"></script>', '<script src="/vendor/lib@1/lib.js" integrity="sha384-…" crossorigin="anonymous"></script>'],
  'ls-26': ['const label = humanizeDuration(90000)', 'const label = new Intl.DurationFormat("en").format({ minutes: 1, seconds: 30 })'],
  'ls-27': ["$field.parent().addClass('is-invalid')", '.field:has(:user-invalid) { outline: 2px solid red }'],
  'ls-28': ["el.style.height = el.scrollHeight + 'px'", '.grow { field-sizing: content }'],
  'ls-29': ["if (event.keyCode === 13) submit()", "if (event.key === 'Enter' && !event.isComposing) submit()"],
  'ls-30': ["document.registerElement('x-widget', { prototype })", "customElements.define('x-widget', Widget)"],
  'ls-31': ['.legacy:host-context(.dark) { --surface: #111 }', ':host { --surface: #fff }'],
  'ls-32': ['<Balancer>{title}</Balancer>', '.title { text-wrap: balance }'],
  'ls-33': ['select:invalid { border-color: red }', 'select:user-invalid { border-color: red }'],
}

test('table holds exactly 33 ordered, unique rule ids', () => {
  assert.equal(RULES.length, 33)
  const ids = RULES.map((rule) => rule.id)
  assert.equal(new Set(ids).size, 33)
  assert.deepEqual(ids, Array.from({ length: 33 }, (_, index) => `ls-${String(index + 1).padStart(2, '0')}`))
  assert.ok(Object.isFrozen(RULES))
})

test('confidence vocabulary is exactly high/medium/low, ordered strongest first', () => {
  assert.deepEqual([...CONFIDENCE_ORDER], ['high', 'medium', 'low'])
  for (const rule of RULES) assert.ok(CONFIDENCE_ORDER.includes(rule.confidence), rule.id)
})

test('every guide pointer resolves in the shipped catalog', () => {
  let withGuide = 0
  for (const rule of RULES) {
    if (rule.guideId === null) continue
    withGuide += 1
    assert.ok(GUIDE_IDS.has(rule.guideId), `${rule.id} points at unknown guide ${rule.guideId}`)
  }
  assert.equal(withGuide, RULES.length)
})

test('the table covers exactly 33 distinct guides, one per rule', () => {
  const covered = new Set(RULES.map((rule) => rule.guideId))
  assert.equal(covered.size, 33)
  assert.equal(covered.size, RULES.length)
})

test('every source is a flag-free RegExp source that never matches an empty string', () => {
  for (const rule of RULES) {
    const compiled = new RegExp(rule.source, 'g')
    assert.equal(compiled.flags, 'g', `${rule.id} baked flags into its source`)
    compiled.lastIndex = 0
    assert.equal(''.match(compiled), null, `${rule.id} matches the empty string`)
  }
  assert.equal(new Set(RULES.map((rule) => rule.source)).size, RULES.length)
})

test('every message is one non-empty imperative sentence', () => {
  for (const rule of RULES) {
    assert.equal(typeof rule.message, 'string', rule.id)
    const message = rule.message.trim()
    assert.ok(message.length >= 20, `${rule.id} message is too short`)
    assert.ok(!message.includes('\n'), `${rule.id} message wraps`)
    assert.ok(message.endsWith('.'), `${rule.id} message is not a sentence`)
    // Dotted API names are fine (`element.setHTML()`); a period followed by whitespace is a
    // sentence boundary, and a rule message must not have a second one.
    assert.ok(!/\.\s/.test(message), `${rule.id} message is more than one sentence`)
    assert.ok(/^[A-Z]/.test(message), `${rule.id} message does not start with a capital`)
  }
})

test('each rule fires on its legacy sample and stays quiet on the modern one', () => {
  for (const rule of RULES) {
    const [legacy, modern] = SAMPLES[rule.id]
    assert.ok(new RegExp(rule.source).test(legacy), `${rule.id} missed its own sample`)
    assert.ok(!new RegExp(rule.source).test(modern), `${rule.id} fired on the modern counterpart`)
  }
})

test('one legacy line yields exactly one finding, never two rules on the same marker', () => {
  for (const [id, [legacy]] of Object.entries(SAMPLES)) {
    const matched = RULES.filter((rule) => new RegExp(rule.source).test(legacy)).map((rule) => rule.id)
    assert.deepEqual(matched, [id], `${legacy} should fire only ${id}`)
  }
})

test('ls-32 catches both the balanceText() call and the <Balancer> JSX element', () => {
  const rule = RULES.find((entry) => entry.id === 'ls-32')
  for (const line of ['balanceText(el, { watch: true })', 'const x = <Balancer>{title}</Balancer>', '<Balancer className="t" />']) {
    assert.ok(new RegExp(rule.source).test(line), `ls-32 missed ${line}`)
  }
  // The JSX form has no call parenthesis: a `name(` pattern alone would have missed it.
  assert.ok(!/balanceText\s*\(/.test('<Balancer>{title}</Balancer>'))
})

test('ls-08 leaves select:invalid alone and ls-22 leaves balancing markers alone', () => {
  const byId = (id) => RULES.find((rule) => rule.id === id).source
  // ls-33 owns the select reading; ls-08 must not steal it back.
  assert.ok(!new RegExp(byId('ls-08')).test('select:invalid { border-color: red }'))
  assert.ok(new RegExp(byId('ls-08')).test('input:invalid { border-color: red }'))
  assert.ok(new RegExp(byId('ls-08')).test('textarea:invalid { border-color: red }'))
  // ls-32 owns balancing; ls-22 keeps the fitty/fitText sizing markers.
  for (const line of ['balanceText(el)', '<Balancer>{title}</Balancer>']) {
    assert.ok(!new RegExp(byId('ls-22')).test(line), `ls-22 still claims ${line}`)
    assert.ok(new RegExp(byId('ls-32')).test(line), `ls-32 misses ${line}`)
  }
  assert.ok(new RegExp(byId('ls-22')).test('fitty(el)'))
  assert.ok(new RegExp(byId('ls-22')).test('fitText(el, 1.2)'))
})

test('speculation stays rare and always names a guide', () => {
  const flagged = RULES.filter((rule) => rule.confidence === 'low')
  assert.ok(flagged.length <= 3, `${flagged.length} low-confidence rules is too many`)
  for (const rule of flagged) assert.ok(rule.guideId, `${rule.id} is speculative but points nowhere`)
})

test('selectRules(undefined) returns every rule in table order', () => {
  const { rules, unknown } = selectRules(undefined)
  assert.deepEqual(unknown, [])
  assert.deepEqual(rules.map((rule) => rule.id), RULES.map((rule) => rule.id))
  assert.equal(selectRules([]).rules.length, 0)
})

test('selectRules reports unknown ids instead of throwing', () => {
  const { rules, unknown } = selectRules(['ls-01', 'nope'])
  assert.deepEqual(rules.map((rule) => rule.id), ['ls-01'])
  assert.deepEqual(unknown, ['nope'])

  const duplicates = selectRules(['ls-02', 'ls-02'])
  assert.deepEqual(duplicates.rules.map((rule) => rule.id), ['ls-02'])
  assert.deepEqual(duplicates.unknown, [])

  const ordered = selectRules(['ls-30', 'ls-01'])
  assert.deepEqual(ordered.rules.map((rule) => rule.id), ['ls-30', 'ls-01'])

  const repeated = selectRules(['nope', 'ls-03', 'nope'])
  assert.deepEqual(repeated.unknown, ['nope'])
  assert.deepEqual(repeated.rules.map((rule) => rule.id), ['ls-03'])
})

test('ruleById resolves known ids and shrugs at the rest', () => {
  assert.equal(ruleById('ls-08').guideId, 'validate-input-after-interaction')
  assert.equal(ruleById('nope'), undefined)
  assert.equal(ruleById(undefined), undefined)
  assert.equal(ruleById('ls-01').id, 'ls-01')
})
