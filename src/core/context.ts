import type { PlatformConfig } from './config.js';
import type { Logger } from './logger.js';
import type { GraphStore } from './store.js';
import type { CapabilityInventory, Signal } from './model.js';
import type { CrawlResult } from '../crawler/crawler.js';
import type { NormalizedSite } from '../normalizer/normalize.js';
import type { SiteGraph } from '../site-graph/site-graph.js';
import type { EntityGraph } from '../entity-engine/entity-graph.js';
import type { ContentModel } from '../content-engine/content-engine.js';

/**
 * Everything an analysis engine is allowed to see.
 *
 * Engines receive this and return signals. They do not crawl, do not parse HTML, and
 * do not keep state between runs - which is the mechanism that makes SEO, AEO, AIO and
 * GEO four views of one dataset instead of four datasets.
 */
export interface AnalysisContext {
  config: PlatformConfig;
  log: Logger;
  store: GraphStore;
  crawl: CrawlResult;
  site: NormalizedSite;
  siteGraph: SiteGraph;
  entityGraph: EntityGraph;
  content: ContentModel;
  inventory: CapabilityInventory;
}

export interface AnalysisEngine {
  id: string;
  /** Human name for the dashboard. */
  name: string;
  analyze(ctx: AnalysisContext): Signal[];
}

/** Convenience for engines: pages worth judging on content quality. */
export function analyzablePages(ctx: AnalysisContext) {
  return ctx.site.pages.filter((p) => p.status >= 200 && p.status < 300);
}

/** Pages the site itself intends to have indexed. */
export function indexablePages(ctx: AnalysisContext) {
  return analyzablePages(ctx).filter((p) => p.indexable && !p.indexabilityReasons.includes('non-canonical'));
}
