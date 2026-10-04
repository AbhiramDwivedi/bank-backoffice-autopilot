# Capability selection

How a caller finds the right capability for a request, what is built today, and the design this
should grow into. Code: `apps/cu/src/catalog/{search,text,index}.ts`, CLI in
`apps/cu/src/commands/catalog.ts`.

## Where this stands

Today a caller picks a capability by exact id (`replay <file>`, `catalog invoke <id>`), by
browsing `catalog list`, or now by keyword search (`catalog search "<text>"`). That is a
**good-enough stopgap**, not the end state. It works when a person or a calling program already
knows roughly what the capability is called. It does not turn a sentence like "what's Jane's
savings balance?" into a choice, and `catalog tools` (every definition at once) does not survive a
large catalog: see the measurements below.

## The ideal design

A **tiny LLM call** chooses the capability from the user's statement, with the catalog loaded
**progressively, the way agent skills are**:

1. **Level 1: names and one-liners.** The model sees only, per capability, a name and a one-line
   description (plus status and risk level). For a big catalog the list is first narrowed by
   search to a top-k shortlist.
2. **Level 2: one full definition.** Only for the capability it chose does the model get the full
   tool definition: description, outputs, business outcomes, typed input schema.
3. **Fill the inputs.** The model produces the typed inputs. `cu` validates them against the
   capability's input schema (type, required, pattern) before anything runs.
4. **Execute.** `catalog invoke` replays the capability. No model is involved from here on.

### Division of labour

**The LLM decides *what* runs. Execution stays deterministic.**

- The ideal selector can only choose among **approved** capabilities and fill typed inputs that
  are validated. It never drives the UI, never sees credentials (secrets are bound from the
  environment at replay time, and `sensitive` inputs are never echoed back), and cannot invent a
  step.
- **What is built does not enforce "approved" by itself.** Drafts are included in `catalog search`,
  `tools --brief`, `tools --query`, and plain `tools`; `catalog invoke` refuses only a deprecated
  capability; and replay's approval gate blocks a draft only when it has an irreversible step. A
  draft with only read or reversible steps runs. So a selector must filter to `status: approved`
  itself. The lever for that exists: `--approved-only` on `catalog search` and `catalog tools`
  (with `--id` it refuses a draft). It is opt-in, not the default.
- With that filter, a wrong choice is bounded by what the chosen capability already enforces: its
  risk level, the policy allowlist, and input validation. The worst a bad selector can then do is
  run a *different approved capability with valid inputs*, which is why confirmation for
  irreversible capabilities (below) matters. Without the filter the bound is weaker: a wrong
  choice can run any non-deprecated draft that has no irreversible step.
- Replay itself stays model-free (`packages/core/src/replay/no-llm.redteam.test.ts` pins it).
  Selection is a separate, optional front door in front of `catalog invoke`; nothing on the replay
  path imports it, and it would live in an LLM-touching module (`agent/` or an adapter), not in
  `apps/cu/src/catalog`.

## How the built pieces map onto the design

| Design step | Built | Command |
|---|---|---|
| Level 1 listing | yes | `catalog tools --brief` (id, tool name, one-line description, status, risk) |
| Shortlister | yes | `catalog search "<text>" [--top-k n] [--json]`, or `catalog tools --query "<text>" [--top-k n] [--brief]` |
| Level 2 definition | yes | `catalog tools --id <id>` |
| Typed-input validation, execution | yes (already existed) | `catalog invoke <id> --input name=value` |
| The selector LLM call | **no** | |
| Meaning-based (embedding) matching | **no** | |
| Persisted search index | **no** | |

`catalog invoke` validates `--input` against the capability's input schema inside replay and
returns a typed `hard_failure` for a bad value; a selector's output goes through exactly that
check.

### Search

Deterministic, local, dependency-free keyword ranking (no embeddings, no model call).

- **Index per capability:** id, name, description, input names and descriptions, output names and
  descriptions, business-outcome names and descriptions, `app.vendor`, `app.product`,
  `app.surface`, and the tenant keys (`app.tenant`, `overrides[].tenant`). The schema has no tags
  field, so there are none to index.
