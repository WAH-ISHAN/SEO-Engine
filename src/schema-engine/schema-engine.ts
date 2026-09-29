import { analyzablePages, indexablePages, type AnalysisContext, type AnalysisEngine } from '../core/context.js';
import { derived, observed, type Evidence, type PageProps, type SchemaBlock, type Signal } from '../core/model.js';
import { PROBLEM_FAMILIES as P, signal } from '../core/problems.js';
import { normalizeWhitespace, truncate } from '../core/text.js';
import { isHttpUrl } from '../core/url.js';
import { normalizeType, propArray, propString } from '../parser/structured-data.js';
import { DATE_PROPERTIES, FORMAT_TO_TYPE, SINGLETON_TYPES, specFor, URL_PROPERTIES } from './vocabulary.js';

/**
 * Structured-data detection and validation.
 *
 * The engine detects what is already implemented before it judges anything, then checks
 * three things: is the markup well-formed, does it carry the properties its type needs,
 * and - the check that matters most - does it agree with what the page actually shows?
 *
 * Structured data that describes content a visitor cannot see is misleading, whatever
 * its effect on results. That check is treated as a correctness failure, not a
 * nice-to-have.
 */
export const schemaEngine: AnalysisEngine = {
  id: 'schema',
  name: 'Structured Data',
  analyze(ctx: AnalysisContext): Signal[] {
    return [
      ...parseErrors(ctx),
      ...missingRequiredProperties(ctx),
      ...invalidPropertyValues(ctx),
      ...duplicateTypes(ctx),
      ...contentMismatches(ctx),
      ...absentStructuredData(ctx),
      ...orphanedSchemaGraph(ctx),
    ];
  },
};

function parseErrors(ctx: AnalysisContext): Signal[] {
  const broken: { url: string; error: string; excerpt: string }[] = [];
  for (const page of analyzablePages(ctx)) {
    for (const s of page.schemas) {
      if (!s.parseError) continue;
      broken.push({ url: page.url, error: s.parseError, excerpt: truncate(String(s.raw), 200) });
    }
  }
  if (broken.length === 0) return [];

  return [signal({
    engine: 'schema', family: P.SCHEMA_INVALID, scope: 'parse-errors',
    rule: 'SCHEMA.PARSE_ERROR', category: 'STRUCTURED_DATA',
    title: `${broken.length} structured-data block(s) are not valid JSON`,
    detail:
      'These blocks cannot be parsed, so they are ignored entirely. The markup is present in the ' +
      'page but contributes nothing.',
    severity: 'high', confidence: 0.99,
    affectedUrls: [...new Set(broken.map((b) => b.url))],
    evidence: broken.slice(0, 8).map((b) => observed('parser.structured-data', b.url, {
      excerpt: b.excerpt, note: `JSON parse error: ${b.error}`,
    })),
    currentState: `${broken.length} JSON-LD blocks fail to parse.`,
    recommendedState: 'Every JSON-LD block parses as valid JSON.',
    validationRule: 'VALIDATE.SCHEMA_PARSES',
  })];
}

