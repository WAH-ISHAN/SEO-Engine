import { hash } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { GraphStore } from '../core/store.js';
import type { PlatformConfig } from '../core/config.js';
import type {
  Change, PageProps, Recommendation, ValidationCheck, ValidationResult,
} from '../core/model.js';
import { fetchUrl } from '../crawler/http.js';
import { parseSitemap } from '../crawler/sitemap.js';
import { parsePage } from '../parser/page.js';
import { sha256 } from '../core/text.js';
import { normalizeUrl } from '../core/url.js';
import { ADVISORY_RULES, VALIDATORS, worstStatus, type ValidationSubject } from './validators.js';

/**
 * The validation engine.
 *
 * Validation re-fetches the live URL rather than trusting the patch that was applied.
 * A patch that changed a file proves nothing about what the server sends; only the
 * response does.
 *
 * Each result carries both before and after states, so a change that fixes its target
 * while breaking something else is reported as a regression rather than a success.
 */

export interface ValidationOptions {
  /** Snapshot of page state taken before the change, keyed by URL. */
  before?: Map<string, PageSnapshot>;
  /** Upper bound on URLs re-fetched in one pass. */
  maxUrls?: number;
}

export interface PageSnapshot {
  url: string;
  status: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string[];
  h1Count: number;
  wordCount: number;
  schemaTypes: string[];
  internalLinkCount: number;
  imageAltMissing: number;
  contentHash: string;
  landmarks: string[];
}

export class ValidationEngine {
  constructor(private config: PlatformConfig, private store: GraphStore, private log: Logger) {}

  /** Captures the state of a set of URLs so an after-state can be compared to it. */
  async snapshot(urls: string[]): Promise<Map<string, PageSnapshot>> {
    const out = new Map<string, PageSnapshot>();
    for (const url of urls) {
      const subject = await this.fetchSubject(url);
      out.set(url, toSnapshot(url, subject.page, subject.status));
    }
    return out;
  }

  /**
   * Validates one change by re-crawling its target and running the rule its
   * recommendation declared.
   */
  async validateChange(
    change: Change, recommendation: Recommendation, opts: ValidationOptions = {},
  ): Promise<ValidationResult> {
    const url = change.fix.url;
    const before = opts.before?.get(url) ?? null;
    const subject = await this.fetchSubject(url);
    const checks: ValidationCheck[] = [];

    // Always confirm the URL still serves before judging anything else about it.
    checks.push(VALIDATORS['VALIDATE.HTTP_STATUS'](subject));

    const rule = recommendation.validationRule;
    const validator = VALIDATORS[rule];
    if (validator) {
      checks.push(validator(subject, expectedFor(rule, recommendation, change)));
    } else if (ADVISORY_RULES.has(rule)) {
      checks.push({
        rule,
        status: 'WARNING',
        message:
          `${rule} describes an editorial condition that cannot be verified by re-crawling. ` +
          'A person has to confirm this one.',
      });
    } else {
      checks.push({
        rule,
        status: 'WARNING',
        message: `No validator is implemented for ${rule}, so this change has not been verified.`,
      });
    }

    const after = toSnapshot(url, subject.page, subject.status);
    checks.push(...detectRegressions(before, after));

    const result: ValidationResult = {
      id: `val-${hash(change.id, String(Date.now()))}`,
      changeId: change.id,
      recommendationId: recommendation.id,
      url,
      status: worstStatus(checks),
      checks,
      before: before ? (before as unknown as Record<string, unknown>) : null,
      after: after as unknown as Record<string, unknown>,
      ranAt: Date.now(),
    };
    this.store.saveValidation(result);

    const updated: Change = {
      ...change,
      status: result.status === 'FAIL' ? 'failed' : 'validated',
      notes: [...change.notes, `Validation ${result.status}: ${checks.map((c) => `${c.rule}=${c.status}`).join(', ')}`],
    };
    this.store.saveChange(updated);

    this.log.info(`validation ${result.status} for ${url} (${rule})`);
    return result;
  }

  /**
   * Validates a recommendation without any change having been applied, which is how a
   * fix made outside this platform gets confirmed.
   */
  async validateRecommendation(rec: Recommendation, opts: ValidationOptions = {}): Promise<ValidationResult[]> {
    const urls = rec.affectedUrls.slice(0, opts.maxUrls ?? 10);
    const results: ValidationResult[] = [];
    for (const url of urls) {
      const subject = await this.fetchSubject(url);
      const checks: ValidationCheck[] = [VALIDATORS['VALIDATE.HTTP_STATUS'](subject)];
      const validator = VALIDATORS[rec.validationRule];
      if (validator) checks.push(validator(subject, expectedFor(rec.validationRule, rec, null)));
      else {
        checks.push({
          rule: rec.validationRule,
          status: 'WARNING',
          message: ADVISORY_RULES.has(rec.validationRule)
            ? 'This condition requires human review; it cannot be verified by re-crawling.'
            : `No validator is implemented for ${rec.validationRule}.`,
        });
      }
      const after = toSnapshot(url, subject.page, subject.status);
      const result: ValidationResult = {
        id: `val-${hash(rec.id, url, String(Date.now()))}`,
        changeId: null,
        recommendationId: rec.id,
        url,
        status: worstStatus(checks),
        checks,
        before: opts.before?.get(url) as unknown as Record<string, unknown> ?? null,
        after: after as unknown as Record<string, unknown>,
        ranAt: Date.now(),
      };
      this.store.saveValidation(result);
      results.push(result);
    }
    return results;
  }

