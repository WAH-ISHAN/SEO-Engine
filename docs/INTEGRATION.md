# Search Optimization Integration

This service is API-first. A customer site connects to the hosted engine by REST, MCP or the SDK; it does not install crawler logic into the website. One crawl produces a common site model, then SEO, AEO, AIO and GEO profiles read that same model and return evidence-backed findings.

Scores are hygiene and readiness measures for this engine's checks. They are not ranking predictions, traffic estimates or AI citation guarantees.

## Configure

```powershell
npm ci
npm run build
Copy-Item seo-projects.example.json seo-projects.json
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`seo-projects.json`:

```json
[
  {
    "id": "client-a",
    "name": "Client A Website",
    "url": "https://client-a.example",
    "apiKey": "REPLACE_WITH_RANDOM_64_HEX_KEY",
    "maxPages": 100
  }
]
```

Run:

```powershell
$env:SEO_PROJECTS_FILE = 'E:/enginesme/seo-engine/seo-projects.json'
$env:SEO_DATA_DIR = 'E:/enginesme/seo-engine/.seo-data'
$env:HOST = '127.0.0.1'
$env:PORT = '4010'
npm start
```

Project credentials are server-side assignments. One API key sees one project. Rotate a key by changing `seo-projects.json` and restarting the service.

## REST API

All endpoints require `Authorization: Bearer <project-key>`.

| Method | Path | Result |
|---|---|---|
| GET | `/v1/projects` | Assigned project without the secret |
| POST | `/v1/projects/:projectId/audits` | Start an audit |
| GET | `/v1/projects/:projectId/audits` | List jobs |
| GET | `/v1/projects/:projectId/audits/:auditId` | Read job status |
| GET | `/v1/projects/:projectId/audits/:auditId/report` | Read a completed job report |
| GET | `/v1/projects/:projectId/reports/latest` | Latest completed report |
| GET | `/v1/projects/:projectId/reports/latest/seo` | SEO profile report |
| GET | `/v1/projects/:projectId/reports/latest/aeo` | AEO profile report |
| GET | `/v1/projects/:projectId/reports/latest/aio` | AIO profile report |
| GET | `/v1/projects/:projectId/reports/latest/geo` | GEO profile report |
| GET | `/v1/projects/:projectId/reports/latest/entities` | Detected entities |
| GET | `/v1/projects/:projectId/reports/latest/recommendations` | Unified recommendations |
| GET | `/v1/projects/:projectId/reports/latest/schema` | Structured-data slice |

Audit body:

```json
{
  "profiles": ["seo", "aeo", "aio", "geo"],
  "maxPages": 100
}
```

Response:

```json
{
  "id": "e3b68fa7-df32-4a62-851d-c936935d9fa2",
  "projectId": "client-a",
  "status": "running",
  "profiles": ["seo", "aeo", "aio", "geo"],
  "maxPages": 100
}
```

Backend example:

```js
const response = await fetch(
  `${process.env.OPTIMIZE_API_URL}/v1/projects/${process.env.OPTIMIZE_PROJECT_ID}/audits`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPTIMIZE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ profiles: ['seo', 'aeo', 'aio', 'geo'] })
  }
);

const audit = await response.json();
```

Keep `OPTIMIZE_API_KEY` in backend environment variables only. Never expose it through browser JavaScript, `NEXT_PUBLIC_*` or `VITE_*`.

Legacy `GET /v1/projects/:projectId/report` remains as an alias for the latest completed full report.

## SDK

```js
import { OptimizationEngine } from 'uwoe';

const engine = new OptimizationEngine({
  apiUrl: process.env.OPTIMIZE_API_URL,
  apiKey: process.env.OPTIMIZE_API_KEY,
  projectId: process.env.OPTIMIZE_PROJECT_ID
});

await engine.audit({ profiles: ['seo', 'aeo', 'aio', 'geo'], maxPages: 100 });
const geo = await engine.getLatestReport('geo');
```

## MCP

Use stdio MCP. The MCP server calls the REST API; the API itself is not an MCP HTTP endpoint.

```json
{
  "mcpServers": {
    "search-optimization": {
      "command": "node",
      "args": ["E:/enginesme/seo-engine/plugins/search-optimization/mcp-server.mjs"],
      "env": {
        "OPTIMIZE_API_URL": "http://127.0.0.1:4010",
        "OPTIMIZE_API_KEY": "YOUR_ASSIGNED_PROJECT_KEY"
      }
    }
  }
}
```

Tools:

| Tool | Purpose |
|---|---|
| `optimization_list_projects` | Show the assigned project |
| `optimization_start_audit` | Start an audit with optional profiles and page limit |
| `optimization_list_audits` | List persisted jobs |
| `optimization_get_audit` | Poll job status |
| `optimization_get_summary` | Read latest unified summary |
| `optimization_get_report` | Read paginated full report sections |
| `optimization_get_seo_report` | Read latest SEO profile |
| `optimization_get_aeo_report` | Read latest AEO profile |
| `optimization_get_aio_report` | Read latest AIO profile |
| `optimization_get_geo_report` | Read latest GEO profile |
| `optimization_get_entities` | Read detected entities |
| `optimization_get_recommendations` | Read unified recommendations |

Legacy `seo_*` tools remain as compatibility aliases. `OPTIMIZE_API_URL` and `OPTIMIZE_API_KEY` are preferred; `SEO_API_URL` and `SEO_API_KEY` still work.

## Operational Notes

The API permits at most two simultaneous audits globally and one per project. There is no queue; retry a `409` later. Workers have a ten-minute deadline. The service writes reports under `.seo-data/<project>/jobs/<audit-id>/out/report.json`.

JavaScript is not rendered. SSR/static HTML gives the best results. Crawls are limited to the configured origin and should only be run for sites you own or have permission to audit.

Run `npm test` before handing over a deployment.
