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
  for (const base of ['call', 'hit', 'miss', 'file', 'finding', 'pattern', 'entry']) {
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
  'scanner.ignoreUsage',
  'scanner.review',
  'scanner.reviewUnknown',
  'scanner.reviewList',
  'scanner.reviewTooLong',
  'scanner.rules',
  'scanner.lifetime',
  'scanner.lifetimeSince',
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
  // The counts the scan sections print go through the plural helper, which needs each base's forms.
  for (const base of ['file', 'finding', 'pattern', 'entry']) {
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
  assert.match(CLIENT_SOURCE, /renderEmpty\(t, report\)[\s\S]{0,160}renderScanner\(t, report, scan, busy, scannerActions\)/)
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

test('the lifetime caption names the day the books opened, and drops the suffix when it has none', async () => {
  const rules = [{ ruleId: 'ls-13', count: 2 }]

  const dated = await mountPanel(reportOf({ topRules: rules, scanCountsSince: '2026-11-01' }))
  const datedCaption = elementIn(dated.tree, (element) => element.props?.key === 'scan-rules-scope')
  assert.ok(datedCaption !== undefined, 'the lifetime caption is not rendered')
  // The date is the host's string, printed as given and never reformatted by the panel.
  assert.equal(
    datedCaption.children.join(''),
    `${translate('scanner.lifetime', { days: 7 })} · ${translate('scanner.lifetimeSince', { date: '2026-11-01' })}`,
  )

  // Without an origin the caption is the 0.11.0 sentence, character for character: an unrecorded
  // start must not grow a dash, an empty pair or an "unknown".
  const undated = await mountPanel(reportOf({ topRules: rules }))
  const undatedCaption = elementIn(undated.tree, (element) => element.props?.key === 'scan-rules-scope')
  assert.ok(undatedCaption !== undefined, 'the lifetime caption is not rendered')
  assert.equal(undatedCaption.children.join(''), translate('scanner.lifetime', { days: 7 }))
  assert.ok(!undatedCaption.children.join('').includes('·'), 'an absent date still rendered a separator')
})

test('the lifetime date is translated in all three languages and is only appended when recorded', () => {
  for (const name of DICTIONARIES) {
    const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
    assert.deepEqual(placeholders(dictionary.get('scanner.lifetimeSince')), ['date'], `${name} does not take {date}`)
    assert.ok(dictionary.get('scanner.lifetimeSince').trim() !== '', `${name}.scanner.lifetimeSince is empty`)
  }
  assert.match(RU.get('scanner.lifetimeSince'), /[\u0400-\u04ff]/, 'RU.scanner.lifetimeSince is not Russian')
  assert.match(ZH.get('scanner.lifetimeSince'), CJK, 'ZH.scanner.lifetimeSince has no Chinese text')
  assert.notEqual(RU.get('scanner.lifetimeSince'), EN.get('scanner.lifetimeSince'), 'RU.scanner.lifetimeSince is copied from English')
  assert.notEqual(ZH.get('scanner.lifetimeSince'), EN.get('scanner.lifetimeSince'), 'ZH.scanner.lifetimeSince is copied from English')

  // The suffix is guarded by the host's field: an empty date renders no suffix at all.
  assert.match(CLIENT_SOURCE, /report\.scanCountsSince === ''/, 'the caption does not check for an absent date')
  assert.ok(
    CLIENT_SOURCE.includes("t('scanner.lifetimeSince', { date: report.scanCountsSince })"),
    'the caption does not render the recorded date',
  )
  assert.ok(
    CLIENT_SOURCE.includes('scanCountsSince: asText(payload.scanCountsSince)'),
    'the report body never reads the date',
  )
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
function loadClient(options = {}) {
  let spec
  resetHooks()
  // The browser global, named `window` because that is what client.js reads.
  const browserWindow = { __ModuleLoader__: { load(candidate) { spec = candidate } } }
  // A page's clipboard is a browser global, so a test that needs one hands it in: the client reads
  // `window.navigator.clipboard` exactly as the shell would expose it.
  if (options.navigator !== undefined) browserWindow.navigator = options.navigator
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
async function mountPanel(report, options = {}) {
  const panel = loadClient(options).get('main:guidance')
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

/** The one button whose visible text is `label`, or undefined when the panel draws none. */
function buttonOf(tree, label) {
  return elementIn(tree, (element) => element.type === 'button' && element.children.includes(label))
}

/** A Remote envelope whose result is a success carrying `text`. */
function textEnvelope(text) {
  return { ok: true, value: { result: { kind: 'success', text } } }
}

/** A Remote envelope whose result is a refusal — the shape a refused write arrives in. */
function refusalEnvelope(text) {
  return { ok: true, value: { result: { kind: 'error', text } } }
}

/**
 * The panel with a bridge that answers each command line with its own envelope.
 *
 * A flow needs that: the report, the scan and the two halves of a write cannot all be answered by
 * the same fixture. `answers` is keyed by command line, `'*'` answers anything the test did not name,
 * and a line with no answer fails the test instead of resolving into a state no assertion can explain.
 */
async function mountScriptedPanel(report, answers, options = {}) {
  const panel = loadClient(options).get('main:guidance')
  assert.equal(typeof panel, 'function', 'the panel is not registered under the main slot')
  const bridge = {
    lines: [],
    call(sessionId, line) {
      bridge.lines.push(line)
      const answer = answers[line] === undefined ? answers['*'] : answers[line]
      assert.notEqual(answer, undefined, `the test answered no line: ${line}`)
      return Promise.resolve(answer)
    },
  }
  const props = { t: translate, bridge, useSessions: () => 'session-1' }
  renderOnce(panel, props)
  await new Promise((resolve) => setImmediate(resolve))
  return { tree: renderOnce(panel, props), panel, props, bridge }
}

/** Let the last command answer, then render what the panel settled on. */
async function settle(panel, props) {
  await new Promise((resolve) => setImmediate(resolve))
  return renderOnce(panel, props)
}

/** One `/guidance-scan --format json` value, as phase C writes it. */
function scanValueOf(extra = {}) {
  return {
    scanned: { files: 2, bytes: 240, skippedByReason: {} },
    findings: [],
    guides: [],
    truncated: false,
    suppressed: 0,
    ...extra,
  }
}

/** One finding of that value, with the site id a mute needs. */
function findingOf(extra = {}) {
  return {
    ruleId: 'ls-13',
    confidence: 'high',
    path: 'src/app.css',
    line: 12,
    column: 3,
    guideId: 'anchor-positioning',
    message: 'Position the anchor instead of nudging the element',
    snippet: 'left: 1px',
    lines: [12],
    occurrences: 1,
    siteId: '96cb61de',
    ...extra,
  }
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

/** The strings the suppression half added, in the order the contract names them. */
const SUPPRESS_KEYS = [
  'scan.suppressed',
  'scan.suppressedTag',
  'scan.suppressProblem',
  'scan.mute',
  'scan.muteConfirm',
  'scan.muteFailed',
]

test('the suppression strings exist in all three dictionaries, in the contract order', () => {
  const english = [...EN.keys()]
  const positions = SUPPRESS_KEYS.map((key) => {
    assert.notEqual(english.indexOf(key), -1, `EN has no ${key}`)
    return english.indexOf(key)
  })
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'the keys are out of order')
  // One group, in the same place in every dictionary: the scan strings, before the chat row's.
  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(positions[index], positions[index - 1] + 1, 'the suppression keys are not one contiguous group')
  }
  for (const key of SUPPRESS_KEYS) {
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
  // The count and the rules it belongs to; one word for the tag; one raw token in the problem note.
  assert.deepEqual(placeholders(EN.get('scan.suppressed')), ['count', 'rules'])
  assert.deepEqual(placeholders(EN.get('scan.suppressedTag')), [])
  assert.deepEqual(placeholders(EN.get('scan.suppressProblem')), ['reason'])
  // The problem sentence is the one the text renderer prints, so the two surfaces say the same thing.
  assert.equal(
    EN.get('scan.suppressProblem'),
    'Suppression file: {reason}; nothing is muted this scan.',
    'the problem note no longer matches the text renderer',
  )
  // A muted finding is not a fixed one: neither reporting string may claim a repair.
  for (const [name, dictionary] of [['EN', EN], ['RU', RU], ['ZH', ZH]]) {
    for (const key of ['scan.suppressed', 'scan.suppressedTag']) {
      assert.doesNotMatch(dictionary.get(key), /fixed|исправлено|已修复/i, `${name}.${key} claims a fix`)
    }
  }
  // The second click names the file it appends to, and a file name is never translated.
  for (const dictionary of [EN, RU, ZH]) {
    assert.match(dictionary.get('scan.muteConfirm'), /\.suppress/, 'the confirmation does not name the file it writes')
  }
  assert.deepEqual(placeholders(EN.get('scan.muteFailed')), ['message'])
})

test('the muted count is reported beside the scan it belongs to, and a missing count renders nothing', async () => {
  const scan = { at: '2026-11-11', files: 70, findings: 85, rules: [] }
  const muted = textsOf(
    (await mountPanel(reportOf({ lastScan: { ...scan, suppressed: 3, suppressedRules: { 'ls-08': 1, 'ls-13': 2 } } }))).tree,
  )
  assert.ok(muted.includes('Suppressed 3 (ls-13 2, ls-08 1)'), 'the panel does not report the muted count with its rules')
  // A muted finding is still a finding: the scan's own count is not reduced.
  assert.ok(muted.includes('Last scan: 2026-11-11 · 70 files · 85 findings'), 'the muted count was subtracted from the scan')
  const plain = textsOf((await mountPanel(reportOf({ lastScan: scan }))).tree)
  const zero = textsOf((await mountPanel(reportOf({ lastScan: { ...scan, suppressed: 0, suppressedRules: {} } }))).tree)
  // Absence and an explicit zero render the same panel — never a fabricated "0 suppressed". The
  // timestamp is the one text that changes between two mounts, so it is compared out.
  const clock = EN.get('updated').split('{time}')[0]
  const stable = (texts) => texts.filter((text) => !text.startsWith(clock))
  assert.deepEqual(stable(zero), stable(plain), 'an explicit zero changed the panel')
  assert.equal(plain.some((text) => text.startsWith('Suppressed')), false, 'a pre-C report grew a suppressed line')
})

test('the ignore audit is one sentence from two counts, and is absent when the host kept none', async () => {
  const scan = { at: '2026-11-11', files: 70, findings: 85, rules: [] }
  const lineOf = async (lastScan) => {
    const { tree } = await mountPanel(reportOf({ lastScan }))
    return elementIn(tree, (element) => element.props?.key === 'scan-ignore-usage')
  }

  // Two counts in, one sentence out — and the noun is pluralized by the panel's own helper, so the
  // file name stays untranslated while `pattern` does not.
  const used = await lineOf({ ...scan, ignoreUsage: { patterns: 3, idle: 1 } })
  assert.ok(used !== undefined, 'the ignore audit is not rendered')
  assert.equal(
    used.children.join(''),
    translate('scanner.ignoreUsage', { patterns: translate('pattern.many', { count: 3 }), unused: 1 }),
  )
  // A single pattern is `1 pattern`, not `1 patterns`: the panel reuses the plural machinery instead
  // of hand-building the number.
  const single = await lineOf({ ...scan, ignoreUsage: { patterns: 1, idle: 0 } })
  assert.ok(single !== undefined, 'a one-pattern file renders no audit line')
  assert.equal(
    single.children.join(''),
    translate('scanner.ignoreUsage', { patterns: translate('pattern.one', { count: 1 }), unused: 0 }),
  )
  assert.match(single.children.join(''), /^\.scanignore: 1 pattern, 0 matched nothing/, 'the pinned sentence changed')

  // Absence is not a zero: a state file written before 0.12.0, or one whose file could not be read,
  // draws no line at all. This is the case the whole item exists for.
  const plain = textsOf((await mountPanel(reportOf({ lastScan: scan }))).tree)
  assert.equal(plain.some((text) => text.includes('.scanignore')), false, 'a pre-0.12.0 report grew an ignore line')
  // Nor does a pair that contradicts itself get printed as zeros: the reader drops the block and the
  // panel renders exactly what it rendered before the field existed. `{ patterns: 3 }` is the invented
  // zero this field exists to prevent — a missing `idle` must not read as "none of them is idle".
  for (const inconsistent of [{ patterns: 1, idle: 4 }, { patterns: 0, idle: 0 }, { patterns: 3 }, { patterns: '3', idle: 0 }]) {
    const texts = textsOf((await mountPanel(reportOf({ lastScan: { ...scan, ignoreUsage: inconsistent } }))).tree)
    assert.equal(
      texts.some((text) => text.includes('.scanignore')),
      false,
      `an inconsistent block ${JSON.stringify(inconsistent)} was printed as a claim`,
    )
  }
})

test('the ignore audit exists in all three languages and names the same two numbers', () => {
  for (const name of DICTIONARIES) {
    const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
    assert.deepEqual(placeholders(dictionary.get('scanner.ignoreUsage')), ['patterns', 'unused'], `${name} does not take both counts`)
    assert.ok(dictionary.get('scanner.ignoreUsage').includes('.scanignore'), `${name} stopped naming the file`)
  }
  assert.match(RU.get('scanner.ignoreUsage'), /[\u0400-\u04ff]/, 'RU.scanner.ignoreUsage is not Russian')
  assert.match(ZH.get('scanner.ignoreUsage'), CJK, 'ZH.scanner.ignoreUsage has no Chinese text')
  assert.notEqual(RU.get('scanner.ignoreUsage'), EN.get('scanner.ignoreUsage'), 'RU.scanner.ignoreUsage is copied from English')
  assert.notEqual(ZH.get('scanner.ignoreUsage'), EN.get('scanner.ignoreUsage'), 'ZH.scanner.ignoreUsage is copied from English')
  // The panel reads the two counts and never a pattern: the host keeps the file's text on the machine
  // that owns it, so the client's reader has no place to put one.
  assert.match(CLIENT_SOURCE, /ignoreUsage: readIgnoreUsage\(value\.ignoreUsage\)/, 'the report reader drops the counts')
  assert.match(CLIENT_SOURCE, /if \(last !== null && last\.ignoreUsage !== null\)/, 'the audit line is unconditional')
})

test('the panel scan counts its muted findings and tags them, and offers the action only to a site it can name', async () => {
  const value = scanValueOf({
    findings: [
      findingOf(),
      findingOf({ ruleId: 'ls-02', path: 'src/app.js', line: 3, siteId: 'aa11bb22', suppressed: true }),
      // A pre-C finding: the host sends no site id, so nothing may offer to mute it.
      findingOf({ ruleId: 'ls-08', path: 'src/legacy.js', line: 8, siteId: undefined }),
    ],
    suppressed: 1,
  })
  const { tree, panel, props } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(value)),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  const texts = textsOf(scanned)
  assert.ok(texts.includes('Scanned 2 files, 3 findings · Suppressed 1 (ls-02 1)'), 'the summary does not report the muted count')
  assert.ok(texts.includes('src/app.css:12'), 'the scan result lists no place for its findings')
  // The tag is a word on the muted row, and only there.
  const tags = elementsOf(scanned).filter(
    (element) => element.children.length === 1 && element.children[0] === EN.get('scan.suppressedTag'),
  )
  assert.equal(tags.length, 1, 'the muted row is not tagged exactly once')
  // Of the three rows only the first can be muted: the second already is, the third has no site id
  // to name, and an action with no target must not be drawn at all.
  const offers = elementsOf(scanned).filter(
    (element) => element.type === 'button' && element.children.includes(EN.get('scan.mute')),
  )
  assert.equal(offers.length, 1, 'a row without a site id, or an already muted one, offers the action')
})

test('muting asks for a plan, writes only on the second click, and reports the outcome', async () => {
  const value = scanValueOf({ findings: [findingOf()] })
  const plan = 'Plan: append 96cb61de (ls-13) to /work/app/.suppress — file exists, 3 entries, cap 200'
  const outcome = 'Appended 96cb61de to /work/app/.suppress — 4 entries'
  const { tree, panel, props, bridge } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(value)),
    '/guidance-suppress 96cb61de --dry-run': textEnvelope(plan),
    '/guidance-suppress 96cb61de': textEnvelope(outcome),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.mute')).props.onClick()
  const planned = await settle(panel, props)
  // One click, one command: the plan, which writes nothing.
  assert.deepEqual(
    bridge.lines.filter((line) => line.startsWith('/guidance-suppress')),
    ['/guidance-suppress 96cb61de --dry-run'],
    'the first click did not stop at the plan',
  )
  const plannedTexts = textsOf(planned)
  assert.ok(plannedTexts.includes(plan), 'the host plan is not shown verbatim')
  assert.ok(plannedTexts.includes('96cb61de · ls-13 · src/app.css:12'), 'the plan does not name the site, the rule and the place')
  // It sits under the row it came from, so a long list cannot separate a confirmation from its target.
  const order = elementsOf(planned)
  const placeAt = order.findIndex((element) => element.children.includes('src/app.css:12'))
  const factsAt = order.findIndex((element) => element.children.includes('96cb61de · ls-13 · src/app.css:12'))
  assert.ok(placeAt !== -1 && factsAt > placeAt, 'the plan is not rendered under the row it came from')
  const confirm = buttonOf(planned, EN.get('scan.muteConfirm'))
  assert.equal(typeof confirm, 'object', 'the plan has no second, distinct button')
  confirm.props.onClick()
  const done = await settle(panel, props)
  // The second click applies the same plan: same command, no `--dry-run`.
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-suppress')), [
    '/guidance-suppress 96cb61de --dry-run',
    '/guidance-suppress 96cb61de',
  ])
  const doneTexts = textsOf(done)
  assert.ok(doneTexts.includes(outcome), 'the outcome the host reported is not shown')
  assert.equal(doneTexts.some((text) => text.startsWith(EN.get('scan.muteFailed').split('{')[0])), false, 'a success renders the refusal sentence')
  assert.equal(typeof buttonOf(done, EN.get('scan.muteConfirm')), 'undefined', 'the plan outlived its confirmation')
})

test('the mute plan opens with the panel\'s own sentence, the way the ignore plan does', async () => {
  // The live pass found the pair asymmetric: the ignore box started with a panel sentence and the mute
  // box was all host English, so two deliberate flows read as one flow and one accident.
  const plan =
    'Suppression plan for 96cb61de: append {"reason":"","at":"2026-11-11"} to /work/app/.suppress, which would go from 0 to 1 entry (cap 200). Nothing has been written; run the same line without --dry-run to write it.'
  const { tree, panel, props } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(scanValueOf({ findings: [findingOf()] }))),
    '/guidance-suppress 96cb61de --dry-run': textEnvelope(plan),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.mute')).props.onClick()
  const planned = await settle(panel, props)
  const texts = textsOf(planned)
  assert.ok(texts.includes(EN.get('scan.muteNote')), 'the mute plan has no panel-owned sentence')
  // The note is the panel's, not a translation of the host's: the plan itself stays verbatim, and the
  // note is the only prose above it.
  assert.ok(texts.includes(plan), 'the host plan is no longer shown verbatim')
  const order = elementsOf(planned)
  const noteAt = order.findIndex((element) => element.children.includes(EN.get('scan.muteNote')))
  const planAt = order.findIndex((element) => element.children.includes(plan))
  assert.ok(noteAt !== -1 && planAt > noteAt, 'the note does not open the box')
  // The ignore's sentence belongs to the ignore: a mute is not an ignore and may not borrow its words.
  assert.equal(texts.includes(EN.get('scan.ignoreNote')), false, 'the mute plan shows the ignore note')
})

/**
 * The panel's own sentence for a mute, beside the ignore's.
 *
 * It is not in `SUPPRESS_KEYS`: that list is one contiguous group ending at `scan.muteFailed`, and the
 * ignore group must follow it immediately, so the two notes sit together after both groups instead.
 */
test('the mute note exists in all three dictionaries, and claims no fix', () => {
  assert.ok(CLIENT_SOURCE.includes("t('scan.muteNote')"), 'client.js never renders scan.muteNote')
  assert.equal(placeholders(EN.get('scan.muteNote')).length, 0, 'the mute note takes no placeholder')
  for (const [name, dictionary] of [['EN', EN], ['RU', RU], ['ZH', ZH]]) {
    const text = dictionary.get('scan.muteNote')
    assert.notEqual(text, undefined, `${name} has no scan.muteNote`)
    assert.notEqual(text, dictionary.get('scan.ignoreNote'), `${name}.scan.muteNote is the ignore note`)
    assert.doesNotMatch(text, /fixed|исправлено|已修复/i, `${name}.scan.muteNote claims a fix`)
  }
  for (const [name, dictionary] of [['RU', RU], ['ZH', ZH]]) {
    assert.notEqual(dictionary.get('scan.muteNote'), EN.get('scan.muteNote'), `${name}.scan.muteNote is copied from English`)
  }
  assert.match(RU.get('scan.muteNote'), /[\u0400-\u04ff]/, 'RU.scan.muteNote is not Russian')
  assert.match(ZH.get('scan.muteNote'), CJK, 'ZH.scan.muteNote has no Chinese text')
  // A muted finding is counted, not removed: the sentence has to say what the scan still does with it.
  assert.match(EN.get('scan.muteNote'), /still counts/i, 'the mute note does not say the finding is still counted')
  assert.match(EN.get('scan.muteNote'), /suppressed/i, 'the mute note does not say how the finding is reported')
})

test('an "already present" answer is the no-op the host names, and it is shown as one', async () => {
  const noop = '96cb61de is already in /work/app/.suppress — nothing written'
  const { tree, panel, props } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(scanValueOf({ findings: [findingOf()] }))),
    '/guidance-suppress 96cb61de --dry-run': textEnvelope('Plan: append 96cb61de (ls-13) to /work/app/.suppress'),
    '/guidance-suppress 96cb61de': textEnvelope(noop),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.mute')).props.onClick()
  const planned = await settle(panel, props)
  buttonOf(planned, EN.get('scan.muteConfirm')).props.onClick()
  const done = await settle(panel, props)
  const texts = textsOf(done)
  // The panel keeps the host's words: it neither calls the no-op a success of its own nor a failure.
  assert.ok(texts.includes(noop), 'the no-op the host named is not shown')
  assert.equal(
    texts.some((text) => text.startsWith(EN.get('scan.muteFailed').split('{')[0])),
    false,
    'a no-op is reported as a refusal',
  )
})