function missingRequiredProperties(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const byTypeAndProp = new Map<string, { urls: string[]; evidence: Evidence[] }>();
  const recommendedGaps = new Map<string, { urls: string[]; evidence: Evidence[] }>();

  for (const page of analyzablePages(ctx)) {
    for (const [i, block] of page.schemas.entries()) {
      if (block.parseError || !block.raw || typeof block.raw !== 'object') continue;
      const obj = block.raw as Record<string, unknown>;
      for (const type of block.types.map(normalizeType)) {
        const spec = specFor(type);
        if (!spec) continue;
        const locator = `${page.url}#structured-data[${i}]`;

        for (const prop of spec.required) {
          if (hasProperty(obj, prop)) continue;
          const key = `${type}.${prop}`;
          if (!byTypeAndProp.has(key)) byTypeAndProp.set(key, { urls: [], evidence: [] });
          const entry = byTypeAndProp.get(key)!;
          entry.urls.push(page.url);
          if (entry.evidence.length < 6) {
            entry.evidence.push(observed('parser.structured-data', locator, {
              excerpt: truncate(JSON.stringify(obj), 200),
              note: `${type} block declares no "${prop}" property`,
            }));
          }
        }
        for (const prop of spec.recommended) {
          if (hasProperty(obj, prop)) continue;
          const key = `${type}.${prop}`;
          if (!recommendedGaps.has(key)) recommendedGaps.set(key, { urls: [], evidence: [] });
          const entry = recommendedGaps.get(key)!;
          entry.urls.push(page.url);
          if (entry.evidence.length < 4) {
            entry.evidence.push(derived('schema-engine', locator, {
              note: `${type} block omits the commonly expected "${prop}" property`,
            }));
          }
        }
      }
    }
  }

  for (const [key, entry] of byTypeAndProp) {
    const [type, prop] = key.split('.');
    out.push(signal({
      engine: 'schema', family: P.SCHEMA_INCOMPLETE, scope: key,
      rule: `SCHEMA.MISSING_REQUIRED.${type}.${prop}`, category: 'STRUCTURED_DATA',
      title: `${entry.urls.length} ${type} block(s) omit the required "${prop}" property`,
      detail:
        `Without "${prop}", the ${type} markup does not describe its subject. Consumers that ` +
        'validate against the type will discard the block.',
      severity: 'medium', confidence: 0.9,
      affectedUrls: [...new Set(entry.urls)],
      evidence: entry.evidence,
      currentState: `${entry.urls.length} ${type} blocks have no "${prop}".`,
      recommendedState: `Every ${type} block declares "${prop}" with a value drawn from the page.`,
      validationRule: 'VALIDATE.SCHEMA_REQUIRED_PROPERTIES',
      fix: {
        kind: 'schema.fix', url: entry.urls[0], before: { type, missing: prop }, after: null,
        rationale:
          `The value of "${prop}" is a fact about this page's subject. It is filled in from the ` +
          'page\'s own content where an unambiguous source exists, and otherwise left for an editor ' +
          'rather than invented.',
        requiresHuman: true,
      },
    }));
  }

  // Recommended-property gaps are aggregated into one low-severity item per type so the
  // queue is not flooded with advisory noise.
  const byType = new Map<string, { props: string[]; urls: string[]; evidence: Evidence[] }>();
  for (const [key, entry] of recommendedGaps) {
    const [type, prop] = key.split('.');
    if (!byType.has(type)) byType.set(type, { props: [], urls: [], evidence: [] });
    const t = byType.get(type)!;
    t.props.push(prop);
    t.urls.push(...entry.urls);
    if (t.evidence.length < 5) t.evidence.push(...entry.evidence.slice(0, 1));
  }
  for (const [type, t] of byType) {
    out.push(signal({
      engine: 'schema', family: P.SCHEMA_INCOMPLETE, scope: `${type}:recommended`,
      rule: `SCHEMA.MISSING_RECOMMENDED.${type}`, category: 'STRUCTURED_DATA',
      title: `${type} markup omits ${t.props.length} commonly expected propert${t.props.length === 1 ? 'y' : 'ies'}`,
      detail:
        `Missing: ${t.props.join(', ')}. These are not required, and adding one is only worthwhile ` +
        'when the page genuinely has the information.',
      severity: 'low', confidence: 0.6,
      affectedUrls: [...new Set(t.urls)],
      evidence: t.evidence,
      currentState: `${type} blocks declare only their required properties.`,
      recommendedState: `${type} blocks carry the expected properties that the page can truthfully supply.`,
      validationRule: 'VALIDATE.SCHEMA_RECOMMENDED_PROPERTIES',
    }));
  }
  return out;
}

