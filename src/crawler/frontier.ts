import { normalizeUrl, registrableRoot, sameSite } from '../core/url.js';
import type { RawRecord } from './raw-store.js';

export interface FrontierItem {
  url: string;
  depth: number;
  discoveredFrom: string | null;
  method: RawRecord['discoveryMethod'];
  /** Lower runs first. Sitemap and shallow pages are crawled before deep tails. */
  priority: number;
}

/**
 * The crawl frontier: dedupe, scope enforcement, and ordering.
 *
 * Ordering is breadth-first by depth with a priority nudge, because depth-from-home is
 * itself a signal we need for the site graph - a depth-first crawl would report
 * misleading depths for pages reachable by several paths.
 */
export class Frontier {
  private queue: FrontierItem[] = [];
  private seen = new Set<string>();
  private root: string;

  constructor(
    private origin: string,
    private opts: {
      maxDepth: number;
      includeSubdomains: boolean;
      includePatterns: RegExp[];
      excludePatterns: RegExp[];
    },
  ) {
    this.root = registrableRoot(new URL(origin).hostname);
  }

  /** Returns true when the URL was newly enqueued. */
  add(rawUrl: string, depth: number, from: string | null, method: FrontierItem['method']): boolean {
    const url = normalizeUrl(rawUrl, from ?? this.origin);
    if (!url) return false;
    if (this.seen.has(url)) return false;
    if (depth > this.opts.maxDepth) return false;
    if (!this.inScope(url)) return false;

    this.seen.add(url);
    const priority = (method === 'seed' ? 0 : method === 'sitemap' ? 1 : 2) + depth;
    this.queue.push({ url, depth, discoveredFrom: from, method, priority });
    return true;
  }

  /** Records a URL as already handled without queueing it. */
  markSeen(rawUrl: string): void {
    const url = normalizeUrl(rawUrl, this.origin);
    if (url) this.seen.add(url);
  }

  has(url: string): boolean {
    const n = normalizeUrl(url, this.origin);
    return n ? this.seen.has(n) : false;
  }

  next(): FrontierItem | undefined {
    if (this.queue.length === 0) return undefined;
    let bestIdx = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority < this.queue[bestIdx].priority) bestIdx = i;
    }
    return this.queue.splice(bestIdx, 1)[0];
  }

  get pending(): number {
    return this.queue.length;
  }

  get discovered(): number {
    return this.seen.size;
  }

  inScope(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

    const host = u.hostname.toLowerCase();
    const originHost = new URL(this.origin).hostname.toLowerCase();
    if (this.opts.includeSubdomains) {
      if (registrableRoot(host) !== this.root) return false;
    } else if (host !== originHost) {
      return false;
    }

    if (this.opts.excludePatterns.some((re) => re.test(url))) return false;
    if (this.opts.includePatterns.length > 0 && !this.opts.includePatterns.some((re) => re.test(url))) {
      return false;
    }
    return true;
  }

  isInternal(url: string): boolean {
    return this.opts.includeSubdomains
      ? sameSite(url, this.origin)
      : (() => {
          try {
            return new URL(url).hostname.toLowerCase() === new URL(this.origin).hostname.toLowerCase();
          } catch {
            return false;
          }
        })();
  }
}

export function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      /* An invalid user pattern must not abort the crawl. */
    }
  }
  return out;
}
