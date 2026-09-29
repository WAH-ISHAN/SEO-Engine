import { hash } from '../core/ids.js';
import { familyOf } from '../core/problems.js';
import {
  corroboratedConfidence, maxSeverity, priorityScore, severityRank,
} from '../core/severity.js';
import type {
  CapabilityInventory, Category, Evidence, FixKind, FixSpec, Issue, Recommendation, Severity, Signal,
} from '../core/model.js';
import type { AnalysisContext } from '../core/context.js';
import { capabilitiesTouching } from '../normalizer/inventory.js';

/**
 * The unified recommendation engine.
 *
 * This is where four analyses become one plan. Signals arrive from every engine keyed
 * by the underlying problem rather than by the engine that found it, so when the SEO
 * engine, the AIO engine and the schema engine all notice the same missing structured
 * data, the output is a single recommendation listing three contributing signals -
 * not three items competing for the same fix.
 *
 * Two outputs come out of here, kept deliberately apart:
 *   Issues          - what was observed. Facts, with evidence, no judgement.
 *   Recommendations - what this platform advises doing about them. Judgement, always
 *                     traceable back to the facts.
 */

export interface RecommendationResult {
  issues: Issue[];
  recommendations: Recommendation[];
  /** Ordered work queue, dependencies before dependents. */
  queue: Recommendation[];
  stats: {
    signalsIn: number;
    recommendationsOut: number;
    mergedSignals: number;
    multiEngineFindings: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    requiringHumanApproval: number;
  };
}

export function buildRecommendations(ctx: AnalysisContext, signals: Signal[]): RecommendationResult {
  const now = Date.now();
  const grouped = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!grouped.has(s.problemKey)) grouped.set(s.problemKey, []);
    grouped.get(s.problemKey)!.push(s);
  }

  const issues: Issue[] = [];
  const recommendations: Recommendation[] = [];
  const idByProblemKey = new Map<string, string>();

  for (const [problemKey, group] of grouped) {
    const id = `rec-${hash(problemKey)}`;
    idByProblemKey.set(problemKey, id);

    // Rule: a recommendation must rest on fact. `observed` is read directly from the
    // crawled bytes and `derived` is computed deterministically from them, so either
    // qualifies. A finding supported only by this platform's own heuristics is
    // reported as an observation and never becomes an action.
    const evidence = mergeEvidence(group.flatMap((s) => s.evidence));
    const hasFactualBasis = evidence.some((e) => e.kind === 'observed' || e.kind === 'derived');

    const severity = maxSeverity(group.map((s) => s.severity));
    const confidence = corroboratedConfidence(group.map((s) => s.confidence));
    const affectedUrls = [...new Set(group.flatMap((s) => s.affectedUrls))];
    const primary = pickPrimary(group);

    issues.push({
      id: `issue-${hash(problemKey)}`,
      rule: primary.rule,
      category: primary.category,
      severity,
      title: primary.title,
      detail: primary.detail,
      affectedUrls,
      evidence,
      engines: [...new Set(group.map((s) => s.engine))],
      firstSeen: now,
      lastSeen: now,
    });

    if (!hasFactualBasis) {
      ctx.log.debug(`no recommendation for ${problemKey}: supported by inference alone`);
      continue;
    }

    const fix = pickFix(group);
    const respectsExisting = existingCapabilitiesFor(ctx.inventory, primary.category, fix?.kind);

    recommendations.push({
      id,
      problemKey,
      category: primary.category,
      contributingSignals: group.map((s) => ({
        engine: s.engine, rule: s.rule, severity: s.severity, confidence: s.confidence,
      })).sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
      issue: primary.title,
      detail: mergeDetails(group),
      evidence,
      affectedUrls,
      severity,
      confidence,
      priority: 0, // assigned below, once dependencies are known
      dependencies: [],
      currentState: primary.currentState,
      recommendedState: primary.recommendedState,
      implementationMethod: implementationMethod(ctx, fix, primary.category),
      validationMethod: validationMethod(primary.validationRule, affectedUrls.length),
      validationRule: primary.validationRule,
      rollbackMethod: rollbackMethod(ctx, fix),
      fix,
      respectsExisting,
      createdAt: now,
    });
  }

  // Resolve declared dependencies into recommendation ids.
  const byId = new Map(recommendations.map((r) => [r.id, r]));
  for (const rec of recommendations) {
    const group = grouped.get(rec.problemKey) ?? [];
    const deps = new Set<string>();
    for (const s of group) {
      for (const depKey of s.dependsOn ?? []) {
        const depId = idByProblemKey.get(depKey);
        if (depId && depId !== rec.id && byId.has(depId)) deps.add(depId);
      }
    }
    // Structural dependencies: some fixes are pointless until another lands.
    for (const implied of impliedDependencies(rec, recommendations)) deps.add(implied);
    rec.dependencies = [...deps];
  }

  // Priority, now that blocking relationships are known.
  const unblockCount = new Map<string, number>();
  for (const rec of recommendations) {
    for (const d of rec.dependencies) unblockCount.set(d, (unblockCount.get(d) ?? 0) + 1);
  }
  for (const rec of recommendations) {
    rec.priority = priorityScore({
      severity: rec.severity,
      confidence: rec.confidence,
      category: rec.category,
      affectedUrlCount: rec.affectedUrls.length,
      totalPageCount: ctx.site.pages.length,
      unblocks: unblockCount.get(rec.id) ?? 0,
      blocked: rec.dependencies.length > 0,
    });
  }

  const queue = topologicalQueue(recommendations);
  const multiEngine = recommendations.filter((r) => new Set(r.contributingSignals.map((s) => s.engine)).size > 1);

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const r of recommendations) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  }

  ctx.log.info(
    `recommendations: ${signals.length} signals merged into ${recommendations.length} items ` +
    `(${multiEngine.length} corroborated by more than one engine)`,
  );

  return {
    issues: issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    recommendations,
    queue,
    stats: {
      signalsIn: signals.length,
      recommendationsOut: recommendations.length,
      mergedSignals: signals.length - recommendations.length,
      multiEngineFindings: multiEngine.length,
      byCategory,
      bySeverity,
      requiringHumanApproval: recommendations.filter((r) => !r.fix || r.fix.requiresHuman).length,
    },
  };
}

