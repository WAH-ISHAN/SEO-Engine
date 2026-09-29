# Search Optimization Engine

A headless search optimization engine for **SEO, AEO, AIO, and GEO**, exposed through **REST API, MCP, SDK, and CLI integrations**.

The engine crawls a website once, builds a shared site model, and runs multiple analysis profiles on the same data. It produces structured findings, evidence, recommendations, and reports without requiring a dashboard or changing the target website.

---

## Overview

This project is designed as an API-first optimization engine that can be connected to different websites and software systems.

Instead of installing SEO logic directly inside every project, the engine runs as a separate service.

A client application only needs:

- Engine API URL
- Project ID
- Project API key

The same engine can then be used across multiple projects.

```text
Website / Application
        |
        v
     REST API
        |
        v
   Crawl Website
        |
        v
 Shared Site Model
        |
  -------------------------
  |      |       |       |
 SEO    AEO     AIO     GEO
  |      |       |       |
  -------------------------
        |
        v
 Findings + Evidence
        |
        v
 Recommendations / Reports
        |
  -------------------------
  |         |            |
 REST      MCP          SDK
```

---

## Optimization Profiles

### SEO

Analyzes technical and on-page search optimization signals such as:

- Page titles and meta descriptions
- Heading structure
- Canonical URLs
- Internal links
- Content structure
- Duplicate and thin content
- Structured data
- Accessibility-related signals
- Sitemap and robots information
- Basic server and performance signals

### AEO

Analyzes how clearly website content can answer user questions.

Focus areas include:

- Question and answer structure
- Clear headings
- Direct answers
- Lists and structured content
- Content completeness
- Search intent alignment
- Entity and schema support

### AIO

Analyzes whether content is easy for AI-powered search systems and assistants to understand.

Focus areas include:

- Semantic content structure
- Entity clarity
- Structured data
- Source and author information
- Machine-readable relationships
- Content organization
- Crawlable HTML
- AI-friendly information structure

### GEO

Analyzes content for generative search and answer systems.

Focus areas include:

- Entity consistency
- Clear factual information
- Source attribution
- Content extractability
- Topic coverage
- Structured relationships
- Original information
- Generative search readiness

> The engine reports technical and content signals. It does not guarantee search rankings, traffic, AI citations, or visibility.

---

## Main Features

- SEO, AEO, AIO, and GEO analysis profiles
- Single crawl with a shared analysis model
- Project-based REST API
- Project-specific API keys
- MCP integration
- JavaScript/TypeScript SDK
- Local CLI
- Docker support
- Structured JSON reports
- Evidence-based findings
- Recommendations with priorities
- Audit history
- Entity and structured-data analysis
- Local review and change workflow
- Validation and rollback support
- Automated test suite

---

## Requirements

- Node.js **22.13+**
- npm

---

## Installation

Clone the repository and install dependencies.

```bash
git clone https://github.com/WAH-ISHAN/SEO-Engine.git
cd SEO-Engine
npm ci
npm run build
```

Create the project configuration file.

### Windows PowerShell

```powershell
Copy-Item seo-projects.example.json seo-projects.json
```

### Linux / macOS

```bash
cp seo-projects.example.json seo-projects.json
```

Generate a secure API key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

---

## Project Configuration

Edit `seo-projects.json`.

Example:

```json
[
  {
    "id": "client-a",
    "name": "Client A Website",
    "url": "https://example.com",
    "apiKey": "YOUR_GENERATED_API_KEY",
    "maxPages": 100
  }
]
```

Each project should have its own API key.

Do not commit real API keys to GitHub.

---

## Start the Engine

```bash
npm start
```

The default REST API runs on:

```text
http://127.0.0.1:4010
```

Environment variables can be used to change the configuration.

```text
SEO_PROJECTS_FILE
SEO_DATA_DIR
HOST
PORT
```

The newer integration layer can also use optimization-prefixed environment variables where supported.

---

## Start an Audit

An audit can run one or more optimization profiles.

Example request:

