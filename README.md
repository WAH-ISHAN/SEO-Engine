# On-Page SEO Engine

Headless website auditing through a project-scoped REST API and a stdio MCP plugin.
There is no dashboard, browser UI or HTML report server.

The on-page profile checks metadata, headings, content, internal links, structured data
and accessibility. Each report separates observed issues from recommendations and includes
evidence, priorities and proposed changes. Auditing does not change the target website.

## Start

Use Node.js 22.13+ (or a newer supported Node release).

```powershell
npm ci
npm run build
Copy-Item seo-projects.example.json seo-projects.json
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Edit `seo-projects.json`: set your website URL, project ID and the generated API key.
Then run `npm start`. The API listens at `http://127.0.0.1:4010` by default.
Keys stay in server configuration and the consuming project's backend/MCP environment.

## Integrate

Read **[the complete MCP, REST API and project assignment guide](docs/INTEGRATION.md)**.
It includes Windows/Linux setup, MCP configuration, every endpoint, request/response
examples, backend integration, assignment to other clients, Docker deployment,
troubleshooting and migration from the previous single-site service.

```powershell
$env:SEO_API_URL = 'http://127.0.0.1:4010'
$env:SEO_API_KEY = '<your project key>'
npm run mcp
```

MCP runs over stdin/stdout and is normally launched by your MCP client. It is not a web page.
The plugin is in `plugins/on-page-seo`; its five tools discover the assigned project,
start audits, list audits, poll status and retrieve paginated report sections.

## Local CLI

```powershell
npm run uwoe -- audit https://example.com --max-pages 50
```

The CLI produces a JSON report under `.uwoe/<site>/out/`. Existing local commands for
review, approval, apply, validation and rollback remain available with `npm run uwoe -- help`.
Remote API/MCP clients cannot write project source files.

## Verification

```powershell
npm test
```

Tests cover the analysis engine, local patch safety, HTTP crawling, JSON-only reporting,
project credentials, REST audit persistence and a real MCP stdio client/server exchange.

The legacy multi-engine library remains available to programmatic consumers through
`runAudit(config, { profile: 'full' })`. CLI and service audits use `on-page`.
See [architecture](docs/ARCHITECTURE.md) for the shared analysis model.
