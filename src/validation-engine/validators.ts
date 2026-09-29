import type { PageProps, ValidationCheck, ValidationStatus } from '../core/model.js';
import type { ParsedPage } from '../parser/page.js';
import { normalizeType } from '../parser/structured-data.js';
import { truncate } from '../core/text.js';

/**
 * The validator registry.
 *
 * Every recommendation names a validation rule, and every rule is implemented here.
 * That correspondence is enforced: a recommendation whose rule has no validator cannot
 * claim its fix was verified, because nothing checked it.
 */

export interface ValidationSubject {
  url: string;
  page: PageProps | null;
  parsed: ParsedPage | null;
  /** Raw response facts, available even when the page did not parse as HTML. */
  status: number;
  headers: Record<string, string>;
  redirectChain: string[];
  networkError: string | null;
  /** Site-level facts, for rules that are not about a single page. */
  site: {
    robotsStatus: number | null;
    robotsBody: string;
    sitemapUrls: string[];
    internalLinkTargets: Map<string, number>;
  };
}

export type Validator = (subject: ValidationSubject, expected?: unknown) => ValidationCheck;

const pass = (rule: string, message: string, extra: Partial<ValidationCheck> = {}): ValidationCheck =>
  ({ rule, status: 'PASS', message, ...extra });
const warn = (rule: string, message: string, extra: Partial<ValidationCheck> = {}): ValidationCheck =>
  ({ rule, status: 'WARNING', message, ...extra });
const fail = (rule: string, message: string, extra: Partial<ValidationCheck> = {}): ValidationCheck =>
  ({ rule, status: 'FAIL', message, ...extra });