/** The signal that best describes the problem: highest severity, then most specific. */
function pickPrimary(group: Signal[]): Signal {
  return [...group].sort((a, b) => {
    const s = severityRank(b.severity) - severityRank(a.severity);
    if (s !== 0) return s;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // Prefer the engine whose category owns the mechanism being changed.
    return ENGINE_AUTHORITY.indexOf(a.engine) - ENGINE_AUTHORITY.indexOf(b.engine);
  })[0];
}

/** Which engine's framing wins when several describe the same defect. */
const ENGINE_AUTHORITY = ['seo', 'schema', 'internal-link', 'entity', 'aio', 'aeo', 'geo', 'site-graph', 'content'];

/** The most actionable fix available, preferring one that can be applied safely. */
function pickFix(group: Signal[]): FixSpec | undefined {
  const fixes = group.map((s) => s.fix).filter((f): f is FixSpec => !!f);
  if (fixes.length === 0) return undefined;
  const automatable = fixes.find((f) => !f.requiresHuman);
  return automatable ?? fixes[0];
}

function mergeDetails(group: Signal[]): string {
  if (group.length === 1) return group[0].detail;
  const primary = pickPrimary(group);
  const others = group.filter((s) => s !== primary);
  const perspectives = others
    .map((s) => `${engineLabel(s.engine)}: ${s.detail}`)
    .join('\n\n');
  return `${primary.detail}\n\nThe same underlying problem was independently detected by ` +
    `${others.length} other analysis${others.length === 1 ? '' : 'es'}:\n\n${perspectives}`;
}

function engineLabel(id: string): string {
  switch (id) {
    case 'seo': return 'Technical & on-page SEO';
    case 'aeo': return 'Answer engine optimization';
    case 'aio': return 'AI readability';
    case 'geo': return 'Generative search readiness';
    case 'schema': return 'Structured data';
    case 'internal-link': return 'Internal linking';
    case 'entity': return 'Entity analysis';
    case 'site-graph': return 'Site graph';
    default: return 'Content analysis';
  }
}