```json
{
  "profiles": [
    "seo",
    "aeo",
    "aio",
    "geo"
  ],
  "maxPages": 50
}
```

The crawler collects the website data once and shares it across the selected analysis profiles.

---

## REST API

All project requests use Bearer authentication.

```http
Authorization: Bearer YOUR_PROJECT_API_KEY
```

### Main Endpoints

```text
GET  /v1/projects

POST /v1/projects/:projectId/audits

GET  /v1/projects/:projectId/audits

GET  /v1/projects/:projectId/audits/:auditId

GET  /v1/projects/:projectId/audits/:auditId/report

GET  /v1/projects/:projectId/report
```

The updated service also supports profile-focused report access and structured report sections such as:

- SEO
- AEO
- AIO
- GEO
- Entities
- Recommendations
- Schema

---

## Example REST Request

```js
const baseUrl = process.env.OPTIMIZE_API_URL;
const projectId = process.env.OPTIMIZE_PROJECT_ID;

const response = await fetch(
  `${baseUrl}/v1/projects/${projectId}/audits`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPTIMIZE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      profiles: ["seo", "aeo", "aio", "geo"],
      maxPages: 50
    })
  }
);

const audit = await response.json();

console.log(audit);
```

Keep API keys on the server side.

Do not place them inside browser JavaScript, `NEXT_PUBLIC_*`, or `VITE_*` variables.

---

## MCP Integration

The project includes an MCP integration for AI development tools and MCP-compatible clients.

The newer entry point is:

```text
plugins/search-optimization/mcp-server.mjs
```

Legacy SEO MCP names can remain available for backward compatibility.

### Environment

```powershell
$env:OPTIMIZE_API_URL = 'http://127.0.0.1:4010'
$env:OPTIMIZE_API_KEY = '<your project key>'
```

Legacy variables can also be supported:

```powershell
$env:SEO_API_URL = 'http://127.0.0.1:4010'
$env:SEO_API_KEY = '<your project key>'
```

Start the MCP integration:

```bash
npm run mcp
```

---

## MCP Tools

The optimization MCP interface can expose tools such as:

```text
optimization_list_projects

optimization_start_audit

optimization_list_audits

optimization_get_audit

optimization_get_report
```

Profile-specific report tools can also expose SEO, AEO, AIO, GEO, entities, and recommendations.

This allows an MCP client to perform workflows such as:

```text
Audit this project using SEO, AEO, AIO and GEO.

Show the highest-priority issues.

Show only AEO recommendations.

List structured-data problems.

Retrieve the latest optimization report.
```

---

## SDK

The project includes a reusable SDK client.

```ts
import { OptimizationEngine } from "uwoe";

const engine = new OptimizationEngine({
  apiUrl: process.env.OPTIMIZE_API_URL!,
  apiKey: process.env.OPTIMIZE_API_KEY!,
  projectId: process.env.OPTIMIZE_PROJECT_ID!
});

const audit = await engine.startAudit({
  profiles: ["seo", "aeo", "aio", "geo"],
  maxPages: 50
});

console.log(audit);
```

The SDK allows other Node.js applications to use the optimization engine without manually building every HTTP request.

---

## Local CLI

The local CLI can run audits without using the hosted REST workflow.

```bash
npm run uwoe -- audit https://example.com --max-pages 50
```

Reports are stored under:

```text
.uwoe/<site>/out/
```

Check all CLI commands:

```bash
npm run uwoe -- help
```

The local workflow can also support review, approval, validation, apply, and rollback operations.

Example:

```bash
npm run uwoe -- queue https://example.com

npm run uwoe -- changes https://example.com

npm run uwoe -- approve https://example.com <change-id> --approver developer

npm run uwoe -- validate https://example.com <recommendation-id>
```

---

## Report Model

Reports separate what the engine directly observes from what it recommends.

A simplified report can look like:

