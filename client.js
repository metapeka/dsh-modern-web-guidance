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
 * A scan is reported with its caveats, never as bare counts: how many paths the walk skipped and why
 * (`skippedByReason` / a stored `lastScan.skipped`), and whether a cap cut the list short
 * (`truncated`). Both are counts and raw reason tokens — `extension`, `dot-directory` — shown
 * untranslated exactly like a rule id, and both are optional in older data, where the line is
 * simply shorter.
 *
 * The panel also explains what it counts instead of printing bare pairs: a rule row keeps its id, its
 * raw confidence token and a count that names its unit, with the rule's own message clamped under it,
 * and one caption says so when the ranked counts are lifetime totals rather than the selected window.
 * A host that predates those fields sends none of them, and the row then renders exactly what it did
 * before — version skew costs a caption or a hint, never a row.
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
    /**
     * The `<select>` value that asks the report to sum every workspace. No workspace id is `all`:
     * the host makes those out of 8 lowercase hex characters.
     */
    const WORKSPACE_ALL = 'all'
    /** The host's synthetic bucket for counters recorded before workspaces were attributed. */
    const UNATTRIBUTED_ID = '_unattributed'
    /** Characters of a workspace id shown beside a duplicated name: enough to tell two apart. */
    const WORKSPACE_ID_CHARS = 4
    /** Dead-guide ids the panel lists: the counter caps its own sample at 20 as well. */
    const MAX_DEAD_ROWS = 20
    /**
     * The scan the panel's button runs. `.` is the session workspace: the command refuses to scan
     * anything on its own, so the panel asks for it explicitly and the scanner still decides what
     * that path means. JSON output, because the panel renders counters, not sentences.
     */
    const SCAN_LINE = '/guidance-scan . --format json'
    /**
     * The two writes the panel may ask for, and ADR-0003 allows exactly these two: one suppression
     * entry, one `.scanignore` line. Each takes a plan first — `--dry-run` answers the plan and writes
     * nothing, and the same line without the flag applies that plan.
     */
    const SUPPRESS_LINE = '/guidance-suppress'
    const SCANIGNORE_LINE = '/guidance-scanignore'
    /** The wire name of the scan tool: the key ui-tool dispatches a row by, and the name in the log. */
    const SCAN_TOOL_NAME = 'web_guidance_legacy_scan'
    /** Three skip reasons fit the rail width; the rest are counted on the same line. */
    const SKIP_REASONS_SHOWN = 3
    /** Rules one scan ranks in the panel, and findings the chat row lists before it summarises. */
    const MAX_SCAN_RULES = 10
    /** Recent scans the panel lists: the ring keeps 20, a rail shows the five that answer "when". */
    const MAX_HISTORY_ROWS = 5
    const MAX_TOOL_ROWS = 16
    /**
     * How long the copy button waits for the clipboard before it says it could not.
     *
     * `navigator.clipboard.writeText()` is a browser promise that is allowed to stay pending: a window
     * without OS focus parks the write, and a permission prompt nobody sees does the same. The button's
     * label is the whole answer to the click, so a copy the panel never saw land is reported as a
     * failure — never claimed as a success — and the wait is bounded so that answer always arrives.
     */
    const COPY_TIMEOUT_MS = 4000

    /** English dictionary: the fallback locale, so it must stay complete. */
    const EN = {
      'title': 'Guidance Insights',
      'subtitle': 'Local counters recorded by this plugin. Read-only.',
      'refresh': 'Refresh',
      'loading': 'Reading the counters...',
      'copy.json': 'Copy as JSON',
      'copy.done': 'JSON copied',
      'copy.failed': 'The clipboard refused',
      'copy.timeout': 'The clipboard did not answer',
      'updated': 'Updated {time}',
      'period.short': '{days} d',
      'workspace.label': 'Workspace: {name}',
      'workspace.all': 'All workspaces',
      'workspace.unattributed': 'Unattributed',
      'workspace.switch': 'Switch workspace',
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
      'scanner.skipped': 'skipped {count}',
      'scanner.cut': 'truncated',
      'scanner.branch': 'branch {branch}',
      'scanner.detached': 'detached at {sha}',
      'scanner.ignoreUsage': '.scanignore: {patterns}, {unused} matched nothing',
      'scanner.review': '.suppress: {entries}, {matching} matching, {unused} unused',
      'scanner.reviewUnknown': '.suppress: {entries}, {matching} matching; the last scan was incomplete, so no entry is shown as unused',
      'scanner.reviewList': 'Entries that matched nothing:',
      'scanner.history': 'Recent scans',
      'scanner.historyMore': 'and {count} earlier',
      'scanner.diffAgainst': 'Since the scan of {when}:',
      'scanner.diffCounts': '{resolved} no longer present · {stillOpen} still open · {new} new',
      'scanner.diffPartial': 'not comparable ({reason})',
      'scanner.diffFirst': 'The next scan will be compared with this one',
      'scanner.diffRetired': '{count} under retired rules',
      'scanner.lastSeen': 'last {when}',
      'scanner.rules': 'Rules that matched',
      'scanner.lifetime': 'Lifetime totals, not the {days}-day window',
      'scanner.lifetimeSince': 'since {date}',
      'scanner.guides': 'Guides to load',
      'scanner.scan': 'Scan workspace folder',
      'scanner.scanning': 'Scanning the workspace...',
      'scanner.failed': 'The scan did not run: {message}',
      'scan.summary': 'Scanned {files}, {findings}',
      'scan.skipped': 'Skipped {count} ({reasons})',
      'scan.skippedMore': '+{more} more',
      'scan.clean': 'No rule matched.',
      'scan.truncated': 'Truncated: the scan hit a cap, so this list is incomplete.',
      'scan.suppressed': 'Suppressed {count} ({rules})',
      'scan.suppressedTag': 'muted',
      'scan.suppressProblem': 'Suppression file: {reason}; nothing is muted this scan.',
      'scan.mute': 'Mute',
      'scan.muteConfirm': 'Append to .suppress',
      'scan.muteFailed': 'The entry was not written: {message}',
      'scan.ignore': 'Ignore this path',
      'scan.ignoreConfirm': 'Append to .scanignore',
      'scan.ignoreFailed': 'The pattern was not written: {message}',
      'scan.ignoreNote': 'An ignore makes the next scan read less: that path is skipped, and the finding is not fixed.',
      'scan.muteNote': 'A mute hides one site without fixing it: the scan still counts the finding and reports it as suppressed.',
      'scan.remove': 'Remove this entry',
      'scan.removeConfirm': 'Remove from .suppress',
      'scan.removeFailed': 'The entry was not removed: {message}',
      'scan.removeNote': 'Removing a mute un-mutes one site: the next scan counts that finding again, and no counter changes.',
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
      'pattern.one': '{count} pattern',
      'pattern.few': '{count} patterns',
      'pattern.many': '{count} patterns',
      'entry.one': '{count} entry',
      'entry.few': '{count} entries',
      'entry.many': '{count} entries',
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
      'copy.json': 'Копировать JSON',
      'copy.done': 'JSON скопирован',
      'copy.failed': 'Буфер обмена отказал',
      'copy.timeout': 'Буфер обмена не ответил',
      'updated': 'Обновлено {time}',
      'period.short': '{days} дн.',
      'workspace.label': 'Рабочая папка: {name}',
      'workspace.all': 'Все рабочие папки',
      'workspace.unattributed': 'Без привязки',
      'workspace.switch': 'Переключить рабочую папку',
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
      'scanner.skipped': 'пропущено {count}',
      'scanner.cut': 'обрезано',
      'scanner.branch': 'ветка {branch}',
      'scanner.detached': 'отсоединён HEAD: {sha}',
      'scanner.ignoreUsage': '.scanignore: {patterns}, без совпадений: {unused}',
      'scanner.review': '.suppress: {entries}, совпадений: {matching}, без совпадений: {unused}',
      'scanner.reviewUnknown': '.suppress: {entries}, совпадений: {matching}; последнее сканирование было неполным, поэтому ни одна запись не показана как несовпавшая',
      'scanner.reviewList': 'Записи без совпадений:',
      'scanner.history': 'Последние сканирования',
      'scanner.historyMore': 'и ещё {count} более ранних',
      'scanner.diffAgainst': 'С момента сканирования {when}:',
      'scanner.diffCounts': '{resolved} больше не встречаются · {stillOpen} остаются · {new} новых',
      'scanner.diffPartial': 'сравнение невозможно ({reason})',
      'scanner.diffFirst': 'Следующее сканирование будет сравнено с этим',
      'scanner.diffRetired': '{count} по снятым правилам',
      'scanner.lastSeen': 'последний раз {when}',
      'scanner.rules': 'Сработавшие правила',
      'scanner.lifetime': 'Итоги за всё время, а не за {days} дн.',
      'scanner.lifetimeSince': 'начиная с {date}',
      'scanner.guides': 'Подсказки, которые стоит открыть',
      'scanner.scan': 'Сканировать рабочую папку',
      'scanner.scanning': 'Сканирую рабочую папку...',
      'scanner.failed': 'Сканирование не запустилось: {message}',
      'scan.summary': 'Просканировано {files}, {findings}',
      'scan.skipped': 'Пропущено {count} ({reasons})',
      'scan.skippedMore': '+{more} ещё',
      'scan.clean': 'Ни одно правило не сработало.',
      'scan.truncated': 'Список обрезан: сканирование упёрлось в лимит, поэтому он неполный.',
      'scan.suppressed': 'Заглушено {count} ({rules})',
      'scan.suppressedTag': 'заглушено',
      'scan.suppressProblem': 'Файл подавлений: {reason}; в этом сканировании ничего не заглушено.',
      'scan.mute': 'Заглушить',
      'scan.muteConfirm': 'Дописать в .suppress',
      'scan.muteFailed': 'Запись не выполнена: {message}',
      'scan.ignore': 'Игнорировать этот путь',
      'scan.ignoreConfirm': 'Дописать в .scanignore',
      'scan.ignoreFailed': 'Шаблон не записан: {message}',
      'scan.ignoreNote': 'Игнорирование уменьшает объём следующего сканирования: этот путь пропускается, а находка не исправляется.',
      'scan.muteNote': 'Заглушение скрывает один участок кода, а не исправляет его: находка остаётся в сканировании и учитывается как подавленная.',
      'scan.remove': 'Удалить запись',
      'scan.removeConfirm': 'Удалить из .suppress',
      'scan.removeFailed': 'Запись не удалена: {message}',
      'scan.removeNote': 'Удаление заглушения снова открывает один участок: следующее сканирование снова засчитает эту находку, а счётчики не изменятся.',
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
      'pattern.one': '{count} шаблон',
      'pattern.few': '{count} шаблона',
      'pattern.many': '{count} шаблонов',
      'entry.one': '{count} запись',
      'entry.few': '{count} записи',
      'entry.many': '{count} записей',
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
      'copy.json': '复制为 JSON',
      'copy.done': 'JSON 已复制',
      'copy.failed': '剪贴板拒绝了写入',
      'copy.timeout': '剪贴板没有响应',
      'updated': '更新于 {time}',
      'period.short': '{days} 天',
      'workspace.label': '工作区：{name}',
      'workspace.all': '所有工作区',
      'workspace.unattributed': '未归属',
      'workspace.switch': '切换工作区',
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
      'scanner.skipped': '跳过 {count}',
      'scanner.cut': '已截断',
      'scanner.branch': '分支 {branch}',
      'scanner.detached': '游离 HEAD：{sha}',
      'scanner.ignoreUsage': '.scanignore：{patterns}，{unused} 条未匹配任何内容',
      'scanner.review': '.suppress：{entries}，匹配 {matching}，未匹配 {unused}',
      'scanner.reviewUnknown': '.suppress：{entries}，匹配 {matching}；上次扫描不完整，因此不显示未匹配的条目',
      'scanner.reviewList': '未匹配的条目：',
      'scanner.history': '最近的扫描',
      'scanner.historyMore': '另有 {count} 次更早的',
      'scanner.diffAgainst': '自 {when} 的扫描以来：',
      'scanner.diffCounts': '{resolved} 不再出现 · {stillOpen} 仍然存在 · {new} 新增',
      'scanner.diffPartial': '无法比较（{reason}）',
      'scanner.diffFirst': '下一次扫描将与此比较',
      'scanner.diffRetired': '已停用规则 {count} 条',
      'scanner.lastSeen': '最近 {when}',
      'scanner.rules': '命中的规则',
      'scanner.lifetime': '累计总数，不是最近 {days} 天的窗口',
      'scanner.lifetimeSince': '自 {date} 起',
      'scanner.guides': '需要打开的指引',
      'scanner.scan': '扫描工作区',
      'scanner.scanning': '正在扫描工作区...',
      'scanner.failed': '扫描未能运行：{message}',
      'scan.summary': '已扫描 {files}，{findings}',
      'scan.skipped': '已跳过 {count} 个（{reasons}）',
      'scan.skippedMore': '另有 {more} 项',
      'scan.clean': '没有规则命中。',
      'scan.truncated': '已截断：扫描触到上限，所以这份清单不完整。',
      'scan.suppressed': '已屏蔽 {count}（{rules}）',
      'scan.suppressedTag': '已屏蔽',
      'scan.suppressProblem': '屏蔽文件：{reason}；本次扫描未屏蔽任何内容。',
      'scan.mute': '屏蔽',
      'scan.muteConfirm': '追加到 .suppress',
      'scan.muteFailed': '未写入条目：{message}',
      'scan.ignore': '忽略此路径',
      'scan.ignoreConfirm': '追加到 .scanignore',
      'scan.ignoreFailed': '未写入模式：{message}',
      'scan.ignoreNote': '忽略只让下次扫描读得更少：该路径被跳过，问题并未修复。',
      'scan.muteNote': '屏蔽只隐藏一处问题、并不修复它：该问题仍留在扫描结果中，并按已屏蔽计数。',
      'scan.remove': '删除此条目',
      'scan.removeConfirm': '从 .suppress 删除',
      'scan.removeFailed': '未删除条目：{message}',
      'scan.removeNote': '删除屏蔽会让这一处重新显示：下次扫描会再次计入该问题，计数器不会改变。',
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
      'pattern.one': '{count} 个模式',
      'pattern.few': '{count} 个模式',
      'pattern.many': '{count} 个模式',
      'entry.one': '{count} 条记录',
      'entry.few': '{count} 条记录',
      'entry.many': '{count} 条记录',
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
     * The command line for one window and one workspace.
     *
     * Both selectors belong to the command, not to the panel: the panel only picks numbers and ids,
     * so the text report and the panel keep reading one implementation of the counters. An empty id
     * asks for nothing extra, which is the command's own default (this session's workspace).
     *
     * @param {number} days
     * @param {string} [workspace] a workspace id, `all`, or '' for the command's default.
     * @returns {string}
     */
    function reportLine(days, workspace) {
      const line = `${REPORT_LINE} --days ${asCount(days)}`
      const selected = asText(workspace)
      if (selected === '') return line
      if (selected === WORKSPACE_ALL) return `${line} --all`
      return `${line} --workspace ${selected}`
    }

    /**
     * The visible name of one workspace.
     *
     * The host sums the counters recorded before it attributed anything into a bucket with an empty
     * name; that bucket, and only that bucket, is what the locale calls unattributed. The word is the
     * translator's, because the host names no workspace and invents no English.
     *
     * @param {Function} t bound translator.
     * @param {{ id: string, name: string }} workspace
     * @returns {string}
     */
    function workspaceName(t, workspace) {
      if (workspace.id === UNATTRIBUTED_ID || workspace.name === '') return t('workspace.unattributed')
      return workspace.name
    }

    /**
     * One `<option>` per entry plus the aggregate, each with the label to show for it.
     *
     * Two projects can share a directory basename (`app`, `app`), so a label that would repeat gains
     * a short id suffix: the id is a hash of the path, so nothing outside the profile is disclosed.
     * The full id settles the case of two ids that share their first characters.
     *
     * @param {Function} t bound translator.
     * @param {Array<{ id: string, name: string }>} workspaces
     * @returns {Array<{ id: string, label: string }>}
     */
    function workspaceOptions(t, workspaces) {
      const names = new Map()
      for (const entry of workspaces) names.set(entry.name, (names.get(entry.name) ?? 0) + 1)
      const used = new Set()
      const options = workspaces.map((entry) => {
        const name = workspaceName(t, entry)
        let label = names.get(entry.name) > 1 ? `${name} · ${entry.id.slice(0, WORKSPACE_ID_CHARS)}` : name
        if (used.has(label)) label = `${name} · ${entry.id}`
        used.add(label)
        return { id: entry.id, label }
      })
      return [{ id: WORKSPACE_ALL, label: t('workspace.all') }, ...options]
    }

    /**
     * The chip's label: the selected entry's own option label when the report lists it, its bare
     * name otherwise, so a report that names a workspace the switcher omits still says whose numbers
     * these are.
     *
     * @param {Function} t bound translator.
     * @param {Array<{ id: string, label: string }>} options
     * @param {{ id: string, name: string }|null} workspace the report's own `workspace`.
     * @returns {string}
     */
    function workspaceLabelOf(t, options, workspace) {
      if (workspace === null || workspace === undefined) return t('workspace.all')
      const option = options.find((row) => row.id === workspace.id)
      return option === undefined ? workspaceName(t, workspace) : option.label
    }

    /**
     * The `<select>` value: what the reader picked, or, before a pick, the workspace the report
     * answered for.
     *
     * @param {string} selected the reader's pick, or '' for none.
     * @param {{ id: string }|null} workspace the report's own `workspace`.
     * @returns {string}
     */
    function workspaceSelected(selected, workspace) {
      if (selected !== '') return selected
      const id = workspace === null || workspace === undefined ? '' : asText(workspace.id)
      return id === '' ? WORKSPACE_ALL : id
    }

    /** The value of one `<select>` change event, read defensively. */
    function selectValue(event) {
      const target = event === null || event === undefined ? undefined : event.target
      return target === null || target === undefined ? '' : asText(target.value)
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

    /**
     * A stored timestamp as `YYYY-MM-DD HH:MM`, in UTC like every date the counters print.
     *
     * A day-only value (the rule day maps store `YYYY-MM-DD`) renders as its date, so one formatter
     * serves both a scan's `at` and a rule's first/last-seen day. Anything else falls back to the
     * date part, because a malformed stamp should not become a second format.
     *
     * @param {unknown} value
     * @returns {string}
     */
    function scanWhen(value) {
      const text = asText(value)
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(text)
      return match === null ? dayOf(text) : `${match[1]} ${match[2]}`
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
     * `fields` names the descriptive strings a row may carry besides its id and its count: the rule's
     * message, confidence and guide, and the guide's description. They are read as text and default
     * to '', because an older host sends none of them — a version skew costs the detail, never the
     * row or the count that was already there.
     *
     * @param {Array<Record<string, unknown>>} rows
     * @param {'ruleId' | 'guideId'} key
     * @param {string[]} [fields] extra text fields to carry over, defaulting to ''.
     * @returns {Array<{ name: string, calls: number }>}
     */
    function rankedIds(rows, key, fields) {
      const extras = Array.isArray(fields) ? fields : []
      const out = []
      for (const row of rows) {
        const name = asText(row[key])
        if (name === '') continue
        const ranked = { name, calls: asCount(row.count) }
        for (const field of extras) ranked[field] = asText(row[field])
        out.push(ranked)
      }
      out.sort((left, right) => {
        if (right.calls !== left.calls) return right.calls - left.calls
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      })
      return out
    }

    /**
     * A `{ reason: count }` skip map as ranked rows plus its total.
     *
     * The reasons are the scanner's own vocabulary — `extension`, `binary`, `large`, `too-many`,
     * `unreadable`, `outside`, `dot-directory`, `scanignore` — so they are shown verbatim, exactly
     * like a rule id: translating them would invent a second name for something the text report and
     * `/guidance-scan` already print. A missing map reads as empty, which is also what a stale stats
     * file and a scan that skipped nothing produce, so neither case is an error.
     *
     * @param {unknown} value the `skippedByReason` map (scan value) or `skipped` map (last scan).
     * @returns {{ rows: Array<{ name: string, calls: number }>, total: number }}
     */
    function readSkipMap(value) {
      const rows = []
      let total = 0
      if (value !== null && typeof value === 'object' && Array.isArray(value) === false) {
        for (const [reason, count] of Object.entries(value)) {
          const name = asText(reason).trim()
          const amount = asCount(count)
          if (name === '' || amount <= 0) continue
          rows.push({ name, calls: amount })
          total += amount
        }
      }
      rows.sort((left, right) => {
        if (right.calls !== left.calls) return right.calls - left.calls
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      })
      return { rows, total }
    }

    /**
     * The branch label a completed scan recorded, or null when it recorded none.
     *
     * The host writes exactly two shapes — `{ kind: 'branch', name }` and `{ kind: 'detached', sha }`
     * — and writes nothing at all when `<workspace>/.git/HEAD` could not be read (ADR-0002 §4). A
     * missing, malformed or empty label reads as null, so the last-scan line stays exactly what it
     * was: a label that was not read is silence, never an "unknown" token.
     *
     * @param {unknown} value
     * @returns {{ kind: 'branch', name: string }|{ kind: 'detached', sha: string }|null}
     */
    function readBranch(value) {
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
      if (value.kind === 'branch') {
        const name = asText(value.name)
        return name === '' ? null : { kind: 'branch', name }
      }
      if (value.kind === 'detached') {
        const sha = asText(value.sha)
        return sha === '' ? null : { kind: 'detached', sha }
      }
      return null
    }

    /**
     * The stored last scan, or null. A value without a usable date reads as null: the section then
     * says nothing has run rather than printing an empty date.
     *
     * `skipped` and `truncated` are the caveats of the scan: 0.7.2 state files have neither, so a
     * missing map reads as empty and a missing flag as false and the line is simply shorter. `branch`
     * is the same bargain one layer later: absent unless the scan could read one.
     *
     * `suppressed` is the third bargain: a muted finding is still a finding, so its count sits beside
     * the scan's own and its rule breakdown beside that. A state file written before phase C has
     * neither member, and then no line is drawn — never a fabricated "0 suppressed".
     *
     * `ignoreUsage` is the fourth, and the one this panel must be most careful with: the host sends
     * two counts and never a pattern, because a `.scanignore` line is a path fragment. Absent means
     * "no file, or a file nobody could read", which draws no line at all — the panel cannot print
     * "0 patterns, 0 matched nothing" for a state document that never saw one.
     *
     * `suppressions` is the fifth: the host's join of the `.suppress` file against the sites its last
     * scan saw, as `{ entries, matching, unused: [siteId] | null }`. Absent is a 0.11.0 document or a
     * file nobody could read, and both draw no block; `unused: null` is a scan that could not prove
     * anything and draws the same block *without* an unused number. The ids are the only entry text a
     * scan can carry — a date, a reason and a rule belong to the entry, not to this scan — so the
     * panel lists them raw and offers the removal that names one.
     *
     * @param {unknown} value
     * @returns {{ at: string, files: number, findings: number, rules: string[], skipped: { rows: Array<{ name: string, calls: number }>, total: number }, truncated: boolean, branch: { kind: string, name?: string, sha?: string }|null, suppressed: number, suppressedRules: Array<{ name: string, calls: number }>, ignoreUsage: { patterns: number, unused: number }|null, suppressions: { entries: number, matching: number, unused: string[]|null }|null } | null}
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
        skipped: readSkipMap(value.skipped),
        truncated: value.truncated === true,
        branch: readBranch(value.branch),
        suppressed: asCount(value.suppressed),
        suppressedRules: rankedEntries(value.suppressedRules),
        ignoreUsage: readIgnoreUsage(value.ignoreUsage),
        suppressions: readSuppressionReview(value.suppressions),
      }
    }

    /**
     * The last scan's review of the `.suppress` file, or null when it carried none worth drawing.
     *
     * The gate is the host's own (`lib/report.js` applies the same one): two counts, then `unused` as
     * either null or a list of eight-hex ids that has to agree with the counts it claims — an
     * incomplete scan is null, and a list that disagrees with `entries - matching` is dropped back to
     * null rather than used to name entries the counts do not account for. Null renders the numbers
     * without an unused figure: the panel never turns "unknown" into `0`, which here would say every
     * mute still matches a site nobody looked for.
     *
     * @param {unknown} value
     * @returns {{ entries: number, matching: number, unused: string[]|null }|null}
     */
    function readSuppressionReview(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      if (typeof value.entries !== 'number' || !Number.isFinite(value.entries)) return null
      if (typeof value.matching !== 'number' || !Number.isFinite(value.matching)) return null
      const entries = asCount(value.entries)
      const matching = Math.min(entries, asCount(value.matching))
      if (value.unused === null) return { entries, matching, unused: null }
      if (!Array.isArray(value.unused)) return null
      const unused = [...new Set(value.unused.filter((id) => typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)))]
      return { entries, matching, unused: unused.length === entries - matching ? unused : null }
    }

    /**
     * The two counts the host keeps about the last scan's `.scanignore`, or null.
     *
     * The panel counts nothing itself and *defaults* nothing: both members have to be numbers, because
     * a missing `idle` read as `0` would print "3 patterns, 0 matched nothing" for a document that
     * never said so — the invented zero this whole field exists to prevent. A pair that does not agree
     * (more idle than patterns, a non-number, an empty file) reads as null and draws no line, which is
     * the same rule the host applies at the door. Two counts are enough because the sentence needs the
     * total and how many of those lines excluded nothing; the patterns themselves never leave the
     * machine that owns them.
     *
     * @param {unknown} value
     * @returns {{ patterns: number, unused: number }|null}
     */
    function readIgnoreUsage(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      if (typeof value.patterns !== 'number' || !Number.isFinite(value.patterns)) return null
      if (typeof value.idle !== 'number' || !Number.isFinite(value.idle)) return null
      const patterns = asCount(value.patterns)
      const unused = asCount(value.idle)
      if (patterns === 0 || unused > patterns) return null
      return { patterns, unused }
    }

    /**
     * The workspace the report answered for, or null when it aggregated every one.
     *
     * Additive on the wire: a host that predates attribution sends no `workspace` key at all, and
     * then the header renders exactly what 0.9.0 rendered.
     *
     * @param {unknown} value
     * @returns {{ id: string, name: string }|null}
     */
    function readWorkspace(value) {
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
      const id = asText(value.id)
      if (id === '') return null
      return { id, name: asText(value.name) }
    }

    /**
     * The switcher's entries, in the order the host ranked them (most recent scan first).
     *
     * Read defensively like the other optional scan fields: a value that is not an array reads as
     * [], a malformed entry is dropped rather than thrown over, and [] is what makes the header draw
     * no chip and no switcher. Only the id and the name are kept: the counts beside each entry are
     * the tiles' business, and a chip does not repeat them.
     *
     * @param {unknown} value
     * @returns {Array<{ id: string, name: string }>}
     */
    function readWorkspaces(value) {
      const entries = []
      for (const entry of asRows(value)) {
        const id = asText(entry.id)
        if (id === '') continue
        entries.push({ id, name: asText(entry.name) })
      }
      return entries
    }

    /**
     * The comparison the latest scan made against the previous one, or null when there is none.
     *
     * A comparison that ran names the scan it compared against and carries three numbers; one that
     * was skipped carries a guard token instead and **no numbers** (§4.5), so the token is what the
     * panel prints, raw like a skip reason. A report from before phase B has no `scanDiff` key, and
     * a diff with neither a token nor a date is not a comparison: both read as null, which is what
     * keeps the line off the panel instead of printing a zero nobody measured.
     *
     * @param {unknown} value
     * @returns {{ against: string, partial: string, resolved: number, stillOpen: number, new: number, retired: number }|null}
     */
    function readScanDiff(value) {
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
      const against = asText(value.against)
      const partial = asText(value.partial)
      if (against === '' && partial === '') return null
      return {
        against,
        partial,
        resolved: asCount(value.resolved),
        stillOpen: asCount(value.stillOpen),
        new: asCount(value.new),
        // Baseline sites whose rule this version no longer ships. Counted apart, never as resolved.
        retired: asCount(value.retired),
      }
    }

    /**
     * The recent scans, newest first, as the panel's rows need them.
     *
     * Only the members a row renders are kept: the entry's `diff`, `skipped`, `truncated` and
     * `outcome` belong to the JSON and to the text report. The `rules` map arrives as
     * `{ 'ls-13': 4 }` and is ranked by the same helper the counters use, so a row's rule list is in
     * count-desc order whatever the host sent.
     *
     * @param {unknown} value
     * @returns {Array<{ at: string, files: number, findings: number, rules: Array<{ name: string, calls: number }>, branch: object|null }>}
     */
    function readScanHistory(value) {
      const entries = []
      for (const entry of asRows(value)) {
        const at = asText(entry.at)
        if (at === '') continue
        entries.push({
          at,
          files: asCount(entry.files),
          findings: asCount(entry.findings),
          rules: rankedEntries(entry.rules),
          branch: readBranch(entry.branch),
        })
      }
      return entries
    }

    /**
     * Validate one `/guidance-stats --json` report and normalize it for rendering. The panel never
     * renders a partially parsed report: a missing or mistyped field raises instead.
     *
     * The scan detail is the exception, because it is the newest and the thinnest: a rule's message,
     * confidence and guide, a guide's description and the scope the counts were taken over are all
     * read as optional text. A host that predates them sends nothing, and the section renders the
     * ids and counts exactly as it did before instead of raising over a caption it cannot write.
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
        topRules: rankedIds(asRows(payload.topRules), 'ruleId', [
          'message',
          'confidence',
          'guideId',
          // The dates ride on the ranked row only in the described path; a host without them reads
          // them as '' and the row renders exactly the row it rendered before (no suffix, no hint).
          'firstSeen',
          'lastSeen',
        ]).slice(0, MAX_SCAN_RULES),
        topScanGuides: rankedIds(asRows(payload.topScanGuides), 'guideId', ['description']).slice(0, MAX_SCAN_RULES),
        // Which window the ranked rule counts cover. `'lifetime'` says they are not the {days} the
        // rest of the panel shows; an older report has no such field, and then the section stays
        // silent rather than claiming either way.
        scanCountsScope: asText(payload.scanCountsScope),
        // The day those counters began, already formatted by the host: the panel renders the string
        // it was given and never guesses at a locale date. '' means the document recorded no origin,
        // and the caption then keeps exactly the 0.11.0 text — no suffix, no dash, no "unknown".
        scanCountsSince: asText(payload.scanCountsSince),
        lastScan: readLastScan(payload.lastScan),
        // The scan story, additive like everything else in this block: a pre-B host sends neither,
        // and null / [] is what keeps the comparison line and the history block off the panel.
        scanDiff: readScanDiff(payload.scanDiff),
        scanHistory: readScanHistory(payload.scanHistory),
        // Whose numbers these are, and whose are on offer. Both are additive: a 0.9.0 host sends
        // neither, and null / [] is the panel's own "no attribution to show" state.
        workspace: readWorkspace(payload.workspace),
        workspaces: readWorkspaces(payload.workspaces),
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
     * Turn one Remote result envelope into a report, plus the JSON it came from.
     *
     * The report itself is the command's text. `json` is the text's own object, pretty-printed back —
     * the copy action hands a person exactly what the host sent, so it needs the payload rather than a
     * second request or a re-encoding of the normalized report (which is a subset of it by design).
     *
     * @param {unknown} envelope
     * @returns {{ report: object, json: string }} the validated report and its source text.
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
      let json
      try {
        json = JSON.stringify(payload, null, 2)
      } catch {
        throw panelError('call', 'the report cannot be copied as JSON')
      }
      return { report: readReport(payload), json }
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
     * A finding since 0.8.0 is one code site, not one line: `lines` carries the whole run it stands
     * for, and `occurrences` its length. Both are read defensively — an older host sends neither, and
     * then the row shows the single `line` exactly as before.
     *
     * `message` and `snippet` are carried for the row's tooltips only: sixteen rows with a second
     * text line each would bury the table, so the reader hovers a rule to see what it asks for and a
     * place to see the code. An older host sends neither, and both read as ''.
     *
     * A finding also carries the site identity a mute names and, when a person already muted it, the
     * boolean that makes the row tagged rather than hidden: it is still a finding.
     *
     * @param {Record<string, unknown>} row
     * @returns {{ ruleId: string, confidence: string, path: string, line: number, column: number, guideId: string, lines: number[], occurrences: number, message: string, snippet: string, siteId: string, suppressed: boolean }}
     */
    function readFinding(row) {
      const lines = Array.isArray(row.lines)
        ? row.lines.map((line) => asCount(line)).filter((line) => line > 0)
        : []
      return {
        ruleId: asText(row.ruleId),
        confidence: asText(row.confidence),
        path: asText(row.path),
        line: asCount(row.line),
        column: asCount(row.column),
        guideId: asText(row.guideId),
        lines,
        occurrences: asCount(row.occurrences) || lines.length || 1,
        message: asText(row.message),
        snippet: asText(row.snippet),
        // The site identity is what a mute names, so it is read on every finding, muted or not: a
        // pre-C host sends none, and then no row offers the action instead of offering a broken one.
        siteId: asText(row.siteId),
        // The boolean on a finding, never the number: the count lives on the scan result (§6).
        suppressed: row.suppressed === true,
      }
    }

    /**
     * The problems a suppression file reported, as rows: `{ key, reason }`, with `''` for a file-level
     * problem (the host writes `key: null` for one that mutes nothing).
     *
     * A bad entry drops that entry and the rest apply; the finding coming back on screen is the report
     * for it, so only a file-level failure becomes a visible note. Both are read, because the value
     * carries both and the count is the host's business, not this file's guess.
     *
     * @param {unknown} value
     * @returns {Array<{ key: string, reason: string }>}
     */
    function readSuppressProblems(value) {
      const rows = []
      for (const row of asRows(value)) {
        const reason = asText(row.reason)
        if (reason === '') continue
        rows.push({ key: asText(row.key), reason })
      }
      return rows
    }

    /**
     * Where one finding lives, as the row prints it: `path:line` for a single hit and
     * `path:first-last` for a run, with the hit count when the run skips a line.
     *
     * @param {{ path: string, line: number, lines: number[], occurrences: number }} finding
     * @returns {string}
     */
    function findingPlace(finding) {
      if (finding.path === '') return ''
      const lines = Array.isArray(finding.lines) ? finding.lines : []
      if (lines.length > 1) {
        const first = lines[0]
        const last = lines[lines.length - 1]
        const dense = last - first + 1 === lines.length
        return `${finding.path}:${first}-${last}${dense ? '' : ` (${finding.occurrences})`}`
      }
      return `${finding.path}:${finding.line}`
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
     * Counts, ids, and the findings themselves: the panel renders only the counts and the skip map,
     * and the chat row renders the findings because there they belong to a call the session already
     * made.
     *
     * @param {unknown} payload
     * @returns {{ files: number, bytes: number, findings: Array<object>, guides: Array<{ id: string, findings: number }>, skipped: { rows: Array<{ name: string, calls: number }>, total: number }, truncated: boolean, suppressed: number, suppressProblems: Array<{ key: string, reason: string }>, rules: Array<{ name: string, calls: number }> }}
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
      // The count, never a subtraction: a muted finding is still in `findings`, so the summary can
      // report it beside the total instead of shrinking the total. A pre-C value has neither the
      // member nor the flags, and both read as 0, which renders no clause at all.
      const flagged = findings.filter((finding) => finding.suppressed).length
      return {
        files: asCount(scanned.files),
        bytes: asCount(scanned.bytes),
        findings,
        guides,
        skipped: readSkipMap(scanned.skippedByReason),
        truncated: payload.truncated === true,
        suppressed: 'suppressed' in payload ? asCount(payload.suppressed) : flagged,
        // A corrupt file mutes nothing and the host says so in one raw token; that sentence is the
        // only suppression problem a table can carry, because a bad entry announces itself by the
        // finding that came back on screen.
        suppressProblems: readSuppressProblems(payload.suppressProblems),
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
      const skips = new Map()
      // The text renderer marks a muted row with ` (suppressed)` after the message and counts the muted
      // findings in the summary. Reading both here is what makes this reader agree with the JSON one
      // (§12): the same call must not render differently depending on the format it answered with.
      const marker = /\s*\(suppressed\)$/
      const problems = []
      let truncated = false
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        const match = /^-\s+(.+?):(\d+):(\d+)\s+(\S+)\s+\(([^)]+)\)\s+(.*)$/.exec(trimmed)
        if (match !== null) {
          const muted = marker.test(match[6])
          findings.push({
            ruleId: match[4],
            confidence: match[5],
            path: match[1],
            line: asCount(match[2]),
            column: asCount(match[3]),
            guideId: '',
            // The summary line prints the rule's message after the confidence, so the chat row can
            // keep the same hover hint for it as it does for a JSON answer.
            message: muted ? match[6].replace(marker, '') : match[6],
            snippet: '',
            // A text answer names no site, so no row of it offers a mute: the action needs a target.
            siteId: '',
            suppressed: muted,
          })
          continue
        }
        // `Skipped 279 path(s): 277 extension, 2 dot-directory` — the same counts the JSON carries,
        // printed as prose. The reasons are read verbatim so the row can report them unchanged.
        const skipped = /^Skipped (\d+) path\(s\)(?::\s*(.*))?\.?$/.exec(trimmed)
        if (skipped !== null) {
          for (const item of (skipped[2] ?? '').split(/,\s*/)) {
            const pair = /^(\d+)\s+(\S+)$/.exec(item.trim())
            if (pair === null) continue
            skips.set(pair[2], asCount(pair[1]))
          }
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
        // `Suppression file: malformed; nothing is muted this scan.` — the sentence the chat row prints,
        // read back so a text answer loses nothing the JSON answer reports. The entry-level note is not
        // read here: the findings it dropped are on screen, and that is their report.
        const suppression = /^Suppression file: (.+?); nothing is muted this scan\.?$/.exec(trimmed)
        if (suppression !== null) {
          problems.push({ key: '', reason: suppression[1] })
          continue
        }
      }
      const scannedMatch = /Scanned (\d+) file\(s\)/.exec(text)
      // `— 85 finding(s), 3 suppressed.` The count is the host's; the flags are the fallback for a text
      // whose summary line was cut, so the number never contradicts the tags on the rows below it.
      const suppressedMatch = /, (\d+) suppressed\b/.exec(text)
      return {
        files: scannedMatch === null ? 0 : asCount(scannedMatch[1]),
        bytes: 0,
        findings,
        guides,
        skipped: readSkipMap(Object.fromEntries(skips)),
        truncated,
        suppressed: suppressedMatch === null ? findings.filter((finding) => finding.suppressed).length : asCount(suppressedMatch[1]),
        suppressProblems: problems,
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

    /**
     * The suppression write, as the command line a person would type.
     *
     * `--dry-run` answers the plan and writes nothing; the same line without it applies that plan
     * (`docs/adr/0003-write-surface.md` §4). The site id is data, never a path: the
     * command resolves it against this workspace and refuses anything it cannot name, so the panel
     * never composes a target of its own.
     *
     * @param {string} siteId the eight-hex site identity the scan reported.
     * @param {boolean} dryRun whether this line only asks for the plan.
     * @returns {string}
     */
    function suppressLine(siteId, dryRun) {
      return `${SUPPRESS_LINE} ${siteId}${dryRun === true ? ' --dry-run' : ''}`
    }

    /**
     * The removal of one suppression entry, as the command line a person would type.
     *
     * ADR-0004's retract half: `--remove <siteId> --dry-run` answers the plan (the exact line it would
     * drop, the count before and after) and writes nothing; the same line without the flag removes
     * exactly that one entry. The id is data the scan reported, never something the panel composed.
     *
     * @param {string} siteId the eight-hex identity the entry is keyed by.
     * @param {boolean} dryRun whether this line only asks for the plan.
     * @returns {string}
     */
    function removeLine(siteId, dryRun) {
      return `${SUPPRESS_LINE} --remove ${siteId}${dryRun === true ? ' --dry-run' : ''}`
    }

    /**
     * The `.scanignore` write, as the command line a person would type.
     *
     * A pattern is one line of the file and one token of the command line, so a path containing a
     * space or a quote travels quoted: the command's own tokenizer gives it back unchanged, and the
     * line the file gains is the path the row named. `--dry-run` is the plan; the same line without
     * it appends it.
     *
     * @param {string} pattern the workspace-relative path the row is showing.
     * @param {boolean} dryRun whether this line only asks for the plan.
     * @returns {string}
     */
    function scanIgnoreLine(pattern, dryRun) {
      const text = asText(pattern)
      const token = /[\s"']/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text
      return `${SCANIGNORE_LINE} ${token}${dryRun === true ? ' --dry-run' : ''}`
    }

    /**
     * One write command's answer: its text on success, or its refusal as an error.
     *
     * The shape is the scan button's (`{ kind, text }`), and so is the rule: a refusal is
     * `kind: 'error'` with a stable code in its text, so it becomes an error state and can never be
     * rendered as a success. A success with no text is not a success either — the ADR says a write
     * reports what it changed and where, and "already suppressed, nothing written" says exactly that
     * in words, so a silent answer is a broken host, not a no-op.
     *
     * @param {unknown} envelope
     * @param {string} line the command line the envelope should be answering.
     * @returns {string} the command's own text.
     */
    function readWriteEnvelope(envelope, line) {
      const outcome = commandOutcome(envelope, line)
      const text = asText(outcome.text)
      if (outcome.kind === 'error') throw panelError('write', text === '' ? 'the write command reported an error' : text)
      if (outcome.kind !== 'success') throw panelError('write', 'the write command returned no result')
      if (text === '') throw panelError('write', 'the write command returned no text')
      return text
    }

    /**
     * The page's clipboard writer, when this page has one.
     *
     * The copy action needs no host call and no new data path: the panel already holds the report's own
     * JSON. A page without the API — an insecure origin, a shell that does not mount it — simply gets
     * no button: absent, never broken. A writer that exists and then refuses is reported as a refusal.
     *
     * @returns {Function|undefined} `(text) => Promise<void>`, or undefined when there is none.
     */
    function clipboardOf() {
      if (typeof window !== 'object' || window === null) return undefined
      const clipboard = window.navigator === null || window.navigator === undefined ? undefined : window.navigator.clipboard
      if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== 'function') return undefined
      return (text) => clipboard.writeText(text)
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
      // Two rows on a wide panel, and that is deliberate. Measured in a live host at 869px of panel
      // (787px of content): the title block needs ~250px to keep its subtitle on one line and the four
      // controls need ~700px, so 787px cannot hold both — fitting them would mean crushing the
      // subtitle into a column or dropping one of the two places the workspace is named. So the header
      // wraps instead, and the controls keep their own order. What it must not do is wrap because of a
      // long workspace name: the chip is the one element here with ellipsis-capable text, so it is the
      // one allowed to give way (`S.workspace` and `S.workspaceChip` shrink; the buttons never do).
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
      // The workspace chip names whose numbers are on screen and the select next to it changes
      // them. Both sit in the header beside the window switch, and both are themed like it. Only the
      // chip shrinks: its text is the only text in this header that can be abbreviated without
      // losing a control, and a squeezed `<select>` loses its arrow instead of its tail.
      workspace: { flex: '0 1 auto', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      workspaceChip: {
        flex: '0 1 auto',
        minWidth: 0,
        maxWidth: '180px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '4px 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.4,
      },
      workspaceSelect: {
        flex: '0 0 auto',
        appearance: 'none',
        maxWidth: '160px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '4px 8px',
        font: 'inherit',
        fontSize: '12px',
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
      // A rule row is a line of facts — id, confidence, a count that names its unit — with the rule's
      // own message wrapped underneath it, so `ls-17` explains itself without the reader opening
      // lib/scan-rules.js. The count hugs the id instead of jumping to the far edge of a wide panel.
      scanHeading: {
        fontSize: '11px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
        marginTop: '2px',
      },
      // What the counts below count: lifetime or the window above. One quiet line, never a claim.
      scanCaption: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.4 },
      scanLine: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '4px 0',
        borderTop: '1px solid var(--dsw-alias-separator-primary)',
        minWidth: 0,
      },
      scanLineFirst: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '4px 0', minWidth: 0 },
      scanRuleHead: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 },
      scanName: { flex: '0 0 auto', fontSize: '12px', fontWeight: 500 },
      scanConfidence: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
      scanCount: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      // When a rule was last seen: one more fact on the row's head, quieter than its count because
      // the count is what the row ranks by and the date is what the reader came to the history for.
      scanSeen: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
      // A recent-scan row is one wrapped line of facts: `date time · files · findings · rules`.
      historyText: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
        lineHeight: 1.45,
        overflowWrap: 'anywhere',
      },
      // The place of a finding in the panel's own scan: the one place it shows a path, because the
      // user scanned their own workspace and the mute action has to name a site.
      scanPlace: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      // `muted` is a word, not a colour: a reader with no colour still sees that the finding was
      // muted, and it is the same word in the chat row.
      mutedTag: {
        flex: '0 0 auto',
        padding: '0 5px',
        borderRadius: '5px',
        background: 'var(--dsw-alias-fill-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '10px',
      },
      // The two row actions are quiet text buttons: they are the panel's writes, so they must not look
      // like the scan button that produces numbers.
      rowActions: { flex: '0 0 auto', display: 'flex', alignItems: 'baseline', gap: '10px', marginLeft: 'auto' },
      rowAction: {
        flex: '0 0 auto',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '11px',
        textDecoration: 'underline',
        cursor: 'pointer',
      },
      rowActionBusy: { color: 'var(--dsw-alias-label-tertiary)', cursor: 'default' },
      // A refused write is an error on screen, never a quieter success: its own sentence and the
      // error colour, and the outcome branch below is not where it lands.
      muteError: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.5 },
      // The plan before the second click: the site or the pattern, the file and the entry the host
      // would add, boxed so it cannot be mistaken for a result.
      mutePlan: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        marginTop: '2px',
        padding: '6px 8px',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-layer-1)',
        minWidth: 0,
      },
      // The review list is bounded by height, not by row count: every unused entry must keep its
      // remove action reachable, and the `.suppress` file's own cap is 200 entries — a pile that size
      // would push the scan result off the screen, which the scroll box prevents without hiding a row.
      reviewBox: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '150px',
        overflowY: 'auto',
        minWidth: 0,
      },
      // Two lines of the rule's own text, clamped here rather than sliced by the client so the whole
      // sentence stays in the element (and in its title); the panel stays a summary, not a manual.
      // `-webkit-line-clamp` takes an integer, hence the string: a number would be sent as `2px`.
      scanMessage: {
        display: '-webkit-box',
        WebkitLineClamp: '2',
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
        lineHeight: 1.45,
        overflowWrap: 'anywhere',
      },
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
      // A muted row is dimmed as well as tagged, but never dimmed alone: the word is the signal and
      // the dimming only says the row is not the table's subject any more.
      muted: { opacity: '0.65' },
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
     * The header's workspace control: a chip naming the workspace whose numbers are on screen, and
     * the native `<select>` that asks the command for another.
     *
     * Returns null on a host that sends no `workspaces` list, so the header is exactly the 0.9.0 one
     * — the same degradation the report reader gives the rest of the panel. The chip keeps naming
     * the report that is rendered while a reload is in flight; only the select follows the pick.
     *
     * @param {Function} t bound translator.
     * @param {object|undefined} report the loaded report, if there is one yet.
     * @param {string} selected the reader's pick, or '' for none.
     * @param {Function} onChange called with the chosen id (or `all`).
     * @returns {object|null}
     */
    function renderWorkspace(t, report, selected, onChange) {
      const workspaces = report === undefined || report === null ? [] : report.workspaces
      if (!Array.isArray(workspaces) || workspaces.length === 0) return null
      const workspace = report.workspace === undefined ? null : report.workspace
      const options = workspaceOptions(t, workspaces)
      const label = workspaceLabelOf(t, options, workspace)
      return h(
        'div',
        { style: S.workspace, role: 'group', 'aria-label': t('workspace.switch') },
        h('span', { style: S.workspaceChip, title: label }, t('workspace.label', { name: label })),
        h(
          'select',
          {
            style: S.workspaceSelect,
            'aria-label': t('workspace.switch'),
            value: workspaceSelected(selected, workspace),
            onChange: (event) => onChange(selectValue(event)),
          },
          options.map((option) => h('option', { key: `workspace-${option.id}`, value: option.id }, option.label)),
        ),
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

    /**
     * The comparison line under the last scan, or null when the report carries no comparison.
     *
     * Three states and one silence. A comparison that ran names the scan it compared against and the
     * numbers it measured — "no longer present", never "fixed": the panel can prove absence, not a
     * fix. A first scan says the next one will be compared. A skipped comparison prints its guard
     * token raw, like a skip reason, because `fewer-files` is the scanner's word and not a locale
     * key. Retired sites are a fourth number and appear only when there are any: they left because
     * the rule did, not because the code changed.
     *
     * @param {Function} t bound translator.
     * @param {object|null} diff the report's `scanDiff`.
     * @returns {string|null}
     */
    function diffLine(t, diff) {
      if (diff === null) return null
      if (diff.partial !== '') {
        return diff.partial === 'no-baseline'
          ? t('scanner.diffFirst')
          : t('scanner.diffPartial', { reason: diff.partial })
      }
      const counts = t('scanner.diffCounts', { resolved: diff.resolved, stillOpen: diff.stillOpen, new: diff.new })
      const retired = diff.retired > 0 ? ` · ${t('scanner.diffRetired', { count: diff.retired })}` : ''
      return `${t('scanner.diffAgainst', { when: scanWhen(diff.against) })} ${counts}${retired}`
    }

    /**
     * One row of the recent-scans block: when, how big, what it found, and what it was measured on.
     *
     * `date time · files · findings · rule×count` — the rules are the entry's own top list, raw ids
     * with a `×` and their counts, never translated, and the branch label rides along through
     * ADR-0002's two keys when the scan recorded one. The entry's diff is deliberately absent: three
     * more numbers in a rail this narrow is noise, and the JSON keeps them for a reader who asks.
     *
     * @param {Function} t bound translator.
     * @param {object} entry one normalized history entry.
     * @param {number} index the row's position: zero draws no separator above it.
     * @returns {object} the row.
     */
    function scanHistoryLine(t, entry, index) {
      const facts = [scanWhen(entry.at), plural(t, 'file', entry.files), plural(t, 'finding', entry.findings)]
      if (entry.rules.length > 0) facts.push(entry.rules.map((rule) => `${rule.name}×${rule.calls}`).join(', '))
      if (entry.branch !== null) {
        facts.push(
          entry.branch.kind === 'branch'
            ? t('scanner.branch', { branch: entry.branch.name })
            : t('scanner.detached', { sha: entry.branch.sha }),
        )
      }
      return h(
        'div',
        { style: index === 0 ? S.scanLineFirst : S.scanLine, key: `history-${index}` },
        h('span', { style: S.historyText }, facts.join(' · ')),
      )
    }

    /**
     * One rule row: `ls-17  high  121 findings` on the first line, the rule's own message clamped to
     * two lines under it — the section has to say what a rule is, not only how often it fired.
     *
     * The count carries its unit because a bare 121 next to a rule id cannot be told apart from 121
     * files; the plural helper picks the language's form. `message` and `confidence` are optional:
     * the ranked rows of the report carry them, while the rows of the panel's own live scan answer
     * still carry only an id and a count, and there the first line simply ends after the count.
     *
     * @param {Function} t bound translator.
     * @param {{ name: string, calls: number, message?: string, confidence?: string, guideId?: string }} rule
     * @param {boolean} first whether this is the first row of its group (no separator above it).
     * @returns {object} the row.
     */
    function scanRuleLine(t, rule, first) {
      const message = asText(rule.message)
      const confidence = asText(rule.confidence)
      const guideId = asText(rule.guideId)
      const firstSeen = asText(rule.firstSeen)
      const lastSeen = asText(rule.lastSeen)
      // `firstSeen` is secondary detail, so it rides in the row's tooltip beside the message — the
      // place this panel already keeps what does not fit on the line. An undated row keeps exactly the
      // tooltip it had; the visible suffix is the last-seen day, because "when did I last see this" is
      // the question the history exists to answer.
      const hint = firstSeen === '' ? message : message === '' ? firstSeen : `${message} · ${firstSeen}`
      const rowProps = { style: first ? S.scanLineFirst : S.scanLine, key: `rule-${rule.name}` }
      if (firstSeen !== '') rowProps.title = hint
      return h(
        'div',
        rowProps,
        h(
          'div',
          { style: S.scanRuleHead },
          // Hovering the id names the guide that explains the fix; a host without the new fields
          // leaves the id as its own hint.
          h('span', { style: S.scanName, title: guideId === '' ? rule.name : guideId }, rule.name),
          confidence === '' ? null : h('span', { style: S.scanConfidence }, confidence),
          h('span', { style: S.scanCount }, plural(t, 'finding', rule.calls)),
          lastSeen === '' ? null : h('span', { style: S.scanSeen }, t('scanner.lastSeen', { when: scanWhen(lastSeen) })),
        ),
        message === '' ? null : h('div', { style: S.scanMessage, title: hint }, message),
      )
    }

    /**
     * `Skipped 279 (277 extension, 2 dot-directory, +2 more)` — one line, counts and raw reason
     * tokens only.
     *
     * Files that were never read are the other half of "Scanned 70 files, 97 findings": a scan whose
     * walk refused a third of the tree reports a smaller number, and saying so is the difference
     * between a report and a claim. Three reasons fit a rail width; the rest are counted, not hidden.
     *
     * @param {Function} t bound translator.
     * @param {{ rows: Array<{ name: string, calls: number }>, total: number }} skipped the map.
     * @param {number} limit how many reasons to name.
     * @returns {string} the line.
     */
    function skipLine(t, skipped, limit) {
      const shown = skipped.rows.slice(0, limit)
      const reasons = shown.map((row) => `${row.calls} ${row.name}`)
      const rest = skipped.rows.length - shown.length
      if (rest > 0) reasons.push(t('scan.skippedMore', { more: rest }))
      return t('scan.skipped', { count: skipped.total, reasons: reasons.join(', ') })
    }

    /**
     * A `{ name: count }` map as the line prints it: `ls-13 2, ls-08 1`.
     *
     * Raw rule ids and their counts, exactly like every other id in this panel: a muted finding is
     * counted under the rule that caught it, and neither word is this file's to translate.
     *
     * @param {Array<{ name: string, calls: number }>} rows ranked rows.
     * @returns {string}
     */
    function ruleList(rows) {
      return rows.map((row) => `${row.name} ${row.calls}`).join(', ')
    }

    /**
     * One finding of the panel's own scan, as the row that offers to mute it.
     *
     * `ls-13 · src/app.css:12` plus the `muted` tag when the host says the site is suppressed, with the
     * finding's message as the row's tooltip. This is the one place in the panel that shows a path: the
     * user scanned their own workspace, and both writes are decisions about one site or one file of it
     * (the counters above keep their "ids and numbers, never a path" rule).
     *
     * Each write is offered only where it can name its target, and never as a button that fails when
     * clicked: a muted row offers no mute (the decision is already made), a row without a `siteId`
     * offers none either (every row of a host that predates suppression has none), and a row without a
     * place offers no ignore — a path is what an ignore names, and a finding without one has no target
     * to exclude.
     *
     * @param {Function} t bound translator.
     * @param {object} finding one normalized finding.
     * @param {number} index its position: zero draws no separator above it.
     * @param {boolean} blocked whether a scan or a write is in flight.
     * @param {{ onMute: Function, onIgnore: Function }} actions ask the host for the plan that would
     *   mute this site, or exclude this path.
     * @returns {object} the row.
     */
    function findingLine(t, finding, index, blocked, actions) {
      const place = findingPlace(finding)
      const message = asText(finding.message)
      const muted = finding.suppressed === true
      const path = asText(finding.path)
      const head = [
        h('span', { style: S.scanName, key: 'rule', title: message === '' ? finding.ruleId : message }, finding.ruleId),
      ]
      if (place !== '') head.push(h('span', { style: S.scanPlace, key: 'place' }, place))
      if (muted) head.push(h('span', { style: S.mutedTag, key: 'tag' }, t('scan.suppressedTag')))
      // Nothing is offered for what is already decided: a muted finding has nothing left to mute, and
      // a row whose value named no site or no path cannot name the target a write needs. Both are
      // absences, not buttons that fail when pressed.
      const offered = []
      if (!muted && asText(finding.siteId) !== '') {
        offered.push(
          h(
            'button',
            {
              type: 'button',
              key: 'mute',
              style: blocked ? { ...S.rowAction, ...S.rowActionBusy } : S.rowAction,
              disabled: blocked,
              onClick: () => actions.onMute(finding),
            },
            t('scan.mute'),
          ),
        )
      }
      if (path !== '') {
        offered.push(
          h(
            'button',
            {
              type: 'button',
              key: 'ignore',
              style: blocked ? { ...S.rowAction, ...S.rowActionBusy } : S.rowAction,
              disabled: blocked,
              onClick: () => actions.onIgnore(finding),
            },
            t('scan.ignore'),
          ),
        )
      }
      if (offered.length > 0) head.push(h('div', { style: S.rowActions, key: 'actions' }, offered))
      return h(
        'div',
        { style: index === 0 ? S.scanLineFirst : S.scanLine, key: `finding-${index}` },
        h('div', { style: S.scanRuleHead }, head),
      )
    }

    /**
     * One suppression entry that matched nothing, as the row that offers to remove it.
     *
     * The row shows the site id and nothing else, because that is all the scan could prove about the
     * entry: a date, a reason and a rule belong to the file, and the join that produced this list never
     * read them. The id is what `--remove` takes, so the row and the command name the same thing, and
     * the removal's plan is where a person reads the date and reason of the payload before the second
     * click — the host prints them, the panel does not guess them.
     *
     * @param {Function} t bound translator.
     * @param {string} siteId one eight-hex identity from the review's `unused`.
     * @param {number} index its position: zero draws no separator above it.
     * @param {boolean} blocked whether a scan or a write is in flight.
     * @param {{ onRemove: Function }} actions asks the host for the plan that would remove this entry.
     * @returns {object} the row.
     */
    function reviewEntryLine(t, siteId, index, blocked, actions) {
      return h(
        'div',
        { style: index === 0 ? S.scanLineFirst : S.scanLine, key: `entry-${siteId}` },
        h(
          'div',
          { style: S.scanRuleHead },
          h('span', { style: S.scanName, key: 'site' }, siteId),
          h(
            'div',
            { style: S.rowActions, key: 'actions' },
            h(
              'button',
              {
                type: 'button',
                key: 'remove',
                style: blocked ? { ...S.rowAction, ...S.rowActionBusy } : S.rowAction,
                disabled: blocked,
                onClick: () => actions.onRemove(siteId),
              },
              t('scan.remove'),
            ),
          ),
        ),
      )
    }

    /**
     * A write, in the states it may be in: the plan with its second button, the outcome the host
     * reported, and the refusal.
     *
     * All three writes share this one surface, because they share one protocol: one click never
     * writes, the first click asks only for the plan, and this draws it — the target, the rule or the
     * place it came from, then the host's own plan text, which names the absolute file and the exact
     * line — the panel does not restate a path it was not given. The second, distinct button
     * underneath is the write.
     *
     * The outcome is the host's text verbatim, so a write reports what it changed and where, and
     * "already suppressed, nothing written" reads as the no-op it is. A refusal takes its own sentence
     * and its own colour: it can never be mistaken for the outcome. What differs between the three is
     * only what they write, so only three strings and the caption differ — and the removal's caption
     * is the one that must never sound like a fix: it un-mutes a site, it does not repair it.
     *
     * @param {Function} t bound translator.
     * @param {{ status: string, kind: string, target: string, rule: string, place: string, text: string, message: string }} write
     * @param {Function} onConfirm applies the plan that is on screen.
     * @returns {object|null}
     */
    function renderWrite(t, write, onConfirm) {
      const ignore = write.kind === 'ignore'
      const remove = write.kind === 'remove'
      if (write.status === 'done') return h('div', { style: S.stateBody, key: 'write-done' }, asText(write.text))
      if (write.status === 'error') {
        return h(
          'div',
          { style: S.muteError, key: 'write-error' },
          ignore
            ? t('scan.ignoreFailed', { message: asText(write.message) })
            : remove
              ? t('scan.removeFailed', { message: asText(write.message) })
              : t('scan.muteFailed', { message: asText(write.message) }),
        )
      }
      if (write.status !== 'planning' && write.status !== 'plan' && write.status !== 'writing') return null
      const facts = [asText(write.target), asText(write.rule), asText(write.place)].filter((fact) => fact !== '')
      const plan = asText(write.text)
      // Disabled until the plan is on screen, and again while it is being applied: the second click is
      // only a click when there is a plan it can mean.
      const pending = write.status !== 'plan'
      return h(
        'div',
        { style: S.mutePlan, key: 'write-plan' },
        // The panel's own sentence for the write it is about to make, and the only prose in the box
        // that is ours: the host's plan stays verbatim underneath, because it is a command line's
        // answer and not something to re-word. Each write gets its own — an ignore makes the next
        // scan read less, a mute hides one site and moves no counter, a removal un-mutes it again —
        // so the three boxes read as three deliberate flows instead of one flow and two accidents.
        h(
          'div',
          { style: S.note, key: 'note' },
          ignore ? t('scan.ignoreNote') : remove ? t('scan.removeNote') : t('scan.muteNote'),
        ),
        facts.length === 0 ? null : h('div', { style: S.note, key: 'facts' }, facts.join(' · ')),
        plan === '' ? null : h('div', { style: S.note, key: 'plan' }, plan),
        h(
          'div',
          { style: S.scanActions, key: 'actions' },
          h(
            'button',
            {
              type: 'button',
              style: pending ? { ...S.action, ...S.actionBusy } : S.action,
              disabled: pending,
              onClick: onConfirm,
            },
            ignore ? t('scan.ignoreConfirm') : remove ? t('scan.removeConfirm') : t('scan.muteConfirm'),
          ),
        ),
      )
    }

    /**
     * What the scanner catches, plus the button that runs one.
     *
     * The section reads the counters the report carries — the last scan, the rules that matched, the
     * guides to load — and answers its own button with the result of *that* scan. The counters keep
     * their "ids, counts and the rule's own message, never a path, never a snippet" rule; only the
     * panel's own scan result lists its findings with their places, because there a person mutes one.
     * The chat row renders the findings of a call the session already made.
     *
     * @param {Function} t bound translator.
     * @param {object} report the normalized report.
     * @param {{ status: string, value?: object, message?: string }} scan the panel's own scan state.
     * @param {boolean} busy whether the report is still loading.
     * @param {{ onScan: Function, onMute: Function, onIgnore: Function, onConfirm: Function, write: object }} actions
     *   the scan's button and the two writes ADR-0003 allows.
     */
    function renderScanner(t, report, scan, busy, actions) {
      // The panel always passes the write state; the default is for a caller that renders the section
      // without one, which then draws no action at all.
      const write = actions.write ?? {
        status: 'idle',
        kind: 'suppress',
        target: '',
        rule: '',
        place: '',
        text: '',
        message: '',
      }
      // No second write while one is in flight, and none while a scan is starting: the answer to that
      // scan is about to replace the rows a write would have named.
      const running = scan.status === 'running'
      const writing = write.status === 'planning' || write.status === 'writing'
      const blocked = running || busy
      const last = report.lastScan
      // The last scan is one line: date, two counts, and — when the stored scan has them — how many
      // paths were skipped and whether the list was cut. Older state files carry neither, so the
      // line is simply shorter instead of guessing.
      const lastFacts =
        last === null
          ? []
          : [
              t('scanner.last', { when: last.at }),
              plural(t, 'file', last.files),
              plural(t, 'finding', last.findings),
            ]
      if (last !== null && last.skipped.total > 0) lastFacts.push(t('scanner.skipped', { count: last.skipped.total }))
      if (last !== null && last.truncated) lastFacts.push(t('scanner.cut'))
      // The scan's branch is one more fact in the same list, and only when the host recorded one: an
      // absent label adds nothing, so a non-git project or a 0.10.x state file keeps today's line.
      if (last !== null && last.branch !== null) {
        lastFacts.push(
          last.branch.kind === 'branch'
            ? t('scanner.branch', { branch: last.branch.name })
            : t('scanner.detached', { sha: last.branch.sha }),
        )
      }
      const children = [
        h(
          'div',
          { style: S.note, key: 'scan-summary' },
          lastFacts.length === 0 ? t('scanner.none') : lastFacts.join(' · '),
        ),
      ]
      // The comparison sits directly under the scan it compares: it is a claim about exactly those
      // two scans, so it stays next to the second one and never becomes a lifetime number.
      const comparison = diffLine(t, report.scanDiff)
      if (comparison !== null) children.push(h('div', { style: S.note, key: 'scan-diff' }, comparison))
      // A muted finding is still a finding, so its count sits beside the scan's own and is never taken
      // out of it. Both members have to be there: the panel names the rules the number belongs to and
      // invents neither. A state file written before phase C has neither, so the line is absent —
      // never a fabricated "0 suppressed".
      if (last !== null && last.suppressed > 0 && last.suppressedRules.length > 0) {
        children.push(
          h(
            'div',
            { style: S.note, key: 'scan-suppressed' },
            t('scan.suppressed', { count: last.suppressed, rules: ruleList(last.suppressedRules) }),
          ),
        )
      }
      // What the ignore file's own lines did: two counts, never a pattern, because the host keeps the
      // file's text on the machine that owns it. This is the only place the panel may call one line
      // idle, and it stays a sentence — a state file written before 0.12.0 has no block and draws no
      // line, so the panel never invents "0 patterns, 0 matched nothing" for a scan it cannot see.
      if (last !== null && last.ignoreUsage !== null) {
        children.push(
          h(
            'div',
            { style: S.note, key: 'scan-ignore-usage' },
            t('scanner.ignoreUsage', {
              patterns: plural(t, 'pattern', last.ignoreUsage.patterns),
              unused: last.ignoreUsage.unused,
            }),
          ),
        )
      }
      // The `.suppress` file's own review: the host's join of every entry against the sites its last
      // scan saw, as two counts and — only when it could prove them — the ids that matched nothing.
      // Three absences, each with its own rendering and none of them a zero: no block at all (a 0.11.0
      // document, or a file nobody could read) draws nothing; `unused: null` (an incomplete scan) draws
      // the numbers *without* an unused figure; an empty file draws nothing either, because a file
      // with no entry has nothing to review. Never "everything is unused", which is the claim this
      // block exists to make impossible.
      const review = last === null ? null : last.suppressions
      if (review !== null && review.entries > 0) {
        children.push(
          h(
            'div',
            { style: S.note, key: 'scan-review' },
            review.unused === null
              ? t('scanner.reviewUnknown', { entries: plural(t, 'entry', review.entries), matching: review.matching })
              : t('scanner.review', {
                  entries: plural(t, 'entry', review.entries),
                  matching: review.matching,
                  unused: review.unused.length,
                }),
          ),
        )
        if (review.unused !== null && review.unused.length > 0) {
          children.push(h('div', { style: S.scanCaption, key: 'scan-review-list' }, t('scanner.reviewList')))
          // The list is bounded rather than shortened: a box that scrolls keeps every entry's remove
          // action reachable, where slicing to five would silently put a file's 200th entry beyond a
          // person's reach while the header still counted it.
          children.push(
            h(
              'div',
              { style: S.reviewBox, key: 'scan-review-rows' },
              review.unused.map((siteId, index) =>
                reviewEntryLine(t, siteId, index, blocked || writing, actions),
              ),
            ),
          )
        }
      }
      // The removal's plan, confirmation and outcome sit directly under the review block — outside the
      // scroll box, so a confirmation can never be scrolled away from the button that means it, and
      // still drawn after the count reaches zero, because that is the answer to the click that got it
      // there. A `suppress` or `ignore` write is drawn beside its finding row further down.
      if (write.kind === 'remove') {
        const removalBlock = renderWrite(t, write, actions.onConfirm)
        if (removalBlock !== null) children.push(removalBlock)
      }
      if (report.topRules.length > 0) {
        children.push(h('div', { style: S.scanHeading, key: 'scan-rules-head' }, t('scanner.rules')))
        // The ranked rules are lifetime counters: they are not the {days} window the tiles above
        // show. Saying so costs one line; guessing either way would mislabel every number below.
        if (report.scanCountsScope === 'lifetime') {
          // The date is the host's string, rendered as given: the panel never formats a calendar for
          // a locale it does not know. Without one the caption is the 0.11.0 sentence unchanged — an
          // unrecorded origin must not become a dash, an empty pair or an invented "today" (E-1).
          const since = report.scanCountsSince === ''
            ? ''
            : ` · ${t('scanner.lifetimeSince', { date: report.scanCountsSince })}`
          children.push(
            h(
              'div',
              { style: S.scanCaption, key: 'scan-rules-scope' },
              `${t('scanner.lifetime', { days: report.periodDays })}${since}`,
            ),
          )
        }
        for (const [index, rule] of report.topRules.entries()) children.push(scanRuleLine(t, rule, index === 0))
      }
      // The ring is depth-bounded, not window-bounded: "did my fix land" must survive the 7/30
      // switch, which is why this block never claims to cover the window the tiles above show.
      if (report.scanHistory.length > 0) {
        children.push(h('div', { style: S.scanHeading, key: 'scan-history-head' }, t('scanner.history')))
        const shown = report.scanHistory.slice(0, MAX_HISTORY_ROWS)
        for (const [index, entry] of shown.entries()) children.push(scanHistoryLine(t, entry, index))
        if (report.scanHistory.length > shown.length) {
          children.push(
            h(
              'div',
              { style: S.scanCaption, key: 'scan-history-more' },
              t('scanner.historyMore', { count: report.scanHistory.length - shown.length }),
            ),
          )
        }
      }
      if (report.topScanGuides.length > 0) {
        children.push(h('div', { style: S.scanHeading, key: 'scan-guides-head' }, t('scanner.guides')))
        children.push(
          h(
            'div',
            { style: S.deadList, key: 'scan-guides' },
            report.topScanGuides.map((guide) => {
              const description = asText(guide.description)
              // The chip keeps `id (count)` as its visible text; the guide's own description is the
              // hint, so a reader learns what to load without a second line or a wider panel.
              return h(
                'span',
                { style: S.deadRow, key: `guide-${guide.name}`, title: description === '' ? guide.name : description },
                `${guide.name} (${guide.calls})`,
              )
            }),
          ),
        )
      }
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
              onClick: actions.onScan,
            },
            running ? t('scanner.scanning') : t('scanner.scan'),
          ),
        ),
      )
      if (scan.status === 'ready' && scan.value !== undefined) {
        const value = scan.value
        // The summary's facts, one clause each. A muted finding is still a finding, so its count is
        // added here and never taken out of the total above: the host counted it, and this panel does
        // not do arithmetic the host did not do. Only the rows it tagged can contribute the rules, so
        // a value without the tag gives no clause at all.
        const muted = value.findings.filter((finding) => finding.suppressed === true)
        const facts = [
          t('scan.summary', {
            files: plural(t, 'file', value.files),
            findings: plural(t, 'finding', value.findings.length),
          }),
        ]
        if (value.suppressed > 0 && muted.length > 0) {
          facts.push(t('scan.suppressed', { count: value.suppressed, rules: ruleList(ruleCounts(muted)) }))
        }
        children.push(h('div', { style: S.note, key: 'scan-result' }, facts.join(' · ')))
        // What the walk refused and whether it was cut: the two caveats that turn the counts above
        // from a claim into a report. Both are already in the value the command returned.
        if (value.skipped.total > 0) {
          children.push(h('div', { style: S.note, key: 'scan-skipped' }, skipLine(t, value.skipped, SKIP_REASONS_SHOWN)))
        }
        if (value.truncated) children.push(h('div', { style: S.stateBody, key: 'scan-truncated' }, t('scan.truncated')))
        if (value.rules.length > 0) {
          for (const [index, rule] of value.rules.entries()) children.push(scanRuleLine(t, rule, index === 0))
        } else {
          children.push(h('div', { style: S.note, key: 'scan-clean' }, t('scan.clean')))
        }
        // The findings themselves, one row per site, capped like the chat row. This is the only place
        // the panel lists a place, and it is the only place a write is offered: the suppression needs a
        // site and the ignore needs a path, so a value that carries neither — or a host that predates
        // phase C and sends no `siteId` — means no action at all, never a button that fails when pressed.
        const anchored = (finding) =>
          write.target !== '' &&
          (write.kind === 'ignore' ? asText(finding.path) === write.target : asText(finding.siteId) === write.target)
        let placed = false
        if (value.findings.length > 0) {
          const shownFindings = value.findings.slice(0, MAX_TOOL_ROWS)
          for (const [index, finding] of shownFindings.entries()) {
            children.push(findingLine(t, finding, index, blocked || writing, actions))
            // The plan, its confirmation and its outcome sit under the row they belong to, so a long
            // list cannot separate a confirmation from the finding it would write. One block, at the
            // first row that names the target: two rules can fire in one file, and the file is what an
            // ignore names.
            if (placed === false && anchored(finding)) {
              children.push(renderWrite(t, write, actions.onConfirm))
              placed = true
            }
          }
          const rest = value.findings.length - shownFindings.length
          if (rest > 0) children.push(h('div', { style: S.note, key: 'scan-more' }, t('row.more', { count: rest })))
        }
        // A plan whose row fell outside the cap is still shown, at the end rather than not at all. A
        // removal has no finding row at all — its entry matched nothing, which is what it is — so it
        // was drawn under the review block above and must not be drawn a second time here.
        if (placed === false && write.kind !== 'remove') {
          const block = renderWrite(t, write, actions.onConfirm)
          if (block !== null) children.push(block)
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
          const place = findingPlace(finding)
          // Sixteen findings and no room for a second line each: the rule's message and the matched
          // snippet live in the two cells' tooltips, so the table stays a table and a reader can
          // still ask a row what it means and what it caught.
          const ruleHint = asText(finding.message)
          const placeHint = asText(finding.snippet)
          // A muted finding keeps its four cells and its place: the tag rides inside the rule cell as
          // a word, so the grid does not shift and colour is never the only signal, and the row is
          // dimmed as well. It is still a finding — the header's count does not change.
          const muted = finding.suppressed === true
          body.push(
            h(
              'div',
              { style: muted ? { ...T.row, ...T.muted } : T.row, key: `finding-${index}`, title: place },
              h(
                'span',
                { style: T.rule, title: ruleHint === '' ? finding.ruleId : ruleHint },
                muted ? `${finding.ruleId} ${t('scan.suppressedTag')}` : finding.ruleId,
              ),
              h('span', { style: T.place, title: placeHint === '' ? place : placeHint }, place),
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
      // One line under the table when the suppression file could not be read at all: the token is the
      // host's, raw like a skip reason, and it says nothing was muted so the table cannot suggest
      // otherwise. A pre-C result carries no problems and prints no line.
      const suppressionProblem = value.suppressProblems.find((row) => row.key === '')
      if (suppressionProblem !== undefined) {
        body.push(
          h(
            'div',
            { style: T.note, key: 'suppress-problem' },
            t('scan.suppressProblem', { reason: suppressionProblem.reason }),
          ),
        )
      }
      if (value.skipped.total > 0) {
        body.push(h('div', { style: T.note, key: 'skipped' }, skipLine(t, value.skipped, SKIP_REASONS_SHOWN)))
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
     * The panel. It is read-only apart from two command lines: the header picks the window and the
     * workspace whose counters are on screen, Refresh re-runs the counters command, and the scan
     * button asks the host to scan the workspace folder. The one write (ADR-0003) is the mute action:
     * it asks for a plan, shows it, and only a second, distinct click appends the entry.
     * Every subscription it starts is component-local, so unmounting it releases them.
     */
    function GuidancePanel(props) {
      const t = props.t
      const bridge = props.bridge
      const sessionId = props.useSessions(selectSessionId)
      const [state, setState] = useState({ status: 'loading', report: undefined, json: '', code: '', message: '', at: 0 })
      const [days, setDays] = useState(PERIODS[0])
      // '' is "no pick yet": the command answers for this session's workspace by itself, and the
      // report's own `workspace` then says which one that was.
      const [workspace, setWorkspace] = useState('')
      const [scan, setScan] = useState({ status: 'idle', value: undefined, message: '' })
      // The two writes, as one small state machine: `planning` asks for the plan, `plan` is on screen,
      // `writing` applies it, `done` carries the host's outcome, `error` its refusal. `idle` draws
      // nothing at all, and no state of it is reachable without a plan having been asked for. `kind`
      // says which of the two it is: the suppression names a site, the ignore names a path.
      const [write, setWrite] = useState({
        status: 'idle',
        kind: 'suppress',
        target: '',
        rule: '',
        place: '',
        text: '',
        message: '',
      })
      // The copy action has four states and no other surface: the button's own label says which —
      // `idle`, `done`, `failed` (the write refused) and `timeout` (it never answered). The last two
      // are different sentences because they are different facts, and only `done` may claim a copy.
      const [copied, setCopied] = useState('idle')
      const alive = useRef(true)
      // Every load takes a ticket; a response whose ticket is no longer current is dropped, so
      // switching the window mid-request shows the answer to the window the user ended up on.
      const ticket = useRef(0)
      const scanTicket = useRef(0)
      const writeTicket = useRef(0)
      // Which copy click owns the label: a timeout from an abandoned attempt must not overwrite the
      // answer of the one the user is now waiting on.
      const copyTicket = useRef(0)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(() => {
        if (bridge === undefined || typeof bridge.call !== 'function') {
          setState({ status: 'error', report: undefined, json: '', code: 'bridge', message: '', at: 0 })
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState({ status: 'error', report: undefined, json: '', code: 'session', message: '', at: 0 })
          return
        }
        const mine = ticket.current + 1
        ticket.current = mine
        setState((previous) => ({ ...previous, status: 'loading' }))
        // A copy is about the report that was on screen, so a new load takes the answer back to idle
        // while the previous JSON is still what the button would hand over.
        setCopied('idle')
        let pending
        try {
          pending = Promise.resolve(bridge.call(sessionId, reportLine(days, workspace)))
        } catch (error) {
          pending = Promise.reject(error)
        }
        pending
          .then((envelope) => {
            if (!alive.current || ticket.current !== mine) return
            const { report, json } = readEnvelope(envelope)
            setState({ status: 'ready', report, json, code: '', message: '', at: Date.now() })
          })
          .catch((error) => {
            if (!alive.current || ticket.current !== mine) return
            const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'call'
            setState({ status: 'error', report: undefined, json: '', code, message: messageOf(error), at: 0 })
          })
      }, [bridge, sessionId, days, workspace])

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

      /**
       * Ask the host what one write would do. Nothing is written by this click.
       *
       * The answer is the plan ([ADR-0003](docs/adr/0003-write-surface.md) §4): the absolute target
       * file, the exact entry, whether the file exists and what it would cover. It is shown verbatim —
       * the host is what will write it, so the panel does not restate a path it was not given — and the
       * target the click came from is put beside it, so the plan is about a named site or path rather
       * than about an opaque id.
       *
       * Both writes go through this one function, because they are one protocol: the only thing the
       * `kind` changes is which command line is asked and which facts the caption carries.
       *
       * @param {string} kind `suppress`, `ignore` or `remove`.
       * @param {object} row the row the click came from: a finding for the first two, an unused entry
       *   (`{ id }`) for a removal.
       * @returns {void}
       */
      const requestWrite = useCallback(
        (kind, row) => {
          // The row drew this action only for a row carrying the target it needs, and reading it
          // again here is what keeps the command line provably the row's own target.
          const ignore = kind === 'ignore'
          const remove = kind === 'remove'
          const target = remove ? asText(row.id) : ignore ? asText(row.path) : asText(row.siteId)
          // For an ignore the place *is* the target, so the caption would repeat itself; the rule
          // belongs to the suppressed site, not to the path. A removal names an entry the scan could
          // not place at all, so it has neither a path nor a rule to put beside the id.
          const rule = ignore || remove ? '' : asText(row.ruleId)
          const place = ignore || remove ? '' : findingPlace(row)
          const blank = { kind, target, rule, place, text: '', message: '' }
          if (bridge === undefined || typeof bridge.call !== 'function') {
            setWrite({ ...blank, status: 'error', message: t('error.bridge') })
            return
          }
          if (typeof sessionId !== 'string' || sessionId === '') {
            setWrite({ ...blank, status: 'error', message: t('error.session') })
            return
          }
          const mine = writeTicket.current + 1
          writeTicket.current = mine
          // `--dry-run` answers the plan and writes nothing; the second, distinct button below is what
          // appends the entry or removes it.
          const line = remove
            ? removeLine(target, true)
            : ignore
              ? scanIgnoreLine(target, true)
              : suppressLine(target, true)
          setWrite({ ...blank, status: 'planning' })
          let pending
          try {
            pending = Promise.resolve(bridge.call(sessionId, line))
          } catch (error) {
            pending = Promise.reject(error)
          }
          pending
            .then((envelope) => {
              if (!alive.current || writeTicket.current !== mine) return
              setWrite({ ...blank, status: 'plan', text: readWriteEnvelope(envelope, line) })
            })
            .catch((error) => {
              if (!alive.current || writeTicket.current !== mine) return
              setWrite({ ...blank, status: 'error', message: messageOf(error) })
            })
        },
        [bridge, sessionId, t],
      )

      const requestMute = useCallback((finding) => requestWrite('suppress', finding), [requestWrite])
      const requestIgnore = useCallback((finding) => requestWrite('ignore', finding), [requestWrite])
      const requestRemove = useCallback((siteId) => requestWrite('remove', { id: siteId }), [requestWrite])

      /**
       * Apply the plan that is on screen: the same command without `--dry-run`.
       *
       * The line is rebuilt from the plan's own target, so the click can only ever confirm the plan the
       * person read. Its answer is shown verbatim — a success reports the entry it appended or removed
       * and says that a removal is not a fix, the "already present, nothing written" no-op says exactly
       * that — and a refusal is an error, never an outcome.
       */
      const confirmWrite = useCallback(() => {
        if (write.status !== 'plan') return
        const kind = write.kind
        const ignore = kind === 'ignore'
        const remove = kind === 'remove'
        const target = asText(write.target)
        const rule = asText(write.rule)
        const place = asText(write.place)
        const blank = { kind, target, rule, place, text: '', message: '' }
        if (bridge === undefined || typeof bridge.call !== 'function') {
          setWrite({ ...blank, status: 'error', message: t('error.bridge') })
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          setWrite({ ...blank, status: 'error', message: t('error.session') })
          return
        }
        const mine = writeTicket.current + 1
        writeTicket.current = mine
        const line = remove
          ? removeLine(target, false)
          : ignore
            ? scanIgnoreLine(target, false)
            : suppressLine(target, false)
        setWrite({ ...blank, status: 'writing', text: write.text })
        let pending
        try {
          pending = Promise.resolve(bridge.call(sessionId, line))
        } catch (error) {
          pending = Promise.reject(error)
        }
        pending
          .then((envelope) => {
            if (!alive.current || writeTicket.current !== mine) return
            setWrite({ ...blank, status: 'done', text: readWriteEnvelope(envelope, line) })
            // The report is refetched rather than adjusted: the counts are the host's, and the scan's
            // own value cannot be re-read — a write is not a scan and changes no counter.
            load()
          })
          .catch((error) => {
            if (!alive.current || writeTicket.current !== mine) return
            setWrite({ ...blank, status: 'error', message: messageOf(error) })
          })
      }, [bridge, sessionId, load, write, t])

      /**
       * Hand the report's own JSON to the clipboard.
       *
       * No host call, no file write, no second data path: what is copied is the object the panel
       * already received, pretty-printed. The button's label is the whole report — `JSON copied`, or
       * the named failure (`The clipboard refused`, `The clipboard did not answer`) — because the
       * action is small enough that a sentence beside it would be the larger part of it.
       *
       * The wait is bounded (`COPY_TIMEOUT_MS`): a write that never settles gets the same visible
       * answer as one that was refused, because "we did not see it land" is exactly what the panel
       * knows. A late success does not flip the label afterwards — the user has already been told it
       * failed and pressed it again — and `copyTicket` keeps an old attempt's timeout from overwriting
       * the answer of a newer click.
       *
       * @returns {void}
       */
      const copyReport = useCallback(() => {
        const clipboard = clipboardOf()
        const json = typeof state.json === 'string' ? state.json : ''
        if (clipboard === undefined || json === '') return
        const mine = copyTicket.current + 1
        copyTicket.current = mine
        let pending
        try {
          pending = Promise.resolve(clipboard(json))
        } catch (error) {
          pending = Promise.reject(error)
        }
        // Whichever happens first is the answer: the write landing, the write refusing, or the wait
        // running out. `timeout` is a failure of its own — it says the clipboard did not answer,
        // which is true whether or not the parked write eventually lands.
        let timer
        const timedOut = new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), COPY_TIMEOUT_MS)
        })
        const answer = (outcome) => {
          if (timer !== undefined) clearTimeout(timer)
          if (alive.current && copyTicket.current === mine) setCopied(outcome)
        }
        Promise.race([pending.then(() => 'done'), timedOut]).then(answer, () => answer('failed'))
      }, [state.json])

      const busy = state.status === 'loading'
      // What the scanner section may ask for: its own scan, the two writes ADR-0003 allows and the
      // removal ADR-0004 widened it to — the latter three only ever through the plan-then-confirm
      // pair above.
      const scannerActions = {
        onScan: runScan,
        onMute: requestMute,
        onIgnore: requestIgnore,
        onRemove: requestRemove,
        onConfirm: confirmWrite,
        write,
      }
      // The copy action exists only when there is something to copy and a clipboard to copy it to: a
      // page without one renders exactly the header it always did, never a button that cannot work.
      const canCopy = state.status === 'ready' && state.json !== '' && clipboardOf() !== undefined
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
        renderWorkspace(t, state.report, workspace, setWorkspace),
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
        canCopy
          ? h(
              'button',
              { type: 'button', style: S.action, onClick: copyReport },
              // Four states, and no fifth: the label is the whole report, so each one has to be a
              // sentence that is true when it is on screen.
              copied === 'done'
                ? t('copy.done')
                : copied === 'failed'
                  ? t('copy.failed')
                  : copied === 'timeout'
                    ? t('copy.timeout')
                    : t('copy.json'),
            )
          : null,
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
                renderScanner(t, report, scan, busy, scannerActions),
              )
            : h(
                React.Fragment,
                null,
                renderKpis(t, report),
                renderSeries(t, report),
                renderBreakdown(t, report),
                renderScanner(t, report, scan, busy, scannerActions),
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
