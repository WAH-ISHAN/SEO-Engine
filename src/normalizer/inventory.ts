import {
  derived, observed, type CapabilityInventory, type Evidence, type InventoryConflict,
  type InventoryFact, type PageProps,
} from '../core/model.js';
import type { CrawlResult } from '../crawler/crawler.js';
import type { NormalizedSite } from './normalize.js';
import type { ContentModel } from '../content-engine/content-engine.js';
import type { EntityGraph } from '../entity-engine/entity-graph.js';
import { normalizeType } from '../parser/structured-data.js';
import { truncate } from '../core/text.js';

/**
 * Capability inventory: what this website already does.
 *
 * This runs before any engine analyses anything, and it is the platform's first rule
 * in executable form - detect the existing implementation before proposing a new one.
 * Recommendations consult this inventory so a fix never re-adds a capability the site
 * already has, and never silently replaces an existing configuration.
 */

export function buildInventory(
  site: NormalizedSite,
  crawl: CrawlResult,
  content: ContentModel,
  entities: EntityGraph,
): CapabilityInventory {
  const present: Record<string, InventoryFact> = {};
  const absent: string[] = [];
  const conflicts: InventoryConflict[] = [];
  const pages = site.pages.filter((p) => p.status >= 200 && p.status < 300);
  const total = Math.max(1, pages.length);

  const record = (capability: string, matching: PageProps[], detail: string, evidence: Evidence[]) => {
    if (matching.length === 0) {
      absent.push(capability);
      return;
    }
    present[capability] = {
      capability,
      coverage: Number((matching.length / total).toFixed(3)),
      detail,
      evidence: evidence.slice(0, 5),
    };
  };

  // -- Site-level infrastructure --------------------------------------------

  if (crawl.robots.fetched && crawl.robots.status === 200) {
    present['robots-txt'] = {
      capability: 'robots-txt',
      coverage: 1,
      detail:
        `robots.txt is served with ${crawl.robots.groups.length} user-agent group(s) and ` +
        `${crawl.robots.sitemaps.length} sitemap reference(s).`,
      evidence: [observed('crawler.robots', crawl.robots.url, {
        excerpt: truncate(crawl.robots.raw, 300),
        note: 'robots.txt returned HTTP 200',
      })],
    };
  } else {
    absent.push('robots-txt');
  }

  const sitemapUrlCount = crawl.sitemapEntries.length;
  if (sitemapUrlCount > 0) {
    present['xml-sitemap'] = {
      capability: 'xml-sitemap',
      coverage: 1,
      detail:
        `${crawl.sitemaps.length} sitemap document(s) listing ${sitemapUrlCount} URLs. ` +
        (crawl.robots.sitemaps.length
          ? 'Referenced from robots.txt.'
          : 'Found at a conventional location; not referenced from robots.txt.'),
      evidence: crawl.sitemaps.slice(0, 3).map((s) =>
        observed('crawler.sitemap', s.url, { note: `${s.kind} with ${s.entries.length} entries` })),
    };
  } else {
    absent.push('xml-sitemap');
  }

  // -- Page-level SEO machinery ---------------------------------------------

  const withTitle = pages.filter((p) => p.title && p.title.length > 0);
  record('titles', withTitle, `${withTitle.length} of ${total} pages serve a <title>.`,
    withTitle.slice(0, 3).map((p) => observed('parser.head', p.url, {
      excerpt: `<title>${truncate(p.title ?? '', 90)}</title>`,
    })));

  const withDesc = pages.filter((p) => p.metaDescription);
  record('meta-descriptions', withDesc, `${withDesc.length} of ${total} pages serve a meta description.`,
    withDesc.slice(0, 3).map((p) => observed('parser.head', p.url, {
      excerpt: `<meta name="description" content="${truncate(p.metaDescription ?? '', 90)}">`,
    })));

  const withCanonical = pages.filter((p) => p.canonical);
  record('canonical-tags', withCanonical,
    `${withCanonical.length} of ${total} pages declare rel=canonical. ` +
    `${withCanonical.filter((p) => p.canonical === p.url).length} are self-referencing.`,
    withCanonical.slice(0, 3).map((p) => observed('parser.head', p.url, {
      excerpt: `<link rel="canonical" href="${truncate(p.canonical ?? '', 90)}">`,
    })));

  const withOg = pages.filter((p) => Object.keys(p.openGraph).length >= 3);
  record('open-graph', withOg, `${withOg.length} of ${total} pages serve Open Graph metadata.`,
    withOg.slice(0, 3).map((p) => observed('parser.head', p.url, {
      note: `Open Graph properties: ${Object.keys(p.openGraph).slice(0, 6).join(', ')}`,
    })));

  const withTwitter = pages.filter((p) => Object.keys(p.twitter).length >= 2);
  record('twitter-cards', withTwitter, `${withTwitter.length} of ${total} pages serve Twitter card metadata.`,
    withTwitter.slice(0, 2).map((p) => observed('parser.head', p.url, {
      note: `Twitter properties: ${Object.keys(p.twitter).join(', ')}`,
    })));

  const withViewport = pages.filter((p) => p.mobileViewport);
  record('mobile-viewport', withViewport, `${withViewport.length} of ${total} pages declare a viewport meta tag.`,
    withViewport.slice(0, 2).map((p) => observed('parser.head', p.url, {
      excerpt: `<meta name="viewport" content="${truncate(p.mobileViewport ?? '', 70)}">`,
    })));

  const withLang = pages.filter((p) => p.lang);
  record('html-lang', withLang, `${withLang.length} of ${total} pages declare a lang attribute.`,
    withLang.slice(0, 2).map((p) => observed('parser.html', p.url, { excerpt: `<html lang="${p.lang}">` })));

  const withHreflang = pages.filter((p) => p.hreflang.length > 0);
  record('hreflang', withHreflang, `${withHreflang.length} of ${total} pages declare hreflang alternates.`,
    withHreflang.slice(0, 2).map((p) => observed('parser.head', p.url, {
      note: `Alternates: ${p.hreflang.map((h) => h.lang).join(', ')}`,
    })));

  const withSemantics = pages.filter((p) => p.landmarks.includes('main'));
  record('semantic-landmarks', withSemantics,
    `${withSemantics.length} of ${total} pages use a <main> landmark.`,
    withSemantics.slice(0, 2).map((p) => observed('parser.dom', p.url, {
      note: `Landmarks present: ${p.landmarks.join(', ')}`,
    })));

  // -- Structured data ------------------------------------------------------

  const schemaTypes = new Map<string, string[]>();
  for (const p of pages) {
    for (const s of p.schemas) {
      for (const t of s.types.map(normalizeType)) {
        if (!schemaTypes.has(t)) schemaTypes.set(t, []);
        schemaTypes.get(t)!.push(p.url);
      }
    }
  }
  for (const [type, urls] of schemaTypes) {
    present[`schema:${type}`] = {
      capability: `schema:${type}`,
      coverage: Number((urls.length / total).toFixed(3)),
      detail: `Schema.org ${type} is already implemented on ${urls.length} page(s).`,
      evidence: urls.slice(0, 3).map((u) => observed('parser.structured-data', u, {
        note: `${type} structured data present`,
      })),
    };
  }
  if (schemaTypes.size === 0) absent.push('structured-data');

  // -- AEO / AIO / GEO capabilities the site already ships ------------------

  const contentModels = [...content.byUrl.values()];
  const faqPages = contentModels.filter((m) => m.formats.includes('faq'));
  record('faq-content', faqPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${faqPages.length} page(s) already present question-and-answer content.`,
    faqPages.slice(0, 3).map((m) => observed('content-engine', m.url, {
      note: `${m.questions.length} question(s) detected`,
    })));

  const answerPages = contentModels.filter((m) => m.answerBlocks.length > 0);
  record('direct-answers', answerPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${answerPages.length} page(s) answer a stated question directly beneath it.`,
    answerPages.slice(0, 3).map((m) => m.answerBlocks[0].evidence));

  const howToPages = contentModels.filter((m) => m.howToSteps.length > 0);
  record('how-to-content', howToPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${howToPages.length} page(s) present step-by-step procedures.`,
    howToPages.slice(0, 2).map((m) => m.howToSteps[0].evidence));

  const comparisonPages = contentModels.filter((m) => m.comparisons.length > 0);
  record('comparison-content', comparisonPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${comparisonPages.length} page(s) present comparison content.`,
    comparisonPages.slice(0, 2).map((m) => m.comparisons[0].evidence));

  const citingPages = contentModels.filter((m) => m.externalReferences.some((r) => r.inMainContent));
  record('external-citations', citingPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${citingPages.length} page(s) cite sources outside this site from within their main content.`,
    citingPages.slice(0, 3).map((m) => observed('content-engine', m.url, {
      note: `${m.externalReferences.filter((r) => r.inMainContent).length} outbound reference(s) in main content`,
    })));

  const authoredPages = contentModels.filter((m) => m.authors.length > 0);
  record('author-attribution', authoredPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${authoredPages.length} page(s) attribute an author in structured data.`,
    authoredPages.slice(0, 2).map((m) => observed('content-engine', m.url, {
      note: `Author(s): ${m.authors.join(', ')}`,
    })));

  const datedPages = contentModels.filter((m) => m.publishedDate || m.modifiedDate);
  record('content-dates', datedPages.map((m) => site.pageByUrl.get(m.url)!).filter(Boolean),
    `${datedPages.length} page(s) state a published or modified date.`,
    datedPages.slice(0, 2).map((m) => observed('content-engine', m.url, {
      note: `published=${m.publishedDate ?? 'none'} modified=${m.modifiedDate ?? 'none'}`,
    })));

  if (entities.primaryOrganization) {
    const org = entities.primaryOrganization;
    present['organization-identity'] = {
      capability: 'organization-identity',
      coverage: 1,
      detail:
        `The site identifies its operator as "${org.name}"` +
        (org.origins.includes('schema') ? ' in structured data.' : ' in metadata only.'),
      evidence: org.evidence.slice(0, 3),
    };
  } else {
    absent.push('organization-identity');
  }

  // -- Platform fingerprints ------------------------------------------------

  const fingerprintCounts = new Map<string, string[]>();
  for (const p of pages) {
    for (const f of p.fingerprints) {
      if (!fingerprintCounts.has(f)) fingerprintCounts.set(f, []);
      fingerprintCounts.get(f)!.push(p.url);
    }
  }
  for (const [id, urls] of fingerprintCounts) {
    present[`platform:${id}`] = {
      capability: `platform:${id}`,
      coverage: Number((urls.length / total).toFixed(3)),
      detail: `Detected ${id} on ${urls.length} page(s). Changes must be made through this system.`,
      evidence: urls.slice(0, 2).map((u) => observed('parser.fingerprint', u, { note: `${id} fingerprint matched` })),
    };
  }

  // -- Conflicts between existing implementations ---------------------------

  conflicts.push(...detectConflicts(site, pages));

  return { present, absent: [...new Set(absent)], conflicts };
}

