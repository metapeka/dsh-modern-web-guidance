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
  'scanner.skipped',
  'scanner.cut',
  'scanner.rules',
  'scanner.lifetime',
  'scanner.guides',
  'scanner.scan',
  'scanner.scanning',
  'scanner.failed',
  'scan.summary',
  'scan.skipped',
  'scan.skippedMore',
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

test('the scan caveats are read from the value and rendered, not dropped', () => {
  // The value `/guidance-scan --format json` returns already carries both caveats; the panel reads
  // them instead of rendering the counts alone.
  assert.match(CLIENT_SOURCE, /skipped: readSkipMap\(scanned\.skippedByReason\)/, 'the scan skip map is not read')
  assert.match(CLIENT_SOURCE, /skipped: readSkipMap\(value\.skipped\)/, 'the stored scan skip map is not read')
  // A missing map on a 0.7.2 state file reads as empty instead of crashing the section.
  assert.match(
    CLIENT_SOURCE,
    /value !== null && typeof value === 'object' && Array\.isArray\(value\) === false/,
    'a non-object skip map is no longer ignored',
  )
  // Three reasons fit a rail; the rest are counted on the same line rather than hidden.
  assert.ok(CLIENT_SOURCE.includes('const SKIP_REASONS_SHOWN = 3'), 'the skip-reason limit changed')
  assert.match(CLIENT_SOURCE, /const rest = skipped\.rows\.length - shown\.length/, 'the remaining reasons are not counted')
  assert.match(CLIENT_SOURCE, /if \(rest > 0\) reasons\.push\(t\('scan\.skippedMore'/, 'the +N more suffix is not rendered')
  // Reason tokens are the scanner's own vocabulary, shown verbatim exactly like a rule id.
  assert.match(CLIENT_SOURCE, /shown\.map\(\(row\) => `\$\{row\.calls\} \$\{row\.name\}`\)/, 'reasons are no longer printed as count + token')
  assert.ok(!CLIENT_SOURCE.includes("t(row.name"), 'a skip reason is translated')
  // Both render sites: the button's inline result and the chat row that carries the same value.
  const calls = CLIENT_SOURCE.match(/skipLine\(t, value\.skipped, SKIP_REASONS_SHOWN\)/g) ?? []
  assert.equal(calls.length, 2, 'the skip line is missing from the panel result or the chat row')
  assert.match(CLIENT_SOURCE, /if \(value\.skipped\.total > 0\)/, 'the skip line is rendered even when nothing was skipped')
})

test('a stale last scan without the new fields renders a shorter line, not a broken one', () => {
  // 0.7.2 state files have no `skipped`/`truncated` in `lastScan`: the line keeps its date and two
  // counts and simply adds nothing, instead of printing `undefined` or throwing.
  assert.match(
    CLIENT_SOURCE,
    /if \(last !== null && last\.skipped\.total > 0\) lastFacts\.push\(t\('scanner\.skipped'/,
    'the skipped fact is not conditional on a non-empty map',
  )
  assert.match(
    CLIENT_SOURCE,
    /if \(last !== null && last\.truncated\) lastFacts\.push\(t\('scanner\.cut'\)/,
    'the truncated fact is not conditional on the flag being true',
  )
  assert.ok(
    CLIENT_SOURCE.includes("lastFacts.length === 0 ? t('scanner.none') : lastFacts.join(' · ')"),
    'the last-scan line is no longer one joined line',
  )
  // `lastScan: null` still says nothing has run; the new facts never resurrect it.
  assert.match(CLIENT_SOURCE, /last === null\s*\n?\s*\? \[\]/, 'a null last scan no longer starts empty')
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
    /function findingPlace\(finding\)/,
    'the chat row no longer has one place to format a location',
  )
  assert.ok(
    CLIENT_SOURCE.includes('const place = findingPlace(finding)'),
    'the chat row no longer locates a finding through findingPlace',
  )
})

/** The strings Phase A added: a rule row that explains itself instead of printing a bare pair. */
test('a rule row names its confidence, its unit and the rule message', () => {
  assert.match(CLIENT_SOURCE, /function scanRuleLine\(t, rule, first\)/, 'the rule row does not take the translator')
  // The confidence token is raw, exactly like a rule id: no dictionary entry may ever grow for it.
  assert.match(CLIENT_SOURCE, /h\('span', \{ style: S\.scanConfidence \}, confidence\)/, 'the confidence token is not rendered')
  assert.ok(!CLIENT_SOURCE.includes('confidence.high'), 'a confidence token was translated')
  // `121` alone says neither what it counts nor whether it is findings or files.
  assert.ok(CLIENT_SOURCE.includes("plural(t, 'finding', rule.calls)"), 'the rule count does not name its unit')
  // The message is a second line clamped by CSS (the full sentence stays in the title) and dropped
  // when absent, because a live scan answer still carries only an id and a count.
  assert.match(
    CLIENT_SOURCE,
    /message === '' \? null : h\('div', \{ style: S\.scanMessage, title: hint \}, message\)/,
    'the rule message is not rendered under the row',
  )
  assert.match(CLIENT_SOURCE, /WebkitLineClamp: '2'/, 'the rule message is not clamped to two lines')
  assert.ok(!CLIENT_SOURCE.includes('message.slice('), 'the rule message is cut by the client instead of clamped by CSS')
  // Every colour still comes from a theme token, never from a literal.
  assert.ok(!/#[0-9a-fA-F]{3,10}\b/.test(CLIENT_SOURCE), 'a style value is a literal colour instead of a --dsw-alias-* token')
})

test('the report hands the rule and guide detail through, and an old host costs only a caption', () => {
  // The ranked rows carry the rule's dates as well as its words: five optional fields, each read as
  // '' when the host does not send it.
  assert.match(
    CLIENT_SOURCE,
    /topRules: rankedIds\(asRows\(payload\.topRules\), 'ruleId', \[\s*'message',[\s\S]*?'lastSeen',\s*\]\)\.slice\(0, MAX_SCAN_RULES\)/,
    'the rule detail is not read from the report',
  )
  assert.match(
    CLIENT_SOURCE,
    /topScanGuides: rankedIds\(asRows\(payload\.topScanGuides\), 'guideId', \['description'\]\)\.slice\(0, MAX_SCAN_RULES\)/,
    'the guide description is not read from the report',
  )
  // Every extra field defaults to '': a report that predates them renders the same row it did, only
  // without the detail — version skew costs a hint, never the row.
  assert.ok(
    CLIENT_SOURCE.includes('for (const field of extras) ranked[field] = asText(row[field])'),
    'the optional row fields are not read defensively',
  )
  assert.match(CLIENT_SOURCE, /scanCountsScope: asText\(payload\.scanCountsScope\)/, 'the count scope is not read')
  // One caption, and only when the host says the ranked counts are lifetime totals.
  assert.match(CLIENT_SOURCE, /if \(report\.scanCountsScope === 'lifetime'\)/, 'the lifetime caption is unconditional')
  assert.ok(
    CLIENT_SOURCE.includes("t('scanner.lifetime', { days: report.periodDays })"),
    'the lifetime caption does not name the selected window',
  )
})

test('the lifetime caption is translated and names the window in every language', () => {
  for (const name of DICTIONARIES) {
    const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
    assert.deepEqual(placeholders(dictionary.get('scanner.lifetime')), ['days'], `${name} does not name the {days} window`)
  }
  assert.match(RU.get('scanner.lifetime'), /[\u0400-\u04ff]/, 'RU.scanner.lifetime is not Russian')
  assert.match(ZH.get('scanner.lifetime'), CJK, 'ZH.scanner.lifetime has no Chinese text')
  assert.notEqual(RU.get('scanner.lifetime'), EN.get('scanner.lifetime'), 'RU.scanner.lifetime is copied from English')
  assert.notEqual(ZH.get('scanner.lifetime'), EN.get('scanner.lifetime'), 'ZH.scanner.lifetime is copied from English')
})

test('the guide chips explain themselves without changing their text', () => {
  // The visible text stays `id (count)`; the description is the hint, so it never lengthens the chip.
  assert.ok(CLIENT_SOURCE.includes('`${guide.name} (${guide.calls})`'), 'the guide chip text changed')
  assert.match(CLIENT_SOURCE, /title: description === '' \? guide\.name : description/, 'the guide chip carries no description hint')
})

/**
 * The hook cells of the component being rendered, and the cursor inside its current render.
 *
 * React is not a dependency of this suite, so a component is driven by calling it: one state cell
 * per `useState` in call order, kept across renders so a second render sees the update, and every
 * effect run once per render so a reload shows up as the bridge call it makes. `resetHooks()` starts
 * a fresh component instance; `renderOnce` starts a fresh render of the instance that already owns
 * the cells.
 */
const HOOKS = { cells: [], index: 0 }

function resetHooks() {
  HOOKS.cells = []
  HOOKS.index = 0
}

const REACT = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children }
  },
  useState(initial) {
    const index = HOOKS.index
    HOOKS.index += 1
    if (HOOKS.cells[index] === undefined) HOOKS.cells[index] = { value: initial }
    const cell = HOOKS.cells[index]
    return [
      cell.value,
      (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
      },
    ]
  },
  useRef(value) {
    const index = HOOKS.index
    HOOKS.index += 1
    if (HOOKS.cells[index] === undefined) HOOKS.cells[index] = { value: { current: value } }
    return HOOKS.cells[index].value
  },
  useCallback(fn) {
    HOOKS.index += 1
    return fn
  },
  useEffect(fn) {
    HOOKS.index += 1
    fn()
  },
}

/** Render one hook-using component once: a fresh hook cursor over the cells it already owns. */
function renderOnce(component, props) {
  HOOKS.index = 0
  return component(props)
}

/**
 * The client half as the browser loads it: `window.__ModuleLoader__.load({ factory })` runs once, and
 * the `apply(ctx)` the factory returns registers the three slots. Loading it here lets a test drive a
 * component with the props the host passes, instead of only grepping the source for the call that
 * renders it.
 *
 * React is stubbed to what this file's components call: `createElement` and the four hooks the panel
 * uses. See `REACT` above for what those stubs promise.
 */
function loadClient() {
  let spec
  resetHooks()
  // The browser global, named `window` because that is what client.js reads.
  const browserWindow = { __ModuleLoader__: { load(candidate) { spec = candidate } } }
  const requireReact = (name) => {
    assert.equal(name, 'react', `client.js required ${name} instead of react`)
    return REACT
  }
  new Function('window', 'require', CLIENT_SOURCE)(browserWindow, requireReact)
  assert.ok(spec !== undefined && typeof spec.factory === 'function', 'client.js registered no factory')
  const components = new Map()
  const ctx = {
    locale: { bind: () => (key) => key, register() {} },
    effect: (run) => run(),
    slots: {
      inject: (name, add) => add(),
      register: (meta, component) => {
        components.set(`${meta.name}:${meta.key ?? meta.id ?? ''}`, component)
        return () => {}
      },
    },
  }
  spec.factory(requireReact).apply(ctx)
  return components
}

/** Every element of a stubbed render tree, depth first. */
function elementsOf(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) elementsOf(child, out)
  return out
}

/** The English dictionary as a translator, substituting `{name}` placeholders. */
function translate(key, params) {
  const value = EN.get(key)
  assert.notEqual(value, undefined, `no English string for ${key}`)
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    params === undefined || params[name] === undefined ? match : String(params[name]),
  )
}

