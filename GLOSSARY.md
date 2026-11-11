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
One code site produced by a rule: a path, the `lines` it covers, how many hits that is (`occurrences`),
the first hit's 1-based line and column, rule id, guide id, confidence, message and a clipped snippet of
the first hit's line. A run of one rule's hits on neighbouring lines — the next line or one blank line
later — is **one** finding, never N, and `maxFindings` counts findings rather than hits. Use `lines[0]`
and `lines.at(-1)` for the range.
_Avoid_: hit, warning, error, issue

**Confidence**:
How conclusive a rule's marker is on its own — `high` when the marker alone is conclusive, `medium`
when it is strong only in context, `low` when a false positive is likely.
_Avoid_: severity, priority

**`.scanignore`**:
An optional file at the workspace root listing paths one scan must not read: one pattern per line
(`report/` for every directory of that name, `src/app.js` for one file, `*.min.js` for a name shape),
`#` for a comment, `*` inside one path segment and never across `/`. A pattern may name one file or a
directory: with a trailing `/` it matches a directory only and skips its subtree, without the slash a path
of that name — file or directory — matches. A pattern containing `/` is matched against the whole
workspace-relative path from the root, so `src/app.js` names exactly that file; a single-segment pattern
matches that name at any depth. It is read at the start of every scan; a malformed line is reported in the
result and never fails the scan. It is **not** a security boundary — the scanner is already confined to
`realpath(cwd)`, so the file can only make a scan read less than it is allowed to, never more.
_Avoid_: .gitignore, allowlist, blocklist, sandbox rule

**Suppressed finding**:
A finding a person decided to mute. It stays in the scan's results and is counted separately
(`suppressed: N`) by rule, and a suppressed site is still present — so it is never counted as resolved
and "fixed" and "muted" can never look the same. It is recorded per code site (`siteId`, never a line
number) in a workspace-root `.suppress` file that only an explicit command appends to, after a visible
confirmation (ADR-0003). Contrast an ignored path: `.scanignore` means the scan never reads the file,
which is a different act with a different consequence.
_Avoid_: fixed, ignored, false positive, accepted risk

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
A search call that returned at least one guide. In the scanner's vocabulary a hit is one match of one rule
on one line, and several neighbouring hits of the same rule collapse into a single finding — `occurrences`
is that count.
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

**Answer rate**:
The share of *guidance* calls the corpus answered — `(hit + list) / (hit + list + miss + unknown id)` —
stated for one window beside the window before it. It is deliberately not the hit rate: that one
divides hits by every call, scans and errors included, and answers "what did the agent get"; this one
answers "did the corpus answer what it was asked", so a week of scanning cannot move it. `list` counts
as answered, because the corpus returned its own inventory, and `error` is in neither side.
_Avoid_: hit rate, success rate, resolution rate

**Report**:
The human-facing summary of counters over one period, produced by the `/guidance-stats` command.
_Avoid_: dashboard, metrics page

**Workspace**:
The directory a session is working in, as the host reports it in the session header. Scan counters are kept
per workspace; guidance counters are not, because those measure the bundled corpus rather than a project.
_Avoid_: project, repo, folder

**Workspace id**:
Eight lowercase hexadecimal characters — FNV-1a 32-bit over the resolved workspace path — used as the key of
a counter bucket. Stable across runs, and the only thing that tells two same-named checkouts apart: the path
itself is never stored.
_Avoid_: project id, slug, key

**Branch label**:
The branch a scan ran on, read from `<workspace>/.git/HEAD` when that scan finishes: a branch name
(`main`), `detached at a1b2c3d` for a detached checkout, or nothing at all — a failed read is a missing
label, never "unknown". It is recorded per scan and never used as a counter key, so switching branches
never splits a workspace's totals; the scope and the four shapes are ADR-0002.
_Avoid_: branch bucket, per-branch counters, revision, tag

**Unattributed**:
The bucket holding scan counters written before per-workspace attribution existed (0.10.0). It is offered in
the switcher and selectable by id rather than hidden, and nothing writes to it any more.
_Avoid_: legacy, unknown, orphan

## Panel

**Panel**:
A read-only view the plugin contributes to the Harness Web UI — today exactly one, Guidance Insights,
opened from the left rail. It draws the same counters the report prints as a map: it never changes a
counter itself, calls no tool and reaches no network. The one action it offers is the scan button, which
asks the host to run the `/guidance-scan` command and shows that run inline; a scan started there is
counted like any other. The report stays the text form.
_Avoid_: dashboard, widget, tab
