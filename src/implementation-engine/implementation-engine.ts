import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hash } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { GraphStore } from '../core/store.js';
import type {
  Change, ChangeStatus, FixSpec, PageProps, Recommendation, RollbackPlan,
} from '../core/model.js';
import type { AnalysisContext } from '../core/context.js';
import { detectRepo, mapUrlToFiles, type RepoProfile, type UrlMapping } from './repo-adapter.js';
import {
  addJsonLd, retargetLink, setCanonical, setHtmlLang, setMetaByName, setMetaByProperty,
  setTitle, unifiedDiff, type HtmlEditResult,
} from './patch.js';

/**
 * The implementation engine.
 *
 * The lifecycle is fixed and cannot be short-circuited:
 *
 *   proposed -> previewed -> approved -> applied -> validated
 *                       \-> rejected        \-> failed -> rolled-back
 *
 * Nothing is written without three things being true at once: writes are enabled in
 * configuration, the change carries an explicit approval, and the file on disk still
 * matches what was read when the preview was generated. The last condition is what
 * stops a stale preview from silently clobbering someone else's edit.
 */

export interface ImplementationOptions {
  /** Master switch. False means audit only, regardless of approvals. */
  allowWrites: boolean;
  /** Who approved. Recorded on the change for the audit trail. */
  approver?: string;
  /** Apply only changes whose fix is marked safe for automation. */
  automatedOnly?: boolean;
}

export class ImplementationEngine {
  private repo: RepoProfile | null = null;
  /** Content read at preview time, keyed by absolute path. */
  private previewBaseline = new Map<string, string>();

  constructor(private ctx: AnalysisContext, private store: GraphStore, private log: Logger) {
    if (ctx.config.repoPath) {
      this.repo = detectRepo(ctx.config.repoPath, log);
    }
  }

  get repoProfile(): RepoProfile | null {
    return this.repo;
  }

  /**
   * Turns recommendations into concrete changes with previews.
   * This is a read-only operation: files are read, never written.
   */
  propose(recommendations: Recommendation[]): Change[] {
    const changes: Change[] = [];
    for (const rec of recommendations) {
      if (!rec.fix) continue;
      const change = this.buildChange(rec, rec.fix);
      changes.push(change);
      this.store.saveChange(change);
    }
    this.log.info(
      `proposed ${changes.length} change(s); ` +
      `${changes.filter((c) => c.patch).length} have a reviewable patch, ` +
      `${changes.filter((c) => !c.patch).length} are instructions only`,
    );
    return changes;
  }

  private buildChange(rec: Recommendation, fix: FixSpec): Change {
    const id = `chg-${hash(rec.id, fix.kind, fix.url)}`;
    const notes: string[] = [];
    let patch: string | null = null;
    let targetFiles: string[] = [];
    let rollback: RollbackPlan = {
      method: 'manual',
      files: {},
      instructions:
        'No file-level change was generated, so there is nothing to restore automatically. ' +
        `Reverting means undoing the described change: ${describeFix(fix)}`,
    };

    if (fix.kind === 'url.change') {
      notes.push(...this.urlChangePreflight(fix));
    }

    if (this.repo && isFileEditable(fix)) {
      const page = this.ctx.site.pageByUrl.get(fix.url);
      const html = this.ctx.site.htmlByUrl.get(fix.url);
      const mapping = mapUrlToFiles(this.repo, fix.url, html);
      notes.push(`Source mapping: ${mapping.note} (confidence ${mapping.confidence.toFixed(2)})`);

      if (mapping.files.length > 0 && mapping.confidence >= 0.9) {
        const result = this.generatePatch(mapping, fix, page);
        patch = result.patch;
        targetFiles = result.files;
        rollback = result.rollback;
        if (result.note) notes.push(result.note);
      } else if (mapping.files.length > 0) {
        notes.push(
          'The source file was matched but not with enough confidence to edit automatically. ' +
          'A patch is not generated; the target value below should be applied by hand.',
        );
        targetFiles = mapping.files;
      }
    } else if (!this.repo) {
      notes.push('No repository is configured, so this change is delivered as an instruction with its exact target value.');
    }

    if (fix.requiresHuman) {
      notes.push('This change requires a human to supply or verify the value; it is never applied automatically.');
    }

    return {
      id,
      recommendationId: rec.id,
      status: patch ? 'previewed' : 'proposed',
      fix,
      patch,
      targetFiles,
      rollback,
      createdAt: Date.now(),
      appliedAt: null,
      approvedBy: null,
      notes,
    };
  }

