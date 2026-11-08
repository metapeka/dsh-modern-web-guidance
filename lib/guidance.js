/**
 * Offline guide index for the Modern Web Guidance plugin.
 *
 * Reads the bundled `data/guides.json` catalog plus the guide markdown files and
 * builds a small in-memory BM25 index on first use. No network access, no model,
 * no native dependencies: the plugin ships its corpus and searches it locally.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  let indexPromise

  async function readEntry(entry) {
    const relative = join('guides', entry.category, `${entry.id}.md`)
    const markdown = await readFile(join(dataDir, relative), 'utf8')
    const title = titleOf(markdown, entry.id)
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
    const catalogText = await readFile(join(dataDir, 'guides.json'), 'utf8')
    const catalog = JSON.parse(catalogText)
    if (!Array.isArray(catalog)) throw new Error('guides.json must be an array')
    const docs = await Promise.all(catalog.map(readEntry))
    const byId = new Map()
    const byTerm = new Map()
    for (let position = 0; position < docs.length; position += 1) {
      const doc = docs[position]
      byId.set(doc.id, doc)
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
    return { docs, byId, byTerm, averageWeight }
  }

  function index() {
    indexPromise ??= buildIndex()
    return indexPromise
  }

  /** Terms matching a query token exactly or as a prefix (handles remaining word forms). */
  function expand(term, byTerm) {
    const expanded = new Map()
    const stemmed = stem(term)
    if (byTerm.has(term)) expanded.set(term, 1)
    if (stemmed !== term && byTerm.has(stemmed)) expanded.set(stemmed, 1)
    if (term.length < 5) return expanded
    for (const candidate of byTerm.keys()) {
      if (candidate !== term && candidate !== stemmed && candidate.startsWith(term)) expanded.set(candidate, 0.7)
    }
    return expanded
  }

  function prepare(query) {
    const normalized = String(query ?? '').trim().toLowerCase()
    const queryTerms = [...new Set(tokenize(normalized))]
    const queryStems = new Set(queryTerms.map(stem))
    const phrase = slugFromPhrase(normalized)
    return { normalized, queryTerms, queryStems, phrase }
  }

  function toHit(doc, value) {
    return {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      description: doc.description,
      tokenCount: doc.tokenCount,
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
    const { docs, byTerm, averageWeight } = await index()
    const limit = Math.min(Math.max(Number(options.limit) || 8, 1), 25)
    const prepared = prepare(query)
    if (prepared.queryTerms.length === 0) {
      return substringFallback(docs, prepared.normalized, limit, options.category)
    }
    const scores = new Map()
    const idfCache = new Map()
    for (const term of prepared.queryTerms) {
      for (const [variant, factor] of expand(term, byTerm)) {
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
      .filter((hit) => options.category === undefined || hit.doc.category === options.category)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((hit) => toHit(hit.doc, hit.score))
    if (ranked.length === 0) {
      ranked = substringFallback(docs, prepared.normalized, limit, options.category)
    }
    return ranked
  }

  /** Every guide id, with title/category/description, optionally filtered by category. */
  async function list(options = {}) {
    const { docs } = await index()
    const filtered = options.category === undefined
      ? docs
      : docs.filter((doc) => doc.category === options.category)
    return filtered.map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      description: doc.description,
    }))
  }

  /** Full markdown for one or more guide ids; unknown ids are reported, not thrown. */
  async function retrieve(ids) {
    const { byId, docs } = await index()
    const requested = (Array.isArray(ids) ? ids : String(ids ?? '').split(','))
      .map((value) => String(value).trim().replace(/^['"]|['"]$/g, ''))
      .filter((value) => value.length > 0)
    const guides = []
    const unknown = []
    for (const id of requested) {
      const doc = byId.get(id) ?? docs.find((candidate) => candidate.id === slugFromPhrase(id))
      if (doc === undefined) {
        unknown.push(id)
        continue
      }
      guides.push({ id: doc.id, title: doc.title, category: doc.category, content: doc.markdown })
    }
    return { guides, unknown }
  }

  /** Warm the index early so the first tool call does not pay for it. */
  async function ready() {
    await index()
  }

  return { search, list, retrieve, ready }
}
