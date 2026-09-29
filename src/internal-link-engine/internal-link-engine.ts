import { indexablePages, type AnalysisContext, type AnalysisEngine } from '../core/context.js';
import { derived, observed, type Signal } from '../core/model.js';
import { PROBLEM_FAMILIES as P, signal } from '../core/problems.js';
import { contentWords, similarity, stem, truncate } from '../core/text.js';

/**
 * Internal linking.
 *
 * Link recommendations are generated only where two pages already share subject matter,
 * and each one names the specific page pair and the terms they have in common. Anchor
 * text is proposed from the target page's own title or heading, never from a keyword
 * list, and the engine flags repetitive anchors rather than producing them: an
 * internal link that exists to carry an exact-match phrase is a manipulation, not a
 * navigational aid.
 */
export const internalLinkEngine: AnalysisEngine = {
  id: 'internal-link',
  name: 'Internal Linking',
  analyze(ctx: AnalysisContext): Signal[] {
    return [
      ...orphanPages(ctx),
      ...weaklyLinked(ctx),
      ...excessiveDepth(ctx),
      ...isolatedSections(ctx),
      ...anchorQuality(ctx),
      ...overOptimizedAnchors(ctx),
      ...contextualOpportunities(ctx),
    ];
  },
};

function orphanPages(ctx: AnalysisContext): Signal[] {
  const orphans = ctx.siteGraph.orphanPages
    .map((u) => ctx.site.pageByUrl.get(u))
    .filter((p) => !!p && p.indexable);
  if (orphans.length === 0) return [];

  const inSitemap = new Set(ctx.crawl.sitemapEntries.map((e) => e.loc));
  return [signal({
    engine: 'internal-link', family: P.ORPHAN_PAGE, scope: 'site',
    rule: 'LINK.ORPHAN_PAGE', category: 'INFORMATION_ARCHITECTURE',
    title: `${orphans.length} indexable page(s) receive no internal links`,
    detail:
      'Nothing on the site links to these pages. ' +
      `${orphans.filter((p) => inSitemap.has(p!.url)).length} of them appear in the sitemap, which ` +
      'is how they were discovered at all. A page nothing links to is one the site does not treat ' +
      'as part of itself.',
    severity: 'high', confidence: 0.9,
    affectedUrls: orphans.map((p) => p!.url),
    evidence: orphans.slice(0, 10).map((p) => derived('site-graph', p!.url, {
      note: `0 inbound internal links; discovered via ${inSitemap.has(p!.url) ? 'sitemap' : 'crawl seed or redirect'}`,
    })),
    currentState: `${orphans.length} indexable pages have no inbound internal links.`,
    recommendedState: 'Every page worth indexing is reachable by following links from the homepage.',
    validationRule: 'VALIDATE.PAGE_HAS_INLINKS',
    fix: {
      kind: 'link.add-internal', url: orphans[0]!.url, before: 0, after: null,
      rationale:
        'The right place to link from depends on where the page belongs in the site. Candidate ' +
        'sources are proposed separately where topical overlap supports them.',
      requiresHuman: true,
    },
  })];
}

function weaklyLinked(ctx: AnalysisContext): Signal[] {
  const weak = ctx.siteGraph.weaklyConnectedPages
    .map((u) => ctx.site.pageByUrl.get(u))
    .filter((p) => !!p && p.indexable && p.wordCount >= 200);
  if (weak.length === 0) return [];

  return [signal({
    engine: 'internal-link', family: P.WEAK_INTERNAL_LINKING, scope: 'site',
    rule: 'LINK.SINGLE_INBOUND_LINK', category: 'INTERNAL_LINKING',
    title: `${weak.length} substantive page(s) have a single inbound internal link`,
    detail:
      'These pages hang off one link. If that link is removed or the page linking to it changes, ' +
      'the page becomes unreachable.',
    severity: 'medium', confidence: 0.75,
    affectedUrls: weak.map((p) => p!.url),
    evidence: weak.slice(0, 10).map((p) => derived('site-graph', p!.url, {
      note: `${ctx.siteGraph.metrics.get(p!.url)?.inLinks ?? 0} inbound link(s), ` +
        `${ctx.siteGraph.metrics.get(p!.url)?.contextualInLinks ?? 0} of them in main content`,
    })),
    currentState: `${weak.length} pages depend on a single inbound link.`,
    recommendedState: 'Substantive pages are reachable from more than one place.',
    validationRule: 'VALIDATE.PAGE_INLINK_COUNT',
  })];
}