  private generatePatch(
    mapping: UrlMapping, fix: FixSpec, page: PageProps | undefined,
  ): { patch: string | null; files: string[]; rollback: RollbackPlan; note?: string } {
    const root = this.repo!.root;
    const relPath = mapping.files[0];
    const abs = join(root, relPath);
    if (!existsSync(abs)) {
      return { patch: null, files: [], rollback: manualRollback(fix), note: `Mapped file ${relPath} no longer exists.` };
    }

    const original = readFileSync(abs, 'utf8');
    const edited = applyFixToHtml(original, fix, page);
    if (!edited.changed) {
      return {
        patch: null, files: [relPath], rollback: manualRollback(fix),
        note: `No patch generated: ${edited.reason ?? 'the edit produced no change'}.`,
      };
    }

    // Record what the file looked like when the preview was made, so apply can verify
    // the file has not moved underneath us.
    this.previewBaseline.set(abs, original);

    return {
      patch: unifiedDiff(original, edited.html, relPath),
      files: [relPath],
      rollback: {
        method: 'file-restore',
        files: { [relPath]: original },
        instructions:
          `Restores ${relPath} to the exact bytes captured before the change was applied, then ` +
          're-runs validation to confirm the site matches its previous state.',
      },
    };
  }

  /**
   * URL changes are the most destructive thing this platform can propose, so they get a
   * pre-flight that has to pass before the change is even previewed.
   */
  private urlChangePreflight(fix: FixSpec): string[] {
    const notes: string[] = [];
    const oldUrl = fix.url;
    const newUrl = typeof fix.after === 'string' ? fix.after : String((fix.after as any)?.url ?? '');
    const page = this.ctx.site.pageByUrl.get(oldUrl);
    const metrics = this.ctx.siteGraph.metrics.get(oldUrl);

    notes.push(`OLD URL: ${oldUrl}`);
    notes.push(`NEW URL: ${newUrl || '(not specified)'}`);
    notes.push(`REDIRECT: a permanent 301 from ${oldUrl} to ${newUrl} must be in place before the old URL stops serving.`);

    if (!page) {
      notes.push('RISK: HIGH - the current URL was not successfully crawled, so its present state is unknown.');
    } else {
      notes.push(`CURRENT STATE: HTTP ${page.status}, ${page.indexable ? 'indexable' : `not indexable (${page.indexabilityReasons.join(', ')})`}.`);
      if (page.canonical && page.canonical !== oldUrl) {
        notes.push(`RISK: this URL already canonicalizes to ${page.canonical}; changing it may compound an existing canonicalization decision.`);
      }
    }
    if (metrics) {
      notes.push(
        `INTERNAL LINKS: ${metrics.inLinks} inbound (${metrics.contextualInLinks} contextual). ` +
        'Every one must be updated to the new URL in the same change, or they become redirect hops.',
      );
      notes.push(`INTERNAL PROMINENCE: rank ${metrics.prominenceRank} of ${this.ctx.siteGraph.metrics.size} by internal link structure.`);
    }
    const inSitemap = this.ctx.crawl.sitemapEntries.some((e) => e.loc === oldUrl);
    notes.push(`SITEMAP: the old URL ${inSitemap ? 'is listed and must be replaced' : 'is not listed'}.`);

    notes.push(
      'EXTERNAL LINKS: not available. This platform does not have backlink data, so it cannot tell ' +
      'you what links to this URL from other sites. Check that before proceeding.',
    );
    notes.push(
      'TRAFFIC AND RANKING DATA: not available. No analytics or search-console source is connected, ' +
      'so the value of the existing URL is unknown to this platform.',
    );
    notes.push(
      'VALIDATION: after the change, the old URL must return 301 to the new URL, the new URL must ' +
      'return 200 and be indexable, and no internal link may still point at the old URL.',
    );
    notes.push('This change is never applied automatically under any configuration.');
    return notes;
  }

  // -- approval and application --------------------------------------------

