#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { defaultConfig, type PlatformConfig } from './core/config.js';
import { createLogger, type LogLevel } from './core/logger.js';
import { GraphStore } from './core/store.js';
import type { Change, Recommendation } from './core/model.js';
import { runAudit, ON_PAGE_CATEGORIES } from './pipeline/pipeline.js';
import { ImplementationEngine } from './implementation-engine/implementation-engine.js';
import { ValidationEngine } from './validation-engine/validation-engine.js';
import { MonitoringEngine } from './monitoring-engine/monitoring-engine.js';

/**
 * Command-line interface.
 *
 * The default is audit: crawl, analyse, recommend, report - and change nothing.
 * Writing to the site requires both a repository and an explicit --allow-writes, and
 * even then each change must be approved individually.
 */

const HELP = `
Unified Website Optimization Engine

USAGE
  uwoe <command> [options]

COMMANDS
  audit <url>              Crawl, analyse and report. Makes no changes.
  crawl <url>              Crawl only, then print discovery statistics.
  queue <url>              Print the prioritized recommendation queue from the last audit.
  show <url> <rec-id>      Print one recommendation in full, with its evidence.
  changes <url>            List proposed changes and their approval status.
  approve <url> <chg-id>   Record approval for a change. Does not apply it.
  apply <url> <chg-id>     Apply an approved change. Requires --allow-writes and --repo.
  rollback <url> <chg-id>  Restore the files a change modified.
  validate <url> <rec-id>  Re-crawl the affected URLs and run the recommendation's validator.
  monitor <url>            Compare the two most recent snapshots for a site.

OPTIONS
  --repo <path>            Path to the site's source repository. Enables file-level patches.
  --max-pages <n>          Page budget for the crawl (default 500).
  --max-depth <n>          Maximum click depth from the seed URL (default 6).
  --concurrency <n>        Parallel requests (default 4).
  --delay <ms>             Minimum delay between requests (default 200).
  --user-agent <string>    Override the crawler user agent.
  --include <regex>        Only crawl URLs matching this pattern. Repeatable.
  --exclude <regex>        Skip URLs matching this pattern. Repeatable.
  --subdomains             Follow subdomains of the same registrable domain.
  --ignore-robots          Fetch disallowed URLs anyway and mark them as blocked.
  --allow-writes           Permit applying approved changes to files. Off by default.
  --approver <name>        Name recorded on approvals.
  --out <dir>              Output directory for the JSON report.
  --log <level>            silent | error | warn | info | debug (default info).

EXAMPLES
  uwoe audit https://example.com --max-pages 200
  uwoe audit https://example.com --repo ./site --out ./reports
  uwoe queue https://example.com
  uwoe approve https://example.com chg-1a2b3c4d --approver alex
  uwoe apply https://example.com chg-1a2b3c4d --repo ./site --allow-writes
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    i++;
    const existing = flags[key];
    if (Array.isArray(existing)) existing.push(next);
    else if (typeof existing === 'string') flags[key] = [existing, next];
    else flags[key] = next;
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}
function list(flags: Args['flags'], key: string): string[] {
  const v = flags[key];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  return [];
}
function num(flags: Args['flags'], key: string, fallback: number): number {
  const v = str(flags, key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildConfig(url: string, args: Args): PlatformConfig {
  const cfg = defaultConfig(url);
  cfg.crawl.maxPages = num(args.flags, 'max-pages', cfg.crawl.maxPages);
  cfg.crawl.maxDepth = num(args.flags, 'max-depth', cfg.crawl.maxDepth);
  cfg.crawl.concurrency = num(args.flags, 'concurrency', cfg.crawl.concurrency);
  cfg.crawl.politenessDelayMs = num(args.flags, 'delay', cfg.crawl.politenessDelayMs);
  const ua = str(args.flags, 'user-agent');
  if (ua) cfg.crawl.userAgent = ua;
  cfg.crawl.includePatterns = list(args.flags, 'include');
  cfg.crawl.excludePatterns = [...cfg.crawl.excludePatterns, ...list(args.flags, 'exclude')];
  cfg.crawl.includeSubdomains = args.flags['subdomains'] === true;
  cfg.crawl.ignoreRobotsForAudit = args.flags['ignore-robots'] === true;
  cfg.repoPath = str(args.flags, 'repo') ? resolve(str(args.flags, 'repo')!) : null;
  cfg.allowWrites = args.flags['allow-writes'] === true;
  const out = str(args.flags, 'out');
  if (out) cfg.outDir = resolve(out);
  const log = str(args.flags, 'log');
  if (log) cfg.logLevel = log as LogLevel;
  return cfg;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags['help']) {
    process.stdout.write(HELP);
    return 0;
  }

  const url = args.positional[0];
  if (!url) {
    process.stderr.write('Error: a site URL is required.\n' + HELP);
    return 2;
  }
  try {
    new URL(url);
  } catch {
    process.stderr.write(`Error: "${url}" is not a valid URL. Include the scheme, e.g. https://example.com\n`);
    return 2;
  }

  const config = buildConfig(url, args);
  const log = createLogger(config.logLevel, 'uwoe');

  switch (args.command) {
    case 'audit': return cmdAudit(config);
    case 'crawl': return cmdCrawl(config);
    case 'queue': return cmdQueue(config);
    case 'show': return cmdShow(config, args.positional[1]);
    case 'changes': return cmdChanges(config);
    case 'approve': return cmdApprove(config, args.positional[1], str(args.flags, 'approver') ?? 'cli-user');
    case 'apply': return cmdApply(config, args.positional[1]);
    case 'rollback': return cmdRollback(config, args.positional[1]);
    case 'validate': return cmdValidate(config, args.positional[1]);
    case 'monitor': return cmdMonitor(config);
    default:
      process.stderr.write(`Unknown command "${args.command}".\n${HELP}`);
      log.debug('unknown command');
      return 2;
  }
}

