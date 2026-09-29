import { indexablePages, type AnalysisContext, type AnalysisEngine } from '../core/context.js';
import { derived, observed, type Signal } from '../core/model.js';
import { PROBLEM_FAMILIES as P, signal } from '../core/problems.js';
import { similarity, truncate } from '../core/text.js';

/**
 * Generative-search readiness.
 *
 * The honest framing for this engine: nobody can verify what any generative system will
 * include in an answer, and this platform does not pretend otherwise. What it can do is
 * measure properties that are checkable on the site itself - how completely a topic is
 * covered, whether the site says anything that exists nowhere else, whether expertise is
 * evidenced, whether the entity is named consistently, and whether related content is
 * connected.
 *
 * Those are worth improving because they make the site genuinely more useful. They are
 * reported as site properties, never as a forecast of inclusion in AI-generated answers.
 */
export const geoEngine: AnalysisEngine = {
  id: 'geo',
  name: 'Generative Search Readiness',
  analyze(ctx: AnalysisContext): Signal[] {
    return [
      ...topicCompleteness(ctx),
      ...originalInformation(ctx),
      ...expertiseSignals(ctx),
      ...citationPractice(ctx),
      ...comparisonCoverage(ctx),
      ...brandConsistency(ctx),
      ...topicConnectivity(ctx),
    ];
  },
};

/**
 * A topic cluster whose pages all cover the same ground at the same shallow depth is
 * incomplete: the site touches the subject repeatedly without ever treating it fully.
 */
