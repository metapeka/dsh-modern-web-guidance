/**
 * Client half of dsh-modern-web-guidance: the sidebar rail entry and the read-only
 * "Guidance Insights" panel.
 *
 * The browser module loader gives no relative imports, so this file is self-contained: React
 * arrives through `require`, host services and the React context through `ctx`, and every visible
 * string through the Client locale service. The panel changes nothing on its own — it asks the host
 * to run this plugin's own `/guidance-stats --json` command and renders the report that comes back,
 * so the slash command and the panel keep one implementation of the counters.
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

    /** English dictionary: the fallback locale, so it must stay complete. */
    const EN = {
      'title': 'Guidance Insights',
      'subtitle': 'Local counters recorded by this plugin. Read-only.',
      'refresh': 'Refresh',
      'loading': 'Reading the counters...',
      'updated': 'Updated {time}',
      'kpi.calls': 'Total calls',
      'kpi.hitRate': 'Hit rate',
      'kpi.period': 'Period',
      'kpi.periodValue': 'Last {days} days',
      'kpi.corpus': 'Guides',
      'stats.legacyScan': 'Legacy scans',
      'stats.findings': 'Findings',
      'tool.legacyScan': 'Legacy scan',
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
      'kpi.calls': 'Всего вызовов',
      'kpi.hitRate': 'Доля попаданий',
      'kpi.period': 'Период',
      'kpi.periodValue': 'Последние {days} дн.',
      'kpi.corpus': 'Подсказок',
      'stats.legacyScan': 'Сканирования устаревшего кода',
      'stats.findings': 'Замечания',
      'tool.legacyScan': 'Сканер устаревшего кода',
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
      'kpi.calls': '总调用次数',
      'kpi.hitRate': '命中率',
      'kpi.period': '统计周期',
      'kpi.periodValue': '最近 {days} 天',
      'kpi.corpus': '指引数量',
      'stats.legacyScan': '遗留代码扫描',
      'stats.findings': '发现问题数',
      'tool.legacyScan': '遗留代码扫描工具',
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

      return {
        periodDays: asCount(payload.periodDays),
        corpus: { total: asCount(corpus.total), version: asText(corpus.version), snapshotDate: asText(corpus.snapshotDate) },
        calls: asCount(totals.calls),
        hitRate: asCount(totals.hitRate),
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
        deadGuides: { total: asCount(dead.total), sample: Array.isArray(dead.sample) ? dead.sample : [] },
        legacyScan: firstCount(tools['legacy-scan'], byTool['legacy-scan']),
        findings: firstCount(payload.findings, totals.findings),
      }
    }

    /**
     * Turn one Remote result envelope into a report.
     *
     * `commands.execute` answers `{ ok, value: { result: { kind, text } } }`, and `value` is absent
     * when the line did not resolve to a command at all. The report itself is the command's text.
     *
     * @param {unknown} envelope
     * @returns {object} the validated report.
     */
    function readEnvelope(envelope) {
      if (envelope === null || typeof envelope !== 'object') {
        throw panelError('call', 'the host returned no result')
      }
      if (envelope.ok !== true) {
        const failure = envelope.error !== null && typeof envelope.error === 'object' ? envelope.error : {}
        throw panelError('call', `${asText(failure.code) || 'error'}: ${asText(failure.message) || 'the host rejected the call'}`)
      }
      const value = envelope.value
      if (value === null || typeof value !== 'object') {
        throw panelError('call', `/guidance-stats is not registered on this host (no result for ${REPORT_LINE})`)
      }
      const outcome = value.result
      if (outcome === null || typeof outcome !== 'object') {
        throw panelError('call', 'the command returned no outcome')
      }
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
      header: { display: 'flex', alignItems: 'flex-start', gap: '12px' },
      headerText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
      title: { fontSize: '16px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.4 },
      updated: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
      refresh: {
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
      refreshBusy: { opacity: 0.6, cursor: 'default' },
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
     */
    function renderKpis(t, report) {
      const cells = [
        kpi(t, t('kpi.calls'), String(report.calls)),
        kpi(t, t('kpi.hitRate'), percent(report.hitRate)),
        kpi(t, t('kpi.period'), t('kpi.periodValue', { days: report.periodDays })),
      ]
      if (report.corpus.total > 0) cells.push(kpi(t, t('kpi.corpus'), String(report.corpus.total)))
      cells.push(kpi(t, t('stats.legacyScan'), String(report.legacyScan), t('tool.legacyScan')))
      cells.push(kpi(t, t('stats.findings'), String(report.findings)))
      return h('div', { style: S.kpis }, cells)
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

    /** How many catalog guides were never retrieved. */
    function renderDead(t, report) {
      const dead = report.deadGuides.total
      const total = report.corpus.total
      const body =
        total === 0
          ? t('dead.none')
          : dead === 0
            ? t('dead.none')
            : t('dead.summary', { count: dead, total })
      return section(t('section.dead'), h('div', { style: S.note }, body))
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
     * The panel. It is read-only: the one control asks the host to re-run the counters command.
     * Every subscription it starts is component-local, so unmounting it releases them.
     */
    function GuidancePanel(props) {
      const t = props.t
      const bridge = props.bridge
      const sessionId = props.useSessions(selectSessionId)
      const [state, setState] = useState({ status: 'loading', report: undefined, code: '', message: '', at: 0 })
      const alive = useRef(true)
      const running = useRef(false)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(() => {
        if (running.current) return
        if (bridge === undefined || typeof bridge.call !== 'function') {
          setState({ status: 'error', report: undefined, code: 'bridge', message: '', at: 0 })
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState({ status: 'error', report: undefined, code: 'session', message: '', at: 0 })
          return
        }
        running.current = true
        setState((previous) => ({ ...previous, status: 'loading' }))
        let pending
        try {
          pending = Promise.resolve(bridge.call(sessionId, REPORT_LINE))
        } catch (error) {
          pending = Promise.reject(error)
        }
        pending
          .then((envelope) => {
            if (!alive.current) return
            const report = readEnvelope(envelope)
            setState({ status: 'ready', report, code: '', message: '', at: Date.now() })
          })
          .catch((error) => {
            if (!alive.current) return
            const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'call'
            setState({ status: 'error', report: undefined, code, message: messageOf(error), at: 0 })
          })
          .then(() => {
            running.current = false
          })
      }, [bridge, sessionId])

      useEffect(() => {
        load()
      }, [load])

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
          'button',
          {
            type: 'button',
            style: busy ? { ...S.refresh, ...S.refreshBusy } : S.refresh,
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
        body =
          report.calls === 0
            ? renderEmpty(t, report)
            : h(
                React.Fragment,
                null,
                renderKpis(t, report),
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
    }

    return { inject: ['slots', 'locale', 'remote', 'remote.commands'], apply }
  },
})