function invalidPropertyValues(ctx: AnalysisContext): Signal[] {
  const problems: { url: string; detail: string; excerpt: string }[] = [];

  for (const page of analyzablePages(ctx)) {
    for (const [i, block] of page.schemas.entries()) {
      if (block.parseError || !block.raw || typeof block.raw !== 'object') continue;
      const obj = block.raw as Record<string, unknown>;
      const locator = `${page.url}#structured-data[${i}]`;

      for (const [prop, value] of Object.entries(obj)) {
        if (DATE_PROPERTIES.has(prop)) {
          const s = typeof value === 'string' ? value : propString({ v: value }, 'v');
          if (s && !isIsoDate(s)) {
            problems.push({
              url: page.url,
              detail: `"${prop}" is "${truncate(s, 40)}", which is not an ISO 8601 date`,
              excerpt: locator,
            });
          }
        }
        if (URL_PROPERTIES.has(prop)) {
          for (const v of Array.isArray(value) ? value : [value]) {
            const s = typeof v === 'string' ? v : v && typeof v === 'object'
              ? propString(v as Record<string, unknown>, 'url', 'contentUrl', '@id')
              : null;
            if (s && !isHttpUrl(s) && !s.startsWith('#') && !s.startsWith('/')) {
              problems.push({
                url: page.url,
                detail: `"${prop}" is "${truncate(s, 40)}", which is not an absolute URL`,
                excerpt: locator,
              });
            }
          }
        }
      }

      // An AggregateRating with no reviews behind it is the classic fabricated signal.
      if (block.types.map(normalizeType).includes('AggregateRating')) {
        const count = Number(propString(obj, 'ratingCount', 'reviewCount') ?? '0');
        if (!Number.isFinite(count) || count <= 0) {
          problems.push({
            url: page.url,
            detail: 'AggregateRating declares a rating with no rating count, so nothing supports the score',
            excerpt: locator,
          });
        }
      }
    }
  }
  if (problems.length === 0) return [];

  return [signal({
    engine: 'schema', family: P.SCHEMA_INVALID, scope: 'invalid-values',
    rule: 'SCHEMA.INVALID_PROPERTY_VALUE', category: 'STRUCTURED_DATA',
    title: `${problems.length} structured-data propert${problems.length === 1 ? 'y has' : 'ies have'} an invalid value`,
    detail: 'Values that do not match the expected format are discarded by validating consumers.',
    severity: 'medium', confidence: 0.9,
    affectedUrls: [...new Set(problems.map((p) => p.url))],
    evidence: problems.slice(0, 10).map((p) => observed('schema-engine', p.excerpt, { note: p.detail })),
    currentState: `${problems.length} property values are malformed.`,
    recommendedState: 'Dates are ISO 8601, URLs are absolute, and ratings are backed by counts.',
    validationRule: 'VALIDATE.SCHEMA_VALUE_FORMATS',
  })];
}

function duplicateTypes(ctx: AnalysisContext): Signal[] {
  const offenders: { url: string; type: string; count: number; values: string[] }[] = [];

  for (const page of analyzablePages(ctx)) {
    const counts = new Map<string, SchemaBlock[]>();
    for (const block of page.schemas) {
      if (block.parseError) continue;
      for (const t of block.types.map(normalizeType)) {
        if (!SINGLETON_TYPES.has(t)) continue;
        if (!counts.has(t)) counts.set(t, []);
        counts.get(t)!.push(block);
      }
    }
    for (const [type, blocks] of counts) {
      if (blocks.length < 2) continue;
      const values = blocks.map((b) =>
        propString(b.raw as Record<string, unknown>, 'name', 'headline', '@id') ?? '(unnamed)');
      // Identical repeats are harmless duplication; differing values are a contradiction.
      offenders.push({ url: page.url, type, count: blocks.length, values });
    }
  }
  if (offenders.length === 0) return [];

  const contradictory = offenders.filter((o) => new Set(o.values).size > 1);
  return [signal({
    engine: 'schema', family: P.SCHEMA_DUPLICATE, scope: 'singleton-duplicates',
    rule: 'SCHEMA.DUPLICATE_SINGLETON_TYPE', category: 'STRUCTURED_DATA',
    title: `${offenders.length} page(s) declare a singleton type more than once`,
    detail:
      contradictory.length > 0
        ? `${contradictory.length} of these declare different values for the same type on one page, ` +
          'so the page makes two contradictory statements about the same thing. This normally means ' +
          'two systems - a theme and a plugin, say - are both emitting markup.'
        : 'The same type is declared more than once on a page with matching values, which is ' +
          'redundant rather than contradictory.',
    severity: contradictory.length > 0 ? 'medium' : 'low',
    confidence: 0.9,
    affectedUrls: offenders.map((o) => o.url),
    evidence: offenders.slice(0, 8).map((o) => observed('schema-engine', o.url, {
      note: `${o.count} ${o.type} blocks: ${o.values.map((v) => truncate(v, 40)).join(' | ')}`,
    })),
    currentState: `${offenders.length} pages declare a singleton type multiple times.`,
    recommendedState: 'One system owns structured data, and singleton types appear once per page.',
    validationRule: 'VALIDATE.SCHEMA_NO_DUPLICATE_SINGLETONS',
  })];
}

/**
 * The central check: does the markup describe what the page shows?
 * Markup that asserts content a visitor cannot see is misleading regardless of intent.
 */
