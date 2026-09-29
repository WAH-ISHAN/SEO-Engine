import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.js';

test('compiled audit CLI produces a real report from HTTP pages', async () => {
  const site = await startFixtureServer(0);
  const directory = mkdtempSync(join(tmpdir(), 'tenderhub-seo-cli-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'audit', site.origin, '--max-pages', '3', '--delay', '0', '--log', 'error'], { cwd: directory });
    let errors = '';
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.stdout.resume();
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exitCode, 0, errors);
    const host = new URL(site.origin).origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
    const report = JSON.parse(readFileSync(join(directory, '.uwoe', host, 'out/report.json'), 'utf8'));
    assert.equal(report.meta.site, site.origin);
    assert.ok(report.observed.crawl.stats.ok > 0);
    assert.ok(report.analysis.scores);
  } finally {
    await site.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
