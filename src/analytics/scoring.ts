import type { AnalysisContext } from '../core/context.js';
import type { Category, Signal } from '../core/model.js';
import { healthScore, SCORE_DISCLAIMER } from '../core/severity.js';
import type { RecommendationResult } from '../recommendation-engine/recommendation-engine.js';

/**
 * Scores and rollups for the dashboard.
 *
 * Every score here answers exactly one question: what proportion of this platform's
 * checks does the site currently pass, weighted by how serious each failure is and how
 * much of the site it affects. That is a hygiene measure of the site's own
 * configuration and content.
 *
 * It is not a ranking, a traffic estimate, a competitor comparison, or a prediction
 * about whether any search engine or AI system will surface the site. Every surface
 * that renders a score also renders the disclaimer below, because a number without that
 * context invites exactly the misreading this platform is built to avoid.
 */

export interface ScoreReport {
  scores: {
    overall: number;
    technicalSeo: number;
    onPage: number;
    content: number;
    architecture: number;
    internalLinking: number;
    structuredData: number;
    entity: number;
    aeo: number;
    aio: number;
    geo: number;
    accessibility: number;
    performance: number;
  };
  disclaimer: string;
  coverage: CoverageStats;
  breakdown: { category: Category; score: number; signalCount: number; worstSeverity: string }[];
  keyFacts: KeyFacts;
}

export interface CoverageStats {
  pagesCrawled: number;
  pagesIndexable: number;
  pagesDiscoveredNotCrawled: number;
  urlsInSitemap: number;
  /** Fraction of the site the crawl actually reached, where a sitemap makes that knowable. */
  crawlCompleteness: number | null;
  blockedByRobots: number;
  nonHtmlResponses: number;
  errorResponses: number;
}

export interface KeyFacts {
  origin: string;
  crawlDuration: number;
  avgResponseMs: number;
  maxDepth: number;
  avgDepth: number;
  orphanPages: number;
  brokenInternalLinks: number;
  duplicateClusters: number;
  entitiesFound: number;
  schemaTypesInUse: string[];
  questionsFound: number;
  questionsAnswered: number;
  detectedPlatforms: string[];
  existingCapabilities: string[];
  conflictingImplementations: number;
}

const CATEGORY_TO_SCORE: Record<Category, keyof ScoreReport['scores']> = {
  TECHNICAL_SEO: 'technicalSeo',
  ON_PAGE_SEO: 'onPage',
  CONTENT: 'content',
  INFORMATION_ARCHITECTURE: 'architecture',
  INTERNAL_LINKING: 'internalLinking',
  ENTITY: 'entity',
  STRUCTURED_DATA: 'structuredData',
  AEO: 'aeo',
  AIO: 'aio',
  GEO: 'geo',
  PERFORMANCE: 'performance',
  ACCESSIBILITY: 'accessibility',
};

export function buildScoreReport(
  ctx: AnalysisContext, signals: Signal[], recs: RecommendationResult,
): ScoreReport {
  const pageCount = Math.max(1, ctx.site.pages.length);
  const byCategory = new Map<Category, Signal[]>();
  for (const s of signals) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push(s);
  }

  const scores = {
    overall: 0,
    technicalSeo: 100, onPage: 100, content: 100, architecture: 100, internalLinking: 100,
    structuredData: 100, entity: 100, aeo: 100, aio: 100, geo: 100, accessibility: 100, performance: 100,
  };
  const breakdown: ScoreReport['breakdown'] = [];

  for (const [category, key] of Object.entries(CATEGORY_TO_SCORE) as [Category, keyof ScoreReport['scores']][]) {
    const group = byCategory.get(category) ?? [];
    const score = healthScore(group, pageCount);
    scores[key] = score;
    breakdown.push({
      category,
      score,
      signalCount: group.length,
      worstSeverity: group.length
        ? group.reduce((worst, s) => (rank(s.severity) > rank(worst) ? s.severity : worst), 'info')
        : 'none',
    });
  }

  // The overall score weights categories by how much they gate everything else, so a
  // site with sound fundamentals and weak GEO signals does not read the same as one
  // that is technically broken.
  const weights: Partial<Record<keyof ScoreReport['scores'], number>> = {
    technicalSeo: 3, onPage: 2, architecture: 2, internalLinking: 1.5, content: 2,
    structuredData: 1.5, entity: 1, aeo: 1, aio: 1, geo: 0.75, accessibility: 1, performance: 1,
  };
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights) as [keyof ScoreReport['scores'], number][]) {
    weighted += scores[key] * weight;
    totalWeight += weight;
  }
  scores.overall = Math.round(weighted / totalWeight);

  return {
    scores,
    disclaimer: SCORE_DISCLAIMER,
    coverage: buildCoverage(ctx),
    breakdown: breakdown.sort((a, b) => a.score - b.score),
    keyFacts: buildKeyFacts(ctx, recs),
  };
}

function buildCoverage(ctx: AnalysisContext): CoverageStats {
  const sitemapUrls = new Set(ctx.crawl.sitemapEntries.map((e) => e.loc));
  const crawledFromSitemap = ctx.site.pages.filter((p) => sitemapUrls.has(p.url)).length;
  return {
    pagesCrawled: ctx.site.pages.length,
    pagesIndexable: ctx.site.pages.filter((p) => p.indexable).length,
    pagesDiscoveredNotCrawled: ctx.crawl.notCrawled.length,
    urlsInSitemap: sitemapUrls.size,
    crawlCompleteness: sitemapUrls.size > 0 ? Number((crawledFromSitemap / sitemapUrls.size).toFixed(3)) : null,
    blockedByRobots: ctx.crawl.blockedByRobots.length,
    nonHtmlResponses: ctx.site.nonPageRecords.filter((r) => !r.error && r.status < 400).length,
    errorResponses: ctx.site.nonPageRecords.filter((r) => r.status >= 400 || r.error).length,
  };
}

function buildKeyFacts(ctx: AnalysisContext, recs: RecommendationResult): KeyFacts {
  const schemaTypes = new Set<string>();
  for (const p of ctx.site.pages) for (const s of p.schemas) for (const t of s.types) schemaTypes.add(t);

  const questions = [...ctx.content.byUrl.values()].flatMap((m) => m.questions);

  return {
    origin: ctx.site.origin,
    crawlDuration: ctx.crawl.finishedAt - ctx.crawl.startedAt,
    avgResponseMs: ctx.crawl.stats.avgResponseMs,
    maxDepth: ctx.siteGraph.maxDepth,
    avgDepth: Number(ctx.siteGraph.avgDepth.toFixed(2)),
    orphanPages: ctx.siteGraph.orphanPages.length,
    brokenInternalLinks: ctx.siteGraph.brokenInternalLinks.length,
    duplicateClusters: ctx.siteGraph.duplicateClusters.length,
    entitiesFound: ctx.entityGraph.stats.total,
    schemaTypesInUse: [...schemaTypes].sort(),
    questionsFound: questions.length,
    questionsAnswered: questions.filter((q) => q.hasDirectAnswer).length,
    detectedPlatforms: Object.keys(ctx.inventory.present)
      .filter((k) => k.startsWith('platform:'))
      .map((k) => k.slice('platform:'.length)),
    existingCapabilities: Object.keys(ctx.inventory.present)
      .filter((k) => !k.startsWith('platform:'))
      .sort(),
    conflictingImplementations: ctx.inventory.conflicts.length,
  };
}

function rank(s: string): number {
  return ['info', 'low', 'medium', 'high', 'critical'].indexOf(s);
}

export { SCORE_DISCLAIMER };
