import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { Logger } from '../core/logger.js';
import { pathOf } from '../core/url.js';

/**
 * Maps a live URL back to the source file that produces it.
 *
 * Without this mapping the platform can describe a change but not make one. With it,
 * changes are reviewable diffs against real files. The adapter is deliberately
 * conservative: when it cannot establish with confidence which file produces a URL, it
 * says so and the change stays a proposal rather than guessing at a file to edit.
 */

export type ProjectKind =
  | 'static-html' | 'nextjs-app' | 'nextjs-pages' | 'astro' | 'hugo' | 'jekyll'
  | 'eleventy' | 'nuxt' | 'sveltekit' | 'gatsby' | 'unknown';

export interface RepoProfile {
  root: string;
  kind: ProjectKind;
  /** Directory whose files correspond to routes. */
  routeRoot: string | null;
  /** Directory of built output, when one exists. */
  outputRoot: string | null;
  detail: string;
}

export interface UrlMapping {
  url: string;
  files: string[];
  /** How the file was matched. Lower confidence means a proposal, not a patch. */
  confidence: number;
  method: 'static-path' | 'route-file' | 'content-match' | 'none';
  note: string;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out',
  '.cache', 'coverage', '.vercel', '.netlify', 'vendor', '.uwoe',
]);

export function detectRepo(root: string, log: Logger): RepoProfile {
  const abs = resolve(root);
  const has = (p: string) => existsSync(join(abs, p));

  let kind: ProjectKind = 'unknown';
  let routeRoot: string | null = null;
  let outputRoot: string | null = null;
  let detail = 'No recognized framework layout; treating files as static assets.';

  if (has('app') && (has('next.config.js') || has('next.config.mjs') || has('next.config.ts'))) {
    kind = 'nextjs-app';
    routeRoot = 'app';
    outputRoot = '.next';
    detail = 'Next.js App Router. Metadata lives in layout/page metadata exports, not in HTML files.';
  } else if (has('pages') && (has('next.config.js') || has('next.config.mjs'))) {
    kind = 'nextjs-pages';
    routeRoot = 'pages';
    outputRoot = '.next';
    detail = 'Next.js Pages Router. Metadata is set via next/head.';
  } else if (has('astro.config.mjs') || has('astro.config.ts')) {
    kind = 'astro';
    routeRoot = 'src/pages';
    outputRoot = 'dist';
    detail = 'Astro. Metadata lives in .astro layouts and page frontmatter.';
  } else if (has('hugo.toml') || has('config.toml') || has('hugo.yaml')) {
    kind = 'hugo';
    routeRoot = 'content';
    outputRoot = 'public';
    detail = 'Hugo. Page metadata comes from Markdown front matter and layout templates.';
  } else if (has('_config.yml')) {
    kind = 'jekyll';
    routeRoot = '.';
    outputRoot = '_site';
    detail = 'Jekyll. Page metadata comes from front matter and _layouts.';
  } else if (has('.eleventy.js') || has('eleventy.config.js')) {
    kind = 'eleventy';
    routeRoot = 'src';
    outputRoot = '_site';
    detail = 'Eleventy. Page metadata comes from front matter and layouts.';
  } else if (has('nuxt.config.ts') || has('nuxt.config.js')) {
    kind = 'nuxt';
    routeRoot = 'pages';
    outputRoot = '.output';
    detail = 'Nuxt. Metadata is set via useHead or definePageMeta.';
  } else if (has('svelte.config.js')) {
    kind = 'sveltekit';
    routeRoot = 'src/routes';
    outputRoot = 'build';
    detail = 'SvelteKit. Metadata is set inside svelte:head blocks.';
  } else if (has('gatsby-config.js') || has('gatsby-config.ts')) {
    kind = 'gatsby';
    routeRoot = 'src/pages';
    outputRoot = 'public';
    detail = 'Gatsby. Metadata is set via the Head API or react-helmet.';
  } else if (findHtmlFiles(abs, abs, 2).length > 0) {
    kind = 'static-html';
    routeRoot = '.';
    detail = 'Static HTML files map directly to URL paths.';
  }

  log.info(`repository: ${kind} at ${abs}`);
  return { root: abs, kind, routeRoot, outputRoot, detail };
}

/**
 * Finds the file that produces a URL.
 *
 * For static HTML the mapping is deterministic. For template-driven frameworks the
 * mapping is reported at low confidence, because metadata usually lives in a layout
 * shared by many routes - editing it would change every page that uses it, which is a
 * decision the platform must not make on its own.
 */