// ---------------------------------------------------------------------------

async function cmdAudit(config: PlatformConfig): Promise<number> {
  const result = await runAudit(config, { profile: 'on-page' });
  const s = result.scores;
  const out = process.stdout;

  out.write('\n');
  out.write(`  ${result.context.site.origin}\n`);
  out.write(`  ${'-'.repeat(Math.max(20, result.context.site.origin.length))}\n\n`);
  out.write(`  On-page ${s.scores.onPage}/100   ${result.context.site.pages.length} pages crawled\n\n`);
  for (const b of s.breakdown.filter(item => ON_PAGE_CATEGORIES.has(item.category))) {
    out.write(`  ${b.category.padEnd(26)} ${String(b.score).padStart(3)}  ${bar(b.score)}  ${b.signalCount} signal(s)\n`);
  }
  out.write(`\n  ${s.disclaimer}\n\n`);

  out.write(`  Already implemented: ${Object.keys(result.context.inventory.present).length} capabilities\n`);
  out.write(`  Conflicting implementations: ${result.context.inventory.conflicts.length}\n`);
  out.write(`  Signals: ${result.recommendations.stats.signalsIn} -> recommendations: ${result.recommendations.stats.recommendationsOut}`);
  out.write(` (${result.recommendations.stats.multiEngineFindings} corroborated across engines)\n\n`);

  out.write('  Top of the queue:\n');
  for (const rec of result.recommendations.queue.slice(0, 12)) {
    out.write(`    [P${String(rec.priority).padStart(3)}] ${rec.severity.padEnd(8)} ${rec.issue}\n`);
    out.write(`           ${rec.id}  ${rec.affectedUrls.length} URL(s)  ${rec.contributingSignals.map((x) => x.engine).join('+')}\n`);
  }
  if (result.diff) out.write(`\n  Since the last snapshot: ${result.diff.summary}\n`);
  out.write(`  JSON report: ${result.outputs.json}\n`);
  for (const a of result.outputs.artifacts) out.write(`  Proposed artifact: ${a}\n`);
  out.write('\n  Nothing was changed. Review the queue, then approve and apply individually.\n\n');

  result.store.close();
  return 0;
}

async function cmdCrawl(config: PlatformConfig): Promise<number> {
  const { Crawler } = await import('./crawler/crawler.js');
  const log = createLogger(config.logLevel, 'crawl');
  const crawler = new Crawler(config.crawl, config.rawDir, log);
  const result = await crawler.run();
  const out = process.stdout;
  out.write(`\n  Fetched ${result.stats.fetched} URL(s) from ${result.origin}\n`);
  out.write(`  ok=${result.stats.ok} redirects=${result.stats.redirects} 4xx=${result.stats.clientErrors} ` +
    `5xx=${result.stats.serverErrors} network=${result.stats.networkErrors}\n`);
  out.write(`  robots.txt: ${result.robots.fetched ? `HTTP ${result.robots.status}` : 'not available'}\n`);
  out.write(`  sitemaps: ${result.sitemaps.length} document(s), ${result.sitemapEntries.length} URL entries\n`);
  out.write(`  blocked by robots: ${result.blockedByRobots.length}\n`);
  out.write(`  discovered but not fetched: ${result.notCrawled.length}\n`);
  out.write(`  raw data: ${config.rawDir}\n\n`);
  return 0;
}