  approve(changeId: string, approver: string): Change {
    const change = this.store.getRecord<Change>('change', changeId);
    if (!change) throw new Error(`Unknown change: ${changeId}`);
    if (change.status === 'applied' || change.status === 'validated') {
      throw new Error(`Change ${changeId} has already been applied.`);
    }
    if (change.fix.kind === 'url.change') {
      throw new Error(
        `Change ${changeId} alters a live URL. URL changes are not approvable through this ` +
        'interface; they must be planned and executed deliberately using the pre-flight report.',
      );
    }
    const updated: Change = { ...change, status: 'approved', approvedBy: approver };
    updated.notes = [...change.notes, `Approved by ${approver} at ${new Date().toISOString()}.`];
    this.store.saveChange(updated);
    this.log.info(`change ${changeId} approved by ${approver}`);
    return updated;
  }

  reject(changeId: string, reason: string): Change {
    const change = this.store.getRecord<Change>('change', changeId);
    if (!change) throw new Error(`Unknown change: ${changeId}`);
    const updated: Change = {
      ...change,
      status: 'rejected' as ChangeStatus,
      notes: [...change.notes, `Rejected: ${reason}`],
    };
    this.store.saveChange(updated);
    return updated;
  }

  /**
   * Writes an approved change to disk.
   * Refuses unless writes are enabled, the change is approved, and the file is unchanged
   * since the preview was generated.
   */
  apply(changeId: string, opts: ImplementationOptions): Change {
    const change = this.store.getRecord<Change>('change', changeId);
    if (!change) throw new Error(`Unknown change: ${changeId}`);

    const refuse = (reason: string): Change => {
      const updated: Change = { ...change, status: 'failed', notes: [...change.notes, `Not applied: ${reason}`] };
      this.store.saveChange(updated);
      this.log.warn(`refusing to apply ${changeId}: ${reason}`);
      return updated;
    };

    if (!opts.allowWrites) return refuse('writes are disabled; the platform is running in audit mode.');
    if (change.status !== 'approved') return refuse(`change is "${change.status}", not "approved".`);
    if (change.fix.requiresHuman && opts.automatedOnly) {
      return refuse('change is marked as requiring a human and automated-only mode is active.');
    }
    if (change.fix.kind === 'url.change') return refuse('URL changes are never applied by this engine.');
    if (!change.patch || change.targetFiles.length === 0) {
      return refuse('no file-level patch exists for this change; it must be applied through the site\'s own tooling.');
    }
    if (!this.repo) return refuse('no repository is configured.');

    const relPath = change.targetFiles[0];
    const abs = resolve(this.repo.root, relPath);
    if (!abs.startsWith(this.repo.root)) return refuse(`refusing to write outside the repository root: ${relPath}`);
    if (!existsSync(abs)) return refuse(`target file no longer exists: ${relPath}`);

    const current = readFileSync(abs, 'utf8');
    const baseline = change.rollback.files[relPath];
    if (baseline !== undefined && baseline !== null && current !== baseline) {
      return refuse(
        `${relPath} has changed since this patch was previewed. Re-run the audit to regenerate the ` +
        'patch against the current file rather than overwriting someone else\'s edit.',
      );
    }

    const page = this.ctx.site.pageByUrl.get(change.fix.url);
    const edited = applyFixToHtml(current, change.fix, page);
    if (!edited.changed) return refuse(edited.reason ?? 'the edit produced no change against the current file.');

    writeFileSync(abs, edited.html, 'utf8');
    const updated: Change = {
      ...change,
      status: 'applied',
      appliedAt: Date.now(),
      notes: [...change.notes, `Applied to ${relPath} at ${new Date().toISOString()}.`],
    };
    this.store.saveChange(updated);
    this.log.info(`applied change ${changeId} to ${relPath}`);
    return updated;
  }