  /** Re-fetches a URL and assembles everything the validators need. */
  private async fetchSubject(url: string): Promise<ValidationSubject> {
    const res = await fetchUrl(url, {
      userAgent: this.config.crawl.userAgent,
      timeoutMs: this.config.crawl.requestTimeoutMs,
      maxBodyBytes: this.config.crawl.maxBodyBytes,
      maxRetries: 1,
    }, this.log);

    let page: PageProps | null = null;
    let parsed = null;
    if (res.body && (res.contentType ?? '').includes('html')) {
      parsed = parsePage(res.body, res.finalUrl, res.headers);
      page = {
        url: normalizeUrl(res.finalUrl) ?? res.finalUrl,
        finalUrl: res.finalUrl,
        status: res.status,
        contentType: res.contentType,
        redirectChain: res.redirectChain.map((h) => h.location),
        title: parsed.title,
        metaDescription: parsed.metaDescription,
        canonical: parsed.canonical,
        robotsMeta: parsed.robotsMeta,
        xRobotsTag: (res.headers['x-robots-tag'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        lang: parsed.lang,
        headings: parsed.headings,
        h1s: parsed.h1s,
        text: parsed.text,
        wordCount: parsed.text ? parsed.text.split(/\s+/).filter(Boolean).length : 0,
        fullTextHash: sha256(parsed.fullText),
        contentHash: sha256(parsed.text),
        simhash: '',
        links: parsed.links,
        images: parsed.images,
        videos: parsed.videos,
        schemas: parsed.schemas,
        openGraph: parsed.openGraph,
        twitter: parsed.twitter,
        hreflang: parsed.hreflang,
        landmarks: parsed.landmarks,
        depth: 0,
        indexable: !parsed.robotsMeta.includes('noindex'),
        indexabilityReasons: [],
        bytes: res.bodyBytes,
        fetchedAt: Date.now(),
        responseTimeMs: res.timingMs,
        sectionPath: '',
        fingerprints: parsed.fingerprints.map((f) => f.id),
        mobileViewport: parsed.viewport,
        contentInInitialHtml: parsed.contentInInitialHtml,
      };
    }

    const site = await this.siteFacts();
    return {
      url,
      page,
      parsed,
      status: res.status,
      headers: res.headers,
      redirectChain: res.redirectChain.map((h) => h.location),
      networkError: res.error,
      site,
    };
  }

  private siteFactsCache: ValidationSubject['site'] | null = null;

  /** robots.txt and sitemap state, fetched once per validation run. */
  private async siteFacts(): Promise<ValidationSubject['site']> {
    if (this.siteFactsCache) return this.siteFactsCache;
    const origin = new URL(this.config.crawl.startUrl).origin;

    const robots = await fetchUrl(`${origin}/robots.txt`, {
      userAgent: this.config.crawl.userAgent,
      timeoutMs: this.config.crawl.requestTimeoutMs,
      maxBodyBytes: 500_000,
      maxRetries: 0,
      acceptHeader: 'text/plain,*/*;q=0.8',
    }, this.log);

    const sitemapUrls: string[] = [];
    const sitemapRefs = robots.body.match(/^\s*sitemap\s*:\s*(\S+)/gim)?.map((l) => l.split(/:\s*/).slice(1).join(':').trim())
      ?? [`${origin}/sitemap.xml`];
    for (const ref of sitemapRefs.slice(0, 5)) {
      const res = await fetchUrl(ref, {
        userAgent: this.config.crawl.userAgent,
        timeoutMs: this.config.crawl.requestTimeoutMs,
        maxBodyBytes: this.config.crawl.maxBodyBytes,
        maxRetries: 0,
        acceptHeader: 'application/xml,text/xml,*/*;q=0.8',
      }, this.log);
      if (res.status !== 200 || !res.body) continue;
      const doc = parseSitemap(res.body, ref);
      sitemapUrls.push(...doc.entries.map((e) => e.loc));
      for (const child of doc.children.slice(0, 10)) {
        const childRes = await fetchUrl(child, {
          userAgent: this.config.crawl.userAgent,
          timeoutMs: this.config.crawl.requestTimeoutMs,
          maxBodyBytes: this.config.crawl.maxBodyBytes,
          maxRetries: 0,
        }, this.log);
        if (childRes.status === 200 && childRes.body) {
          sitemapUrls.push(...parseSitemap(childRes.body, child).entries.map((e) => e.loc));
        }
      }
    }

    // Inbound link counts come from the last completed crawl in the store, because
    // recounting them would require crawling the whole site again.
    const internalLinkTargets = new Map<string, number>();
    for (const edge of this.store.allEdges('links_to')) {
      const target = this.store.getNode(edge.to);
      const url = (target?.props as { url?: string } | undefined)?.url;
      if (url) internalLinkTargets.set(url, (internalLinkTargets.get(url) ?? 0) + 1);
    }

    this.siteFactsCache = {
      robotsStatus: robots.error ? null : robots.status,
      robotsBody: robots.body,
      sitemapUrls,
      internalLinkTargets,
    };
    return this.siteFactsCache;
  }
}

function toSnapshot(url: string, page: PageProps | null, status: number): PageSnapshot {
  return {
    url,
    status,
    title: page?.title ?? null,
    metaDescription: page?.metaDescription ?? null,
    canonical: page?.canonical ?? null,
    robotsMeta: page?.robotsMeta ?? [],
    h1Count: page?.h1s.length ?? 0,
    wordCount: page?.wordCount ?? 0,
    schemaTypes: page?.schemas.flatMap((s) => s.types) ?? [],
    internalLinkCount: page?.links.filter((l) => l.internal).length ?? 0,
    imageAltMissing: page?.images.filter((i) => i.alt === null).length ?? 0,
    contentHash: page?.contentHash ?? '',
    landmarks: page?.landmarks ?? [],
  };
}

/**
 * Before/after comparison. A change is only a success if it did not break anything it
 * was not supposed to touch.
 */
function detectRegressions(before: PageSnapshot | null, after: PageSnapshot): ValidationCheck[] {
  if (!before) {
    return [{
      rule: 'VALIDATE.NO_REGRESSION',
      status: 'WARNING',
      message: 'No before-state was captured, so regressions could not be detected.',
    }];
  }
  const regressions: string[] = [];

  if (before.status >= 200 && before.status < 300 && !(after.status >= 200 && after.status < 300)) {
    regressions.push(`the URL now returns HTTP ${after.status} (was ${before.status})`);
  }
  if (before.title && !after.title) regressions.push('the title was removed');
  if (before.metaDescription && !after.metaDescription) regressions.push('the meta description was removed');
  if (before.canonical && !after.canonical) regressions.push('the canonical link was removed');
  if (before.h1Count > 0 && after.h1Count === 0) regressions.push('the H1 was removed');
  if (before.schemaTypes.length > after.schemaTypes.length) {
    const lost = before.schemaTypes.filter((t) => !after.schemaTypes.includes(t));
    if (lost.length) regressions.push(`structured-data types were lost: ${[...new Set(lost)].join(', ')}`);
  }
  if (after.internalLinkCount < before.internalLinkCount * 0.8) {
    regressions.push(`internal links dropped from ${before.internalLinkCount} to ${after.internalLinkCount}`);
  }
  if (after.imageAltMissing > before.imageAltMissing) {
    regressions.push(`images missing alt text rose from ${before.imageAltMissing} to ${after.imageAltMissing}`);
  }
  if (before.wordCount > 100 && after.wordCount < before.wordCount * 0.5) {
    regressions.push(`main content shrank from ${before.wordCount} to ${after.wordCount} words`);
  }
  const lostLandmarks = before.landmarks.filter((l) => !after.landmarks.includes(l));
  if (lostLandmarks.length) regressions.push(`semantic landmarks were lost: ${lostLandmarks.join(', ')}`);

  if (regressions.length === 0) {
    return [{
      rule: 'VALIDATE.NO_REGRESSION',
      status: 'PASS',
      message: 'No previously present page property was lost.',
    }];
  }
  return [{
    rule: 'VALIDATE.NO_REGRESSION',
    status: 'FAIL',
    message: `The change caused ${regressions.length} regression(s): ${regressions.join('; ')}.`,
    expected: before,
    actual: after,
  }];
}

/** Supplies the rule-specific expectation a validator needs. */
function expectedFor(rule: string, rec: Recommendation, change: Change | null): unknown {
  switch (rule) {
    case 'VALIDATE.INTERNAL_LINK_EXISTS': {
      const after = change?.fix.after ?? rec.fix?.after;
      if (typeof after === 'string') return after;
      if (after && typeof after === 'object' && 'href' in after) return (after as { href: string }).href;
      return null;
    }
    case 'VALIDATE.SCHEMA_TYPE_PRESENT': {
      const m = /SCHEMA\.EXPECTED_TYPE_ABSENT\.(\w+)/.exec(rec.contributingSignals[0]?.rule ?? '');
      return m ? m[1] : null;
    }
    case 'VALIDATE.SCHEMA_REQUIRED_PROPERTIES': {
      const m = /SCHEMA\.MISSING_REQUIRED\.(\w+)\.(\w+)/.exec(rec.contributingSignals[0]?.rule ?? '');
      return m ? { type: m[1], props: [m[2]] } : undefined;
    }
    case 'VALIDATE.INTERNAL_LINKS_RESOLVE':
    case 'VALIDATE.INTERNAL_LINKS_DIRECT':
      return rec.affectedUrls;
    case 'VALIDATE.ROBOTS_META_MATCHES_INTENT':
      return true;
    default:
      return undefined;
  }
}
