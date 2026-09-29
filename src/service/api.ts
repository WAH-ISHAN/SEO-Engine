import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';

export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(120),
  url: z.string().url().refine(value => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  }, 'Use an HTTP(S) URL without credentials or a fragment'),
  apiKey: z.string().min(32),
  maxPages: z.number().int().min(1).max(500).default(100),
}).strict();
export const projectsSchema = z.array(projectSchema).min(1).superRefine((items, ctx) => {
  if (new Set(items.map(p => p.id)).size !== items.length)
    ctx.addIssue({ code: 'custom', message: 'Project IDs must be unique' });
  if (new Set(items.map(p => p.apiKey)).size !== items.length)
    ctx.addIssue({ code: 'custom', message: 'Each project must have a different API key' });
});
type Project = z.infer<typeof projectSchema>;
type Job = { id: string; projectId: string; status: 'running' | 'completed' | 'failed';
  startedAt: string; completedAt: string | null; error: string | null; maxPages: number };
const auditInput = z.object({ maxPages: z.number().int().min(1).max(500).optional() }).strict();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApi(projects: Project[], dataDir: string, timeoutMs = 600_000) {
  projects = projectsSchema.parse(projects);
  dataDir = resolve(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  const jobDir = (p: string, j: string) => join(dataDir, p, 'jobs', j);
  function save(job: Job) {
    const path = join(jobDir(job.projectId, job.id), 'job.json');
    writeFileSync(path + '.tmp', JSON.stringify(job, null, 2));
    renameSync(path + '.tmp', path);
  }
  function jobs(project: Project): Job[] {
    const dir = join(dataDir, project.id, 'jobs');
    mkdirSync(dir, { recursive: true });
    return readdirSync(dir).filter(id => uuid.test(id)).map(id =>
      JSON.parse(readFileSync(join(dir, id, 'job.json'), 'utf8')) as Job
    ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  for (const p of projects) for (const job of jobs(p)) {
    if (job.status === 'running') save({ ...job, status: 'failed', completedAt: new Date().toISOString(), error: 'Service stopped before audit completed. Start a new audit.' });
  }
  function start(project: Project, maxPages: number): Job {
    const id = randomUUID();
    const directory = jobDir(project.id, id);
    mkdirSync(directory, { recursive: true });
    const job: Job = { id, projectId: project.id, status: 'running', startedAt: new Date().toISOString(), completedAt: null, error: null, maxPages };
    save(job);
    const inputFile = join(directory, 'input.json');
    writeFileSync(inputFile, JSON.stringify({ url: project.url, maxPages,
      dbPath: join(dataDir, project.id, 'graph.db'), rawDir: join(directory, 'raw'), outDir: join(directory, 'out') }));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), inputFile], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    children.set(project.id, child);
    let error = '';
    let timedOut = false;
    let finished = false;
    child.stderr?.on('data', chunk => { error = (error + String(chunk)).slice(-2000); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      children.delete(project.id);
      job.status = code === 0 && !timedOut && !stopping ? 'completed' : 'failed';
      job.completedAt = new Date().toISOString();
      job.error = job.status === 'completed' ? null : timedOut ? 'Audit exceeded time limit' : stopping ? 'Service stopped' : error || 'Audit worker failed';
      save(job);
    };
    child.once('error', e => { error = e.message; finish(1); });
    child.once('close', finish);
    return job;
  }
  const server = createServer(async (req, res) => {
    try {
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const project = projects.find(p => equal(token, p.apiKey));
      if (!project) return send(res, 401, { error: 'Valid project Bearer token required' });
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/v1/projects') {
        const { apiKey: _key, ...visible } = project;
        return send(res, 200, { projects: [visible] });
      }
      const match = /^\/v1\/projects\/([a-z0-9-]+)\/(audits|report)(?:\/([0-9a-f-]+)(\/report)?)?$/.exec(path);
      if (!match || match[1] !== project.id) return send(res, 404, { error: 'Not found' });
      const [, , resource, id, reportSuffix] = match;
      if (id && !uuid.test(id)) return send(res, 404, { error: 'Not found' });
      if (req.method === 'POST' && resource === 'audits' && !id) {
        const parsed = auditInput.safeParse(await body(req));
        if (!parsed.success) return send(res, 422, { error: 'Expected {maxPages?: integer 1..500}; extra fields are not allowed' });
        const maxPages = parsed.data.maxPages ?? project.maxPages;
        if (maxPages > project.maxPages) return send(res, 422, { error: `Project page limit is ${project.maxPages}` });
        if (stopping || children.size >= 2 || children.has(project.id)) return send(res, 409, { error: 'Audit capacity busy; retry later' });
        return send(res, 202, start(project, maxPages));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      if (resource === 'report' && id) return send(res, 404, { error: 'Not found' });
      const all = jobs(project);
      if (resource === 'audits' && !id) return send(res, 200, { audits: all });
      const job = id ? all.find(j => j.id === id) : all.find(j => j.status === 'completed');
      if (!job) return send(res, 404, { error: 'Audit/report not found' });
      if (resource === 'audits' && !reportSuffix) return send(res, 200, job);
      if (job.status !== 'completed') return send(res, 409, { error: 'Report is not ready', audit: job });
      const report = JSON.parse(readFileSync(join(jobDir(project.id, job.id), 'out', 'report.json'), 'utf8'));
      return send(res, 200, { projectId: project.id, auditId: job.id, report });
    } catch (e) {
      if (e instanceof RequestError) return send(res, e.status, { error: e.message });
      console.error('API request failed', e);
      return send(res, 500, { error: 'Internal service error' });
    }
  });
  return { server, async stop() {
    stopping = true;
    const exits = [...children.values()].map(child => new Promise<void>(done => {
      child.once('close', () => done()); child.kill();
    }));
    await Promise.all(exits);
    await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));
  } };
}
function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('error', reject);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) {
        chunks.length = 0;
        reject(new RequestError(413, 'Request too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 8192) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new RequestError(400, 'Invalid JSON')); }
    });
  });
}
