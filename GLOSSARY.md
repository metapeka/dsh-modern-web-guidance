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

## Legacy scan

**Legacy scan**:
One run of the `web_guidance_legacy_scan` tool — or of the `/guidance-scan` command that runs the same
scanner — over the paths the caller explicitly named: it walks them, matches the rule table line by
line and reports what it found. Read-only; it never writes, spawns a process or reaches the network.
_Avoid_: audit, lint, codemod, migration

**Marker scanner**:
A scanner that matches regular expressions against individual lines of text, with no syntax tree and
no semantic understanding. It is deliberately modest: a clean report means "none of the rules'
markers matched", not "no legacy code". Upstream's own `legacy-scan` is an AST analyzer and is not
shipped here; this plugin makes no parity claim.
_Avoid_: analyzer, parser, static analysis

**Rule**:
One entry in `lib/scan-rules.js` — a stable id (`ls-01` … `ls-33`), the guide that fixes the pattern,
a confidence, one imperative message naming the modern replacement, and the marker it matches.
_Avoid_: check, pattern, detector

**Finding**:
One match produced by a rule: path, 1-based line and column, rule id, guide id, confidence, message
and a clipped snippet of the matched line. One finding per rule, path and line.
_Avoid_: hit, warning, error, issue

**Confidence**:
How conclusive a rule's marker is on its own — `high` when the marker alone is conclusive, `medium`
when it is strong only in context, `low` when a false positive is likely.
_Avoid_: severity, priority

## Telemetry

**Call**:
One invocation of one of the plugin's tools by an agent. The unit every counter counts.
_Avoid_: request, query, usage

**Outcome**:
The classification of a call: hit, miss, unknown id, list, findings, clean, or error. The last three
are scan-specific: `findings` is a scan that raised at least one finding, `clean` one that raised
none, and an errored call is still counted.
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

**Hit rate**:
The share of calls that found something. The report divides hits by every call — `list` and `error` included — and so
reads low; the panel divides hits by the calls that could hit (hits, misses and unknown ids) and keeps the report's
number in the tile's tooltip.
_Avoid_: success rate, accuracy

**Report**:
The human-facing summary of counters over one period, produced by the `/guidance-stats` command.
_Avoid_: dashboard, metrics page

## Panel

**Panel**:
A read-only view the plugin contributes to the Harness Web UI — today exactly one, Guidance Insights,
opened from the left rail. It draws the same counters the report prints as a map: it never changes a
counter itself, calls no tool and reaches no network. The one action it offers is the scan button, which
asks the host to run the `/guidance-scan` command and shows that run inline; a scan started there is
counted like any other. The report stays the text form.
_Avoid_: dashboard, widget, tab
