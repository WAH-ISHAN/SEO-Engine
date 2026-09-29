import { analyzablePages, indexablePages, type AnalysisContext, type AnalysisEngine } from '../core/context.js';
import { derived, observed, type Evidence, type PageProps, type Signal } from '../core/model.js';
import { PROBLEM_FAMILIES as P, signal } from '../core/problems.js';
import { truncate } from '../core/text.js';
import { pathOf, urlQualityIssues } from '../core/url.js';
import { hasCapability } from '../normalizer/inventory.js';

/**
 * Technical and on-page SEO analysis.
 *
 * Every check reports what was observed, the URLs it was observed on, and the rule that
 * will prove a fix landed. Nothing here is inferred about how a search engine will
 * treat the site; the findings are about the site's own configuration.
 */
export const seoEngine: AnalysisEngine = {
  id: 'seo',
  name: 'Technical & On-Page SEO',
  analyze(ctx: AnalysisContext): Signal[] {
    return [
      ...crawlability(ctx),
      ...indexability(ctx),
      ...canonicalization(ctx),
      ...sitemapChecks(ctx),
      ...urlStructure(ctx),
      ...titles(ctx),
      ...descriptions(ctx),
      ...headings(ctx),
      ...contentChecks(ctx),
      ...linkHealth(ctx),
      ...mediaChecks(ctx),
      ...semanticHtml(ctx),
      ...mobileAndLang(ctx),
      ...performanceSignals(ctx),
      ...transportSecurity(ctx),
    ];
  },
};

// ---------------------------------------------------------------------------

function crawlability(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const { crawl } = ctx;

  if (!hasCapability(ctx.inventory, 'robots-txt', 1)) {
    out.push(signal({
      engine: 'seo', family: P.ROBOTS_MISSING, scope: ctx.site.origin,
      rule: 'SEO.ROBOTS_TXT_ABSENT', category: 'TECHNICAL_SEO',
      title: 'No robots.txt is served',
      detail:
        `A request to ${ctx.site.origin}/robots.txt did not return a usable file ` +
        `(status ${crawl.robots.status ?? 'network error'}). Crawlers will assume everything is ` +
        'crawlable, and there is nowhere to advertise the XML sitemap.',
      severity: 'medium', confidence: 0.95,
      affectedUrls: [`${ctx.site.origin}/robots.txt`],
      evidence: [observed('crawler.robots', `${ctx.site.origin}/robots.txt`, {
        note: crawl.robotsProbeError ?? `HTTP ${crawl.robots.status ?? 0}`,
        value: crawl.robots.status,
      })],
      currentState: 'No robots.txt, or it does not return HTTP 200.',
      recommendedState: 'robots.txt returns HTTP 200 and references the XML sitemap.',
      validationRule: 'VALIDATE.ROBOTS_TXT_200',
      fix: {
        kind: 'robots.txt', url: `${ctx.site.origin}/robots.txt`,
        before: null,
        after: buildRobotsTxt(ctx),
        rationale: 'Adds a permissive robots.txt that advertises the sitemap without blocking anything.',
        requiresHuman: true,
      },
    }));
  }

  // Pages that robots.txt blocks but that the site links to internally are being
  // withheld from crawlers while still being promoted internally.
  const linkedBlocked = crawl.blockedByRobots.filter((b) =>
    ctx.site.pages.some((p) => p.links.some((l) => l.href === b.url)));
  if (linkedBlocked.length > 0) {
    out.push(signal({
      engine: 'seo', family: P.ROBOTS_BLOCKS_CONTENT, scope: ctx.site.origin,
      rule: 'SEO.ROBOTS_BLOCKS_LINKED_PAGES', category: 'TECHNICAL_SEO',
      title: `robots.txt blocks ${linkedBlocked.length} internally linked URL(s)`,
      detail:
        'These URLs are linked from pages on the site but disallowed in robots.txt, so crawlers ' +
        'are told not to fetch them. Either the links or the robots rules are wrong.',
      severity: 'high', confidence: 0.9,
      affectedUrls: linkedBlocked.map((b) => b.url),
      evidence: linkedBlocked.slice(0, 8).map((b) => observed('crawler.robots', b.url, {
        note: `Blocked by robots.txt rule: ${b.rule}`, value: b.rule,
      })),
      currentState: `${linkedBlocked.length} internally linked URLs are disallowed in robots.txt.`,
      recommendedState: 'Internally linked URLs that should be indexed are crawlable, or the links are removed.',
      validationRule: 'VALIDATE.ROBOTS_ALLOWS_URLS',
    }));
  }
  return out;
}

function indexability(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];

  const noindexed = analyzablePages(ctx).filter(
    (p) => p.robotsMeta.includes('noindex') || p.robotsMeta.includes('none') || p.xRobotsTag.includes('noindex'),
  );
  // A noindex page that receives many internal links is usually a mistake, so it is
  // reported; a noindex page nothing links to is probably deliberate.
  const linkedNoindex = noindexed.filter((p) => (ctx.siteGraph.metrics.get(p.url)?.inLinks ?? 0) >= 2);
  if (linkedNoindex.length > 0) {
    out.push(signal({
      engine: 'seo', family: P.PAGE_NOINDEX, scope: 'linked-noindex',
      rule: 'SEO.NOINDEX_ON_LINKED_PAGE', category: 'TECHNICAL_SEO',
      title: `${linkedNoindex.length} internally promoted page(s) are set to noindex`,
      detail:
        'These pages are linked from at least two other pages on the site but instruct search ' +
        'engines not to index them. Confirm the noindex is intentional.',
      severity: 'high', confidence: 0.75,
      affectedUrls: linkedNoindex.map((p) => p.url),
      evidence: linkedNoindex.slice(0, 8).map((p) => observed('parser.head', p.url, {
        excerpt: `<meta name="robots" content="${p.robotsMeta.join(', ')}">`,
        note: `${ctx.siteGraph.metrics.get(p.url)?.inLinks ?? 0} internal links point here`,
      })),
      currentState: 'Pages carry a noindex directive while being linked internally.',
      recommendedState: 'Indexing directives match how the site links to the page.',
      validationRule: 'VALIDATE.ROBOTS_META_MATCHES_INTENT',
    }));
  }

  for (const conflict of ctx.inventory.conflicts.filter((c) => c.capability === 'robots-directives')) {
    out.push(signal({
      engine: 'seo', family: P.ROBOTS_DIRECTIVE_CONFLICT, scope: 'meta-vs-header',
      rule: 'SEO.ROBOTS_DIRECTIVE_CONFLICT', category: 'TECHNICAL_SEO',
      title: 'Robots meta tag and X-Robots-Tag header disagree',
      detail: conflict.detail,
      severity: 'high', confidence: 0.95,
      affectedUrls: conflict.urls,
      evidence: conflict.evidence,
      currentState: 'Two indexing mechanisms give contradictory instructions on the same URL.',
      recommendedState: 'One mechanism owns indexing directives and the other is removed.',
      validationRule: 'VALIDATE.ROBOTS_DIRECTIVES_AGREE',
    }));
  }
  return out;
}