function openStore(config: PlatformConfig): GraphStore | null {
  if (!existsSync(config.dbPath)) {
    process.stderr.write(`No previous audit found for this site (${config.dbPath} does not exist).\nRun "uwoe audit <url>" first.\n`);
    return null;
  }
  return new GraphStore(config.dbPath);
}

async function cmdQueue(config: PlatformConfig): Promise<number> {
  const store = openStore(config);
  if (!store) return 1;
  const recs = store.recommendations().sort((a, b) => b.priority - a.priority);
  const out = process.stdout;
  out.write(`\n  ${recs.length} recommendation(s)\n\n`);
  for (const r of recs) {
    out.write(`  [P${String(r.priority).padStart(3)}] ${r.severity.padEnd(8)} ${r.category.padEnd(26)} ${r.issue}\n`);
    out.write(`         ${r.id}  ${r.affectedUrls.length} URL(s)  engines: ${r.contributingSignals.map((s) => s.engine).join(', ')}`);
    out.write(r.dependencies.length ? `  blocked by ${r.dependencies.length}\n` : '\n');
  }
  out.write('\n  Use "uwoe show <url> <rec-id>" for full evidence.\n\n');
  store.close();
  return 0;
}

async function cmdShow(config: PlatformConfig, recId: string | undefined): Promise<number> {
  if (!recId) {
    process.stderr.write('Error: a recommendation id is required.\n');
    return 2;
  }
  const store = openStore(config);
  if (!store) return 1;
  const rec = store.getRecord<Recommendation>('recommendation', recId);
  if (!rec) {
    process.stderr.write(`No recommendation with id ${recId}.\n`);
    store.close();
    return 1;
  }
  const out = process.stdout;
  out.write(`\n  ${rec.issue}\n  ${'-'.repeat(Math.min(78, rec.issue.length))}\n\n`);
  out.write(`  Category:     ${rec.category}\n`);
  out.write(`  Severity:     ${rec.severity}   Confidence: ${(rec.confidence * 100).toFixed(0)}%   Priority: ${rec.priority}\n`);
  out.write(`  Detected by:  ${rec.contributingSignals.map((s) => `${s.engine} (${s.rule})`).join('\n                ')}\n\n`);
  out.write(`  ${rec.detail.replace(/\n/g, '\n  ')}\n\n`);
  out.write(`  Current state:     ${rec.currentState}\n`);
  out.write(`  Recommended state: ${rec.recommendedState}\n\n`);
  if (rec.respectsExisting.length) {
    out.write(`  Must not disturb:  ${rec.respectsExisting.join(', ')}\n\n`);
  }
  out.write(`  Evidence (${rec.evidence.length}):\n`);
  for (const e of rec.evidence.slice(0, 15)) {
    out.write(`    [${e.kind}] ${e.source} @ ${e.locator}\n`);
    if (e.note) out.write(`        ${e.note}\n`);
    if (e.excerpt) out.write(`        > ${e.excerpt.slice(0, 160)}\n`);
  }
  out.write(`\n  Affected URLs (${rec.affectedUrls.length}):\n`);
  for (const u of rec.affectedUrls.slice(0, 20)) out.write(`    ${u}\n`);
  if (rec.affectedUrls.length > 20) out.write(`    ... and ${rec.affectedUrls.length - 20} more\n`);
  out.write(`\n  Implementation: ${rec.implementationMethod}\n`);
  out.write(`  Validation:     ${rec.validationMethod}\n`);
  out.write(`  Rollback:       ${rec.rollbackMethod}\n`);
  if (rec.fix) {
    out.write(`\n  Proposed change: ${rec.fix.kind} on ${rec.fix.url}\n`);
    out.write(`    before: ${JSON.stringify(rec.fix.before)?.slice(0, 200)}\n`);
    out.write(`    after:  ${JSON.stringify(rec.fix.after)?.slice(0, 400)}\n`);
    out.write(`    ${rec.fix.rationale}\n`);
    out.write(`    ${rec.fix.requiresHuman ? 'Requires a human; never applied automatically.' : 'Can be applied automatically once approved.'}\n`);
  }
  out.write('\n');
  store.close();
  return 0;
}