test('a refused write is an error with its code, never an outcome', async () => {
  const value = scanValueOf({ findings: [findingOf()] })
  const refusal = 'Error: cap-reached — .suppress already holds the 200 entries the cap allows'
  const { tree, panel, props, bridge } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(value)),
    '/guidance-suppress 96cb61de --dry-run': textEnvelope('Plan: append 96cb61de (ls-13) to /work/app/.suppress'),
    '/guidance-suppress 96cb61de': refusalEnvelope(refusal),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.mute')).props.onClick()
  const planned = await settle(panel, props)
  buttonOf(planned, EN.get('scan.muteConfirm')).props.onClick()
  const refused = await settle(panel, props)
  const sentence = translate('scan.muteFailed', { message: refusal })
  const texts = textsOf(refused)
  assert.ok(texts.includes(sentence), 'the refusal is not reported with its code')
  assert.equal(texts.includes(refusal), false, 'the refusal is rendered as an outcome')
  // It is drawn as an error, so it cannot be mistaken for the outcome branch.
  const styled = elementIn(refused, (element) => element.children.includes(sentence))
  assert.equal(styled.props.style.color, 'var(--dsw-alias-state-error-primary)', 'a refusal is not styled as an error')
  assert.equal(typeof buttonOf(refused, EN.get('scan.muteConfirm')), 'undefined', 'a refusal leaves a live confirmation')
  // Nothing was written by the refusal, and no third line was ever asked for.
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-suppress')), [
    '/guidance-suppress 96cb61de --dry-run',
    '/guidance-suppress 96cb61de',
  ])
})

