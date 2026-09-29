import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A local static server for the fixture site.
 *
 * It deliberately reproduces the conditions a real crawler meets: extensionless URLs,
 * directory indexes, a redirect, and a 404. Testing the crawler against a server that
 * behaves too politely would prove nothing.
 */

const ROOT = resolve(fileURLToPath(new URL('./fixtures/site', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
};

/** URLs the fixture site redirects, so redirect handling is exercised. */
const REDIRECTS: Record<string, string> = {
  '/pricing': '/services',
  '/old-faq': '/faq',
};

export interface FixtureServer {
  server: Server;
  origin: string;
  close(): Promise<void>;
}

export async function startFixtureServer(port = 8799): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (REDIRECTS[url]) {
      res.writeHead(301, { location: REDIRECTS[url] });
      res.end();
      return;
    }

    const file = resolveFile(url);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Not found</title></head><body><h1>404</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });

  // Fail fast and say why. A port conflict that leaves listen() pending would hang the
  // whole suite in a before() hook with no indication of the cause.
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use; a previous fixture server is still running.`)
        : err);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function resolveFile(urlPath: string): string | null {
  const clean = urlPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const candidates = clean === ''
    ? ['index.html']
    : [clean, `${clean}.html`, join(clean, 'index.html')];

  for (const c of candidates) {
    const full = resolve(join(ROOT, c));
    // Never serve outside the fixture root, even if a test asks for it.
    if (!full.startsWith(ROOT)) continue;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}
