import type { PageProps } from '../core/model.js';
import type { NormalizedSite } from '../normalizer/normalize.js';
import type { CrawlResult } from '../crawler/crawler.js';
import { contentWords, hammingDistanceHex, similarity, stem, termFrequency } from '../core/text.js';
import { sectionPath } from '../core/url.js';
import {
  bfsDepths, buildGraph, inDegree, outDegree, pageRank, weaklyConnectedComponents,
  type AdjacencyGraph,
} from './graph.js';

/**
 * The site graph: the website expressed as structure rather than as a list of pages.
 * Information architecture, link topology and content relationships all live here, and
 * every engine that needs "how does this page sit in the site" reads it from here.
 */

export interface PageMetrics {
  url: string;
  depth: number;
  inLinks: number;
  outLinks: number;
  internalOutLinks: number;
  /** Inbound links that sit in main content rather than nav/footer boilerplate. */
  contextualInLinks: number;
  pageRank: number;
  /** Rank position by pageRank, 1 = most internally prominent. */
  prominenceRank: number;
  section: string;
  orphan: boolean;
  weaklyConnected: boolean;
}

export interface DuplicateCluster {
  kind: 'exact' | 'near';
  urls: string[];
  similarity: number;
  /** The URL the cluster appears to canonicalize to, when one is declared. */
  canonicalTarget: string | null;
}

export interface TopicCluster {
  id: string;
  label: string;
  terms: string[];
  urls: string[];
  /** Mean pairwise similarity inside the cluster. */
  cohesion: number;
}

export interface CannibalizationGroup {
  topic: string;
  urls: string[];
  /** Overlap of the leading terms between the competing pages. */
  overlap: number;
  evidenceTerms: string[];
}

export interface SectionSummary {
  path: string;
  pageCount: number;
  avgDepth: number;
  avgWordCount: number;
  indexablePages: number;
  /** Links entering the section from outside it. */
  externalInLinks: number;
  orphanCount: number;
  isolated: boolean;
}

export interface SiteGraph {
  graph: AdjacencyGraph;
  metrics: Map<string, PageMetrics>;
  homepage: string | null;
  sections: SectionSummary[];
  orphanPages: string[];
  /** Pages reachable only through a single inbound link. */
  weaklyConnectedPages: string[];
  isolatedSections: string[];
  duplicateClusters: DuplicateCluster[];
  topicClusters: TopicCluster[];
  cannibalization: CannibalizationGroup[];
  brokenInternalLinks: { from: string; to: string; status: number | null; anchor: string }[];
  /** Internal links that resolve only after a redirect. */
  redirectedInternalLinks: { from: string; to: string; finalUrl: string; hops: number }[];
  maxDepth: number;
  avgDepth: number;
}

export function buildSiteGraph(site: NormalizedSite, crawl: CrawlResult): SiteGraph {
  const pages = site.pages;
  const urls = pages.map((p) => p.url);
  const urlSet = new Set(urls);

  const edges: [string, string][] = [];
  for (const p of pages) {
    for (const l of p.links) {
      if (l.internal && urlSet.has(l.href) && l.href !== p.url) edges.push([p.url, l.href]);
    }
  }
  const graph = buildGraph(urls, edges);

  const homepage = pickHomepage(site, urls);
  const depths = bfsDepths(graph, homepage ? [homepage] : urls.slice(0, 1));
  const ranks = pageRank(graph);

  const rankOrder = [...ranks.entries()].sort((a, b) => b[1] - a[1]);
  const rankPosition = new Map<string, number>();
  rankOrder.forEach(([u], i) => rankPosition.set(u, i + 1));

  const contextualIn = new Map<string, number>();
  for (const p of pages) {
    for (const l of p.links) {
      if (!l.internal || !urlSet.has(l.href) || l.href === p.url) continue;
      if (l.inMainContent) contextualIn.set(l.href, (contextualIn.get(l.href) ?? 0) + 1);
    }
  }

  const metrics = new Map<string, PageMetrics>();
  for (const p of pages) {
    const inL = inDegree(graph, p.url);
    metrics.set(p.url, {
      url: p.url,
      depth: depths.get(p.url) ?? Infinity,
      inLinks: inL,
      outLinks: p.links.length,
      internalOutLinks: outDegree(graph, p.url),
      contextualInLinks: contextualIn.get(p.url) ?? 0,
      pageRank: ranks.get(p.url) ?? 0,
      prominenceRank: rankPosition.get(p.url) ?? urls.length,
      section: p.sectionPath,
      orphan: inL === 0 && p.url !== homepage,
      weaklyConnected: inL > 0 && inL <= 1 && p.url !== homepage,
    });
  }

  const components = weaklyConnectedComponents(graph);
  const mainComponent = new Set(components[0] ?? []);
  for (const m of metrics.values()) {
    if (!mainComponent.has(m.url) && components.length > 1) m.weaklyConnected = true;
  }

  const finiteDepths = [...metrics.values()].map((m) => m.depth).filter((d) => Number.isFinite(d));

  return {
    graph,
    metrics,
    homepage,
    sections: summarizeSections(pages, metrics, graph),
    orphanPages: [...metrics.values()].filter((m) => m.orphan).map((m) => m.url).sort(),
    weaklyConnectedPages: [...metrics.values()]
      .filter((m) => m.weaklyConnected && !m.orphan)
      .map((m) => m.url)
      .sort(),
    isolatedSections: [],
    duplicateClusters: findDuplicates(pages),
    topicClusters: clusterTopics(pages),
    cannibalization: findCannibalization(pages),
    brokenInternalLinks: findBrokenLinks(site, crawl),
    redirectedInternalLinks: findRedirectedLinks(site),
    maxDepth: finiteDepths.length ? Math.max(...finiteDepths) : 0,
    avgDepth: finiteDepths.length ? finiteDepths.reduce((a, b) => a + b, 0) / finiteDepths.length : 0,
  };
}