test('a refused plan writes nothing and leaves no confirmation to press', async () => {
  const { tree, panel, props, bridge } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(scanValueOf({ findings: [findingOf()] }))),
    '/guidance-suppress 96cb61de --dry-run': refusalEnvelope('Error: site-unknown — no site 96cb61de in this workspace'),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.mute')).props.onClick()
  const refused = await settle(panel, props)
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-suppress')), ['/guidance-suppress 96cb61de --dry-run'])
  assert.ok(
    textsOf(refused).includes(translate('scan.muteFailed', { message: 'Error: site-unknown — no site 96cb61de in this workspace' })),
    'a refused plan is not reported with its code',
  )
  assert.equal(typeof buttonOf(refused, EN.get('scan.muteConfirm')), 'undefined', 'a refused plan leaves a live confirmation')
})

test('without a scan there is no finding list and no mute to press', async () => {
  const { tree } = await mountScriptedPanel(reportOf(), { '*': reportEnvelope(reportOf()) })
  const texts = textsOf(tree)
  // Unavailable, not a button that fails: with no scan there is no site to name.
  assert.equal(texts.includes(EN.get('scan.mute')), false, 'the panel offers a mute before any scan ran')
  assert.equal(texts.includes(EN.get('scan.muteConfirm')), false, 'a confirmation is on screen without a plan')
  assert.equal(texts.some((text) => text.startsWith('Scanned ')), false, 'a scan result appeared with no scan')
})