- **Ranking:** BM25F. Per-field weights: id 4, name 4, description 2, outputs 1.2, business
  outcomes 1.2, inputs 1, app/tenant metadata 0.6. Each term's weighted, length-normalised
  frequency is saturated (k1 = 1.2, b = 0.75) and multiplied by inverse document frequency over
  the loaded catalog, so a word that names one capability outweighs a word every capability
  shares. Field length is averaged over capabilities that have the field (otherwise a
  rarely-filled field such as outputs makes its few users look "long" and penalises them).
- **Query semantics:** terms are OR-ed. A capability matching one of three words appears, lower.
  A query with no matching word returns nothing; it never falls back to a guess.
- **Tokenizer:** Unicode-aware (NFKC-normalised, letters and numbers of any script, lower-cased);
  splits kebab-case, snake_case and camelCase; drops single characters and a short stop-word
  list (`text.ts`). Accented text matches itself (`Müller`, `café`). There is **no
  transliteration** (`café` does not match `cafe`) and **no CJK word segmentation** (a run of CJK
  characters is one token that matches only the identical run).
- **Stemmer:** plurals only (`balances` meets `balance`, `parties` meets `party`, `visas` meets
  `visa`). `-ing` and `-ed` rules were tried and dropped: they merged `savings` with `save` and
  `checking` with `check`, which in a credit-union catalog sends the headline query
  `savings` to a "save a note" capability. Known misses: `statuses` does not meet `status`.
- **Prefix matching:** the last query token also matches by prefix at half weight (`savin` finds
  `savings`), for interactive use. A capability's contribution per query word is the best of its
  exact and prefix matches, never the sum, and a prefix never re-scores a word the user already
  typed in full (`balance bal` scores like `balance`).
- **Results explain themselves:** each hit carries score, version, status, risk and `matched`:
  which fields matched and with which query words, so a person or a calling program can see why.
- **Deprecated** capabilities are excluded unless `--include-deprecated`. **Drafts** are
  included and marked by `status`; `--approved-only` drops them (and wins over
  `--include-deprecated`). Document frequency is computed over the whole catalog, so
  scores do not shift with the flag. Order is score then id, so output is deterministic.

### Ids and tool names

A capability id has no length cap in the schema, but tool names are limited to 64 characters. For
a longer id the tool name is the truncated form. Level-1 entries therefore carry both `id` (real)
and `name` (tool name); `tools --id`, `Catalog.resolve` and `catalog invoke` accept either, an
exact id always winning, and a tool name shared by two ids (an ambiguous truncation) resolves to
neither, while the ids still work. Shortlists are keyed by id.

### The one-line description

Used by `tools --brief`, the search table, and `--json` results. Rule (`oneLineDescription`):
collapse whitespace; take the first sentence (a `.`, `!` or `?` followed by the end of the text,
or by whitespace and then an upper-case letter or digit; periods after a single letter and after
`e.g`, `i.e`, `vs`, `no`, `approx`, `inc`, `ltd`, `co`, `dr`, `mr`, `mrs`, `ms`, `st`, `u.s`,
`u.k` do not end it; an unlisted abbreviation before a capital still splits, a known limit); if
longer than 120 characters, cut at the last word boundary and append `...`.
It is derived, not authored, so it cannot drift from the description. The cost is that a
capability whose first sentence is vague gets a vague one-liner; fix the description.

## Measured scale

`npx tsx apps/cu/scripts/catalog-scale-bench.ts <count> <repeats>` (works from any cwd) generates
synthetic capabilities (the example artifact with varied id, name, description and field
descriptions) in a temp directory and times each phase separately. It is a script, not a test.

**Variance, stated plainly:** these numbers come from one Windows development machine that was
running other test suites at the same time. Repeated runs of the same command differed by 2 to 3
times, and single repeats were up to 10 times slower than the median. An independent measurement
saw 1.0 s at 200 and 12 s at 2,000 capabilities, against 0.6 to 0.75 s and 6.8 to 8.4 s in the
runs below. Read the ranges as order of magnitude, not as benchmarks.