test('the chat row keeps the finding message and snippet as tooltips, and an old result still renders', () => {
  const row = loadClient().get('tool.call.toolview:web_guidance_legacy_scan')
  assert.equal(typeof row, 'function', 'the chat row is not registered under the scan wire name')
  const tree = row({
    phase: 'result',
    t: translate,
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            scanned: { files: 2, bytes: 20, skippedByReason: {} },
            findings: [
              {
                ruleId: 'ls-17',
                confidence: 'high',
                path: 'src/a.js',
                line: 12,
                column: 3,
                guideId: 'anchor-positioning',
                message: 'Position the anchor instead of nudging the element',
                snippet: 'margin-left: -1px;',
              },
              // A finding from a host that predates the two fields: the cells fall back to the hints
              // they always had instead of rendering an empty tooltip or a broken row.
              { ruleId: 'ls-18', confidence: 'low', path: 'src/b.js', line: 4, column: 1, guideId: '' },
            ],
          }),
        },
      ],
    },
  })
  const elements = elementsOf(tree)
  const cell = (text) => elements.find((element) => element.children.includes(text))
  assert.equal(
    cell('ls-17').props.title,
    'Position the anchor instead of nudging the element',
    'the rule cell lost its message tooltip',
  )
  assert.equal(cell('src/a.js:12').props.title, 'margin-left: -1px;', 'the place cell lost its snippet tooltip')
  assert.equal(cell('ls-18').props.title, 'ls-18', 'the rule cell cannot fall back to its id')
  assert.equal(cell('src/b.js:4').props.title, 'src/b.js:4', 'the place cell cannot fall back to its place')
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

