import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startFixtureServer, type FixtureServer } from './server.js';
import { defaultConfig, type PlatformConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { runAudit, type AuditResult } from '../src/pipeline/pipeline.js';
import { ImplementationEngine } from '../src/implementation-engine/implementation-engine.js';
import { ValidationEngine } from '../src/validation-engine/validation-engine.js';
import { familyOf } from '../src/core/problems.js';

/**
 * End-to-end: a real crawl of a real HTTP server serving a site with deliberate defects,
 * through every stage of the pipeline.
 *
 * The fixture site is built to contain each class of problem the platform claims to
 * find, so a regression in any engine shows up as a failing assertion here rather than
 * as a quietly emptier report.
 */

const FIXTURE_SRC = fileURLToPath(new URL('./fixtures/site', import.meta.url));

let server: FixtureServer;
let workDir: string;
let config: PlatformConfig;
let result: AuditResult;

function familiesIn(res: AuditResult): Set<string> {
  return new Set(res.recommendations.recommendations.map((r) => familyOf(r.problemKey)));
}

before(async () => {
  server = await startFixtureServer(8799);
  workDir = mkdtempSync(join(tmpdir(), 'uwoe-e2e-'));
  config = defaultConfig(server.origin, { logLevel: 'silent' });
  config.dbPath = join(workDir, 'graph.db');
  config.rawDir = join(workDir, 'raw');
  config.outDir = join(workDir, 'out');
  config.crawl.maxPages = 60;
  config.crawl.concurrency = 4;
  config.crawl.politenessDelayMs = 0;
  result = await runAudit(config, { logger: createLogger('silent') });
});

after(async () => {
  // Guarded: if before() failed, these were never assigned, and an unguarded teardown
  // would replace the real failure with a confusing one.
  result?.store.close();
  await server?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('discovery', () => {
  test('crawls the site and normalizes its pages', () => {
    assert.ok(result.context.site.pages.length >= 8, `expected >=8 pages, got ${result.context.site.pages.length}`);
    const urls = result.context.site.pages.map((p) => p.url);
    assert.ok(urls.some((u) => u.endsWith('/faq')));
    assert.ok(urls.some((u) => u.includes('/services/boundary-survey')));
  });

  test('reads robots.txt and follows its sitemap reference', () => {
    assert.equal(result.context.crawl.robots.status, 200);
    assert.ok(result.context.crawl.sitemapEntries.length >= 8);
  });

  test('discovers the orphan page through the sitemap alone', () => {
    const orphan = result.context.site.pages.find((p) => p.url.endsWith('/orphan-guide'));
    assert.ok(orphan, 'orphan page was not crawled');
    assert.equal(result.context.siteGraph.metrics.get(orphan!.url)?.inLinks, 0);
  });

  test('records raw responses separately from the normalized model', () => {
    assert.ok(existsSync(join(workDir, 'raw', 'index.jsonl')));
    const raw = readFileSync(join(workDir, 'raw', 'index.jsonl'), 'utf8').trim().split('\n');
    assert.ok(raw.length >= result.context.site.pages.length);
    // Every normalized page must trace back to a stored response body.
    const record = JSON.parse(raw[0]);
    assert.ok('bodyFile' in record && 'fetchedAt' in record);
  });

  test('captures the redirect and the 404 as auditable facts', () => {
    // A redirected response is normalized under its destination, so the fact that the
    // requested URL redirected is kept in its own index rather than on the Page.
    const redirects = result.context.site.redirects;
    assert.ok(redirects.size >= 1, 'no redirect was recorded');
    const pricing = redirects.get(`${server.origin}/pricing`);
    assert.ok(pricing, '/pricing was not recorded as a redirect');
    assert.ok(pricing!.finalUrl.endsWith('/services'));
    assert.equal(pricing!.status, 301);

    const errors = result.context.site.nonPageRecords.filter((r) => r.status >= 400);
    assert.ok(errors.length >= 1, 'the broken link target was not recorded as an error');
  });

  test('normalizes a redirected fetch under its destination without duplicating the page', () => {
    const services = result.context.site.pages.filter((p) => p.url === `${server.origin}/services`);
    assert.equal(services.length, 1, 'the redirect destination was normalized twice');
  });
});

describe('understanding', () => {
  test('builds a site graph with depth and link structure', () => {
    const sg = result.context.siteGraph;
    assert.ok(sg.homepage, 'homepage was not identified');
    const boundary = [...sg.metrics.values()].find((m) => m.url.includes('boundary-survey'));
    assert.ok(boundary);
    assert.equal(boundary!.depth, 1, 'boundary survey should be one click from home');
    assert.ok(boundary!.inLinks >= 1);
  });

  test('detects the near-duplicate blog pair', () => {
    const dupes = result.context.siteGraph.duplicateClusters;
    assert.ok(dupes.length >= 1, 'no duplicate cluster found');
    const cluster = dupes.find((d) => d.urls.some((u) => u.includes('surveyor')));
    assert.ok(cluster, 'the duplicated blog pair was not clustered');
    assert.ok(cluster!.urls.length >= 2);
  });

  test('extracts the organization and its declared services without inventing facts', () => {
    const eg = result.context.entityGraph;
    assert.ok(eg.primaryOrganization, 'no primary organization identified');
    assert.equal(eg.primaryOrganization!.name, 'Northwind Survey Co');
    assert.ok(eg.primaryOrganization!.origins.includes('schema'));

    const services = eg.entities.filter((e) => e.nodeClass === 'Service');
    assert.ok(services.some((s) => s.name === 'Boundary Survey'));

    // Every entity attribute must carry evidence pointing at where it was read.
    for (const e of eg.entities) {
      assert.ok(e.evidence.length > 0, `entity ${e.name} has no evidence`);
      assert.ok(e.evidence.every((ev) => ev.locator), `entity ${e.name} has evidence without a locator`);
    }
  });

  test('extracts questions and their answers from the FAQ page', () => {
    const faq = [...result.context.content.byUrl.values()].find((m) => m.url.endsWith('/faq'));
    assert.ok(faq);
    assert.ok(faq!.questions.length >= 4, `expected 4+ questions, got ${faq!.questions.length}`);
    assert.ok(faq!.questions.every((q) => q.hasDirectAnswer), 'FAQ answers were not detected');
  });

  test('inventories what the site already implements before recommending anything', () => {
    const inv = result.context.inventory;
    assert.ok(inv.present['robots-txt'], 'robots.txt was not inventoried');
    assert.ok(inv.present['xml-sitemap'], 'sitemap was not inventoried');
    assert.ok(inv.present['canonical-tags'], 'canonical tags were not inventoried');
    assert.ok(inv.present['schema:Organization'], 'existing Organization schema was not inventoried');
    assert.ok(inv.present['faq-content'], 'existing FAQ content was not inventoried');
  });

  test('detects the duplicated canonical as a conflicting implementation', () => {
    const conflict = result.context.inventory.conflicts.find((c) => c.capability === 'canonical-tags');
    assert.ok(conflict, 'the double canonical on /about was not detected');
    assert.ok(conflict!.urls.some((u) => u.includes('/about')));
  });
});

describe('analysis', () => {
  test('every engine contributes signals', () => {
    const engines = new Set(result.signals.map((s) => s.engine));
    for (const expected of ['seo', 'schema', 'internal-link', 'aeo', 'aio', 'geo']) {
      assert.ok(engines.has(expected as never), `engine ${expected} produced no signals`);
    }
  });

  test('finds the defects the fixture was built to contain', () => {
    const families = familiesIn(result);
    const expected = [
      'BROKEN_INTERNAL_LINK',      // /services/missing-page
      'INTERNAL_LINK_TO_REDIRECT', // /pricing -> /services
      'ORPHAN_PAGE',               // /orphan-guide
      'TITLE_DUPLICATE',           // "Services" used twice
      'DUPLICATE_CONTENT',         // the blog pair
      'IMAGE_ALT_MISSING',         // crew.jpg
      'CANONICAL_CONFLICT',        // two canonicals on /about
      'SCHEMA_CONTRADICTS_CONTENT',// FAQ markup on /about with no visible Q&A
      'HEADING_ORDER',             // h1 -> h4 in the blog post
      'THIN_CONTENT',              // /about
    ];
    const missing = expected.filter((f) => !families.has(f));
    assert.deepEqual(missing, [], `these expected problems were not detected: ${missing.join(', ')}`);
  });

  test('flags fabricated-looking review markup as contradicting the page', () => {
    const rec = result.recommendations.recommendations.find(
      (r) => familyOf(r.problemKey) === 'SCHEMA_CONTRADICTS_CONTENT');
    assert.ok(rec);
    assert.ok(rec!.affectedUrls.some((u) => u.includes('/about')));
    assert.equal(rec!.severity, 'high');
  });

  test('does not report problems the site does not have', () => {
    const families = familiesIn(result);
    assert.ok(!families.has('ROBOTS_MISSING'), 'reported a missing robots.txt that exists');
    assert.ok(!families.has('SITEMAP_MISSING'), 'reported a missing sitemap that exists');
    assert.ok(!families.has('ORGANIZATION_IDENTITY_MISSING'), 'reported missing org identity that is declared');
  });
});

describe('unified recommendations', () => {
  test('merges signals from different engines into one recommendation', () => {
    const merged = result.recommendations.recommendations.filter(
      (r) => new Set(r.contributingSignals.map((s) => s.engine)).size > 1);
    assert.ok(merged.length >= 1,
      'no recommendation was corroborated across engines, so deduplication is not working');
    for (const m of merged) {
      assert.ok(m.contributingSignals.length >= 2);
      assert.ok(m.detail.includes('independently detected'));
    }
  });

  test('produces exactly one recommendation per problem key', () => {
    const keys = result.recommendations.recommendations.map((r) => r.problemKey);
    assert.equal(keys.length, new Set(keys).size, 'duplicate problem keys reached the output');
  });

  test('every recommendation rests on fact, never on inference alone', () => {
    for (const r of result.recommendations.recommendations) {
      assert.ok(r.evidence.length > 0, `${r.id} has no evidence`);
      // `observed` is read from the crawled bytes; `derived` is computed
      // deterministically from them. Either is a factual basis. Heuristic judgement
      // alone is not, and must never reach the recommendation queue.
      assert.ok(r.evidence.some((e) => e.kind === 'observed' || e.kind === 'derived'),
        `${r.id} rests on inference alone and should not have become a recommendation`);
    }
  });

  test('inference-only findings are reported as observations but never as actions', () => {
    const recKeys = new Set(result.recommendations.recommendations.map((r) => r.problemKey));
    const inferenceOnly = result.signals.filter(
      (s) => s.evidence.length > 0 && s.evidence.every((e) => e.kind === 'inferred'));
    for (const s of inferenceOnly) {
      assert.ok(!recKeys.has(s.problemKey),
        `${s.rule} is supported only by inference yet produced a recommendation`);
    }
  });

  test('every recommendation declares validation and rollback', () => {
    for (const r of result.recommendations.recommendations) {
      assert.ok(r.validationRule.startsWith('VALIDATE.'), `${r.id} has no validation rule`);
      assert.ok(r.validationMethod.length > 20, `${r.id} has no validation method`);
      assert.ok(r.rollbackMethod.length > 20, `${r.id} has no rollback method`);
    }
  });

  test('the queue orders dependencies before the items they block', () => {
    const position = new Map<string, number>();
    result.recommendations.queue.forEach((r, i) => position.set(r.id, i));
    for (const rec of result.recommendations.queue) {
      for (const dep of rec.dependencies) {
        if (!position.has(dep)) continue;
        assert.ok(position.get(dep)! < position.get(rec.id)!,
          `${rec.id} is queued before its dependency ${dep}`);
      }
    }
  });

  test('recommendations name the existing capabilities they must not disturb', () => {
    const withExisting = result.recommendations.recommendations.filter((r) => r.respectsExisting.length > 0);
    assert.ok(withExisting.length > 0, 'no recommendation acknowledged the existing setup');
  });

  test('content-authoring fixes are never marked auto-applicable', () => {
    for (const r of result.recommendations.recommendations) {
      if (!r.fix) continue;
      if (['content.manual', 'image.alt', 'url.change'].includes(r.fix.kind)) {
        assert.equal(r.fix.requiresHuman, true, `${r.fix.kind} on ${r.id} must require a human`);
      }
    }
  });
});

describe('implementation safety', () => {
  let repoDir: string;

  before(() => {
    repoDir = join(workDir, 'repo');
    cpSync(FIXTURE_SRC, repoDir, { recursive: true });
  });

  test('audit mode writes nothing to the site', () => {
    for (const c of result.changes) {
      assert.notEqual(c.status, 'applied');
      assert.equal(c.appliedAt, null);
    }
  });

  test('generates a reviewable patch against real source files', async () => {
    const cfg = { ...config, repoPath: repoDir, allowWrites: false };
    const ctx = { ...result.context, config: cfg };
    const engine = new ImplementationEngine(ctx, result.store, createLogger('silent'));

    const titleRec = result.recommendations.recommendations.find(
      (r) => r.fix?.kind === 'meta.title' || r.fix?.kind === 'meta.canonical' || r.fix?.kind === 'meta.description');
    assert.ok(titleRec, 'no metadata fix was proposed');

    const changes = engine.propose([titleRec!]);
    assert.equal(changes.length, 1);
    const change = changes[0];
    assert.ok(change.notes.some((n) => n.includes('Source mapping')));
    if (change.patch) {
      assert.ok(change.patch.includes('--- a/'));
      assert.equal(change.rollback.method, 'file-restore');
      assert.ok(Object.keys(change.rollback.files).length > 0,
        'a file patch was generated with no captured original to restore');
    }
  });

  test('refuses to apply without writes enabled', () => {
    const cfg = { ...config, repoPath: repoDir, allowWrites: false };
    const engine = new ImplementationEngine({ ...result.context, config: cfg }, result.store, createLogger('silent'));
    const change = result.store.changes().find((c) => c.patch);
    if (!change) return;
    const after = engine.apply(change.id, { allowWrites: false });
    assert.equal(after.status, 'failed');
    assert.ok(after.notes.some((n) => n.includes('writes are disabled')));
  });

  test('refuses to apply a change that was never approved', () => {
    const cfg = { ...config, repoPath: repoDir, allowWrites: true };
    const engine = new ImplementationEngine({ ...result.context, config: cfg }, result.store, createLogger('silent'));
    const change = result.store.changes().find((c) => c.patch && c.status !== 'approved');
    if (!change) return;
    const after = engine.apply(change.id, { allowWrites: true });
    assert.equal(after.status, 'failed');
    assert.ok(after.notes.some((n) => n.includes('not "approved"')));
  });

  test('applies an approved change and restores it exactly on rollback', () => {
    const cfg = { ...config, repoPath: repoDir, allowWrites: true };
    const engine = new ImplementationEngine({ ...result.context, config: cfg }, result.store, createLogger('silent'));

    const target = result.context.site.pages.find((p) => p.url.includes('/services/topographic-survey'));
    assert.ok(target);
    const proposed = engine.propose([{
      ...result.recommendations.recommendations[0],
      id: 'rec-test-title',
      fix: {
        kind: 'meta.title', url: target!.url,
        before: target!.title,
        after: 'Topographic Survey Services | Northwind Survey Co',
        rationale: 'test', requiresHuman: false,
      },
    }]);
    const change = proposed[0];
    assert.ok(change.patch, 'expected a patch for a static HTML file');
    const file = join(repoDir, change.targetFiles[0]);
    const original = readFileSync(file, 'utf8');

    engine.approve(change.id, 'test-approver');
    const applied = engine.apply(change.id, { allowWrites: true });
    assert.equal(applied.status, 'applied', applied.notes.join(' | '));
    const afterWrite = readFileSync(file, 'utf8');
    assert.ok(afterWrite.includes('Topographic Survey Services'));
    assert.notEqual(afterWrite, original);

    const rolledBack = engine.rollback(change.id);
    assert.equal(rolledBack.status, 'rolled-back');
    assert.equal(readFileSync(file, 'utf8'), original, 'rollback did not restore the file byte-for-byte');
  });

  test('refuses to apply a stale patch when the file changed underneath it', () => {
    const cfg = { ...config, repoPath: repoDir, allowWrites: true };
    const engine = new ImplementationEngine({ ...result.context, config: cfg }, result.store, createLogger('silent'));
    const target = result.context.site.pages.find((p) => p.url.includes('/services/boundary-survey'));
    const proposed = engine.propose([{
      ...result.recommendations.recommendations[0],
      id: 'rec-test-stale',
      fix: {
        kind: 'meta.description', url: target!.url,
        before: null, after: 'A new description written for this test.',
        rationale: 'test', requiresHuman: false,
      },
    }]);
    const change = proposed[0];
    if (!change.patch) return;

    engine.approve(change.id, 'test-approver');
    // Simulate someone else editing the file between preview and apply.
    const file = join(repoDir, change.targetFiles[0]);
    const current = readFileSync(file, 'utf8');
    writeFileSync(file, current.replace('<h1>', '<h1 data-edited="1">'), 'utf8');

    const applied = engine.apply(change.id, { allowWrites: true });
    assert.equal(applied.status, 'failed');
    assert.ok(applied.notes.some((n) => n.includes('has changed since this patch was previewed')));
  });

  test('never approves a URL change', () => {
    const engine = new ImplementationEngine(result.context, result.store, createLogger('silent'));
    const proposed = engine.propose([{
      ...result.recommendations.recommendations[0],
      id: 'rec-test-url',
      fix: {
        kind: 'url.change', url: `${server.origin}/about`,
        before: `${server.origin}/about`, after: `${server.origin}/about-us`,
        rationale: 'test', requiresHuman: true,
      },
    }]);
    const change = proposed[0];
    assert.ok(change.notes.some((n) => n.startsWith('OLD URL:')));
    assert.ok(change.notes.some((n) => n.startsWith('REDIRECT:')));
    assert.ok(change.notes.some((n) => n.includes('EXTERNAL LINKS: not available')));
    assert.ok(change.notes.some((n) => n.includes('TRAFFIC AND RANKING DATA: not available')));
    assert.throws(() => engine.approve(change.id, 'test'), /URL changes are not approvable/);
  });
});

describe('validation', () => {
  test('confirms a condition that holds and fails one that does not', async () => {
    const engine = new ValidationEngine(config, result.store, createLogger('silent'));

    const passing = result.recommendations.recommendations.find((r) => r.validationRule === 'VALIDATE.TITLE_PRESENT');
    const failing = result.recommendations.recommendations.find((r) => r.validationRule === 'VALIDATE.IMAGE_ALT');

    if (failing) {
      const results = await engine.validateRecommendation(failing, { maxUrls: 2 });
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.status === 'FAIL'),
        'validating an unfixed image-alt problem should fail');
      assert.ok(results[0].checks.some((c) => c.rule === 'VALIDATE.IMAGE_ALT'));
    }
    if (passing) {
      const results = await engine.validateRecommendation(passing, { maxUrls: 2 });
      assert.ok(results.length > 0);
    }
  });

  test('captures a before-state and detects a regression against it', async () => {
    const engine = new ValidationEngine(config, result.store, createLogger('silent'));
    const url = `${server.origin}/faq`;
    const before = await engine.snapshot([url]);
    assert.ok(before.get(url)?.title);

    // Pretend the page previously had structured data and an extra landmark.
    const doctored = new Map(before);
    doctored.set(url, {
      ...before.get(url)!,
      schemaTypes: ['FAQPage'],
      title: 'Previous title',
    });

    const rec = result.recommendations.recommendations[0];
    const change = result.store.changes()[0];
    if (!change) return;
    const res = await engine.validateChange(
      { ...change, fix: { ...change.fix, url } }, rec, { before: doctored });
    const regression = res.checks.find((c) => c.rule === 'VALIDATE.NO_REGRESSION');
    assert.ok(regression);
    assert.equal(regression!.status, 'FAIL');
    assert.ok(regression!.message.includes('structured-data types were lost'));
  });

  test('says plainly when a rule cannot be verified by re-crawling', async () => {
    const engine = new ValidationEngine(config, result.store, createLogger('silent'));
    const advisory = result.recommendations.recommendations.find(
      (r) => r.validationRule === 'VALIDATE.TOPIC_DEPTH' || r.validationRule === 'VALIDATE.CITATION_PRESENT'
        || r.validationRule === 'VALIDATE.DUPLICATE_RESOLVED');
    if (!advisory) return;
    const results = await engine.validateRecommendation(advisory, { maxUrls: 1 });
    const check = results[0].checks.find((c) => c.rule === advisory.validationRule);
    assert.ok(check);
    assert.equal(check!.status, 'WARNING');
    assert.ok(/human|cannot be verified/i.test(check!.message));
  });
});

describe('monitoring', () => {
  test('a second audit produces a comparable snapshot and a diff', async () => {
    const second = await runAudit(config, { logger: createLogger('silent'), skipReports: true });
    assert.ok(second.diff, 'no diff was produced on the second run');
    assert.notEqual(second.snapshot.id, result.snapshot.id);
    // An unchanged site should report no new issues.
    assert.equal(second.diff!.newIssues.length, 0,
      `unchanged site reported new issues: ${second.diff!.newIssues.map((i) => i.title).join(', ')}`);
    assert.equal(second.diff!.regressions.length, 0);
    second.store.close();
  });
});

describe('reporting', () => {
  test('does not generate a dashboard', () => {
    assert.equal(existsSync(join(config.outDir, 'dashboard.html')), false);
    assert.equal('dashboard' in result.outputs, false);
  });

  test('writes a JSON report that separates observation from recommendation', () => {
    const report = JSON.parse(readFileSync(result.outputs.json, 'utf8'));
    assert.ok(report.observed, 'no observed section');
    assert.ok(report.analysis, 'no analysis section');
    assert.ok(report.observed.inventory.present);
    assert.ok(Array.isArray(report.analysis.recommendations));
    assert.ok(report.meta.scoreDisclaimer.includes('not search rankings'));
  });

  test('scores land in range and carry their disclaimer', () => {
    for (const [name, value] of Object.entries(result.scores.scores)) {
      assert.ok(value >= 0 && value <= 100, `${name} score out of range: ${value}`);
    }
    assert.ok(result.scores.disclaimer.includes('not search rankings'));
  });
});
