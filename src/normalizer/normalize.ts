import type { CrawlResult } from '../crawler/crawler.js';
import type { RawRecord, RawStore } from '../crawler/raw-store.js';
import { isAllowed } from '../crawler/robots.js';
import type { Logger } from '../core/logger.js';
import {
  derived, observed, type Evidence, type IndexabilityReason, type PageProps,
} from '../core/model.js';
import { GraphStore } from '../core/store.js';
import { normalizeUrl, sectionPath } from '../core/url.js';
import { sha256, simhash, truncate } from '../core/text.js';
import { parsePage, type ParsedPage } from '../parser/page.js';

/**
 * Turns raw responses into the single normalized model.
 *
 * This is the only place raw bytes are interpreted. Every engine downstream reads
 * Page nodes and graph edges, never HTML, which is what stops SEO/AEO/AIO/GEO from
 * drifting into four different views of the same site.
 */

export interface NormalizedSite {
  origin: string;
  websiteId: string;
  pages: PageProps[];
  pageByUrl: Map<string, PageProps>;
  /** Parsed DOM per URL, retained for engines that need document structure. */
  parsedByUrl: Map<string, ParsedPage>;
  /** Raw HTML per URL, for evidence excerpts. */
  htmlByUrl: Map<string, string>;
  /** Non-HTML or failed fetches, kept so the report can account for every URL. */
  nonPageRecords: RawRecord[];
  /**
   * Every URL that redirected, keyed by the URL that was requested. A redirected
   * response is normalized under its destination, so without this the fact that the
   * original URL redirects would be lost.
   */
  redirects: Map<string, { finalUrl: string; hops: number; status: number }>;
}

