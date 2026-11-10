/**
 * The legacy-scan rule table for `web_guidance_legacy_scan`.
 *
 * Thirty hand-written markers, each pointing at the guide that explains the modern
 * replacement. This is deliberately not a port of upstream's analyzer: upstream detects
 * these patterns with the TypeScript compiler, so its rules cannot be reused as data —
 * see `docs/notes/legacy-scan-feasibility.md` for the measurement behind that claim.
 * A marker here has to be honest on its own: if the pattern also appears in ordinary
 * modern code, the rule is either `low` confidence or it is not in the table.
 *
 * Matching contract: `source` is a RegExp *source* string with no flags. The scanner
 * compiles `new RegExp(source, 'g')` once and matches line by line, so `^` and `$`
 * anchor to the line and no flag may be baked in. Ids are stable: telemetry, the panel
 * and `/guidance-stats` all quote them.
 */

/**
 * @typedef {object} ScanRule
 * @property {string} id stable rule id, `ls-01` … `ls-30`
 * @property {string | null} guideId guide in `data/guides.json`, or null when no guide owns the marker
 * @property {'high' | 'medium' | 'low'} confidence `high` when the marker alone is conclusive
 * @property {string} message one imperative sentence naming the modern replacement
 * @property {string} source RegExp source without flags, matched per line
 */

/** Confidence values, strongest first. Used for sorting findings and for the panel column. */
export const CONFIDENCE_ORDER = Object.freeze(['high', 'medium', 'low'])

/**
 * Ordered rule table. Ids run `ls-01` … `ls-30`; CSS markers come first, then HTML/DOM
 * structure, then the JavaScript library and API markers, so a report reads top-down by
 * layer. Every non-null `guideId` is a real catalog entry — `test/scan-rules.test.mjs`
 * fails if a rename ever breaks that.
 *
 * @type {readonly ScanRule[]}
 */
