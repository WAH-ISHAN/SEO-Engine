import type { LogLevel } from './logger.js';

export interface CrawlConfig {
  /** Seed URL. The origin of this URL defines the site boundary. */
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  /** Delay between requests to the same host, ms. Overridden upward by crawl-delay. */
  politenessDelayMs: number;
  requestTimeoutMs: number;
  userAgent: string;
  respectRobots: boolean;
  followSitemaps: boolean;
  /** Also fetch pages that robots.txt disallows, marking them as blocked. Off. */
  ignoreRobotsForAudit: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  /** Follow subdomains of the registrable root. */
  includeSubdomains: boolean;
  maxBodyBytes: number;
  maxRetries: number;
  /** Operator-approved origins, enforced on redirects and sitemaps too. */
  allowedOrigins?: string[];
}

export interface PlatformConfig {
  crawl: CrawlConfig;
  /** Where the normalized store lives. */
  dbPath: string;
  /** Where raw crawl artifacts live. Kept separate from normalized data by design. */
  rawDir: string;
  outDir: string;
  /** Optional path to the site's source repository, enabling code-level fixes. */
  repoPath: string | null;
  logLevel: LogLevel;
  /** Nothing is written to the site or repo unless this is explicitly true. */
  allowWrites: boolean;
}

export function defaultConfig(startUrl: string, overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  const origin = safeOrigin(startUrl);
  const slug = origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
  const base = `.uwoe/${slug}`;
  const cfg: PlatformConfig = {
    crawl: {
      startUrl,
      maxPages: 500,
      maxDepth: 6,
      concurrency: 4,
      politenessDelayMs: 200,
      requestTimeoutMs: 20_000,
      userAgent:
        'Mozilla/5.0 (compatible; UWOE/1.0; +https://example.invalid/uwoe-bot) ' +
        'website-optimization-auditor',
      respectRobots: true,
      followSitemaps: true,
      ignoreRobotsForAudit: false,
      includePatterns: [],
      excludePatterns: [
        '\\.(jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|eot|zip|gz|pdf|mp4|mp3|webm)$',
        '/wp-admin/', '/wp-json/', '/cdn-cgi/',
      ],
      includeSubdomains: false,
      maxBodyBytes: 5_000_000,
      maxRetries: 2,
      ...(overrides.crawl ?? {}),
    },
    dbPath: `${base}/graph.db`,
    rawDir: `${base}/raw`,
    outDir: `${base}/out`,
    repoPath: null,
    logLevel: 'info',
    allowWrites: false,
  };
  return { ...cfg, ...overrides, crawl: cfg.crawl };
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return 'unknown-site';
  }
}