function contentMismatches(ctx: AnalysisContext): Signal[] {
  const mismatches: { url: string; detail: string; excerpt: string }[] = [];

  for (const page of analyzablePages(ctx)) {
    const visible = normalizeWhitespace(`${page.text} ${page.h1s.join(' ')} ${page.title ?? ''}`).toLowerCase();
    const model = ctx.content.byUrl.get(page.url);

    for (const [i, block] of page.schemas.entries()) {
      if (block.parseError || !block.raw || typeof block.raw !== 'object') continue;
      const obj = block.raw as Record<string, unknown>;
      const locator = `${page.url}#structured-data[${i}]`;
      const types = block.types.map(normalizeType);

      const headline = propString(obj, 'headline', 'name');
      if (headline && headline.length > 10 && types.some((t) => specFor(t)?.mustMatchContent?.length)) {
        if (!visible.includes(headline.toLowerCase().slice(0, Math.min(40, headline.length)))) {
          mismatches.push({
            url: page.url,
            detail: `${types[0]} declares name/headline "${truncate(headline, 60)}", which does not appear in the visible page text`,
            excerpt: locator,
          });
        }
      }

      // FAQ markup whose questions are nowhere on the page is the most common form of
      // fabricated structured data.
      if (types.includes('FAQPage') || types.includes('QAPage')) {
        const questions = propArray(obj, 'mainEntity')
          .map((q) => (q && typeof q === 'object' ? propString(q as Record<string, unknown>, 'name', 'text') : null))
          .filter((q): q is string => !!q);
        const invisible = questions.filter((q) => !visible.includes(q.toLowerCase().slice(0, Math.min(35, q.length))));
        if (invisible.length > 0) {
          mismatches.push({
            url: page.url,
            detail:
              `${invisible.length} of ${questions.length} FAQ questions in the markup do not appear ` +
              `in the page's visible content (for example: "${truncate(invisible[0], 70)}")`,
            excerpt: locator,
          });
        }
      }

      if (types.includes('HowTo')) {
        const steps = propArray(obj, 'step')
          .map((s) => (typeof s === 'string' ? s : s && typeof s === 'object'
            ? propString(s as Record<string, unknown>, 'name', 'text') : null))
          .filter((s): s is string => !!s);
        const hasVisibleSteps = (model?.howToSteps.length ?? 0) > 0;
        if (steps.length > 0 && !hasVisibleSteps) {
          mismatches.push({
            url: page.url,
            detail: `HowTo markup declares ${steps.length} steps, but no step-by-step content was found on the page`,
            excerpt: locator,
          });
        }
      }

      if (types.includes('Review') || types.includes('AggregateRating')) {
        const hasVisibleReview = /\b(review|rating|stars?|out of 5|★)\b/i.test(page.text);
        if (!hasVisibleReview) {
          mismatches.push({
            url: page.url,
            detail:
              `${types[0]} markup is present but the page shows no visible review or rating content. ` +
              'Review markup must correspond to reviews the page actually displays.',
            excerpt: locator,
          });
        }
      }
    }
  }
  if (mismatches.length === 0) return [];

  return [signal({
    engine: 'schema', family: P.SCHEMA_CONTRADICTS_CONTENT, scope: 'content-mismatch',
    rule: 'SCHEMA.CONTRADICTS_VISIBLE_CONTENT', category: 'STRUCTURED_DATA',
    title: `${mismatches.length} structured-data block(s) describe content the page does not show`,
    detail:
      'Structured data is a machine-readable statement about what a page contains. When it asserts ' +
      'questions, steps, reviews or headlines that are not on the page, it misrepresents the page to ' +
      'anything that reads it. Either the content or the markup has to change.',
    severity: 'high', confidence: 0.8,
    affectedUrls: [...new Set(mismatches.map((m) => m.url))],
    evidence: mismatches.slice(0, 10).map((m) => observed('schema-engine', m.excerpt, { note: m.detail })),
    currentState: `${mismatches.length} markup blocks assert content that is not visible on the page.`,
    recommendedState: 'Structured data describes only what the page actually shows.',
    validationRule: 'VALIDATE.SCHEMA_MATCHES_CONTENT',
    fix: {
      kind: 'schema.remove', url: mismatches[0].url, before: mismatches[0].detail, after: null,
      rationale:
        'Either the markup is removed or the content it claims is genuinely added. Which of the two ' +
        'is correct depends on what the page is meant to contain, so this needs a human decision.',
      requiresHuman: true,
    },
  })];
}