function canonicalization(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = analyzablePages(ctx);

  const missing = pages.filter((p) => !p.canonical && p.indexable);
  if (missing.length > 0) {
    // If the site canonicalizes nowhere at all, that is one site-wide decision, not N
    // page problems. If most pages have one and a few do not, the few are the defect.
    const coverage = ctx.inventory.present['canonical-tags']?.coverage ?? 0;
    const siteWide = coverage < 0.2;
    out.push(signal({
      engine: 'seo',
      family: P.CANONICAL_MISSING,
      scope: siteWide ? ctx.site.origin : 'partial-canonical-coverage',
      rule: 'SEO.CANONICAL_MISSING', category: 'TECHNICAL_SEO',
      title: siteWide
        ? 'No page declares a canonical URL'
        : `${missing.length} indexable page(s) do not declare a canonical URL`,
      detail: siteWide
        ? 'No rel=canonical was found anywhere on the site. Without it, any URL variation that ' +
          'serves the same content competes with itself.'
        : `${Math.round(coverage * 100)}% of pages declare a canonical URL, but these do not, ` +
          'which makes canonicalization inconsistent across the site.',
      severity: siteWide ? 'high' : 'medium',
      confidence: 0.9,
      affectedUrls: missing.map((p) => p.url),
      evidence: missing.slice(0, 8).map((p) => observed('parser.head', p.url, {
        note: 'No <link rel="canonical"> element in the served HTML',
      })),
      currentState: `${missing.length} of ${pages.length} pages serve no rel=canonical.`,
      recommendedState: 'Every indexable page declares a self-referencing canonical URL unless it is a duplicate.',
      validationRule: 'VALIDATE.CANONICAL_PRESENT',
      fix: missing.length
        ? {
            kind: 'meta.canonical', url: missing[0].url, before: null, after: missing[0].url,
            rationale: 'Self-referencing canonical, derived from the URL the page was served at.',
            requiresHuman: false,
          }
        : undefined,
    }));
  }

  const broken: { page: PageProps; reason: string }[] = [];
  for (const p of pages) {
    if (!p.canonical || p.canonical === p.url) continue;
    const target = ctx.site.pageByUrl.get(p.canonical);
    if (!target) {
      const rec = ctx.crawl.records.find((r) => r.url === p.canonical);
      if (rec && (rec.status >= 400 || rec.error)) {
        broken.push({ page: p, reason: `canonical target returns HTTP ${rec.status || 'network error'}` });
      } else if (rec && rec.redirectChain.length) {
        broken.push({ page: p, reason: `canonical target redirects to ${rec.finalUrl}` });
      }
    } else if (!target.indexable) {
      broken.push({ page: p, reason: `canonical target is itself blocked from indexing (${target.indexabilityReasons.join(', ')})` });
    }
  }
  if (broken.length > 0) {
    out.push(signal({
      engine: 'seo', family: P.CANONICAL_BROKEN, scope: 'broken-canonical-targets',
      rule: 'SEO.CANONICAL_TARGET_UNUSABLE', category: 'TECHNICAL_SEO',
      title: `${broken.length} page(s) canonicalize to an unusable URL`,
      detail: 'A canonical tag pointing at an error, a redirect, or a noindex URL discards the ' +
        'signal entirely rather than consolidating it.',
      severity: 'high', confidence: 0.9,
      affectedUrls: broken.map((b) => b.page.url),
      evidence: broken.slice(0, 8).map((b) => observed('parser.head', b.page.url, {
        excerpt: `<link rel="canonical" href="${truncate(b.page.canonical ?? '', 100)}">`,
        note: b.reason,
      })),
      currentState: 'Canonical tags point at URLs that cannot serve as canonicals.',
      recommendedState: 'Every canonical points at a URL that returns 200 and is indexable.',
      validationRule: 'VALIDATE.CANONICAL_TARGET_OK',
    }));
  }

  for (const conflict of ctx.inventory.conflicts.filter((c) => c.capability === 'canonical-tags')) {
    out.push(signal({
      engine: 'seo', family: P.CANONICAL_CONFLICT, scope: conflict.detail.slice(0, 40),
      rule: 'SEO.CANONICAL_CONFLICT', category: 'TECHNICAL_SEO',
      title: 'Conflicting canonical configuration detected',
      detail: conflict.detail,
      severity: 'high', confidence: 0.95,
      affectedUrls: conflict.urls,
      evidence: conflict.evidence,
      currentState:
        `${conflict.urls.length} page(s) carry a conflicting canonical configuration. ` +
        `Affected: ${conflict.urls.slice(0, 3).map((u) => truncate(u, 60)).join(', ')}` +
        (conflict.urls.length > 3 ? ` and ${conflict.urls.length - 3} more.` : '.'),
      recommendedState: 'Exactly one system emits rel=canonical, and it agrees with the indexing directives.',
      validationRule: 'VALIDATE.SINGLE_CANONICAL',
    }));
  }
  return out;
}

