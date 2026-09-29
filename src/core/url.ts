/**
 * URL normalization. Two URLs that address the same resource must normalize to the
 * same string, or the whole graph double-counts pages.
 */

const DEFAULT_STRIP_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', '_ga', 'igshid', 'yclid',
];

export interface NormalizeOptions {
  stripParams?: string[];
  /** Keep the trailing slash exactly as served. Off by default (slash removed). */
  preserveTrailingSlash?: boolean;
  /** Drop the fragment. On by default. */
  dropFragment?: boolean;
  /** Lowercase the path. Off - paths are case sensitive on most servers. */
  lowercasePath?: boolean;
}

export function normalizeUrl(input: string, base?: string, opts: NormalizeOptions = {}): string | null {
  let u: URL;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  if (opts.dropFragment !== false) u.hash = '';

  const strip = new Set(opts.stripParams ?? DEFAULT_STRIP_PARAMS);
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (!strip.has(k.toLowerCase())) keep.push([k, v]);
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);

  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  if (opts.lowercasePath) u.pathname = u.pathname.toLowerCase();
  if (!opts.preserveTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

export function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase();
    const hb = new URL(b).hostname.toLowerCase();
    return registrableRoot(ha) === registrableRoot(hb);
  } catch {
    return false;
  }
}

/** Naive eTLD+1. Sufficient for same-site checks; not a Public Suffix List. */
export function registrableRoot(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoLevelTlds = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz',
    'co.jp', 'com.br', 'co.za', 'com.mx', 'co.in',
  ]);
  const last2 = parts.slice(-2).join('.');
  return twoLevelTlds.has(last2) ? parts.slice(-3).join('.') : last2;
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

export function pathDepth(url: string): number {
  const p = pathOf(url).replace(/^\/|\/$/g, '');
  return p === '' ? 0 : p.split('/').length;
}

/**
 * Collapse a URL to a section pattern: /blog/2024/my-post becomes /blog/*
 * Groups pages into templates without needing CMS access.
 */
export function sectionPath(url: string): string {
  const segs = pathOf(url).replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  if (segs.length === 0) return '/';
  if (segs.length === 1) return `/${segs[0]}`;
  return `/${segs[0]}/*`;
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Flags URL shapes that are hostile to crawlers and to humans. */
export function urlQualityIssues(url: string): string[] {
  const issues: string[] = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return ['unparseable'];
  }
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    p = u.pathname;
  }
  if (/[A-Z]/.test(u.pathname)) issues.push('uppercase-characters');
  if (p.includes('_')) issues.push('underscores');
  if (/\s/.test(p) || u.pathname.includes('%20')) issues.push('spaces');
  if (p.length > 115) issues.push('excessive-length');
  if (pathDepth(url) > 5) issues.push('excessive-depth');
  if ([...u.searchParams.keys()].length > 3) issues.push('many-query-parameters');
  if (/\.(php|asp|aspx|jsp|cgi)$/i.test(p)) issues.push('file-extension-exposed');
  const slug = p.split('/').pop() ?? '';
  if (/\d{4,}/.test(slug) && !/^\d{4}$/.test(slug)) issues.push('numeric-id-in-slug');
  return issues;
}
