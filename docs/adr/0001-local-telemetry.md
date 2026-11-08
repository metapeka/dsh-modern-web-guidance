# ADR-0001: Local usage counters instead of "no telemetry"

- **Status:** accepted
- **Date:** 2026-11-08

## Context

The plugin advertises that it makes no network calls and contains no telemetry, and that
promise is part of its listing copy. The cost is blindness: nobody can tell which of the 193
guides agents actually retrieve, which queries return nothing, or which guides are dead weight.
Corpus refreshes are therefore scheduled on guesswork, and guide descriptions are rewritten
without knowing whether the wording failed the agent.

## Decision

Record every call to the plugin's three tools locally, inside the profile's durable storage, and
expose the numbers through a human command (`/guidance-stats`) — never through an agent-facing
tool, and never by sending anything off the machine.

- What is stored: per-tool counts, per-outcome counts (hit, miss, unknown id, list, error),
  per-day counts, per-category hit counts, per-guide retrieve counts, and a bounded ring of the
  last 1000 calls carrying the query text and the ids that came back.
- Nothing leaves the machine: no network endpoint, no analytics service, no third-party SDK.
- The data is opt-out: `enabled: false` on the plugin row registers no listener and writes no file.
- Retention defaults to 90 days; `--reset --yes` erases everything.
- The privacy boundary is the profile data directory — the same trust boundary that already holds
  session logs.

## Consequences

- The public "no telemetry" claim becomes "local counters, nothing leaves the machine", and the
  README, badges and PUBLISHING notes must say so.
- Miss queries become the actionable input for corpus refresh and description tuning.
- The package gains state it never had before: corrupt or partial state must degrade to "no data"
  rather than break tool calls, and that path needs a test.
- The report is host-only, so it ships without a client bundle; the panel in 0.3.0 reads the same
  aggregates through a host Remote.

## Alternatives considered

- **No counters at all** (the status quo): keeps the promise literally but leaves the corpus
  unmeasured.
- **Aggregate counts without query text**: safer, but miss queries are the whole point of the
  exercise: a count of misses that cannot be reproduced cannot be fixed.
- **Agent-facing stats tool**: costs schema tokens on every request and invites the model to call
  it pointlessly; the numbers serve the maintainer, not the agent.