```json
{
  "meta": {
    "site": "https://example.com"
  },
  "profiles": {
    "seo": {},
    "aeo": {},
    "aio": {},
    "geo": {}
  },
  "observed": {
    "issues": [],
    "coverage": {},
    "inventory": {}
  },
  "analysis": {
    "recommendations": [],
    "queue": []
  },
  "entities": [],
  "changes": [],
  "monitoring": {}
}
```

The engine aims to keep evidence, detected issues, and recommendations separate.

This makes reports easier to inspect and verify.

---

## Architecture

The engine follows a shared analysis model.

```text
Crawler
   |
   v
Raw Website Data
   |
   v
Normalizer
   |
   v
Shared Graph / Site Model
   |
   +-------------------------------+
   |           |          |        |
   v           v          v        v
  SEO         AEO        AIO      GEO
 Engine      Engine     Engine   Engine
   |           |          |        |
   +-------------+----------+------+
                 |
                 v
              Signals
                 |
                 v
       Recommendation Engine
                 |
                 v
              Reports
```

Analysis engines should not independently crawl the website.

They receive the same analysis context and return their own signals.

This avoids duplicate crawling and keeps findings consistent across profiles.

---

## Evidence Model

The engine separates evidence into three types:

```text
Observed
Derived
Inferred
```

### Observed

Information directly found in the crawled website.

### Derived

Information calculated from observed data.

### Inferred

A heuristic or analytical conclusion produced by an engine.

Recommendations should be supported by real observed or derived evidence where possible.

---

## Docker

Build the image:

```bash
docker build -t search-optimization-engine .
```

Example run:

```bash
docker run \
  --name search-optimization-engine \
  --init \
  -p 127.0.0.1:4010:4010 \
  search-optimization-engine
```

For production deployments:

- Use persistent storage
- Use HTTPS
- Keep API keys secret
- Add reverse-proxy rate limits
- Restrict unnecessary outbound network access
- Do not expose internal cloud or management networks

---

## Testing

Run the full test suite:

```bash
npm test
```

Run a build separately:

```bash
npm run build
```

The test suite covers areas such as:

- Analysis engines
- Crawling
- API behavior
- Project authentication
- Audit storage
- MCP communication
- Local patch safety
- Report generation

---

## Project Structure

```text
src/
├── core/
├── crawler/
├── normalizer/
├── seo-engine/
├── aeo-engine/
├── aio-engine/
├── geo-engine/
├── recommendation-engine/
├── pipeline/
├── service/
└── sdk/

plugins/
├── on-page-seo/
└── search-optimization/

docs/
├── ARCHITECTURE.md
└── INTEGRATION.md

test/
```

The existing engine modules remain reusable while the REST, MCP, and SDK layers expose them as one optimization platform.

---

## Security

- Use a different API key for each project.
- Keep API keys in backend environment variables.
- Never commit `seo-projects.json` with real secrets.
- Do not expose API keys to frontend applications.
- Use HTTPS for remote deployments.
- Restrict projects to websites you own or have permission to audit.
- Review recommendations before applying changes.

---

## Current Limitations

The engine does not guarantee:

- Google rankings
- Search traffic increases
- AI citations
- Featured snippets
- Search-engine indexing
- Generative-engine visibility

Other current limitations may include:

- JavaScript-rendered content may not be fully visible to the crawler.
- Backlink and traffic data require external data sources.
- Some framework or CMS changes require manual implementation.
- Performance analysis is not a replacement for full Core Web Vitals testing.

The goal is to provide useful, evidence-based optimization information rather than artificial ranking guarantees.

---

## Documentation

For integration details:

```text
docs/INTEGRATION.md
```

For architecture details:

```text
docs/ARCHITECTURE.md
```

---

## License

MIT

---

## Author

**W.A.H. Ishan**

GitHub:  
https://github.com/WAH-ISHAN

---

## Project Goal

The goal of this project is to provide one reusable optimization engine that can connect to different software systems and websites through standard developer interfaces.

```text
One crawl.
One shared model.
SEO + AEO + AIO + GEO.
REST + MCP + SDK.
```