export const VALIDATORS: Record<string, Validator> = {
  'VALIDATE.HTTP_STATUS': (s) => {
    if (s.networkError) return fail('VALIDATE.HTTP_STATUS', `Request failed: ${s.networkError}`, { actual: 0 });
    if (s.status >= 200 && s.status < 300) return pass('VALIDATE.HTTP_STATUS', `HTTP ${s.status}`, { actual: s.status });
    if (s.status >= 300 && s.status < 400) {
      return warn('VALIDATE.HTTP_STATUS', `HTTP ${s.status}: the URL redirects`, { actual: s.status });
    }
    return fail('VALIDATE.HTTP_STATUS', `HTTP ${s.status}`, { expected: 200, actual: s.status });
  },

  'VALIDATE.TITLE_PRESENT': (s) => {
    const t = s.page?.title;
    if (!t) return fail('VALIDATE.TITLE_PRESENT', 'No non-empty <title> is served.', { actual: null });
    return pass('VALIDATE.TITLE_PRESENT', `Title present: "${truncate(t, 70)}"`, { actual: t });
  },

  'VALIDATE.TITLE_LENGTH': (s) => {
    const t = s.page?.title;
    if (!t) return fail('VALIDATE.TITLE_LENGTH', 'No title to measure.', { actual: null });
    if (t.length >= 15 && t.length <= 65) {
      return pass('VALIDATE.TITLE_LENGTH', `Title is ${t.length} characters.`, { actual: t.length });
    }
    return warn('VALIDATE.TITLE_LENGTH', `Title is ${t.length} characters, outside 15-65.`, { actual: t.length });
  },

  'VALIDATE.TITLE_UNIQUE': (s, expected) => {
    // Uniqueness is a site-level property, checked by the caller supplying the set of
    // other titles; without it the check reports honestly that it could not run.
    const others = Array.isArray(expected) ? (expected as string[]) : null;
    const t = s.page?.title;
    if (!t) return fail('VALIDATE.TITLE_UNIQUE', 'No title to compare.', { actual: null });
    if (!others) return warn('VALIDATE.TITLE_UNIQUE', 'Other page titles were not supplied, so uniqueness was not checked.');
    const clash = others.filter((o) => o.trim().toLowerCase() === t.trim().toLowerCase()).length;
    return clash === 0
      ? pass('VALIDATE.TITLE_UNIQUE', 'Title is unique across the crawled pages.', { actual: t })
      : fail('VALIDATE.TITLE_UNIQUE', `Title is shared with ${clash} other page(s).`, { actual: t });
  },

  'VALIDATE.DESCRIPTION_PRESENT': (s) => {
    const d = s.page?.metaDescription;
    return d
      ? pass('VALIDATE.DESCRIPTION_PRESENT', `Description present (${d.length} characters).`, { actual: d })
      : fail('VALIDATE.DESCRIPTION_PRESENT', 'No meta description is served.', { actual: null });
  },

  'VALIDATE.DESCRIPTION_LENGTH': (s) => {
    const d = s.page?.metaDescription;
    if (!d) return fail('VALIDATE.DESCRIPTION_LENGTH', 'No description to measure.', { actual: null });
    return d.length >= 70 && d.length <= 165
      ? pass('VALIDATE.DESCRIPTION_LENGTH', `Description is ${d.length} characters.`, { actual: d.length })
      : warn('VALIDATE.DESCRIPTION_LENGTH', `Description is ${d.length} characters, outside 70-165.`, { actual: d.length });
  },

  'VALIDATE.DESCRIPTION_UNIQUE': (s, expected) => {
    const others = Array.isArray(expected) ? (expected as string[]) : null;
    const d = s.page?.metaDescription;
    if (!d) return fail('VALIDATE.DESCRIPTION_UNIQUE', 'No description to compare.', { actual: null });
    if (!others) return warn('VALIDATE.DESCRIPTION_UNIQUE', 'Other descriptions were not supplied; uniqueness not checked.');
    const clash = others.filter((o) => o.trim().toLowerCase() === d.trim().toLowerCase()).length;
    return clash === 0
      ? pass('VALIDATE.DESCRIPTION_UNIQUE', 'Description is unique.', { actual: d })
      : fail('VALIDATE.DESCRIPTION_UNIQUE', `Description is shared with ${clash} other page(s).`);
  },

  'VALIDATE.CANONICAL_PRESENT': (s) => {
    const c = s.page?.canonical;
    if (!c) return fail('VALIDATE.CANONICAL_PRESENT', 'No rel=canonical is served.', { actual: null });
    return c === s.url
      ? pass('VALIDATE.CANONICAL_PRESENT', 'Self-referencing canonical present.', { actual: c })
      : warn('VALIDATE.CANONICAL_PRESENT', `Canonical points elsewhere: ${c}`, { actual: c });
  },

  'VALIDATE.SINGLE_CANONICAL': (s) => {
    const n = s.parsed?.canonicalCount ?? 0;
    if (n === 1) return pass('VALIDATE.SINGLE_CANONICAL', 'Exactly one canonical link element.', { actual: n });
    if (n === 0) return fail('VALIDATE.SINGLE_CANONICAL', 'No canonical link element.', { actual: 0 });
    return fail('VALIDATE.SINGLE_CANONICAL', `${n} canonical link elements on one page.`, { expected: 1, actual: n });
  },

  'VALIDATE.CANONICAL_TARGET_OK': (s, expected) => {
    const targetStatus = typeof expected === 'number' ? expected : null;
    const c = s.page?.canonical;
    if (!c) return fail('VALIDATE.CANONICAL_TARGET_OK', 'No canonical to check.');
    if (targetStatus === null) {
      return warn('VALIDATE.CANONICAL_TARGET_OK', `Canonical target ${c} was not re-fetched, so its status is unknown.`);
    }
    return targetStatus >= 200 && targetStatus < 300
      ? pass('VALIDATE.CANONICAL_TARGET_OK', `Canonical target returns HTTP ${targetStatus}.`, { actual: targetStatus })
      : fail('VALIDATE.CANONICAL_TARGET_OK', `Canonical target returns HTTP ${targetStatus}.`, { expected: 200, actual: targetStatus });
  },

  'VALIDATE.ROBOTS_META_MATCHES_INTENT': (s, expected) => {
    const shouldIndex = expected !== false;
    const robots = s.page?.robotsMeta ?? [];
    const noindex = robots.includes('noindex') || robots.includes('none') || (s.page?.xRobotsTag ?? []).includes('noindex');
    if (shouldIndex && noindex) {
      return fail('VALIDATE.ROBOTS_META_MATCHES_INTENT', 'Page is still marked noindex.', { actual: robots });
    }
    if (!shouldIndex && !noindex) {
      return fail('VALIDATE.ROBOTS_META_MATCHES_INTENT', 'Page is not marked noindex as intended.', { actual: robots });
    }
    return pass('VALIDATE.ROBOTS_META_MATCHES_INTENT', `Indexing directives match intent (${robots.join(', ') || 'no directives'}).`);
  },

  'VALIDATE.ROBOTS_DIRECTIVES_AGREE': (s) => {
    const meta = s.page?.robotsMeta ?? [];
    const header = s.page?.xRobotsTag ?? [];
    const conflict =
      (meta.includes('index') && header.includes('noindex')) ||
      (meta.includes('noindex') && header.includes('index'));
    return conflict
      ? fail('VALIDATE.ROBOTS_DIRECTIVES_AGREE', `Meta says [${meta.join(', ')}], header says [${header.join(', ')}].`)
      : pass('VALIDATE.ROBOTS_DIRECTIVES_AGREE', 'Robots meta tag and header agree.');
  },

  'VALIDATE.ROBOTS_TXT_200': (s) =>
    s.site.robotsStatus === 200
      ? pass('VALIDATE.ROBOTS_TXT_200', 'robots.txt returns HTTP 200.', { actual: 200 })
      : fail('VALIDATE.ROBOTS_TXT_200', `robots.txt returns HTTP ${s.site.robotsStatus ?? 'nothing'}.`, { expected: 200, actual: s.site.robotsStatus }),

  'VALIDATE.ROBOTS_REFERENCES_SITEMAP': (s) =>
    /^\s*sitemap\s*:/im.test(s.site.robotsBody)
      ? pass('VALIDATE.ROBOTS_REFERENCES_SITEMAP', 'robots.txt contains a Sitemap directive.')
      : fail('VALIDATE.ROBOTS_REFERENCES_SITEMAP', 'robots.txt contains no Sitemap directive.'),

  'VALIDATE.ROBOTS_ALLOWS_URLS': (s, expected) => {
    const allowed = expected === true;
    return allowed
      ? pass('VALIDATE.ROBOTS_ALLOWS_URLS', 'The URL is crawlable under the current robots.txt.')
      : fail('VALIDATE.ROBOTS_ALLOWS_URLS', 'The URL is still disallowed by robots.txt.');
  },

  'VALIDATE.SITEMAP_REACHABLE': (s) =>
    s.site.sitemapUrls.length > 0
      ? pass('VALIDATE.SITEMAP_REACHABLE', `A sitemap listing ${s.site.sitemapUrls.length} URL(s) is reachable.`, { actual: s.site.sitemapUrls.length })
      : fail('VALIDATE.SITEMAP_REACHABLE', 'No reachable sitemap with entries.'),

  'VALIDATE.SITEMAP_COVERS_INDEXABLE': (s) =>
    s.site.sitemapUrls.includes(s.url)
      ? pass('VALIDATE.SITEMAP_COVERS_INDEXABLE', 'The URL is listed in the sitemap.')
      : fail('VALIDATE.SITEMAP_COVERS_INDEXABLE', 'The URL is still absent from the sitemap.'),

  'VALIDATE.SITEMAP_ENTRIES_CLEAN': (s) => {
    if (!s.site.sitemapUrls.includes(s.url)) {
      return pass('VALIDATE.SITEMAP_ENTRIES_CLEAN', 'The URL is no longer listed in the sitemap.');
    }
    if (s.status >= 200 && s.status < 300 && (!s.page?.canonical || s.page.canonical === s.url)) {
      return pass('VALIDATE.SITEMAP_ENTRIES_CLEAN', 'The listed URL is a canonical HTTP 200 page.');
    }
    return fail(
      'VALIDATE.SITEMAP_ENTRIES_CLEAN',
      `The URL is listed but returns HTTP ${s.status}` +
        (s.page?.canonical && s.page.canonical !== s.url ? ` and canonicalizes to ${s.page.canonical}` : '') + '.',
    );
  },

  'VALIDATE.H1_PRESENT': (s) => {
    const n = s.page?.h1s.length ?? 0;
    return n >= 1
      ? pass('VALIDATE.H1_PRESENT', `H1 present: "${truncate(s.page!.h1s[0], 60)}"`, { actual: n })
      : fail('VALIDATE.H1_PRESENT', 'No H1 on the page.', { expected: 1, actual: 0 });
  },

  'VALIDATE.H1_SINGLE': (s) => {
    const n = s.page?.h1s.length ?? 0;
    if (n === 1) return pass('VALIDATE.H1_SINGLE', 'Exactly one H1.', { actual: 1 });
    if (n === 0) return fail('VALIDATE.H1_SINGLE', 'No H1 on the page.', { expected: 1, actual: 0 });
    return warn('VALIDATE.H1_SINGLE', `${n} H1 elements on the page.`, { expected: 1, actual: n });
  },

  'VALIDATE.HEADING_ORDER': (s) => {
    const headings = s.page?.headings ?? [];
    let prev = 0;
    for (const h of headings) {
      if (prev !== 0 && h.level > prev + 1) {
        return warn('VALIDATE.HEADING_ORDER', `Heading level jumps from h${prev} to h${h.level}.`);
      }
      prev = h.level;
    }
    return pass('VALIDATE.HEADING_ORDER', 'Heading levels descend without skipping.');
  },

  'VALIDATE.LANG_PRESENT': (s) =>
    s.page?.lang
      ? pass('VALIDATE.LANG_PRESENT', `lang="${s.page.lang}"`, { actual: s.page.lang })
      : fail('VALIDATE.LANG_PRESENT', 'No lang attribute on <html>.'),

  'VALIDATE.VIEWPORT_PRESENT': (s) =>
    s.page?.mobileViewport
      ? pass('VALIDATE.VIEWPORT_PRESENT', `viewport="${s.page.mobileViewport}"`, { actual: s.page.mobileViewport })
      : fail('VALIDATE.VIEWPORT_PRESENT', 'No viewport meta tag.'),

  'VALIDATE.OPEN_GRAPH_PRESENT': (s) => {
    const og = s.page?.openGraph ?? {};
    const required = ['og:title', 'og:description'];
    const missing = required.filter((k) => !og[k]);
    return missing.length === 0
      ? pass('VALIDATE.OPEN_GRAPH_PRESENT', 'Open Graph title and description present.')
      : fail('VALIDATE.OPEN_GRAPH_PRESENT', `Missing: ${missing.join(', ')}.`, { actual: Object.keys(og) });
  },

  'VALIDATE.MAIN_LANDMARK': (s) =>
    s.page?.landmarks.includes('main')
      ? pass('VALIDATE.MAIN_LANDMARK', 'A <main> landmark is present.')
      : fail('VALIDATE.MAIN_LANDMARK', 'No <main> landmark.', { actual: s.page?.landmarks }),

  'VALIDATE.SEMANTIC_ELEMENTS': (s) => {
    const marks = s.page?.landmarks ?? [];
    const semantic = ['main', 'article', 'section', 'header', 'footer', 'nav'].filter((l) => marks.includes(l));
    return semantic.length >= 2
      ? pass('VALIDATE.SEMANTIC_ELEMENTS', `Semantic elements present: ${semantic.join(', ')}.`)
      : fail('VALIDATE.SEMANTIC_ELEMENTS', `Only ${semantic.length} semantic element type(s) present.`, { actual: marks });
  },

  'VALIDATE.CONTENT_IN_HTML': (s) =>
    s.page?.contentInInitialHtml
      ? pass('VALIDATE.CONTENT_IN_HTML', `${s.page.wordCount} words present in the server response.`, { actual: s.page.wordCount })
      : fail('VALIDATE.CONTENT_IN_HTML', 'The served HTML still contains almost no content.'),

  'VALIDATE.IMAGE_ALT': (s) => {
    const imgs = s.page?.images ?? [];
    const missing = imgs.filter((i) => i.alt === null);
    return missing.length === 0
      ? pass('VALIDATE.IMAGE_ALT', `All ${imgs.length} image(s) declare an alt attribute.`)
      : fail('VALIDATE.IMAGE_ALT', `${missing.length} of ${imgs.length} images have no alt attribute.`, { actual: missing.length });
  },

  'VALIDATE.IMAGE_DIMENSIONS': (s) => {
    const imgs = (s.page?.images ?? []).filter((i) => i.inMainContent);
    const missing = imgs.filter((i) => i.width === null || i.height === null);
    return missing.length === 0
      ? pass('VALIDATE.IMAGE_DIMENSIONS', 'All main-content images declare dimensions.')
      : warn('VALIDATE.IMAGE_DIMENSIONS', `${missing.length} main-content image(s) lack dimensions.`, { actual: missing.length });
  },

  'VALIDATE.CONTROL_LABELS': (s) => {
    const n = s.parsed?.unlabeledControls ?? 0;
    return n === 0
      ? pass('VALIDATE.CONTROL_LABELS', 'Every form control has an accessible name.')
      : fail('VALIDATE.CONTROL_LABELS', `${n} control(s) have no accessible name.`, { actual: n });
  },

  'VALIDATE.SCHEMA_PARSES': (s) => {
    const broken = (s.page?.schemas ?? []).filter((x) => x.parseError);
    return broken.length === 0
      ? pass('VALIDATE.SCHEMA_PARSES', 'All structured-data blocks parse.')
      : fail('VALIDATE.SCHEMA_PARSES', `${broken.length} block(s) fail to parse: ${broken[0].parseError}`, { actual: broken.length });
  },

  'VALIDATE.PAGE_HAS_SCHEMA': (s) => {
    const valid = (s.page?.schemas ?? []).filter((x) => !x.parseError && x.types.length > 0);
    return valid.length > 0
      ? pass('VALIDATE.PAGE_HAS_SCHEMA', `Types declared: ${valid.flatMap((v) => v.types).join(', ')}.`)
      : fail('VALIDATE.PAGE_HAS_SCHEMA', 'No valid structured data on the page.');
  },

  'VALIDATE.SCHEMA_TYPE_PRESENT': (s, expected) => {
    const type = typeof expected === 'string' ? expected : null;
    const types = (s.page?.schemas ?? []).flatMap((x) => x.types.map(normalizeType));
    if (!type) {
      return types.length
        ? pass('VALIDATE.SCHEMA_TYPE_PRESENT', `Types present: ${types.join(', ')}.`)
        : fail('VALIDATE.SCHEMA_TYPE_PRESENT', 'No structured-data types present.');
    }
    return types.includes(type)
      ? pass('VALIDATE.SCHEMA_TYPE_PRESENT', `${type} is declared.`, { expected: type, actual: types })
      : fail('VALIDATE.SCHEMA_TYPE_PRESENT', `${type} is not declared.`, { expected: type, actual: types });
  },

  'VALIDATE.SCHEMA_REQUIRED_PROPERTIES': (s, expected) => {
    const spec = expected as { type: string; props: string[] } | undefined;
    if (!spec) return warn('VALIDATE.SCHEMA_REQUIRED_PROPERTIES', 'No property expectation was supplied.');
    const blocks = (s.page?.schemas ?? []).filter((b) => b.types.map(normalizeType).includes(spec.type));
    if (blocks.length === 0) {
      return fail('VALIDATE.SCHEMA_REQUIRED_PROPERTIES', `No ${spec.type} block on the page.`);
    }
    const missing = spec.props.filter((p) =>
      blocks.every((b) => {
        const o = b.raw as Record<string, unknown>;
        return !o || o[p] === undefined || o[p] === null || o[p] === '';
      }));
    return missing.length === 0
      ? pass('VALIDATE.SCHEMA_REQUIRED_PROPERTIES', `${spec.type} declares ${spec.props.join(', ')}.`)
      : fail('VALIDATE.SCHEMA_REQUIRED_PROPERTIES', `${spec.type} still omits: ${missing.join(', ')}.`, { actual: missing });
  },

  'VALIDATE.SCHEMA_MATCHES_CONTENT': (s) => {
    const page = s.page;
    if (!page) return fail('VALIDATE.SCHEMA_MATCHES_CONTENT', 'The page could not be parsed.');
    const visible = `${page.text} ${page.title ?? ''} ${page.h1s.join(' ')}`.toLowerCase();
    const mismatches: string[] = [];
    for (const block of page.schemas) {
      if (block.parseError || !block.raw || typeof block.raw !== 'object') continue;
      const obj = block.raw as Record<string, unknown>;
      const questions = Array.isArray(obj.mainEntity) ? obj.mainEntity : [];
      for (const q of questions) {
        const name = q && typeof q === 'object' ? (q as Record<string, unknown>).name : null;
        if (typeof name === 'string' && !visible.includes(name.toLowerCase().slice(0, Math.min(30, name.length)))) {
          mismatches.push(truncate(name, 60));
        }
      }
    }
    return mismatches.length === 0
      ? pass('VALIDATE.SCHEMA_MATCHES_CONTENT', 'Structured data matches the visible content.')
      : fail('VALIDATE.SCHEMA_MATCHES_CONTENT', `Markup asserts content not on the page: ${mismatches.slice(0, 3).join('; ')}.`, { actual: mismatches.length });
  },

  'VALIDATE.SCHEMA_NO_DUPLICATE_SINGLETONS': (s) => {
    const counts = new Map<string, number>();
    for (const b of s.page?.schemas ?? []) {
      for (const t of b.types.map(normalizeType)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const dupes = [...counts.entries()].filter(([t, n]) =>
      n > 1 && ['WebSite', 'BreadcrumbList', 'FAQPage', 'Organization', 'LocalBusiness'].includes(t));
    return dupes.length === 0
      ? pass('VALIDATE.SCHEMA_NO_DUPLICATE_SINGLETONS', 'No singleton type is duplicated.')
      : fail('VALIDATE.SCHEMA_NO_DUPLICATE_SINGLETONS', `Duplicated: ${dupes.map(([t, n]) => `${t} x${n}`).join(', ')}.`);
  },

  'VALIDATE.ORGANIZATION_SCHEMA_PRESENT': (s) => {
    const types = (s.page?.schemas ?? []).flatMap((b) => b.types.map(normalizeType));
    const has = types.some((t) => t === 'Organization' || t === 'LocalBusiness' || t === 'Corporation');
    return has
      ? pass('VALIDATE.ORGANIZATION_SCHEMA_PRESENT', 'An Organization entity is declared.')
      : fail('VALIDATE.ORGANIZATION_SCHEMA_PRESENT', 'No Organization entity is declared.', { actual: types });
  },

  'VALIDATE.INTERNAL_LINKS_RESOLVE': (s, expected) => {
    const brokenTargets = Array.isArray(expected) ? (expected as string[]) : [];
    const links = (s.page?.links ?? []).filter((l) => l.internal).map((l) => l.href);
    const stillBroken = links.filter((l) => brokenTargets.includes(l));
    return stillBroken.length === 0
      ? pass('VALIDATE.INTERNAL_LINKS_RESOLVE', 'No links to known-broken URLs remain on this page.')
      : fail('VALIDATE.INTERNAL_LINKS_RESOLVE', `${stillBroken.length} link(s) still point at broken URLs.`, { actual: stillBroken });
  },

  'VALIDATE.INTERNAL_LINKS_DIRECT': (s, expected) => {
    const redirectingTargets = Array.isArray(expected) ? (expected as string[]) : [];
    const links = (s.page?.links ?? []).filter((l) => l.internal).map((l) => l.href);
    const viaRedirect = links.filter((l) => redirectingTargets.includes(l));
    return viaRedirect.length === 0
      ? pass('VALIDATE.INTERNAL_LINKS_DIRECT', 'All internal links point at final URLs.')
      : warn('VALIDATE.INTERNAL_LINKS_DIRECT', `${viaRedirect.length} link(s) still resolve via a redirect.`, { actual: viaRedirect });
  },

  'VALIDATE.INTERNAL_LINK_EXISTS': (s, expected) => {
    const target = typeof expected === 'string' ? expected : null;
    if (!target) return warn('VALIDATE.INTERNAL_LINK_EXISTS', 'No target URL was supplied to check for.');
    const found = (s.page?.links ?? []).some((l) => l.href === target);
    return found
      ? pass('VALIDATE.INTERNAL_LINK_EXISTS', `A link to ${target} is present.`, { expected: target })
      : fail('VALIDATE.INTERNAL_LINK_EXISTS', `No link to ${target} on this page.`, { expected: target });
  },

  'VALIDATE.PAGE_HAS_INLINKS': (s) => {
    const n = s.site.internalLinkTargets.get(s.url) ?? 0;
    return n > 0
      ? pass('VALIDATE.PAGE_HAS_INLINKS', `${n} internal link(s) point here.`, { actual: n })
      : fail('VALIDATE.PAGE_HAS_INLINKS', 'Still no inbound internal links.', { expected: '>=1', actual: 0 });
  },

  'VALIDATE.PAGE_INLINK_COUNT': (s) => {
    const n = s.site.internalLinkTargets.get(s.url) ?? 0;
    if (n >= 2) return pass('VALIDATE.PAGE_INLINK_COUNT', `${n} inbound internal links.`, { actual: n });
    if (n === 1) return warn('VALIDATE.PAGE_INLINK_COUNT', 'Only one inbound internal link.', { actual: 1 });
    return fail('VALIDATE.PAGE_INLINK_COUNT', 'No inbound internal links.', { actual: 0 });
  },

  'VALIDATE.ANCHOR_DESCRIPTIVE': (s) => {
    const generic = (s.page?.links ?? []).filter((l) =>
      l.internal && ['click here', 'here', 'read more', 'learn more', 'more'].includes(l.anchor.trim().toLowerCase()));
    return generic.length === 0
      ? pass('VALIDATE.ANCHOR_DESCRIPTIVE', 'No generic anchor text on this page.')
      : warn('VALIDATE.ANCHOR_DESCRIPTIVE', `${generic.length} generic anchor(s) remain.`, { actual: generic.length });
  },

  'VALIDATE.ANCHOR_HAS_NAME': (s) => {
    const empty = (s.page?.links ?? []).filter((l) => l.anchor.trim().length === 0);
    return empty.length === 0
      ? pass('VALIDATE.ANCHOR_HAS_NAME', 'Every link has an accessible name.')
      : fail('VALIDATE.ANCHOR_HAS_NAME', `${empty.length} link(s) have no accessible name.`, { actual: empty.length });
  },

  'VALIDATE.REDIRECT_HOPS': (s) => {
    const hops = s.redirectChain.length;
    if (hops === 0) return pass('VALIDATE.REDIRECT_HOPS', 'The URL resolves without redirecting.', { actual: 0 });
    if (hops === 1) return pass('VALIDATE.REDIRECT_HOPS', 'The URL redirects in a single hop.', { actual: 1 });
    return fail('VALIDATE.REDIRECT_HOPS', `${hops} redirect hops.`, { expected: '<=1', actual: hops });
  },

  'VALIDATE.NO_MIXED_CONTENT': (s) => {
    if (!s.url.startsWith('https://')) return pass('VALIDATE.NO_MIXED_CONTENT', 'Not an HTTPS page.');
    const insecure = [
      ...(s.page?.images ?? []).map((i) => i.src),
      ...(s.page?.videos ?? []).map((v) => v.src),
    ].filter((u) => u.startsWith('http://'));
    return insecure.length === 0
      ? pass('VALIDATE.NO_MIXED_CONTENT', 'No insecure subresources.')
      : fail('VALIDATE.NO_MIXED_CONTENT', `${insecure.length} insecure subresource(s).`, { actual: insecure.slice(0, 3) });
  },

  'VALIDATE.WORD_COUNT': (s) => {
    const n = s.page?.wordCount ?? 0;
    return n >= 200
      ? pass('VALIDATE.WORD_COUNT', `${n} words of main content.`, { actual: n })
      : warn('VALIDATE.WORD_COUNT', `${n} words of main content.`, { expected: '>=200', actual: n });
  },

  'VALIDATE.RESPONSE_TIME': (s) => {
    const ms = s.page?.responseTimeMs ?? 0;
    if (ms === 0) return warn('VALIDATE.RESPONSE_TIME', 'No timing was recorded.');
    return ms <= 1500
      ? pass('VALIDATE.RESPONSE_TIME', `Responded in ${ms}ms.`, { actual: ms })
      : warn('VALIDATE.RESPONSE_TIME', `Responded in ${ms}ms.`, { expected: '<=1500', actual: ms });
  },

  'VALIDATE.PAGE_WEIGHT': (s) => {
    const bytes = s.page?.bytes ?? 0;
    return bytes <= 1_500_000
      ? pass('VALIDATE.PAGE_WEIGHT', `${(bytes / 1024).toFixed(0)} KB of HTML.`, { actual: bytes })
      : warn('VALIDATE.PAGE_WEIGHT', `${(bytes / 1_048_576).toFixed(2)} MB of HTML.`, { actual: bytes });
  },
};

/**
 * Rules that describe a condition rather than a single verifiable page property.
 * They are declared explicitly so that "no validator" always means "not implemented"
 * rather than "silently unchecked".
 */
export const ADVISORY_RULES = new Set([
  'VALIDATE.URL_SHAPE', 'VALIDATE.DUPLICATE_RESOLVED', 'VALIDATE.QUESTIONS_ANSWERED',
  'VALIDATE.ANSWER_LEADS', 'VALIDATE.DEFINITION_PRESENT', 'VALIDATE.SUBHEADINGS_PRESENT',
  'VALIDATE.CITATION_PRESENT', 'VALIDATE.CITATION_RATE', 'VALIDATE.SUBJECT_NAMED',
  'VALIDATE.AUTHOR_PRESENT', 'VALIDATE.AUTHOR_HAS_BIO', 'VALIDATE.DATES_PRESENT',
  'VALIDATE.ENTITY_HAS_DESCRIPTION', 'VALIDATE.ENTITY_SAMEAS', 'VALIDATE.ENTITY_TARGETS_RESOLVE',
  'VALIDATE.TOPIC_DEPTH', 'VALIDATE.TOPIC_CONNECTIVITY', 'VALIDATE.ORIGINALITY_MARKERS',
  'VALIDATE.COMPARISON_PRESENT', 'VALIDATE.BRAND_NAME_CONSISTENT', 'VALIDATE.PERSON_ENTITY_PRESENT',
  'VALIDATE.ANCHOR_DIVERSITY', 'VALIDATE.SECTION_INLINKS', 'VALIDATE.CLICK_DEPTH',
  'VALIDATE.REACHABLE_FROM_HOME', 'VALIDATE.SCHEMA_VALUE_FORMATS', 'VALIDATE.SCHEMA_CONNECTED',
  'VALIDATE.SCHEMA_RECOMMENDED_PROPERTIES',
]);

export function worstStatus(checks: ValidationCheck[]): ValidationStatus {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'WARNING')) return 'WARNING';
  return 'PASS';
}
