import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../core/ids.js';
import type { HttpResponse } from './http.js';

/**
 * Raw crawl artifacts, stored separately from the normalized model by design.
 *
 * Keeping bytes and interpretation apart is what makes every finding auditable: any
 * claim in a report can be traced back to the exact response the crawler saw, and a
 * re-analysis with improved rules never requires re-crawling the site.
 */

export interface RawRecord {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  redirectChain: { url: string; status: number; location: string }[];
  fetchedAt: number;
  timingMs: number;
  bodyBytes: number;
  truncated: boolean;
  error: string | null;
  /** Relative path of the stored body within the raw directory. */
  bodyFile: string | null;
  discoveredFrom: string | null;
  discoveryMethod: 'seed' | 'link' | 'sitemap' | 'canonical' | 'redirect' | 'revalidation';
  depth: number;
}

export class RawStore {
  private indexPath: string;
  private index = new Map<string, RawRecord>();

  constructor(private dir: string) {
    mkdirSync(join(dir, 'bodies'), { recursive: true });
    this.indexPath = join(dir, 'index.jsonl');
    if (existsSync(this.indexPath)) {
      for (const line of readFileSync(this.indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as RawRecord;
          this.index.set(rec.url, rec);
        } catch {
          /* Skip a torn line rather than failing the whole run. */
        }
      }
    }
  }

  put(
    res: HttpResponse,
    meta: { discoveredFrom: string | null; discoveryMethod: RawRecord['discoveryMethod']; depth: number },
  ): RawRecord {
    let bodyFile: string | null = null;
    if (res.body) {
      bodyFile = join('bodies', `${hash(res.requestedUrl)}.txt`);
      writeFileSync(join(this.dir, bodyFile), res.body, 'utf8');
    }
    const rec: RawRecord = {
      url: res.requestedUrl,
      finalUrl: res.finalUrl,
      status: res.status,
      headers: res.headers,
      contentType: res.contentType,
      redirectChain: res.redirectChain,
      fetchedAt: Date.now(),
      timingMs: res.timingMs,
      bodyBytes: res.bodyBytes,
      truncated: res.truncated,
      error: res.error,
      bodyFile,
      discoveredFrom: meta.discoveredFrom,
      discoveryMethod: meta.discoveryMethod,
      depth: meta.depth,
    };
    this.index.set(rec.url, rec);
    // Append-only: a crash mid-crawl still leaves every completed fetch on disk.
    writeFileSync(this.indexPath, JSON.stringify(rec) + '\n', { flag: 'a', encoding: 'utf8' });
    return rec;
  }

  body(rec: RawRecord): string {
    if (!rec.bodyFile) return '';
    const p = join(this.dir, rec.bodyFile);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  get(url: string): RawRecord | undefined {
    return this.index.get(url);
  }

  all(): RawRecord[] {
    return [...this.index.values()];
  }

  size(): number {
    return this.index.size;
  }

  bodyFileCount(): number {
    try {
      return readdirSync(join(this.dir, 'bodies')).length;
    } catch {
      return 0;
    }
  }
}
