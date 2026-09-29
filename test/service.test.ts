import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApi, projectsSchema } from '../src/service/api.js';
import { fetchUrl } from '../src/crawler/http.js';
import { startFixtureServer } from './server.js';

test('project API and real stdio MCP complete an isolated on-page audit', { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer(0);
  const directory = mkdtempSync(join(tmpdir(), 'seo-service-'));
  const key = 'a'.repeat(40);
  const projects = projectsSchema.parse([
    { id: 'one', name: 'One', url: fixture.origin, apiKey: key, maxPages: 20 },
    { id: 'two', name: 'Two', url: fixture.origin, apiKey: 'b'.repeat(40), maxPages: 20 },
  ]);
  let api = createApi(projects, directory);
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done));
  const address = api.server.address() as { port: number };
  let base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, data?: unknown, token = key) => fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    assert.equal((await request('/v1/projects', undefined, 'bad')).status, 401);
    assert.equal((await fetch(base + '/v1/projects', { headers: { authorization: key } })).status, 401);
    assert.equal((await request('/v1/projects/one/audits', { value: 'x'.repeat(9000) })).status, 413);
    assert.equal((await fetch(base + '/v1/projects/one/audits', {
      method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{invalid',
    })).status, 400);
    assert.equal((await request('/v1/projects/two/audits')).status, 404);
    assert.equal((await request('/v1/projects/one/report')).status, 404);
    assert.equal((await request('/v1/projects/one/audits', { maxPages: 21 })).status, 422);
    assert.equal((await request('/v1/projects/one/audits', { targetUrl: 'http://other.test' })).status, 422);
    assert.equal((await request('/v1/projects/one/audits', null)).status, 422);
    assert.equal((await request('/')).status, 404);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../plugins/on-page-seo/mcp-server.mjs', import.meta.url))],
      env: { ...process.env as Record<string, string>, SEO_API_URL: base, SEO_API_KEY: key }, stderr: 'pipe',
    }));
    assert.equal((await client.listTools()).tools.length, 5);
    const assigned = await client.callTool({ name: 'seo_list_projects', arguments: {} });
    assert.equal(JSON.stringify(assigned).includes(key), false);
    const start = await client.callTool({ name: 'seo_start_audit', arguments: { projectId: 'one', maxPages: 20 } });
    assert.ok(!start.isError, JSON.stringify(start));
    const job = start.structuredContent as { id: string };
    assert.ok(job.id);
    assert.equal((await request('/v1/projects/one/audits', {})).status, 409);
    assert.equal((await request(`/v1/projects/one/audits/${job.id}/report`)).status, 409);
    let status: any;
    for (let attempt = 0; attempt < 150; attempt++) {
      status = await (await request(`/v1/projects/one/audits/${job.id}`)).json();
      if (status.status !== 'running') break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    const output = await (await request('/v1/projects/one/report')).json() as any;
    assert.equal(output.report.meta.profile, 'on-page');
    assert.ok(output.report.observed.issues.length > 0);
    for (const issue of output.report.observed.issues)
      assert.ok(output.report.meta.categories.includes(issue.category));
    assert.equal('aeo' in output.report.analysis.scores, false);
    assert.equal(existsSync(join(directory, 'one/jobs', job.id, 'out/dashboard.html')), false);
    const result = await client.callTool({ name: 'seo_get_report', arguments: { projectId: 'one', section: 'recommendations', limit: 1 } });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = result.structuredContent as any;
    assert.equal(data.data.items.length, 1);
    const denied = await client.callTool({ name: 'seo_get_report', arguments: { projectId: 'two' } });
    assert.equal(denied.isError, true);
    await client.close();
    await api.stop();
    api = createApi(projects, directory);
    await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;
    assert.equal((await request(`/v1/projects/one/audits/${job.id}/report`)).status, 200);
  } finally {
    await client.close();
    await api.stop();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('crawler refuses unapproved redirect origins before making a request', async () => {
  let hits = 0;
  const destination = createServer((_req, res) => { hits++; res.end('private'); });
  await new Promise<void>(done => destination.listen(0, '127.0.0.1', done));
  const forbidden = `http://127.0.0.1:${(destination.address() as any).port}`;
  const source = createServer((_req, res) => { res.writeHead(302, { location: forbidden }); res.end(); });
  await new Promise<void>(done => source.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(source.address() as any).port}`;
  try {
    const result = await fetchUrl(origin, { allowedOrigins: [origin], userAgent: 'test', timeoutMs: 1000, maxRetries: 0, maxBodyBytes: 1000 });
    assert.match(result.error!, /approved/);
    assert.equal(hits, 0);
  } finally {
    await Promise.all([source, destination].map(s => new Promise<void>(done => s.close(() => done()))));
  }
});

test('project assignments reject reused credentials and path traversal', () => {
  const p = { id: 'one', name: 'One', url: 'https://example.com', apiKey: 'x'.repeat(40) };
  assert.equal(projectsSchema.safeParse([p, { ...p, id: 'two' }]).success, false);
  assert.equal(projectsSchema.safeParse([{ ...p, id: '../one' }]).success, false);
});

test('worker timeout persists a failed job without a report', { timeout: 10_000 }, async () => {
  const fixture = await startFixtureServer(0);
  const directory = mkdtempSync(join(tmpdir(), 'seo-timeout-'));
  const key = 'c'.repeat(40);
  const api = createApi(projectsSchema.parse([{ id: 'one', name: 'One', url: fixture.origin, apiKey: key }]), directory, 20);
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(api.server.address() as any).port}/v1/projects/one/audits`;
  const headers = { authorization: `Bearer ${key}` };
  try {
    const job = await (await fetch(base, { method: 'POST', headers, body: '{}' })).json() as any;
    let state: any;
    for (let i = 0; i < 50; i++) {
      state = await (await fetch(`${base}/${job.id}`, { headers })).json();
      if (state.status === 'failed') break;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.equal(state.status, 'failed');
    assert.match(state.error, /time limit/);
    assert.equal((await fetch(`${base}/${job.id}/report`, { headers })).status, 409);
  } finally {
    await api.stop();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
