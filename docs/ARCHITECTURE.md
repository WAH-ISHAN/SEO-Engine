# Architecture

The current product is headless: `src/service/api.ts` owns project credentials and
durable audit jobs, `src/service/worker.ts` runs the on-page profile, and
`plugins/on-page-seo/mcp-server.mjs` exposes the REST workflow through stdio MCP.
The dashboard was removed. See [integration](INTEGRATION.md) for setup and assignment.
The broader analysis model below remains available to library consumers.

This document covers the decisions that hold the platform together, and how to extend it
without breaking them.

---

## 1. One data model

`src/core/model.ts` defines the vocabulary. Node types (`Website`, `Page`, `Entity`,
`Question`, `Schema`, `Issue`, `Recommendation`, `Change`, `ValidationResult`, …) and
relationship types (`contains`, `links_to`, `mentions`, `answers`, `canonical_of`,
`redirects_to`, …) are closed unions, so a typo is a compile error rather than a silently
orphaned node.

`GraphStore` holds it. SQLite for durability, in-memory adjacency indexes for traversal,
kept in sync on every write so a run never round-trips to disk to walk the graph.

Two invariants the store enforces:

- **Identity comes from `(type, key)`, never from content.** `upsertNode` merges props
  into an existing node rather than creating a second one. A page crawled twice is one
  node.
- **Edges require evidence.** `addEdge` returns `null` for an empty evidence array. A
  relationship nobody can point at is not a relationship.

**The rule that makes this one platform:** no engine keeps its own copy of website data.
Engines receive an `AnalysisContext` and return `Signal[]`. They do not crawl, do not
parse HTML, and hold no state between runs. Four independent products sharing a repo is
exactly what this design prevents.

## 2. Raw data is separate from analysis

`RawStore` writes every response — headers, timing, redirect chain, body — to an
append-only JSONL index plus one file per body, under `.uwoe/<site>/raw/`.

Two things follow. Any claim in any report traces back to the exact bytes the crawler
saw. And improving a rule costs a re-analysis, not a re-crawl.

## 3. Evidence: fact versus judgement

```ts
type EvidenceKind = 'observed' | 'derived' | 'inferred';
```

- `observed` — read directly out of the crawled bytes, carrying a verbatim excerpt.
- `derived` — computed deterministically from observations. Counts, graph metrics,
  similarity scores. Still fact, just fact you calculated.
- `inferred` — a heuristic judgement by this platform.

The recommendation engine requires at least one `observed` **or** `derived` item.
Inference alone produces an *issue* (an observation the reader can weigh) but never a
*recommendation* (an action the platform is advising).

This is also why the report has two top-level sections, `observed` and `analysis`. A
reader who trusts nothing the platform concludes can still use everything it saw.

## 4. Problem families: how findings converge

```ts
problemKey = `${family}::${hash(scope)}`
```

The family names the underlying defect. The scope names what it applies to — usually a
URL, sometimes the site, sometimes a type or a pattern. The **detecting engine is not
part of the key**, which is the entire mechanism.

`buildRecommendations` groups signals by key. One key, one recommendation, every
contributing signal attached, severity taken as the maximum and confidence raised by
corroboration:

```ts
corroboratedConfidence([0.6, 0.6]) // 0.84 — two independent detectors agreeing
```

### Adding a check

1. Pick a family from `PROBLEM_FAMILIES`. **Reuse one if the defect already exists** —
   that is how a new perspective connects to a known problem instead of duplicating it.
   Add a family only for a genuinely new defect.
2. Choose the scope carefully. Too broad merges unrelated findings; too narrow floods the
   queue with near-duplicates. Per-URL for page defects, site-wide for one configuration
   decision.
3. Emit a `Signal` with evidence, `currentState`, `recommendedState`, and a
   `validationRule`.
4. Implement that rule in `VALIDATORS`, or list it in `ADVISORY_RULES` if it genuinely
   cannot be verified by re-crawling. There is no third option: a rule that is in neither
   reports "no validator is implemented", so the change is never claimed as verified.

### Adding an engine

Implement `AnalysisEngine` and add it to `ANALYSIS_ENGINES` in `pipeline.ts`. An engine
that throws is logged and skipped — one failing analysis must not lose the other five.

## 5. Inventory before analysis

`buildInventory` runs after normalization and before every engine. It records what the
site already implements, with coverage ratios and evidence, and detects conflicts between
existing mechanisms.

Engines consult it (`hasCapability`) to avoid reporting a missing capability that exists.
The recommendation engine attaches `respectsExisting` so the reader knows what a change
must not disturb. `implementationMethod` routes the change through the detected platform:
if Yoast owns the metadata, the recommendation says to change it in Yoast, because
editing the theme would be overwritten or produce a second conflicting tag.