function topicCompleteness(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];

  for (const cluster of ctx.siteGraph.topicClusters) {
    if (cluster.urls.length < 3) continue;
    const pages = cluster.urls.map((u) => ctx.site.pageByUrl.get(u)).filter((p) => !!p);
    if (pages.length < 3) continue;

    const deepest = Math.max(...pages.map((p) => p!.wordCount));
    const avgWords = pages.reduce((a, p) => a + p!.wordCount, 0) / pages.length;
    const questionsInCluster = pages.reduce(
      (a, p) => a + (ctx.content.byUrl.get(p!.url)?.questions.length ?? 0), 0);

    // Many shallow pages, no substantial treatment, and few questions answered.
    if (deepest >= 900 || avgWords >= 600) continue;
    if (questionsInCluster >= pages.length) continue;

    out.push(signal({
      engine: 'geo', family: P.TOPIC_INCOMPLETE, scope: `topic:${cluster.id}`,
      rule: 'GEO.TOPIC_COVERED_SHALLOWLY', category: 'GEO',
      title: `The "${cluster.label}" topic is covered across ${cluster.urls.length} pages but never in depth`,
      detail:
        `These ${cluster.urls.length} pages share a term set, the longest runs to ${deepest} words, ` +
        `and between them they answer ${questionsInCluster} question(s). The site returns to this ` +
        'subject without ever treating it thoroughly in one place.',
      severity: 'low', confidence: 0.5,
      affectedUrls: cluster.urls,
      evidence: [
        derived('site-graph.topics', cluster.urls[0], {
          note: `Cluster terms: ${cluster.terms.slice(0, 8).join(', ')}; cohesion ${cluster.cohesion}`,
          value: cluster.terms,
        }),
        ...cluster.urls.slice(0, 5).map((u) => derived('content-engine', u, {
          note: `${ctx.site.pageByUrl.get(u)?.wordCount ?? 0} words`,
        })),
      ],
      currentState: `${cluster.urls.length} pages average ${Math.round(avgWords)} words on this topic.`,
      recommendedState:
        'The topic has one thorough treatment that the shallower pages support and link to.',
      validationRule: 'VALIDATE.TOPIC_DEPTH',
      fix: {
        kind: 'content.manual', url: cluster.urls[0], before: cluster.urls, after: null,
        rationale:
          'Deciding whether to consolidate these pages or deepen one of them is an editorial ' +
          'judgement about the subject. The platform reports the pattern and will not mass-produce ' +
          'pages to fill the gap.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

function originalInformation(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const substantial = indexablePages(ctx).filter((p) => p.wordCount >= 400);
  if (substantial.length < 3) return out;

  const withOriginality = substantial.filter(
    (p) => (ctx.content.byUrl.get(p.url)?.originalityMarkers.length ?? 0) > 0);
  const ratio = withOriginality.length / substantial.length;
  if (ratio >= 0.2) return out;

  out.push(signal({
    engine: 'geo', family: P.ORIGINAL_INFORMATION_MISSING, scope: ctx.site.origin,
    rule: 'GEO.NO_FIRST_HAND_INFORMATION', category: 'GEO',
    title: `Only ${withOriginality.length} of ${substantial.length} substantial pages contain first-hand information`,
    detail:
      'Across the crawled content, almost nothing signals original work - no stated methodology, ' +
      'no sample sizes, no first-person testing or research, no dated observations. Content that ' +
      'restates what is available elsewhere gives no reason to consult this site specifically.',
    severity: 'medium', confidence: 0.5,
    affectedUrls: substantial.map((p) => p.url).slice(0, 40),
    evidence: [
      derived('content-engine.originality', ctx.site.origin, {
        note: `${withOriginality.length} of ${substantial.length} pages over 400 words show ` +
          'markers of first-hand information',
        value: Number(ratio.toFixed(3)),
      }),
      ...withOriginality.slice(0, 3).map((p) => observed('content-engine.originality', p.url, {
        excerpt: truncate(ctx.content.byUrl.get(p.url)?.originalityMarkers[0]?.excerpt ?? '', 180),
        note: `Marker: ${ctx.content.byUrl.get(p.url)?.originalityMarkers[0]?.marker}`,
      })),
    ],
    currentState: `${Math.round(ratio * 100)}% of substantial pages show any first-hand information.`,
    recommendedState:
      'Content that reports the organization\'s own data, testing or experience states so, with method.',
    validationRule: 'VALIDATE.ORIGINALITY_MARKERS',
    fix: {
      kind: 'content.manual', url: substantial[0].url, before: null, after: null,
      rationale:
        'Original information can only come from the organization doing original work. The platform ' +
        'will not generate claims of research that did not happen.',
      requiresHuman: true,
    },
  }));
  return out;
}

function expertiseSignals(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const people = ctx.entityGraph.entities.filter((e) => e.nodeClass === 'Person');
  const articlePages = indexablePages(ctx).filter(
    (p) => (ctx.content.byUrl.get(p.url)?.formats ?? []).some((f) => f === 'article' || f === 'guide'));

  if (articlePages.length >= 3 && people.length === 0) {
    out.push(signal({
      engine: 'geo', family: P.EXPERTISE_SIGNALS_MISSING, scope: ctx.site.origin,
      rule: 'GEO.NO_NAMED_EXPERTISE', category: 'GEO',
      title: 'No named people are associated with the site\'s content',
      detail:
        `The site publishes ${articlePages.length} article-style pages but no Person entity appears ` +
        'anywhere in its structured data or bylines. Nobody is identifiably behind the content.',
      severity: 'medium', confidence: 0.65,
      affectedUrls: articlePages.map((p) => p.url).slice(0, 30),
      evidence: [derived('entity-engine', ctx.site.origin, {
        note: `${articlePages.length} article-style pages, 0 Person entities extracted`,
        value: articlePages.length,
      })],
      currentState: 'No people are named as authors or experts anywhere on the crawled site.',
      recommendedState: 'Content is attributed to the real people who produced it.',
      validationRule: 'VALIDATE.PERSON_ENTITY_PRESENT',
      fix: {
        kind: 'content.manual', url: articlePages[0].url, before: null, after: null,
        rationale:
          'Author identity must reflect who actually wrote the content. Creating author profiles for ' +
          'people who did not write the pages would be a fabricated credential, which this platform ' +
          'does not produce under any circumstances.',
        requiresHuman: true,
      },
    }));
    return out;
  }

  // Authors who are named but have no biography or credentials anywhere.
  const thinAuthors = people.filter((p) => !p.description && p.sameAs.length === 0);
  if (thinAuthors.length && articlePages.length >= 2) {
    out.push(signal({
      engine: 'geo', family: P.EXPERTISE_SIGNALS_MISSING, scope: 'author-credentials',
      rule: 'GEO.AUTHOR_WITHOUT_CREDENTIALS', category: 'GEO',
      title: `${thinAuthors.length} named author(s) have no stated background`,
      detail:
        'These people are credited as authors but the site says nothing about who they are or why ' +
        'they are qualified to write on the subject.',
      severity: 'low', confidence: 0.6,
      affectedUrls: [...new Set(thinAuthors.flatMap((p) => p.mentionedOn))].slice(0, 20),
      evidence: thinAuthors.slice(0, 6).map((p) => derived('entity-engine', p.mentionedOn[0] ?? ctx.site.origin, {
        note: `"${p.name}" is credited as an author with no description and no external profile`,
        value: p.name,
      })),
      currentState: `${thinAuthors.length} authors are named without any biographical context.`,
      recommendedState: 'Authors have a real biography stating their actual relevant background.',
      validationRule: 'VALIDATE.AUTHOR_HAS_BIO',
      fix: {
        kind: 'content.manual', url: thinAuthors[0].mentionedOn[0] ?? ctx.site.origin, before: null, after: null,
        rationale:
          'Credentials are factual claims about a real person. The platform will not write a ' +
          'biography or attribute qualifications it cannot verify.',
        requiresHuman: true,
      },
    }));
  }
  return out;
}

function citationPractice(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const substantial = indexablePages(ctx).filter((p) => p.wordCount >= 400);
  if (substantial.length < 3) return out;

  const citing = substantial.filter(
    (p) => (ctx.content.byUrl.get(p.url)?.externalReferences.filter((r) => r.inMainContent).length ?? 0) > 0);
  const ratio = citing.length / substantial.length;
  if (ratio >= 0.3) return out;

  out.push(signal({
    engine: 'geo', family: P.FACTS_UNSOURCED, scope: `${ctx.site.origin}|citation-practice`,
    rule: 'GEO.LOW_CITATION_RATE', category: 'GEO',
    title: `Only ${citing.length} of ${substantial.length} substantial pages cite any outside source`,
    detail:
      'Main content almost never links out. Content that engages with sources is easier to verify ' +
      'and situates the site within its subject rather than isolated from it.',
    severity: 'low', confidence: 0.55,
    affectedUrls: substantial.filter((p) => !citing.includes(p)).map((p) => p.url).slice(0, 40),
    evidence: [derived('content-engine', ctx.site.origin, {
      note: `${citing.length}/${substantial.length} pages over 400 words contain an outbound reference ` +
        'inside their main content',
      value: Number(ratio.toFixed(3)),
    })],
    currentState: `${Math.round(ratio * 100)}% of substantial pages cite an external source.`,
    recommendedState: 'Content cites the sources it draws on where it draws on them.',
    validationRule: 'VALIDATE.CITATION_RATE',
  }));
  return out;
}

function comparisonCoverage(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const products = ctx.entityGraph.entities.filter((e) => ['Product', 'Service'].includes(e.nodeClass));
  if (products.length < 2) return out;

  const comparisonPages = [...ctx.content.byUrl.values()].filter((m) => m.comparisons.length > 0);
  if (comparisonPages.length > 0) return out;

  out.push(signal({
    engine: 'geo', family: P.COMPARISON_COVERAGE_GAP, scope: ctx.site.origin,
    rule: 'GEO.NO_COMPARISON_CONTENT', category: 'GEO',
    title: `The site offers ${products.length} products or services but compares none of them`,
    detail:
      'No page presents a comparison, a table of options, or a "which should I choose" treatment. ' +
      'Readers deciding between the site\'s own offerings have nothing to work from, and neither ' +
      'does anything summarising the site.',
    severity: 'low', confidence: 0.45,
    affectedUrls: [...new Set(products.flatMap((p) => p.mentionedOn))].slice(0, 20),
    evidence: [derived('content-engine', ctx.site.origin, {
      note: `${products.length} offerings declared (${products.slice(0, 5).map((p) => p.name).join(', ')}); ` +
        'no comparison heading or comparison table found on any page',
      value: products.map((p) => p.name),
    })],
    currentState: 'No comparison content exists anywhere on the crawled site.',
    recommendedState: 'Where the site offers alternatives, it explains how they differ.',
    validationRule: 'VALIDATE.COMPARISON_PRESENT',
    fix: {
      kind: 'content.manual', url: products[0].mentionedOn[0] ?? ctx.site.origin, before: null, after: null,
      rationale:
        'An accurate comparison requires knowing how the offerings genuinely differ. The platform ' +
        'identifies the gap; the content must come from someone who knows the answer.',
      requiresHuman: true,
    },
  }));
  return out;
}

function brandConsistency(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const org = ctx.entityGraph.primaryOrganization;
  if (!org) return out;

  // The same organization named differently across pages is an entity-resolution
  // problem for anything trying to identify the publisher.
  const variants = new Map<string, string[]>();
  for (const page of ctx.site.pages) {
    const candidates = [
      page.openGraph['og:site_name'],
      page.title?.split(/\s[|–—]\s/).pop()?.trim(),
    ].filter((v): v is string => !!v && v.length > 1);
    for (const v of candidates) {
      const key = v.trim();
      if (!variants.has(key)) variants.set(key, []);
      variants.get(key)!.push(page.url);
    }
  }
  // Keep variants that look like the org name but are not identical to it.
  const orgLower = org.name.toLowerCase();
  const nearVariants = [...variants.entries()].filter(([name]) => {
    const n = name.toLowerCase();
    if (n === orgLower) return false;
    const sim = similarity(n.split(/\s+/), orgLower.split(/\s+/));
    return sim > 0 && sim < 1;
  });

  if (nearVariants.length === 0) return out;
  const affected = [...new Set(nearVariants.flatMap(([, urls]) => urls))];

  out.push(signal({
    engine: 'geo', family: P.BRAND_INCONSISTENT, scope: `org:${org.name}`,
    rule: 'GEO.BRAND_NAME_INCONSISTENT', category: 'ENTITY',
    title: `The site names its publisher in ${nearVariants.length + 1} different ways`,
    detail:
      `Structured data declares "${org.name}", but pages also present ` +
      `${nearVariants.map(([n]) => `"${n}"`).join(', ')}. Anything resolving the publisher has to ` +
      'decide whether these are the same organization.',
    severity: 'low', confidence: 0.55,
    affectedUrls: affected.slice(0, 30),
    evidence: [
      ...org.evidence.slice(0, 2),
      ...nearVariants.slice(0, 4).map(([name, urls]) => observed('parser.head', urls[0], {
        excerpt: truncate(name, 100),
        note: `Alternative publisher name used on ${urls.length} page(s)`,
      })),
    ],
    currentState: `Publisher is named as "${org.name}" and ${nearVariants.length} variant(s).`,
    recommendedState:
      'One canonical organization name is used consistently; genuine alternative names are declared as alternateName.',
    validationRule: 'VALIDATE.BRAND_NAME_CONSISTENT',
  }));
  return out;
}

/**
 * Topic clusters whose members do not link to each other. Related content that is not
 * connected reads as a set of unrelated pages.
 */
function topicConnectivity(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];

  for (const cluster of ctx.siteGraph.topicClusters) {
    if (cluster.urls.length < 3) continue;
    const members = new Set(cluster.urls);
    let internalEdges = 0;
    for (const u of cluster.urls) {
      for (const target of ctx.siteGraph.graph.out.get(u) ?? []) {
        if (members.has(target)) internalEdges++;
      }
    }
    // A connected cluster of n pages should have at least n-1 internal links.
    const expected = cluster.urls.length - 1;
    if (internalEdges >= expected) continue;

    out.push(signal({
      engine: 'geo', family: P.MISSING_TOPIC_LINK, scope: `topic:${cluster.id}`,
      rule: 'GEO.TOPIC_CLUSTER_DISCONNECTED', category: 'INTERNAL_LINKING',
      title: `The "${cluster.label}" pages barely link to each other`,
      detail:
        `${cluster.urls.length} pages share a term set but only ${internalEdges} link(s) connect them. ` +
        'Nothing about the site\'s structure indicates these pages belong together.',
      severity: 'low', confidence: 0.6,
      affectedUrls: cluster.urls,
      evidence: [derived('site-graph.topics', cluster.urls[0], {
        note: `${internalEdges} internal link(s) among ${cluster.urls.length} topically related pages ` +
          `(terms: ${cluster.terms.slice(0, 6).join(', ')})`,
        value: internalEdges,
      })],
      currentState: `${internalEdges} of at least ${expected} expected intra-topic links exist.`,
      recommendedState: 'Pages on the same topic link to each other where the connection is genuine.',
      validationRule: 'VALIDATE.TOPIC_CONNECTIVITY',
    }));
  }
  return out;
}