test('a muted finding is tagged in the chat row, and the two readers agree on it', () => {
  const row = loadClient().get('tool.call.toolview:web_guidance_legacy_scan')
  assert.equal(typeof row, 'function', 'the chat row is not registered under the scan wire name')
  const fromValue = (payload) =>
    row({ phase: 'result', t: translate, block: { kind: 'result', isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] } })
  const fromText = (text) =>
    row({ phase: 'result', t: translate, block: { kind: 'result', isError: false, content: [{ type: 'text', text }] } })
  const value = (muted) => ({
    scanned: { files: 1, bytes: 10, skippedByReason: {} },
    guides: [],
    truncated: false,
    suppressed: muted ? 1 : 0,
    findings: [
      {
        ruleId: 'ls-13',
        confidence: 'high',
        path: 'src/app.css',
        line: 12,
        column: 3,
        guideId: 'anchor-positioning',
        message: 'Position the anchor instead of nudging',
        snippet: '',
        lines: [12],
        occurrences: 1,
        siteId: '96cb61de',
        ...(muted ? { suppressed: true } : {}),
      },
    ],
  })
  const mutedRow = fromValue(value(true))
  const plainRow = fromValue(value(false))
  const dimmed = (tree) => elementIn(tree, (element) => element.props?.style?.opacity === '0.65')
  // The tag is a word inside the rule cell, so the four columns and the grid do not move.
  assert.ok(textsOf(mutedRow).includes(`ls-13 ${EN.get('scan.suppressedTag')}`), 'the muted row is not tagged')
  assert.notEqual(dimmed(mutedRow), undefined, 'the muted row is not dimmed')
  assert.equal(dimmed(plainRow), undefined, 'an unmuted row is dimmed')
  assert.ok(textsOf(mutedRow).includes('src/app.css:12'), 'the muted row lost its place')
  // A muted finding is still counted: the header keeps the findings total.
  assert.ok(textsOf(mutedRow).includes('Scanned 1 file, 1 finding'), 'the header count changed with a muted finding')
  // The pre-C row is exactly the row it always was: no tag anywhere, no dimming.
  assert.equal(textsOf(plainRow).some((text) => text.includes(EN.get('scan.suppressedTag'))), false, 'a pre-C row grew a tag')
  // The text reader agrees with the value reader, marker and all: the same call renders the same row.
  const textRow = fromText(
    'Scanned 1 file(s) — 1 finding(s), 1 suppressed.\n- src/app.css:12:3 ls-13 (high) Position the anchor instead of nudging (suppressed)',
  )
  assert.ok(textsOf(textRow).includes(`ls-13 ${EN.get('scan.suppressedTag')}`), 'the text reader does not tag a muted row')
  assert.notEqual(dimmed(textRow), undefined, 'the text reader does not dim a muted row')
  // The marker is stripped, so the tooltip is the rule's message and not the bookkeeping.
  assert.equal(
    elementIn(textRow, (element) => element.props.title === 'Position the anchor instead of nudging (suppressed)'),
    undefined,
    'the suppression marker leaked into the tooltip',
  )
  assert.notEqual(
    elementIn(textRow, (element) => element.props.title === 'Position the anchor instead of nudging'),
    undefined,
    'the text row lost the rule message tooltip',
  )
  // A suppression file that could not be read mutes nothing, and the row says so in one line — the
  // same sentence the text renderer prints, with the host's raw token.
  const problemNote = translate('scan.suppressProblem', { reason: 'malformed' })
  const withProblem = fromValue({ ...value(false), suppressProblems: [{ key: null, reason: 'malformed' }] })
  assert.ok(textsOf(withProblem).includes(problemNote), 'a file-level suppression problem is silent')
  assert.equal(textsOf(plainRow).some((text) => text.includes('Suppression file')), false, 'a clean result grew a problem note')
  // A per-entry problem is not a note: that finding is on screen, which is its report.
  const entryProblem = fromValue({ ...value(false), suppressProblems: [{ key: 'aa11bb22', reason: 'invalid' }] })
  assert.equal(
    textsOf(entryProblem).some((text) => text.includes('Suppression file')),
    false,
    'a dropped entry was reported as a file-level failure',
  )
  // The text reader reads the same sentence back, so a summary answer carries the note too.
  assert.ok(
    textsOf(fromText(`Suppression file: malformed; nothing is muted this scan.\n- src/app.css:12:3 ls-13 (high) Nudge`)).includes(
      problemNote,
    ),
    'the text reader drops the problem sentence',
  )
})

/** The strings the `.scanignore` write added: the action, its confirmation, its note and its refusal. */
const IGNORE_KEYS = ['scan.ignore', 'scan.ignoreConfirm', 'scan.ignoreFailed', 'scan.ignoreNote']

test('the ignore strings exist in all three dictionaries, in the contract order', () => {
  const english = [...EN.keys()]
  const positions = IGNORE_KEYS.map((key) => {
    assert.notEqual(english.indexOf(key), -1, `EN has no ${key}`)
    return english.indexOf(key)
  })
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'the keys are out of order')
  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(positions[index], positions[index - 1] + 1, 'the ignore keys are not one contiguous group')
  }
  // The ignore group follows the suppression group: the two writes are one story, and a reader of the
  // dictionaries should meet them together, the product's only two writes.
  assert.equal(positions[0], english.indexOf('scan.muteFailed') + 1, 'the ignore keys do not follow the suppression keys')
  for (const key of IGNORE_KEYS) {
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
  assert.deepEqual(placeholders(EN.get('scan.ignoreFailed')), ['message'])
  // The second click names the file it appends to, and a file name is never translated.
  for (const dictionary of [EN, RU, ZH]) {
    assert.match(dictionary.get('scan.ignoreConfirm'), /\.scanignore/, 'the confirmation does not name the file it writes')
  }
  // An ignore is not a suppression, and neither surface may call it one: the two writes are different
  // decisions, so the ignore's words never borrow the mute's.
  for (const [name, dictionary] of [['EN', EN], ['RU', RU], ['ZH', ZH]]) {
    for (const key of IGNORE_KEYS) {
      assert.doesNotMatch(dictionary.get(key), /muted|заглуш|已静音/i, `${name}.${key} calls an ignore a mute`)
    }
  }
  // The panel's own words for what the exclusion does: it makes the next scan read less, which is the
  // one thing a `.scanignore` pattern can promise.
  assert.match(EN.get('scan.ignoreNote'), /the next scan read less/, 'the ignore note does not say the next scan reads less')
  // Two different words for two different writes: the action a person reads must not be the one that
  // appends a suppression entry.
  assert.notEqual(EN.get('scan.ignore'), EN.get('scan.mute'))
})

/** The strings the copy action added: the button in its four states. */
const COPY_KEYS = ['copy.json', 'copy.done', 'copy.failed', 'copy.timeout']

test('the copy strings exist in all three dictionaries and are rendered', () => {
  for (const key of COPY_KEYS) {
    for (const name of DICTIONARIES) {
      const dictionary = name === 'EN' ? EN : name === 'RU' ? RU : ZH
      assert.ok(dictionary.has(key), `${name} has no ${key}`)
    }
    assert.ok(CLIENT_SOURCE.includes(`t('${key}'`) || CLIENT_SOURCE.includes(`t('${key}')`), `client.js never renders ${key}`)
    assert.deepEqual(placeholders(RU.get(key)), placeholders(EN.get(key)), `placeholders differ for RU.${key}`)
    assert.deepEqual(placeholders(ZH.get(key)), placeholders(EN.get(key)), `placeholders differ for ZH.${key}`)
    assert.match(RU.get(key), /[\u0400-\u04ff]/, `RU.${key} is not Russian`)
    assert.match(ZH.get(key), CJK, `ZH.${key} has no Chinese text`)
    assert.notEqual(RU.get(key), EN.get(key), `RU.${key} is copied from English`)
    assert.notEqual(ZH.get(key), EN.get(key), `ZH.${key} is copied from English`)
  }
  // The action names the format it copies, because the panel shows numbers and the file holds JSON.
  assert.match(EN.get('copy.json'), /JSON/)
})

test('an ignore asks for a plan, writes only on the second click, and says the scan reads less', async () => {
  const plan =
    'Ignore plan for src/app.css: append src/app.css to /work/app/.scanignore, which would go from 2 patterns to 3 patterns. The pattern has a slash, so it is anchored at the workspace root and the next scan skips exactly that path. Nothing has been written; run the same line without --dry-run to write it.'
  const outcome =
    'Appended to /work/app/.scanignore: src/app.css. The file now holds 3 patterns. The next scan reads less because of it: an ignore excludes a path from the walk, it does not fix or mute a finding, and no counter moves.'
  const { tree, panel, props, bridge } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(scanValueOf({ findings: [findingOf()] }))),
    '/guidance-scanignore src/app.css --dry-run': textEnvelope(plan),
    '/guidance-scanignore src/app.css': textEnvelope(outcome),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.ignore')).props.onClick()
  const planned = await settle(panel, props)
  // One click, one command: the plan, which writes nothing.
  assert.deepEqual(
    bridge.lines.filter((line) => line.startsWith('/guidance-scanignore')),
    ['/guidance-scanignore src/app.css --dry-run'],
    'the first click did not stop at the plan',
  )
  const plannedTexts = textsOf(planned)
  assert.ok(plannedTexts.includes(plan), 'the host plan is not shown verbatim')
  // The panel says what the exclusion means in its own words, and they are not the suppression's.
  assert.ok(plannedTexts.includes(EN.get('scan.ignoreNote')), 'the plan does not say the next scan reads less')
  assert.equal(
    plannedTexts.some((text) => text.startsWith(EN.get('scan.muteFailed').split('{')[0])),
    false,
    'an ignore plan is reported as a suppression problem',
  )
  const confirm = buttonOf(planned, EN.get('scan.ignoreConfirm'))
  assert.equal(typeof confirm, 'object', 'the ignore plan has no second, distinct button')
  confirm.props.onClick()
  const done = await settle(panel, props)
  // The second click applies the same plan: same command, no `--dry-run`.
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-scanignore')), [
    '/guidance-scanignore src/app.css --dry-run',
    '/guidance-scanignore src/app.css',
  ])
  const doneTexts = textsOf(done)
  assert.ok(doneTexts.includes(outcome), 'the outcome the host reported is not shown')
  assert.equal(typeof buttonOf(done, EN.get('scan.ignoreConfirm')), 'undefined', 'the plan outlived its confirmation')
  // A suppression was never asked for: the two writes are not one button with a switch.
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-suppress')), [])
})