function excessiveDepth(ctx: AnalysisContext): Signal[] {
  const deep = [...ctx.siteGraph.metrics.values()]
    .filter((m) => Number.isFinite(m.depth) && m.depth > 4)
    .filter((m) => ctx.site.pageByUrl.get(m.url)?.indexable);
  const unreachable = [...ctx.siteGraph.metrics.values()]
    .filter((m) => !Number.isFinite(m.depth) && ctx.site.pageByUrl.get(m.url)?.indexable);

  const out: Signal[] = [];
  if (deep.length) {
    out.push(signal({
      engine: 'internal-link', family: P.EXCESSIVE_DEPTH, scope: 'site',
      rule: 'LINK.EXCESSIVE_CLICK_DEPTH', category: 'INFORMATION_ARCHITECTURE',
      title: `${deep.length} page(s) sit more than four clicks from the homepage`,
      detail:
        'Click depth is measured over internal links from the homepage. Pages this far down are ' +
        'reached less often by readers and crawled less often.',
      severity: 'medium', confidence: 0.8,
      affectedUrls: deep.map((m) => m.url),
      evidence: deep.slice(0, 10).map((m) => derived('site-graph.bfs', m.url, {
        note: `${m.depth} clicks from the homepage`, value: m.depth,
      })),
      currentState: `${deep.length} indexable pages are more than four clicks deep ` +
        `(maximum observed depth: ${ctx.siteGraph.maxDepth}).`,
      recommendedState: 'Important pages are within about three clicks of the homepage.',
      validationRule: 'VALIDATE.CLICK_DEPTH',
    }));
  }
  if (unreachable.length) {
    out.push(signal({
      engine: 'internal-link', family: P.ORPHAN_PAGE, scope: 'unreachable',
      rule: 'LINK.UNREACHABLE_FROM_HOMEPAGE', category: 'INFORMATION_ARCHITECTURE',
      title: `${unreachable.length} indexable page(s) cannot be reached from the homepage`,
      detail:
        'No path of internal links connects the homepage to these pages, even though they are ' +
        'linked from somewhere. They form a disconnected part of the site graph.',
      severity: 'high', confidence: 0.85,
      affectedUrls: unreachable.map((m) => m.url),
      evidence: unreachable.slice(0, 8).map((m) => derived('site-graph.bfs', m.url, {
        note: `No internal-link path from ${ctx.siteGraph.homepage ?? 'the homepage'} reaches this URL`,
      })),
      currentState: `${unreachable.length} pages are outside the homepage's reachable graph.`,
      recommendedState: 'Every indexable page is reachable by following links from the homepage.',
      validationRule: 'VALIDATE.REACHABLE_FROM_HOME',
    }));
  }
  return out;
}