| Capabilities | Read + parse all files | Validate all | `loadCatalog` end to end (median of runs) | Build search index | One search | Level-1 listing | Full `tools` listing |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 | 0.35 to 0.48 s | 0.09 to 0.19 s | 0.6 to 0.75 s (single repeats 0.33 to 2.7 s) | 24 to 41 ms | 0.4 to 0.7 ms | ~10k tokens | ~48k tokens |
| 2,000 | 4.4 to 5.3 s | 1.4 to 1.8 s | 6.8 to 8.4 s (single repeats 5 to 30 s) | 380 to 430 ms | 4.6 to 7 ms | ~105k tokens | ~480k tokens |

(Three runs per row, five repeats each. Tokens are JSON bytes divided by four.) What this says:

- **Search itself is cheap.** The index builds in well under a second at 2,000 capabilities and a
  query takes milliseconds. Ranking is not the bottleneck.
- **`loadCatalog` is, and mostly because of file I/O and JSON parsing, not schema validation.**
  Per file, read + parse cost about 1.8 to 2.7 ms and validation about 0.4 to 0.9 ms, so reading
  is roughly three quarters of the split on this machine (the synthetic files may be smaller than
  real ones, so the ratio can shift). `loadCatalog` runs on every CLI invocation. It is under a
  second at 200 capabilities; around 500 to 1,000 it makes a one-shot `catalog search` feel slow
  (2 s and up). **That is where a persisted index becomes necessary**: an on-disk projection of
  the searchable fields plus file path and mtime, refreshed only for files whose mtime changed, so
  a search reads no artifact and only the chosen capability is parsed and validated. Because
  reading dominates, a cache that only skipped validation would not be enough. A long-lived
  process that loads once does not need it until the tens of thousands.
- **Level 1 is not free either.** About 50 tokens per capability: fine at 200 (10k tokens), too
  much to hand a "tiny" model at 2,000 (about 105k). Past a few hundred capabilities the search
  shortlist is not an optimisation, it is required: show the model the top-k briefs, not all of
  them.
- Plain `catalog tools` at 2,000 capabilities is ~480k tokens. It stays as the unchanged default
  for small catalogs and existing callers; do not feed it to a model at scale.

## Failure modes of a selector

The selector is not built, so these are the requirements for it, not current behaviour.

- **Ambiguous request.** Two capabilities fit ("look up the balance" could be savings or
  checking). Ask the user, or return the top-k with their scores for a person to pick. Do not
  guess. Search scores can inform "ambiguous" (a small gap between first and second) but are only
  comparable within one query.
- **No match.** Say so. `catalog search` already returns an empty list for an unmatched query, and
  the selector must treat that, or a model answer outside the shortlist, as "no capability", never
  as a nearest-neighbour fallback.
- **Irreversible capability.** An approved capability with an irreversible step will run if
  chosen: the approval gate protects against *unapproved* ones, not against a wrong *approved*
  one. The front door needs its own confirmation step before invoking anything whose risk level is
  `irreversible`, showing the capability and the filled inputs to the user. This is the main gap
  between "bounded by the capability" and "safe".
- **Bad inputs.** A hallucinated or malformed value fails input validation and surfaces as a
  typed failure; the selector can re-ask. It must not retry by loosening the schema.
- **Prompt injection through descriptions.** Capability names and descriptions are model input at
  level 1. They come from discovery and approval, so they are reviewed artifacts, but a selector
  should treat them as data, and tenant-supplied text should not be able to reach that prompt
  unreviewed.
- **Wrong tenant or app.** App and tenant metadata are searchable but not authoritative; the
  selector should pass the tenant explicitly rather than infer it from the request.

## Not part of this work

Listed only as future work:

- **Reusable sub-capabilities**: a shared login (or other common prefix) that a capability's
  schema can reference instead of repeating it in every artifact.
- **Catalog health monitoring**: scheduled canary replays and a drift dashboard, so a capability
  that has started failing is flagged before a caller picks it.