test('the ignore pattern is the row path, quoted when it carries a space', async () => {
  const { tree, panel, props, bridge } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(
      JSON.stringify(scanValueOf({ findings: [findingOf({ path: 'src/my page.astro' })] })),
    ),
    '/guidance-scanignore "src/my page.astro" --dry-run': textEnvelope('Ignore plan for src/my page.astro: append it'),
    '/guidance-scanignore "src/my page.astro"': textEnvelope('Appended src/my page.astro'),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.ignore')).props.onClick()
  const planned = await settle(panel, props)
  // A pattern is one token: the command's own tokenizer strips the quotes, so the line the file gains
  // is the path the row named.
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-scanignore')), [
    '/guidance-scanignore "src/my page.astro" --dry-run',
  ])
  buttonOf(planned, EN.get('scan.ignoreConfirm')).props.onClick()
  await settle(panel, props)
  assert.equal(bridge.lines.filter((line) => line.startsWith('/guidance-scanignore')).length, 2)
})

test('one file gets one plan even when two rules fire in it', async () => {
  const plan = 'Ignore plan for src/app.css: append src/app.css to /work/app/.scanignore'
  // Two findings in one file: the ignore names the file, so exactly one plan may be on screen.
  const value = scanValueOf({ findings: [findingOf(), findingOf({ ruleId: 'ls-08', siteId: 'aa11bb22' })] })
  const { tree, panel, props } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(value)),
    '/guidance-scanignore src/app.css --dry-run': textEnvelope(plan),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  assert.equal(
    elementsOf(scanned).filter((element) => element.type === 'button' && element.children.includes(EN.get('scan.ignore'))).length,
    2,
  )
  buttonOf(scanned, EN.get('scan.ignore')).props.onClick()
  const planned = await settle(panel, props)
  assert.equal(elementsOf(planned).filter((element) => element.children.includes(plan)).length, 1, 'the plan is drawn once per row')
})

test('a refused ignore is reported with its own sentence, never the suppression one', async () => {
  const refusal = 'Refused (malformed): /work/app/.scanignore has 1 line outside the .scanignore grammar (line 2)'
  const { tree, panel, props } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(scanValueOf({ findings: [findingOf()] }))),
    '/guidance-scanignore src/app.css --dry-run': refusalEnvelope(refusal),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  buttonOf(scanned, EN.get('scan.ignore')).props.onClick()
  const refused = await settle(panel, props)
  const texts = textsOf(refused)
  assert.ok(texts.includes(translate('scan.ignoreFailed', { message: refusal })), 'the refusal is not reported')
  assert.equal(
    texts.some((text) => text.startsWith(EN.get('scan.muteFailed').split('{')[0])),
    false,
    'a refused ignore is reported as a refused suppression',
  )
  assert.equal(typeof buttonOf(refused, EN.get('scan.ignoreConfirm')), 'undefined', 'a refusal leaves a live confirmation')
})

test('each row offers only the writes it can name a target for', async () => {
  const value = scanValueOf({
    findings: [
      findingOf(),
      // A pre-C finding with no site id: it can still be ignored, because an ignore names a path.
      findingOf({ ruleId: 'ls-08', path: 'src/legacy.js', line: 8, siteId: undefined }),
      // A finding with no place: it can be muted, but there is no path to exclude.
      findingOf({ ruleId: 'ls-02', path: '', place: undefined, siteId: 'aa11bb22' }),
    ],
  })
  const { tree, panel, props } = await mountScriptedPanel(reportOf(), {
    '*': reportEnvelope(reportOf()),
    '/guidance-scan . --format json': textEnvelope(JSON.stringify(value)),
  })
  buttonOf(tree, EN.get('scanner.scan')).props.onClick()
  const scanned = await settle(panel, props)
  const offered = (label) =>
    elementsOf(scanned).filter((element) => element.type === 'button' && element.children.includes(label))
  assert.equal(offered(EN.get('scan.mute')).length, 2, 'a row without a site id offered a mute')
  assert.equal(offered(EN.get('scan.ignore')).length, 2, 'a row without a path offered an ignore')
})

test('without a scan there is no ignore to press either', async () => {
  const { tree } = await mountScriptedPanel(reportOf(), { '*': reportEnvelope(reportOf()) })
  const texts = textsOf(tree)
  assert.equal(texts.includes(EN.get('scan.ignore')), false, 'the panel offers an ignore before any scan ran')
  assert.equal(texts.includes(EN.get('scan.ignoreConfirm')), false, 'an ignore confirmation is on screen without a plan')
})

test('the panel copies the report JSON and says so, without a second request', async () => {
  const report = reportOf({ calls: 4 })
  const copied = []
  const clipboard = {
    writeText(text) {
      copied.push(text)
      return Promise.resolve()
    },
  }
  const { tree, panel, props } = await mountPanel(report, { navigator: { clipboard } })
  const button = buttonOf(tree, EN.get('copy.json'))
  assert.equal(typeof button, 'object', 'the panel offers no copy action')
  button.props.onClick()
  const after = await settle(panel, props)
  assert.equal(copied.length, 1, 'the click did not write the clipboard once')
  // What is copied is the object the host sent: no re-encoding of the normalized report, which is a
  // subset by design, and no second command.
  assert.deepEqual(JSON.parse(copied[0]), report)
  assert.equal(typeof buttonOf(after, EN.get('copy.done')), 'object', 'the copy was not reported on the button')
  assert.equal(buttonOf(after, EN.get('copy.failed')), undefined)
})

test('a clipboard that refuses is reported, and a page without one gets no button', async () => {
  const clipboard = { writeText: () => Promise.reject(new Error('denied')) }
  const { tree, panel, props } = await mountPanel(reportOf(), { navigator: { clipboard } })
  buttonOf(tree, EN.get('copy.json')).props.onClick()
  const failed = await settle(panel, props)
  assert.equal(typeof buttonOf(failed, EN.get('copy.failed')), 'object', 'a refused copy is silent')
  assert.equal(buttonOf(failed, EN.get('copy.done')), undefined)

  // No clipboard on this page — an insecure origin, a shell that mounts none: no button at all.
  const plain = await mountPanel(reportOf())
  assert.equal(buttonOf(plain.tree, EN.get('copy.json')), undefined, 'a page without a clipboard offers a copy')
})

/** The copy's bounded wait, read from the source: the test cannot import the browser module. */
const COPY_TIMEOUT_MS = Number(/const COPY_TIMEOUT_MS = (\d+)/.exec(CLIENT_SOURCE)?.[1])

test('a clipboard that never settles is reported as a failure, not left looking idle', async (t) => {
  // This is the live-host defect, reproduced: a window without OS focus parks `writeText()`, so it
  // settles neither way and a label that only moves on `then`/`catch` stays on `copy.json` forever —
  // a working copy and a dead button look identical. Resolve and reject alone would not have caught it.
  assert.ok(
    Number.isSafeInteger(COPY_TIMEOUT_MS) && COPY_TIMEOUT_MS > 0,
    'client.js has no named, positive COPY_TIMEOUT_MS',
  )
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clipboard = { writeText: () => new Promise(() => {}) }
  const { tree, panel, props } = await mountPanel(reportOf(), { navigator: { clipboard } })
  buttonOf(tree, EN.get('copy.json')).props.onClick()
  // While the write is in flight the label has not moved: it claims nothing it does not know.
  const waiting = await settle(panel, props)
  assert.equal(typeof buttonOf(waiting, EN.get('copy.json')), 'object', 'the label answered before the copy did')
  assert.equal(buttonOf(waiting, EN.get('copy.done')), undefined, 'a parked copy is reported as done')
  t.mock.timers.tick(COPY_TIMEOUT_MS)
  const answered = await settle(panel, props)
  assert.equal(typeof buttonOf(answered, EN.get('copy.timeout')), 'object', 'a parked copy reports nothing at all')
  assert.equal(buttonOf(answered, EN.get('copy.done')), undefined, 'a copy nobody saw land is reported as done')
  // The timeout is its own sentence: "did not answer" is not "refused", and the panel must not
  // pretend it knows which one it was.
  assert.equal(buttonOf(answered, EN.get('copy.failed')), undefined, 'a timeout is reported as a refusal')
})

