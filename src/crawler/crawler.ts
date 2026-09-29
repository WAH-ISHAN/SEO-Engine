import type { CrawlConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { normalizeUrl } from '../core/url.js';
import { parsePage } from '../parser/page.js';
import { fetchUrl, sleep, type HttpResponse } from './http.js';
import { compilePatterns, Frontier } from './frontier.js';
import { RawStore, type RawRecord } from './raw-store.js';
import { isAllowed, parseRobots, PERMISSIVE_ROBOTS, type RobotsTxt } from './robots.js';
import { candidateSitemapUrls, parseSitemap, type SitemapDocument, type SitemapEntry } from './sitemap.js';

export interface CrawlResult {
  origin: string;
  startUrl: string;
  startedAt: number;
  finishedAt: number;
  robots: RobotsTxt;
  robotsProbeError: string | null;
  sitemaps: SitemapDocument[];
  sitemapEntries: SitemapEntry[];
  /** URLs robots.txt blocked, recorded as an audit fact rather than silently dropped. */
  blockedByRobots: { url: string; rule: string }[];
  records: RawRecord[];
  /** URLs discovered but not fetched because a budget was reached. */
  notCrawled: string[];
  stats: {
    fetched: number;
    ok: number;
    redirects: number;
    clientErrors: number;
    serverErrors: number;
    networkErrors: number;
    nonHtml: number;
    totalBytes: number;
    avgResponseMs: number;
  };
}

/**
 * The crawler is the only component that talks to the network during discovery.
 * Everything downstream reads from the raw store, so analysis is reproducible and a
 * rule change never costs another crawl.
 */
export class Crawler {
  private frontier: Frontier;
  private raw: RawStore;
  private origin: string;
  private lastRequestAt = 0;
  private crawlDelayMs: number;

  constructor(private cfg: CrawlConfig, rawDir: string, private log: Logger) {
    const start = normalizeUrl(cfg.startUrl);
    if (!start) throw new Error(`Invalid start URL: ${cfg.startUrl}`);
    this.origin = new URL(start).origin;
    this.crawlDelayMs = cfg.politenessDelayMs;
    this.frontier = new Frontier(this.origin, {
      maxDepth: cfg.maxDepth,
      includeSubdomains: cfg.includeSubdomains,
      includePatterns: compilePatterns(cfg.includePatterns),
      excludePatterns: compilePatterns(cfg.excludePatterns),
    });
    this.raw = new RawStore(rawDir);
  }

  get rawStore(): RawStore {
    return this.raw;
  }

  async run(): Promise<CrawlResult> {
    const startedAt = Date.now();
    const startUrl = normalizeUrl(this.cfg.startUrl)!;
    this.log.info(`crawl starting at ${startUrl}`);

    const { robots, error: robotsProbeError } = await this.loadRobots();
    if (robots.fetched) {
      this.log.info(`robots.txt: ${robots.groups.length} group(s), ${robots.sitemaps.length} sitemap ref(s)`);
    } else {
      this.log.info('robots.txt: not available - treating all paths as crawlable');
    }

    const { docs: sitemaps, entries: sitemapEntries } = this.cfg.followSitemaps
      ? await this.loadSitemaps(robots)
      : { docs: [], entries: [] };

    this.frontier.add(startUrl, 0, null, 'seed');
    for (const e of sitemapEntries) this.frontier.add(e.loc, 1, null, 'sitemap');

    const blockedByRobots: { url: string; rule: string }[] = [];
    const records: RawRecord[] = [];
    let fetched = 0;
    const inFlight = new Set<Promise<void>>();

    const worker = async (): Promise<void> => {
      for (;;) {
        if (fetched >= this.cfg.maxPages) return;
        const item = this.frontier.next();
        if (!item) return;

        if (this.cfg.respectRobots) {
          const decision = isAllowed(robots, this.cfg.userAgent, item.url);
          if (decision.crawlDelay !== null) {
            this.crawlDelayMs = Math.max(this.cfg.politenessDelayMs, decision.crawlDelay * 1000);
          }
          if (!decision.allowed) {
            blockedByRobots.push({ url: item.url, rule: decision.rule ?? 'disallow' });
            if (!this.cfg.ignoreRobotsForAudit) continue;
          }
        }

        fetched++;
        await this.throttle();
        const res = await fetchUrl(
          item.url,
          {
            userAgent: this.cfg.userAgent,
            timeoutMs: this.cfg.requestTimeoutMs,
            maxBodyBytes: this.cfg.maxBodyBytes,
            maxRetries: this.cfg.maxRetries,
            allowedOrigins: this.cfg.allowedOrigins,
          },
          this.log,
        );
        const rec = this.raw.put(res, {
          discoveredFrom: item.discoveredFrom,
          discoveryMethod: item.method,
          depth: item.depth,
        });
        records.push(rec);
        this.log.debug(`${res.status} ${item.url}`, { depth: item.depth, ms: res.timingMs });

        this.enqueueFrom(res, item.depth);
      }
    };

    for (let i = 0; i < Math.max(1, this.cfg.concurrency); i++) {
      const p = worker().finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    await Promise.all([...inFlight]);

    const notCrawled: string[] = [];
    for (;;) {
      const leftover = this.frontier.next();
      if (!leftover) break;
      notCrawled.push(leftover.url);
    }

    const result: CrawlResult = {
      origin: this.origin,
      startUrl,
      startedAt,
      finishedAt: Date.now(),
      robots,
      robotsProbeError,
      sitemaps,
      sitemapEntries,
      blockedByRobots,
      records,
      notCrawled,
      stats: summarize(records),
    };
    this.log.info(
      `crawl finished: ${records.length} fetched, ${result.stats.ok} ok, ` +
        `${result.stats.clientErrors + result.stats.serverErrors} error responses, ` +
        `${notCrawled.length} left unfetched`,
    );
    return result;
  }

  /** Queue links, canonicals and redirect targets found in a response. */
  private enqueueFrom(res: HttpResponse, depth: number): void {
    for (const hop of res.redirectChain) {
      this.frontier.add(hop.location, depth, hop.url, 'redirect');
    }
    const ct = (res.contentType ?? '').toLowerCase();
    if (!res.body || !(ct.includes('html') || ct.includes('xml') || ct === '')) return;
    if (!ct.includes('html') && ct !== '') return;

    const parsed = parsePage(res.body, res.finalUrl, res.headers);
    for (const link of parsed.links) {
      if (!link.internal) continue;
      this.frontier.add(link.href, depth + 1, res.finalUrl, 'link');
    }
    if (parsed.canonical) this.frontier.add(parsed.canonical, depth, res.finalUrl, 'canonical');
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.crawlDelayMs - Date.now();
    this.lastRequestAt = Date.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
  }

  private async loadRobots(): Promise<{ robots: RobotsTxt; error: string | null }> {
    const url = `${this.origin}/robots.txt`;
    const res = await fetchUrl(
      url,
      {
        userAgent: this.cfg.userAgent,
        timeoutMs: this.cfg.requestTimeoutMs,
        maxBodyBytes: 1_000_000,
        maxRetries: 1,
        allowedOrigins: this.cfg.allowedOrigins,
        acceptHeader: 'text/plain,*/*;q=0.8',
      },
      this.log,
    );
    this.raw.put(res, { discoveredFrom: null, discoveryMethod: 'seed', depth: 0 });
    if (res.error) return { robots: { ...PERMISSIVE_ROBOTS, url }, error: res.error };
    if (res.status === 200 && res.body) return { robots: parseRobots(res.body, url, res.status), error: null };
    return { robots: { ...PERMISSIVE_ROBOTS, url, status: res.status }, error: null };
  }

  private async loadSitemaps(robots: RobotsTxt): Promise<{ docs: SitemapDocument[]; entries: SitemapEntry[] }> {
    const queue = robots.sitemaps.length ? [...robots.sitemaps] : candidateSitemapUrls(this.origin);
    const probing = robots.sitemaps.length === 0;
    const docs: SitemapDocument[] = [];
    const entries: SitemapEntry[] = [];
    const visited = new Set<string>();

    while (queue.length && docs.length < 60) {
      const sm = queue.shift()!;
      const url = normalizeUrl(sm, this.origin);
      if (!url || visited.has(url)) continue;
      visited.add(url);

      await this.throttle();
      const res = await fetchUrl(
        url,
        {
          userAgent: this.cfg.userAgent,
          timeoutMs: this.cfg.requestTimeoutMs,
          maxBodyBytes: this.cfg.maxBodyBytes,
          maxRetries: 1,
          allowedOrigins: this.cfg.allowedOrigins,
          acceptHeader: 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8',
        },
        this.log,
      );
      this.raw.put(res, { discoveredFrom: robots.url || null, discoveryMethod: 'sitemap', depth: 0 });

      // When probing conventional locations, a miss is expected and not an error.
      if (res.status !== 200 || !res.body) {
        if (!probing) {
          docs.push({
            url,
            kind: 'unknown',
            entries: [],
            children: [],
            errors: [`Sitemap referenced in robots.txt returned HTTP ${res.status || 'network error'}`],
          });
        }
        continue;
      }

      const doc = parseSitemap(res.body, url);
      docs.push(doc);
      entries.push(...doc.entries);
      for (const child of doc.children) queue.push(child);
      // A successful probe means the conventional location exists; stop guessing.
      if (probing && (doc.entries.length > 0 || doc.children.length > 0)) {
        while (queue.length && candidateSitemapUrls(this.origin).includes(queue[0])) queue.shift();
      }
    }
    if (entries.length) this.log.info(`sitemaps: ${docs.length} document(s), ${entries.length} URL entries`);
    return { docs, entries };
  }
}

function summarize(records: RawRecord[]): CrawlResult['stats'] {
  const s = {
    fetched: records.length,
    ok: 0,
    redirects: 0,
    clientErrors: 0,
    serverErrors: 0,
    networkErrors: 0,
    nonHtml: 0,
    totalBytes: 0,
    avgResponseMs: 0,
  };
  let totalMs = 0;
  for (const r of records) {
    s.totalBytes += r.bodyBytes;
    totalMs += r.timingMs;
    if (r.error) s.networkErrors++;
    else if (r.status >= 200 && r.status < 300) s.ok++;
    else if (r.status >= 300 && r.status < 400) s.redirects++;
    else if (r.status >= 400 && r.status < 500) s.clientErrors++;
    else if (r.status >= 500) s.serverErrors++;
    if (r.redirectChain.length) s.redirects++;
    if (r.contentType && !r.contentType.includes('html')) s.nonHtml++;
  }
  s.avgResponseMs = records.length ? Math.round(totalMs / records.length) : 0;
  return s;
}