/** The strings workspace attribution added: the chip, the aggregate option, the unattributed bucket. */
const WORKSPACE_KEYS = ['workspace.label', 'workspace.all', 'workspace.unattributed', 'workspace.switch']

test('every workspace string exists in all three dictionaries and is rendered', () => {
  for (const key of WORKSPACE_KEYS) {
    for (const name of DICTIONARIES) {
      const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
      assert.ok(dictionary.has(key), `${name} has no ${key}`)
    }
    assert.ok(CLIENT_SOURCE.includes(`t('${key}'`), `client.js never renders ${key}`)
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
    // A chip that names nothing is a chip the reader has to decode.
    assert.match(RU.get(key), /[\u0400-\u04ff]/, `RU.${key} is not Russian`)
    assert.match(ZH.get(key), CJK, `ZH.${key} has no Chinese text`)
    assert.notEqual(RU.get(key), EN.get(key), `RU.${key} is copied from English`)
    assert.notEqual(ZH.get(key), EN.get(key), `ZH.${key} is copied from English`)
  }
  // One interpolated string carries the name, so the wire shape stays a chip and not a sentence.
  assert.deepEqual(placeholders(EN.get('workspace.label')), ['name'], 'the chip does not interpolate the workspace name')
})

test('the workspace keys are read additively and the switch reuses the report bridge', () => {
  // Both keys are optional on the wire: a 0.9.0 host sends neither, and the panel renders what it did.
  assert.match(CLIENT_SOURCE, /workspace: readWorkspace\(payload\.workspace\)/, 'the selected workspace is not read')
  assert.match(CLIENT_SOURCE, /workspaces: readWorkspaces\(payload\.workspaces\)/, 'the workspace list is not read')
  assert.match(
    CLIENT_SOURCE,
    /function readWorkspaces\(value\) \{[\s\S]{0,120}for \(const entry of asRows\(value\)\)/,
    'a malformed workspace list is not read as rows',
  )
  assert.match(
    CLIENT_SOURCE,
    /if \(value === null \|\| value === undefined \|\| typeof value !== 'object' \|\| Array\.isArray\(value\)\) return null/,
    'a malformed selected workspace is not ignored',
  )
  // The switcher asks the command, not the host: one line, through the same bridge Refresh uses.
  assert.ok(CLIENT_SOURCE.includes('`${line} --workspace ${selected}`'), 'the selection never reaches the command line')
  assert.ok(CLIENT_SOURCE.includes('`${line} --all`'), 'the aggregate option does not ask for every workspace')
  assert.match(CLIENT_SOURCE, /bridge\.call\(sessionId, reportLine\(days, workspace\)\)/, 'the report line does not carry the selection')
  assert.match(CLIENT_SOURCE, /onChange: \(event\) => onChange\(selectValue\(event\)\)/, 'the select does not read its own value')
  assert.ok(CLIENT_SOURCE.includes("useState('')"), 'the selection has no component state')
  assert.ok(CLIENT_SOURCE.includes('[bridge, sessionId, days, workspace]'), 'a selection does not reload the report')
  // It stays a read: the panel still owns exactly two command lines and no new button.
  assert.equal((CLIENT_SOURCE.match(/const (REPORT_LINE|SCAN_LINE) = /g) ?? []).length, 2, 'the panel grew a third command line')
})

/** A `/guidance-stats --json` body: the fields the panel requires, plus whatever a test adds. */
function reportOf(extra = {}) {
  return {
    periodDays: 7,
    corpus: { total: 208, version: '2026-11-01', snapshotDate: '2026-11-01' },
    totals: { calls: 4, hitRate: 0.5, byTool: { 'legacy-scan': 2 }, byOutcome: { hit: 1, miss: 1 } },
    topQueries: [],
    misses: [],
    coverage: [],
    series: [],
    deadGuides: { total: 208, sample: [] },
    topRules: [],
    topScanGuides: [],
    scanCountsScope: 'lifetime',
    lastScan: null,
    ...extra,
  }
}

/** The Remote envelope a successful command answers with. */
function reportEnvelope(report) {
  return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(report) } } }
}