test('a copy that lands after the timeout does not turn the failure back into a success', async (t) => {
  // The honesty direction: once the panel has said it could not copy, a late resolve proves only that
  // the write was slow. Flipping the label to `JSON copied` would retract a true statement, so the
  // late success must find the race already settled. A `writeText().then(done)` without the race
  // would show `copy.done` here, which is exactly the implementation this test rejects.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let land
  const clipboard = {
    writeText: () =>
      new Promise((resolve) => {
        land = resolve
      }),
  }
  const { tree, panel, props } = await mountPanel(reportOf(), { navigator: { clipboard } })
  buttonOf(tree, EN.get('copy.json')).props.onClick()
  t.mock.timers.tick(COPY_TIMEOUT_MS)
  await new Promise((resolve) => setImmediate(resolve))
  land()
  const late = await settle(panel, props)
  assert.equal(typeof buttonOf(late, EN.get('copy.timeout')), 'object', 'a late copy silently overwrote the timeout')
  assert.equal(buttonOf(late, EN.get('copy.done')), undefined, 'a late copy claims the user was told it worked')
})

test('with nothing to copy the copy action is absent, not broken', async () => {
  const clipboard = { writeText: () => Promise.resolve() }
  // No report: the command refused, so the panel has no JSON and must not offer to hand one over.
  const { tree } = await mountScriptedPanel(reportOf(), { '*': refusalEnvelope('Error: no-profile — nothing recorded') }, {
    navigator: { clipboard },
  })
  assert.equal(buttonOf(tree, EN.get('copy.json')), undefined, 'an empty panel offers a copy')
})

/** The strings the removal added: the row action, its confirmation, its refusal and the lead-in. */
const REMOVE_KEYS = ['scan.remove', 'scan.removeConfirm', 'scan.removeFailed', 'scan.removeNote']

/** A report for a workspace whose last scan reviewed its suppression file. */
function reviewReport(suppressions, lastScan = {}) {
  return reportOf({
    lastScan: {
      at: '2026-11-10T09:42:11.000Z',
      files: 12,
      findings: 4,
      rules: [],
      skipped: {},
      truncated: false,
      suppressions,
      ...lastScan,
    },
  })
}

test('the removal strings exist in all three dictionaries, in one group after the mute', () => {
  const english = [...EN.keys()]
  const positions = REMOVE_KEYS.map((key) => {
    assert.notEqual(english.indexOf(key), -1, `EN has no ${key}`)
    return english.indexOf(key)
  })
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'the keys are out of order')
  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(positions[index], positions[index - 1] + 1, 'the removal keys are not one contiguous group')
  }
  // The two halves of ADR-0004 are one story: the mute appends an entry, the removal takes it back, and
  // a reader of the dictionaries meets them together — with the ignore group in between, because that
  // is the order the writes were added in and reordering would rewrite three dictionaries for nothing.
  assert.equal(positions[0], english.indexOf('scan.muteNote') + 1, 'the removal keys do not follow the mute note')
  for (const key of REMOVE_KEYS) {
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
  assert.deepEqual(placeholders(EN.get('scan.removeFailed')), ['message'])
  // The second click names the file it shrinks, and a file name is never translated.
  for (const dictionary of [EN, RU, ZH]) {
    assert.match(dictionary.get('scan.removeConfirm'), /\.suppress/, 'the confirmation does not name the file it edits')
  }
  // The one panel-owned sentence a removal gets says what it does and refuses the vocabulary of repair:
  // an entry that is gone from the file is still a finding, and a person who reads "fixed" has been told
  // a false thing about their code.
  assert.doesNotMatch(EN.get('scan.removeNote'), /fix|resolv|repair|gone/i, 'the removal note promises a repair')
  assert.match(EN.get('scan.removeNote'), /un-mutes/, 'the removal note does not say what it undoes')
  assert.doesNotMatch(RU.get('scan.removeNote'), /исправ|почин|решён/i, 'the Russian note promises a repair')
  assert.doesNotMatch(ZH.get('scan.removeNote'), /修复|解决/, 'the Chinese note promises a repair')
  // Two different writes, two different action words: removal must not borrow the ignore's or the mute's.
  assert.notEqual(EN.get('scan.remove'), EN.get('scan.mute'))
  assert.notEqual(EN.get('scan.removeConfirm'), EN.get('scan.muteConfirm'))
})

test('a review with unused entries names its counts and offers one removal per id', async () => {
  const { tree } = await mountPanel(reviewReport({ entries: 3, matching: 1, unused: ['aa11bb22', 'cc33dd44'] }))
  const texts = textsOf(tree)
  assert.ok(
    texts.includes(translate('scanner.review', { entries: translate('entry.few', { count: 3 }), matching: 1, unused: 2 })),
    'the review header does not name all three numbers',
  )
  assert.ok(texts.includes(EN.get('scanner.reviewList')), 'the unused entries have no caption')
  // The ids are the host's data: eight hex characters, drawn as given and never translated.
  assert.equal(texts.filter((text) => text === 'aa11bb22' || text === 'cc33dd44').length, 2, 'an unused id is not drawn')
  const removals = elementsOf(tree).filter(
    (element) => element.type === 'button' && element.children.includes(EN.get('scan.remove')),
  )
  assert.equal(removals.length, 2, 'the review does not offer one removal per entry')
  // Bounded by height, not by a cap: the box scrolls so every remove action stays reachable, where
  // slicing the list would leave a counted entry with no button to act on it.
  const box = elementIn(tree, (element) => element.props.style?.maxHeight === '150px' && element.props.style?.overflowY === 'auto')
  assert.equal(typeof box, 'object', 'the review list is not a bounded, scrollable block')
  assert.equal(elementsOf(box).filter((element) => element.type === 'button').length, 2, 'the list is bounded but not whole')
})

test('an incomplete scan prints the counts without an unused number', async () => {
  // `unused: null` is the host saying it could not prove anything: a scan that skipped files or read
  // fewer of them than its baseline cannot know which entries matched nothing, and the panel must not
  // print `0` for it — that sentence would claim every mute still matches a site nobody looked for.
  const { tree } = await mountPanel(reviewReport({ entries: 3, matching: 1, unused: null }))
  const texts = textsOf(tree)
  assert.ok(
    texts.includes(translate('scanner.reviewUnknown', { entries: translate('entry.few', { count: 3 }), matching: 1 })),
    'an incomplete review draws no sentence',
  )
  assert.equal(
    texts.includes(translate('scanner.review', { entries: translate('entry.few', { count: 3 }), matching: 1, unused: 0 })),
    false,
    'an incomplete review invented an unused number',
  )
  assert.equal(texts.includes(EN.get('scanner.reviewList')), false, 'an incomplete review lists entries it cannot prove')
  assert.equal(buttonOf(tree, EN.get('scan.remove')), undefined, 'an incomplete review offers a removal it cannot justify')
  // A list that disagrees with its own counts is the same state: two entries, one match, and one id
  // cannot name the other, so the ids are dropped rather than used to accuse an entry of idleness.
  for (const dishonest of [
    { entries: 3, matching: 1, unused: ['aa11bb22'] },
    { entries: 3, matching: 1, unused: 'aa11bb22' },
    { entries: '3', matching: 1, unused: [] },
  ]) {
    const { tree: guarded } = await mountPanel(reviewReport(dishonest))
    assert.equal(
      buttonOf(guarded, EN.get('scan.remove')),
      undefined,
      `a review that disagrees with itself (${JSON.stringify(dishonest)}) still offers a removal`,
    )
  }
})

