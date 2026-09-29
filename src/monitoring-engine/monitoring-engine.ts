import { hash } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { GraphStore } from '../core/store.js';
import type { Issue, PageProps, Severity } from '../core/model.js';
import type { AnalysisContext } from '../core/context.js';
import type { RecommendationResult } from '../recommendation-engine/recommendation-engine.js';
import type { ScoreReport } from '../analytics/scoring.js';

/**
 * Monitoring.
 *
 * A snapshot is the complete auditable state of the site at one moment. Comparing two
 * of them answers the questions that matter between runs: what broke, what got fixed,
 * and what came back. Regressions are called out separately from new issues, because a
 * problem that was fixed and has returned means something in the delivery process is
 * undoing the work.
 */

export interface SiteSnapshot {
  id: string;
  site: string;
  takenAt: number;
  pageCount: number;
  indexableCount: number;
  scores: ScoreReport['scores'];
  /** Per-URL fingerprint of everything monitoring compares. */
  pages: Record<string, PageFingerprint>;
  issueKeys: Record<string, { rule: string; severity: Severity; urlCount: number; title: string }>;
  totals: {
    issues: number;
    recommendations: number;
    brokenLinks: number;
    orphanPages: number;
    schemaBlocks: number;
    redirects: number;
    httpErrors: number;
  };
}

export interface PageFingerprint {
  status: number;
  indexable: boolean;
  title: string | null;
  description: string | null;
  canonical: string | null;
  contentHash: string;
  wordCount: number;
  schemaTypes: string[];
  internalOutLinks: number;
  inLinks: number;
  depth: number;
}

export type ChangeKind =
  | 'page-added' | 'page-removed' | 'status-changed' | 'indexability-changed'
  | 'title-changed' | 'description-changed' | 'canonical-changed' | 'content-changed'
  | 'schema-changed' | 'links-changed' | 'depth-changed';

export interface MonitoringDiff {
  from: { id: string; takenAt: number };
  to: { id: string; takenAt: number };
  newIssues: { key: string; title: string; severity: Severity; urlCount: number }[];
  resolvedIssues: { key: string; title: string; severity: Severity }[];
  regressions: { key: string; title: string; severity: Severity; note: string }[];
  pageChanges: { url: string; kind: ChangeKind; before: unknown; after: unknown }[];
  scoreDeltas: Record<string, number>;
  summary: string;
}

export class MonitoringEngine {
  constructor(private store: GraphStore, private log: Logger) {}

  capture(ctx: AnalysisContext, recs: RecommendationResult, scores: ScoreReport): SiteSnapshot {
    const takenAt = Date.now();
    const pages: Record<string, PageFingerprint> = {};
    for (const p of ctx.site.pages) {
      pages[p.url] = fingerprint(p, ctx);
    }

    const issueKeys: SiteSnapshot['issueKeys'] = {};
    for (const issue of recs.issues) {
      issueKeys[issueKey(issue)] = {
        rule: issue.rule,
        severity: issue.severity,
        urlCount: issue.affectedUrls.length,
        title: issue.title,
      };
    }

    const snapshot: SiteSnapshot = {
      id: `snap-${hash(ctx.site.origin, String(takenAt))}`,
      site: ctx.site.origin,
      takenAt,
      pageCount: ctx.site.pages.length,
      indexableCount: ctx.site.pages.filter((p) => p.indexable).length,
      scores: scores.scores,
      pages,
      issueKeys,
      totals: {
        issues: recs.issues.length,
        recommendations: recs.recommendations.length,
        brokenLinks: ctx.siteGraph.brokenInternalLinks.length,
        orphanPages: ctx.siteGraph.orphanPages.length,
        schemaBlocks: ctx.site.pages.reduce((n, p) => n + p.schemas.length, 0),
        redirects: ctx.site.nonPageRecords.filter((r) => r.redirectChain.length > 0).length,
        httpErrors: ctx.site.nonPageRecords.filter((r) => r.status >= 400 || r.error).length,
      },
    };

    this.store.saveSnapshot(snapshot.id, snapshot.site, takenAt, snapshot);
    this.log.info(`snapshot ${snapshot.id} captured (${snapshot.pageCount} pages, ${recs.issues.length} issues)`);
    return snapshot;
  }

  history(site: string, limit = 30): { id: string; takenAt: number }[] {
    return this.store.listSnapshots(site, limit);
  }

  /** Compares the two most recent snapshots for a site. */
  latestDiff(site: string): MonitoringDiff | null {
    const recent = this.store.latestSnapshots<SiteSnapshot>(site, 2);
    if (recent.length < 2) return null;
    return this.diff(recent[1].data, recent[0].data);
  }