/**
 * The panel as the host mounts it. The report arrives on a promise, so the component is rendered
 * twice: once while the command runs, then again with the answer in state. The bridge records every
 * line it is asked to run, which is how a switcher click is observed.
 */
async function mountPanel(report) {
  const panel = loadClient().get('main:guidance')
  assert.equal(typeof panel, 'function', 'the panel is not registered under the main slot')
  const bridge = {
    lines: [],
    call(sessionId, line) {
      bridge.lines.push(line)
      return Promise.resolve(reportEnvelope(report))
    },
  }
  const props = { t: translate, bridge, useSessions: () => 'session-1' }
  renderOnce(panel, props)
  // Let the command answer, then render what the panel settled on.
  await new Promise((resolve) => setImmediate(resolve))
  return { tree: renderOnce(panel, props), panel, props, bridge }
}

/** One element of a rendered tree by predicate. */
function elementIn(tree, predicate) {
  return elementsOf(tree).find(predicate)
}

/** The `<option>` elements a rendered `<select>` carries, in order. */
function optionsOf(select) {
  return elementsOf(select).filter((element) => element.type === 'option')
}

test('the header chip names the workspace the report answered for, and the switch lists every one', async () => {
  const { tree } = await mountPanel(
    reportOf({
      workspace: { id: 'aaaa1111', name: 'app' },
      workspaces: [
        { id: 'aaaa1111', name: 'app', findings: 12, rules: 3, lastScanAt: 1762000000000 },
        { id: 'bbbb2222', name: 'site', findings: 0, rules: 0, lastScanAt: null },
      ],
    }),
  )
  const chip = elementIn(tree, (element) => element.props.title === 'app')
  assert.deepEqual(chip?.children, ['Workspace: app'], 'the chip does not name the selected workspace')
  const select = elementIn(tree, (element) => element.type === 'select')
  assert.equal(select?.props.value, 'aaaa1111', 'the switcher does not start on the selected workspace')
  assert.equal(select?.props['aria-label'], 'Switch workspace', 'the switcher has no accessible name')
  assert.deepEqual(
    optionsOf(select).map((option) => option.children[0]),
    ['All workspaces', 'app', 'site'],
    'the switcher does not offer the aggregate plus every workspace',
  )
})

