import { observed, type EntityProps, type Evidence, type PageProps } from '../core/model.js';
import { normalizeWhitespace, truncate } from '../core/text.js';
import { normalizeUrl } from '../core/url.js';
import { normalizeType, propArray, propString, typesOf } from '../parser/structured-data.js';

/**
 * Entity extraction.
 *
 * Hard rule: an entity attribute is recorded only when it was read out of the page.
 * Nothing here infers that an organization has a phone number, a founder, or a
 * relationship to another entity. Where a fact is absent, its absence is the finding -
 * that is what the AIO engine reports as missing context, rather than filling the gap.
 */

const ORG_TYPES = new Set([
  'Organization', 'Corporation', 'LocalBusiness', 'NGO', 'EducationalOrganization',
  'GovernmentOrganization', 'SportsOrganization', 'MedicalOrganization', 'NewsMediaOrganization',
  'OnlineBusiness', 'Store', 'Restaurant', 'ProfessionalService', 'FinancialService',
  'HomeAndConstructionBusiness', 'AutomotiveBusiness', 'LodgingBusiness', 'HealthAndBeautyBusiness',
]);
const PERSON_TYPES = new Set(['Person']);
const PRODUCT_TYPES = new Set(['Product', 'SoftwareApplication', 'Book', 'Vehicle', 'IndividualProduct']);
const SERVICE_TYPES = new Set(['Service', 'Offer', 'AggregateOffer', 'FinancialProduct']);
const PLACE_TYPES = new Set(['Place', 'PostalAddress', 'LocalBusiness', 'AdministrativeArea', 'City', 'Country']);
const ARTICLE_TYPES = new Set([
  'Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'Report', 'Guide',
]);

export type EntityClass =
  | 'Organization' | 'Person' | 'Product' | 'Service' | 'Location' | 'Article' | 'Entity';

export function classifyType(schemaType: string): EntityClass {
  const t = normalizeType(schemaType);
  if (ORG_TYPES.has(t)) return 'Organization';
  if (PERSON_TYPES.has(t)) return 'Person';
  if (PRODUCT_TYPES.has(t)) return 'Product';
  if (SERVICE_TYPES.has(t)) return 'Service';
  if (PLACE_TYPES.has(t)) return 'Location';
  if (ARTICLE_TYPES.has(t)) return 'Article';
  return 'Entity';
}

export interface ExtractedEntity extends EntityProps {
  /** Schema-declared @id, used to link entities across pages. */
  schemaId: string | null;
  /** Relationship claims this entity makes, each with its own evidence. */
  claims: EntityClaim[];
  nodeClass: EntityClass;
  sourceUrl: string;
}

export interface EntityClaim {
  /** Relationship vocabulary from the central model. */
  relation: 'offers' | 'authored_by' | 'published_by' | 'located_in' | 'mentions' | 'references' | 'related_to';
  /** Name or URL of the target, exactly as stated on the page. */
  target: string;
  targetClass: EntityClass;
  evidence: Evidence[];
}

/** Extracts entities declared in a page's structured data, including nested ones. */
export function extractFromSchema(page: PageProps): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];

  for (const [i, block] of page.schemas.entries()) {
    if (block.parseError || !block.raw || typeof block.raw !== 'object') continue;
    const root = block.raw as Record<string, unknown>;
    // An Organization that declares its services inline is describing several
    // entities in one block. Each typed object is an entity in its own right, so the
    // graph would be missing real, stated relationships if only the outer one counted.
    for (const obj of typedObjectsWithin(root)) {
      const types = typesOf(obj);
      if (types.length === 0) continue;

      const name = propString(obj, 'name', 'legalName', 'headline', 'alternateName');
      const nodeClass = classifyType(types[0]);
      if (nodeClass === 'Article') continue; // Articles become Page-level nodes, not entities.
      if (!name) continue;

      const locator = `${page.url}#structured-data[${i}]`;
      const ev = (note: string, value?: unknown): Evidence =>
        observed('schema', locator, {
          note,
          value,
          excerpt: truncate(JSON.stringify(obj), 220),
        });

      const urlProp = propString(obj, 'url');
      const sameAs = propArray(obj, 'sameAs')
        .map((s) => (typeof s === 'string' ? s : propString(s as Record<string, unknown>, 'url', '@id')))
        .filter((s): s is string => !!s);

      const entity: ExtractedEntity = {
        name: normalizeWhitespace(name),
        entityType: types[0],
        description: propString(obj, 'description', 'disambiguatingDescription'),
        urls: [urlProp, page.url].filter((u): u is string => !!u).map((u) => normalizeUrl(u, page.url) ?? u),
        aliases: propArray(obj, 'alternateName')
          .filter((a): a is string => typeof a === 'string')
          .map(normalizeWhitespace),
        sameAs,
        evidence: [ev(`Declared as ${types.join(', ')} in ${block.syntax} on this page`, types)],
        origin: 'schema',
        confidence: 0.95,
        schemaId: propString(obj, '@id'),
        nodeClass,
        sourceUrl: page.url,
        claims: [],
      };

      // Relationship claims, each one read directly from a property.
      for (const target of propArray(obj, 'author')) {
        const t = nameOf(target);
        if (t) {
          entity.claims.push({
            relation: 'authored_by', target: t, targetClass: 'Person',
            evidence: [ev(`author property names "${t}"`, t)],
          });
        }
      }
      for (const target of propArray(obj, 'publisher')) {
        const t = nameOf(target);
        if (t) {
          entity.claims.push({
            relation: 'published_by', target: t, targetClass: 'Organization',
            evidence: [ev(`publisher property names "${t}"`, t)],
          });
        }
      }
      for (const target of [...propArray(obj, 'makesOffer'), ...propArray(obj, 'hasOfferCatalog'), ...propArray(obj, 'offers')]) {
        const t = nameOf(target);
        if (t) {
          entity.claims.push({
            relation: 'offers', target: t, targetClass: 'Service',
            evidence: [ev(`offer property names "${t}"`, t)],
          });
        }
      }
      for (const target of [...propArray(obj, 'address'), ...propArray(obj, 'areaServed'), ...propArray(obj, 'location')]) {
        const t = addressOf(target);
        if (t) {
          entity.claims.push({
            relation: 'located_in', target: t, targetClass: 'Location',
            evidence: [ev(`address/location property states "${t}"`, t)],
          });
        }
      }
      for (const target of [...propArray(obj, 'parentOrganization'), ...propArray(obj, 'subOrganization'), ...propArray(obj, 'brand')]) {
        const t = nameOf(target);
        if (t) {
          entity.claims.push({
            relation: 'related_to', target: t, targetClass: 'Organization',
            evidence: [ev(`organization relationship property names "${t}"`, t)],
          });
        }
      }
      for (const target of [...propArray(obj, 'citation'), ...propArray(obj, 'isBasedOn')]) {
        const t = typeof target === 'string' ? target : nameOf(target);
        if (t) {
          entity.claims.push({
            relation: 'references', target: t, targetClass: 'Entity',
            evidence: [ev(`citation property references "${truncate(t, 80)}"`, t)],
          });
        }
      }

      out.push(entity);
    }
  }
  return out;
}

