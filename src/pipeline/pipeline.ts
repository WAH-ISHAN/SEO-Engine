import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformConfig } from '../core/config.js';
import { createLogger, type Logger } from '../core/logger.js';
import { GraphStore } from '../core/store.js';
import type { AnalysisContext, AnalysisEngine } from '../core/context.js';
import type { Signal } from '../core/model.js';
import { Crawler, type CrawlResult } from '../crawler/crawler.js';
import { normalize } from '../normalizer/normalize.js';
import { buildInventory } from '../normalizer/inventory.js';
import { buildSiteGraph } from '../site-graph/site-graph.js';
import { buildEntityGraph } from '../entity-engine/entity-graph.js';
import { buildContentModel } from '../content-engine/content-engine.js';
import { seoEngine } from '../seo-engine/seo-engine.js';
import { aeoEngine } from '../aeo-engine/aeo-engine.js';
import { aioEngine } from '../aio-engine/aio-engine.js';
import { geoEngine } from '../geo-engine/geo-engine.js';
import { schemaEngine } from '../schema-engine/schema-engine.js';
import { internalLinkEngine } from '../internal-link-engine/internal-link-engine.js';
import { buildRecommendations, type RecommendationResult } from '../recommendation-engine/recommendation-engine.js';
import { ImplementationEngine } from '../implementation-engine/implementation-engine.js';
import { MonitoringEngine, type MonitoringDiff, type SiteSnapshot } from '../monitoring-engine/monitoring-engine.js';
import { buildScoreReport, type ScoreReport } from '../analytics/scoring.js';
import type { Change } from '../core/model.js';

/**
 * The pipeline.
 *
 * Website -> Crawler -> Raw data -> Normalizer -> Central model -> Site graph +
 * Entity graph -> SEO/AEO/AIO/GEO analysis -> Unified recommendations -> Priority
 * queue -> Human approval -> Implementation -> Validation -> Monitoring.
 *
 * The ordering is the design. Discovery and inventory complete before any engine runs,
 * so every engine analyses the same understood site; recommendations are produced from
 * merged signals rather than per-engine; and nothing is implemented until a person has
 * approved it.
 */

export const ANALYSIS_ENGINES: AnalysisEngine[] = [
  seoEngine, schemaEngine, internalLinkEngine, aeoEngine, aioEngine, geoEngine,
];

export interface AuditResult {
  context: AnalysisContext;
  signals: Signal[];
  recommendations: RecommendationResult;
  scores: ScoreReport;
  snapshot: SiteSnapshot;
  diff: MonitoringDiff | null;
  changes: Change[];
  store: GraphStore;
  outputs: { json: string; artifacts: string[] };
}

export interface AuditOptions {
  /** Reuse an existing crawl instead of fetching again. */
  existingCrawl?: CrawlResult;
  /** Skip writing the JSON report. */
  skipReports?: boolean;
  profile?: 'full' | 'on-page';
  logger?: Logger;
}

