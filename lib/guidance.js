/**
 * Offline guide index for the Modern Web Guidance plugin.
 *
 * Reads the bundled `data/guides.json` catalog plus the guide markdown files and
 * builds a small in-memory BM25 index on first use. No network access, no model,
 * no native dependencies: the plugin ships its corpus and searches it locally.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * Upstream's guides cross-reference each other with the upstream CLI, e.g.
 * `npx -y modern-web-guidance@latest retrieve "dialog"`. Returning that text verbatim asks the
 * agent to fetch and execute an unpinned remote package, so the reference is rewritten to this
 * plugin's own tool call when the corpus is loaded. The markdown files on disk stay untouched, so
 * they keep matching the pinned upstream snapshot byte for byte.
 */
const CLI_REFERENCE = /npx -y modern-web-guidance@latest retrieve "([a-z0-9-]+)"/g

/** Guide ids and categories are slugs; anything else is not a legitimate catalog entry. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/

const MAX_QUERY_CHARS = 512
const MAX_QUERY_TERMS = 24
const MAX_RETRIEVE_IDS = 10
const MAX_RETRIEVE_CHARS = 120_000
const MAX_ID_LENGTH = 80
const MAX_UNKNOWN_REPORTED = 10
const MAX_PREFIX_EXPANSIONS = 200

function normalizeGuideText(markdown) {
  return markdown.replace(CLI_REFERENCE, 'web_guidance_retrieve({"ids":["$1"]})')
}

/** Category filters are forgiving: " CSS " and "Css" mean the same thing as "css". */
function normalizeCategory(value) {
  if (typeof value !== 'string') return undefined
  const category = value.trim().toLowerCase()
  return category === '' ? undefined : category
}

/**
 * Result count. The schema says 1..25, so a numeric argument is clamped into that range instead of
 * silently meaning "default" (0 used to become 8); only a missing or non-numeric argument defaults.
 */
function normalizeLimit(value) {
  if (value === undefined || value === null) return 8
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(numeric)) return 8
  return Math.min(Math.max(Math.floor(numeric), 1), 25)
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my',
  'no', 'not', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then',
  'there', 'these', 'they', 'this', 'to', 'up', 'use', 'using', 'was', 'we',
  'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with',
  'you', 'your',
])

const FIELD_WEIGHTS = {
  title: 3,
  id: 3,
  description: 2.5,
  features: 2.5,
  headings: 1.5,
  body: 1,
}

// Rank bonuses that keep an exact guide from losing to a broader guide whose
// body merely repeats the query words many times.
const ID_CONTAINMENT_BONUS = 10
const TITLE_CONTAINMENT_BONUS = 6
const DESCRIPTION_CONTAINMENT_BONUS = 2

const BM25_K1 = 1.2
const BM25_B = 0.75

/** Crude English stemmer, deliberately small: enough to fold plurals and common suffixes. */
export function stem(term) {
  let value = term
  if (value.length <= 4) return value
  if (value.endsWith('ies') && value.length > 5) value = `${value.slice(0, -3)}y`
  else if (value.endsWith('sses')) value = value.slice(0, -2)
  else if (value.endsWith('s') && !value.endsWith('ss') && !value.endsWith('us')) value = value.slice(0, -1)
  if (value.endsWith('ing') && value.length > 5) value = value.slice(0, -3)
  else if (value.endsWith('ed') && value.length > 5) value = value.slice(0, -2)
  if (value.endsWith('ion') && value.length > 6) value = value.slice(0, -3)
  if (value.endsWith('ment') && value.length > 6) value = value.slice(0, -4)
  if (value.endsWith('e') && value.length > 6) value = value.slice(0, -1)
  return value
}