function isolatedSections(ctx: AnalysisContext): Signal[] {
  const isolated = ctx.siteGraph.sections.filter((s) => s.isolated && s.pageCount >= 2);
  if (isolated.length === 0) return [];

  return [signal({
    engine: 'internal-link', family: P.ISOLATED_SECTION, scope: 'site',
    rule: 'LINK.ISOLATED_SECTION', category: 'INFORMATION_ARCHITECTURE',
    title: `${isolated.length} section(s) receive no links from the rest of the site`,
    detail:
      'Pages inside these sections link to each other but nothing outside links in. The section ' +
      'exists as an island in the site graph.',
    severity: 'medium', confidence: 0.8,
    affectedUrls: isolated.flatMap((s) =>
      ctx.site.pages.filter((p) => p.sectionPath === s.path).map((p) => p.url)).slice(0, 50),
    evidence: isolated.slice(0, 6).map((s) => derived('site-graph.sections', `${ctx.site.origin}${s.path}`, {
      note: `${s.pageCount} pages in ${s.path}, 0 inbound links from outside the section`,
      value: s.pageCount,
    })),
    currentState: `${isolated.length} sections have no inbound links from elsewhere on the site.`,
    recommendedState: 'Each section is linked from navigation or from related content outside it.',
    validationRule: 'VALIDATE.SECTION_INLINKS',
  })];
}

const GENERIC_ANCHORS = new Set([
  'click here', 'here', 'read more', 'more', 'link', 'this', 'this page', 'learn more',
  'find out more', 'see more', 'continue', 'continue reading', 'details', 'download',
  'go', 'view', 'more info', 'more information',
]);

function anchorQuality(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const generic: { from: string; to: string; anchor: string }[] = [];
  const empty: { from: string; to: string }[] = [];

  for (const page of ctx.site.pages) {
    for (const l of page.links) {
      if (!l.internal) continue;
      const a = l.anchor.trim().toLowerCase();
      if (a.length === 0) {
        empty.push({ from: page.url, to: l.href });
      } else if (GENERIC_ANCHORS.has(a)) {
        generic.push({ from: page.url, to: l.href, anchor: l.anchor });
      }
    }
  }

  if (generic.length) {
    out.push(signal({
      engine: 'internal-link', family: P.ANCHOR_TEXT_QUALITY, scope: 'generic-anchors',
      rule: 'LINK.GENERIC_ANCHOR_TEXT', category: 'INTERNAL_LINKING',
      title: `${generic.length} internal link(s) use generic anchor text`,
      detail:
        'Anchors like "click here" and "read more" describe the act of clicking rather than the ' +
        'destination. Out of context - in a screen reader\'s link list, for instance - they convey nothing.',
      severity: 'low', confidence: 0.85,
      affectedUrls: [...new Set(generic.map((g) => g.from))],
      evidence: generic.slice(0, 10).map((g) => observed('parser.a', g.from, {
        excerpt: `<a href="${truncate(g.to, 70)}">${g.anchor}</a>`,
        note: 'Anchor text does not describe the destination',
      })),
      currentState: `${generic.length} internal links use non-descriptive anchor text.`,
      recommendedState: 'Anchor text describes the page it leads to.',
      validationRule: 'VALIDATE.ANCHOR_DESCRIPTIVE',
      fix: anchorFix(ctx, generic[0]),
    }));
  }

  if (empty.length) {
    out.push(signal({
      engine: 'internal-link', family: P.ANCHOR_TEXT_QUALITY, scope: 'empty-anchors',
      rule: 'LINK.EMPTY_ANCHOR_TEXT', category: 'ACCESSIBILITY',
      title: `${empty.length} internal link(s) have no accessible text`,
      detail:
        'These links contain no text, no image alt and no aria-label, so they have no accessible ' +
        'name at all.',
      severity: 'medium', confidence: 0.85,
      affectedUrls: [...new Set(empty.map((e) => e.from))],
      evidence: empty.slice(0, 8).map((e) => observed('parser.a', e.from, {
        excerpt: `<a href="${truncate(e.to, 80)}"></a>`, note: 'Link has no accessible name',
      })),
      currentState: `${empty.length} links have no accessible name.`,
      recommendedState: 'Every link has text, image alt text, or an aria-label.',
      validationRule: 'VALIDATE.ANCHOR_HAS_NAME',
    }));
  }
  return out;
}