function sitemapChecks(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const { crawl } = ctx;
  const indexable = indexablePages(ctx);

  if (crawl.sitemapEntries.length === 0) {
    out.push(signal({
      engine: 'seo', family: P.SITEMAP_MISSING, scope: ctx.site.origin,
      rule: 'SEO.SITEMAP_ABSENT', category: 'TECHNICAL_SEO',
      title: 'No XML sitemap was found',
      detail:
        'Neither robots.txt nor the conventional sitemap locations produced a usable sitemap. ' +
        'Discovery then depends entirely on internal linking, which leaves orphan pages invisible.',
      severity: 'high', confidence: 0.9,
      affectedUrls: [`${ctx.site.origin}/sitemap.xml`],
      evidence: [derived('crawler.sitemap', ctx.site.origin, {
        note: `Probed ${crawl.sitemaps.length} candidate location(s); none returned sitemap entries`,
      })],
      currentState: 'No XML sitemap is served.',
      recommendedState: 'An XML sitemap lists every canonical, indexable URL and is referenced from robots.txt.',
      validationRule: 'VALIDATE.SITEMAP_REACHABLE',
      fix: {
        kind: 'sitemap.xml', url: `${ctx.site.origin}/sitemap.xml`, before: null,
        after: indexable.map((p) => p.url),
        rationale: 'Sitemap generated from the indexable pages actually discovered during the crawl.',
        requiresHuman: true,
      },
    }));
    return out;
  }

  const sitemapUrls = new Set(crawl.sitemapEntries.map((e) => e.loc));
  const bad: { url: string; reason: string }[] = [];
  for (const entry of crawl.sitemapEntries) {
    const page = ctx.site.pageByUrl.get(entry.loc);
    const rec = ctx.crawl.records.find((r) => r.url === entry.loc);
    if (rec && (rec.status >= 400 || rec.error)) {
      bad.push({ url: entry.loc, reason: `returns HTTP ${rec.status || 'network error'}` });
    } else if (rec && rec.redirectChain.length > 0) {
      bad.push({ url: entry.loc, reason: `redirects to ${rec.finalUrl}` });
    } else if (page && !page.indexable) {
      bad.push({ url: entry.loc, reason: `is not indexable (${page.indexabilityReasons.join(', ')})` });
    } else if (page && page.canonical && page.canonical !== page.url) {
      bad.push({ url: entry.loc, reason: `canonicalizes to a different URL (${page.canonical})` });
    }
  }
  if (bad.length > 0) {
    out.push(signal({
      engine: 'seo', family: P.SITEMAP_BAD_ENTRIES, scope: ctx.site.origin,
      rule: 'SEO.SITEMAP_CONTAINS_BAD_URLS', category: 'TECHNICAL_SEO',
      title: `The sitemap lists ${bad.length} URL(s) that should not be in it`,
      detail:
        'A sitemap is a statement about which URLs are canonical and indexable. Entries that ' +
        'error, redirect, or point away from themselves contradict that statement.',
      severity: 'medium', confidence: 0.9,
      affectedUrls: bad.map((b) => b.url),
      evidence: bad.slice(0, 8).map((b) => observed('crawler.sitemap', b.url, { note: `Sitemap entry ${b.reason}` })),
      currentState: `${bad.length} of ${crawl.sitemapEntries.length} sitemap entries are not canonical 200 URLs.`,
      recommendedState: 'The sitemap lists only canonical URLs that return HTTP 200 and are indexable.',
      validationRule: 'VALIDATE.SITEMAP_ENTRIES_CLEAN',
    }));
  }

  const missing = indexable.filter((p) => !sitemapUrls.has(p.url) && (!p.canonical || p.canonical === p.url));
  if (missing.length > 0 && missing.length >= indexable.length * 0.1) {
    out.push(signal({
      engine: 'seo', family: P.SITEMAP_STALE, scope: ctx.site.origin,
      rule: 'SEO.SITEMAP_INCOMPLETE', category: 'TECHNICAL_SEO',
      title: `${missing.length} indexable page(s) are absent from the sitemap`,
      detail:
        'These pages were found by crawling the site but are not listed in any sitemap, so the ' +
        'sitemap no longer reflects the site.',
      severity: 'medium', confidence: 0.85,
      affectedUrls: missing.map((p) => p.url),
      evidence: missing.slice(0, 8).map((p) => derived('crawler.sitemap', p.url, {
        note: 'Discovered by crawl, not present in any sitemap document',
      })),
      currentState: `Sitemap covers ${indexable.length - missing.length} of ${indexable.length} indexable pages.`,
      recommendedState: 'The sitemap is regenerated whenever pages are added or removed.',
      validationRule: 'VALIDATE.SITEMAP_COVERS_INDEXABLE',
    }));
  }

  if (crawl.robots.fetched && crawl.robots.sitemaps.length === 0 && crawl.sitemapEntries.length > 0) {
    out.push(signal({
      engine: 'seo', family: P.SITEMAP_MISSING, scope: 'robots-sitemap-reference',
      rule: 'SEO.SITEMAP_NOT_IN_ROBOTS', category: 'TECHNICAL_SEO',
      title: 'The sitemap is not referenced from robots.txt',
      detail: 'A sitemap exists but robots.txt does not point to it, so crawlers have to guess its location.',
      severity: 'low', confidence: 0.95,
      affectedUrls: [`${ctx.site.origin}/robots.txt`],
      evidence: [observed('crawler.robots', crawl.robots.url, {
        excerpt: truncate(crawl.robots.raw, 200), note: 'No Sitemap: directive present',
      })],
      currentState: 'robots.txt contains no Sitemap: directive.',
      recommendedState: 'robots.txt contains a Sitemap: line for each sitemap index.',
      validationRule: 'VALIDATE.ROBOTS_REFERENCES_SITEMAP',
      fix: {
        kind: 'robots.txt', url: `${ctx.site.origin}/robots.txt`,
        before: crawl.robots.raw,
        after: `${crawl.robots.raw.trimEnd()}\n\nSitemap: ${crawl.sitemaps[0]?.url ?? `${ctx.site.origin}/sitemap.xml`}\n`,
        rationale: 'Appends a Sitemap directive for the sitemap that was actually found during the crawl.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

function urlStructure(ctx: AnalysisContext): Signal[] {
  const byIssue = new Map<string, string[]>();
  for (const p of indexablePages(ctx)) {
    for (const issue of urlQualityIssues(p.url)) {
      if (!byIssue.has(issue)) byIssue.set(issue, []);
      byIssue.get(issue)!.push(p.url);
    }
  }
  const out: Signal[] = [];
  for (const [issue, urls] of byIssue) {
    if (urls.length === 0) continue;
    const severity = issue === 'excessive-depth' || issue === 'spaces' ? 'medium' : 'low';
    out.push(signal({
      engine: 'seo', family: P.URL_STRUCTURE, scope: issue,
      rule: `SEO.URL_${issue.toUpperCase().replace(/-/g, '_')}`, category: 'TECHNICAL_SEO',
      title: `${urls.length} URL(s) have a structural issue: ${issue.replace(/-/g, ' ')}`,
      detail: URL_ISSUE_DETAIL[issue] ?? `URLs exhibit the pattern "${issue}".`,
      severity, confidence: 0.85,
      affectedUrls: urls,
      evidence: urls.slice(0, 8).map((u) => observed('normalizer.url', u, { note: `URL path: ${pathOf(u)}` })),
      currentState: `${urls.length} URLs match the "${issue}" pattern.`,
      recommendedState: 'URLs are lowercase, hyphen-separated, shallow, and free of query clutter.',
      // Changing a live URL is never automatic: it needs redirect planning and approval.
      validationRule: 'VALIDATE.URL_SHAPE',
    }));
  }
  return out;
}

const URL_ISSUE_DETAIL: Record<string, string> = {
  'uppercase-characters': 'Uppercase characters in a path create case-sensitive duplicates on most servers.',
  underscores: 'Underscores are not treated as word separators by all parsers; hyphens are unambiguous.',
  spaces: 'Encoded spaces make URLs fragile when copied, shared, or logged.',
  'excessive-length': 'Very long paths are hard to share and often indicate a deep, unclear hierarchy.',
  'excessive-depth': 'Deeply nested paths usually mean content sits far from the homepage in the site graph.',
  'many-query-parameters': 'Multiple query parameters produce many URLs serving near-identical content.',
  'file-extension-exposed': 'Exposing a server file extension ties the URL to the current implementation.',
  'numeric-id-in-slug': 'Numeric identifiers in slugs carry no meaning for readers or for machines.',
};

// ---------------------------------------------------------------------------
// On-page
// ---------------------------------------------------------------------------

function titles(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx);

  const missing = pages.filter((p) => !p.title || p.title.trim().length === 0);
  if (missing.length) {
    out.push(signal({
      engine: 'seo', family: P.TITLE_MISSING, scope: 'site',
      rule: 'SEO.TITLE_MISSING', category: 'ON_PAGE_SEO',
      title: `${missing.length} page(s) have no title`,
      detail: 'A page with no <title> gives search engines, browsers and link previews nothing to show.',
      severity: 'critical', confidence: 0.99,
      affectedUrls: missing.map((p) => p.url),
      evidence: missing.slice(0, 8).map((p) => observed('parser.head', p.url, {
        note: 'No non-empty <title> element in the served HTML',
      })),
      currentState: `${missing.length} indexable pages serve no title.`,
      recommendedState: 'Every indexable page serves a unique, descriptive title.',
      validationRule: 'VALIDATE.TITLE_PRESENT',
      fix: titleFixFor(ctx, missing[0]),
    }));
  }

  const dupes = groupBy(pages.filter((p) => p.title), (p) => p.title!.trim().toLowerCase());
  for (const [titleText, group] of dupes) {
    if (group.length < 2) continue;
    out.push(signal({
      engine: 'seo', family: P.TITLE_DUPLICATE, scope: titleText,
      rule: 'SEO.TITLE_DUPLICATE', category: 'ON_PAGE_SEO',
      title: `${group.length} pages share the title "${truncate(group[0].title!, 60)}"`,
      detail: 'Identical titles make the pages indistinguishable in results and usually indicate ' +
        'a template that does not vary its title per page.',
      severity: 'medium', confidence: 0.95,
      affectedUrls: group.map((p) => p.url),
      evidence: group.slice(0, 6).map((p) => observed('parser.head', p.url, {
        excerpt: `<title>${truncate(p.title ?? '', 90)}</title>`,
      })),
      currentState: `${group.length} pages serve the identical title "${truncate(group[0].title!, 60)}".`,
      recommendedState: 'Each page states its own subject in its title.',
      validationRule: 'VALIDATE.TITLE_UNIQUE',
    }));
  }

  const badLength = pages.filter((p) => p.title && (p.title.length < 15 || p.title.length > 65));
  if (badLength.length) {
    out.push(signal({
      engine: 'seo', family: P.TITLE_LENGTH, scope: 'site',
      rule: 'SEO.TITLE_LENGTH', category: 'ON_PAGE_SEO',
      title: `${badLength.length} title(s) fall outside the 15-65 character range`,
      detail: 'Very short titles under-describe the page; very long ones get truncated in results.',
      severity: 'low', confidence: 0.7,
      affectedUrls: badLength.map((p) => p.url),
      evidence: badLength.slice(0, 8).map((p) => observed('parser.head', p.url, {
        excerpt: truncate(p.title ?? '', 100), value: p.title?.length,
        note: `${p.title?.length} characters`,
      })),
      currentState: `${badLength.length} titles are shorter than 15 or longer than 65 characters.`,
      recommendedState: 'Titles describe the page in roughly 15-65 characters.',
      validationRule: 'VALIDATE.TITLE_LENGTH',
    }));
  }
  return out;
}

function titleFixFor(ctx: AnalysisContext, page: PageProps) {
  // The proposed title is assembled only from text the page already publishes.
  const h1 = page.h1s[0];
  const heading = page.headings.find((h) => h.level <= 2)?.text;
  const source = h1 ?? heading;
  if (!source) return undefined;
  const brand = ctx.entityGraph.primaryOrganization?.name;
  const proposed = brand && !source.toLowerCase().includes(brand.toLowerCase())
    ? `${source} | ${brand}`
    : source;
  return {
    kind: 'meta.title' as const,
    url: page.url,
    before: page.title,
    after: truncate(proposed, 65),
    rationale: `Derived from the page's own ${h1 ? 'H1' : 'top heading'} text` +
      (brand ? ' plus the organization name declared in the site\'s structured data.' : '.'),
    requiresHuman: false,
  };
}

function descriptions(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx);

  const missing = pages.filter((p) => !p.metaDescription);
  if (missing.length) {
    out.push(signal({
      engine: 'seo', family: P.DESCRIPTION_MISSING, scope: 'site',
      rule: 'SEO.DESCRIPTION_MISSING', category: 'ON_PAGE_SEO',
      title: `${missing.length} page(s) have no meta description`,
      detail: 'Without a description the snippet is assembled from whatever text is on the page, ' +
        'which is often navigation or boilerplate.',
      severity: 'medium', confidence: 0.9,
      affectedUrls: missing.map((p) => p.url),
      evidence: missing.slice(0, 8).map((p) => observed('parser.head', p.url, {
        note: 'No <meta name="description"> in the served HTML',
      })),
      currentState: `${missing.length} of ${pages.length} indexable pages serve no meta description.`,
      recommendedState: 'Every indexable page serves a description summarising that page.',
      validationRule: 'VALIDATE.DESCRIPTION_PRESENT',
      fix: descriptionFixFor(missing[0]),
    }));
  }

  const dupes = groupBy(pages.filter((p) => p.metaDescription), (p) => p.metaDescription!.trim().toLowerCase());
  const duplicated = [...dupes.values()].filter((g) => g.length > 1);
  if (duplicated.length) {
    const urls = duplicated.flat().map((p) => p.url);
    out.push(signal({
      engine: 'seo', family: P.DESCRIPTION_DUPLICATE, scope: 'site',
      rule: 'SEO.DESCRIPTION_DUPLICATE', category: 'ON_PAGE_SEO',
      title: `${urls.length} page(s) share a meta description with another page`,
      detail: 'Duplicated descriptions indicate a template default rather than a per-page summary.',
      severity: 'low', confidence: 0.9,
      affectedUrls: urls,
      evidence: duplicated.slice(0, 4).flatMap((g) => g.slice(0, 2).map((p) =>
        observed('parser.head', p.url, { excerpt: truncate(p.metaDescription ?? '', 120) }))),
      currentState: `${duplicated.length} description(s) are reused across multiple pages.`,
      recommendedState: 'Each page has a description written for that page.',
      validationRule: 'VALIDATE.DESCRIPTION_UNIQUE',
    }));
  }

  const badLength = pages.filter((p) => p.metaDescription &&
    (p.metaDescription.length < 70 || p.metaDescription.length > 165));
  if (badLength.length) {
    out.push(signal({
      engine: 'seo', family: P.DESCRIPTION_LENGTH, scope: 'site',
      rule: 'SEO.DESCRIPTION_LENGTH', category: 'ON_PAGE_SEO',
      title: `${badLength.length} meta description(s) fall outside the 70-165 character range`,
      detail: 'Descriptions below 70 characters waste the space; above 165 they are truncated.',
      severity: 'low', confidence: 0.65,
      affectedUrls: badLength.map((p) => p.url),
      evidence: badLength.slice(0, 6).map((p) => observed('parser.head', p.url, {
        excerpt: truncate(p.metaDescription ?? '', 180), note: `${p.metaDescription?.length} characters`,
      })),
      currentState: `${badLength.length} descriptions are outside 70-165 characters.`,
      recommendedState: 'Descriptions summarise the page in roughly 70-165 characters.',
      validationRule: 'VALIDATE.DESCRIPTION_LENGTH',
    }));
  }
  return out;
}

function descriptionFixFor(page: PageProps) {
  // Built strictly by extracting the page's own opening sentences.
  if (!page.text || page.wordCount < 30) return undefined;
  const firstSentences = page.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  if (firstSentences.length < 50) return undefined;
  return {
    kind: 'meta.description' as const,
    url: page.url,
    before: page.metaDescription,
    after: truncate(firstSentences, 160),
    rationale: 'Extracted verbatim from the opening of the page\'s own main content; no new claims are introduced.',
    requiresHuman: true,
  };
}

function headings(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx).filter((p) => p.wordCount >= 50);

  const noH1 = pages.filter((p) => p.h1s.length === 0);
  if (noH1.length) {
    out.push(signal({
      engine: 'seo', family: P.H1_MISSING, scope: 'site',
      rule: 'SEO.H1_MISSING', category: 'ON_PAGE_SEO',
      title: `${noH1.length} page(s) have no H1`,
      detail: 'The H1 states what the page is about in the document itself, for readers, assistive ' +
        'technology and machine parsers alike.',
      severity: 'medium', confidence: 0.9,
      affectedUrls: noH1.map((p) => p.url),
      evidence: noH1.slice(0, 8).map((p) => observed('parser.dom', p.url, {
        note: `No <h1>; page has ${p.headings.length} heading(s) starting at h${p.headings[0]?.level ?? 0}`,
      })),
      currentState: `${noH1.length} content pages serve no H1.`,
      recommendedState: 'Each content page has exactly one H1 naming its subject.',
      validationRule: 'VALIDATE.H1_PRESENT',
    }));
  }

  const multiH1 = pages.filter((p) => p.h1s.length > 1);
  if (multiH1.length) {
    out.push(signal({
      engine: 'seo', family: P.H1_MULTIPLE, scope: 'site',
      rule: 'SEO.H1_MULTIPLE', category: 'ON_PAGE_SEO',
      title: `${multiH1.length} page(s) have more than one H1`,
      detail: 'Multiple H1 elements make the page\'s primary subject ambiguous to any consumer that ' +
        'relies on the heading outline.',
      severity: 'low', confidence: 0.8,
      affectedUrls: multiH1.map((p) => p.url),
      evidence: multiH1.slice(0, 6).map((p) => observed('parser.dom', p.url, {
        excerpt: p.h1s.map((h) => truncate(h, 40)).join(' | '), note: `${p.h1s.length} H1 elements`,
      })),
      currentState: `${multiH1.length} pages serve more than one H1.`,
      recommendedState: 'One H1 per page; subordinate sections use H2 and below.',
      validationRule: 'VALIDATE.H1_SINGLE',
    }));
  }

  const skipped = pages.filter((p) => hasSkippedLevel(p));
  if (skipped.length) {
    out.push(signal({
      engine: 'seo', family: P.HEADING_ORDER, scope: 'site',
      rule: 'SEO.HEADING_ORDER', category: 'ACCESSIBILITY',
      title: `${skipped.length} page(s) skip heading levels`,
      detail: 'A heading outline that jumps levels (H2 straight to H4) breaks the document structure ' +
        'that screen readers and content parsers navigate by.',
      severity: 'low', confidence: 0.85,
      affectedUrls: skipped.map((p) => p.url),
      evidence: skipped.slice(0, 6).map((p) => observed('parser.dom', p.url, {
        note: `Heading levels in order: ${p.headings.map((h) => `h${h.level}`).join(' ')}`,
      })),
      currentState: `${skipped.length} pages have a non-sequential heading outline.`,
      recommendedState: 'Heading levels descend one at a time.',
      validationRule: 'VALIDATE.HEADING_ORDER',
    }));
  }
  return out;
}

function hasSkippedLevel(p: PageProps): boolean {
  let prev = 0;
  for (const h of p.headings) {
    if (prev !== 0 && h.level > prev + 1) return true;
    prev = h.level;
  }
  return false;
}

function contentChecks(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx);

  // Index and landing pages are legitimately short, so they are excluded rather than
  // reported as thin.
  const thin = pages.filter((p) => {
    const model = ctx.content.byUrl.get(p.url);
    const isIndex = model?.formats.includes('index') || model?.formats.includes('landing');
    return p.wordCount < 200 && !isIndex && p.url !== ctx.siteGraph.homepage;
  });
  if (thin.length) {
    out.push(signal({
      engine: 'seo', family: P.THIN_CONTENT, scope: 'site',
      rule: 'SEO.THIN_CONTENT', category: 'CONTENT',
      title: `${thin.length} indexable page(s) carry under 200 words of main content`,
      detail:
        'These pages are indexable but say very little. The fix is to determine whether each one ' +
        'should be expanded, merged into a fuller page, or removed from the index - not to pad it.',
      severity: 'medium', confidence: 0.75,
      affectedUrls: thin.map((p) => p.url),
      evidence: thin.slice(0, 8).map((p) => derived('content-engine', p.url, {
        note: `${p.wordCount} words in the detected main content region`, value: p.wordCount,
      })),
      currentState: `${thin.length} indexable pages have fewer than 200 words.`,
      recommendedState: 'Every indexable page either says something substantive or is deliberately excluded from the index.',
      validationRule: 'VALIDATE.WORD_COUNT',
      fix: {
        kind: 'content.manual', url: thin[0].url, before: thin[0].wordCount, after: null,
        rationale: 'Requires an editorial decision: expand, consolidate, or noindex. ' +
          'This platform does not generate page content to satisfy a word count.',
        requiresHuman: true,
      },
    }));
  }

  for (const cluster of ctx.siteGraph.duplicateClusters) {
    const resolved = cluster.canonicalTarget !== null;
    out.push(signal({
      engine: 'seo', family: P.DUPLICATE_CONTENT, scope: cluster.urls.join('|'),
      rule: cluster.kind === 'exact' ? 'SEO.DUPLICATE_CONTENT_EXACT' : 'SEO.DUPLICATE_CONTENT_NEAR',
      category: 'CONTENT',
      title: `${cluster.urls.length} pages serve ${cluster.kind === 'exact' ? 'identical' : 'near-identical'} content`,
      detail: resolved
        ? `These pages already agree on a canonical (${cluster.canonicalTarget}), so the duplication ` +
          'is declared. Confirm that is intended.'
        : 'These pages duplicate each other and do not agree on a single canonical URL.',
      severity: resolved ? 'low' : cluster.kind === 'exact' ? 'high' : 'medium',
      confidence: cluster.kind === 'exact' ? 0.95 : 0.7,
      affectedUrls: cluster.urls,
      evidence: cluster.urls.slice(0, 6).map((u) => derived('site-graph.duplicates', u, {
        note: `Content similarity ${(cluster.similarity * 100).toFixed(1)}% with the rest of the cluster`,
        value: cluster.similarity,
      })),
      currentState: `${cluster.urls.length} URLs serve the same content` +
        (resolved ? ' with a shared canonical.' : ' with no shared canonical.'),
      recommendedState: 'One URL is canonical and the rest point to it, or the duplicates are consolidated.',
      validationRule: 'VALIDATE.DUPLICATE_RESOLVED',
    }));
  }
  return out;
}

function linkHealth(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];

  const broken = ctx.siteGraph.brokenInternalLinks;
  if (broken.length) {
    const byTarget = groupBy(broken, (b) => b.to);
    out.push(signal({
      engine: 'seo', family: P.BROKEN_INTERNAL_LINK, scope: 'site',
      rule: 'SEO.BROKEN_INTERNAL_LINK', category: 'TECHNICAL_SEO',
      title: `${broken.length} internal link(s) point to ${byTarget.size} broken URL(s)`,
      detail: 'Internal links to error pages waste crawl budget and strand readers.',
      severity: 'high', confidence: 0.95,
      affectedUrls: [...new Set(broken.map((b) => b.from))],
      evidence: broken.slice(0, 10).map((b) => observed('crawler.http', b.from, {
        excerpt: `<a href="${truncate(b.to, 90)}">${truncate(b.anchor, 40)}</a>`,
        note: `Target returns ${b.status === null ? 'a network error' : `HTTP ${b.status}`}`,
      })),
      currentState: `${broken.length} internal links resolve to error responses.`,
      recommendedState: 'Internal links point at URLs that return HTTP 200, or are removed.',
      validationRule: 'VALIDATE.INTERNAL_LINKS_RESOLVE',
      fix: {
        kind: 'link.fix-broken', url: broken[0].from,
        before: broken[0].to, after: null,
        rationale: 'Requires a human decision on the correct destination; the platform will not ' +
          'guess a replacement URL.',
        requiresHuman: true,
      },
    }));
  }

  const redirected = ctx.siteGraph.redirectedInternalLinks;
  if (redirected.length) {
    out.push(signal({
      engine: 'seo', family: P.INTERNAL_LINK_TO_REDIRECT, scope: 'site',
      rule: 'SEO.INTERNAL_LINK_TO_REDIRECT', category: 'TECHNICAL_SEO',
      title: `${redirected.length} internal link(s) point at a redirect`,
      detail: 'Each hop adds latency and dilutes the directness of the link. Linking straight to the ' +
        'final URL removes the hop.',
      severity: 'low', confidence: 0.9,
      affectedUrls: [...new Set(redirected.map((r) => r.from))],
      evidence: redirected.slice(0, 8).map((r) => observed('crawler.http', r.from, {
        note: `Links to ${r.to}, which redirects to ${r.finalUrl} after ${r.hops} hop(s)`,
      })),
      currentState: `${redirected.length} internal links resolve through a redirect.`,
      recommendedState: 'Internal links point at final destination URLs.',
      validationRule: 'VALIDATE.INTERNAL_LINKS_DIRECT',
      fix: {
        kind: 'link.add-internal', url: redirected[0].from,
        before: redirected[0].to, after: redirected[0].finalUrl,
        rationale: 'The destination is the URL the server itself redirects to, observed during the crawl.',
        requiresHuman: false,
      },
    }));
  }

  const longChains = ctx.site.nonPageRecords.filter((r) => r.redirectChain.length >= 3);
  if (longChains.length) {
    out.push(signal({
      engine: 'seo', family: P.REDIRECT_CHAIN, scope: 'site',
      rule: 'SEO.REDIRECT_CHAIN', category: 'TECHNICAL_SEO',
      title: `${longChains.length} URL(s) redirect through three or more hops`,
      detail: 'Long redirect chains are slow and fragile; some crawlers stop following them.',
      severity: 'medium', confidence: 0.95,
      affectedUrls: longChains.map((r) => r.url),
      evidence: longChains.slice(0, 6).map((r) => observed('crawler.http', r.url, {
        note: r.redirectChain.map((h) => `${h.status} -> ${h.location}`).join(' | '),
      })),
      currentState: `${longChains.length} URLs take three or more hops to resolve.`,
      recommendedState: 'Each redirect goes straight to its final destination in one hop.',
      validationRule: 'VALIDATE.REDIRECT_HOPS',
    }));
  }

  const errors = ctx.site.nonPageRecords.filter((r) => r.status >= 400 || r.error);
  if (errors.length) {
    out.push(signal({
      engine: 'seo', family: P.HTTP_ERROR, scope: 'site',
      rule: 'SEO.HTTP_ERROR', category: 'TECHNICAL_SEO',
      title: `${errors.length} URL(s) returned an error response`,
      detail: 'These URLs were discovered during the crawl but did not return usable content.',
      severity: errors.some((e) => e.status >= 500) ? 'high' : 'medium',
      confidence: 0.98,
      affectedUrls: errors.map((r) => r.url),
      evidence: errors.slice(0, 10).map((r) => observed('crawler.http', r.url, {
        note: r.error ? `Network error: ${r.error}` : `HTTP ${r.status}`,
        value: r.status,
      })),
      currentState: `${errors.length} discovered URLs return errors.`,
      recommendedState: 'Discovered URLs return 200, or return 410/404 deliberately and are not linked.',
      validationRule: 'VALIDATE.HTTP_STATUS',
    }));
  }
  return out;
}

function mediaChecks(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = analyzablePages(ctx);

  const missingAlt: { url: string; src: string }[] = [];
  const missingDims: { url: string; src: string }[] = [];
  for (const p of pages) {
    for (const img of p.images) {
      if (img.alt === null) missingAlt.push({ url: p.url, src: img.src });
      if (img.inMainContent && (img.width === null || img.height === null)) {
        missingDims.push({ url: p.url, src: img.src });
      }
    }
  }

  if (missingAlt.length) {
    out.push(signal({
      engine: 'seo', family: P.IMAGE_ALT_MISSING, scope: 'site',
      rule: 'SEO.IMAGE_ALT_MISSING', category: 'ACCESSIBILITY',
      title: `${missingAlt.length} image(s) have no alt attribute`,
      detail:
        'An image with no alt attribute is unreadable to screen readers and unindexable as content. ' +
        'Decorative images should carry an explicitly empty alt, which is different from having none.',
      severity: 'medium', confidence: 0.95,
      affectedUrls: [...new Set(missingAlt.map((i) => i.url))],
      evidence: missingAlt.slice(0, 10).map((i) => observed('parser.img', i.url, {
        excerpt: `<img src="${truncate(i.src, 100)}">`, note: 'No alt attribute present',
      })),
      currentState: `${missingAlt.length} images omit the alt attribute entirely.`,
      recommendedState: 'Content images describe themselves in alt text; decorative images use alt="".',
      validationRule: 'VALIDATE.IMAGE_ALT',
      fix: {
        kind: 'image.alt', url: missingAlt[0].url, before: null, after: null,
        rationale: 'Alt text must describe the specific image. This platform will not invent a ' +
          'description of an image it has not been given.',
        requiresHuman: true,
      },
    }));
  }

  if (missingDims.length) {
    out.push(signal({
      engine: 'seo', family: P.IMAGE_DIMENSIONS_MISSING, scope: 'site',
      rule: 'SEO.IMAGE_DIMENSIONS_MISSING', category: 'PERFORMANCE',
      title: `${missingDims.length} content image(s) declare no width or height`,
      detail: 'Without intrinsic dimensions the browser cannot reserve space, so the page shifts as ' +
        'images load.',
      severity: 'low', confidence: 0.85,
      affectedUrls: [...new Set(missingDims.map((i) => i.url))],
      evidence: missingDims.slice(0, 8).map((i) => observed('parser.img', i.url, {
        excerpt: `<img src="${truncate(i.src, 90)}">`, note: 'No width/height attributes',
      })),
      currentState: `${missingDims.length} main-content images have no declared dimensions.`,
      recommendedState: 'Content images declare width and height so layout is stable while loading.',
      validationRule: 'VALIDATE.IMAGE_DIMENSIONS',
    }));
  }

  const unlabeled = pages
    .map((p) => ({ url: p.url, n: ctx.site.parsedByUrl.get(p.url)?.unlabeledControls ?? 0 }))
    .filter((x) => x.n > 0);
  if (unlabeled.length) {
    out.push(signal({
      engine: 'seo', family: P.FORM_CONTROL_UNLABELED, scope: 'site',
      rule: 'SEO.FORM_CONTROL_UNLABELED', category: 'ACCESSIBILITY',
      title: `${unlabeled.reduce((a, x) => a + x.n, 0)} form control(s) have no accessible name`,
      detail: 'Controls with no label, aria-label or associated text cannot be identified by assistive technology.',
      severity: 'medium', confidence: 0.85,
      affectedUrls: unlabeled.map((x) => x.url),
      evidence: unlabeled.slice(0, 8).map((x) => observed('parser.dom', x.url, {
        note: `${x.n} control(s) without an accessible name`, value: x.n,
      })),
      currentState: `${unlabeled.length} pages contain unlabeled form controls.`,
      recommendedState: 'Every interactive control has a programmatically associated name.',
      validationRule: 'VALIDATE.CONTROL_LABELS',
    }));
  }
  return out;
}

function semanticHtml(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx).filter((p) => p.wordCount >= 100);

  const noMain = pages.filter((p) => !p.landmarks.includes('main'));
  if (noMain.length >= Math.max(1, pages.length * 0.3)) {
    out.push(signal({
      engine: 'seo', family: P.SEMANTIC_STRUCTURE_WEAK, scope: 'main-landmark',
      rule: 'SEO.NO_MAIN_LANDMARK', category: 'ACCESSIBILITY',
      title: `${noMain.length} page(s) have no <main> landmark`,
      detail:
        'Without a <main> element, the boundary between page content and site chrome has to be ' +
        'guessed by every consumer - assistive technology, reader modes, and content extractors alike.',
      severity: 'medium', confidence: 0.85,
      affectedUrls: noMain.map((p) => p.url),
      evidence: noMain.slice(0, 8).map((p) => observed('parser.dom', p.url, {
        note: `Landmarks present: ${p.landmarks.join(', ') || 'none'}`,
      })),
      currentState: `${noMain.length} of ${pages.length} content pages have no <main> element.`,
      recommendedState: 'Each page wraps its primary content in <main>, with nav and footer outside it.',
      validationRule: 'VALIDATE.MAIN_LANDMARK',
    }));
  }

  const jsOnly = pages.filter((p) => !p.contentInInitialHtml);
  if (jsOnly.length) {
    out.push(signal({
      engine: 'seo', family: P.CONTENT_NOT_IN_HTML, scope: 'site',
      rule: 'SEO.CONTENT_REQUIRES_JS', category: 'TECHNICAL_SEO',
      title: `${jsOnly.length} page(s) serve little or no content in the initial HTML`,
      detail:
        'The served HTML contains scripts but almost no text, so the content is assembled in the ' +
        'browser. Any consumer that does not execute JavaScript sees an effectively empty page.',
      severity: 'high', confidence: 0.7,
      affectedUrls: jsOnly.map((p) => p.url),
      evidence: jsOnly.slice(0, 6).map((p) => derived('parser.fingerprint', p.url, {
        note: `${p.wordCount} words of text in the server response`, value: p.wordCount,
      })),
      currentState: `${jsOnly.length} pages require JavaScript execution to show their content.`,
      recommendedState: 'Primary content is present in the server-rendered HTML.',
      validationRule: 'VALIDATE.CONTENT_IN_HTML',
    }));
  }
  return out;
}

