import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createApi, projectsSchema } from './dist/src/service/api.js';

const configPath = resolve(process.env.SEO_PROJECTS_FILE || 'seo-projects.json');
const projects = projectsSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
const dataDir = resolve(process.env.SEO_DATA_DIR || '.seo-data');
const port = Number(process.env.PORT || 4010);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
mkdirSync(dataDir, { recursive: true });
const lock = join(dataDir, 'service.lock');
try { closeSync(openSync(lock, 'wx')); }
catch { throw new Error(`Data directory is locked: ${lock}. Stop the previous service before removing a stale lock.`); }
writeFileSync(lock, String(process.pid));
const release = () => { try { unlinkSync(lock); } catch {} };
process.once('exit', release);
const api = createApi(projects, dataDir);
api.server.once('error', error => { console.error(error.message); process.exitCode = 1; });
api.server.listen(port, process.env.HOST || '127.0.0.1', () => console.error(`On-page SEO API listening on port ${port}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await api.stop();
  release();
});