/** Split text into lowercase search terms, dropping stopwords and single letters. */
function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const raw = text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g)
  if (raw === null) return []
  const terms = []
  for (const token of raw) {
    for (const part of token.split(/[.+#-]+/)) {
      if (part.length < 2) continue
      if (STOPWORDS.has(part)) continue
      terms.push(part)
    }
  }
  return terms
}

/** Searchable tokens plus their stems. */
function analyze(text) {
  const terms = []
  for (const term of tokenize(text)) {
    terms.push(term)
    const stemmed = stem(term)
    if (stemmed !== term) terms.push(stemmed)
  }
  return terms
}

function stemSet(text) {
  return new Set(tokenize(text).map(stem))
}

/**
 * Feature ids from a manifest gate list. Upstream writes objects (`{id, ...}`); a plain string is
 * accepted too, so a hand-edited catalog still annotates the guide instead of failing the index.
 * Malformed items are ignored rather than thrown: an annotation must never take the tools down.
 */
function gateFeatureIds(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  for (const item of value) {
    const id = typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : ''
    if (id !== '') ids.push(id)
  }
  return [...new Set(ids)]
}

/**
 * A short markdown warning for a guide whose platform feature is an Origin Trial or a volatile one.
 * It is prepended to the returned body only; the file on disk stays byte-identical to upstream.
 */
function experimentalBanner({ originTrials, volatileFeatures }) {
  const groups = []
  if (originTrials.length > 0) {
    groups.push(`Origin Trial feature(s) ${originTrials.map((id) => `\`${id}\``).join(', ')}`)
  }
  if (volatileFeatures.length > 0) {
    groups.push(`volatile feature(s) ${volatileFeatures.map((id) => `\`${id}\``).join(', ')}`)
  }
  if (groups.length === 0) return ''
  return `> [!WARNING]\n> Experimental: ${groups.join('; ')}. Check availability before relying on this guide.\n\n`
}

/** First markdown heading of a guide, used as its display title. */
function titleOf(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match === null ? fallback : match[1].trim()
}

/** `##` / `###` headings joined into one searchable string. */
function headingsOf(markdown) {
  const out = []
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ') || line.startsWith('### ')) out.push(line.replace(/^#+\s+/, ''))
  }
  return out.join(' ')
}

function addField(terms, text, weight) {
  for (const term of analyze(text)) {
    terms.set(term, (terms.get(term) ?? 0) + weight)
  }
}

function slugFromPhrase(phrase) {
  return phrase.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function overlap(needles, haystack) {
  if (needles.size === 0) return 0
  let hits = 0
  for (const needle of needles) if (haystack.has(needle)) hits += 1
  return hits / needles.size
}

/**
 * Create a searcher over the bundled corpus.
 * @param {{dataDir: string}} options absolute path of the plugin `data` directory.
 */
export function createGuidance({ dataDir }) {
  const dataRoot = resolve(dataDir)
  let indexPromise

  async function readEntry(entry) {
    if (typeof entry?.id !== 'string' || !SLUG.test(entry.id)) {
      throw new Error(`invalid guide id in guides.json: ${JSON.stringify(entry?.id)}`)
    }
    if (typeof entry.category !== 'string' || !SLUG.test(entry.category)) {
      throw new Error(`invalid category for guide "${entry.id}": ${JSON.stringify(entry.category)}`)
    }
    const relative = join('guides', entry.category, `${entry.id}.md`)
    const absolute = resolve(dataRoot, relative)
    // Defence in depth: catalog values reach a filesystem path, so refuse anything that resolves
    // outside the bundled data directory even if the catalog was tampered with.
    if (!absolute.startsWith(`${dataRoot}${sep}`)) {
      throw new Error(`guide path escapes the data directory: "${entry.id}"`)
    }
    let raw
    try {
      raw = await readFile(absolute, 'utf8')
    } catch (cause) {
      // Node's message carries the absolute install path; keep that out of tool output.
      throw new Error(`guide "${entry.id}" could not be read from the bundled data`, { cause })
    }
    const markdown = normalizeGuideText(raw)
    const title = titleOf(markdown, entry.id)
    const originTrials = gateFeatureIds(entry.originTrials)
    const volatileFeatures = gateFeatureIds(entry.volatileFeatures)
    const terms = new Map()
    addField(terms, title, FIELD_WEIGHTS.title)
    addField(terms, entry.id, FIELD_WEIGHTS.id)
    addField(terms, entry.description ?? '', FIELD_WEIGHTS.description)
    addField(terms, (entry.featuresUsed ?? []).join(' '), FIELD_WEIGHTS.features)
    addField(terms, headingsOf(markdown), FIELD_WEIGHTS.headings)
    addField(terms, markdown, FIELD_WEIGHTS.body)
    return {
      id: entry.id,
      title,
      category: entry.category,
      description: entry.description ?? '',
      featuresUsed: entry.featuresUsed ?? [],
      tokenCount: entry.tokenCount ?? Math.round(markdown.length / 4),
      originTrials,
      volatileFeatures,
      experimental: originTrials.length > 0 || volatileFeatures.length > 0,
      relative,
      markdown,
      weight: [...terms.values()].reduce((sum, value) => sum + value, 0),
      terms,
      idStems: stemSet(entry.id),
      titleStems: stemSet(title),
      descriptionStems: stemSet(entry.description ?? ''),
    }
  }

  async function buildIndex() {
    let catalogText
    try {
      catalogText = await readFile(join(dataRoot, 'guides.json'), 'utf8')
    } catch (cause) {
      throw new Error('the bundled guide catalog could not be read', { cause })
    }
    let catalog
    try {
      catalog = JSON.parse(catalogText)
    } catch (cause) {
      throw new Error('the bundled guide catalog is not valid JSON', { cause })
    }
    if (!Array.isArray(catalog)) throw new Error('the bundled guide catalog must be an array')
    const docs = await Promise.all(catalog.map(readEntry))
    const byId = new Map()
    const bySlug = new Map()
    const byTerm = new Map()
    for (let position = 0; position < docs.length; position += 1) {
      const doc = docs[position]
      if (byId.has(doc.id)) throw new Error(`duplicate guide id in guides.json: "${doc.id}"`)
      byId.set(doc.id, doc)
      bySlug.set(slugFromPhrase(doc.id), doc)
      for (const [term, weight] of doc.terms) {
        let posting = byTerm.get(term)
        if (posting === undefined) {
          posting = []
          byTerm.set(term, posting)
        }
        posting.push([position, weight])
      }
    }
    const averageWeight = docs.reduce((sum, doc) => sum + doc.weight, 0) / Math.max(docs.length, 1)
    // Sorted once so prefix expansion is a binary-search range instead of a full vocabulary scan.
    const sortedTerms = [...byTerm.keys()].sort()
    return { docs, byId, bySlug, byTerm, sortedTerms, averageWeight }
  }

  function index() {
    indexPromise ??= buildIndex().catch((error) => {
      // A transient read failure must not poison the tool for the rest of the session.
      indexPromise = undefined
      throw error
    })
    return indexPromise
  }

  /** First position in `sorted` whose value is >= `value`. */
  function lowerBound(sorted, value) {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (sorted[middle] < value) low = middle + 1
      else high = middle
    }
    return low
  }

  /** Terms matching a query token exactly or as a prefix (handles remaining word forms). */
  function expand(term, byTerm, sortedTerms) {
    const expanded = new Map()
    const stemmed = stem(term)
    if (byTerm.has(term)) expanded.set(term, 1)
    if (stemmed !== term && byTerm.has(stemmed)) expanded.set(stemmed, 1)
    if (term.length < 5 || sortedTerms === undefined) return expanded
    for (let position = lowerBound(sortedTerms, term);
      position < sortedTerms.length && expanded.size < MAX_PREFIX_EXPANSIONS;
      position += 1) {
      const candidate = sortedTerms[position]
      if (!candidate.startsWith(term)) break
      if (candidate !== term && candidate !== stemmed) expanded.set(candidate, 0.7)
    }
    return expanded
  }

  function prepare(query) {
    // The cost of a query is (distinct terms × vocabulary), so both are bounded: a 137 KB query
    // otherwise blocks the host's event loop for seconds.
    const normalized = String(query ?? '').trim().toLowerCase().slice(0, MAX_QUERY_CHARS)
    const allTerms = [...new Set(tokenize(normalized))]
    const queryTerms = allTerms.slice(0, MAX_QUERY_TERMS)
    const queryStems = new Set(queryTerms.map(stem))
    const phrase = slugFromPhrase(normalized)
    return { normalized, queryTerms, queryStems, phrase, droppedTerms: allTerms.length - queryTerms.length }
  }

  function toHit(doc, value) {
    return {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      description: doc.description,
      tokenCount: doc.tokenCount,
      experimental: doc.experimental,
      score: Math.round(value * 100) / 100,
    }
  }

  function substringFallback(docs, needle, limit, category) {
    if (needle.length < 3) return []
    const matches = []
    for (const doc of docs) {
      if (category !== undefined && doc.category !== category) continue
      const haystack = `${doc.title} ${doc.id} ${doc.description} ${doc.markdown}`.toLowerCase()
      if (haystack.includes(needle)) matches.push({ doc, score: 1 })
    }
    return matches.slice(0, limit).map((hit) => toHit(hit.doc, hit.score))
  }

  /**
   * Rank guides for a natural-language query.
   * @param {string} query
   * @param {{limit?: number, category?: string}} [options]
   */
  async function search(query, options = {}) {
    const { docs, byTerm, sortedTerms, averageWeight } = await index()
    const limit = normalizeLimit(options.limit)
    const category = normalizeCategory(options.category)
    const prepared = prepare(query)
    if (prepared.queryTerms.length === 0) {
      return substringFallback(docs, prepared.normalized, limit, category)
    }
    const scores = new Map()
    const idfCache = new Map()
    for (const term of prepared.queryTerms) {
      for (const [variant, factor] of expand(term, byTerm, sortedTerms)) {
        let idf = idfCache.get(variant)
        if (idf === undefined) {
          const posting = byTerm.get(variant)
          const df = posting === undefined ? 0 : posting.length
          idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
          idfCache.set(variant, idf)
        }
        const posting = byTerm.get(variant)
        if (posting === undefined) continue
        for (const [position, weight] of posting) {
          const doc = docs[position]
          const lengthNorm = 1 - BM25_B + BM25_B * (doc.weight / averageWeight)
          const contribution = (idf * factor * weight * (BM25_K1 + 1)) / (weight + BM25_K1 * lengthNorm)
          scores.set(position, (scores.get(position) ?? 0) + contribution)
        }
      }
    }
    for (let position = 0; position < docs.length; position += 1) {
      const doc = docs[position]
      const idOverlap = overlap(prepared.queryStems, doc.idStems)
      const titleOverlap = overlap(prepared.queryStems, doc.titleStems)
      const descriptionOverlap = overlap(prepared.queryStems, doc.descriptionStems)
      const bonus = idOverlap * ID_CONTAINMENT_BONUS
        + titleOverlap * TITLE_CONTAINMENT_BONUS
        + descriptionOverlap * DESCRIPTION_CONTAINMENT_BONUS
        + (doc.id === prepared.phrase ? 12 : 0)
        + (slugFromPhrase(doc.title) === prepared.phrase ? 8 : 0)
      if (bonus > 0) scores.set(position, (scores.get(position) ?? 0) + bonus)
    }
    let ranked = [...scores.entries()]
      .map(([position, value]) => ({ doc: docs[position], score: value }))
      .filter((hit) => category === undefined || hit.doc.category === category)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((hit) => toHit(hit.doc, hit.score))
    if (ranked.length === 0) {
      ranked = substringFallback(docs, prepared.normalized, limit, category)
    }
    return ranked
  }

  /** Every guide id, with title/category/description, optionally filtered by category. */
  async function list(options = {}) {
    const { docs } = await index()
    // An empty or non-string category means "no filter" — returning zero guides for "" would let a
    // caller conclude the catalog is empty.
    const category = normalizeCategory(options.category)
    const filtered = category === undefined
      ? docs
      : docs.filter((doc) => doc.category === category)
    return filtered.map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      description: doc.description,
    }))
  }

  /**
   * Full markdown for one or more guide ids; unknown ids are reported, not thrown.
   * Bounded on purpose: a single call may not materialise the whole corpus or repeat the
   * same guide, which would otherwise blow up the caller's context and the host's memory.
   * Guides that lean on an Origin Trial or a volatile platform feature open with a short warning
   * banner (see `experimentalBanner`); the bundled markdown itself is never modified.
   */
  async function retrieve(ids) {
    const { byId, bySlug } = await index()
    const raw = (Array.isArray(ids) ? ids : String(ids ?? '').split(','))
      .map((value) => String(value).trim().replace(/^['"]|['"]$/g, ''))
      .filter((value) => value.length > 0)

    const guides = []
    const unknown = []
    const skipped = []
    const seen = new Set()
    let unknownCount = 0
    let chars = 0

    for (const id of raw) {
      if (id.length > MAX_ID_LENGTH) {
        unknownCount += 1
        if (unknown.length < MAX_UNKNOWN_REPORTED) unknown.push(id.slice(0, MAX_ID_LENGTH))
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      const doc = byId.get(id) ?? bySlug.get(slugFromPhrase(id))
      if (doc === undefined) {
        unknownCount += 1
        if (unknown.length < MAX_UNKNOWN_REPORTED) unknown.push(id)
        continue
      }
      const content = experimentalBanner(doc) + doc.markdown
      if (guides.length >= MAX_RETRIEVE_IDS || chars + content.length > MAX_RETRIEVE_CHARS) {
        skipped.push(doc.id)
        continue
      }
      chars += content.length
      guides.push({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        experimental: doc.experimental,
        content,
      })
    }

    return {
      guides,
      unknown,
      unknownCount,
      skipped,
      truncated: skipped.length > 0,
      limits: { maxGuides: MAX_RETRIEVE_IDS, maxChars: MAX_RETRIEVE_CHARS },
    }
  }

  /** Warm the index early so the first tool call does not pay for it. */
  async function ready() {
    await index()
  }

  return { search, list, retrieve, ready }
}
