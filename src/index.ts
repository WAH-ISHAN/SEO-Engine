/**
 * Unified Website Optimization Engine.
 *
 * One optimization platform over one shared website model. SEO, AEO, AIO and GEO are
 * six analyses reading the same normalized data, not four products with four crawlers.
 */

export * from './core/model.js';
export * from './core/config.js';
export * from './core/context.js';
export * from './core/problems.js';
export { GraphStore } from './core/store.js';
export { createLogger, type Logger, type LogLevel } from './core/logger.js';
export { healthScore, priorityScore, SCORE_DISCLAIMER } from './core/severity.js';
export * from './core/url.js';

export { Crawler, type CrawlResult } from './crawler/crawler.js';
export { RawStore, type RawRecord } from './crawler/raw-store.js';
export { parseRobots, isAllowed, type RobotsTxt } from './crawler/robots.js';
export { parseSitemap, type SitemapDocument } from './crawler/sitemap.js';
export { fetchUrl, type HttpResponse } from './crawler/http.js';

export { parseHtml, textContent, byTag, type DomNode } from './parser/dom.js';
export { parsePage, type ParsedPage } from './parser/page.js';
export { extractStructuredData } from './parser/structured-data.js';
export { detectFingerprints } from './parser/fingerprint.js';

export { normalize, type NormalizedSite } from './normalizer/normalize.js';
export { buildInventory, hasCapability } from './normalizer/inventory.js';
export { buildSiteGraph, type SiteGraph } from './site-graph/site-graph.js';
export { buildEntityGraph, type EntityGraph } from './entity-engine/entity-graph.js';
export { buildContentModel, type ContentModel } from './content-engine/content-engine.js';

export { seoEngine } from './seo-engine/seo-engine.js';
export { aeoEngine } from './aeo-engine/aeo-engine.js';
export { aioEngine } from './aio-engine/aio-engine.js';
export { geoEngine } from './geo-engine/geo-engine.js';
export { schemaEngine } from './schema-engine/schema-engine.js';
export { internalLinkEngine } from './internal-link-engine/internal-link-engine.js';

export { buildRecommendations, type RecommendationResult } from './recommendation-engine/recommendation-engine.js';
export { ImplementationEngine } from './implementation-engine/implementation-engine.js';
export { detectRepo, mapUrlToFiles } from './implementation-engine/repo-adapter.js';
export { unifiedDiff } from './implementation-engine/patch.js';
export { ValidationEngine } from './validation-engine/validation-engine.js';
export { VALIDATORS, ADVISORY_RULES } from './validation-engine/validators.js';
export { MonitoringEngine, type SiteSnapshot, type MonitoringDiff } from './monitoring-engine/monitoring-engine.js';
export { buildScoreReport, type ScoreReport } from './analytics/scoring.js';

export { runAudit, ANALYSIS_ENGINES, type AuditResult } from './pipeline/pipeline.js';