export function normalize(
  crawl: CrawlResult,
  raw: RawStore,
  store: GraphStore,
  userAgent: string,
  log: Logger,
): NormalizedSite {
  const origin = crawl.origin;
  const domain = new URL(origin).hostname;
  const at = Date.now();

  const website = store.upsertNode('Website', origin, origin, {
    origin,
    domain,
    crawledAt: crawl.startedAt,
    pageCount: 0,
  });
  const domainNode = store.upsertNode('Domain', domain, domain, { domain, origin });
  store.addEdge('belongs_to', website.id, domainNode.id, [
    observed('normalizer', origin, { note: `Site served from host ${domain}` }),
  ]);

  const pages: PageProps[] = [];
  const pageByUrl = new Map<string, PageProps>();
  const parsedByUrl = new Map<string, ParsedPage>();
  const htmlByUrl = new Map<string, string>();
  const nonPageRecords: RawRecord[] = [];
  const redirects = new Map<string, { finalUrl: string; hops: number; status: number }>();

  for (const rec of raw.all()) {
    if (rec.url.endsWith('/robots.txt')) continue;
    if (rec.redirectChain.length > 0) {
      const dest = normalizeUrl(rec.finalUrl) ?? rec.finalUrl;
      const from = normalizeUrl(rec.url) ?? rec.url;
      if (dest !== from) {
        redirects.set(from, { finalUrl: dest, hops: rec.redirectChain.length, status: rec.redirectChain[0].status });
        recordRedirect(store, rec, from, dest, at);
      }
    }
    const ct = (rec.contentType ?? '').toLowerCase();
    const looksHtml = ct.includes('html') || (!ct && /<html|<!doctype html/i.test(raw.body(rec).slice(0, 2000)));

    if (rec.error || !looksHtml || rec.status < 200 || rec.status >= 400) {
      nonPageRecords.push(rec);
      // Error and redirect URLs still become nodes: link checking needs their status.
      recordNonPage(store, rec, at);
      continue;
    }

    const html = raw.body(rec);
    const parsed = parsePage(html, rec.finalUrl, rec.headers);
    const page = toPageProps(rec, parsed, html, crawl, userAgent);

    // A redirected fetch is normalized under its destination, which may already have
    // been crawled directly. Keep one Page per normalized URL.
    if (pageByUrl.has(page.url)) continue;
    pages.push(page);
    pageByUrl.set(page.url, page);
    parsedByUrl.set(page.url, parsed);
    htmlByUrl.set(page.url, html);
  }

  log.info(`normalized ${pages.length} HTML pages, ${nonPageRecords.length} non-page responses`);

  // Materialize nodes and structural edges.
  for (const page of pages) {
    const node = store.upsertNode('Page', page.url, page.title ?? page.url, page as unknown as Record<string, unknown>, at);
    store.addEdge('contains', website.id, node.id, [
      observed('normalizer', page.url, { note: `HTTP ${page.status} on the site host` }),
    ]);

    const section = store.upsertNode('Section', `${origin}${page.sectionPath}`, page.sectionPath, {
      path: page.sectionPath,
      origin,
    }, at);
    store.addEdge('belongs_to', node.id, section.id, [
      derived('normalizer', page.url, { note: `URL path groups into section ${page.sectionPath}` }),
    ]);
    store.addEdge('contains', website.id, section.id, [
      derived('normalizer', origin, { note: `Section ${page.sectionPath} observed on this site` }),
    ]);

    for (const img of page.images) {
      const imgNode = store.upsertNode('Image', img.src, img.alt ?? img.src, { ...img }, at);
      store.addEdge('contains', node.id, imgNode.id, [
        observed('parser.img', page.url, { excerpt: `<img src="${truncate(img.src, 120)}" alt="${img.alt ?? ''}">` }),
      ], { inMainContent: img.inMainContent });
    }
    for (const vid of page.videos) {
      const vNode = store.upsertNode('Video', vid.src, vid.title ?? vid.src, { ...vid }, at);
      store.addEdge('contains', node.id, vNode.id, [
        observed('parser.video', page.url, { excerpt: truncate(vid.src, 160) }),
      ]);
    }
    for (const [i, s] of page.schemas.entries()) {
      const key = `${page.url}#schema-${i}`;
      const sNode = store.upsertNode('Schema', key, s.types.join(',') || s.syntax, {
        syntax: s.syntax, types: s.types, raw: s.raw, parseError: s.parseError ?? null, url: page.url,
      }, at);
      store.addEdge('describes', sNode.id, node.id, [
        observed('parser.structured-data', page.url, {
          excerpt: truncate(JSON.stringify(s.raw), 240),
          note: `${s.syntax} block declaring ${s.types.join(', ') || 'no @type'}`,
        }),
      ]);
    }
  }

  // Link edges, once every page node exists.
  for (const page of pages) {
    const fromNode = store.findNode('Page', page.url);
    if (!fromNode) continue;
    for (const link of page.links) {
      if (!link.internal) continue;
      const target = store.findNode('Page', link.href) ?? store.findNode('URL', link.href);
      if (!target) continue;
      store.addEdge(
        'links_to', fromNode.id, target.id,
        [observed('parser.a', page.url, {
          excerpt: `<a href="${truncate(link.rawHref, 100)}">${truncate(link.anchor, 60)}</a>`,
        })],
        { anchor: link.anchor, rel: link.rel, inMainContent: link.inMainContent, nofollow: link.nofollow },
        link.anchor,
      );
    }
    if (page.canonical && page.canonical !== page.url) {
      const target = store.findNode('Page', page.canonical) ?? store.findNode('URL', page.canonical);
      if (target) {
        store.addEdge('canonical_of', target.id, fromNode.id, [
          observed('parser.link-canonical', page.url, {
            excerpt: `<link rel="canonical" href="${truncate(page.canonical, 120)}">`,
          }),
        ]);
      }
    }
  }

  store.upsertNode('Website', origin, origin, {
    origin, domain, crawledAt: crawl.startedAt, pageCount: pages.length,
  }, at);

  return { origin, websiteId: website.id, pages, pageByUrl, parsedByUrl, htmlByUrl, nonPageRecords, redirects };
}

/** Records a redirect as a first-class fact, whatever the destination turned out to be. */
function recordRedirect(store: GraphStore, rec: RawRecord, from: string, to: string, at: number): void {
  const fromNode = store.upsertNode('URL', from, from, {
    url: from, finalUrl: to, status: rec.redirectChain[0].status, redirected: true,
  }, at);
  const toNode = store.upsertNode('URL', to, to, { url: to, status: rec.status }, at);
  const redirect = store.upsertNode('Redirect', from, `${from} -> ${to}`, {
    from, to,
    hops: rec.redirectChain.map((hop) => ({ url: hop.url, status: hop.status, to: hop.location })),
    chainLength: rec.redirectChain.length,
  }, at);
  const evidence = [observed('crawler.http', from, {
    note: rec.redirectChain.map((hop) => `${hop.status} -> ${hop.location}`).join(' | '),
    value: rec.redirectChain.length,
  })];
  store.addEdge('redirects_to', fromNode.id, toNode.id, evidence);
  store.addEdge('references', redirect.id, toNode.id, evidence);
}