test('the switch asks the command for the chosen workspace and redraws on the answer', async () => {
  const { tree, panel, props, bridge } = await mountPanel(
    reportOf({
      workspace: { id: 'aaaa1111', name: 'app' },
      workspaces: [
        { id: 'aaaa1111', name: 'app', findings: 12, rules: 3, lastScanAt: 1762000000000 },
        { id: 'bbbb2222', name: 'site', findings: 0, rules: 0, lastScanAt: null },
      ],
    }),
  )
  const before = bridge.lines.length
  const select = elementIn(tree, (element) => element.type === 'select')
  select.props.onChange({ target: { value: 'bbbb2222' } })
  // The state change is what re-runs the report: the effect fires with the new selection.
  const next = renderOnce(panel, props)
  assert.deepEqual(
    bridge.lines.slice(before),
    ['/guidance-stats --json --days 7 --workspace bbbb2222'],
    'the switcher does not re-run the report line for the chosen workspace',
  )
  const redrawn = elementIn(next, (element) => element.type === 'select')
  assert.equal(redrawn.props.value, 'bbbb2222', 'the switcher does not show the new pick before the answer lands')
  // The chip keeps naming the numbers that are still on screen.
  assert.deepEqual(elementIn(next, (element) => element.props.title === 'app')?.children, ['Workspace: app'])
})

test('the aggregate option asks for every workspace and says so in the chip', async () => {
  const { tree, panel, props, bridge } = await mountPanel(
    reportOf({
      workspace: null,
      workspaces: [{ id: 'aaaa1111', name: 'app', findings: 12, rules: 3, lastScanAt: 1762000000000 }],
    }),
  )
  assert.deepEqual(elementIn(tree, (element) => element.props.title === 'All workspaces')?.children, [
    'Workspace: All workspaces',
  ])
  const select = elementIn(tree, (element) => element.type === 'select')
  assert.equal(select.props.value, 'all', 'an aggregate report does not select the aggregate option')
  const before = bridge.lines.length
  select.props.onChange({ target: { value: 'all' } })
  renderOnce(panel, props)
  assert.deepEqual(bridge.lines.slice(before), ['/guidance-stats --json --days 7 --all'], 'the aggregate option does not ask --all')
})

test('the unattributed bucket is named by the dictionary, never shown as an empty name', async () => {
  const { tree } = await mountPanel(
    reportOf({
      workspace: { id: '_unattributed', name: '' },
      workspaces: [{ id: '_unattributed', name: '', findings: 7, rules: 2, lastScanAt: null }],
    }),
  )
  assert.deepEqual(elementIn(tree, (element) => element.props.title === 'Unattributed')?.children, [
    'Workspace: Unattributed',
  ])
  const select = elementIn(tree, (element) => element.type === 'select')
  assert.deepEqual(optionsOf(select).map((option) => option.children[0]), ['All workspaces', 'Unattributed'])
})

test('two workspaces that share a name stay distinguishable', async () => {
  const { tree } = await mountPanel(
    reportOf({
      workspace: { id: 'aaaa1111', name: 'app' },
      workspaces: [
        { id: 'aaaa1111', name: 'app', findings: 1, rules: 1, lastScanAt: 1762000000000 },
        { id: 'bbbb2222', name: 'app', findings: 2, rules: 1, lastScanAt: null },
      ],
    }),
  )
  const labels = optionsOf(elementIn(tree, (element) => element.type === 'select')).map((option) => option.children[0])
  assert.deepEqual(labels, ['All workspaces', 'app · aaaa', 'app · bbbb'], 'a duplicated name is not told apart')
  assert.equal(new Set(labels).size, labels.length, 'two options share one label')
})