function mobileAndLang(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = analyzablePages(ctx);

  const noViewport = pages.filter((p) => !p.mobileViewport);
  if (noViewport.length) {
    out.push(signal({
      engine: 'seo', family: P.VIEWPORT_MISSING, scope: 'site',
      rule: 'SEO.VIEWPORT_MISSING', category: 'TECHNICAL_SEO',
      title: `${noViewport.length} page(s) declare no viewport meta tag`,
      detail: 'Without a viewport declaration, mobile browsers render the page at desktop width and scale it down.',
      severity: 'high', confidence: 0.95,
      affectedUrls: noViewport.map((p) => p.url),
      evidence: noViewport.slice(0, 8).map((p) => observed('parser.head', p.url, {
        note: 'No <meta name="viewport"> present',
      })),
      currentState: `${noViewport.length} pages have no viewport meta tag.`,
      recommendedState: 'Every page declares <meta name="viewport" content="width=device-width, initial-scale=1">.',
      validationRule: 'VALIDATE.VIEWPORT_PRESENT',
      fix: {
        kind: 'meta.viewport', url: noViewport[0].url, before: null,
        after: 'width=device-width, initial-scale=1',
        rationale: 'Standard responsive viewport declaration.',
        requiresHuman: false,
      },
    }));
  }

  const noLang = pages.filter((p) => !p.lang);
  if (noLang.length) {
    out.push(signal({
      engine: 'seo', family: P.LANG_MISSING, scope: 'site',
      rule: 'SEO.LANG_MISSING', category: 'ACCESSIBILITY',
      title: `${noLang.length} page(s) declare no language`,
      detail: 'The lang attribute tells screen readers which pronunciation rules to use and tells ' +
        'parsers which language the text is in.',
      severity: 'low', confidence: 0.95,
      affectedUrls: noLang.map((p) => p.url),
      evidence: noLang.slice(0, 6).map((p) => observed('parser.html', p.url, { note: 'No lang attribute on <html>' })),
      currentState: `${noLang.length} pages have no lang attribute.`,
      recommendedState: 'The <html> element declares the page language.',
      validationRule: 'VALIDATE.LANG_PRESENT',
    }));
  }

  const noSocial = indexablePages(ctx).filter((p) => !p.openGraph['og:title'] && !p.openGraph['og:description']);
  if (noSocial.length >= Math.max(1, indexablePages(ctx).length * 0.5)) {
    out.push(signal({
      engine: 'seo', family: P.SOCIAL_METADATA_MISSING, scope: 'site',
      rule: 'SEO.OPEN_GRAPH_MISSING', category: 'ON_PAGE_SEO',
      title: `${noSocial.length} page(s) serve no Open Graph metadata`,
      detail: 'Without Open Graph tags, link previews fall back to whatever the platform can scrape.',
      severity: 'low', confidence: 0.9,
      affectedUrls: noSocial.map((p) => p.url),
      evidence: noSocial.slice(0, 6).map((p) => observed('parser.head', p.url, {
        note: 'No og:title or og:description present',
      })),
      currentState: `${noSocial.length} pages have no Open Graph metadata.`,
      recommendedState: 'Pages declare og:title, og:description, og:url and og:image.',
      validationRule: 'VALIDATE.OPEN_GRAPH_PRESENT',
    }));
  }
  return out;
}

