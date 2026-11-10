import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { PACKAGE_DIR } from './paths.mjs'

/**
 * The Guidance Insights panel ships its dictionaries inline in `client.js` (a client half is loaded
 * as-is, with no bundler and no relative imports), so nothing type-checks them. These tests are the
 * safety net: a new key, a lost placeholder or a half-translated dictionary fails here instead of
 * rendering an untranslated key in the panel.
 *
 * Dictionaries are read as text, not imported: `client.js` is a browser module that calls
 * `window.__ModuleLoader__.load(...)` at load time and cannot be imported by Node.
 */

const CLIENT_SOURCE = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8')
const DICTIONARIES = ['EN', 'RU', 'ZH']
const CJK = /[\u4e00-\u9fff]/
const PLACEHOLDER = /\{(\w+)\}/g
/** Names that stay Latin in every language: a tool the model calls and a command the user types. */
const LATIN_NAMES = ['/guidance-stats', 'web_guidance_search']

/** The text between the braces of `const <name> = { ... }`, honouring quotes and nested braces. */
function dictionaryBody(source, name) {
  const marker = `const ${name} = {`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `client.js declares no ${name} dictionary`)
  const open = source.indexOf('{', start + marker.length - 1)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === "'" || character === '"') {
      const quote = character
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  assert.ok(end > open, `client.js has an unterminated ${name} dictionary`)
  return source.slice(open + 1, end)
}

/** One dictionary as an ordered key -> value map, with its authoring convention enforced. */
function parseDictionary(source, name) {
  const body = dictionaryBody(source, name)
  const entries = []
  const pattern = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    entries.push([unescape(match[1]), unescape(match[2])])
  }
  // The dictionaries are written one `'key': 'value',` per line. A different line count means the
  // pattern above missed a value (a template literal, a double-quoted string, a broken line), and
  // every comparison below would then quietly run on part of a dictionary.
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  assert.equal(lines.length, entries.length, `${name} is not one 'key': 'value' pair per line`)
  return new Map(entries)
}

function unescape(text) {
  return text.replace(/\\(.)/g, '$1')
}

/** The placeholder names of one value, sorted so the comparison ignores their order. */
function placeholders(value) {
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]))].sort()
}

const EN = parseDictionary(CLIENT_SOURCE, 'EN')
const RU = parseDictionary(CLIENT_SOURCE, 'RU')
const ZH = parseDictionary(CLIENT_SOURCE, 'ZH')

test('client.js registers the panel dictionaries as en, ru and zh', () => {
  assert.match(
    CLIENT_SOURCE,
    /ctx\.locale\.register\(NS, \{ en: EN, ru: RU, zh: ZH \}\)/,
    'the locale registration does not offer all three dictionaries',
  )
  // A parser that silently returned nothing would pass every parity check below, so pin the size.
  assert.ok(EN.size >= 30, `only ${EN.size} English keys parsed out of client.js`)
})

test('every dictionary has exactly the English keys, in the English order', () => {
  const keys = [...EN.keys()]
  for (const name of DICTIONARIES) {
    const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
    assert.deepEqual([...dictionary.keys()], keys, `${name} does not match the English key set`)
  }
})

test('no dictionary leaves a key or an empty value behind', () => {
  for (const name of DICTIONARIES) {
    const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
    for (const [key, value] of dictionary) {
      assert.notEqual(value.trim(), '', `${name}.${key} is empty`)
      assert.notEqual(value, key, `${name}.${key} is still the raw key`)
    }
  }
})

test('every Chinese value keeps the placeholders of its English source', () => {
  for (const [key, value] of EN) {
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(value), `placeholders differ for ZH.${key}`)
  }
})

test('the Chinese dictionary defines all three plural forms with the same text', () => {
  for (const base of ['call', 'hit', 'miss']) {
    const forms = ['one', 'few', 'many'].map((form) => ZH.get(`${base}.${form}`))
    assert.ok(forms.every((form) => typeof form === 'string'), `${base} is missing a plural form`)
    assert.equal(new Set(forms).size, 1, `${base} plural forms differ, but Chinese has no plural`)
    assert.match(forms[0], /\{count\}/, `${base} plural forms have no {count} placeholder`)
  }
})