function pickHomepage(site: NormalizedSite, urls: string[]): string | null {
  const origin = site.origin;
  for (const candidate of [origin, `${origin}/`, `${origin}/index.html`, `${origin}/home`]) {
    const hit = urls.find((u) => u === candidate || u === candidate.replace(/\/$/, ''));
    if (hit) return hit;
  }
  // Fall back to the shallowest URL, which is what a homepage looks like structurally.
  return [...urls].sort((a, b) => a.length - b.length)[0] ?? null;
}

function summarizeSections(
  pages: PageProps[], metrics: Map<string, PageMetrics>, graph: AdjacencyGraph,
): SectionSummary[] {
  const bySection = new Map<string, PageProps[]>();
  for (const p of pages) {
    const key = p.sectionPath;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key)!.push(p);
  }

  const out: SectionSummary[] = [];
  for (const [path, group] of bySection) {
    const urls = new Set(group.map((p) => p.url));
    let externalInLinks = 0;
    for (const u of urls) {
      for (const src of graph.in.get(u) ?? []) if (!urls.has(src)) externalInLinks++;
    }
    const depths = group.map((p) => metrics.get(p.url)?.depth ?? Infinity).filter(Number.isFinite);
    out.push({
      path,
      pageCount: group.length,
      avgDepth: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : Infinity,
      avgWordCount: group.reduce((a, p) => a + p.wordCount, 0) / group.length,
      indexablePages: group.filter((p) => p.indexable).length,
      externalInLinks,
      orphanCount: group.filter((p) => metrics.get(p.url)?.orphan).length,
      // A section nothing links into from elsewhere is structurally stranded.
      isolated: externalInLinks === 0 && path !== '/' && group.length > 0,
    });
  }
  return out.sort((a, b) => b.pageCount - a.pageCount);
}

/** Exact duplicates by content hash, near-duplicates by simhash proximity. */
function findDuplicates(pages: PageProps[]): DuplicateCluster[] {
  const clusters: DuplicateCluster[] = [];
  const substantive = pages.filter((p) => p.wordCount >= 50);

  const byHash = new Map<string, PageProps[]>();
  for (const p of substantive) {
    if (!byHash.has(p.contentHash)) byHash.set(p.contentHash, []);
    byHash.get(p.contentHash)!.push(p);
  }
  const exactMembers = new Set<string>();
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    for (const p of group) exactMembers.add(p.url);
    clusters.push({
      kind: 'exact',
      urls: group.map((p) => p.url).sort(),
      similarity: 1,
      canonicalTarget: declaredCanonical(group),
    });
  }

  const remaining = substantive.filter((p) => !exactMembers.has(p.url));
  const assigned = new Set<string>();
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i];
    if (assigned.has(a.url)) continue;
    const group = [a];
    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j];
      if (assigned.has(b.url)) continue;
      if (hammingDistanceHex(a.simhash, b.simhash) <= 6) {
        group.push(b);
        assigned.add(b.url);
      }
    }
    if (group.length > 1) {
      assigned.add(a.url);
      const sim = 1 - hammingDistanceHex(a.simhash, group[1].simhash) / 64;
      clusters.push({
        kind: 'near',
        urls: group.map((p) => p.url).sort(),
        similarity: Number(sim.toFixed(3)),
        canonicalTarget: declaredCanonical(group),
      });
    }
  }
  return clusters;
}

function declaredCanonical(group: PageProps[]): string | null {
  const canonicals = new Set(group.map((p) => p.canonical).filter((c): c is string => !!c));
  return canonicals.size === 1 ? [...canonicals][0] : null;
}

/**
 * Agglomerative clustering over page term vectors. Produces topic groupings that
 * describe what the site already covers; it does not assert search demand.
 */