test('a report without workspaces keeps the panel exactly as it was', async () => {
  const legacy = elementsOf((await mountPanel(reportOf())).tree)
  assert.equal(legacy.some((element) => element.type === 'select'), false, 'a 0.9.0 host grew a switcher')
  assert.equal(
    legacy.some((element) =>
      element.children.some((child) => typeof child === 'string' && child.startsWith('Workspace: ')),
    ),
    false,
    'a 0.9.0 host grew a chip',
  )
  // Everything else still renders, and the button count matches an attributed panel: the workspace
  // switch adds a chip and a select, never a control of its own.
  assert.ok(legacy.some((element) => element.children.includes('Total calls')), 'the tiles are gone')
  const attributed = elementsOf(
    (
      await mountPanel(
        reportOf({
          workspace: null,
          workspaces: [{ id: 'aaaa1111', name: 'app', findings: 1, rules: 1, lastScanAt: 1762000000000 }],
        }),
      )
    ).tree,
  )
  assert.equal(
    attributed.filter((element) => element.type === 'button').length,
    legacy.filter((element) => element.type === 'button').length,
    'the workspace switch added a button',
  )
})

/** The branch label's two strings: the branch itself, and the detached checkout's shortened sha. */
const BRANCH_KEYS = ['scanner.branch', 'scanner.detached']

test('the branch label is translated into every language and rendered on the scan line', () => {
  for (const key of BRANCH_KEYS) {
    for (const name of DICTIONARIES) {
      const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
      assert.ok(dictionary.has(key), `${name} has no ${key}`)
    }
    assert.ok(CLIENT_SOURCE.includes(`t('${key}'`), `client.js never renders ${key}`)
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
    assert.match(RU.get(key), /[\u0400-\u04ff]/, `RU.${key} is not Russian`)
    assert.match(ZH.get(key), CJK, `ZH.${key} has no Chinese text`)
    assert.notEqual(RU.get(key), EN.get(key), `RU.${key} is copied from English`)
    assert.notEqual(ZH.get(key), EN.get(key), `ZH.${key} is copied from English`)
  }
  // The detached form names the short sha, and the branch form names the branch: one placeholder each.
  assert.deepEqual(placeholders(EN.get('scanner.branch')), ['branch'])
  assert.deepEqual(placeholders(EN.get('scanner.detached')), ['sha'])
})

/** The last-scan line the panel renders for one stored scan, read back out of its markup. */
async function lastScanLine(lastScan) {
  const { tree } = await mountPanel(reportOf({ lastScan }))
  const lines = elementsOf(tree)
    .filter((element) => element.children.length === 1 && typeof element.children[0] === 'string')
    .map((element) => element.children[0])
    .filter((text) => text.startsWith(EN.get('scanner.last').split('{when}')[0]))
  assert.equal(lines.length, 1, 'the panel does not render one last-scan line')
  return lines[0]
}

test('the last-scan line gains the branch fact and nothing else', async () => {
  const scan = { at: '2026-11-11', files: 70, findings: 85, rules: [] }
  const plain = await lastScanLine(scan)
  // Byte-identical to the line before the label existed: date, two counted facts, no suffix.
  assert.equal(plain, 'Last scan: 2026-11-11 · 70 files · 85 findings', 'the branchless last-scan line changed')
  // One more fact, in the same ` · ` list the line already joins.
  assert.equal(await lastScanLine({ ...scan, branch: { kind: 'branch', name: 'main' } }), `${plain} · branch main`)
  assert.equal(
    await lastScanLine({ ...scan, branch: { kind: 'detached', sha: 'a1b2c3d' } }),
    `${plain} · detached at a1b2c3d`,
  )
  // A label that was not read is silence, never an "unknown" and never an empty `branch `.
  for (const branch of [
    null,
    {},
    { kind: 'nope' },
    { kind: 'branch' },
    { kind: 'branch', name: '' },
    { kind: 'detached' },
    { kind: 'detached', sha: '' },
    'main',
    ['main'],
  ]) {
    assert.equal(
      await lastScanLine({ ...scan, branch }),
      plain,
      `a ${JSON.stringify(branch)} label rendered a suffix on the last-scan line`,
    )
  }
})

test('the branch belongs to the scan, so the workspace chip does not change', async () => {
  const { tree } = await mountPanel(
    reportOf({
      lastScan: { at: '2026-11-11', files: 70, findings: 85, rules: [], branch: { kind: 'branch', name: 'main' } },
      workspace: { id: 'aaaa1111', name: 'app' },
      workspaces: [{ id: 'aaaa1111', name: 'app', findings: 85, rules: 1, lastScanAt: 1762000000000 }],
    }),
  )
  assert.deepEqual(elementIn(tree, (element) => element.props.title === 'app')?.children, ['Workspace: app'])
})

/** The strings scan history added, in the order the contract names them. */
const HISTORY_KEYS = [
  'scanner.history',
  'scanner.historyMore',
  'scanner.diffAgainst',
  'scanner.diffCounts',
  'scanner.diffPartial',
  'scanner.diffFirst',
  'scanner.diffRetired',
  'scanner.lastSeen',
]