test('every Chinese value is translated, not copied from English', () => {
  for (const [key, value] of ZH) {
    // A value made only of placeholders and punctuation is the same in every language.
    const text = value.replace(PLACEHOLDER, '')
    if (!/[A-Za-z]/.test(text)) continue
    assert.match(value, CJK, `ZH.${key} carries no Chinese text: "${value}"`)
  }
})

test('the command and tool names stay Latin in Chinese', () => {
  for (const [key, value] of EN) {
    for (const name of LATIN_NAMES) {
      if (!value.includes(name)) continue
      assert.ok(ZH.get(key).includes(name), `ZH.${key} lost ${name}`)
    }
  }
})

/** The three keys the 0.5.0 panel gained for the fourth tool, in the order every dictionary keeps. */
const LEGACY_SCAN_KEYS = ['stats.legacyScan', 'stats.findings', 'tool.legacyScan']

test('the fourth tool is named in every dictionary, in the same order', () => {
  for (const name of DICTIONARIES) {
    const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
    const keys = [...dictionary.keys()]
    const positions = LEGACY_SCAN_KEYS.map((key) => {
      const position = keys.indexOf(key)
      assert.notEqual(position, -1, `${name} is missing ${key}`)
      return position
    })
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${name} keeps the fourth-tool keys out of order`)
  }
})

test('the fourth-tool keys carry the same placeholders and are really translated', () => {
  for (const key of LEGACY_SCAN_KEYS) {
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.match(ZH.get(key), CJK, `ZH.${key} is not Chinese: "${ZH.get(key)}"`)
    assert.notEqual(ZH.get(key), EN.get(key), `ZH.${key} is copied from English`)
  }
})

test('the panel renders the fourth tool and survives a report without its counter', () => {
  for (const key of LEGACY_SCAN_KEYS) {
    assert.ok(CLIENT_SOURCE.includes(`t('${key}')`), `client.js never renders ${key}`)
  }
  // A report built from a 0.4.x state file has no `legacy-scan` counter and no findings total. Both
  // tiles still render, so both numbers must be read through the helper that answers 0 for a missing
  // field rather than formatting `undefined` into the row as `NaN`.
  assert.match(CLIENT_SOURCE, /legacyScan: firstCount\(/, 'the fourth tool count is not read tolerantly')
  assert.match(CLIENT_SOURCE, /findings: firstCount\(/, 'the findings total is not read tolerantly')
})

test('the plugin-list locale card mirrors locale/en.json in every language', () => {
  const read = (locale) => JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', `${locale}.json`), 'utf8'))
  const en = read('en')
  assert.deepEqual(Object.keys(en), ['meta'])
  assert.deepEqual(Object.keys(en.meta).sort(), ['description', 'title'])
  for (const locale of ['ru', 'zh']) {
    const card = read(locale)
    assert.deepEqual(Object.keys(card), Object.keys(en), `locale/${locale}.json has a different top level`)
    assert.deepEqual(Object.keys(card.meta), Object.keys(en.meta), `locale/${locale}.json meta differs`)
    for (const field of ['title', 'description']) {
      assert.equal(typeof card.meta[field], 'string', `locale/${locale}.json meta.${field} is not a string`)
      assert.notEqual(card.meta[field].trim(), '', `locale/${locale}.json meta.${field} is empty`)
    }
  }
})

test('the Chinese plugin-list card is written in Chinese', () => {
  const card = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', 'zh.json'), 'utf8'))
  assert.match(card.meta.title, CJK, 'locale/zh.json meta.title has no Chinese text')
  assert.match(card.meta.description, CJK, 'locale/zh.json meta.description has no Chinese text')
  assert.match(card.meta.description, /Google Chrome/, 'locale/zh.json should keep the product name')
})
