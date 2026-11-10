/**
 * Client half of dsh-modern-web-guidance: the sidebar rail entry, the read-only
 * "Guidance Insights" panel, and the chat row for the legacy-scan tool.
 *
 * The browser module loader gives no relative imports, so this file is self-contained: React
 * arrives through `require`, host services and the React context through `ctx`, and every visible
 * string through the Client locale service. The panel changes nothing on its own — it asks the host
 * to run this plugin's own `/guidance-stats --json` and `/guidance-scan` commands and renders what
 * comes back, so the slash commands and the panel keep one implementation each.
 *
 * The chat row is registered into ui-tool's keyed `tool.call.toolview` slot under the wire name
 * `web_guidance_legacy_scan`, which is an unclaimed key: the generic card stays in place for every
 * other tool, and this row replaces only that one.
 *
 * Bridge note: `commands.execute` is a host method already exposed as a Remote
 * (`@Remote(agent, line, submittedAttachments, signal)`), so the panel needs no new host service and
 * no schema codegen. It resolves the Remote service lazily on every call: a page whose composition
 * does not mount it renders the "Panel bridge unavailable" state instead of guessing.
 */

window.__ModuleLoader__.load({
  id: 'dsh-modern-web-guidance',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-modern-web-guidance'
    /**
     * The sidebar entry id AND the `main` slot key: the layout dispatches `main` by the selected
     * sidebar id, so these two must stay one constant.
     */
    const PANEL_ID = 'guidance'
    /** The command line whose report this panel renders. */
    const REPORT_LINE = '/guidance-stats --json'
    /** The windows the header switch offers, in days. The first one is the default. */
    const PERIODS = [7, 30]
    /** Dead-guide ids the panel lists: the counter caps its own sample at 20 as well. */
    const MAX_DEAD_ROWS = 20
    /**
     * The scan the panel's button runs. `.` is the session workspace: the command refuses to scan
     * anything on its own, so the panel asks for it explicitly and the scanner still decides what
     * that path means. JSON output, because the panel renders counters, not sentences.
     */
    const SCAN_LINE = '/guidance-scan . --format json'
    /** The wire name of the scan tool: the key ui-tool dispatches a row by, and the name in the log. */
    const SCAN_TOOL_NAME = 'web_guidance_legacy_scan'
    /** Rules one scan ranks in the panel, and findings the chat row lists before it summarises. */
    const MAX_SCAN_RULES = 10
    const MAX_TOOL_ROWS = 16

    /** English dictionary: the fallback locale, so it must stay complete. */
    const EN = {
      'title': 'Guidance Insights',
      'subtitle': 'Local counters recorded by this plugin. Read-only.',
      'refresh': 'Refresh',
      'loading': 'Reading the counters...',
      'updated': 'Updated {time}',
      'period.short': '{days} d',
      'kpi.calls': 'Total calls',
      'kpi.hitRate': 'Hit rate',
      'hitRate.raw': 'The report counts every call: {value}',
      'kpi.period': 'Period',
      'kpi.periodValue': 'Last {days} days',
      'kpi.corpus': 'Guides',
      'stats.legacyScan': 'Legacy scans',
      'stats.findings': 'Findings',
      'tool.legacyScan': 'Legacy scan',
      'section.series': 'Calls per day',
      'series.bar': '{day}: {calls}',
      'section.breakdown': 'Calls by tool and outcome',
      'breakdown.byTool': 'By tool',
      'breakdown.byOutcome': 'By outcome',
      'breakdown.empty': 'Nothing to break down yet.',
      'section.scanner': 'What the scanner catches',
      'scanner.none': 'No scan has run yet.',
      'scanner.last': 'Last scan: {when}',
      'scanner.rules': 'Rules that matched',
      'scanner.guides': 'Guides to load',
      'scanner.scan': 'Scan workspace folder',
      'scanner.scanning': 'Scanning the workspace...',
      'scanner.failed': 'The scan did not run: {message}',
      'scan.summary': 'Scanned {files}, {findings}',
      'scan.clean': 'No rule matched.',
      'scan.truncated': 'Truncated: the scan hit a cap, so this list is incomplete.',
      'row.title': 'Legacy scan',
      'row.preparing': 'Preparing the scan...',
      'row.running': 'Scanning...',
      'row.stopped': 'Scan stopped',
      'row.failed': 'Scan failed',
      'row.paths': 'Paths: {paths}',
      'row.more': 'and {count} more',
      'row.rule': 'Rule',
      'row.confidence': 'Confidence',
      'row.location': 'Location',
      'row.guide': 'Guide',
      'section.queries': 'Top queries',
      'section.queries.empty': 'No queries to rank yet.',
      'section.coverage': 'Category coverage',
      'section.misses': 'Queries that found nothing',
      'section.misses.empty': 'No query came back empty.',
      'section.dead': 'Dead guides',
      'dead.summary': '{count} of {total} guides have never been retrieved',
      'dead.none': 'Every guide has been retrieved at least once.',
      'coverage.value': '{retrieved} / {total}',
      'call.one': '{count} call',
      'call.few': '{count} calls',
      'call.many': '{count} calls',
      'hit.one': '{count} hit',
      'hit.few': '{count} hits',
      'hit.many': '{count} hits',
      'miss.one': '{count} miss',
      'miss.few': '{count} misses',
      'miss.many': '{count} misses',
      'file.one': '{count} file',
      'file.few': '{count} files',
      'file.many': '{count} files',
      'finding.one': '{count} finding',
      'finding.few': '{count} findings',
      'finding.many': '{count} findings',
      'empty.title': 'No calls in the last {days} days',
      'empty.body': 'Ask for a guide with web_guidance_search, then refresh this panel. /guidance-stats prints the same report as text.',
      'error.title': 'Usage counters are unavailable',
      'error.bridge': 'Panel bridge unavailable',
      'error.bridgeHint': 'The host command bridge is not reachable from this page. /guidance-stats --json prints the same report.',
      'error.session': 'No session is available to run /guidance-stats',
      'error.sessionHint': 'Open or start a conversation, then press Refresh.',
      'error.hint': '/guidance-stats prints the same report in the terminal.',
    }

    /** Russian dictionary. */
    const RU = {
      'title': 'Статистика подсказок',
      'subtitle': 'Локальные счётчики плагина. Только чтение.',
      'refresh': 'Обновить',
      'loading': 'Чтение счётчиков...',
      'updated': 'Обновлено {time}',
      'period.short': '{days} дн.',
      'kpi.calls': 'Всего вызовов',
      'kpi.hitRate': 'Доля попаданий',
      'hitRate.raw': 'В отчёте учитываются все вызовы: {value}',
      'kpi.period': 'Период',
      'kpi.periodValue': 'Последние {days} дн.',
      'kpi.corpus': 'Подсказок',
      'stats.legacyScan': 'Сканирования устаревшего кода',
      'stats.findings': 'Замечания',
      'tool.legacyScan': 'Сканер устаревшего кода',
      'section.series': 'Вызовы по дням',
      'series.bar': '{day}: {calls}',
      'section.breakdown': 'Вызовы по инструментам и исходам',
      'breakdown.byTool': 'По инструментам',
      'breakdown.byOutcome': 'По исходам',
      'breakdown.empty': 'Пока нечего разбирать.',
      'section.scanner': 'Что находит сканер',
      'scanner.none': 'Сканирование ещё не запускали.',
      'scanner.last': 'Последнее сканирование: {when}',
      'scanner.rules': 'Сработавшие правила',
      'scanner.guides': 'Подсказки, которые стоит открыть',
      'scanner.scan': 'Сканировать рабочую папку',
      'scanner.scanning': 'Сканирую рабочую папку...',
      'scanner.failed': 'Сканирование не запустилось: {message}',
      'scan.summary': 'Просканировано {files}, {findings}',
      'scan.clean': 'Ни одно правило не сработало.',
      'scan.truncated': 'Список обрезан: сканирование упёрлось в лимит, поэтому он неполный.',
      'row.title': 'Сканер устаревшего кода',
      'row.preparing': 'Готовлю сканирование...',
      'row.running': 'Сканирую...',
      'row.stopped': 'Сканирование остановлено',
      'row.failed': 'Сканирование не удалось',
      'row.paths': 'Пути: {paths}',
      'row.more': 'и ещё {count}',
      'row.rule': 'Правило',
      'row.confidence': 'Уверенность',
      'row.location': 'Место',
      'row.guide': 'Подсказка',
      'section.queries': 'Частые запросы',
      'section.queries.empty': 'Пока нет запросов для рейтинга.',
      'section.coverage': 'Покрытие по категориям',
      'section.misses': 'Запросы без результата',
      'section.misses.empty': 'Ни один запрос не остался без результата.',
      'section.dead': 'Непрочитанные подсказки',
      'dead.summary': '{count} из {total} подсказок ни разу не открывали',
      'dead.none': 'Каждую подсказку открывали хотя бы раз.',
      'coverage.value': '{retrieved} / {total}',
      'call.one': '{count} вызов',
      'call.few': '{count} вызова',
      'call.many': '{count} вызовов',
      'hit.one': '{count} попадание',
      'hit.few': '{count} попадания',
      'hit.many': '{count} попаданий',
      'miss.one': '{count} промах',
      'miss.few': '{count} промаха',
      'miss.many': '{count} промахов',
      'file.one': '{count} файл',
      'file.few': '{count} файла',
      'file.many': '{count} файлов',
      'finding.one': '{count} замечание',
      'finding.few': '{count} замечания',
      'finding.many': '{count} замечаний',
      'empty.title': 'За последние {days} дн. вызовов не было',
      'empty.body': 'Попросите подсказку через web_guidance_search и обновите панель. /guidance-stats печатает тот же отчёт текстом.',
      'error.title': 'Счётчики недоступны',
      'error.bridge': 'Мост панели недоступен',
      'error.bridgeHint': 'Мост команд хоста недоступен со страницы. /guidance-stats --json печатает тот же отчёт.',
      'error.session': 'Нет сессии, в которой можно выполнить /guidance-stats',
      'error.sessionHint': 'Откройте или начните диалог, затем нажмите «Обновить».',
      'error.hint': '/guidance-stats печатает тот же отчёт в терминале.',
    }

    /**
     * Simplified Chinese dictionary. Chinese has no plural inflection, so `call`, `hit` and `miss`
     * define `.one`, `.few` and `.many` with the same text: `plural()` stays as it is and picks a
     * form for every language.
     */
    const ZH = {
      'title': '指引使用统计',
      'subtitle': '本插件在本机记录的计数器，只读。',
      'refresh': '刷新',
      'loading': '正在读取计数器...',
      'updated': '更新于 {time}',
      'period.short': '{days} 天',
      'kpi.calls': '总调用次数',
      'kpi.hitRate': '命中率',
      'hitRate.raw': '报告按全部调用计算：{value}',
      'kpi.period': '统计周期',
      'kpi.periodValue': '最近 {days} 天',
      'kpi.corpus': '指引数量',
      'stats.legacyScan': '遗留代码扫描',
      'stats.findings': '发现问题数',
      'tool.legacyScan': '遗留代码扫描工具',
      'section.series': '每日调用',
      'series.bar': '{day}：{calls}',
      'section.breakdown': '按工具和结果统计',
      'breakdown.byTool': '按工具',
      'breakdown.byOutcome': '按结果',
      'breakdown.empty': '暂无可统计的数据。',
      'section.scanner': '扫描器发现了什么',
      'scanner.none': '还没有运行过扫描。',
      'scanner.last': '最近一次扫描：{when}',
      'scanner.rules': '命中的规则',
      'scanner.guides': '需要打开的指引',
      'scanner.scan': '扫描工作区',
      'scanner.scanning': '正在扫描工作区...',
      'scanner.failed': '扫描未能运行：{message}',
      'scan.summary': '已扫描 {files}，{findings}',
      'scan.clean': '没有规则命中。',
      'scan.truncated': '已截断：扫描触到上限，所以这份清单不完整。',
      'row.title': '遗留代码扫描',
      'row.preparing': '正在准备扫描...',
      'row.running': '正在扫描...',
      'row.stopped': '扫描已停止',
      'row.failed': '扫描失败',
      'row.paths': '路径：{paths}',
      'row.more': '另有 {count} 条',
      'row.rule': '规则',
      'row.confidence': '置信度',
      'row.location': '位置',
      'row.guide': '指引',
      'section.queries': '热门查询',
      'section.queries.empty': '暂无可排序的查询。',
      'section.coverage': '分类覆盖率',
      'section.misses': '没有结果的查询',
      'section.misses.empty': '没有查询返回空结果。',
      'section.dead': '未被读过的指引',
      'dead.summary': '{total} 篇指引中有 {count} 篇从未被检索',
      'dead.none': '每篇指引都至少被检索过一次。',
      'coverage.value': '{retrieved} / {total}',
      'call.one': '{count} 次调用',
      'call.few': '{count} 次调用',
      'call.many': '{count} 次调用',
      'hit.one': '{count} 次命中',
      'hit.few': '{count} 次命中',
      'hit.many': '{count} 次命中',
      'miss.one': '{count} 次未命中',
      'miss.few': '{count} 次未命中',
      'miss.many': '{count} 次未命中',
      'file.one': '{count} 个文件',
      'file.few': '{count} 个文件',
      'file.many': '{count} 个文件',
      'finding.one': '{count} 条发现',
      'finding.few': '{count} 条发现',
      'finding.many': '{count} 条发现',
      'empty.title': '最近 {days} 天没有调用',
      'empty.body': '使用 web_guidance_search 获取指引，然后刷新本面板。/guidance-stats 会以文本形式输出同一份报告。',
      'error.title': '使用计数器不可用',
      'error.bridge': '面板桥接不可用',
      'error.bridgeHint': '当前页面无法访问主机命令桥接。/guidance-stats --json 会输出同一份报告。',
      'error.session': '没有可运行 /guidance-stats 的会话',
      'error.sessionHint': '打开或开始一个对话，然后点击刷新。',
      'error.hint': '/guidance-stats 会在终端输出同一份报告。',
    }

    //#region helpers

    /** A finite number, or 0: the report is JSON, so a missing field must read as zero. */
    function asCount(value) {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number : 0
    }

    /** A string, or ''. */
    function asText(value) {
      return typeof value === 'string' ? value : ''
    }

    /**
     * The first finite number among the candidates, or 0. An object counts as its own `total`.
     *
     * The fourth tool's counter is read this way on purpose: the 0.5.0 report carries it as
     * `tools['legacy-scan']`, the snapshot carries the same number as `totals.byTool['legacy-scan']`,
     * and a report built from a 0.4.x state file carries neither. Missing must read as 0 — a panel
     * that printed `NaN` or threw would be worse than one that shows nothing yet.
     *
     * @param {...unknown} candidates
     * @returns {number}
     */
    function firstCount(...candidates) {
      for (const candidate of candidates) {
        const value = candidate !== null && typeof candidate === 'object' ? candidate.total : candidate
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return 0
    }

    /** The plain objects of an array value, or [] when it is not an array. */
    function asRows(value) {
      if (!Array.isArray(value)) return []
      return value.filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
    }

    /**
     * The command line for one window.
     *
     * `--days` belongs to the command, not to the panel: the panel only picks the number, so the
     * text report and the panel keep reading one implementation of the counters.
     *
     * @param {number} days
     * @returns {string}
     */
    function reportLine(days) {
      return `${REPORT_LINE} --days ${asCount(days)}`
    }

    /**
     * One `id -> count` map from the report as a ranked list, biggest first.
     *
     * Ties fall back to the id, compared without a locale, so two renders of one report always list
     * the rows in the same order.
     *
     * @param {unknown} map
     * @returns {Array<{ name: string, calls: number }>}
     */
    function rankedEntries(map) {
      if (map === null || typeof map !== 'object') return []
      const rows = []
      for (const [name, count] of Object.entries(map)) {
        if (name === '') continue
        rows.push({ name, calls: asCount(count) })
      }
      rows.sort((left, right) => {
        if (right.calls !== left.calls) return right.calls - left.calls
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      })
      return rows
    }

    /**
     * A bar height in pixels: the busiest day fills the strip, an idle day keeps a hairline.
     *
     * @param {number} calls
     * @param {number} peak the largest count in the series.
     * @returns {string}
     */
    function barHeight(calls, peak) {
      if (calls <= 0 || peak <= 0) return '2px'
      return `${Math.max(4, Math.round((calls / peak) * 24))}px`
    }

    /** A 0..1 ratio as a whole percentage, matching the text report's format. */
    function percent(ratio) {
      const value = Math.min(Math.max(asCount(ratio), 0), 1)
      return `${Math.round(value * 100)}%`
    }

    /** A bar width in percent, clamped so a corrupt count cannot break the layout. */
    function barWidth(retrieved, total) {
      if (total <= 0) return '0%'
      const value = Math.min(Math.max(retrieved / total, 0), 1)
      return `${Math.round(value * 100)}%`
    }

    /** The `YYYY-MM-DD` date part of an ISO timestamp, or '' when it is not one. */
    function dayOf(value) {
      const text = asText(value)
      const day = text.slice(0, 10)
      return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : text
    }

    /** A query on one line: whitespace folded, length capped like the text report does. */
    function queryText(value) {
      const query = asText(value).replace(/\s+/g, ' ').trim()
      if (query === '') return '(empty query)'
      return query.length <= 120 ? query : `${query.slice(0, 117)}...`
    }

    /** The first physical line of a text: all a collapsed failing row has room for. */
    function firstLine(text) {
      const newline = text.indexOf('\n')
      return newline === -1 ? text : text.slice(0, newline)
    }

    /** A localized count with the language's plural form. */
    function plural(t, base, count) {
      const n = Math.abs(asCount(count))
      const rest100 = n % 100
      const rest10 = n % 10
      let form = 'many'
      if (rest100 < 11 || rest100 > 14) {
        if (rest10 === 1) form = 'one'
        else if (rest10 >= 2 && rest10 <= 4) form = 'few'
      }
      return t(`${base}.${form}`, { count: n })
    }

    /** A tagged error: `code` decides which error state the panel renders. */
    function panelError(code, message) {
      const error = new Error(message)
      error.code = code
      return error
    }

    /** A thrown value as a message. */
    function messageOf(error) {
      return error instanceof Error && error.message !== '' ? error.message : String(error)
    }

    //#endregion

    //#region report reading

    /**
     * The first balanced `{...}` block of a text, so a report wrapped in a sentence still parses.
     * Quotes and escapes are honoured, because query text can contain braces.
     *
     * @param {string} text
     * @returns {string|undefined}
     */
    function firstJsonBlock(text) {
      const start = text.indexOf('{')
      if (start < 0) return undefined
      let depth = 0
      let quoted = false
      let escaped = false
      for (let index = start; index < text.length; index += 1) {
        const character = text[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') quoted = false
          continue
        }
        if (character === '"') {
          quoted = true
          continue
        }
        if (character === '{') depth += 1
        else if (character === '}') {
          depth -= 1
          if (depth === 0) return text.slice(start, index + 1)
        }
      }
      return undefined
    }

    /**
     * The `{ ruleId | guideId, count }` rows of a report as a ranked list, biggest first, ties by id.
     *
     * The report ranks these too; ranking again keeps the panel's order its own promise and drops a
     * row that carries no usable id instead of rendering an empty name.
     *
     * @param {Array<Record<string, unknown>>} rows
     * @param {'ruleId' | 'guideId'} key
     * @returns {Array<{ name: string, calls: number }>}
     */
    function rankedIds(rows, key) {
      const out = []
      for (const row of rows) {
        const name = asText(row[key])
        if (name === '') continue
        out.push({ name, calls: asCount(row.count) })
      }
      out.sort((left, right) => {
        if (right.calls !== left.calls) return right.calls - left.calls
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      })
      return out
    }

    /**
     * The stored last scan, or null. A value without a usable date reads as null: the section then
     * says nothing has run rather than printing an empty date.
     *
     * @param {unknown} value
     * @returns {{ at: string, files: number, findings: number, rules: string[] } | null}
     */
    function readLastScan(value) {
      if (value === null || typeof value !== 'object') return null
      const at = dayOf(value.at)
      if (at === '') return null
      return {
        at,
        files: asCount(value.files),
        findings: asCount(value.findings),
        rules: Array.isArray(value.rules) ? value.rules.filter((id) => typeof id === 'string' && id !== '') : [],
      }
    }

    /**
     * Validate one `/guidance-stats --json` report and normalize it for rendering. The panel never
     * renders a partially parsed report: a missing or mistyped field raises instead.
     *
     * @param {unknown} payload the parsed JSON.
     * @returns {object} the report the panel renders.
     */
    function readReport(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw panelError('call', 'the report is not a JSON object')
      }
      const totals = payload.totals
      if (totals === null || typeof totals !== 'object') {
        throw panelError('call', 'the report has no totals')
      }
      if (typeof totals.calls !== 'number' || typeof totals.hitRate !== 'number') {
        throw panelError('call', 'the report totals are incomplete')
      }
      if (!Array.isArray(payload.topQueries) || !Array.isArray(payload.misses) || !Array.isArray(payload.coverage)) {
        throw panelError('call', 'the report lists are incomplete')
      }
      const corpus = payload.corpus !== null && typeof payload.corpus === 'object' ? payload.corpus : {}
      const dead = payload.deadGuides !== null && typeof payload.deadGuides === 'object' ? payload.deadGuides : {}
      const tools = payload.tools !== null && typeof payload.tools === 'object' ? payload.tools : {}
      const byTool = totals.byTool !== null && typeof totals.byTool === 'object' ? totals.byTool : {}
      const byOutcome = totals.byOutcome !== null && typeof totals.byOutcome === 'object' ? totals.byOutcome : {}
      const hitRate = asCount(totals.hitRate)
      // `hitRate` divides hits by every call, `list`, `findings`, `clean` and `error` included, so it
      // always understates the rate. The outcome counters know which calls were attempts at all.
      const attempts = asCount(byOutcome.hit) + asCount(byOutcome.miss) + asCount(byOutcome['unknown-id'])
      const deadSample = Array.isArray(dead.sample) ? dead.sample : []

      return {
        periodDays: asCount(payload.periodDays),
        corpus: { total: asCount(corpus.total), version: asText(corpus.version), snapshotDate: asText(corpus.snapshotDate) },
        calls: asCount(totals.calls),
        hitRate,
        hitRateHonest: attempts > 0 ? asCount(byOutcome.hit) / attempts : hitRate,
        topQueries: asRows(payload.topQueries).map((row) => ({
          query: queryText(row.query),
          calls: asCount(row.calls),
          hits: asCount(row.hits),
          misses: asCount(row.misses),
          lastAt: dayOf(row.lastAt),
        })),
        misses: asRows(payload.misses).map((row) => ({
          query: queryText(row.query),
          calls: asCount(row.calls),
          lastAt: dayOf(row.lastAt),
        })),
        coverage: asRows(payload.coverage).map((row) => ({
          category: asText(row.category),
          retrieved: asCount(row.retrieved),
          total: asCount(row.total),
        })),
        series: asRows(payload.series).map((row) => ({ day: dayOf(row.day), calls: asCount(row.calls) })),
        byTool: rankedEntries(byTool),
        byOutcome: rankedEntries(byOutcome),
        deadGuides: {
          total: asCount(dead.total),
          sample: deadSample.filter((id) => typeof id === 'string' && id !== '').slice(0, MAX_DEAD_ROWS),
        },
        legacyScan: firstCount(tools['legacy-scan'], byTool['legacy-scan']),
        findings: firstCount(payload.findings, totals.findings),
        topRules: rankedIds(asRows(payload.topRules), 'ruleId').slice(0, MAX_SCAN_RULES),
        topScanGuides: rankedIds(asRows(payload.topScanGuides), 'guideId').slice(0, MAX_SCAN_RULES),
        lastScan: readLastScan(payload.lastScan),
      }
    }

    /**
     * One command envelope's result, with the failures every command shares.
     *
     * `commands.execute` answers `{ ok, value: { result: { kind, text } } }`, and `value` is absent
     * when the line did not resolve to a command at all.
     *
     * @param {unknown} envelope
     * @param {string} line the command line the envelope should be answering.
     * @returns {{ kind?: unknown, text?: unknown }} the command's own result.
     */
    function commandOutcome(envelope, line) {
      if (envelope === null || typeof envelope !== 'object') {
        throw panelError('call', 'the host returned no result')
      }
      if (envelope.ok !== true) {
        const failure = envelope.error !== null && typeof envelope.error === 'object' ? envelope.error : {}
        throw panelError('call', `${asText(failure.code) || 'error'}: ${asText(failure.message) || 'the host rejected the call'}`)
      }
      const value = envelope.value
      if (value === null || typeof value !== 'object') {
        throw panelError('call', `${line} is not registered on this host (no result for ${line})`)
      }
      const outcome = value.result
      if (outcome === null || typeof outcome !== 'object') {
        throw panelError('call', 'the command returned no outcome')
      }
      return outcome
    }

    /**
     * Turn one Remote result envelope into a report.
     *
     * The report itself is the command's text.
     *
     * @param {unknown} envelope
     * @returns {object} the validated report.
     */
    function readEnvelope(envelope) {
      const outcome = commandOutcome(envelope, REPORT_LINE)
      const text = asText(outcome.text)
      if (outcome.kind === 'error') throw panelError('call', text === '' ? 'the command reported an error' : text)
      if (outcome.kind !== 'success' || text === '') throw panelError('call', 'the command returned no report')
      const block = firstJsonBlock(text)
      if (block === undefined) throw panelError('call', 'the report carries no JSON object')
      let payload
      try {
        payload = JSON.parse(block)
      } catch {
        throw panelError('call', 'the report is not valid JSON')
      }
      return readReport(payload)
    }

    //#endregion

    //#region scan reading

    /**
     * The text of one settled tool result block.
     *
     * This mirrors ui-tool's own `resultText` contract: a settled block carries `kind`, a `content`
     * array of items, and an optional `error`. Reading the same fields in the same order means this
     * row shows what the generic card would have shown, for a result it does not understand.
     *
     * @param {unknown} block the `result` block of a `tool.call.toolview` payload.
     * @returns {string|null}
     */
    function resultText(block) {
      if (block === null || typeof block !== 'object' || !('kind' in block)) return null
      const content = Array.isArray(block.content) ? block.content : []
      const parts = []
      for (const item of content) {
        if (item === null || typeof item !== 'object') continue
        parts.push(item.type === 'text' ? asText(item.text) : JSON.stringify(item, null, 2))
      }
      const failure = block.error
      if (parts.length === 0 && failure !== null && typeof failure === 'object') {
        parts.push(`${asText(failure.name)}: ${asText(failure.code)}`)
      }
      const text = parts.join('\n')
      return text === '' ? null : text
    }

    /**
     * The paths one scan call was given. `argsRaw` may still be streaming while the call runs, so a
     * partial JSON body reads as "no paths yet" instead of throwing inside a chat row.
     *
     * @param {unknown} block a `start` block of the tool view.
     * @returns {string[]}
     */
    function scanPaths(block) {
      const block_ = block !== null && typeof block === 'object' ? block : {}
      const raw = asText(block_.argsRaw)
      if (raw === '') return []
      try {
        const parsed = JSON.parse(raw)
        const paths = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.paths) ? parsed.paths : []
        return paths.map((path) => asText(path)).filter((path) => path !== '')
      } catch {
        return []
      }
    }

    /**
     * One finding of a scan result, as the chat row renders it.
     *
     * @param {Record<string, unknown>} row
     * @returns {{ ruleId: string, confidence: string, path: string, line: number, column: number, guideId: string }}
     */
    function readFinding(row) {
      return {
        ruleId: asText(row.ruleId),
        confidence: asText(row.confidence),
        path: asText(row.path),
        line: asCount(row.line),
        column: asCount(row.column),
        guideId: asText(row.guideId),
      }
    }

    /**
     * Findings aggregated per rule id, biggest first: one rule can fire many times in one scan.
     *
     * @param {Array<{ ruleId: string }>} findings
     * @returns {Array<{ name: string, calls: number }>}
     */
    function ruleCounts(findings) {
      const counts = new Map()
      for (const finding of findings) {
        if (finding.ruleId === '') continue
        counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1)
      }
      const rows = []
      for (const [name, calls] of counts) rows.push({ name, calls })
      rows.sort((left, right) => {
        if (right.calls !== left.calls) return right.calls - left.calls
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      })
      return rows
    }

    /**
     * One `/guidance-scan --format json` value as the panel and the chat row render it.
     *
     * Counts, ids, and the findings themselves: the panel renders only the counts, and the chat row
     * renders the findings because there they belong to a call the session already made.
     *
     * @param {unknown} payload
     * @returns {{ files: number, bytes: number, findings: Array<object>, guides: Array<{ id: string, findings: number }>, truncated: boolean, rules: Array<{ name: string, calls: number }> }}
     */
    function readScanValue(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw panelError('scan', 'the scan result is not a JSON object')
      }
      const scanned = payload.scanned !== null && typeof payload.scanned === 'object' ? payload.scanned : {}
      const findings = asRows(payload.findings)
        .map(readFinding)
        .filter((finding) => finding.ruleId !== '')
      const guides = []
      for (const row of asRows(payload.guides)) {
        const id = asText(row.id)
        if (id !== '') guides.push({ id, findings: asCount(row.findings) })
      }
      return {
        files: asCount(scanned.files),
        bytes: asCount(scanned.bytes),
        findings,
        guides,
        truncated: payload.truncated === true,
        rules: ruleCounts(findings).slice(0, MAX_SCAN_RULES),
      }
    }

    /**
     * A summary-format scan printed as text, read back into rows.
     *
     * The panel asks for JSON, but the chat row renders whatever the model actually called, and the
     * summary format prints one `- path:line:column rule (confidence) message` line per finding plus
     * the aggregate guide line. Reading those lines keeps the row a table; a line that does not match
     * is simply not a finding.
     *
     * @param {string} text
     * @returns {object} the same shape `readScanValue` returns.
     */
    function readScanText(text) {
      const findings = []
      const guides = []
      let truncated = false
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        const match = /^-\s+(.+?):(\d+):(\d+)\s+(\S+)\s+\(([^)]+)\)\s+(.*)$/.exec(trimmed)
        if (match !== null) {
          findings.push({
            ruleId: match[4],
            confidence: match[5],
            path: match[1],
            line: asCount(match[2]),
            column: asCount(match[3]),
            guideId: '',
          })
          continue
        }
        if (trimmed.startsWith('Load with web_guidance_retrieve:')) {
          const list = trimmed.slice('Load with web_guidance_retrieve:'.length).replace(/\.\s*$/, '')
          for (const item of list.split(/,\s*|\s+and\s+/)) {
            const guideMatch = /^([a-z0-9][a-z0-9-]*)(?:\s*\((\d+)\))?$/i.exec(item.trim())
            if (guideMatch === null) continue
            guides.push({ id: guideMatch[1], findings: guideMatch[2] === undefined ? 0 : asCount(guideMatch[2]) })
          }
          continue
        }
        if (trimmed.startsWith('Truncated:')) truncated = true
      }
      const scannedMatch = /Scanned (\d+) file\(s\)/.exec(text)
      return {
        files: scannedMatch === null ? 0 : asCount(scannedMatch[1]),
        bytes: 0,
        findings,
        guides,
        truncated,
        rules: ruleCounts(findings).slice(0, MAX_SCAN_RULES),
      }
    }

    /**
     * One `/guidance-scan` envelope as a scan value.
     *
     * A refusal arrives as `kind: 'error'` with its text ("Error: path-absolute — …"), so it becomes
     * the panel's error state instead of an exception: the button reports it and the panel stays usable.
     *
     * @param {unknown} envelope
     * @returns {object} the normalized scan value.
     */
    function readScanEnvelope(envelope) {
      const outcome = commandOutcome(envelope, SCAN_LINE)
      const text = asText(outcome.text)
      if (outcome.kind === 'error') throw panelError('scan', text === '' ? 'the scan reported an error' : text)
      if (outcome.kind !== 'success' || text === '') throw panelError('scan', 'the scan returned no result')
      const block = firstJsonBlock(text)
      if (block !== undefined) {
        let payload
        try {
          payload = JSON.parse(block)
        } catch {
          payload = undefined
        }
        if (payload !== undefined) return readScanValue(payload)
      }
      return readScanText(text)
    }

    //#endregion

    //#region session selection

    /**
     * Pick the session whose agent runs the command. A `main` panel is root-scoped, so it has no
     * session of its own: prefer the session the main view is showing (the convention another root
     * panel uses), then the most recently active top-level session.
     *
     * @param {{ ids?: string[], byId?: object }|undefined} snapshot the sessions snapshot.
     * @returns {string|undefined}
     */
    function selectSessionId(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return undefined
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids : []
      const byId = snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
      let candidate
      let candidateAt = -1
      for (const id of ids) {
        const row = byId[id]
        if (row === null || typeof row !== 'object') continue
        const retained = row.retainedBy !== null && typeof row.retainedBy === 'object' ? row.retainedBy : {}
        if (asCount(retained.mainView) > 0) return id
        if (row.origin === 'subagent' || typeof row.parentId === 'string') continue
        const at = asCount(row.updatedAt)
        if (at > candidateAt) {
          candidate = id
          candidateAt = at
        }
      }
      if (candidate !== undefined) return candidate
      return ids.length > 0 && typeof ids[0] === 'string' ? ids[0] : undefined
    }

    //#endregion

    //#region styles

    /** Every style value comes from a theme alias token; the icon artwork is the only exception. */
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        padding: '20px 24px 28px',
        overflowY: 'auto',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      header: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
      headerText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
      title: { fontSize: '16px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.4 },
      updated: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
      // One small button style for both controls — Refresh in the header and the scan button in the
      // scanner section — so the two never drift apart.
      action: {
        flex: '0 0 auto',
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '6px 12px',
        fontSize: '12px',
        lineHeight: 1.4,
        cursor: 'pointer',
      },
      actionBusy: { opacity: 0.6, cursor: 'default' },
      // The window switch sits between the title block and refresh; `flexWrap` on the header lets
      // both controls drop under the title instead of squeezing it on a narrow panel.
      periods: {
        flex: '0 0 auto',
        display: 'flex',
        gap: '2px',
        padding: '2px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-fill-l1)',
      },
      periodButton: {
        appearance: 'none',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '4px 8px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.4,
        cursor: 'pointer',
      },
      periodActive: {
        appearance: 'none',
        border: 'none',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '4px 8px',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1.4,
        cursor: 'pointer',
      },
      // 120px is the narrow-panel budget: a ~320px panel spends 24px of padding on each side, and
      // `2 × 120 + 8` fits even after the shell takes some of it, so the six tiles form a 2-column
      // block instead of one tall column. On a wide panel `auto-fit` stretches them into one row.
      kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' },
      kpi: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      kpiLabel: {
        fontSize: '11px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      kpiValue: { fontSize: '20px', fontWeight: 600, lineHeight: 1.2 },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '10px',
        padding: '5px 0',
        borderTop: '1px solid var(--dsw-alias-separator-primary)',
      },
      rowFirst: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '5px 0' },
      rowText: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '13px',
      },
      rowMeta: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      rowHits: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-state-success-primary)', whiteSpace: 'nowrap' },
      rowMisses: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'nowrap' },
      coverageRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' },
      coverageName: { flex: '0 0 34%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' },
      coverageTrack: {
        flex: '1 1 auto',
        height: '6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-fill-l2)',
        overflow: 'hidden',
      },
      coverageFill: { height: '100%', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)' },
      coverageValue: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      // One hairline per day, bottom-aligned in a fixed 28px strip. Bars grow into the free space but
      // never past 16px: seven days across a wide panel would otherwise be seven fat columns.
      spark: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '28px' },
      sparkBar: { flex: '1 1 0', minWidth: '2px', maxWidth: '16px', borderRadius: '2px', background: 'var(--dsw-alias-brand-primary)' },
      sparkBarZero: { flex: '1 1 0', minWidth: '2px', maxWidth: '16px', borderRadius: '2px', background: 'var(--dsw-alias-border-l2)' },
      split: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' },
      splitColumn: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      splitHead: { fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary)' },
      splitRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', minWidth: 0 },
      splitName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' },
      splitCount: { flex: '0 0 auto', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      // Twenty ids wrap into a few lines instead of adding twenty rows of scroll to the panel.
      deadList: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      // The scanner section keeps a rule id beside its count: these are pairs, not a two-column
      // table, so the number hugs the id instead of jumping to the far edge of a wide panel.
      scanHeading: {
        fontSize: '11px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
        marginTop: '2px',
      },
      scanLine: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        padding: '4px 0',
        borderTop: '1px solid var(--dsw-alias-separator-primary)',
        minWidth: 0,
      },
      scanLineFirst: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 0', minWidth: 0 },
      scanName: { flex: '0 0 auto', fontSize: '12px', fontWeight: 500 },
      scanCount: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      scanActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '2px' },
      deadRow: {
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '2px 6px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
      },
      note: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5 },
      state: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      stateTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-state-warn-primary)' },
      stateBody: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
    }

    /**
     * The chat row's own styles. A tool row sits inside the conversation, not in the panel, so it
     * keeps the generic card's quiet surface (a hairline border, no shadow) and the smaller type the
     * transcript uses, and it never reaches for panel-only spacing.
     */
    const T = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minWidth: 0,
        padding: '8px 10px',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      title: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      meta: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 },
      chip: {
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '1px 6px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
      },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '10px',
        padding: '3px 0',
        borderTop: '1px solid var(--dsw-alias-separator-primary)',
        minWidth: 0,
      },
      rowFirst: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '3px 0', minWidth: 0 },
      rule: { flex: '0 0 auto', fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      place: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      confidence: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      guide: {
        flex: '0 0 auto',
        maxWidth: '40%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      note: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5 },
      failed: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.5 },
    }

    //#endregion

    //#region components

    /** The rail glyph. Drawn here because a client half may not import host icon packages. */
    function GuidanceIcon(props) {
      const size = asCount(props?.size) || 18
      const active = props?.active === true
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          role: 'img',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('path', {
          d: 'M4 5.5h6.5a2 2 0 0 1 2 2V19a2.2 2.2 0 0 0-1.8-1H4z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M20 5.5h-6.5a2 2 0 0 0-2 2V19a2.2 2.2 0 0 1 1.8-1H20z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M7 9.5h2.6M7 12.5h2.6M14.4 9.5H17M14.4 12.5H17',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * One KPI cell, with an optional hover hint naming the tool behind the number.
     *
     * @param {Function} t bound translator.
     * @param {string} label already-localized tile label.
     * @param {string} value already-formatted tile value.
     * @param {string} [hint] already-localized tooltip.
     */
    function kpi(t, label, value, hint) {
      return h(
        'div',
        { style: S.kpi, key: label, title: hint },
        h('div', { style: S.kpiLabel }, label),
        h('div', { style: S.kpiValue }, value),
      )
    }

    /** A card holding one titled section. */
    function section(title, children) {
      return h(
        'section',
        { style: S.card, key: title },
        h('div', { style: S.cardTitle }, title),
        children,
      )
    }

    /**
     * The KPI row: total calls, hit rate, period, corpus size, plus the fourth tool's call count and
     * the findings it reported. The last two tiles always render: a report from a 0.4.x state file
     * has no such counter, and 0 is the honest number to show for it.
     *
     * The hit-rate tile shows the rate over the calls that could hit; the report's own rate, which
     * also counts `list` and `error`, sits in the tooltip so the difference stays visible.
     */
    function renderKpis(t, report) {
      const cells = [
        kpi(t, t('kpi.calls'), String(report.calls)),
        kpi(t, t('kpi.hitRate'), percent(report.hitRateHonest), t('hitRate.raw', { value: percent(report.hitRate) })),
        kpi(t, t('kpi.period'), t('kpi.periodValue', { days: report.periodDays })),
      ]
      if (report.corpus.total > 0) cells.push(kpi(t, t('kpi.corpus'), String(report.corpus.total)))
      cells.push(kpi(t, t('stats.legacyScan'), String(report.legacyScan), t('tool.legacyScan')))
      cells.push(kpi(t, t('stats.findings'), String(report.findings)))
      return h('div', { style: S.kpis }, cells)
    }

    /**
     * One bar per day of the window, scaled to the busiest day. Pure divs: a chart library would be
     * the first dependency in a file that has none, and an SVG would paint outside the theme tokens.
     */
    function renderSeries(t, report) {
      const rows = report.series
      if (rows.length === 0) return null
      let peak = 0
      for (const row of rows) if (row.calls > peak) peak = row.calls
      return section(
        t('section.series'),
        h(
          'div',
          { style: S.spark },
          rows.map((row, index) =>
            h('div', {
              key: `day-${index}`,
              style: { ...(row.calls > 0 ? S.sparkBar : S.sparkBarZero), height: barHeight(row.calls, peak) },
              title: t('series.bar', { day: row.day, calls: plural(t, 'call', row.calls) }),
            }),
          ),
        ),
      )
    }

    /** One ranked column of `id — count` rows. */
    function breakdownColumn(t, heading, rows) {
      return h(
        'div',
        { style: S.splitColumn, key: heading },
        h('div', { style: S.splitHead }, heading),
        rows.length === 0
          ? h('div', { style: S.note }, t('breakdown.empty'))
          : rows.map((row, index) =>
              h(
                'div',
                { style: S.splitRow, key: `${heading}-${index}` },
                h('span', { style: S.splitName, title: row.name }, row.name),
                h('span', { style: S.splitCount }, String(row.calls)),
              ),
            ),
      )
    }

    /**
     * The two breakdowns `/guidance-stats` prints inline as "Calls by tool" and "Calls by outcome".
     *
     * The rows are the report's own ids, verbatim: they are the vocabulary the text command uses, so
     * a reader comparing the two sees the same words. Only the headings are translated.
     */
    function renderBreakdown(t, report) {
      if (report.byTool.length === 0 && report.byOutcome.length === 0) return null
      return section(
        t('section.breakdown'),
        h('div', { style: S.split }, [
          breakdownColumn(t, t('breakdown.byTool'), report.byTool),
          breakdownColumn(t, t('breakdown.byOutcome'), report.byOutcome),
        ]),
      )
    }

    /** One `ls-13  4` pair: a rule id and how many findings it raised. */
    function scanRuleLine(rule, first) {
      return h(
        'div',
        { style: first ? S.scanLineFirst : S.scanLine, key: `rule-${rule.name}` },
        h('span', { style: S.scanName, title: rule.name }, rule.name),
        h('span', { style: S.scanCount }, String(rule.calls)),
      )
    }

    /**
     * What the scanner catches, plus the button that runs one.
     *
     * The section reads the counters the report carries — the last scan, the rules that matched, the
     * guides to load — and answers its own button with the result of *that* scan. Counters are not
     * evidence: this section shows ids and numbers, never a path and never a snippet. The chat row
     * renders those, because there they belong to a call the session already made.
     *
     * @param {Function} t bound translator.
     * @param {object} report the normalized report.
     * @param {{ status: string, value?: object, message?: string }} scan the panel's own scan state.
     * @param {boolean} busy whether the report is still loading.
     * @param {Function} onScan starts a scan.
     */
    function renderScanner(t, report, scan, busy, onScan) {
      const last = report.lastScan
      const children = [
        h(
          'div',
          { style: S.note, key: 'scan-summary' },
          last === null
            ? t('scanner.none')
            : [
                t('scanner.last', { when: last.at }),
                plural(t, 'file', last.files),
                plural(t, 'finding', last.findings),
              ].join(' · '),
        ),
      ]
      if (report.topRules.length > 0) {
        children.push(h('div', { style: S.scanHeading, key: 'scan-rules-head' }, t('scanner.rules')))
        for (const [index, rule] of report.topRules.entries()) children.push(scanRuleLine(rule, index === 0))
      }
      if (report.topScanGuides.length > 0) {
        children.push(h('div', { style: S.scanHeading, key: 'scan-guides-head' }, t('scanner.guides')))
        children.push(
          h(
            'div',
            { style: S.deadList, key: 'scan-guides' },
            report.topScanGuides.map((guide) =>
              h('span', { style: S.deadRow, key: `guide-${guide.name}`, title: guide.name }, `${guide.name} (${guide.calls})`),
            ),
          ),
        )
      }
      const running = scan.status === 'running'
      const blocked = running || busy
      children.push(
        h(
          'div',
          { style: S.scanActions, key: 'scan-actions' },
          h(
            'button',
            {
              type: 'button',
              style: blocked ? { ...S.action, ...S.actionBusy } : S.action,
              disabled: blocked,
              onClick: onScan,
            },
            running ? t('scanner.scanning') : t('scanner.scan'),
          ),
        ),
      )
      if (scan.status === 'ready' && scan.value !== undefined) {
        const value = scan.value
        children.push(
          h(
            'div',
            { style: S.note, key: 'scan-result' },
            t('scan.summary', {
              files: plural(t, 'file', value.files),
              findings: plural(t, 'finding', value.findings.length),
            }),
          ),
        )
        if (value.truncated) children.push(h('div', { style: S.stateBody, key: 'scan-truncated' }, t('scan.truncated')))
        if (value.rules.length > 0) {
          for (const [index, rule] of value.rules.entries()) children.push(scanRuleLine(rule, index === 0))
        } else {
          children.push(h('div', { style: S.note, key: 'scan-clean' }, t('scan.clean')))
        }
      } else if (scan.status === 'error') {
        children.push(
          h('div', { style: S.stateBody, key: 'scan-error' }, t('scanner.failed', { message: asText(scan.message) })),
        )
      }
      return section(t('section.scanner'), children)
    }

    /** The ranked queries with hit and miss counts. */
    function renderQueries(t, report) {
      const rows = report.topQueries
      if (rows.length === 0) return section(t('section.queries'), h('div', { style: S.note }, t('section.queries.empty')))
      return section(
        t('section.queries'),
        rows.map((row, index) =>
          h(
            'div',
            { style: index === 0 ? S.rowFirst : S.row, key: `query-${index}` },
            h('span', { style: S.rowText, title: row.query }, row.query),
            h('span', { style: S.rowMeta }, plural(t, 'call', row.calls)),
            row.hits > 0 ? h('span', { style: S.rowHits }, plural(t, 'hit', row.hits)) : null,
            row.misses > 0 ? h('span', { style: S.rowMisses }, plural(t, 'miss', row.misses)) : null,
          ),
        ),
      )
    }

    /** Every catalog category with a retrieved/total bar. */
    function renderCoverage(t, report) {
      const rows = report.coverage
      if (rows.length === 0) return null
      return section(
        t('section.coverage'),
        rows.map((row, index) =>
          h(
            'div',
            { style: S.coverageRow, key: `coverage-${index}` },
            h('span', { style: S.coverageName, title: row.category }, row.category),
            h('span', { style: S.coverageTrack }, h('span', { style: { ...S.coverageFill, width: barWidth(row.retrieved, row.total) } })),
            h('span', { style: S.coverageValue }, t('coverage.value', { retrieved: row.retrieved, total: row.total })),
          ),
        ),
      )
    }

    /** Queries that came back empty. */
    function renderMisses(t, report) {
      const rows = report.misses
      if (rows.length === 0) return section(t('section.misses'), h('div', { style: S.note }, t('section.misses.empty')))
      return section(
        t('section.misses'),
        rows.map((row, index) =>
          h(
            'div',
            { style: index === 0 ? S.rowFirst : S.row, key: `miss-${index}` },
            h('span', { style: S.rowText, title: row.query }, row.query),
            h('span', { style: S.rowMisses }, plural(t, 'miss', row.calls)),
            row.lastAt === '' ? null : h('span', { style: S.rowMeta }, row.lastAt),
          ),
        ),
      )
    }

    /**
     * The guides nobody ever retrieved: the count first, then the ids themselves, so the panel
     * answers "what do we never find" instead of only "how many".
     */
    function renderDead(t, report) {
      const dead = report.deadGuides
      const total = report.corpus.total
      const body =
        total === 0
          ? t('dead.none')
          : dead.total === 0
            ? t('dead.none')
            : t('dead.summary', { count: dead.total, total })
      const ids = dead.sample
      return section(t('section.dead'), [
        h('div', { style: S.note, key: 'dead-summary' }, body),
        ids.length === 0
          ? null
          : h(
              'div',
              { style: S.deadList, key: 'dead-ids' },
              ids.map((id, index) => h('span', { style: S.deadRow, key: `dead-${index}`, title: id }, id)),
            ),
      ])
    }

    /** The zero-calls state: the report parsed, it simply holds nothing yet. */
    function renderEmpty(t, report) {
      return h(
        'div',
        { style: S.state },
        h('div', { style: S.stateTitle }, t('empty.title', { days: report.periodDays })),
        h('div', { style: S.stateBody }, t('empty.body')),
      )
    }

    /** The error state. `code` picks the explanation; the message is the host's own text. */
    function renderError(t, state) {
      const title = state.code === 'bridge' ? t('error.bridge') : state.code === 'session' ? t('error.session') : t('error.title')
      const hint =
        state.code === 'bridge'
          ? t('error.bridgeHint')
          : state.code === 'session'
            ? t('error.sessionHint')
            : t('error.hint')
      return h(
        'div',
        { style: S.state },
        h('div', { style: S.stateTitle }, title),
        state.message === '' ? null : h('div', { style: S.stateBody }, state.message),
        h('div', { style: S.stateBody }, hint),
      )
    }

    /**
     * The chat row for one `web_guidance_legacy_scan` call.
     *
     * Registered into ui-tool's keyed `tool.call.toolview` slot under that wire name, so it renders
     * that tool alone and the generic card keeps every other call. The props are the documented
     * `ToolCallOwnerProps` — `phase` plus a stage-specific `block`, and `t` from the locale seat this
     * registration asks for. Nothing here guesses a field:
     *
     *  - `preparing` is a call whose arguments are still being written;
     *  - `start` carries `block.argsRaw`, the raw argument JSON, which may still be partial;
     *  - `result` carries a settled block — `kind`, `content`, `error`, `isError` — read the same way
     *    ui-tool's own `resultText` reads it.
     *
     * A scan the model asked for in summary format prints lines, not JSON; those lines are read back
     * into rows here, so the row stays a table either way. Nothing in this component throws: a shape
     * it does not understand degrades to the text the generic card would have shown.
     *
     * @param {object} props the keyed toolview payload.
     * @returns {object} the row.
     */
    function ScanToolRow(props) {
      const t = props.t
      const phase = props.phase
      const block = props.block !== null && typeof props.block === 'object' ? props.block : {}

      const head = (meta) =>
        h('div', { style: T.head }, h('span', { style: T.title }, t('row.title')), h('span', { style: T.meta }, meta))

      if (phase === 'preparing') return h('div', { style: T.card }, head(t('row.preparing')))

      if (phase === 'start') {
        const paths = scanPaths(block)
        return h(
          'div',
          { style: T.card },
          head(t('row.running')),
          paths.length === 0
            ? null
            : h(
                'div',
                { style: T.chips, title: t('row.paths', { paths: paths.join(', ') }) },
                paths.map((path, index) => h('span', { style: T.chip, key: `path-${index}`, title: path }, path)),
              ),
        )
      }

      const text = resultText(block)
      const failure = block.error !== null && typeof block.error === 'object' ? block.error : undefined
      const stopped = asText(failure?.code) === 'interrupted'
      const failed = stopped !== true && block.isError === true
      if (text === null) {
        return h('div', { style: T.card }, head(stopped ? t('row.stopped') : failed ? t('row.failed') : t('row.running')))
      }

      let value
      try {
        const jsonBlock = firstJsonBlock(text)
        if (jsonBlock !== undefined) {
          const payload = JSON.parse(jsonBlock)
          if (payload !== null && typeof payload === 'object' && Array.isArray(payload.findings)) {
            value = readScanValue(payload)
          }
        }
      } catch {
        value = undefined
      }
      if (value === undefined) value = readScanText(text)

      const body = []
      if (failed || stopped) {
        body.push(h('div', { style: T.failed, key: 'failure' }, stopped ? t('row.stopped') : firstLine(text)))
      }
      const shown = value.findings.slice(0, MAX_TOOL_ROWS)
      if (shown.length > 0) {
        body.push(
          h(
            'div',
            { style: T.rowFirst, key: 'columns' },
            h('span', { style: T.rule }, t('row.rule')),
            h('span', { style: T.place }, t('row.location')),
            h('span', { style: T.confidence }, t('row.confidence')),
            h('span', { style: T.guide }, t('row.guide')),
          ),
        )
        for (const [index, finding] of shown.entries()) {
          const place = finding.path === '' ? '' : `${finding.path}:${finding.line}`
          body.push(
            h(
              'div',
              { style: T.row, key: `finding-${index}`, title: place },
              h('span', { style: T.rule }, finding.ruleId),
              h('span', { style: T.place }, place),
              h('span', { style: T.confidence }, finding.confidence),
              finding.guideId === ''
                ? h('span', { style: T.guide }, '')
                : h('span', { style: T.guide, title: finding.guideId }, finding.guideId),
            ),
          )
        }
        const rest = value.findings.length - shown.length
        if (rest > 0) body.push(h('div', { style: T.note, key: 'more' }, t('row.more', { count: rest })))
      } else {
        body.push(h('div', { style: T.note, key: 'clean' }, t('scan.clean')))
      }
      if (value.truncated) body.push(h('div', { style: T.note, key: 'truncated' }, t('scan.truncated')))
      if (value.guides.length > 0) {
        body.push(
          h(
            'div',
            { style: T.chips, key: 'guides' },
            value.guides.map((guide, index) =>
              h(
                'span',
                { style: T.chip, key: `guide-${index}`, title: guide.id },
                guide.findings > 0 ? `${guide.id} (${guide.findings})` : guide.id,
              ),
            ),
          ),
        )
      }
      return h(
        'div',
        { style: T.card },
        head(
          t('scan.summary', {
            files: plural(t, 'file', value.files),
            findings: plural(t, 'finding', value.findings.length),
          }),
        ),
        body,
      )
    }

    /**
     * The panel. It is read-only apart from the scan button: the header picks the window, Refresh
     * re-runs the counters command, and the scan button asks the host to scan the workspace folder.
     * Every subscription it starts is component-local, so unmounting it releases them.
     */
    function GuidancePanel(props) {
      const t = props.t
      const bridge = props.bridge
      const sessionId = props.useSessions(selectSessionId)
      const [state, setState] = useState({ status: 'loading', report: undefined, code: '', message: '', at: 0 })
      const [days, setDays] = useState(PERIODS[0])
      const [scan, setScan] = useState({ status: 'idle', value: undefined, message: '' })
      const alive = useRef(true)
      // Every load takes a ticket; a response whose ticket is no longer current is dropped, so
      // switching the window mid-request shows the answer to the window the user ended up on.
      const ticket = useRef(0)
      const scanTicket = useRef(0)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(() => {
        if (bridge === undefined || typeof bridge.call !== 'function') {
          setState({ status: 'error', report: undefined, code: 'bridge', message: '', at: 0 })
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState({ status: 'error', report: undefined, code: 'session', message: '', at: 0 })
          return
        }
        const mine = ticket.current + 1
        ticket.current = mine
        setState((previous) => ({ ...previous, status: 'loading' }))
        let pending
        try {
          pending = Promise.resolve(bridge.call(sessionId, reportLine(days)))
        } catch (error) {
          pending = Promise.reject(error)
        }
        pending
          .then((envelope) => {
            if (!alive.current || ticket.current !== mine) return
            const report = readEnvelope(envelope)
            setState({ status: 'ready', report, code: '', message: '', at: Date.now() })
          })
          .catch((error) => {
            if (!alive.current || ticket.current !== mine) return
            const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'call'
            setState({ status: 'error', report: undefined, code, message: messageOf(error), at: 0 })
          })
      }, [bridge, sessionId, days])

      useEffect(() => {
        load()
      }, [load])

      /**
       * Run the scan the button offers.
       *
       * The command answers with the scan's own JSON, so the click is answered inline. The counters
       * are written from `tools/result` events, which a command does not raise, so this reload
       * refreshes the report and its timestamp rather than promising a new `lastScan` — a scan the
       * model runs is what moves those counters.
       */
      const runScan = useCallback(() => {
        if (bridge === undefined || typeof bridge.call !== 'function') {
          setScan({ status: 'error', value: undefined, message: t('error.bridge') })
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          setScan({ status: 'error', value: undefined, message: t('error.session') })
          return
        }
        const mine = scanTicket.current + 1
        scanTicket.current = mine
        setScan({ status: 'running', value: undefined, message: '' })
        let pending
        try {
          pending = Promise.resolve(bridge.call(sessionId, SCAN_LINE))
        } catch (error) {
          pending = Promise.reject(error)
        }
        pending
          .then((envelope) => {
            if (!alive.current || scanTicket.current !== mine) return
            setScan({ status: 'ready', value: readScanEnvelope(envelope), message: '' })
            load()
          })
          .catch((error) => {
            if (!alive.current || scanTicket.current !== mine) return
            setScan({ status: 'error', value: undefined, message: messageOf(error) })
          })
      }, [bridge, sessionId, load, t])

      const busy = state.status === 'loading'
      const header = h(
        'header',
        { style: S.header },
        h(
          'div',
          { style: S.headerText },
          h('div', { style: S.title }, t('title')),
          h('div', { style: S.subtitle }, t('subtitle')),
          state.at === 0 ? null : h('div', { style: S.updated }, t('updated', { time: new Date(state.at).toLocaleTimeString() })),
        ),
        h(
          'div',
          { style: S.periods, role: 'group', 'aria-label': t('kpi.period') },
          PERIODS.map((option) =>
            h(
              'button',
              {
                type: 'button',
                key: `period-${option}`,
                style: option === days ? S.periodActive : S.periodButton,
                'aria-pressed': option === days,
                title: t('kpi.periodValue', { days: option }),
                onClick: () => setDays(option),
              },
              t('period.short', { days: option }),
            ),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            style: busy ? { ...S.action, ...S.actionBusy } : S.action,
            disabled: busy,
            onClick: load,
          },
          busy ? t('loading') : t('refresh'),
        ),
      )

      const report = state.report
      let body
      if (state.status === 'error') body = renderError(t, state)
      else if (state.status === 'ready' && report !== undefined) {
        // The scanner section renders in the empty state too: its button is the only way to run a
        // scan from the panel, so hiding it behind "some call happened first" would hide the door.
        body =
          report.calls === 0
            ? h(
                React.Fragment,
                null,
                renderEmpty(t, report),
                renderScanner(t, report, scan, busy, runScan),
              )
            : h(
                React.Fragment,
                null,
                renderKpis(t, report),
                renderSeries(t, report),
                renderBreakdown(t, report),
                renderScanner(t, report, scan, busy, runScan),
                renderQueries(t, report),
                renderCoverage(t, report),
                renderMisses(t, report),
                renderDead(t, report),
              )
      } else body = h('div', { style: S.note }, t('loading'))

      return h('div', { style: S.root }, header, body)
    }

    //#endregion

    /**
     * Register the rail entry, the panel, and the dictionaries.
     *
     * @param {object} ctx the Client root context.
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en: EN, ru: RU, zh: ZH }), 'modern-web-guidance: client dictionaries')

      /**
       * The one bridge. `ctx.remote` is the typed Remote service; a page that does not mount it
       * leaves `commands` undefined, and the panel says so instead of inventing another transport.
       */
      const bridge = {
        call(sessionId, line) {
          let remote
          try {
            remote = ctx.remote !== undefined ? ctx.remote : typeof ctx.get === 'function' ? ctx.get('remote') : undefined
          } catch (error) {
            return Promise.reject(panelError('bridge', messageOf(error)))
          }
          const commands = remote === undefined || remote === null ? undefined : remote.commands
          if (commands === undefined || commands === null || typeof commands.execute !== 'function') {
            return Promise.reject(panelError('bridge', ''))
          }
          try {
            return Promise.resolve(commands.execute(sessionId, line, []))
          } catch (error) {
            return Promise.reject(panelError('call', messageOf(error)))
          }
        },
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('title'),
            locale: NS,
          },
          GuidanceIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ bridge }),
          },
          GuidancePanel,
        ),
      )

      // ui-tool dispatches every atomic call through this keyed slot by wire name. Nothing else
      // claims `web_guidance_legacy_scan`, so this entry adds one row and leaves the generic card on
      // every other tool; the slot is keyed, not replaced.
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: SCAN_TOOL_NAME,
            locale: NS,
          },
          ScanToolRow,
        ),
      )
    }

    return { inject: ['slots', 'locale', 'remote', 'remote.commands'], apply }
  },
})
