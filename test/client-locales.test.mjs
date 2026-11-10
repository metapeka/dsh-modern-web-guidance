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
  for (const base of ['call', 'hit', 'miss', 'file', 'finding']) {
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

/** The strings panel v2 added: the window switch, the daily bars and the tool/outcome breakdown. */
const PANEL_V2_KEYS = [
  'period.short',
  'hitRate.raw',
  'section.series',
  'series.bar',
  'section.breakdown',
  'breakdown.byTool',
  'breakdown.byOutcome',
  'breakdown.empty',
]

test('every panel-v2 string exists in all three dictionaries and is rendered', () => {
  for (const key of PANEL_V2_KEYS) {
    for (const name of DICTIONARIES) {
      const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
      assert.ok(dictionary.has(key), `${name} has no ${key}`)
    }
    // A string that no `t('…')` call reads is dead weight in three dictionaries at once.
    assert.ok(CLIENT_SOURCE.includes(`t('${key}'`), `client.js never renders ${key}`)
  }
  for (const key of PANEL_V2_KEYS) {
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
  }
})

test('the window switch owns the period and the command line follows it', () => {
  assert.match(CLIENT_SOURCE, /const PERIODS = \[7, 30\]/, 'the header switch no longer offers 7 and 30 days')
  // The panel never hard-codes the window into the command line: it appends `--days` from state, so
  // Refresh re-runs the window that is on screen instead of always asking for the default one.
  assert.ok(CLIENT_SOURCE.includes('--days ${asCount(days)}'), 'the report line is not built from the selected window')
  assert.ok(CLIENT_SOURCE.includes('useState(PERIODS[0])'), 'the selected window has no component state')
})

test('the panel derives its own hit rate from the outcome counters', () => {
  // `totals.hitRate` counts `list` and `error` as misses; the tile shows hits over real attempts and
  // keeps the report's number in the tooltip, so the difference stays visible.
  assert.match(CLIENT_SOURCE, /hitRateHonest:\s*attempts > 0/, 'client.js no longer derives an honest hit rate')
  assert.match(CLIENT_SOURCE, /percent\(report\.hitRateHonest\)/, 'the hit-rate tile does not use the derived rate')
  assert.match(CLIENT_SOURCE, /percent\(report\.hitRate\)/, 'the report hit rate is not shown next to it')
})

/** The strings layers two and three added: the scanner section, the scan facts and the chat row. */
const SCANNER_KEYS = [
  'section.scanner',
  'scanner.none',
  'scanner.last',
  'scanner.rules',
  'scanner.guides',
  'scanner.scan',
  'scanner.scanning',
  'scanner.failed',
  'scan.summary',
  'scan.clean',
  'scan.truncated',
  'row.title',
  'row.preparing',
  'row.running',
  'row.stopped',
  'row.failed',
  'row.paths',
  'row.more',
  'row.rule',
  'row.confidence',
  'row.location',
  'row.guide',
]

test('every scanner string exists in all three dictionaries and is rendered', () => {
  for (const key of SCANNER_KEYS) {
    for (const name of DICTIONARIES) {
      const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
      assert.ok(dictionary.has(key), `${name} has no ${key}`)
    }
    // A string no `t('…')` call reads would be dead weight in three dictionaries at once.
    assert.ok(CLIENT_SOURCE.includes(`t('${key}'`), `client.js never renders ${key}`)
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
  }
  // The two counts the scan sections print go through the plural helper, which needs both bases.
  for (const base of ['file', 'finding']) {
    assert.ok(CLIENT_SOURCE.includes(`plural(t, '${base}'`), `client.js never pluralizes ${base}`)
    assert.ok(EN.has(`${base}.many`), `EN has no ${base} plural forms`)
  }
})

test('the scanner section is fed by the report and can start a scan', () => {
  assert.ok(CLIENT_SOURCE.includes("const SCAN_LINE = '/guidance-scan . --format json'"), 'the scan command line changed')
  // The three report fields the section reads, each kept rather than dropped.
  assert.match(CLIENT_SOURCE, /topRules: rankedIds\(/, 'the report top rules are no longer read')
  assert.match(CLIENT_SOURCE, /topScanGuides: rankedIds\(/, 'the report scan guides are no longer read')
  assert.match(CLIENT_SOURCE, /lastScan: readLastScan\(/, 'the report last scan is no longer read')
  // The answer to the button is parsed defensively, and a refusal is a state, not a throw.
  assert.match(CLIENT_SOURCE, /value: readScanEnvelope\(envelope\)/, 'the scan reply is not parsed into the section')
  assert.ok(CLIENT_SOURCE.includes("panelError('scan'"), 'a broken scan reply is not tagged as a scan failure')
  // A capped scan says so, in both places that render it.
  const truncated = CLIENT_SOURCE.match(/t\('scan\.truncated'/g) ?? []
  assert.ok(truncated.length >= 2, 'the truncation notice is missing from the panel or the chat row')
  // The section renders in the empty state too: its button is the only way to scan from the panel.
  assert.match(CLIENT_SOURCE, /renderEmpty\(t, report\)[\s\S]{0,160}renderScanner\(t, report, scan, busy, runScan\)/)
})

test('the chat row registers into the keyed tool-view slot under the scan wire name', () => {
  assert.ok(CLIENT_SOURCE.includes("const SCAN_TOOL_NAME = 'web_guidance_legacy_scan'"), 'the wire name changed')
  // Keyed registration only: an unkeyed `tool.call.toolview` entry would replace the renderer for
  // every tool in the transcript instead of adding one row.
  const registrations = CLIENT_SOURCE.match(/name: 'tool\.call\.toolview'/g) ?? []
  assert.equal(registrations.length, 1, 'client.js registers the tool view more than once')
  assert.match(
    CLIENT_SOURCE,
    /name: 'tool\.call\.toolview',\s*key: SCAN_TOOL_NAME,\s*locale: NS,/,
    'the tool view is not registered additively under the scan wire name',
  )
})

test('the chat row reads the documented tool-call props instead of guessing', () => {
  // `phase` and `block` are the documented `ToolCallOwnerProps`; `block.argsRaw` is the start-stage
  // argument reader, and a settled block carries `kind`, `content`, `error` and `isError`.
  assert.match(CLIENT_SOURCE, /const phase = props\.phase/, 'the row does not read the phase prop')
  assert.match(CLIENT_SOURCE, /const block = props\.block/, 'the row does not read the block prop')
  assert.match(CLIENT_SOURCE, /const raw = asText\(block_\.argsRaw\)/, 'the started arguments are not read from argsRaw')
  assert.ok(CLIENT_SOURCE.includes("'kind' in block"), 'a settled result block is not detected by its kind')
  assert.match(CLIENT_SOURCE, /for \(const item of content\)/, 'the result content array is not read')
  assert.match(CLIENT_SOURCE, /block\.isError === true/, 'the failure flag is not read')
  assert.ok(CLIENT_SOURCE.includes("=== 'interrupted'"), 'an interrupted scan is not recognised')
  // The row is capped: sixteen findings and one line for the rest.
  assert.ok(CLIENT_SOURCE.includes('const MAX_TOOL_ROWS = 16'), 'the row no longer caps its findings')
  assert.match(CLIENT_SOURCE, /t\('row\.more', \{ count: rest \}\)/, 'the rest of the findings are not summarised')
})

test('the panel counts and the chat row locates', () => {
  // Counters are not evidence: the panel renders a rule id with its count, and `path:line` appears
  // only in the chat row, where it belongs to a call the session already made.
  assert.ok(
    (CLIENT_SOURCE.match(/scanRuleLine\(/g) ?? []).length >= 3,
    'the panel sections no longer render rule counts',
  )
  assert.ok(!CLIENT_SOURCE.includes('scanRuleLine(finding'), 'the panel renders a finding instead of a rule count')
  assert.match(
    CLIENT_SOURCE,
    /const place = finding\.path === '' \? '' : `\$\{finding\.path\}:\$\{finding\.line\}`/,
    'the chat row no longer locates a finding',
  )
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