test('a scan without review data draws no block, and a measured zero draws one', async () => {
  // A 0.11.0 document, or a `.suppress` nobody could read: the host attaches nothing, and the panel
  // renders the 0.11.0 section exactly — no header, no caption, no action.
  for (const report of [reportOf(), reportOf({ lastScan: { at: '2026-11-10T09:42:11.000Z', files: 12, findings: 4, rules: [] } })]) {
    const { tree } = await mountPanel(report)
    assert.equal(textsOf(tree).some((text) => text.startsWith('.suppress')), false, 'a document without a review grew one')
    assert.equal(buttonOf(tree, EN.get('scan.remove')), undefined, 'a document without a review offers a removal')
  }
  // An empty file is a measured zero, and its own absence: there is nothing to list, and a header
  // about zero entries would be noise about a file the project does not use.
  const { tree: empty } = await mountPanel(reviewReport({ entries: 0, matching: 0, unused: [] }))
  assert.equal(textsOf(empty).some((text) => text.startsWith('.suppress')), false, 'an empty suppression file grew a review')
  // A file whose every entry still matches says so, in numbers, without inventing a list.
  const { tree: matched } = await mountPanel(reviewReport({ entries: 2, matching: 2, unused: [] }))
  const texts = textsOf(matched)
  assert.ok(
    texts.includes(translate('scanner.review', { entries: translate('entry.few', { count: 2 }), matching: 2, unused: 0 })),
    'a review with nothing unused does not say so',
  )
  assert.equal(texts.includes(EN.get('scanner.reviewList')), false, 'a review with nothing unused lists an entry')
})

test('a removal asks for a plan, writes nothing on the first click and never calls the entry fixed', async () => {
  // The host's two sentences, copied from `index.js`'s `removeSuppressionOutcome`: the plan names the
  // payload it would drop (date and reason), the outcome says the site is unmuted and that no counter
  // moved. The fixture is the host's own text because the panel must not add a word to either.
  const plan =
    'Removal plan for aa11bb22: remove 1 entry from /work/app/.suppress, which would go from 1 to 0 entries, dropping the entry it recorded (2026-10-02, "changed on purpose"). Nothing has been written; run the same line without --dry-run to remove it.'
  const outcome =
    'Removed aa11bb22 from /work/app/.suppress; the file now holds 0 entries. The site is no longer muted, so the next scan counts it as a finding again. A removal is not a fix: it does not mean the finding went away, and no counter has changed.'
  const review = { entries: 1, matching: 0, unused: ['aa11bb22'] }
  const { tree, panel, props, bridge } = await mountScriptedPanel(reviewReport(review), {
    '*': reportEnvelope(reviewReport(review)),
    '/guidance-suppress --remove aa11bb22 --dry-run': textEnvelope(plan),
    '/guidance-suppress --remove aa11bb22': textEnvelope(outcome),
  })
  buttonOf(tree, EN.get('scan.remove')).props.onClick()
  const planned = await settle(panel, props)
  // The first click asked the host for a plan and nothing else: one line, and it is the dry run.
  assert.deepEqual(
    bridge.lines.filter((line) => line.startsWith('/guidance-suppress')),
    ['/guidance-suppress --remove aa11bb22 --dry-run'],
    'the first click did not ask for exactly one removal plan',
  )
  const plannedTexts = textsOf(planned)
  assert.ok(plannedTexts.includes(plan), 'the host plan is not shown verbatim')
  assert.ok(plannedTexts.includes(EN.get('scan.removeNote')), 'the plan does not say what a removal means')
  // The box is about a named entry: the id the command line takes is the caption of the plan.
  assert.ok(plannedTexts.includes('aa11bb22'), 'the plan does not name the entry it would remove')
  // No vocabulary of repair reaches the screen, in either the panel's sentence or the host's outcome.
  assert.doesNotMatch(plannedTexts.join('\n'), /\bfixed\b|\bresolved\b/i, 'the removal flow promises a repair')
  const confirm = buttonOf(planned, EN.get('scan.removeConfirm'))
  assert.equal(typeof confirm, 'object', 'the removal plan has no second, distinct button')
  confirm.props.onClick()
  const done = await settle(panel, props)
  assert.deepEqual(
    bridge.lines.filter((line) => line.startsWith('/guidance-suppress')),
    ['/guidance-suppress --remove aa11bb22 --dry-run', '/guidance-suppress --remove aa11bb22'],
    'the second click did not run the plan it showed',
  )
  // The host's own outcome, verbatim: it is what says the site is unmuted and that no counter moved.
  assert.ok(textsOf(done).includes(outcome), 'the outcome the host reported is not shown')
  assert.equal(buttonOf(done, EN.get('scan.removeConfirm')), undefined, 'the plan outlived its confirmation')
  // The three writes are three flows: no ignore line and no appending mute line were ever asked for.
  assert.deepEqual(bridge.lines.filter((line) => line.startsWith('/guidance-scanignore')), [])
  assert.deepEqual(bridge.lines.filter((line) => /^\/guidance-suppress [0-9a-f]{8}/.test(line)), [])
})

test('a refused removal is an error with the host reason, never an outcome', async () => {
  const refusal = 'Refused (unwritable): /work/app/.suppress is not a file this command can rewrite, so no entry was removed and nothing changed'
  const review = { entries: 1, matching: 0, unused: ['aa11bb22'] }
  const { tree, panel, props } = await mountScriptedPanel(reviewReport(review), {
    '*': reportEnvelope(reviewReport(review)),
    '/guidance-suppress --remove aa11bb22 --dry-run': refusalEnvelope(refusal),
  })
  buttonOf(tree, EN.get('scan.remove')).props.onClick()
  const refused = await settle(panel, props)
  const texts = textsOf(refused)
  assert.ok(texts.includes(translate('scan.removeFailed', { message: refusal })), 'the refusal is not reported with its reason')
  // A refusal is not an outcome: the entry stays listed, and no second click is offered.
  assert.equal(buttonOf(refused, EN.get('scan.removeConfirm')), undefined, 'a refusal leaves a live confirmation')
  assert.equal(texts.includes(refusal), false, 'the refusal is rendered as a success sentence')
})

/** The three words a review row may use for the verdict this scan could prove, plus the too-long note. */
const MATCH_KEYS = ['scan.matchMatched', 'scan.matchUnused', 'scan.matchUnknown']

test('the row-state words exist in all three dictionaries and say three different things', () => {
  const english = [...EN.keys()]
  const positions = MATCH_KEYS.map((key) => {
    assert.notEqual(english.indexOf(key), -1, `EN has no ${key}`)
    return english.indexOf(key)
  })
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'the state words are out of order')
  for (let index = 1; index < positions.length; index += 1) {
    assert.equal(positions[index], positions[index - 1] + 1, 'the state words are not one contiguous group')
  }
  // They follow the removal's own group, because they describe the rows that group is offered on.
  assert.equal(positions[0], english.indexOf('scan.removeNote') + 1, 'the state words do not follow the removal note')
  for (const key of MATCH_KEYS) {
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
  // Three states, three words: "unknown" must not be spelled as "unused", or the row would claim the
  // one thing the scan explicitly could not prove.
  for (const dictionary of [EN, RU, ZH]) {
    const words = MATCH_KEYS.map((key) => dictionary.get(key))
    assert.equal(new Set(words).size, 3, `a dictionary reuses a row-state word: ${words.join(', ')}`)
  }
  // The too-long note names the command that prints the whole file, and a command line is never
  // translated: it is the same Latin text in all three dictionaries.
  assert.match(EN.get('scanner.reviewTooLong'), /\/guidance-suppress --review/, 'the note names no way to see the list')
  for (const dictionary of [EN, RU, ZH]) {
    assert.match(dictionary.get('scanner.reviewTooLong'), /\/guidance-suppress --review/, 'a dictionary dropped the command')
  }
})

test('rows that carry the file show its date and reason, and mark every verdict it can prove', async () => {
  const review = {
    entries: 3,
    matching: 1,
    unused: ['aa11bb22', 'cc33dd44'],
    items: [
      { siteId: 'aa11bb22', date: '2026-10-02', reason: 'changed on purpose', matched: false },
      { siteId: 'bb22cc33', date: '2026-10-04', matched: true },
      { siteId: 'cc33dd44', reason: 'temporary experiment', matched: false },
    ],
  }
  const { tree } = await mountPanel(reviewReport(review))
  const texts = textsOf(tree)
  assert.ok(
    texts.includes(translate('scanner.review', { entries: translate('entry.few', { count: 3 }), matching: 1, unused: 2 })),
    'the header does not name the counts',
  )
  // Every entry of the file, not only the dead ones: three rows, three remove actions.
  const removals = elementsOf(tree).filter(
    (element) => element.type === 'button' && element.children.includes(EN.get('scan.remove')),
  )
  assert.equal(removals.length, 3, 'the review does not offer one removal per entry')
  // The file's own members, verbatim: the date as it was written, the reason as a person wrote it.
  for (const fact of ['aa11bb22', 'bb22cc33', 'cc33dd44', '2026-10-02', '2026-10-04', 'changed on purpose', 'temporary experiment']) {
    assert.ok(texts.includes(fact), `the review dropped ${fact}`)
  }
  // The verdict, in three words: two dead, one live, none unknown.
  assert.equal(texts.filter((text) => text === EN.get('scan.matchUnused')).length, 2, 'an unused entry is not marked')
  assert.equal(texts.filter((text) => text === EN.get('scan.matchMatched')).length, 1, 'a matching entry is not marked')
  assert.equal(texts.includes(EN.get('scan.matchUnknown')), false, 'a proven verdict is marked unknown')
  // The fallback's caption belongs to the fallback: this block lists the file, so it does not say
  // "entries that matched nothing" about a list that is mostly matches.
  assert.equal(texts.includes(EN.get('scanner.reviewList')), false, 'the whole file is captioned as its dead rows')
  // No rule id can be recovered from the file's one-way hash, so the panel must not draw one.
  assert.equal(texts.some((text) => /^ls-\d\d$/.test(text)), false, 'the panel invented a rule id for a file entry')
  // Still bounded by height, and still not capped: all three rows live in the one scroll box.
  const box = elementIn(tree, (element) => element.props.style?.maxHeight === '150px' && element.props.style?.overflowY === 'auto')
  assert.equal(typeof box, 'object', 'the file list is not a bounded, scrollable block')
  assert.equal(elementsOf(box).filter((element) => element.type === 'button').length, 3, 'the bounded list is not whole')
})