function recordNonPage(store: GraphStore, rec: RawRecord, at: number): void {
  const label = rec.error ? `network error: ${rec.error}` : `HTTP ${rec.status}`;
  const node = store.upsertNode('URL', rec.url, label, {
    url: rec.url,
    finalUrl: rec.finalUrl,
    status: rec.status,
    error: rec.error,
    contentType: rec.contentType,
    redirectChain: rec.redirectChain.map((h) => h.location),
  }, at);

  if (rec.redirectChain.length) {
    const target = store.upsertNode('URL', rec.finalUrl, rec.finalUrl, {
      url: rec.finalUrl, status: rec.status,
    }, at);
    const redirect = store.upsertNode('Redirect', rec.url, `${rec.url} -> ${rec.finalUrl}`, {
      from: rec.url,
      to: rec.finalUrl,
      hops: rec.redirectChain.map((h) => ({ url: h.url, status: h.status, to: h.location })),
      chainLength: rec.redirectChain.length,
    }, at);
    store.addEdge('redirects_to', node.id, target.id, [
      observed('crawler.http', rec.url, {
        note: rec.redirectChain.map((h) => `${h.status} -> ${h.location}`).join(' | '),
      }),
    ]);
    store.addEdge('references', redirect.id, target.id, [
      observed('crawler.http', rec.url, { note: `Redirect chain of ${rec.redirectChain.length} hop(s)` }),
    ]);
  }
}

function toPageProps(
  rec: RawRecord, parsed: ParsedPage, html: string, crawl: CrawlResult, userAgent: string,
): PageProps {
  const url = normalizeUrl(rec.finalUrl) ?? rec.finalUrl;
  const xRobots = (rec.headers['x-robots-tag'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const reasons: IndexabilityReason[] = [];
  if (parsed.robotsMeta.includes('noindex') || parsed.robotsMeta.includes('none')) {
    reasons.push('robots-meta-noindex');
  }
  if (xRobots.includes('noindex') || xRobots.includes('none')) reasons.push('x-robots-noindex');
  if (rec.status >= 400) reasons.push('http-error');
  if (rec.redirectChain.length > 0) reasons.push('redirect');
  if (crawl.robots.fetched) {
    const decision = isAllowed(crawl.robots, userAgent, url);
    if (!decision.allowed) reasons.push('robots-txt-disallow');
  }
  if (parsed.canonical && parsed.canonical !== url) reasons.push('non-canonical');
  if (reasons.length === 0) reasons.push('ok');

  // A non-canonical page is still crawlable and served; it is simply not the URL the
  // site wants indexed. Only hard blocks make a page non-indexable.
  const hardBlocks: IndexabilityReason[] = [
    'robots-meta-noindex', 'x-robots-noindex', 'robots-txt-disallow', 'http-error',
  ];
  const indexable = !reasons.some((r) => hardBlocks.includes(r));

  return {
    url,
    finalUrl: rec.finalUrl,
    status: rec.status,
    contentType: rec.contentType,
    redirectChain: rec.redirectChain.map((h) => h.location),
    title: parsed.title,
    metaDescription: parsed.metaDescription,
    canonical: parsed.canonical,
    robotsMeta: parsed.robotsMeta,
    xRobotsTag: xRobots,
    lang: parsed.lang,
    headings: parsed.headings,
    h1s: parsed.h1s,
    text: parsed.text,
    wordCount: parsed.text ? parsed.text.split(/\s+/).filter(Boolean).length : 0,
    fullTextHash: sha256(parsed.fullText),
    contentHash: sha256(parsed.text),
    simhash: simhash(parsed.text),
    links: parsed.links,
    images: parsed.images,
    videos: parsed.videos,
    schemas: parsed.schemas,
    openGraph: parsed.openGraph,
    twitter: parsed.twitter,
    hreflang: parsed.hreflang,
    landmarks: parsed.landmarks,
    depth: rec.depth,
    indexable,
    indexabilityReasons: reasons,
    bytes: rec.bodyBytes || html.length,
    fetchedAt: rec.fetchedAt,
    responseTimeMs: rec.timingMs,
    sectionPath: sectionPath(url),
    fingerprints: parsed.fingerprints.map((f) => f.id),
    mobileViewport: parsed.viewport,
    contentInInitialHtml: parsed.contentInInitialHtml,
  };
}

export function pageEvidence(page: PageProps, source: string, note: string, excerpt?: string): Evidence {
  return observed(source, page.url, { note, excerpt });
}