  /** Restores the exact bytes captured before the change was applied. */
  rollback(changeId: string): Change {
    const change = this.store.getRecord<Change>('change', changeId);
    if (!change) throw new Error(`Unknown change: ${changeId}`);
    if (change.rollback.method !== 'file-restore') {
      throw new Error(
        `Change ${changeId} has no automated rollback. ${change.rollback.instructions}`,
      );
    }
    if (!this.repo) throw new Error('No repository is configured, so files cannot be restored.');

    const restored: string[] = [];
    for (const [relPath, original] of Object.entries(change.rollback.files)) {
      if (original === null) continue;
      const abs = resolve(this.repo.root, relPath);
      if (!abs.startsWith(this.repo.root)) {
        throw new Error(`Refusing to restore a path outside the repository root: ${relPath}`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, original, 'utf8');
      restored.push(relPath);
    }
    const updated: Change = {
      ...change,
      status: 'rolled-back',
      notes: [...change.notes, `Rolled back ${restored.join(', ')} at ${new Date().toISOString()}.`],
    };
    this.store.saveChange(updated);
    this.log.info(`rolled back change ${changeId} (${restored.length} file(s) restored)`);
    return updated;
  }

  /** Writes proposed non-file artifacts (robots.txt, sitemap.xml) to the output directory. */
  exportArtifacts(changes: Change[], outDir: string): string[] {
    const written: string[] = [];
    mkdirSync(outDir, { recursive: true });
    for (const change of changes) {
      if (change.fix.kind === 'robots.txt' && typeof change.fix.after === 'string') {
        const p = join(outDir, 'robots.proposed.txt');
        writeFileSync(p, change.fix.after, 'utf8');
        written.push(p);
      }
      if (change.fix.kind === 'sitemap.xml' && Array.isArray(change.fix.after)) {
        const p = join(outDir, 'sitemap.proposed.xml');
        writeFileSync(p, renderSitemap(change.fix.after as string[]), 'utf8');
        written.push(p);
      }
    }
    return written;
  }
}

// ---------------------------------------------------------------------------

function isFileEditable(fix: FixSpec): boolean {
  return ![
    'robots.txt', 'sitemap.xml', 'redirect.add', 'url.change', 'content.manual',
    'link.fix-broken', 'image.alt',
  ].includes(fix.kind);
}

function applyFixToHtml(html: string, fix: FixSpec, page: PageProps | undefined): HtmlEditResult {
  const after = fix.after;
  switch (fix.kind) {
    case 'meta.title':
      return typeof after === 'string'
        ? setTitle(html, after)
        : { html, changed: false, reason: 'no title value was supplied' };
    case 'meta.description':
      return typeof after === 'string'
        ? setMetaByName(html, 'description', after)
        : { html, changed: false, reason: 'no description value was supplied' };
    case 'meta.canonical': {
      const href = typeof after === 'string' ? after : page?.url;
      return href
        ? setCanonical(html, href)
        : { html, changed: false, reason: 'no canonical URL could be determined' };
    }
    case 'meta.robots':
      return typeof after === 'string'
        ? setMetaByName(html, 'robots', after)
        : { html, changed: false, reason: 'no robots value was supplied' };
    case 'meta.viewport':
      return typeof after === 'string'
        ? setMetaByName(html, 'viewport', after)
        : { html, changed: false, reason: 'no viewport value was supplied' };
    case 'meta.lang':
      return typeof after === 'string'
        ? setHtmlLang(html, after)
        : { html, changed: false, reason: 'no language value was supplied' };
    case 'meta.og': {
      if (!after || typeof after !== 'object') {
        return { html, changed: false, reason: 'no Open Graph values were supplied' };
      }
      let current = html;
      let changed = false;
      for (const [k, v] of Object.entries(after as Record<string, string>)) {
        const r = setMetaByProperty(current, k, v);
        current = r.html;
        changed = changed || r.changed;
      }
      return { html: current, changed, reason: changed ? undefined : 'values already present' };
    }
    case 'schema.add':
      return after
        ? addJsonLd(html, after)
        : { html, changed: false, reason: 'no structured data was supplied' };
    case 'link.add-internal': {
      // Only a retarget is safe to automate; inserting a new link into prose is not.
      if (typeof fix.before === 'string' && typeof after === 'string') {
        return retargetLink(html, fix.before, after);
      }
      return {
        html, changed: false,
        reason: 'inserting a new contextual link requires choosing where it belongs in the text, ' +
          'which is an editorial decision',
      };
    }
    case 'link.anchor':
      return {
        html, changed: false,
        reason: 'anchor text rewrites are proposed rather than applied, since the phrasing has to ' +
          'fit the surrounding sentence',
      };
    default:
      return { html, changed: false, reason: `no automated edit is defined for ${fix.kind}` };
  }
}

function manualRollback(fix: FixSpec): RollbackPlan {
  return {
    method: 'manual',
    files: {},
    instructions: `Revert by undoing: ${describeFix(fix)}`,
  };
}

function describeFix(fix: FixSpec): string {
  return `${fix.kind} on ${fix.url} (from ${JSON.stringify(fix.before)?.slice(0, 80)} to ${JSON.stringify(fix.after)?.slice(0, 80)})`;
}

export function renderSitemap(urls: string[]): string {
  const now = new Date().toISOString().slice(0, 10);
  const entries = urls
    .map((u) => `  <url>\n    <loc>${escapeXml(u)}</loc>\n    <lastmod>${now}</lastmod>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