export async function runAudit(config: PlatformConfig, opts: AuditOptions = {}): Promise<AuditResult> {
  const log = opts.logger ?? createLogger(config.logLevel);
  const started = Date.now();

  // ---- 1. Discover -------------------------------------------------------
  log.info('phase 1/8: discovery');
  const crawler = new Crawler(config.crawl, config.rawDir, log.child('crawler'));
  const crawl = opts.existingCrawl ?? (await crawler.run());

  // ---- 2. Normalize into the central model -------------------------------
  log.info('phase 2/8: normalization');
  const store = new GraphStore(config.dbPath);
  const site = normalize(crawl, crawler.rawStore, store, config.crawl.userAgent, log.child('normalizer'));

  if (site.pages.length === 0) {
    store.close();
    throw new Error('No HTML pages could be audited. The site may be unreachable or blocking the crawler.');
  }

  // ---- 3. Understand: graphs and content ---------------------------------
  log.info('phase 3/8: site graph, entity graph, content model');
  const siteGraph = buildSiteGraph(site, crawl);
  const entityGraph = buildEntityGraph(site, store);
  const content = buildContentModel(site);

  // ---- 4. Inventory what already exists ----------------------------------
  log.info('phase 4/8: capability inventory');
  const inventory = buildInventory(site, crawl, content, entityGraph);
  log.info(
    `inventory: ${Object.keys(inventory.present).length} capabilities present, ` +
    `${inventory.absent.length} absent, ${inventory.conflicts.length} conflicting implementation(s)`,
  );

  const context: AnalysisContext = {
    config, log, store, crawl, site, siteGraph, entityGraph, content, inventory,
  };

  // ---- 5. Analyze --------------------------------------------------------
  log.info('phase 5/8: analysis');
  const signals: Signal[] = [];
  const engines = opts.profile === 'on-page' ? [seoEngine, schemaEngine, internalLinkEngine] : ANALYSIS_ENGINES;
  for (const engine of engines) {
    try {
      const produced = engine.analyze(context);
      signals.push(...produced.filter(s => opts.profile !== 'on-page' || ON_PAGE_CATEGORIES.has(s.category)));
      log.info(`  ${engine.name}: ${produced.length} signal(s)`);
    } catch (err) {
      if (opts.profile === 'on-page') {
        store.close();
        throw new Error(`On-page analysis failed in ${engine.id}`, { cause: err });
      }
      // One failing engine must not lose the other five analyses.
      log.error(`engine ${engine.id} failed`, err instanceof Error ? err.message : String(err));
    }
  }

  // ---- 6. Unify into recommendations -------------------------------------
  log.info('phase 6/8: unified recommendations');
  const recommendations = buildRecommendations(context, signals);
  for (const issue of recommendations.issues) store.saveIssue(issue);
  for (const rec of recommendations.recommendations) store.saveRecommendation(rec);

  // ---- 7. Propose implementations (read-only) ----------------------------
  log.info('phase 7/8: change proposals');
  const implementation = new ImplementationEngine(context, store, log.child('implementation'));
  const changes = implementation.propose(recommendations.queue);

  // ---- 8. Score, snapshot, report ----------------------------------------
  log.info('phase 8/8: scoring, snapshot, reports');
  const scores = buildScoreReport(context, signals, recommendations);
  const monitoring = new MonitoringEngine(store, log.child('monitoring'));
  const snapshot = monitoring.capture(context, recommendations, scores);
  const diff = monitoring.latestDiff(site.origin);

  const outputs = { json: '', artifacts: [] as string[] };
  if (!opts.skipReports) {
    mkdirSync(config.outDir, { recursive: true });
    const jsonPath = join(config.outDir, 'report.json');
    writeFileSync(jsonPath, JSON.stringify(serializeReport(context, recommendations, scores, snapshot, diff, changes, opts.profile), null, 2), 'utf8');
    outputs.json = jsonPath;

    outputs.artifacts = implementation.exportArtifacts(changes, config.outDir);
  }

  log.info(
    `audit complete in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
    `${site.pages.length} pages, ${signals.length} signals, ` +
    `${recommendations.recommendations.length} recommendations, overall score ${scores.scores.overall}`,
  );

  return { context, signals, recommendations, scores, snapshot, diff, changes, store, outputs };
}

/** Machine-readable report. Observations and recommendations are kept separate. */
export function serializeReport(
  ctx: AnalysisContext,
  recs: RecommendationResult,
  scores: ScoreReport,
  snapshot: SiteSnapshot,
  diff: MonitoringDiff | null,
  changes: Change[],
  profile: 'full' | 'on-page' = 'full',
): Record<string, unknown> {
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      site: ctx.site.origin,
      generator: 'Unified Website Optimization Engine 1.0',
      profile,
      categories: profile === 'on-page' ? [...ON_PAGE_CATEGORIES] : 'all',
      scoreDisclaimer: scores.disclaimer,
    },
    observed: {
      crawl: {
        startedAt: ctx.crawl.startedAt,
        finishedAt: ctx.crawl.finishedAt,
        stats: ctx.crawl.stats,
        robotsFound: ctx.crawl.robots.fetched,
        sitemapDocuments: ctx.crawl.sitemaps.map((s) => ({ url: s.url, kind: s.kind, entries: s.entries.length, errors: s.errors })),
        blockedByRobots: ctx.crawl.blockedByRobots,
        notCrawled: ctx.crawl.notCrawled.slice(0, 200),
      },
      coverage: scores.coverage,
      keyFacts: scores.keyFacts,
      inventory: {
        present: ctx.inventory.present,
        absent: ctx.inventory.absent,
        conflicts: ctx.inventory.conflicts,
      },
      siteGraph: {
        homepage: ctx.siteGraph.homepage,
        maxDepth: ctx.siteGraph.maxDepth,
        avgDepth: ctx.siteGraph.avgDepth,
        sections: ctx.siteGraph.sections,
        orphanPages: ctx.siteGraph.orphanPages,
        weaklyConnectedPages: ctx.siteGraph.weaklyConnectedPages,
        duplicateClusters: ctx.siteGraph.duplicateClusters,
        topicClusters: ctx.siteGraph.topicClusters,
        cannibalization: ctx.siteGraph.cannibalization,
        brokenInternalLinks: ctx.siteGraph.brokenInternalLinks,
        redirectedInternalLinks: ctx.siteGraph.redirectedInternalLinks,
      },
      entityGraph: {
        primaryOrganization: ctx.entityGraph.primaryOrganization?.name ?? null,
        stats: ctx.entityGraph.stats,
        entities: ctx.entityGraph.entities.map((e) => ({
          name: e.name,
          class: e.nodeClass,
          types: e.entityTypes,
          description: e.description,
          urls: e.urls,
          sameAs: e.sameAs,
          mentionedOn: e.mentionedOn,
          confidence: e.confidence,
          origins: e.origins,
          relations: e.relations.map((r) => ({ relation: r.relation, target: r.targetName })),
          evidence: e.evidence,
        })),
      },
      content: ctx.content.stats,
      issues: recs.issues,
      graphCounts: ctx.store.counts(),
    },
    analysis: {
      scores: profile === 'on-page' ? { onPage: scores.scores.onPage, content: scores.scores.content, internalLinking: scores.scores.internalLinking, structuredData: scores.scores.structuredData, accessibility: scores.scores.accessibility } : scores.scores,
      breakdown: scores.breakdown.filter(b => profile !== 'on-page' || ON_PAGE_CATEGORIES.has(b.category)),
      recommendations: recs.recommendations,
      queue: recs.queue.map((r) => r.id),
      stats: recs.stats,
    },
    changes,
    monitoring: {
      snapshotId: snapshot.id,
      totals: snapshot.totals,
      diff: profile === 'on-page' && diff ? { ...diff, scoreDeltas: Object.fromEntries(
        Object.entries(diff.scoreDeltas).filter(([key]) => ['onPage', 'content', 'internalLinking', 'structuredData', 'accessibility'].includes(key)),
      ) } : diff,
    },
  };
}

export const ON_PAGE_CATEGORIES = new Set(['ON_PAGE_SEO', 'CONTENT', 'INTERNAL_LINKING', 'STRUCTURED_DATA', 'ACCESSIBILITY']);
