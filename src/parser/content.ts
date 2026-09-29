import { byTag, classList, textContent, walk, type DomNode } from './dom.js';

/**
 * Main-content detection.
 *
 * Semantic landmarks are trusted first, because a site that marks up <main> has told
 * us where its content is. Only when there is no landmark do we fall back to density
 * scoring, and the result records which method was used so downstream engines can
 * discount low-confidence extractions.
 */

export interface MainContent {
  node: DomNode;
  text: string;
  method: 'main-element' | 'article-element' | 'role-main' | 'density' | 'body';
  confidence: number;
}

const BOILERPLATE_HINTS =
  /(^|[-_ ])(nav|navbar|menu|header|footer|sidebar|aside|widget|breadcrumb|cookie|consent|banner|promo|advert|ads?|social|share|comment|related|pagination|skip|modal|popup|newsletter|subscribe)([-_ ]|$)/i;

export function extractMainContent(doc: DomNode): MainContent {
  const body = byTag(doc, 'body')[0] ?? doc;

  const main = byTag(doc, 'main')[0];
  if (main && textContent(main).length > 120) {
    return { node: main, text: textContent(main), method: 'main-element', confidence: 0.95 };
  }

  const roleMain = firstWhere(doc, (n) => n.attrs['role'] === 'main');
  if (roleMain && textContent(roleMain).length > 120) {
    return { node: roleMain, text: textContent(roleMain), method: 'role-main', confidence: 0.9 };
  }

  const articles = byTag(doc, 'article');
  if (articles.length === 1 && textContent(articles[0]).length > 120) {
    return { node: articles[0], text: textContent(articles[0]), method: 'article-element', confidence: 0.85 };
  }

  const best = densestBlock(body);
  if (best && best.score > 0) {
    return { node: best.node, text: textContent(best.node), method: 'density', confidence: 0.6 };
  }
  return { node: body, text: textContent(body), method: 'body', confidence: 0.35 };
}

function firstWhere(root: DomNode, pred: (n: DomNode) => boolean): DomNode | null {
  let found: DomNode | null = null;
  walk(root, (n) => {
    if (found) return false;
    if (n.type === 'element' && pred(n)) {
      found = n;
      return false;
    }
    return undefined;
  });
  return found;
}

interface Scored { node: DomNode; score: number }

/**
 * Scores candidate containers by paragraph text volume, penalizing link density and
 * boilerplate class names. This is the same intuition as readability extractors, kept
 * small and explainable.
 */
function densestBlock(body: DomNode): Scored | null {
  const candidates: Scored[] = [];
  walk(body, (n) => {
    if (n.type !== 'element') return;
    if (!['div', 'section', 'article', 'td', 'main'].includes(n.tag)) return;

    const text = textContent(n);
    if (text.length < 140) return;

    const paragraphs = byTag(n, 'p').filter((p) => textContent(p).length > 40);
    if (paragraphs.length === 0) return;

    const linkText = byTag(n, 'a').reduce((s, a) => s + textContent(a).length, 0);
    const linkDensity = linkText / Math.max(1, text.length);

    const idClass = `${n.attrs['id'] ?? ''} ${classList(n).join(' ')}`;
    const boilerplate = BOILERPLATE_HINTS.test(idClass) ? 0.25 : 1;

    const commas = (text.match(/,/g) ?? []).length;
    const score =
      (text.length / 100 + paragraphs.length * 3 + commas * 0.5) *
      (1 - Math.min(0.9, linkDensity)) *
      boilerplate;

    candidates.push({ node: n, score });
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  // Prefer the shallowest node within 10% of the best score, so we keep whole
  // articles rather than one dense sub-section of them.
  const top = candidates[0];
  const near = candidates.filter((c) => c.score >= top.score * 0.9);
  near.sort((a, b) => depth(a.node) - depth(b.node));
  return near[0];
}

function depth(n: DomNode): number {
  let d = 0;
  let p = n.parent;
  while (p) {
    d++;
    p = p.parent;
  }
  return d;
}

export function isBoilerplateRegion(n: DomNode): boolean {
  let cur: DomNode | null = n;
  while (cur) {
    if (cur.type === 'element') {
      if (['nav', 'footer', 'header', 'aside'].includes(cur.tag)) return true;
      const role = cur.attrs['role'];
      if (role && ['navigation', 'banner', 'contentinfo', 'complementary'].includes(role)) return true;
      if (BOILERPLATE_HINTS.test(`${cur.attrs['id'] ?? ''} ${classList(cur).join(' ')}`)) return true;
    }
    cur = cur.parent;
  }
  return false;
}
