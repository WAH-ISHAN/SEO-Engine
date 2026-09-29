import { byTag, rawText, type DomNode } from './dom.js';

/**
 * Detects the SEO/CMS machinery a site already runs.
 *
 * This exists to satisfy the platform's first rule: never rebuild or overwrite
 * something the site already implements. Recommendations consult these fingerprints
 * before proposing how a fix should be delivered.
 */

export interface Fingerprint {
  id: string;
  kind: 'cms' | 'framework' | 'seo-plugin' | 'analytics' | 'tag-manager' | 'ssg';
  detail: string;
}

interface Rule {
  id: string;
  kind: Fingerprint['kind'];
  detail: string;
  test: (ctx: FingerprintContext) => boolean;
}

export interface FingerprintContext {
  html: string;
  doc: DomNode;
  headers: Record<string, string>;
  generators: string[];
  comments: string[];
}

const RULES: Rule[] = [
  {
    id: 'wordpress', kind: 'cms', detail: 'WordPress',
    test: (c) => c.generators.some((g) => /wordpress/i.test(g)) || /\/wp-(content|includes)\//.test(c.html),
  },
  {
    id: 'yoast-seo', kind: 'seo-plugin', detail: 'Yoast SEO manages meta tags and sitemaps',
    test: (c) => c.comments.some((x) => /yoast seo/i.test(x)) || /wp-seo|yoast/i.test(c.html),
  },
  {
    id: 'rank-math', kind: 'seo-plugin', detail: 'Rank Math manages meta tags and schema',
    test: (c) => c.comments.some((x) => /rank math/i.test(x)) || /rank-math/i.test(c.html),
  },
  {
    id: 'all-in-one-seo', kind: 'seo-plugin', detail: 'All in One SEO manages meta tags',
    test: (c) => c.comments.some((x) => /all in one seo/i.test(x)) || /aioseo/i.test(c.html),
  },
  {
    id: 'nextjs', kind: 'framework', detail: 'Next.js - metadata is defined in app/ or pages/ source',
    test: (c) => /__NEXT_DATA__|\/_next\/static\//.test(c.html) || !!c.headers['x-nextjs-cache'],
  },
  {
    id: 'nuxt', kind: 'framework', detail: 'Nuxt - metadata is defined via useHead/definePageMeta',
    test: (c) => /__NUXT__|\/_nuxt\//.test(c.html),
  },
  {
    id: 'astro', kind: 'ssg', detail: 'Astro - metadata is defined in .astro layouts',
    test: (c) => c.generators.some((g) => /astro/i.test(g)) || /astro-island|data-astro-/.test(c.html),
  },
  {
    id: 'hugo', kind: 'ssg', detail: 'Hugo - metadata comes from front matter and layouts',
    test: (c) => c.generators.some((g) => /hugo/i.test(g)),
  },
  {
    id: 'jekyll', kind: 'ssg', detail: 'Jekyll - metadata comes from front matter and _layouts',
    test: (c) => c.generators.some((g) => /jekyll/i.test(g)),
  },
  {
    id: 'gatsby', kind: 'framework', detail: 'Gatsby - metadata via react-helmet or Gatsby Head API',
    test: (c) => /___gatsby|\/page-data\//.test(c.html),
  },
  {
    id: 'sveltekit', kind: 'framework', detail: 'SvelteKit - metadata via svelte:head',
    test: (c) => /__sveltekit|data-sveltekit/.test(c.html),
  },
  {
    id: 'shopify', kind: 'cms', detail: 'Shopify - templates in Liquid, theme-managed meta',
    test: (c) => /cdn\.shopify\.com|Shopify\.theme/.test(c.html) || !!c.headers['x-shopify-stage'],
  },
  {
    id: 'wix', kind: 'cms', detail: 'Wix - SEO settings managed in the Wix dashboard',
    test: (c) => /static\.wixstatic\.com|wix-warmup-data/.test(c.html),
  },
  {
    id: 'squarespace', kind: 'cms', detail: 'Squarespace - SEO settings managed in the site dashboard',
    test: (c) => /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/.test(c.html),
  },
  {
    id: 'webflow', kind: 'cms', detail: 'Webflow - SEO settings managed per page in the designer',
    test: (c) => /website-files\.com|data-wf-page/.test(c.html),
  },
  {
    id: 'drupal', kind: 'cms', detail: 'Drupal',
    test: (c) => c.generators.some((g) => /drupal/i.test(g)) || /\/sites\/default\/files\//.test(c.html),
  },
  {
    id: 'contentful', kind: 'cms', detail: 'Contentful headless CMS supplies page content',
    test: (c) => /images\.ctfassets\.net|cdn\.contentful\.com/.test(c.html),
  },
  {
    id: 'sanity', kind: 'cms', detail: 'Sanity headless CMS supplies page content',
    test: (c) => /cdn\.sanity\.io/.test(c.html),
  },
  {
    id: 'gtm', kind: 'tag-manager', detail: 'Google Tag Manager present',
    test: (c) => /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/.test(c.html),
  },
  {
    id: 'ga4', kind: 'analytics', detail: 'Google Analytics 4 present',
    test: (c) => /gtag\/js\?id=G-|G-[A-Z0-9]{8,}/.test(c.html),
  },
  {
    id: 'plausible', kind: 'analytics', detail: 'Plausible analytics present',
    test: (c) => /plausible\.io\/js/.test(c.html),
  },
];

export function detectFingerprints(html: string, doc: DomNode, headers: Record<string, string>): Fingerprint[] {
  const generators = byTag(doc, 'meta')
    .filter((m) => (m.attrs['name'] ?? '').toLowerCase() === 'generator')
    .map((m) => m.attrs['content'] ?? '');
  const powered = headers['x-powered-by'];
  if (powered) generators.push(powered);
  if (headers['x-generator']) generators.push(headers['x-generator']);

  const comments: string[] = [];
  collectComments(doc, comments);

  const ctx: FingerprintContext = { html, doc, headers, generators, comments };
  const out: Fingerprint[] = [];
  for (const r of RULES) {
    try {
      if (r.test(ctx)) out.push({ id: r.id, kind: r.kind, detail: r.detail });
    } catch {
      // A broken detector must never break a crawl.
    }
  }
  return out;
}

function collectComments(n: DomNode, out: string[]): void {
  if (n.type === 'comment') out.push(n.text);
  for (const c of n.children) collectComments(c, out);
}

/**
 * Some frameworks hydrate content client-side. If the served HTML has almost no text
 * but plenty of script, downstream engines must know that what a crawler sees is not
 * what a browser renders.
 */
export function contentInInitialHtml(doc: DomNode, mainText: string): boolean {
  if (mainText.length >= 300) return true;
  const scriptBytes = byTag(doc, 'script').reduce((n, s) => n + rawText(s).length, 0);
  const hasRootOnly = byTag(doc, 'div').some(
    (d) => ['root', 'app', '__next', '__nuxt'].includes(d.attrs['id'] ?? '') && d.children.length === 0,
  );
  if (hasRootOnly) return false;
  return !(scriptBytes > 20_000 && mainText.length < 300);
}