function performanceSignals(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = analyzablePages(ctx);

  // Server response time measured by this crawler. It is a server-side signal only and
  // says nothing about rendering or Core Web Vitals in a real browser.
  const slow = pages.filter((p) => p.responseTimeMs > 1500);
  if (slow.length) {
    out.push(signal({
      engine: 'seo', family: P.SLOW_RESPONSE, scope: 'site',
      rule: 'SEO.SLOW_RESPONSE', category: 'PERFORMANCE',
      title: `${slow.length} page(s) took over 1.5s to respond`,
      detail:
        'Measured as time to complete the HTTP response from this crawler. It reflects server and ' +
        'network time only, not browser rendering or Core Web Vitals.',
      severity: 'medium', confidence: 0.6,
      affectedUrls: slow.map((p) => p.url),
      evidence: slow.slice(0, 8).map((p) => observed('crawler.http', p.url, {
        note: `${p.responseTimeMs}ms to complete the response`, value: p.responseTimeMs,
      })),
      currentState: `${slow.length} pages responded in over 1500ms during this crawl.`,
      recommendedState: 'Server response completes well under 1s for HTML documents.',
      validationRule: 'VALIDATE.RESPONSE_TIME',
    }));
  }

  const heavy = pages.filter((p) => p.bytes > 1_500_000);
  if (heavy.length) {
    out.push(signal({
      engine: 'seo', family: P.PAGE_WEIGHT, scope: 'site',
      rule: 'SEO.PAGE_WEIGHT', category: 'PERFORMANCE',
      title: `${heavy.length} page(s) serve more than 1.5 MB of HTML`,
      detail: 'Very large HTML documents delay parsing and usually indicate inlined data or markup bloat.',
      severity: 'low', confidence: 0.8,
      affectedUrls: heavy.map((p) => p.url),
      evidence: heavy.slice(0, 6).map((p) => observed('crawler.http', p.url, {
        note: `${(p.bytes / 1_048_576).toFixed(2)} MB of HTML`, value: p.bytes,
      })),
      currentState: `${heavy.length} HTML documents exceed 1.5 MB.`,
      recommendedState: 'HTML documents stay small; large payloads move to separate cached resources.',
      validationRule: 'VALIDATE.PAGE_WEIGHT',
    }));
  }
  return out;
}

