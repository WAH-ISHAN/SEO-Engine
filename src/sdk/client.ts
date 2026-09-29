export const SDK_PROFILES = ['seo', 'aeo', 'aio', 'geo'] as const;
export type SdkProfile = (typeof SDK_PROFILES)[number];

export interface OptimizationEngineOptions {
  apiKey: string;
  projectId: string;
  apiUrl?: string;
  timeoutMs?: number;
}

export interface StartAuditInput {
  profiles?: SdkProfile[];
  maxPages?: number;
}

export class OptimizationEngine {
  private readonly apiUrl: URL;
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(options: OptimizationEngineOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    if (!options.projectId) throw new Error('projectId is required');
    this.apiUrl = new URL(options.apiUrl ?? 'http://127.0.0.1:4010');
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  listProjects() {
    return this.request('/v1/projects');
  }

  audit(input: StartAuditInput = {}) {
    return this.request(`/v1/projects/${this.projectId}/audits`, input);
  }

  listAudits() {
    return this.request(`/v1/projects/${this.projectId}/audits`);
  }

  getAudit(auditId: string) {
    return this.request(`/v1/projects/${this.projectId}/audits/${auditId}`);
  }

  getLatestReport(section?: SdkProfile | 'entities' | 'recommendations' | 'schema') {
    const suffix = section ? `/${section}` : '';
    return this.request(`/v1/projects/${this.projectId}/reports/latest${suffix}`);
  }

  getAuditReport(auditId: string) {
    return this.request(`/v1/projects/${this.projectId}/audits/${auditId}/report`);
  }

  private async request(path: string, body?: unknown) {
    const response = await fetch(new URL(path, this.apiUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`Optimization API ${response.status}: ${result.error ?? 'Request failed'}`);
    return result;
  }
}
