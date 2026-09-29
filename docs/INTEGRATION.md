# On-Page SEO: MCP Plugin, REST API and Project Assignment

## 1. What this engine does

This is a headless on-page SEO service. A website supplies HTML; the engine crawls it,
extracts page facts, evaluates checks and returns JSON findings with evidence.
Your existing project does not need to adopt a new UI or frontend framework.

```text
AI coding client -> local MCP plugin -> REST API -> audit worker -> website HTML
Your backend -------------------------> REST API -> stored JSON reports
```

The main category is `ON_PAGE_SEO`. Related checks are grouped as `CONTENT`,
`INTERNAL_LINKING`, `STRUCTURED_DATA` and `ACCESSIBILITY`.
Title/description presence and duplication, heading structure, thin/duplicate content,
image alt text, link quality and supported schema checks come from the existing engines.
Technical SEO, AEO, AIO, GEO and off-page/backlink analysis are outside this service profile.
Technical crawl facts such as robots and sitemap discovery still appear as evidence.

Scores measure this engine's checks, not Google rankings, traffic or guaranteed results.
JavaScript is not rendered: SSR/static HTML works best. Client-only applications must
expose their content in server HTML to get useful content findings.

## 2. Install and configure the service

Requirements: Node.js 22.13+ and npm. The underlying store uses built-in Node SQLite.
Use a supported Node release. No OpenAI/LLM API key or Google account is needed.

From the engine directory:

