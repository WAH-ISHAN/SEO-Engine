import { normalizeUrl } from '../core/url.js';
import { decodeEntities } from '../parser/tokenizer.js';

/**
 * Sitemap and sitemap-index parsing, including gzip-encoded sitemaps.
 * Deliberately regex-based rather than a full XML parse: sitemaps are a flat,
 * well-known shape, and real ones are frequently just malformed enough to defeat a
 * strict parser.
 */

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
  /** Which sitemap file listed this URL. */
  source: string;
}

export interface SitemapDocument {
  url: string;
  kind: 'urlset' | 'sitemapindex' | 'unknown';
  entries: SitemapEntry[];
  /** Child sitemap URLs, when this is an index. */
  children: string[];
  errors: string[];
}

export function parseSitemap(xml: string, sitemapUrl: string): SitemapDocument {
  const errors: string[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<urlset[\s>]/i.test(xml);
  const kind: SitemapDocument['kind'] = isIndex ? 'sitemapindex' : isUrlset ? 'urlset' : 'unknown';

  if (kind === 'unknown') {
    // Plain-text sitemaps are legal: one URL per line.
    const lines = xml.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    if (lines.length) {
      return {
        url: sitemapUrl,
        kind: 'urlset',
        entries: lines
          .map((l) => normalizeUrl(l, sitemapUrl))
          .filter((u): u is string => !!u)
          .map((loc) => ({ loc, lastmod: null, changefreq: null, priority: null, source: sitemapUrl })),
        children: [],
        errors,
      };
    }
    errors.push('Not a recognized sitemap: no <urlset>, no <sitemapindex>, no URL list.');
    return { url: sitemapUrl, kind, entries: [], children: [], errors };
  }

  const blockRe = isIndex ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi : /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  const entries: SitemapEntry[] = [];
  const children: string[] = [];

  for (const m of xml.matchAll(blockRe)) {
    const block = m[1];
    const rawLoc = tag(block, 'loc');
    if (!rawLoc) {
      errors.push('Entry without <loc>.');
      continue;
    }
    const loc = normalizeUrl(decodeEntities(rawLoc.trim()), sitemapUrl);
    if (!loc) {
      errors.push(`Unparseable <loc>: ${rawLoc.trim().slice(0, 120)}`);
      continue;
    }
    if (isIndex) {
      children.push(loc);
      continue;
    }
    const priorityRaw = tag(block, 'priority');
    const priority = priorityRaw !== null ? Number.parseFloat(priorityRaw) : null;
    entries.push({
      loc,
      lastmod: tag(block, 'lastmod'),
      changefreq: tag(block, 'changefreq'),
      priority: priority !== null && Number.isFinite(priority) ? priority : null,
      source: sitemapUrl,
    });
  }

  if (entries.length === 0 && children.length === 0) errors.push('Sitemap contains no entries.');
  return { url: sitemapUrl, kind, entries, children, errors };
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return m ? decodeEntities(m[1].trim()) : null;
}

/** Conventional sitemap locations to probe when robots.txt lists none. */
export function candidateSitemapUrls(origin: string): string[] {
  return [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap/sitemap.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap.txt`,
  ];
}