## 6. Dependency ordering

Some fixes are pointless until another lands. `impliedDependencies` encodes the
sequencing:

- Don't list URLs in a sitemap before they resolve and canonicalize correctly.
- Don't add internal links to pages that are broken or blocked.
- Don't add structured data to a page whose markup already contradicts its content.
- Don't rewrite metadata while two systems are emitting contradictory directives.
- Don't describe entity relationships before the organization exists at all.

The queue is a topological sort, ties broken by priority. Cycles are broken by priority
rather than dropped, so an item is never lost.

`priorityScore` is an ordering device: severity × category weight × sublinear reach ×
confidence, plus an unblocking bonus, times a penalty when blocked. It is not a ranking
prediction and must never be presented as one.

## 7. Implementation: three gates

```
proposed → previewed → approved → applied → validated
                  ↘ rejected          ↘ failed → rolled-back
```

A write requires all three of:

1. `allowWrites` in configuration,
2. `status === 'approved'`, and
3. the file on disk still byte-identical to what the preview was generated from.

The third is the one that matters in a team. A preview generated an hour ago, applied
after someone else edited the file, would silently discard their work. Instead the apply
refuses and tells you to re-run the audit.

Before any write, the original bytes go into `RollbackPlan.files`, so rollback restores
the file exactly rather than attempting a reverse patch.

Edits are surgical — `setTitle`, `setCanonical`, `addJsonLd` locate the specific element
and rewrite only that. Reserializing the document would reformat markup nobody asked to
change and make the diff unreviewable.

`mapUrlToFiles` is deliberately conservative. Static HTML maps at 0.95 confidence and is
patched. A framework route maps at ~0.55 and is **not** patched automatically, because
metadata usually lives in a layout shared by many routes — changing it would affect every
page using it, which is not the platform's decision to make.

### URL changes

`url.change` is refused by `approve()` under every configuration. It produces a pre-flight
report instead: old URL, new URL, the required 301, current indexability, inbound link
count, internal prominence, sitemap presence, and explicit statements that backlink data
and traffic/ranking data are **not available to this platform**. Saying "no data" is the
honest output; inventing a risk score from data you do not have is not.

## 8. Validation re-fetches

A patch that changed a file proves nothing about what the server sends. `ValidationEngine`
re-fetches the live URL, runs the declared rule, and compares a before/after snapshot.

`detectRegressions` fails the change if it lost a title, a canonical, an H1, structured
data types, semantic landmarks, 20% of internal links, or half the content — even when
the target rule passes. Fixing one thing while breaking another is a failure, not a
success.

## 9. Monitoring distinguishes new from returned

A snapshot is the complete auditable state at one moment. `diff` walks the site's whole
snapshot history to separate:

- **new issues** — never seen before,
- **resolved** — present then, absent now, and
- **regressions** — resolved in an earlier snapshot and back again.

That third category is the useful one. A regression points at the delivery process, not
at the page: something is undoing the work.

## 10. Dependencies

The crawler, HTML tokenizer, DOM and diff are implemented locally; storage uses Node
SQLite. The MCP integration uses the official MCP SDK and Zod for validated inputs.
TypeScript and Node types are development dependencies. The optional legacy Search
Console module uses google-auth-library and is not part of the service startup.

The trade-off is real: the tokenizer is not a spec-complete HTML5 parser. It implements
the parts that matter for extraction — raw-text elements, attribute quoting, implicit
close rules, entity decoding — and ignores the parts that only matter for rendering.

## 11. Known limits

Stated plainly, because a tool that hides its limits is worse than one that has them:

- **JavaScript is not executed.** Pages assembled client-side are detected and reported
  (`CONTENT_NOT_IN_HTML`), not rendered.
- **Performance signals are server-side only.** Response time and HTML weight, measured by
  this crawler. Not Core Web Vitals, and reported as such.
- **No backlink, traffic, or ranking data.** Nothing is connected. Where that data would
  change a decision — URL changes especially — the platform says it does not have it.
- **`registrableRoot` is not a Public Suffix List.** A hardcoded set of common two-level
  TLDs. Fine for same-site checks, wrong for exotic suffixes.
- **Topic clustering is lexical.** Stemmed term overlap, not semantics. It groups pages
  that use the same words; it does not understand them, and `cohesion` is reported so you
  can discount a weak cluster.
- **Entity resolution is conservative by design.** Two genuinely identical entities named
  slightly differently stay separate. Under-merging is recoverable; over-merging invents a
  relationship that was never stated.