function anchorFix(ctx: AnalysisContext, link: { from: string; to: string; anchor: string }) {
  const target = ctx.site.pageByUrl.get(link.to);
  const suggested = target?.h1s[0] ?? target?.title;
  if (!suggested) return undefined;
  return {
    kind: 'link.anchor' as const,
    url: link.from,
    before: link.anchor,
    after: truncate(suggested, 70),
    rationale:
      'The proposed anchor is the destination page\'s own H1 or title, so it describes the page ' +
      'in the page\'s own words rather than in chosen keywords.',
    requiresHuman: true,
  };
}

/**
 * The inverse failure: the same exact anchor phrase repeated into one destination from
 * many pages. That pattern is what keyword-stuffed internal linking looks like, and this
 * platform reports it rather than producing it.
 */
function overOptimizedAnchors(ctx: AnalysisContext): Signal[] {
  const byTarget = new Map<string, Map<string, string[]>>();
  for (const page of ctx.site.pages) {
    for (const l of page.links) {
      if (!l.internal || !l.anchor) continue;
      const a = l.anchor.trim().toLowerCase();
      if (a.length < 4 || GENERIC_ANCHORS.has(a)) continue;
      if (!byTarget.has(l.href)) byTarget.set(l.href, new Map());
      const m = byTarget.get(l.href)!;
      if (!m.has(a)) m.set(a, []);
      m.get(a)!.push(page.url);
    }
  }

  const offenders: { target: string; anchor: string; sources: string[]; share: number }[] = [];
  for (const [target, anchors] of byTarget) {
    const totalLinks = [...anchors.values()].reduce((n, s) => n + s.length, 0);
    if (totalLinks < 6) continue;
    for (const [anchor, sources] of anchors) {
      const share = sources.length / totalLinks;
      // One phrase carrying nearly every link into a page, from many different pages,
      // is a pattern that does not arise from editorial linking.
      if (sources.length >= 5 && share >= 0.8 && !isNavigationalAnchor(ctx, target, anchor)) {
        offenders.push({ target, anchor, sources, share });
      }
    }
  }
  if (offenders.length === 0) return [];

  return [signal({
    engine: 'internal-link', family: P.ANCHOR_TEXT_OVER_OPTIMIZED, scope: 'repeated-anchors',
    rule: 'LINK.REPETITIVE_EXACT_ANCHOR', category: 'INTERNAL_LINKING',
    title: `${offenders.length} page(s) receive nearly all their internal links with one identical anchor phrase`,
    detail:
      'The same exact phrase is used for almost every link into these pages, from pages with ' +
      'otherwise different content. Editorially placed links vary their wording with context; ' +
      'uniform exact-match anchors are a pattern search engines treat as manipulation.',
    severity: 'medium', confidence: 0.6,
    affectedUrls: offenders.flatMap((o) => [o.target, ...o.sources.slice(0, 5)]),
    evidence: offenders.slice(0, 6).map((o) => derived('internal-link-engine', o.target, {
      note: `"${truncate(o.anchor, 60)}" is the anchor for ${(o.share * 100).toFixed(0)}% of ` +
        `${o.sources.length} inbound links, from ${new Set(o.sources).size} distinct pages`,
      value: o.share,
    })),
    currentState: `${offenders.length} destinations receive uniform exact-match anchor text.`,
    recommendedState: 'Anchor text varies naturally with the context each link sits in.',
    validationRule: 'VALIDATE.ANCHOR_DIVERSITY',
  })];
}

/** Navigation and footer links legitimately repeat the same label everywhere. */
function isNavigationalAnchor(ctx: AnalysisContext, target: string, anchor: string): boolean {
  let inBoilerplate = 0;
  let total = 0;
  for (const page of ctx.site.pages) {
    for (const l of page.links) {
      if (!l.internal || l.href !== target) continue;
      if (l.anchor.trim().toLowerCase() !== anchor) continue;
      total++;
      if (!l.inMainContent) inBoilerplate++;
    }
  }
  return total > 0 && inBoilerplate / total > 0.6;
}