interface Observation {
  url: string;
  /** One line describing what was found, in the platform's words. */
  summary: string;
  /** The conflicting markup itself, quoted verbatim from the page. */
  markup: string;
}

/** Joins the first n regex matches into one quotable excerpt. */
function matchAll(html: string, re: RegExp, limit: number): string {
  return [...html.matchAll(re)].slice(0, limit).map((m) => m[0].replace(/\s+/g, ' ').trim()).join('  |  ');
}

/**
 * Conflicting implementations: two mechanisms on the same page giving contradictory
 * instructions. These are reported before any recommendation is generated, because
 * resolving them is a prerequisite for changing anything safely.
 */
function detectConflicts(site: NormalizedSite, pages: PageProps[]): InventoryConflict[] {
  const conflicts: InventoryConflict[] = [];

  // Each entry keeps the URL alongside what was actually observed there, so the
  // evidence shows the reader the conflicting markup rather than restating the verdict.
  const multiCanonical: Observation[] = [];
  const multiTitle: Observation[] = [];
  const canonicalVsNoindex: Observation[] = [];
  const canonicalToNonIndexable: Observation[] = [];
  const metaVsHeader: Observation[] = [];

  for (const p of pages) {
    const parsed = site.parsedByUrl.get(p.url);
    const html = site.htmlByUrl.get(p.url) ?? '';
    if (parsed && parsed.canonicalCount > 1) {
      multiCanonical.push({
        url: p.url,
        summary: `${parsed.canonicalCount} rel=canonical elements on one page`,
        markup: matchAll(html, /<link\b[^>]*rel=["']?canonical["']?[^>]*>/gi, 3),
      });
    }
    if (parsed && parsed.titleCount > 1) {
      multiTitle.push({
        url: p.url,
        summary: `${parsed.titleCount} title elements on one page`,
        markup: matchAll(html, /<title\b[^>]*>[\s\S]{0,80}?<\/title>/gi, 3),
      });
    }

    const noindex = p.robotsMeta.includes('noindex') || p.xRobotsTag.includes('noindex');
    if (noindex && p.canonical && p.canonical !== p.url) {
      canonicalVsNoindex.push({
        url: p.url,
        summary: 'the page is excluded from the index while pointing its canonical elsewhere',
        markup: `robots: [${[...p.robotsMeta, ...p.xRobotsTag].join(', ')}]  |  canonical -> ${p.canonical}`,
      });
    }

    const metaNoindex = p.robotsMeta.includes('noindex');
    const headerNoindex = p.xRobotsTag.includes('noindex');
    const metaIndex = p.robotsMeta.includes('index');
    if ((metaIndex && headerNoindex) || (metaNoindex && p.xRobotsTag.includes('index'))) {
      metaVsHeader.push({
        url: p.url,
        summary: 'the meta tag and the HTTP header give different indexing instructions',
        markup: `<meta name="robots" content="${p.robotsMeta.join(', ')}">  |  X-Robots-Tag: ${p.xRobotsTag.join(', ')}`,
      });
    }

    if (p.canonical && p.canonical !== p.url) {
      const target = site.pageByUrl.get(p.canonical);
      if (target && !target.indexable) {
        canonicalToNonIndexable.push({
          url: p.url,
          summary: 'the canonical target is itself excluded from the index',
          markup: `canonical -> ${p.canonical}  |  target state: ${target.indexabilityReasons.join(', ')}`,
        });
      }
    }
  }

  const push = (capability: string, found: Observation[], detail: string, source: string) => {
    if (found.length === 0) return;
    conflicts.push({
      capability,
      detail,
      urls: found.slice(0, 50).map((f) => f.url),
      evidence: found.slice(0, 3).map((f) => observed(source, f.url, {
        note: f.summary,
        excerpt: truncate(f.markup, 260),
      })),
    });
  };

  push('canonical-tags', multiCanonical,
    'More than one rel=canonical is served on the same page, so the declared canonical is ambiguous. ' +
    'This usually means two systems (for example a theme and an SEO plugin) are both emitting one.',
    'parser.head');
  push('titles', multiTitle,
    'More than one <title> element is served on the same page, which indicates two systems writing the head.',
    'parser.head');
  push('canonical-tags', canonicalVsNoindex,
    'The page is marked noindex while also pointing rel=canonical at a different URL. ' +
    'These instructions contradict each other.',
    'parser.head');
  push('canonical-tags', canonicalToNonIndexable,
    'The page canonicalizes to a URL that is itself blocked from indexing.',
    'normalizer');
  push('robots-directives', metaVsHeader,
    'The robots meta tag and the X-Robots-Tag header give different indexing instructions for the same URL.',
    'crawler.http');

  return conflicts;
}

/** True when the site already implements a capability at meaningful coverage. */
export function hasCapability(inv: CapabilityInventory, capability: string, minCoverage = 0.5): boolean {
  const fact = inv.present[capability];
  return !!fact && fact.coverage >= minCoverage;
}

/** Lists the existing capabilities a change to these pages must not disturb. */
export function capabilitiesTouching(inv: CapabilityInventory, capabilities: string[]): string[] {
  return capabilities.filter((c) => inv.present[c] !== undefined);
}