test('the scan-history strings exist in all three dictionaries, in the contract order', () => {
  const english = [...EN.keys()]
  const positions = HISTORY_KEYS.map((key) => {
    assert.notEqual(english.indexOf(key), -1, `EN has no ${key}`)
    return english.indexOf(key)
  })
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'the eight keys are out of order')
  for (const key of HISTORY_KEYS) {
    for (const name of DICTIONARIES) {
      const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
      assert.ok(dictionary.has(key), `${name} has no ${key}`)
    }
    assert.ok(CLIENT_SOURCE.includes(`t('${key}'`), `client.js never renders ${key}`)
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
    assert.match(RU.get(key), /[\u0400-\u04ff]/, `RU.${key} is not Russian`)
    assert.match(ZH.get(key), CJK, `ZH.${key} has no Chinese text`)
    assert.notEqual(RU.get(key), EN.get(key), `RU.${key} is copied from English`)
    assert.notEqual(ZH.get(key), EN.get(key), `ZH.${key} is copied from English`)
  }
  // The claim the contract fixes: absence, never a fix.
  assert.match(EN.get('scanner.diffCounts'), /no longer present/)
  assert.match(RU.get('scanner.diffCounts'), /больше не встречаются/)
  assert.match(ZH.get('scanner.diffCounts'), /不再出现/)
  for (const [name, dictionary] of [['EN', EN], ['RU', RU], ['ZH', ZH]]) {
    assert.doesNotMatch(dictionary.get('scanner.diffCounts'), /fixed|исправлено|已修复/i, `${name} claims a fix`)
  }
  assert.deepEqual(placeholders(EN.get('scanner.diffCounts')), ['new', 'resolved', 'stillOpen'])
  // The guard token is the scanner's word: it is interpolated raw, never looked up in a dictionary.
  assert.ok(EN.has('scanner.diffPartial'), 'the partial reason has no sentence to sit in')
  assert.ok(!EN.has('fewer-files'), 'a guard token was given a locale key')
})

/** Every rendered text node of one tree, in document order. */
function textsOf(tree) {
  return elementsOf(tree).flatMap((element) => element.children.filter((child) => typeof child === 'string'))
}

/** One stored scan-history entry, as the host writes it. */
function scanEntry(extra = {}) {
  return {
    at: '2026-11-10T22:27:39.749Z',
    outcome: 'findings',
    files: 70,
    findings: 85,
    rules: { 'ls-13': 4, 'ls-02': 2 },
    skipped: {},
    truncated: false,
    diff: null,
    ...extra,
  }
}

test('the comparison line renders counts, a first scan, and a raw guard token', async () => {
  const counts = textsOf(
    (
      await mountPanel(
        reportOf({
          scanDiff: {
            against: '2026-11-09T08:12:00.000Z',
            resolved: 3,
            stillOpen: 82,
            new: 1,
            retired: 0,
            partial: null,
            rows: [],
          },
        }),
      )
    ).tree,
  )
  assert.ok(
    counts.includes('Since the scan of 2026-11-09 08:12: 3 no longer present · 82 still open · 1 new'),
    'the comparison does not name the scan it compared against and its three numbers',
  )
  // Retired sites are a fourth number, and only when there are any: they are not "resolved".
  const retired = textsOf(
    (
      await mountPanel(
        reportOf({
          scanDiff: { against: '2026-11-09T08:12:00.000Z', resolved: 0, stillOpen: 82, new: 0, retired: 2, partial: null },
        }),
      )
    ).tree,
  )
  assert.ok(
    retired.includes('Since the scan of 2026-11-09 08:12: 0 no longer present · 82 still open · 0 new · 2 under retired rules'),
    'a retired count is not reported apart from the resolved one',
  )
  // A first scan says what happens next, and a skipped comparison prints its token raw.
  const first = textsOf((await mountPanel(reportOf({ scanDiff: { against: null, partial: 'no-baseline', resolved: null } }))).tree)
  assert.ok(first.includes(EN.get('scanner.diffFirst')), 'a first scan does not say the next one will be compared')
  assert.equal(first.some((text) => text.includes('no longer present')), false, 'a first scan printed numbers it cannot have')
  const partial = textsOf((await mountPanel(reportOf({ scanDiff: { against: '2026-11-09T08:12:00.000Z', partial: 'fewer-files', resolved: null } }))).tree)
  assert.ok(partial.includes('not comparable (fewer-files)'), 'a guard token is not shown raw')
  assert.ok(!partial.some((text) => text.includes('no longer present')), 'a skipped comparison printed numbers')
  // No comparison in the report: no line at all.
  const absent = textsOf((await mountPanel(reportOf())).tree)
  assert.equal(absent.some((text) => text.startsWith('Since the scan of ')), false, 'a pre-B report grew a comparison line')
  assert.equal(absent.includes(EN.get('scanner.diffFirst')), false, 'a pre-B report claims a first scan')
})