/**
 * Yields the block itself plus every nested object that declares its own @type,
 * outermost first. Depth is bounded: structured data nested more than a few levels
 * deep is describing implementation detail, not entities.
 */
function typedObjectsWithin(root: Record<string, unknown>, maxDepth = 3): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number) => {
    if (depth > maxDepth || v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (typesOf(obj).length > 0) out.push(obj);
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('@')) continue;
      visit(value, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function nameOf(v: unknown): string | null {
  if (typeof v === 'string') return normalizeWhitespace(v) || null;
  if (v && typeof v === 'object') {
    const s = propString(v as Record<string, unknown>, 'name', 'legalName', 'alternateName', 'url', '@id');
    return s ? normalizeWhitespace(s) : null;
  }
  return null;
}

function addressOf(v: unknown): string | null {
  if (typeof v === 'string') return normalizeWhitespace(v) || null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const parts = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']
      .map((k) => propString(o, k))
      .filter((s): s is string => !!s);
    if (parts.length) return parts.join(', ');
    return nameOf(v);
  }
  return null;
}

/**
 * Site-identity signals taken from metadata rather than structured data. Lower
 * confidence, and always labelled with where they came from.
 */
export function extractFromMetadata(page: PageProps): ExtractedEntity[] {
  const siteName = page.openGraph['og:site_name'];
  if (!siteName) return [];
  return [{
    name: normalizeWhitespace(siteName),
    entityType: 'Organization',
    description: page.openGraph['og:description'] ?? null,
    urls: [page.openGraph['og:url'] ? normalizeUrl(page.openGraph['og:url'], page.url) ?? page.url : page.url],
    aliases: [],
    sameAs: [],
    evidence: [observed('metadata.open-graph', page.url, {
      excerpt: `<meta property="og:site_name" content="${truncate(siteName, 80)}">`,
      note: 'Site name declared in Open Graph metadata',
    })],
    origin: 'metadata',
    confidence: 0.6,
    schemaId: null,
    nodeClass: 'Organization',
    sourceUrl: page.url,
    claims: [],
  }];
}

/**
 * Author attribution visible in the page body. Restricted to explicit markup
 * (rel=author, itemprop=author, byline classes) so a name is never guessed out of
 * prose.
 */
export function extractBylines(page: PageProps, html: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const patterns: { re: RegExp; note: string }[] = [
    { re: /rel=["']author["'][^>]*>([^<]{2,80})</gi, note: 'rel="author" link' },
    { re: /itemprop=["']author["'][^>]*>([^<]{2,80})</gi, note: 'itemprop="author" element' },
    { re: /class=["'][^"']*\b(?:author-name|byline__name|post-author)\b[^"']*["'][^>]*>([^<]{2,80})</gi, note: 'byline element' },
  ];
  const seen = new Set<string>();
  for (const { re, note } of patterns) {
    for (const m of html.matchAll(re)) {
      const name = normalizeWhitespace(m[1]).replace(/^(by|written by)\s+/i, '');
      if (!name || name.length < 2 || seen.has(name.toLowerCase())) continue;
      if (/^\d/.test(name) || name.split(/\s+/).length > 6) continue;
      seen.add(name.toLowerCase());
      out.push({
        name,
        entityType: 'Person',
        description: null,
        urls: [page.url],
        aliases: [],
        sameAs: [],
        evidence: [observed('parser.byline', page.url, {
          excerpt: truncate(m[0], 160),
          note: `Author name published in a ${note}`,
        })],
        origin: 'content',
        confidence: 0.7,
        schemaId: null,
        nodeClass: 'Person',
        sourceUrl: page.url,
        claims: [],
      });
    }
  }
  return out;
}
