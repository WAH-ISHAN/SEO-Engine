import type { HeadingNode, ImageRef, LinkRef, SchemaBlock, VideoRef } from '../core/model.js';
import { normalizeUrl, sameSite } from '../core/url.js';
import { normalizeWhitespace } from '../core/text.js';
import { attr, byTag, textContent, walk, type DomNode, parseHtml } from './dom.js';
import { extractMainContent, isBoilerplateRegion, type MainContent } from './content.js';
import { extractStructuredData } from './structured-data.js';
import { contentInInitialHtml, detectFingerprints, type Fingerprint } from './fingerprint.js';

export interface ParsedPage {
  doc: DomNode;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  canonical: string | null;
  canonicalCount: number;
  rawCanonical: string | null;
  robotsMeta: string[];
  lang: string | null;
  headings: HeadingNode[];
  h1s: string[];
  main: MainContent;
  text: string;
  fullText: string;
  links: LinkRef[];
  images: ImageRef[];
  videos: VideoRef[];
  schemas: SchemaBlock[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  hreflang: { lang: string; href: string }[];
  landmarks: string[];
  fingerprints: Fingerprint[];
  viewport: string | null;
  contentInInitialHtml: boolean;
  /** Elements that exist but carry no accessible name, for the accessibility checks. */
  unlabeledControls: number;
  tableCount: number;
  listCount: number;
  /** Definition-style patterns found in main content, used by AEO/AIO. */
  definitionLists: number;
}

export function parsePage(html: string, pageUrl: string, headers: Record<string, string> = {}): ParsedPage {
  const doc = parseHtml(html);
  const head = byTag(doc, 'head')[0] ?? doc;

  const titleEls = byTag(head, 'title');
  const title = titleEls.length ? normalizeWhitespace(textContent(titleEls[0])) || null : null;

  const metas = byTag(doc, 'meta');
  const metaByName = (name: string): string[] =>
    metas
      .filter((m) => (attr(m, 'name') ?? '').toLowerCase() === name)
      .map((m) => attr(m, 'content') ?? '')
      .filter((v) => v !== '');

  const descriptions = metaByName('description');
  const links = byTag(doc, 'link');

  const canonicalEls = links.filter((l) => relTokens(l).includes('canonical'));
  const rawCanonical = canonicalEls.length ? attr(canonicalEls[0], 'href') : null;
  const canonical = rawCanonical ? normalizeUrl(rawCanonical, pageUrl) : null;

  const robotsMeta = metas
    .filter((m) => {
      const n = (attr(m, 'name') ?? '').toLowerCase();
      return n === 'robots' || n === 'googlebot' || n === 'bingbot';
    })
    .flatMap((m) => (attr(m, 'content') ?? '').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const htmlEl = byTag(doc, 'html')[0];
  const lang = htmlEl ? attr(htmlEl, 'lang') : null;

  const main = extractMainContent(doc);
  const mainText = normalizeWhitespace(main.text);
  const fullText = normalizeWhitespace(textContent(byTag(doc, 'body')[0] ?? doc));

  const headings = extractHeadings(doc);
  const h1s = byTag(doc, 'h1').map((h) => normalizeWhitespace(textContent(h))).filter(Boolean);

  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  for (const m of metas) {
    const property = (attr(m, 'property') ?? attr(m, 'name') ?? '').toLowerCase();
    const content = attr(m, 'content');
    if (!property || content === null) continue;
    if (property.startsWith('og:') || property.startsWith('article:') || property.startsWith('product:')) {
      if (openGraph[property] === undefined) openGraph[property] = content;
    } else if (property.startsWith('twitter:')) {
      if (twitter[property] === undefined) twitter[property] = content;
    }
  }

  const hreflang = links
    .filter((l) => relTokens(l).includes('alternate') && attr(l, 'hreflang'))
    .map((l) => ({ lang: attr(l, 'hreflang')!, href: normalizeUrl(attr(l, 'href') ?? '', pageUrl) ?? '' }))
    .filter((x) => x.href !== '');

  const landmarks = [...new Set(
    byTag(doc, 'header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'figure', 'figcaption', 'time')
      .map((n) => n.tag),
  )].sort();

  const viewportEls = metaByName('viewport');
  const fingerprints = detectFingerprints(html, doc, headers);

  return {
    doc,
    title,
    titleCount: titleEls.length,
    metaDescription: descriptions[0] ? normalizeWhitespace(descriptions[0]) : null,
    metaDescriptionCount: descriptions.length,
    canonical,
    canonicalCount: canonicalEls.length,
    rawCanonical,
    robotsMeta,
    lang,
    headings,
    h1s,
    main,
    text: mainText,
    fullText,
    links: extractLinks(doc, pageUrl),
    images: extractImages(doc, pageUrl, main.node),
    videos: extractVideos(doc, pageUrl),
    schemas: extractStructuredData(doc),
    openGraph,
    twitter,
    hreflang,
    landmarks,
    fingerprints,
    viewport: viewportEls[0] ?? null,
    contentInInitialHtml: contentInInitialHtml(doc, mainText),
    unlabeledControls: countUnlabeledControls(doc),
    tableCount: byTag(doc, 'table').length,
    listCount: byTag(doc, 'ul', 'ol').length,
    definitionLists: byTag(doc, 'dl').length,
  };
}

function relTokens(n: DomNode): string[] {
  return (attr(n, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Flat heading list with parent pointers, so the outline can be checked for skipped
 * levels without reconstructing a tree at every call site.
 */
function extractHeadings(doc: DomNode): HeadingNode[] {
  const out: HeadingNode[] = [];
  const stack: { level: number; index: number }[] = [];
  walk(doc, (n) => {
    if (n.type !== 'element') return;
    const m = /^h([1-6])$/.exec(n.tag);
    if (!m) return;
    const level = Number(m[1]);
    const text = normalizeWhitespace(textContent(n));
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].index : null;
    out.push({ level, text, parent });
    stack.push({ level, index: out.length - 1 });
  });
  return out;
}

function extractLinks(doc: DomNode, pageUrl: string): LinkRef[] {
  const out: LinkRef[] = [];
  const seen = new Set<string>();
  for (const a of byTag(doc, 'a')) {
    const rawHref = attr(a, 'href');
    if (!rawHref) continue;
    const trimmed = rawHref.trim();
    if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript|data|sms):/i.test(trimmed)) continue;
    const href = normalizeUrl(trimmed, pageUrl);
    if (!href) continue;
    const rel = relTokens(a);
    const anchor = normalizeWhitespace(textContent(a)) || normalizeWhitespace(attr(a, 'aria-label') ?? '') ||
      normalizeWhitespace(imageAltInside(a)) || '';
    const key = `${href}|${anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      href,
      rawHref: trimmed,
      anchor,
      rel,
      internal: sameSite(href, pageUrl),
      inMainContent: !isBoilerplateRegion(a),
      nofollow: rel.includes('nofollow') || rel.includes('sponsored') || rel.includes('ugc'),
    });
  }
  return out;
}

function imageAltInside(a: DomNode): string {
  const img = byTag(a, 'img')[0];
  return img ? attr(img, 'alt') ?? '' : '';
}

function extractImages(doc: DomNode, pageUrl: string, mainNode: DomNode): ImageRef[] {
  const mainSet = new Set<DomNode>();
  walk(mainNode, (n) => {
    mainSet.add(n);
  });
  const out: ImageRef[] = [];
  for (const img of byTag(doc, 'img')) {
    const rawSrc = attr(img, 'src') ?? attr(img, 'data-src') ?? firstSrcFromSrcset(attr(img, 'srcset'));
    if (!rawSrc) continue;
    const src = normalizeUrl(rawSrc, pageUrl) ?? rawSrc;
    out.push({
      src,
      alt: attr(img, 'alt'),
      width: numAttr(img, 'width'),
      height: numAttr(img, 'height'),
      loading: attr(img, 'loading'),
      inMainContent: mainSet.has(img),
    });
  }
  return out;
}

function firstSrcFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

function numAttr(n: DomNode, name: string): number | null {
  const v = attr(n, name);
  if (!v) return null;
  const num = Number.parseInt(v, 10);
  return Number.isFinite(num) ? num : null;
}

function extractVideos(doc: DomNode, pageUrl: string): VideoRef[] {
  const out: VideoRef[] = [];
  for (const v of byTag(doc, 'video')) {
    const src = attr(v, 'src') ?? (byTag(v, 'source')[0] ? attr(byTag(v, 'source')[0], 'src') : null);
    if (src) out.push({ src: normalizeUrl(src, pageUrl) ?? src, kind: 'video', title: attr(v, 'title') });
  }
  for (const f of byTag(doc, 'iframe')) {
    const src = attr(f, 'src');
    if (!src) continue;
    if (!/(youtube|youtu\.be|vimeo|wistia|loom|dailymotion)/i.test(src)) continue;
    out.push({ src: normalizeUrl(src, pageUrl) ?? src, kind: 'iframe', title: attr(f, 'title') });
  }
  return out;
}

function countUnlabeledControls(doc: DomNode): number {
  let n = 0;
  for (const el of byTag(doc, 'input', 'select', 'textarea', 'button')) {
    const type = (attr(el, 'type') ?? '').toLowerCase();
    if (el.tag === 'input' && ['hidden', 'submit', 'button', 'image'].includes(type)) continue;
    const hasName =
      !!attr(el, 'aria-label') ||
      !!attr(el, 'aria-labelledby') ||
      !!attr(el, 'title') ||
      (el.tag === 'button' && normalizeWhitespace(textContent(el)).length > 0) ||
      !!attr(el, 'placeholder');
    const id = attr(el, 'id');
    const hasLabel = id
      ? byTag(doc, 'label').some((l) => attr(l, 'for') === id)
      : !!el.parent && el.parent.tag === 'label';
    if (!hasName && !hasLabel) n++;
  }
  return n;
}