test('the recent-scans block lists five rows and counts the ones it hides', async () => {
  const history = ['2026-11-10T22:27:39.749Z', '2026-11-09T08:12:00.000Z', '2026-11-08T07:00:00.000Z', '2026-11-07T06:00:00.000Z', '2026-11-06T05:00:00.000Z', '2026-11-05T04:00:00.000Z', '2026-11-04T03:00:00.000Z'].map(
    (at) => scanEntry({ at }),
  )
  history[0] = scanEntry({ at: history[0].at, branch: { kind: 'branch', name: 'main' } })
  history[1] = scanEntry({ at: history[1].at, branch: { kind: 'detached', sha: 'a1b2c3d' }, rules: {} })
  history[2] = scanEntry({ at: history[2].at, findings: 0, rules: {} })
  const texts = textsOf((await mountPanel(reportOf({ scanHistory: history }))).tree)
  assert.ok(texts.includes(EN.get('scanner.history')), 'the block has no heading')
  const rows = texts.filter((text) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /.test(text))
  assert.equal(rows.length, 5, 'the block does not cap at five rows')
  assert.equal(rows[0], '2026-11-10 22:27 · 70 files · 85 findings · ls-13×4, ls-02×2 · branch main')
  assert.equal(rows[1], '2026-11-09 08:12 · 70 files · 85 findings · detached at a1b2c3d')
  assert.equal(rows[2], '2026-11-08 07:00 · 70 files · 0 findings')
  assert.ok(texts.includes('and 2 earlier'), 'the hidden rows are not counted')
  assert.equal(texts.some((text) => text.startsWith('2026-11-05 04:00')), false, 'a row past the cap is still drawn')
  // The block is silent without a ring, so a pre-B host renders no heading and no rows.
  const legacy = textsOf((await mountPanel(reportOf())).tree)
  assert.equal(legacy.includes(EN.get('scanner.history')), false, 'a pre-B report grew a history block')
})

test('a ranked rule row carries its last-seen day, and only when the host dated it', async () => {
  const dated = textsOf(
    (
      await mountPanel(
        reportOf({
          topRules: [
            {
              ruleId: 'ls-13',
              count: 4,
              message: 'Position the anchor instead of nudging',
              confidence: 'high',
              guideId: 'anchor-positioning',
              firstSeen: '2026-10-01',
              lastSeen: '2026-11-10',
            },
          ],
        }),
      )
    ).tree,
  )
  assert.ok(dated.includes('last 2026-11-10'), 'the rule row has no last-seen suffix')
  // The first sighting is secondary detail: it rides in the row title beside the message.
  const titled = elementIn(
    (await mountPanel(reportOf({ topRules: [{ ruleId: 'ls-13', count: 4, message: 'M', firstSeen: '2026-10-01', lastSeen: '2026-11-10' }] }))).tree,
    (element) => element.props.title === 'M · 2026-10-01',
  )
  assert.equal(typeof titled, 'object', 'the first-seen day is not in the row title')
  // A row the host never dated renders exactly the row it rendered before: no suffix, plain tooltip.
  const legacy = (await mountPanel(reportOf({ topRules: [{ ruleId: 'ls-13', count: 4, message: 'M' }] }))).tree
  const legacyTexts = textsOf(legacy)
  assert.equal(legacyTexts.some((text) => text.startsWith('last ')), false, 'an undated row grew a suffix')
  assert.equal(
    typeof elementIn(legacy, (element) => element.props.title === 'M'),
    'object',
    'an undated row lost its message tooltip',
  )
})

test('scanSeries is data for a later chart, so the panel draws none', async () => {
  assert.equal(CLIENT_SOURCE.includes('scanSeries'), false, 'the panel reads a series this phase does not draw')
  const series = [
    { day: '2026-11-09', scans: 2, files: 140, findings: 168 },
    { day: '2026-11-10', scans: 1, files: 70, findings: 85 },
  ]
  const withSeries = textsOf((await mountPanel(reportOf({ scanSeries: series, lastScan: { at: '2026-11-10', files: 70, findings: 85, rules: [] } }))).tree)
  const without = textsOf((await mountPanel(reportOf({ lastScan: { at: '2026-11-10', files: 70, findings: 85, rules: [] } }))).tree)
  assert.deepEqual(withSeries, without, 'a scanSeries changed the panel')
})
