# Modern Web Guidance plugin

Offline, searchable guidance for modern web platform work: a fixed corpus of Google Chrome's
use-case guides, exposed to agents as search and retrieval tools.

## Corpus

**Guide**:
One curated use-case document from the corpus, addressed by an id and belonging to exactly one
category.
_Avoid_: article, doc, page, topic

**Category**:
One of the topical buckets a guide belongs to (css, forms, security, and so on). Every guide has
exactly one.
_Avoid_: section, group, tag

**Corpus**:
The complete set of guides the plugin ships, treated as one fixed body of knowledge.
_Avoid_: library, dataset, knowledge base

**Snapshot**:
The corpus as taken from upstream at one moment, carrying that moment's date.
_Avoid_: copy, dump, export

**Corpus version**:
The upstream release identifier a snapshot was taken from, such as `2026_10_30-58d055df`.
_Avoid_: build id, revision

## Telemetry

**Call**:
One invocation of one of the plugin's tools by an agent. The unit every counter counts.
_Avoid_: request, query, usage

**Outcome**:
The classification of a call: hit, miss, unknown id, list, or error.
_Avoid_: result, status

**Hit**:
A search call that returned at least one guide.
_Avoid_: match, success

**Miss**:
A search call that returned no guide. The signal that neither the corpus nor a guide's description
answered the question asked.
_Avoid_: failure, no-result

**Unknown id**:
A retrieve call that named a guide id the corpus does not contain.
_Avoid_: bad id, 404

**Dead guide**:
A guide that no call has ever retrieved.
_Avoid_: unused guide, orphan, zero-hit guide

**Report**:
The human-facing summary of counters over one period, produced by the plugin's command.
_Avoid_: dashboard, metrics page