  diff(from: SiteSnapshot, to: SiteSnapshot): MonitoringDiff {
    const newIssues: MonitoringDiff['newIssues'] = [];
    const resolvedIssues: MonitoringDiff['resolvedIssues'] = [];
    const regressions: MonitoringDiff['regressions'] = [];

    // A regression is an issue that this platform saw resolved earlier in the site's
    // history and that is now back, which is different from a problem seen for the
    // first time.
    const historical = this.store.latestSnapshots<SiteSnapshot>(to.site, 20);
    const previouslyResolved = new Set<string>();
    for (let i = 1; i < historical.length; i++) {
      const older = historical[i].data;
      const newer = historical[i - 1].data;
      for (const key of Object.keys(older.issueKeys)) {
        if (!newer.issueKeys[key]) previouslyResolved.add(key);
      }
    }

    for (const [key, issue] of Object.entries(to.issueKeys)) {
      if (from.issueKeys[key]) continue;
      if (previouslyResolved.has(key)) {
        regressions.push({
          key,
          title: issue.title,
          severity: issue.severity,
          note: 'This issue was resolved in an earlier snapshot and has reappeared.',
        });
      } else {
        newIssues.push({ key, title: issue.title, severity: issue.severity, urlCount: issue.urlCount });
      }
    }
    for (const [key, issue] of Object.entries(from.issueKeys)) {
      if (!to.issueKeys[key]) {
        resolvedIssues.push({ key, title: issue.title, severity: issue.severity });
      }
    }

    const pageChanges = diffPages(from.pages, to.pages);

    const scoreDeltas: Record<string, number> = {};
    for (const [k, v] of Object.entries(to.scores)) {
      const prev = (from.scores as Record<string, number>)[k];
      if (typeof prev === 'number' && typeof v === 'number' && prev !== v) scoreDeltas[k] = v - prev;
    }

    const summary = [
      `${newIssues.length} new issue(s)`,
      `${resolvedIssues.length} resolved`,
      `${regressions.length} regression(s)`,
      `${pageChanges.length} page change(s)`,
    ].join(', ');

    return {
      from: { id: from.id, takenAt: from.takenAt },
      to: { id: to.id, takenAt: to.takenAt },
      newIssues: newIssues.sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity)),
      resolvedIssues,
      regressions,
      pageChanges,
      scoreDeltas,
      summary,
    };
  }
}

function fingerprint(p: PageProps, ctx: AnalysisContext): PageFingerprint {
  const m = ctx.siteGraph.metrics.get(p.url);
  return {
    status: p.status,
    indexable: p.indexable,
    title: p.title,
    description: p.metaDescription,
    canonical: p.canonical,
    contentHash: p.contentHash,
    wordCount: p.wordCount,
    schemaTypes: [...new Set(p.schemas.flatMap((s) => s.types))].sort(),
    internalOutLinks: m?.internalOutLinks ?? 0,
    inLinks: m?.inLinks ?? 0,
    depth: Number.isFinite(m?.depth ?? Infinity) ? (m!.depth) : -1,
  };
}

function diffPages(
  from: Record<string, PageFingerprint>, to: Record<string, PageFingerprint>,
): MonitoringDiff['pageChanges'] {
  const changes: MonitoringDiff['pageChanges'] = [];

  for (const url of Object.keys(to)) {
    if (!from[url]) {
      changes.push({ url, kind: 'page-added', before: null, after: { status: to[url].status } });
    }
  }
  for (const url of Object.keys(from)) {
    if (!to[url]) {
      changes.push({ url, kind: 'page-removed', before: { status: from[url].status }, after: null });
    }
  }

  for (const [url, after] of Object.entries(to)) {
    const before = from[url];
    if (!before) continue;

    if (before.status !== after.status) {
      changes.push({ url, kind: 'status-changed', before: before.status, after: after.status });
    }
    if (before.indexable !== after.indexable) {
      changes.push({ url, kind: 'indexability-changed', before: before.indexable, after: after.indexable });
    }
    if (before.title !== after.title) {
      changes.push({ url, kind: 'title-changed', before: before.title, after: after.title });
    }
    if (before.description !== after.description) {
      changes.push({ url, kind: 'description-changed', before: before.description, after: after.description });
    }
    if (before.canonical !== after.canonical) {
      changes.push({ url, kind: 'canonical-changed', before: before.canonical, after: after.canonical });
    }
    if (before.contentHash !== after.contentHash) {
      changes.push({
        url, kind: 'content-changed',
        before: { wordCount: before.wordCount },
        after: { wordCount: after.wordCount },
      });
    }
    if (before.schemaTypes.join(',') !== after.schemaTypes.join(',')) {
      changes.push({ url, kind: 'schema-changed', before: before.schemaTypes, after: after.schemaTypes });
    }
    // Only report link changes that are big enough to be a structural change rather
    // than ordinary editing.
    if (Math.abs(before.internalOutLinks - after.internalOutLinks) >= 3 || before.inLinks !== after.inLinks) {
      changes.push({
        url, kind: 'links-changed',
        before: { out: before.internalOutLinks, in: before.inLinks },
        after: { out: after.internalOutLinks, in: after.inLinks },
      });
    }
    if (before.depth !== after.depth) {
      changes.push({ url, kind: 'depth-changed', before: before.depth, after: after.depth });
    }
  }
  return changes;
}

function issueKey(issue: Issue): string {
  // Keyed on rule plus the set of affected URLs, so "title missing on /a and /b"
  // resolving to "title missing on /b" registers as a change rather than as unchanged.
  return `${issue.rule}::${hash([...issue.affectedUrls].sort().join('|'))}`;
}

function severityOrder(s: Severity): number {
  return ['info', 'low', 'medium', 'high', 'critical'].indexOf(s);
}