function mergeEvidence(all: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  // Observed evidence first: the factual basis should lead.
  const order: Evidence['kind'][] = ['observed', 'derived', 'inferred'];
  for (const kind of order) {
    for (const e of all) {
      if (e.kind !== kind) continue;
      const key = `${e.kind}|${e.source}|${e.locator}|${e.note ?? ''}|${e.excerpt ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/**
 * Structural ordering rules. These encode sequencing that would otherwise have to be
 * rediscovered by whoever works the queue.
 */
function impliedDependencies(rec: Recommendation, all: Recommendation[]): string[] {
  const deps: string[] = [];
  const family = familyOf(rec.problemKey);
  const find = (f: string) => all.filter((r) => familyOf(r.problemKey) === f).map((r) => r.id);

  // Do not list URLs in a sitemap before they resolve and canonicalize correctly.
  if (family === 'SITEMAP_STALE' || family === 'SITEMAP_BAD_ENTRIES') {
    deps.push(...find('CANONICAL_BROKEN'), ...find('HTTP_ERROR'), ...find('CANONICAL_CONFLICT'));
  }
  // Do not add internal links to pages that are broken or blocked.
  if (family === 'MISSING_TOPIC_LINK' || family === 'ORPHAN_PAGE') {
    deps.push(...find('BROKEN_INTERNAL_LINK'), ...find('HTTP_ERROR'));
  }
  // Do not add structured data to a page whose content contradicts existing markup.
  if (family === 'STRUCTURED_DATA_ABSENT' || family === 'SCHEMA_INCOMPLETE') {
    deps.push(...find('SCHEMA_CONTRADICTS_CONTENT'), ...find('SCHEMA_INVALID'));
  }
  // Resolve contradictory directives before rewriting any metadata.
  if (family === 'CANONICAL_MISSING' || family === 'TITLE_DUPLICATE' || family === 'DESCRIPTION_DUPLICATE') {
    deps.push(...find('CANONICAL_CONFLICT'), ...find('ROBOTS_DIRECTIVE_CONFLICT'));
  }
  // Entity descriptions depend on the organization existing at all.
  if (family === 'ENTITY_UNDEFINED' || family === 'ENTITY_RELATIONSHIP_MISSING' || family === 'BRAND_INCONSISTENT') {
    deps.push(...find('ORGANIZATION_IDENTITY_MISSING'));
  }
  return deps.filter((id) => id !== rec.id);
}

/**
 * Orders the queue so no item appears before something it depends on, breaking ties by
 * priority. Cycles are broken by priority rather than dropped, so an item is never lost.
 */
function topologicalQueue(recs: Recommendation[]): Recommendation[] {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const out: Recommendation[] = [];

  const visit = (id: string) => {
    if (visited.has(id) || inStack.has(id)) return;
    const rec = byId.get(id);
    if (!rec) return;
    inStack.add(id);
    const deps = [...rec.dependencies]
      .map((d) => byId.get(d))
      .filter((r): r is Recommendation => !!r)
      .sort((a, b) => b.priority - a.priority);
    for (const d of deps) visit(d.id);
    inStack.delete(id);
    visited.add(id);
    out.push(rec);
  };

  for (const rec of [...recs].sort((a, b) => b.priority - a.priority)) visit(rec.id);
  return out;
}

// ---------------------------------------------------------------------------
// Method descriptions - what actually has to happen, given what the site runs on
// ---------------------------------------------------------------------------

function existingCapabilitiesFor(inv: CapabilityInventory, category: Category, kind?: FixKind): string[] {
  const relevant: string[] = [];
  switch (category) {
    case 'ON_PAGE_SEO':
      relevant.push('titles', 'meta-descriptions', 'open-graph', 'twitter-cards');
      break;
    case 'TECHNICAL_SEO':
      relevant.push('canonical-tags', 'robots-txt', 'xml-sitemap', 'hreflang', 'mobile-viewport');
      break;
    case 'STRUCTURED_DATA':
    case 'ENTITY':
      relevant.push('organization-identity');
      break;
    case 'AEO':
      relevant.push('faq-content', 'direct-answers', 'how-to-content');
      break;
    case 'AIO':
      relevant.push('author-attribution', 'content-dates', 'semantic-landmarks');
      break;
    case 'GEO':
      relevant.push('external-citations', 'comparison-content');
      break;
    default:
      break;
  }
  if (kind?.startsWith('schema')) {
    relevant.push(...Object.keys(inv.present).filter((k) => k.startsWith('schema:')));
  }
  // Whatever platform the site runs on always constrains how a change is delivered.
  relevant.push(...Object.keys(inv.present).filter((k) => k.startsWith('platform:')));
  return capabilitiesTouching(inv, [...new Set(relevant)]);
}

function implementationMethod(ctx: AnalysisContext, fix: FixSpec | undefined, category: Category): string {
  const platforms = Object.keys(ctx.inventory.present)
    .filter((k) => k.startsWith('platform:'))
    .map((k) => k.slice('platform:'.length));

  if (!fix) {
    return 'Manual change. This finding describes a condition rather than a single edit; ' +
      'the work is scoped by whoever owns the affected pages.';
  }
  if (fix.requiresHuman) {
    return `Proposed change, human-authored. ${deliveryRoute(ctx, platforms)} ` +
      'The platform prepares the change and the diff but will not write the value itself, because ' +
      'it would have to invent information it has not observed.';
  }
  const route = deliveryRoute(ctx, platforms);
  return `Automated patch, subject to approval. ${route} ` +
    `The change is previewed as a diff, applied only after explicit approval, then validated by ` +
    `re-crawling the affected ${category === 'TECHNICAL_SEO' ? 'resources' : 'pages'}.`;
}

function deliveryRoute(ctx: AnalysisContext, platforms: string[]): string {
  if (ctx.config.repoPath) {
    const framework = platforms.find((p) =>
      ['nextjs', 'nuxt', 'astro', 'hugo', 'jekyll', 'gatsby', 'sveltekit'].includes(p));
    if (framework) {
      return `The site is built with ${framework} and a repository is configured, so the change is ` +
        'made in source and verified against the built output.';
    }
    return 'A repository is configured, so the change is made in source files and reviewed as a diff.';
  }
  const cms = platforms.find((p) => ['wordpress', 'shopify', 'wix', 'squarespace', 'webflow', 'drupal'].includes(p));
  const seoPlugin = platforms.find((p) => ['yoast-seo', 'rank-math', 'all-in-one-seo'].includes(p));
  if (seoPlugin) {
    return `This site already manages metadata through ${seoPlugin}, so the change must be made ` +
      'there rather than in templates - editing the theme directly would be overwritten or would ' +
      'produce a second conflicting tag.';
  }
  if (cms) {
    return `The site runs on ${cms}; the change is made through its editing interface.`;
  }
  return 'No repository is configured, so the change is delivered as an instruction with the exact ' +
    'target value rather than applied directly.';
}

function validationMethod(rule: string, urlCount: number): string {
  const scope = urlCount === 1 ? 'the affected URL' : `a sample of the ${urlCount} affected URLs`;
  return `Re-crawl ${scope} and run ${rule}, comparing the result against the pre-change snapshot. ` +
    'The change is only marked validated when the rule passes and no previously passing check regresses.';
}

function rollbackMethod(ctx: AnalysisContext, fix: FixSpec | undefined): string {
  if (!fix) return 'No automated change is made, so there is nothing to roll back.';
  if (ctx.config.repoPath) {
    return 'The original file contents are captured before any write and stored with the change ' +
      'record. Rollback restores those exact bytes and re-runs validation to confirm the site ' +
      'matches its pre-change state.';
  }
  return 'The previous value is recorded in the change record before the new one is proposed. ' +
    'Rollback consists of restoring that recorded value through the same route used to apply it.';
}

export function recommendationsByCategory(recs: Recommendation[]): Map<Category, Recommendation[]> {
  const m = new Map<Category, Recommendation[]>();
  for (const r of recs) {
    if (!m.has(r.category)) m.set(r.category, []);
    m.get(r.category)!.push(r);
  }
  for (const list of m.values()) list.sort((a, b) => b.priority - a.priority);
  return m;
}

export type { Severity };
