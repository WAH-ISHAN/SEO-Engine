# Search Optimization Engine

Headless Search Optimization Engine for SEO, AEO, AIO and GEO, exposed through REST API, MCP and SDK integrations. The crawler runs once, normalizes the website into one shared model, then profile engines analyze the same evidence and return one unified report.

There is no dashboard or browser UI. Audits read the target website and produce JSON reports; they do not change the target website.

## Start

Use Node.js 22.13+.

```powershell
npm ci
npm run build
Copy-Item seo-projects.example.json seo-projects.json
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

Edit `seo-projects.json` with your website URL, project ID and generated API key. The API listens at `http://127.0.0.1:4010` by default.

## REST

```http
POST /v1/projects/:projectId/audits
GET  /v1/projects/:projectId/audits/:auditId
GET  /v1/projects/:projectId/reports/latest
GET  /v1/projects/:projectId/reports/latest/seo
GET  /v1/projects/:projectId/reports/latest/aeo
GET  /v1/projects/:projectId/reports/latest/aio
GET  /v1/projects/:projectId/reports/latest/geo
GET  /v1/projects/:projectId/reports/latest/entities
GET  /v1/projects/:projectId/reports/latest/recommendations
GET  /v1/projects/:projectId/reports/latest/schema
```

Audit body:

```json
{ "profiles": ["seo", "aeo", "aio", "geo"], "maxPages": 100 }
```

Keep API keys in backend environment variables. Do not put them in browser code.

## MCP

```powershell
$env:OPTIMIZE_API_URL = 'http://127.0.0.1:4010'
$env:OPTIMIZE_API_KEY = '<your project key>'
npm run mcp
```

The plugin entrypoint is `plugins/search-optimization/mcp-server.mjs`. It exposes `optimization_*` tools for projects, audits, summary, SEO/AEO/AIO/GEO reports, entities and recommendations. Legacy `seo_*` aliases still work.

## SDK

```js
import { OptimizationEngine } from 'uwoe';

const engine = new OptimizationEngine({
  apiUrl: process.env.OPTIMIZE_API_URL,
  apiKey: process.env.OPTIMIZE_API_KEY,
  projectId: process.env.OPTIMIZE_PROJECT_ID
});

const audit = await engine.audit({ profiles: ['seo', 'aeo', 'aio', 'geo'] });
```

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the full setup and API guide, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the shared model design.

## Verify

```powershell
npm test
```