async function cmdChanges(config: PlatformConfig): Promise<number> {
  const store = openStore(config);
  if (!store) return 1;
  const changes = store.changes();
  const out = process.stdout;
  out.write(`\n  ${changes.length} proposed change(s)\n\n`);
  for (const c of changes) {
    out.write(`  ${c.status.padEnd(11)} ${c.id}  ${c.fix.kind.padEnd(18)} ${c.fix.url}\n`);
    if (c.targetFiles.length) out.write(`              files: ${c.targetFiles.join(', ')}\n`);
    out.write(`              patch: ${c.patch ? `${c.patch.split('\n').length} lines` : 'instruction only'}`);
    out.write(`   rollback: ${c.rollback.method}\n`);
  }
  out.write('\n');
  store.close();
  return 0;
}

async function cmdApprove(config: PlatformConfig, changeId: string | undefined, approver: string): Promise<number> {
  if (!changeId) {
    process.stderr.write('Error: a change id is required.\n');
    return 2;
  }
  const store = openStore(config);
  if (!store) return 1;
  const ctx = await minimalContext(config, store);
  const engine = new ImplementationEngine(ctx, store, createLogger(config.logLevel, 'implementation'));
  try {
    const c = engine.approve(changeId, approver);
    process.stdout.write(`\n  Change ${c.id} approved by ${approver}.\n  Apply it with: uwoe apply ${config.crawl.startUrl} ${c.id} --repo <path> --allow-writes\n\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
    return 1;
  } finally {
    store.close();
  }
}

async function cmdApply(config: PlatformConfig, changeId: string | undefined): Promise<number> {
  if (!changeId) {
    process.stderr.write('Error: a change id is required.\n');
    return 2;
  }
  if (!config.allowWrites) {
    process.stderr.write('\n  Refusing to apply: --allow-writes was not passed.\n' +
      '  This platform never writes to a site unless writes are explicitly enabled.\n\n');
    return 1;
  }
  const store = openStore(config);
  if (!store) return 1;
  const ctx = await minimalContext(config, store);
  const engine = new ImplementationEngine(ctx, store, createLogger(config.logLevel, 'implementation'));
  const result = engine.apply(changeId, { allowWrites: true, approver: 'cli' });
  const ok = result.status === 'applied';
  process.stdout.write(`\n  ${ok ? 'Applied' : 'Not applied'}: ${result.id} (${result.status})\n`);
  for (const n of result.notes.slice(-4)) process.stdout.write(`    ${n}\n`);
  if (ok) {
    process.stdout.write(`\n  Validate it with: uwoe validate ${config.crawl.startUrl} ${result.recommendationId}\n`);
    process.stdout.write(`  Roll it back with: uwoe rollback ${config.crawl.startUrl} ${result.id} --repo <path>\n`);
  }
  process.stdout.write('\n');
  store.close();
  return ok ? 0 : 1;
}

async function cmdRollback(config: PlatformConfig, changeId: string | undefined): Promise<number> {
  if (!changeId) {
    process.stderr.write('Error: a change id is required.\n');
    return 2;
  }
  const store = openStore(config);
  if (!store) return 1;
  const ctx = await minimalContext(config, store);
  const engine = new ImplementationEngine(ctx, store, createLogger(config.logLevel, 'implementation'));
  try {
    const c = engine.rollback(changeId);
    process.stdout.write(`\n  Rolled back ${c.id}. Files restored to their pre-change contents.\n\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
    return 1;
  } finally {
    store.close();
  }
}

async function cmdValidate(config: PlatformConfig, recId: string | undefined): Promise<number> {
  if (!recId) {
    process.stderr.write('Error: a recommendation id is required.\n');
    return 2;
  }
  const store = openStore(config);
  if (!store) return 1;
  const rec = store.getRecord<Recommendation>('recommendation', recId);
  if (!rec) {
    process.stderr.write(`No recommendation with id ${recId}.\n`);
    store.close();
    return 1;
  }
  const engine = new ValidationEngine(config, store, createLogger(config.logLevel, 'validation'));
  const results = await engine.validateRecommendation(rec, { maxUrls: 10 });
  const out = process.stdout;
  out.write(`\n  Validating: ${rec.issue}\n  Rule: ${rec.validationRule}\n\n`);
  for (const r of results) {
    out.write(`  ${r.status.padEnd(8)} ${r.url}\n`);
    for (const c of r.checks) out.write(`      ${c.status.padEnd(8)} ${c.rule}: ${c.message}\n`);
  }
  const worst = results.some((r) => r.status === 'FAIL') ? 'FAIL'
    : results.some((r) => r.status === 'WARNING') ? 'WARNING' : 'PASS';
  out.write(`\n  Overall: ${worst}\n\n`);
  store.close();
  return worst === 'FAIL' ? 1 : 0;
}

async function cmdMonitor(config: PlatformConfig): Promise<number> {
  const store = openStore(config);
  if (!store) return 1;
  const origin = new URL(config.crawl.startUrl).origin;
  const engine = new MonitoringEngine(store, createLogger(config.logLevel, 'monitoring'));
  const history = engine.history(origin);
  const out = process.stdout;
  out.write(`\n  ${history.length} snapshot(s) for ${origin}\n`);
  for (const s of history.slice(0, 10)) out.write(`    ${new Date(s.takenAt).toISOString()}  ${s.id}\n`);

  const diff = engine.latestDiff(origin);
  if (!diff) {
    out.write('\n  Only one snapshot exists. Run the audit again to compare.\n\n');
    store.close();
    return 0;
  }
  out.write(`\n  ${diff.summary}\n`);
  if (diff.regressions.length) {
    out.write('\n  Regressions (previously resolved, now back):\n');
    for (const r of diff.regressions) out.write(`    ${r.severity.padEnd(8)} ${r.title}\n`);
  }
  if (diff.newIssues.length) {
    out.write('\n  New issues:\n');
    for (const r of diff.newIssues.slice(0, 20)) out.write(`    ${r.severity.padEnd(8)} ${r.title} (${r.urlCount} URLs)\n`);
  }
  if (diff.resolvedIssues.length) {
    out.write('\n  Resolved:\n');
    for (const r of diff.resolvedIssues.slice(0, 20)) out.write(`    ${r.severity.padEnd(8)} ${r.title}\n`);
  }
  if (Object.keys(diff.scoreDeltas).length) {
    out.write('\n  Score changes:\n');
    for (const [k, v] of Object.entries(diff.scoreDeltas)) {
      out.write(`    ${k.padEnd(18)} ${v > 0 ? '+' : ''}${v}\n`);
    }
  }
  out.write('\n');
  store.close();
  return 0;
}

/**
 * Rebuilds just enough context for the change commands, from the stored graph rather
 * than by re-crawling. Applying an approved patch must not require another crawl.
 */
async function minimalContext(config: PlatformConfig, store: GraphStore) {
  const { createLogger: mk } = await import('./core/logger.js');
  const log = mk(config.logLevel, 'ctx');
  const pages = store.nodesOfType<Record<string, unknown>>('Page');
  const pageByUrl = new Map<string, any>();
  const htmlByUrl = new Map<string, string>();
  for (const p of pages) pageByUrl.set(String(p.props.url), p.props);

  return {
    config,
    log,
    store,
    crawl: {
      origin: new URL(config.crawl.startUrl).origin,
      sitemapEntries: [],
      records: [],
      robots: { fetched: false, sitemaps: [], raw: '', groups: [], status: null, url: '', unknownDirectives: [] },
    } as any,
    site: {
      origin: new URL(config.crawl.startUrl).origin,
      pages: [...pageByUrl.values()],
      pageByUrl,
      parsedByUrl: new Map(),
      htmlByUrl,
      nonPageRecords: [],
      websiteId: '',
    } as any,
    siteGraph: { metrics: new Map(), homepage: null } as any,
    entityGraph: { entities: [], byId: new Map(), primaryOrganization: null, unbackedMentions: [], stats: { total: 0, bySchemaBacked: 0, byClass: {} } } as any,
    content: { byUrl: new Map(), questionIndex: new Map(), stats: {} } as any,
    inventory: { present: {}, absent: [], conflicts: [] },
  };
}

function bar(score: number): string {
  const filled = Math.round(score / 5);
  return '#'.repeat(filled) + '.'.repeat(20 - filled);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`\nFatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
