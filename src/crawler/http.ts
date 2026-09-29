import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import type { Logger } from '../core/logger.js';

/**
 * HTTP client for crawling.
 *
 * Redirects are followed manually so the full chain is preserved - a redirect chain is
 * itself an auditable fact, and losing it would make canonical/redirect analysis
 * guesswork.
 */

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBodyBytes: number;
  maxRetries: number;
  maxRedirects?: number;
  method?: 'GET' | 'HEAD';
  acceptHeader?: string;
  allowedOrigins?: string[];
}

export interface HttpResponse {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  contentType: string | null;
  /** Each hop: the URL requested and the status it returned. */
  redirectChain: { url: string; status: number; location: string }[];
  timingMs: number;
  truncated: boolean;
  error: string | null;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchUrl(url: string, opts: FetchOptions, log?: Logger): Promise<HttpResponse> {
  const started = Date.now();
  const maxRedirects = opts.maxRedirects ?? 8;
  const redirectChain: HttpResponse['redirectChain'] = [];
  let current = url;
  let attempt = 0;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: Response;
    try {
      const target = new URL(current);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
        (opts.allowedOrigins && !opts.allowedOrigins.includes(target.origin))) {
        return errorResponse(url, current, redirectChain, started, 'URL outside approved crawl origins');
      }
      res = await withTimeout(current, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < opts.maxRetries && isTransient(message)) {
        attempt++;
        await sleep(backoff(attempt));
        hop--;
        continue;
      }
      return errorResponse(url, current, redirectChain, started, message);
    }

    const headers = headerMap(res.headers);

    if (res.status >= 300 && res.status < 400 && headers['location']) {
      let next: string;
      try {
        next = new URL(headers['location'], current).toString();
      } catch {
        return errorResponse(url, current, redirectChain, started, `Unparseable Location: ${headers['location']}`);
      }
      redirectChain.push({ url: current, status: res.status, location: next });
      try {
        await res.body?.cancel();
      } catch {
        /* the body is irrelevant on a redirect hop */
      }
      if (next === current) {
        return errorResponse(url, current, redirectChain, started, 'Redirect loop: location equals current URL');
      }
      if (redirectChain.some((h) => h.url === next)) {
        return errorResponse(url, next, redirectChain, started, 'Redirect loop detected');
      }
      current = next;
      continue;
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < opts.maxRetries) {
      attempt++;
      const retryAfter = Number.parseInt(headers['retry-after'] ?? '', 10);
      const wait = Number.isFinite(retryAfter) ? Math.min(30_000, retryAfter * 1000) : backoff(attempt);
      log?.debug(`retrying ${current} after ${res.status}`, { wait });
      try {
        await res.body?.cancel();
      } catch {
        /* discard */
      }
      await sleep(wait);
      hop--;
      continue;
    }

    const { text, bytes, truncated } = await readBody(res, opts.maxBodyBytes);
    return {
      requestedUrl: url,
      finalUrl: current,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers,
      body: text,
      bodyBytes: bytes,
      contentType: headers['content-type'] ?? null,
      redirectChain,
      timingMs: Date.now() - started,
      truncated,
      error: null,
    };
  }

  return errorResponse(url, current, redirectChain, started, `Exceeded ${maxRedirects} redirects`);
}

async function withTimeout(url: string, opts: FetchOptions): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        'user-agent': opts.userAgent,
        accept: opts.acceptHeader ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        break;
      }
    }
  } catch {
    truncated = true;
  }

  let buf: Buffer<ArrayBufferLike> = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  // undici normally decompresses, but manual-redirect + proxies can leak raw streams.
  buf = maybeDecompress(buf, (res.headers.get('content-encoding') ?? '').toLowerCase());
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  const text = decodeBuffer(buf, charset);
  return { text, bytes: total, truncated };
}

function maybeDecompress(buf: Buffer, encoding: string): Buffer<ArrayBufferLike> {
  try {
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
    if (encoding.includes('br')) return brotliDecompressSync(buf);
    if (encoding.includes('deflate')) return inflateSync(buf);
  } catch {
    /* Not actually compressed, or corrupt. Use the bytes as-is. */
  }
  return buf;
}

function decodeBuffer(buf: Buffer, charset?: string): string {
  const cs = charset && charset !== 'utf-8' && charset !== 'utf8' ? charset : 'utf-8';
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function headerMap(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    const key = k.toLowerCase();
    out[key] = out[key] ? `${out[key]}, ${v}` : v;
  });
  return out;
}

function errorResponse(
  requested: string, final: string, chain: HttpResponse['redirectChain'], started: number, error: string,
): HttpResponse {
  return {
    requestedUrl: requested,
    finalUrl: final,
    status: 0,
    ok: false,
    headers: {},
    body: '',
    bodyBytes: 0,
    contentType: null,
    redirectChain: chain,
    timingMs: Date.now() - started,
    truncated: false,
    error,
  };
}

function isTransient(message: string): boolean {
  return /abort|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed/i.test(message);
}

function backoff(attempt: number): number {
  return Math.min(8000, 300 * 2 ** attempt) + Math.floor(Math.random() * 200);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