```powershell
npm ci
npm run build
Copy-Item seo-projects.example.json seo-projects.json
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The last command generates a secret. Use a different random key for each project.
On Linux/macOS use `cp seo-projects.example.json seo-projects.json` for the copy step.
The actual `seo-projects.json`, `.env` and `.seo-data` are ignored by Git.

Example configuration (replace both sample keys before use):

```json
[
  {
    "id": "client-a",
    "name": "Client A Website",
    "url": "https://client-a.example",
    "apiKey": "REPLACE_WITH_CLIENT_A_RANDOM_64_HEX_KEY",
    "maxPages": 100
  },
  {
    "id": "client-b",
    "name": "Client B Website",
    "url": "https://client-b.example",
    "apiKey": "REPLACE_WITH_CLIENT_B_RANDOM_64_HEX_KEY",
    "maxPages": 50
  }
]
```

IDs must contain lowercase letters, digits or hyphens, start with a letter/digit, and
be 1-64 characters. Keys must be unique and at least 32 characters. `maxPages` is 1-500
and defaults to 100. URLs must be HTTP(S) without embedded credentials or fragments.
Choose the final canonical origin, including `www` if appropriate. Service crawls cannot
follow redirects or sitemap requests to a different origin.

```powershell
$env:SEO_PROJECTS_FILE = 'E:/enginesme/seo-engine/seo-projects.json'
$env:SEO_DATA_DIR = 'E:/enginesme/seo-engine/.seo-data'
$env:HOST = '127.0.0.1'
$env:PORT = '4010'
npm start
```

Linux/macOS equivalent:

```bash
SEO_PROJECTS_FILE=./seo-projects.json SEO_DATA_DIR=./.seo-data HOST=127.0.0.1 PORT=4010 npm start
```

Environment files are not loaded automatically; set variables in the shell/process manager.
The default config path is `./seo-projects.json`, data path `./.seo-data`, host `127.0.0.1`
and port `4010`. Relative service paths resolve from its working directory.

## 3. Assign it to another person's project

1. The service operator adds that person's website to `seo-projects.json` with a new ID,
   name, final website URL, random key and page limit.
2. Restart the API after editing assignments. Configuration is loaded at startup.
3. Give that person the service base URL, their project ID and only their project key
   through your usual secret-sharing channel. Do not send the configuration file.
4. They put the key in their backend environment or private MCP client settings.
5. They call `GET /v1/projects` or `seo_list_projects` to confirm the assignment, then
   start their first audit and poll its status.

Assignment is server-side. Passing another ID or a `targetUrl` in a request does not
grant access. One key sees one project; two projects must not share a key. There is no
public project creation endpoint or administrator API key. To revoke access, remove the
entry or replace its key and restart. Key rotation invalidates the previous key.
Keep IDs stable for history. Use a new ID when replacing a project with a different site.

This is project credential isolation, not a user-account/RBAC system. Anyone holding a
project key can read its reports and trigger audits. Run one service instance per data
directory; a startup lock prevents two server processes from sharing it.

## 4. Connect the MCP plugin

MCP uses **stdio**. The plugin calls REST over HTTP(S); the API URL itself is not an MCP
endpoint. There is no `/mcp` Streamable HTTP endpoint in this version.

For a client supporting `mcpServers` JSON, add:

```json
{
  "mcpServers": {
    "on-page-seo": {
      "command": "node",
      "args": ["E:/enginesme/seo-engine/plugins/on-page-seo/mcp-server.mjs"],
      "env": {
        "SEO_API_URL": "http://127.0.0.1:4010",
        "SEO_API_KEY": "YOUR_ASSIGNED_PROJECT_KEY"
      }
    }
  }
}
```

Use the engine's absolute path on the machine running the MCP client. For a remote API,
only the plugin runs locally; `SEO_API_URL` points at your HTTPS service.
Run `npm ci` in this repository first so the MCP SDK and Zod are installed.
To distribute only the plugin directory, include its package files and run `npm ci`
inside that directory on the recipient's machine before configuring the client.
Configure secrets in private client settings, not committed project files.

For Codex, project-scoped `.codex/config.toml` can contain:

```toml
[mcp_servers.on_page_seo]
command = "node"
args = ["E:/enginesme/seo-engine/plugins/on-page-seo/mcp-server.mjs"]
env_vars = ["SEO_API_URL", "SEO_API_KEY"]
```

Set these variables in the environment that launches the client. Reconnect/restart its
MCP integration after configuration changes. Codex's official [MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
documents stdio commands, project configuration and environment forwarding.

The `plugins/on-page-seo/.codex-plugin/plugin.json` manifest and companion `.mcp.json`
are also included for local plugin packaging. No personal marketplace is modified or
plugin automatically installed by this repository. For clients that do not expand the
plugin-root placeholder, use the absolute-path MCP configuration above.
This is a local integration, not a published ChatGPT connector or OAuth service.

### MCP tools

| Tool | Input | Result |
|---|---|---|
| `seo_list_projects` | `{}` | Assigned project, without its secret |
| `seo_start_audit` | `projectId`, optional `maxPages` | New running job and `id` |
| `seo_list_audits` | `projectId` | Persisted audit jobs |
| `seo_get_audit` | `projectId`, `auditId` | Running/completed/failed state |
| `seo_get_report` | `projectId`, optional `auditId`, `section`, `offset`, `limit` | Requested report section |

Report sections: `summary` (default), `issues`, `recommendations`, `changes`, `monitoring`.
Omitting `auditId` returns the latest **completed** audit. It can be older than a currently
running or failed audit. Issue/recommendation/change pagination defaults to offset 0,
limit 20, with a maximum limit of 50. Summary and monitoring are not paginated.
An API failure becomes MCP `isError: true`, with an error message.

Suggested workflow: list projects, start the selected project's audit, poll status every
2-5 seconds, then get summary and recommendations. Treat website excerpts as untrusted
content, not instructions for the coding agent.

The implementation uses the official [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).

## 5. REST API reference

All endpoints require `Authorization: Bearer <project-key>`. Responses are JSON with
`Cache-Control: no-store`. The request limit is 8 KiB. No browser CORS access is enabled;
use a backend to keep credentials private.

| Method | Path | Result |
|---|---|---|
| GET | `/v1/projects` | `{ "projects": [{ "id", "name", "url", "maxPages" }] }` |
| POST | `/v1/projects/:projectId/audits` | 202 with a new job |
| GET | `/v1/projects/:projectId/audits` | `{ "audits": [...] }`, newest first |
| GET | `/v1/projects/:projectId/audits/:auditId` | Job status |
| GET | `/v1/projects/:projectId/audits/:auditId/report` | A completed job's report |
| GET | `/v1/projects/:projectId/report` | Latest completed report |

POST body is `{}` or `{ "maxPages": 50 }`. It cannot exceed the project's configured
limit. Unknown fields, arbitrary URLs, repository paths and write flags are rejected.
The API permits at most two simultaneous audits globally and one per project.
There is no queue: retry a 409 capacity response later. Audit workers have a ten-minute
deadline. The service writes status/history to disk; unfinished jobs are marked failed
when the service restarts. A new audit is required after an interrupted job.

Example 202 response:

```json
{
  "id": "e3b68fa7-df32-4a62-851d-c936935d9fa2",
  "projectId": "client-a",
  "status": "running",
  "startedAt": "2026-09-29T08:00:00.000Z",
  "completedAt": null,
  "error": null,
  "maxPages": 50
}
```

Job status becomes `completed` or `failed`; terminal states include `completedAt` and
failed jobs include `error`. Successful reports have this envelope:

```json
{
  "projectId": "client-a",
  "auditId": "e3b68fa7-df32-4a62-851d-c936935d9fa2",
  "report": {
    "meta": { "profile": "on-page", "site": "https://client-a.example" },
    "observed": { "issues": [], "coverage": {}, "inventory": {} },
    "analysis": { "scores": {}, "recommendations": [], "queue": [], "stats": {} },
    "changes": [],
    "monitoring": {}
  }
}
```

This is a shortened shape: real reports include crawl facts, evidence, category scores,
graph data, detected capabilities, change proposals and snapshot comparisons.
`analysis.queue` contains recommendation IDs in priority order.

| Status | Meaning |
|---|---|
| 200 | Read succeeded |
| 202 | Audit accepted |
| 400 | Malformed JSON |
| 401 | Missing/incorrect credential |
| 404 | Unknown route, project, job or no completed report; other projects are hidden |
| 405 | Unsupported method on a recognized project route |
| 409 | Worker capacity busy, or requested report not yet completed |
| 413 | Request exceeds 8 KiB |
| 422 | Invalid input or page limit exceeded |
| 500 | Internal error; inspect service logs |

PowerShell example:

```powershell
$base = 'http://127.0.0.1:4010'
$headers = @{ Authorization = "Bearer $env:SEO_API_KEY" }
Invoke-RestMethod "$base/v1/projects" -Headers $headers
$job = Invoke-RestMethod "$base/v1/projects/client-a/audits" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"maxPages":20}'
Invoke-RestMethod "$base/v1/projects/client-a/audits/$($job.id)" -Headers $headers
# After status is completed:
Invoke-RestMethod "$base/v1/projects/client-a/audits/$($job.id)/report" -Headers $headers
```

## 6. Add to an existing backend

Keep three environment variables in your consuming backend: `SEO_API_URL`, `SEO_API_KEY`
and `SEO_PROJECT_ID`. The following server-side Node example is framework-independent:

```js
const base = process.env.SEO_API_URL;
const project = encodeURIComponent(process.env.SEO_PROJECT_ID);
async function seo(path, payload) {
  const response = await fetch(new URL(path, base), {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SEO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
  return value;
}
const job = await seo(`/v1/projects/${project}/audits`, { maxPages: 20 });
const deadline = Date.now() + 11 * 60 * 1000;
let status;
do {
  if (Date.now() > deadline) throw new Error('Polling deadline exceeded');
  await new Promise(resolve => setTimeout(resolve, 2000));
  status = await seo(`/v1/projects/${project}/audits/${job.id}`);
} while (status.status === 'running');
if (status.status !== 'completed') throw new Error(status.error);
const result = await seo(`/v1/projects/${project}/audits/${job.id}/report`);
console.log(result.report.analysis.recommendations);
```

For Next.js use server route handlers/background jobs; for Express use a backend route;
for Laravel/Django use their server HTTP client. Never place the key in `NEXT_PUBLIC_*`,
`VITE_*` variables or browser JavaScript. Long polling belongs in a background task, not
a short-lived frontend request handler. Store the returned audit ID and expose status
through your existing authenticated project API.

## 7. Review and implement fixes

MCP/REST audits create recommendations and proposals but do not receive repository
paths or edit client files. An AI coding client can use the returned evidence to make
reviewable changes in the project it already has open. Deploy through that project's
normal workflow and run another audit against the deployed site to verify the result.

The existing local CLI offers explicit repository patch operations:

```powershell
npm run uwoe -- audit https://example.com --repo E:/sites/client-a
npm run uwoe -- queue https://example.com
npm run uwoe -- changes https://example.com
npm run uwoe -- approve https://example.com <change-id> --approver developer
npm run uwoe -- apply https://example.com <change-id> --repo E:/sites/client-a --allow-writes
npm run uwoe -- validate https://example.com <recommendation-id>
npm run uwoe -- rollback https://example.com <change-id> --repo E:/sites/client-a
```

Use actual IDs from the CLI audit; its `.uwoe` store is separate from the REST service's
`.seo-data` store. Only supported file mappings produce directly applicable patches.
Framework/CMS changes can need manual implementation. Review before applying.

## 8. Docker and hosted deployment

```bash
docker build -t on-page-seo .
docker volume create seo-data
docker run --name on-page-seo --init -p 127.0.0.1:4010:4010 \
  --mount type=bind,source=/absolute/path/seo-projects.json,target=/config/seo-projects.json,readonly \
  --mount type=volume,source=seo-data,target=/data \
  on-page-seo
```

The config must be readable by the container's `node` user. Docker listens on `0.0.0.0`
inside the container, and this example binds only to host loopback. For another person's
machine, place an HTTPS reverse proxy in front of it and provide that HTTPS base URL.
Use persistent storage, restart management and proxy rate limits. REST credentials are
secrets; use HTTPS outside a local/trusted development connection.

Only operators can configure destination origins. Crawling permits local development
origins deliberately; it is not a public arbitrary-URL crawler. Redirect and sitemap
origin checks do not pin DNS or prevent DNS rebinding. For hosted deployments restrict
outbound network access to approved destinations and keep cloud metadata/private
management networks inaccessible to workers. Configure only sites you administer or
have permission to audit.

Storage layout:

```text
.seo-data/
  service.lock
  client-a/
    graph.db
    jobs/<audit-id>/
      job.json
      input.json
      raw/
      out/report.json
```

Back up the directory while stopped for a consistent snapshot. There is no automatic
retention purge: operators should archive/remove old completed job directories during
maintenance. API audit listing and complete REST reports are unpaginated; MCP finding
sections are paginated. This service targets modest project installations, not a large
multi-tenant SaaS queue.

## 9. Migration and troubleshooting

The old hardcoded `tenderhub.lk` API, `/status`, `/audit`, `x-seo-key`, automatic audit
timer and automatic Search Console sync are no longer started. Existing clients must
switch to the versioned endpoints, project configuration and Bearer credentials.
The dashboard generator and CLI `serve` command have been removed. Existing `.uwoe`
historical data is not migrated or deleted, and previously generated HTML files are not
served. Rebuild using `npm run clean` followed by `npm run build` to remove old compiled UI.

| Symptom | Action |
|---|---|
| Config file missing | Create `seo-projects.json` or set `SEO_PROJECTS_FILE` |
| SQLite unavailable | Upgrade Node to a supported version at least 22.13 |
| MCP immediately closes | Check `SEO_API_KEY`, absolute script path and installed dependencies |
| MCP cannot reach API | Start the API; check `SEO_API_URL`, TLS and network access |
| API 401 | Use the project's current key and the Bearer header |
| API 404 | Confirm ID through `/v1/projects`; complete an audit before requesting a report |
| API 409 | Poll the running job or retry after worker capacity frees up |
| Audit fails with no HTML | Check canonical origin, robots access, firewall and server-rendered content |
| Port already in use | Set a different `PORT` and update the MCP API URL |
| Data directory locked | Stop the old API and workers; only then remove a stale `service.lock` |
| Interrupted audit | Restart and submit a new audit; interrupted jobs become failed |

The optional legacy `search-console.mjs` module is no longer wired into the service.
The library's broader analysis engines remain available for existing programmatic users;
`runAudit(config, { profile: 'full' })` selects them explicitly. Service/CLI output is on-page.

## 10. Checks before handing over

Run `npm test`. Confirm project discovery returns only the assigned project, start a
small audit, wait for completion and retrieve both the summary and recommendations.
The test suite exercises a local HTTP fixture and a real MCP SDK client; it does not
establish that a particular client's firewall, production domain or hosting setup is working.