function clusterTopics(pages: PageProps[]): TopicCluster[] {
  const candidates = pages.filter((p) => p.indexable && p.wordCount >= 120);
  if (candidates.length < 2) return [];

  const vectors = new Map<string, string[]>();
  for (const p of candidates) {
    const terms = termFrequency(`${p.title ?? ''} ${p.headings.map((h) => h.text).join(' ')} ${p.text}`, 25)
      .map((t) => t.term);
    vectors.set(p.url, terms);
  }

  const clusters: { urls: string[]; terms: Set<string> }[] = [];
  for (const p of candidates) {
    const terms = vectors.get(p.url)!;
    let best: { c: (typeof clusters)[number]; score: number } | null = null;
    for (const c of clusters) {
      const score = similarity(terms, [...c.terms]);
      if (score >= 0.22 && (!best || score > best.score)) best = { c, score };
    }
    if (best) {
      best.c.urls.push(p.url);
      for (const t of terms.slice(0, 10)) best.c.terms.add(t);
    } else {
      clusters.push({ urls: [p.url], terms: new Set(terms.slice(0, 12)) });
    }
  }

  return clusters
    .filter((c) => c.urls.length >= 2)
    .map((c, i) => {
      const terms = [...c.terms].slice(0, 10);
      const sims: number[] = [];
      for (let a = 0; a < c.urls.length; a++) {
        for (let b = a + 1; b < c.urls.length; b++) {
          sims.push(similarity(vectors.get(c.urls[a])!, vectors.get(c.urls[b])!));
        }
      }
      return {
        id: `topic-${i + 1}`,
        label: terms.slice(0, 3).join(' / ') || `cluster ${i + 1}`,
        terms,
        urls: c.urls.sort(),
        cohesion: sims.length ? Number((sims.reduce((x, y) => x + y, 0) / sims.length).toFixed(3)) : 1,
      };
    })
    .sort((a, b) => b.urls.length - a.urls.length);
}

/**
 * Cannibalization: two or more indexable pages in the same section whose titles and
 * headings target the same term set. Reported as an observation about the site's own
 * content, not as a claim about which page any engine ranks.
 */
function findCannibalization(pages: PageProps[]): CannibalizationGroup[] {
  const indexable = pages.filter((p) => p.indexable && p.title && p.wordCount >= 80);
  const signature = new Map<string, { url: string; terms: string[] }[]>();

  for (const p of indexable) {
    const focus = contentWords(`${p.title ?? ''} ${p.h1s.join(' ')}`).map(stem);
    if (focus.length < 2) continue;
    const key = [...new Set(focus)].sort().slice(0, 4).join('|');
    if (!signature.has(key)) signature.set(key, []);
    signature.get(key)!.push({ url: p.url, terms: focus });
  }

  const groups: CannibalizationGroup[] = [];
  for (const [key, members] of signature) {
    if (members.length < 2) continue;
    const overlap = similarity(members[0].terms, members[1].terms);
    groups.push({
      topic: key.replace(/\|/g, ' '),
      urls: members.map((m) => m.url).sort(),
      overlap: Number(overlap.toFixed(3)),
      evidenceTerms: [...new Set(members.flatMap((m) => m.terms))].slice(0, 8),
    });
  }
  return groups.sort((a, b) => b.urls.length - a.urls.length);
}

function findBrokenLinks(
  site: NormalizedSite, crawl: CrawlResult,
): { from: string; to: string; status: number | null; anchor: string }[] {
  const statusByUrl = new Map<string, number>();
  for (const rec of crawl.records) {
    statusByUrl.set(rec.url, rec.error ? 0 : rec.status);
    if (rec.finalUrl !== rec.url) statusByUrl.set(rec.finalUrl, rec.error ? 0 : rec.status);
  }
  const out: { from: string; to: string; status: number | null; anchor: string }[] = [];
  const seen = new Set<string>();
  for (const p of site.pages) {
    for (const l of p.links) {
      if (!l.internal) continue;
      const status = statusByUrl.get(l.href);
      if (status === undefined) continue;
      if (status === 0 || status >= 400) {
        const key = `${p.url}->${l.href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from: p.url, to: l.href, status: status === 0 ? null : status, anchor: l.anchor });
      }
    }
  }
  return out;
}

function findRedirectedLinks(
  site: NormalizedSite,
): { from: string; to: string; finalUrl: string; hops: number }[] {
  const out: { from: string; to: string; finalUrl: string; hops: number }[] = [];
  const seen = new Set<string>();
  for (const p of site.pages) {
    for (const l of p.links) {
      if (!l.internal) continue;
      const r = site.redirects.get(l.href);
      if (!r) continue;
      const key = `${p.url}->${l.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: p.url, to: l.href, finalUrl: r.finalUrl, hops: r.hops });
    }
  }
  return out;
}

export { sectionPath };