function transportSecurity(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  if (!ctx.site.origin.startsWith('https://')) return out;

  const mixed: { url: string; refs: string[] }[] = [];
  for (const p of analyzablePages(ctx)) {
    const refs = [
      ...p.images.map((i) => i.src),
      ...p.videos.map((v) => v.src),
      ...p.links.filter((l) => l.internal).map((l) => l.href),
    ].filter((u) => u.startsWith('http://'));
    if (refs.length) mixed.push({ url: p.url, refs: [...new Set(refs)].slice(0, 5) });
  }
  if (mixed.length) {
    out.push(signal({
      engine: 'seo', family: P.MIXED_CONTENT, scope: 'site',
      rule: 'SEO.MIXED_CONTENT', category: 'TECHNICAL_SEO',
      title: `${mixed.length} HTTPS page(s) reference resources over plain HTTP`,
      detail: 'Browsers block or downgrade insecure subresources on secure pages.',
      severity: 'high', confidence: 0.9,
      affectedUrls: mixed.map((m) => m.url),
      evidence: mixed.slice(0, 8).map((m) => observed('parser.dom', m.url, {
        note: `Insecure references: ${m.refs.map((r) => truncate(r, 60)).join(', ')}`,
      })),
      currentState: `${mixed.length} secure pages reference http:// resources.`,
      recommendedState: 'Every subresource and internal link on an HTTPS page uses HTTPS.',
      validationRule: 'VALIDATE.NO_MIXED_CONTENT',
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------

function buildRobotsTxt(ctx: AnalysisContext): string {
  const sitemap = ctx.crawl.sitemaps[0]?.url ?? `${ctx.site.origin}/sitemap.xml`;
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${sitemap}`, ''].join('\n');
}

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(item);
  }
  return m;
}

export type { Evidence };
