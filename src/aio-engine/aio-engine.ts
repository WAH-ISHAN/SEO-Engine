import { indexablePages, type AnalysisContext, type AnalysisEngine } from '../core/context.js';
import { derived, observed, type Signal } from '../core/model.js';
import { PROBLEM_FAMILIES as P, signal } from '../core/problems.js';
import { truncate } from '../core/text.js';
import { normalizeType } from '../parser/structured-data.js';

/**
 * AI-readability analysis.
 *
 * This engine asks whether the page states plainly, in the served HTML, what it is
 * about: which entity it concerns, who published it, when, on what authority, and with
 * what supporting sources. Those are properties of the document, and they are what an
 * automated reader has to work with.
 *
 * It does not claim that any AI system will read, use, or cite the site. No such claim
 * is verifiable, and the platform does not make predictions it cannot check. What it
 * reports is ambiguity and missing context that a machine reader would encounter.
 */
export const aioEngine: AnalysisEngine = {
  id: 'aio',
  name: 'AI Readability',
  analyze(ctx: AnalysisContext): Signal[] {
    return [
      ...organizationIdentity(ctx),
      ...pageSubjectClarity(ctx),
      ...authorAndDates(ctx),
      ...ambiguousReferences(ctx),
      ...unsourcedClaims(ctx),
      ...machineReadableStructure(ctx),
      ...entityDefinitionGaps(ctx),
    ];
  },
};