/**
 * Contextual link opportunities: pairs of pages that share substantial subject matter
 * where no link exists in either direction. Each recommendation names the pair, the
 * shared terms, and an anchor taken from the target page's own heading.
 */
function contextualOpportunities(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx).filter((p) => p.wordCount >= 250);
  if (pages.length < 2) return out;

  const terms = new Map<string, string[]>();
  for (const p of pages) {
    terms.set(p.url, [...new Set(contentWords(`${p.title ?? ''} ${p.h1s.join(' ')} ${p.text}`).map(stem))].slice(0, 60));
  }

  const opportunities: { from: string; to: string; overlap: number; shared: string[] }[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = 0; j < pages.length; j++) {
      if (i === j) continue;
      const from = pages[i];
      const to = pages[j];
      if (from.sectionPath === to.sectionPath && ctx.siteGraph.metrics.get(to.url)?.inLinks) continue;

      const linked = ctx.siteGraph.graph.out.get(from.url)?.has(to.url) ?? false;
      if (linked) continue;

      const overlap = similarity(terms.get(from.url)!, terms.get(to.url)!);
      if (overlap < 0.35) continue;
      // Prefer sending links to pages that need them.
      const targetInlinks = ctx.siteGraph.metrics.get(to.url)?.inLinks ?? 0;
      if (targetInlinks > 3) continue;
      opportunities.push({ from: from.url, to: to.url, overlap, shared: sharedTerms(terms.get(from.url)!, terms.get(to.url)!) });
    }
  }

  opportunities.sort((a, b) => b.overlap - a.overlap);
  for (const opp of opportunities.slice(0, 25)) {
    const target = ctx.site.pageByUrl.get(opp.to);
    const anchor = target?.h1s[0] ?? target?.title ?? opp.to;
    out.push(signal({
      engine: 'internal-link', family: P.MISSING_TOPIC_LINK, scope: `${opp.from}->${opp.to}`,
      rule: 'LINK.CONTEXTUAL_OPPORTUNITY', category: 'INTERNAL_LINKING',
      title: `${truncate(opp.from, 45)} covers the same subject as ${truncate(opp.to, 45)} but does not link to it`,
      detail:
        `These two pages share ${(opp.overlap * 100).toFixed(0)}% of their significant terms ` +
        `(${opp.shared.slice(0, 6).join(', ')}) and the destination has only ` +
        `${ctx.siteGraph.metrics.get(opp.to)?.inLinks ?? 0} inbound link(s).`,
      severity: 'low', confidence: 0.5,
      affectedUrls: [opp.from, opp.to],
      evidence: [
        derived('internal-link-engine', opp.from, {
          note: `Term overlap ${(opp.overlap * 100).toFixed(1)}% with ${opp.to}; shared terms: ${opp.shared.slice(0, 10).join(', ')}`,
          value: opp.overlap,
        }),
        observed('parser.dom', opp.to, {
          excerpt: truncate(anchor, 120), note: 'Destination page heading, proposed as the anchor text',
        }),
      ],
      currentState: 'No link exists from the source page to the destination.',
      recommendedState: 'A link sits where the source page genuinely discusses the destination\'s subject.',
      validationRule: 'VALIDATE.INTERNAL_LINK_EXISTS',
      fix: {
        kind: 'link.add-internal', url: opp.from,
        before: null,
        after: { href: opp.to, suggestedAnchor: truncate(anchor, 70) },
        rationale:
          'The anchor is the destination page\'s own heading. Where the link belongs in the prose is ' +
          'an editorial decision - a link inserted mechanically into unrelated text is not a ' +
          'contextual link, so this is proposed rather than applied.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

function sharedTerms(a: string[], b: string[]): string[] {
  const sb = new Set(b);
  return a.filter((t) => sb.has(t)).slice(0, 12);
}