export function mapUrlToFiles(profile: RepoProfile, url: string, htmlBody?: string): UrlMapping {
  const path = pathOf(url).replace(/^\/|\/$/g, '');

  if (profile.kind === 'static-html') {
    const candidates = [
      path === '' ? 'index.html' : `${path}.html`,
      path === '' ? 'index.htm' : `${path}/index.html`,
      join(path, 'index.html'),
    ].map((p) => join(profile.root, p));

    for (const c of candidates) {
      if (existsSync(c) && statSync(c).isFile()) {
        return {
          url,
          files: [relative(profile.root, c)],
          confidence: 0.95,
          method: 'static-path',
          note: 'URL path maps directly to this file.',
        };
      }
    }
  }

  if (profile.outputRoot && existsSync(join(profile.root, profile.outputRoot))) {
    const outDir = join(profile.root, profile.outputRoot);
    const candidates = [
      path === '' ? 'index.html' : `${path}.html`,
      path === '' ? 'index.html' : join(path, 'index.html'),
    ].map((p) => join(outDir, p));
    for (const c of candidates) {
      if (existsSync(c)) {
        return {
          url,
          files: [relative(profile.root, c)],
          confidence: 0.4,
          method: 'route-file',
          note:
            'Matched a file in the build output directory. Editing build output is not durable - ' +
            'the next build overwrites it. The corresponding source file must be changed instead.',
        };
      }
    }
  }

  if (profile.routeRoot) {
    const routeDir = join(profile.root, profile.routeRoot);
    if (existsSync(routeDir)) {
      const matches = findRouteFiles(routeDir, path);
      if (matches.length) {
        return {
          url,
          files: matches.map((m) => relative(profile.root, m)),
          confidence: 0.55,
          method: 'route-file',
          note:
            `Matched by route convention for ${profile.kind}. Metadata for this route may be ` +
            'defined in a shared layout rather than in this file, so the change needs review before it is applied.',
        };
      }
    }
  }

  // Last resort: a distinctive string from the live page that appears in exactly one file.
  if (htmlBody) {
    const match = findByContent(profile.root, htmlBody);
    if (match) {
      return {
        url,
        files: [relative(profile.root, match)],
        confidence: 0.5,
        method: 'content-match',
        note: 'Located by finding a distinctive string from the live page in exactly one source file.',
      };
    }
  }

  return {
    url,
    files: [],
    confidence: 0,
    method: 'none',
    note:
      `No source file could be confidently matched to this URL in a ${profile.kind} project. ` +
      'The change is reported with its exact target value so it can be applied by hand.',
  };
}

function findRouteFiles(routeDir: string, urlPath: string): string[] {
  const segments = urlPath ? urlPath.split('/') : [];
  const base = join(routeDir, ...segments);
  const candidates = [
    ...['page.tsx', 'page.jsx', 'page.ts', 'page.js', 'index.astro', 'index.svelte', '+page.svelte']
      .map((f) => join(base, f)),
    ...['.tsx', '.jsx', '.ts', '.js', '.astro', '.svelte', '.md', '.mdx', '.html']
      .map((e) => `${base}${e}`),
    ...(segments.length === 0
      ? ['index.tsx', 'index.jsx', 'index.astro', 'index.md', 'index.html', '_index.md'].map((f) => join(routeDir, f))
      : []),
  ];
  return candidates.filter((c) => existsSync(c) && statSync(c).isFile());
}

/** Picks a long, distinctive line from the live HTML and greps the repo for it. */
function findByContent(root: string, htmlBody: string): string | null {
  const needle = pickNeedle(htmlBody);
  if (!needle) return null;
  const hits: string[] = [];
  walkFiles(root, root, (file) => {
    if (hits.length > 1) return false;
    const ext = extname(file);
    if (!['.html', '.htm', '.astro', '.svelte', '.vue', '.jsx', '.tsx', '.md', '.mdx', '.liquid', '.njk', '.hbs'].includes(ext)) {
      return true;
    }
    try {
      if (readFileSync(file, 'utf8').includes(needle)) hits.push(file);
    } catch {
      /* unreadable file */
    }
    return true;
  });
  return hits.length === 1 ? hits[0] : null;
}

function pickNeedle(html: string): string | null {
  const candidates = html
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 40 && l.length < 200 && !/^<(script|style|link|meta)/i.test(l));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

function walkFiles(root: string, dir: string, visit: (file: string) => boolean): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(root, full, visit);
    else if (!visit(full)) return;
  }
}

function findHtmlFiles(root: string, dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push(...findHtmlFiles(root, full, maxDepth, depth + 1));
      else if (extname(name) === '.html') out.push(full);
    } catch {
      continue;
    }
  }
  return out;
}