function organizationIdentity(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const org = ctx.entityGraph.primaryOrganization;

  if (!org) {
    out.push(signal({
      engine: 'aio', family: P.ORGANIZATION_IDENTITY_MISSING, scope: ctx.site.origin,
      rule: 'AIO.NO_ORGANIZATION_IDENTITY', category: 'ENTITY',
      title: 'The site never states who publishes it in machine-readable form',
      detail:
        'No Organization is declared in structured data or Open Graph metadata anywhere on the ' +
        'crawled pages. A reader can often work out who runs the site from the design and the ' +
        'copy; an automated reader has nothing to work from.',
      severity: 'high', confidence: 0.9,
      affectedUrls: [ctx.site.origin],
      evidence: [derived('entity-engine', ctx.site.origin, {
        note: `${ctx.entityGraph.stats.total} entities extracted across ${ctx.site.pages.length} pages, ` +
          'none of which identifies the site operator',
      })],
      currentState: 'No publisher identity is declared anywhere on the site.',
      recommendedState:
        'One Organization node, on the homepage, states the name, URL and description the site ' +
        'already publishes about itself.',
      validationRule: 'VALIDATE.ORGANIZATION_SCHEMA_PRESENT',
      fix: {
        kind: 'schema.add', url: ctx.siteGraph.homepage ?? ctx.site.origin,
        before: null,
        after: proposedOrganization(ctx),
        rationale:
          'Assembled only from values the site already publishes: the site name from its own ' +
          'metadata or title, and the origin URL. Fields the site does not state - founder, phone, ' +
          'address, social profiles - are deliberately left out rather than guessed.',
        requiresHuman: true,
      },
    }));
    return out;
  }

  if (!org.origins.includes('schema')) {
    out.push(signal({
      engine: 'aio', family: P.ORGANIZATION_IDENTITY_MISSING, scope: `${ctx.site.origin}|schema-form`,
      rule: 'AIO.ORGANIZATION_IDENTITY_METADATA_ONLY', category: 'ENTITY',
      title: `The publisher "${org.name}" is named only in metadata, not in structured data`,
      detail:
        'The site declares its name in Open Graph or byline markup but never as a typed ' +
        'Organization, so its identity is a string rather than an entity that can carry a URL, ' +
        'description and verified profiles.',
      severity: 'medium', confidence: 0.85,
      affectedUrls: org.mentionedOn.slice(0, 20),
      evidence: org.evidence.slice(0, 4),
      currentState: `Publisher identity exists as ${org.origins.join(' and ')} only.`,
      recommendedState: 'The publisher is declared once as a typed Organization with a stable identifier.',
      validationRule: 'VALIDATE.ORGANIZATION_SCHEMA_PRESENT',
    }));
  }

  if (!org.description) {
    out.push(signal({
      engine: 'aio', family: P.ENTITY_UNDEFINED, scope: `org:${org.name}`,
      rule: 'AIO.ORGANIZATION_WITHOUT_DESCRIPTION', category: 'ENTITY',
      title: `"${org.name}" is named but never described`,
      detail:
        'The organization is identified by name across the site but no description property states ' +
        'what it does. The name alone does not disambiguate it from any other organization sharing it.',
      severity: 'medium', confidence: 0.8,
      affectedUrls: org.mentionedOn.slice(0, 20),
      evidence: org.evidence.slice(0, 3),
      currentState: `"${org.name}" has no description property in any structured-data block.`,
      recommendedState: 'The organization entity carries a description of what it actually does.',
      validationRule: 'VALIDATE.ENTITY_HAS_DESCRIPTION',
      fix: {
        kind: 'schema.fix', url: ctx.siteGraph.homepage ?? ctx.site.origin,
        before: { name: org.name, description: null },
        after: null,
        rationale:
          'The description has to state what the organization does, which is a fact about the ' +
          'business. This platform will not compose one; it reports that the field is absent.',
        requiresHuman: true,
      },
    }));
  }

  if (org.sameAs.length === 0 && org.origins.includes('schema')) {
    out.push(signal({
      engine: 'aio', family: P.ENTITY_INCONSISTENT, scope: `org:${org.name}|sameas`,
      rule: 'AIO.ORGANIZATION_WITHOUT_SAMEAS', category: 'ENTITY',
      title: `"${org.name}" declares no external profiles to corroborate its identity`,
      detail:
        'The Organization entity has no sameAs references. Those links are how an entity on this ' +
        'site is tied to the same entity described elsewhere.',
      severity: 'low', confidence: 0.7,
      affectedUrls: org.mentionedOn.slice(0, 10),
      evidence: [derived('entity-engine', ctx.site.origin, {
        note: 'Organization structured data contains no sameAs property',
      })],
      currentState: 'No sameAs references are declared.',
      recommendedState: 'sameAs lists profiles the organization genuinely controls.',
      validationRule: 'VALIDATE.ENTITY_SAMEAS',
      fix: {
        kind: 'schema.fix', url: ctx.siteGraph.homepage ?? ctx.site.origin,
        before: { sameAs: [] }, after: null,
        rationale:
          'Only profiles the organization actually owns may be listed. Listing a profile the ' +
          'organization does not control would be a false identity claim, so the URLs must be ' +
          'supplied by someone who knows which accounts are genuine.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

function proposedOrganization(ctx: AnalysisContext): Record<string, unknown> {
  const home = ctx.siteGraph.homepage ? ctx.site.pageByUrl.get(ctx.siteGraph.homepage) : undefined;
  const name = home?.openGraph['og:site_name'] ?? home?.title?.split(/[|–—-]/)[0]?.trim();
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    url: ctx.site.origin,
  };
  if (name) org.name = name;
  const desc = home?.metaDescription ?? home?.openGraph['og:description'];
  if (desc) org.description = desc;
  // Left blank on purpose: logo, sameAs, contactPoint, address, founder. Each of those
  // is a factual claim the crawl did not establish.
  return org;
}

function pageSubjectClarity(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx).filter((p) => p.wordCount >= 150);

  const noSchema = pages.filter((p) => p.schemas.filter((s) => !s.parseError && s.types.length).length === 0);
  if (noSchema.length) {
    out.push(signal({
      engine: 'aio', family: P.STRUCTURED_DATA_ABSENT, scope: 'site-wide-pages',
      rule: 'AIO.PAGE_SUBJECT_NOT_TYPED', category: 'AIO',
      title: `${noSchema.length} content page(s) declare no machine-readable subject`,
      detail:
        'These pages carry substantive content but no structured data of any kind, so what each ' +
        'page is about has to be inferred from prose. Typing the page states its subject explicitly.',
      severity: 'medium', confidence: 0.8,
      affectedUrls: noSchema.map((p) => p.url),
      evidence: noSchema.slice(0, 8).map((p) => derived('parser.structured-data', p.url, {
        note: `${p.wordCount} words of content, zero valid structured-data blocks`,
        value: p.wordCount,
      })),
      currentState: `${noSchema.length} of ${pages.length} content pages have no structured data.`,
      recommendedState: 'Each content page declares a type that matches what the page actually is.',
      validationRule: 'VALIDATE.PAGE_HAS_SCHEMA',
    }));
  }
  return out;
}

function authorAndDates(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const articlePages = indexablePages(ctx).filter((p) => {
    const model = ctx.content.byUrl.get(p.url);
    return model?.formats.includes('article') || model?.formats.includes('guide');
  });
  if (articlePages.length === 0) return out;

  const noAuthor = articlePages.filter((p) => (ctx.content.byUrl.get(p.url)?.authors.length ?? 0) === 0);
  if (noAuthor.length) {
    out.push(signal({
      engine: 'aio', family: P.AUTHOR_ATTRIBUTION_MISSING, scope: 'articles',
      rule: 'AIO.ARTICLE_WITHOUT_AUTHOR', category: 'AIO',
      title: `${noAuthor.length} article-style page(s) state no author`,
      detail:
        'These pages read as articles or guides but name no author in structured data. Attribution ' +
        'is how a reader - human or automated - tells who stands behind a claim.',
      severity: 'medium', confidence: 0.7,
      affectedUrls: noAuthor.map((p) => p.url),
      evidence: noAuthor.slice(0, 8).map((p) => derived('content-engine', p.url, {
        note: 'No author property in structured data and no byline markup detected',
      })),
      currentState: `${noAuthor.length} of ${articlePages.length} article pages have no attribution.`,
      recommendedState: 'Articles name a real author who actually wrote them.',
      validationRule: 'VALIDATE.AUTHOR_PRESENT',
      fix: {
        kind: 'schema.fix', url: noAuthor[0].url, before: null, after: null,
        rationale:
          'The author must be the person who genuinely wrote the page. This platform will not ' +
          'invent an author name or create a persona; it reports that attribution is absent.',
        requiresHuman: true,
      },
    }));
  }

  const noDates = articlePages.filter((p) => {
    const m = ctx.content.byUrl.get(p.url);
    return !m?.publishedDate && !m?.modifiedDate;
  });
  if (noDates.length) {
    out.push(signal({
      engine: 'aio', family: P.CONTENT_DATES_MISSING, scope: 'articles',
      rule: 'AIO.CONTENT_WITHOUT_DATES', category: 'AIO',
      title: `${noDates.length} article-style page(s) state no publication or update date`,
      detail:
        'Undated content cannot be assessed for currency. Any claim that depends on time - prices, ' +
        'versions, regulations, comparisons - is unverifiable without a date.',
      severity: 'medium', confidence: 0.75,
      affectedUrls: noDates.map((p) => p.url),
      evidence: noDates.slice(0, 8).map((p) => derived('content-engine', p.url, {
        note: 'No datePublished, dateModified, or article:published_time found',
      })),
      currentState: `${noDates.length} article pages carry no date information.`,
      recommendedState: 'Articles state when they were published and when they were last substantively updated.',
      validationRule: 'VALIDATE.DATES_PRESENT',
      fix: {
        kind: 'schema.fix', url: noDates[0].url, before: null, after: null,
        rationale:
          'The real publication date is a fact the CMS holds and the crawl does not. Backdating or ' +
          'inventing a date would misrepresent the content, so the value must come from the site.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

/**
 * Pronouns and bare demonstratives standing in for the subject in places where an
 * extractor has no antecedent: headings, and the opening sentence of the page.
 */
function ambiguousReferences(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const offenders: { url: string; where: string; excerpt: string }[] = [];
  const PRONOUN_START = /^(it|they|this|that|these|those|we|our|its|their|he|she)\b/i;

  for (const page of indexablePages(ctx)) {
    if (page.wordCount < 100) continue;
    const first = page.text.split(/(?<=[.!?])\s+/)[0] ?? '';
    if (first && PRONOUN_START.test(first.trim())) {
      offenders.push({ url: page.url, where: 'opening sentence', excerpt: truncate(first, 160) });
    }
    for (const h of page.headings.filter((x) => x.level >= 2)) {
      if (PRONOUN_START.test(h.text.trim()) && h.text.split(/\s+/).length <= 6) {
        offenders.push({ url: page.url, where: `h${h.level}`, excerpt: truncate(h.text, 120) });
        break;
      }
    }
  }
  if (offenders.length === 0) return out;

  out.push(signal({
    engine: 'aio', family: P.AMBIGUOUS_REFERENCE, scope: 'site',
    rule: 'AIO.AMBIGUOUS_SUBJECT_REFERENCE', category: 'AIO',
    title: `${offenders.length} page(s) open a section with an unresolved pronoun`,
    detail:
      'A heading or opening sentence that begins with "it", "this" or "they" depends on context ' +
      'that a passage lifted out of the page does not carry. Naming the subject makes the passage ' +
      'self-contained.',
    severity: 'low', confidence: 0.5,
    affectedUrls: [...new Set(offenders.map((o) => o.url))],
    evidence: offenders.slice(0, 8).map((o) => observed('content-engine', o.url, {
      excerpt: o.excerpt, note: `Unresolved reference in the ${o.where}`,
    })),
    currentState: `${offenders.length} passages begin with a pronoun rather than naming the subject.`,
    recommendedState: 'Headings and opening sentences name their subject explicitly.',
    validationRule: 'VALIDATE.SUBJECT_NAMED',
  }));
  return out;
}

const CLAIM_PATTERNS = [
  /\b\d+(?:\.\d+)?%\s+(?:of|more|less|faster|higher|lower|increase|decrease)/i,
  /\b(?:studies show|research shows|according to experts|data shows|it is proven)\b/i,
  /\b(?:the (?:best|leading|number one|#1)|world[''`]?s (?:best|leading))\b/i,
  /\b\d+x\s+(?:faster|better|more|cheaper)\b/i,
];

function unsourcedClaims(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const offenders: { url: string; claim: string }[] = [];

  for (const page of indexablePages(ctx)) {
    const model = ctx.content.byUrl.get(page.url);
    if (!model || page.wordCount < 150) continue;
    // A page that cites sources in its main content is treated as sourced.
    if (model.externalReferences.some((r) => r.inMainContent)) continue;

    for (const re of CLAIM_PATTERNS) {
      const m = re.exec(page.text);
      if (!m) continue;
      const start = Math.max(0, m.index - 80);
      offenders.push({ url: page.url, claim: truncate(page.text.slice(start, m.index + m[0].length + 80), 200) });
      break;
    }
  }
  if (offenders.length === 0) return out;

  out.push(signal({
    engine: 'aio', family: P.FACTS_UNSOURCED, scope: 'site',
    rule: 'AIO.CLAIM_WITHOUT_SOURCE', category: 'AIO',
    title: `${offenders.length} page(s) state statistics or superlatives with no source`,
    detail:
      'These pages make quantified or superlative claims and link to no source anywhere in their ' +
      'main content. An unsourced statistic cannot be checked by anyone.',
    severity: 'medium', confidence: 0.6,
    affectedUrls: offenders.map((o) => o.url),
    evidence: offenders.slice(0, 8).map((o) => observed('content-engine', o.url, {
      excerpt: o.claim, note: 'Quantified or superlative claim with no outbound citation on the page',
    })),
    currentState: `${offenders.length} pages make checkable claims without citing where they come from.`,
    recommendedState: 'Claims cite the source they came from, or are restated as the site\'s own finding with its method.',
    validationRule: 'VALIDATE.CITATION_PRESENT',
    fix: {
      kind: 'content.manual', url: offenders[0].url, before: null, after: null,
      rationale:
        'Only the author knows where each figure came from. Attaching a citation this platform ' +
        'selected would fabricate a provenance, so the source must be supplied.',
      requiresHuman: true,
    },
  }));
  return out;
}

function machineReadableStructure(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const pages = indexablePages(ctx).filter((p) => p.wordCount >= 200);

  const flat = pages.filter((p) => {
    const landmarks = new Set(p.landmarks);
    const semantic = ['main', 'article', 'section', 'header', 'footer', 'nav'].filter((l) => landmarks.has(l));
    return semantic.length <= 1;
  });
  if (flat.length) {
    out.push(signal({
      engine: 'aio', family: P.SEMANTIC_STRUCTURE_WEAK, scope: 'semantic-html',
      rule: 'AIO.NON_SEMANTIC_MARKUP', category: 'AIO',
      title: `${flat.length} page(s) are built almost entirely from generic containers`,
      detail:
        'These pages use one semantic element or fewer. Everything - navigation, content, footer - ' +
        'is a div, so the document carries no machine-readable regions.',
      severity: 'medium', confidence: 0.75,
      affectedUrls: flat.map((p) => p.url),
      evidence: flat.slice(0, 8).map((p) => observed('parser.dom', p.url, {
        note: `Semantic elements present: ${p.landmarks.join(', ') || 'none'}`,
      })),
      currentState: `${flat.length} content pages use generic containers instead of semantic elements.`,
      recommendedState: 'Pages use header, nav, main, article, section and footer to mark their regions.',
      validationRule: 'VALIDATE.SEMANTIC_ELEMENTS',
    }));
  }
  return out;
}

function entityDefinitionGaps(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];

  // Services and products the site names in structured data but never describes.
  const undescribed = ctx.entityGraph.entities.filter(
    (e) => ['Service', 'Product'].includes(e.nodeClass) && !e.description,
  );
  if (undescribed.length) {
    out.push(signal({
      engine: 'aio', family: P.ENTITY_UNDEFINED, scope: 'undescribed-offerings',
      rule: 'AIO.OFFERING_WITHOUT_DEFINITION', category: 'ENTITY',
      title: `${undescribed.length} product(s) or service(s) are named but never defined`,
      detail:
        'These are declared as typed entities but carry no description, so what they actually are ' +
        'is stated nowhere in machine-readable form.',
      severity: 'medium', confidence: 0.75,
      affectedUrls: [...new Set(undescribed.flatMap((e) => e.mentionedOn))],
      evidence: undescribed.slice(0, 8).map((e) => derived('entity-engine', e.mentionedOn[0] ?? ctx.site.origin, {
        note: `"${e.name}" declared as ${e.entityTypes.join('/')} with no description property`,
        value: e.name,
      })),
      currentState: `${undescribed.length} offerings are named without a definition.`,
      recommendedState: 'Each named offering states what it is.',
      validationRule: 'VALIDATE.ENTITY_HAS_DESCRIPTION',
      fix: {
        kind: 'schema.fix', url: undescribed[0].mentionedOn[0] ?? ctx.site.origin,
        before: { name: undescribed[0].name, description: null }, after: null,
        rationale:
          'What a service or product is, is a fact about the business. The platform flags the gap ' +
          'rather than describing an offering it knows nothing about.',
        requiresHuman: true,
      },
    }));
  }

  // Entities the site references in claims but never defines anywhere.
  const dangling = ctx.entityGraph.entities.filter((e) =>
    e.evidence.some((ev) => ev.note?.includes('has no entity definition anywhere on this site')));
  if (dangling.length) {
    out.push(signal({
      engine: 'aio', family: P.ENTITY_RELATIONSHIP_MISSING, scope: 'dangling-entity-claims',
      rule: 'AIO.RELATIONSHIP_TARGET_UNDEFINED', category: 'ENTITY',
      title: `${dangling.length} entity relationship(s) point at something the site never defines`,
      detail:
        'Structured data names a related entity - an author, a publisher, a location - that has no ' +
        'definition anywhere on the site. The relationship exists as a string, not as a link between ' +
        'two described things.',
      severity: 'low', confidence: 0.7,
      affectedUrls: [...new Set(dangling.flatMap((e) => e.mentionedOn))].slice(0, 20),
      evidence: dangling.slice(0, 6).flatMap((e) =>
        e.evidence.filter((ev) => ev.note?.includes('no entity definition')).slice(0, 1)),
      currentState: `${dangling.length} relationship targets are named but never defined.`,
      recommendedState: 'Entities named in relationships are defined somewhere on the site or linked by a stable identifier.',
      validationRule: 'VALIDATE.ENTITY_TARGETS_RESOLVE',
    }));
  }
  return out;
}