test('a row whose verdict the scan could not prove is marked unknown, never unused', async () => {
  const review = {
    entries: 2,
    matching: 0,
    unused: null,
    items: [
      { siteId: 'aa11bb22', date: '2026-10-02', matched: null },
      { siteId: 'bb22cc33', matched: null },
    ],
  }
  const { tree } = await mountPanel(reviewReport(review))
  const texts = textsOf(tree)
  assert.ok(
    texts.includes(translate('scanner.reviewUnknown', { entries: translate('entry.few', { count: 2 }), matching: 0 })),
    'an incomplete review draws no sentence',
  )
  assert.equal(texts.filter((text) => text === EN.get('scan.matchUnknown')).length, 2, 'an unknown verdict is not marked')
  assert.equal(texts.includes(EN.get('scan.matchUnused')), false, 'an unknown verdict is marked unused')
  assert.equal(
    texts.includes(translate('scanner.review', { entries: translate('entry.few', { count: 2 }), matching: 0, unused: 0 })),
    false,
    'an incomplete review invented an unused number',
  )
  // The rows are the file, so they can still be acted on one by one — this is the only way to un-mute
  // a live finding, and it never needed the verdict to be proven.
  assert.equal(
    elementsOf(tree).filter((element) => element.type === 'button' && element.children.includes(EN.get('scan.remove'))).length,
    2,
    'the rows of an incomplete review offer no removal',
  )
  // A row that contradicts the header loses: `unused: null` says this scan could not prove absence, so a
  // stray `matched: true` is drawn as unknown rather than believed over the count it disagrees with.
  const { tree: contradicted } = await mountPanel(
    reviewReport({ ...review, items: [{ siteId: 'aa11bb22', matched: true }, { siteId: 'bb22cc33', matched: false }] }),
  )
  const contradictedTexts = textsOf(contradicted)
  assert.equal(contradictedTexts.filter((text) => text === EN.get('scan.matchUnknown')).length, 2, 'a contradiction is trusted')
  assert.equal(contradictedTexts.includes(EN.get('scan.matchMatched')), false, 'a partial scan claimed a match it did not prove')
})

test('a file too large to list draws its counts and one plain note, never a prefix', async () => {
  // The host drops the row list past its own cap and keeps the counts honest; a prefix would read as
  // the whole file, which is exactly the plausible lie the cap exists to refuse.
  const { tree } = await mountPanel(reviewReport({ entries: 240, matching: 12, unused: null }))
  const texts = textsOf(tree)
  assert.ok(texts.includes(EN.get('scanner.reviewTooLong')), 'a file too large to list says nothing about it')
  assert.equal(texts.includes(EN.get('scanner.reviewList')), false, 'a too-long file lists a partial caption')
  assert.equal(buttonOf(tree, EN.get('scan.remove')), undefined, 'a too-long file offers removals from a list it does not show')
  // The counts stay, because they are computed over the whole file and are the honest half of the block.
  assert.ok(
    texts.includes(translate('scanner.reviewUnknown', { entries: translate('entry.many', { count: 240 }), matching: 12 })),
    'a too-long file dropped the counts too',
  )
  // A measured zero is still a zero, and the note still explains why no row follows it.
  const { tree: measured } = await mountPanel(reviewReport({ entries: 240, matching: 240, unused: [] }))
  const measuredTexts = textsOf(measured)
  assert.ok(
    measuredTexts.includes(
      translate('scanner.review', { entries: translate('entry.many', { count: 240 }), matching: 240, unused: 0 }),
    ),
    'a measured zero of a too-long file does not print',
  )
  assert.ok(measuredTexts.includes(EN.get('scanner.reviewTooLong')), 'a too-long file with nothing unused drew no note')
  assert.equal(buttonOf(measured, EN.get('scan.remove')), undefined, 'a too-long file offered a removal anyway')
})

test('a row list that is not the file is dropped, and the fallback lists what it can prove', async () => {
  // Each of these claims to be the file and is not: a list shorter than the count, one id twice, an id
  // that is not a key, a member that is not a list at all. The block falls back to the ids `unused`
  // names rather than drawing a partial file — the difference between "here is the file" and "here is
  // what matched nothing" is the whole point of having two shapes.
  const unused = ['aa11bb22', 'cc33dd44']
  const shared = { entries: 2, matching: 0, unused }
  for (const items of [
    [{ siteId: 'aa11bb22', date: '2026-10-02', matched: false }],
    [{ siteId: 'aa11bb22', matched: false }, { siteId: 'aa11bb22', matched: false }],
    [{ siteId: 'aa11bb22', matched: false }, { siteId: 'zzzzzzzz', matched: false }],
    'aa11bb22',
    [{ siteId: 'aa11bb22', reason: 'only one row' }],
  ]) {
    const { tree } = await mountPanel(reviewReport({ ...shared, items }))
    const texts = textsOf(tree)
    assert.ok(
      texts.includes(EN.get('scanner.reviewList')),
      `a row list that is not the file (${JSON.stringify(items)}) was drawn as the file`,
    )
    assert.deepEqual(
      texts.filter((text) => text === 'aa11bb22' || text === 'cc33dd44'),
      unused,
      'the fallback did not list the ids it can prove',
    )
    assert.equal(texts.includes('2026-10-02'), false, 'a dropped row kept its date on screen')
    assert.equal(texts.includes('only one row'), false, 'a dropped row kept its reason on screen')
  }
})

test('a matching entry can be removed too, under the same two clicks', async () => {
  // The only entry whose removal un-mutes a live finding is one that still matches: offering Remove
  // only on dead rows would make the panel unable to undo the useful mutes.
  const review = {
    entries: 1,
    matching: 1,
    unused: [],
    items: [{ siteId: 'dd44ee55', date: '2026-10-06', reason: 'still live', matched: true }],
  }
  const plan =
    'Removal plan for dd44ee55: remove 1 entry from /work/app/.suppress, which would go from 1 to 0 entries, dropping the entry it recorded (2026-10-06, "still live"). Nothing has been written; run the same line without --dry-run to remove it.'
  const outcome =
    'Removed dd44ee55 from /work/app/.suppress; the file now holds 0 entries. The site is no longer muted, so the next scan counts it as a finding again. A removal is not a fix: it does not mean the finding went away, and no counter has changed.'
  const { tree, panel, props, bridge } = await mountScriptedPanel(reviewReport(review), {
    '*': reportEnvelope(reviewReport(review)),
    '/guidance-suppress --remove dd44ee55 --dry-run': textEnvelope(plan),
    '/guidance-suppress --remove dd44ee55': textEnvelope(outcome),
  })
  const texts = textsOf(tree)
  assert.equal(texts.includes(EN.get('scan.matchMatched')), true, 'a live entry is not marked as matched')
  buttonOf(tree, EN.get('scan.remove')).props.onClick()
  const planned = await settle(panel, props)
  assert.deepEqual(
    bridge.lines.filter((line) => line.startsWith('/guidance-suppress')),
    ['/guidance-suppress --remove dd44ee55 --dry-run'],
    'the first click did not ask for exactly one removal plan',
  )
  assert.ok(textsOf(planned).includes(plan), 'the host plan is not shown verbatim')
  buttonOf(planned, EN.get('scan.removeConfirm')).props.onClick()
  const done = await settle(panel, props)
  assert.deepEqual(
    bridge.lines.filter((line) => line.startsWith('/guidance-suppress')),
    ['/guidance-suppress --remove dd44ee55 --dry-run', '/guidance-suppress --remove dd44ee55'],
    'the second click did not run the plan it showed',
  )
  assert.ok(textsOf(done).includes(outcome), 'the outcome the host reported is not shown')
})