export const RULES = Object.freeze([
  {
    id: 'ls-01',
    guideId: 'customize-scrollbar-color-and-thickness',
    confidence: 'high',
    message: 'Use scrollbar-color and scrollbar-width instead of the vendor ::-webkit-scrollbar pseudo-elements.',
    source: '-webkit-scrollbar',
  },
  {
    id: 'ls-02',
    guideId: 'deliver-optimized-decorative-images',
    confidence: 'high',
    message: 'Use the standard image-set() with a type()/resolution list instead of the -webkit-image-set() prefix.',
    source: '-webkit-image-set\\(\\s*[\'"]',
  },
  {
    id: 'ls-03',
    guideId: 'soft-edge-content-fade',
    confidence: 'high',
    message: 'Add the unprefixed mask-image: linear-gradient(…) alongside the -webkit-mask prefixed declaration.',
    source: '-webkit-mask(?:-image)?\\s*:\\s*linear-gradient',
  },
  {
    id: 'ls-04',
    guideId: 'custom-text-decorations',
    confidence: 'high',
    message: 'Use text-decoration, text-decoration-thickness and text-underline-offset instead of the -webkit-text-emphasis prefix or a border-bottom underline hack.',
    source: '-webkit-text-(?:emphasis|decoration)',
  },
  {
    id: 'ls-05',
    guideId: 'dynamic-sibling-animations',
    confidence: 'medium',
    message: 'Replace repeated :nth-child(N) delay rules with sibling-index() and sibling-count().',
    source: ':nth-(?:child|of-type)\\(\\s*\\d+\\s*\\)',
  },
  {
    id: 'ls-06',
    guideId: 'icons',
    confidence: 'high',
    message: 'Use a CSS mask icon with background-color: currentColor instead of chaining invert(), sepia() and hue-rotate() filters.',
    source: 'filter\\s*:[^;{}]*(?:hue-rotate|sepia)\\(',
  },
  {
    id: 'ls-07',
    guideId: 'checkbox',
    confidence: 'medium',
    message: 'Style the native input with accent-color or appearance: none instead of hiding it and drawing a replacement box with an adjacent-sibling selector.',
    source: 'input\\[type=[\'"]?checkbox[\'"]?\\]\\s*\\+',
  },
  {
    id: 'ls-08',
    guideId: 'validate-input-after-interaction',
    confidence: 'medium',
    message: 'Use :user-invalid so error styling appears only after interaction instead of styling :invalid (including :not(:focus):invalid workarounds).',
    source: ':invalid\\b',
  },
  {
    id: 'ls-09',
    guideId: 'animate-to-intrinsic-sizes',
    confidence: 'medium',
    message: 'Animate height with interpolate-size: allow-keywords or calc-size() instead of transitioning max-height to fake an intrinsic size.',
    source: 'transition(?:-property)?\\s*:[^;{}]*\\bmax-height\\b',
  },
  {
    id: 'ls-10',
    guideId: 'dark-mode',
    confidence: 'medium',
    message: 'Declare color-scheme: light dark and use light-dark() instead of overriding colours inside @media (prefers-color-scheme: dark).',
    source: '@media[^{]*prefers-color-scheme',
  },
  {
    id: 'ls-11',
    guideId: 'dark-mode-toggle',
    confidence: 'medium',
    message: 'Update <meta name="color-scheme"> and CSS color-scheme instead of toggling a dark class or a data-theme attribute from a stored preference.',
    source: 'classList\\.(?:add|remove|toggle)\\(\\s*[\'"]dark[\'"]|data-theme=[\'"](?:dark|light)[\'"]',
  },
  {
    id: 'ls-12',
    guideId: 'css-layout',
    confidence: 'high',
    message: 'Use unprefixed display: flex and gap instead of the 2009 -webkit-box flexbox syntax.',
    source: 'display\\s*:\\s*-webkit-(?:box|flex)\\b|-webkit-box-(?:orient|pack|align)\\s*:',
  },
  {
    id: 'ls-13',
    guideId: 'dialog',
    confidence: 'low',
    message: 'Use a native <dialog> with showModal() instead of a div with a "modal" class driven by script.',
    source: 'class=[\'"][^\'"]*\\bmodal\\b',
  },
  {
    id: 'ls-14',
    guideId: 'declarative-dialog-popover-control',
    confidence: 'medium',
    message: 'Use <dialog> with showModal() and declarative command/closedby attributes instead of data-toggle="modal" wiring.',
    source: 'data-(?:bs-)?toggle=[\'"](?:modal|dialog)[\'"]',
  },
  {
    id: 'ls-15',
    guideId: 'progress',
    confidence: 'high',
    message: 'Use the native <progress> element with accent-color instead of a role="progressbar" div with aria-valuenow.',
    source: 'role=[\'"]progressbar[\'"]',
  },
  {
    id: 'ls-16',
    guideId: 'sanitize-untrusted-html',
    confidence: 'low',
    message: 'Use Element.setHTML() (or the Sanitizer API) instead of assigning a string to .innerHTML.',
    source: '\\.innerHTML\\s*=(?!=)',
  },
  {
    id: 'ls-17',
    guideId: 'html',
    confidence: 'medium',
    message: 'Build the DOM with createElement/append instead of document.write(), which discards the parsed document.',
    source: 'document\\.write(?:ln)?\\s*\\(',
  },
  {
    id: 'ls-18',
    guideId: 'copy-button',
    confidence: 'medium',
    message: 'Use navigator.clipboard.writeText() instead of document.execCommand("copy").',
    source: 'document\\.execCommand\\s*\\(',
  },
  {
    id: 'ls-19',
    guideId: 'slider',
    confidence: 'high',
    message: 'Use a native <input type="range"> with accent-color instead of noUiSlider.create().',
    source: 'noUiSlider',
  },
  {
    id: 'ls-20',
    guideId: 'interest-triggered-tooltips',
    confidence: 'high',
    message: 'Use popover with interest-triggered previews instead of a tippy() or new Popper() tooltip library.',
    source: '\\btippy(?:js)?\\s*\\(|new\\s+Popper\\s*\\(',
  },
  {
    id: 'ls-21',
    guideId: 'scroll-entry-exit-effects',
    confidence: 'high',
    message: 'Use CSS scroll-driven animations with animation-timeline: view() and animation-range: entry, exit instead of AOS, ScrollReveal or WOW.',
    source: '\\bAOS\\.init\\s*\\(|\\bScrollReveal\\s*\\(|new\\s+WOW\\s*\\(',
  },
  {
    id: 'ls-22',
    guideId: 'equal-width-text-lines',
    confidence: 'high',
    message: 'Use text-wrap: balance or text-wrap: pretty instead of fitty, fitText, balanceText or Balancer.',
    source: '\\b(?:fitty|fitText|balanceText|Balancer)\\s*\\(',
  },
  {
    id: 'ls-23',
    guideId: 'scrollspy',
    confidence: 'high',
    message: 'Use CSS scroll-target-group: auto with :target-current instead of data-spy or data-bs-spy="scroll" attributes.',
    source: 'data-(?:bs-)?spy=[\'"]scroll[\'"]',
  },
  {
    id: 'ls-24',
    guideId: 'flicker-free-client-side-ab-testing',
    confidence: 'high',
    message: 'Use <script async blocking="render"> in <head> instead of an .async-hide anti-flicker snippet.',
    source: '\\basync-hide\\b|\\bab-loading\\b',
  },
  {
    id: 'ls-25',
    guideId: 'secure-external-subresources',
    confidence: 'medium',
    message: 'Add integrity, crossorigin="anonymous" and referrerpolicy="no-referrer" — or self-host — for third-party CDN assets.',
    source: 'https?://(?:cdnjs\\.cloudflare\\.com|cdn\\.jsdelivr\\.net|unpkg\\.com)/',
  },
  {
    id: 'ls-26',
    guideId: 'calculate-event-differentials',
    confidence: 'high',
    message: 'Format durations with Intl.DurationFormat instead of humanizeDuration, prettyMs or moment.duration().',
    source: '\\b(?:humanizeDuration|prettyMs)\\s*\\(|\\b(?:moment|dayjs)\\.duration\\s*\\(',
  },
  {
    id: 'ls-27',
    guideId: 'child-state-based-styling',
    confidence: 'medium',
    message: 'Use :has() child-state selectors instead of walking to the parent and toggling a class with jQuery.',
    source: '\\.(?:parent|parents)\\(\\)\\.(?:add|remove|toggle)Class\\s*\\(',
  },
  {
    id: 'ls-28',
    guideId: 'form-fields-automatically-fit-contents',
    confidence: 'medium',
    message: 'Use CSS field-sizing: content instead of copying scrollHeight into an inline height on every input event.',
    source: 'style\\.(?:height|minHeight)\\s*=[^;{}]*scrollHeight',
  },
  {
    id: 'ls-29',
    guideId: 'ime-safe-enter-submit',
    confidence: 'medium',
    message: 'Use event.key with an event.isComposing guard instead of the deprecated keyCode/which === 13 check.',
    source: '\\b(?:keyCode|which)\\s*===?\\s*13\\b',
  },
  {
    id: 'ls-30',
    guideId: 'web-components',
    confidence: 'high',
    message: 'Define custom elements with customElements.define() instead of the removed document.registerElement().',
    source: 'document\\.registerElement\\s*\\(',
  },
])