function absentStructuredData(ctx: AnalysisContext): Signal[] {
  const out: Signal[] = [];
  const byExpectedType = new Map<string, string[]>();

  for (const page of indexablePages(ctx)) {
    const model = ctx.content.byUrl.get(page.url);
    if (!model) continue;
    const present = new Set(page.schemas.flatMap((s) => s.types.map(normalizeType)));

    for (const format of model.formats) {
      const expected = FORMAT_TO_TYPE[format];
      if (!expected || present.has(expected)) continue;
      // Only report when the content genuinely exhibits the format's substance.
      if (expected === 'FAQPage' && model.questions.filter((q) => q.hasDirectAnswer).length < 3) continue;
      if (expected === 'HowTo' && model.howToSteps.length === 0) continue;
      if (expected === 'Article' && page.wordCount < 300) continue;
      if (!byExpectedType.has(expected)) byExpectedType.set(expected, []);
      byExpectedType.get(expected)!.push(page.url);
    }
  }

  // Scoped per URL rather than per type, so that when the AEO engine independently
  // notices the same page has unmarked Q&A content, the two findings merge into one
  // recommendation instead of competing for the same page.
  for (const [type, urls] of byExpectedType) {
    for (const url of urls) {
      out.push(signal({
        engine: 'schema', family: P.STRUCTURED_DATA_ABSENT, scope: url,
        rule: `SCHEMA.EXPECTED_TYPE_ABSENT.${type}`, category: 'STRUCTURED_DATA',
        title: `${truncate(url, 60)} presents ${type}-shaped content without declaring it`,
        detail:
          `This page already contains the content ${type} describes, but does not declare the ` +
          'type. Adding it states what the page is; it does not change what the page contains.',
        severity: 'low', confidence: 0.65,
        affectedUrls: [url],
        evidence: [derived('schema-engine', url, {
          note: `Content shape matches ${type}; no ${type} block present`,
          value: type,
        })],
        currentState: `The page carries ${type}-shaped content with no matching markup.`,
        recommendedState: `Pages whose content is genuinely ${type} declare it, with values taken from the page.`,
        validationRule: 'VALIDATE.SCHEMA_TYPE_PRESENT',
      }));
    }
  }
  return out;
}

/**
 * Structured data spread across a page with no connective properties: an Article that
 * names no publisher, a Product with no brand. The blocks describe things but not how
 * they relate.
 */
function orphanedSchemaGraph(ctx: AnalysisContext): Signal[] {
  const offenders: { url: string; detail: string }[] = [];

  for (const page of indexablePages(ctx)) {
    const blocks = page.schemas.filter((s) => !s.parseError && s.types.length > 0);
    if (blocks.length < 2) continue;
    const linked = blocks.some((b) => {
      const obj = b.raw as Record<string, unknown>;
      return ['publisher', 'author', 'isPartOf', 'mainEntityOfPage', 'about', 'provider', 'brand', '@id']
        .some((p) => hasProperty(obj, p));
    });
    if (!linked) {
      offenders.push({
        url: page.url,
        detail: `${blocks.length} structured-data blocks (${blocks.flatMap((b) => b.types).join(', ')}) ` +
          'with no property connecting any of them',
      });
    }
  }
  if (offenders.length === 0) return [];

  return [signal({
    engine: 'schema', family: P.ENTITY_RELATIONSHIP_MISSING, scope: 'disconnected-schema',
    rule: 'SCHEMA.BLOCKS_NOT_CONNECTED', category: 'STRUCTURED_DATA',
    title: `${offenders.length} page(s) declare multiple entities with no relationships between them`,
    detail:
      'Each block describes something in isolation. Properties such as publisher, author, isPartOf ' +
      'or @id turn a list of separate declarations into a connected description of the page.',
    severity: 'low', confidence: 0.6,
    affectedUrls: offenders.map((o) => o.url),
    evidence: offenders.slice(0, 8).map((o) => derived('schema-engine', o.url, { note: o.detail })),
    currentState: `${offenders.length} pages declare disconnected structured-data blocks.`,
    recommendedState: 'Blocks on a page reference each other so the page describes one connected subject.',
    validationRule: 'VALIDATE.SCHEMA_CONNECTED',
  })];
}

// ---------------------------------------------------------------------------

function hasProperty(obj: Record<string, unknown>, prop: string): boolean {
  const v = obj[prop];
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?([.,]\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s.trim())) {
    return false;
  }
  return !Number.isNaN(Date.parse(s));
}

export type { PageProps };