/** Id → rule lookup, so `ruleById` and `selectRules` stay linear. */
const BY_ID = new Map(RULES.map((rule) => [rule.id, rule]))

/**
 * Resolve the `rules` argument of the tool call.
 *
 * Unknown ids are reported back instead of throwing: the tool returns them to the model as
 * `unknown-rules`, so one typo cannot abort a scan. `undefined` (or anything that is not an
 * array) means every rule; duplicates collapse and the caller's order is preserved.
 *
 * @param {readonly string[] | undefined} ids
 * @returns {{ rules: ScanRule[], unknown: string[] }}
 */
export function selectRules(ids) {
  if (!Array.isArray(ids)) return { rules: [...RULES], unknown: [] }

  const rules = []
  const unknown = []
  const seen = new Set()

  for (const id of ids) {
    if (typeof id !== 'string') {
      const label = String(id)
      if (!seen.has(label)) {
        seen.add(label)
        unknown.push(label)
      }
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const rule = BY_ID.get(id)
    if (rule) rules.push(rule)
    else unknown.push(id)
  }

  return { rules, unknown }
}

/**
 * One rule by id, or `undefined` when the id is not in the table.
 *
 * @param {string} id
 * @returns {ScanRule | undefined}
 */
export function ruleById(id) {
  if (typeof id !== 'string') return undefined
  return BY_ID.get(id)
}
