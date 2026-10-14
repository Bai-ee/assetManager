export interface Cmd {
  id: string; type: string; workerId?: string; sourceId?: string;
  paths?: string[]; capUsd?: number; model?: string; promptVersion?: string; dryRun?: boolean; batch?: boolean;
  /** ANALYZE_FACETS: ignore the done index (full per-file walk + checks) and refresh it. */
  verify?: boolean;
  packageId?: string; sha256?: string; relativePath?: string; targetCommandId?: string; jobId?: string;
  /** Plugin command fields ride along. */
  [extra: string]: unknown;
}
export interface CmdUpdate { commandId: string; state: 'CLAIMED' | 'RUNNING' | 'COMPLETE' | 'FAILED'; error?: string | null; result?: unknown }
export interface ResultItem {
  sha256: string; relativePath: string; mediaType: 'image' | 'video'; width: number; height: number;
  durationSec?: number; capturedAt?: string; facets: unknown; summary: string; activity: string; peopleCount: number;
  jev: unknown; model: string; promptVersion: string; costUsd: number;
  /** Organized copy, relative to the source root. */
  organizedPath?: string;
}

export const CAPABILITIES = ['ANALYZE_FACETS', 'STAGE_FOR_PUBLISH', 'CANCEL_JOB', 'COLLECT_BATCHES'];
export const LOCAL_THUMB_BASE = 'http://127.0.0.1:8777';

/** HITLOOP control-plane client for the analyzer. fetch is injectable for tests. */
export class AnalyzerControl {
  constructor(
    readonly baseUrl: string,
    private token: string,
    readonly workerId: string,
    private fetchImpl: typeof fetch = fetch,
    extraCommandTypes: string[] = [],
  ) {
    this.extraCommandTypes = [...extraCommandTypes];
  }

  private extraCommandTypes: string[];
  /** Plugin command types, added to poll `types` and heartbeat `capabilities`. */
  setExtraCommandTypes(types: string[]) { this.extraCommandTypes = [...types]; }
  private allTypes(): string[] { return Array.from(new Set([...CAPABILITIES, ...this.extraCommandTypes])); }

  private url(p: string) { return new URL(p, this.baseUrl); }
  private h(json = true): Record<string, string> { return { authorization: `Bearer ${this.token}`, ...(json ? { 'content-type': 'application/json' } : {}) }; }

  private async send(method: string, p: string, body?: unknown, timeout = 15_000): Promise<Response> {
    const res = await this.fetchImpl(this.url(p), { method, headers: this.h(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`HITLOOP ${method} ${p} failed: ${res.status}`);
    return res;
  }

  /** The route requires sourceId; capabilities/localThumbBase ride along (dropped server-side until it is extended). */
  async heartbeat(sourceId: string, state: 'ONLINE' | 'PROCESSING', jobId?: string): Promise<void> {
    await this.send('POST', '/api/archive/worker/heartbeat', {
      workerId: this.workerId, sourceId, state, at: new Date().toISOString(), ...(jobId ? { jobId } : {}),
      capabilities: this.allTypes(), localThumbBase: LOCAL_THUMB_BASE,
    });
  }

  async poll(): Promise<Cmd[]> {
    const u = new URL('/api/archive/commands/worker', this.baseUrl);
    u.searchParams.set('workerId', this.workerId);
    u.searchParams.set('types', this.allTypes().join(','));
    const res = await this.fetchImpl(u, { headers: this.h(false), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HITLOOP command poll failed: ${res.status}`);
    return ((await res.json()) as { commands?: Cmd[] }).commands || [];
  }

  async update(u: CmdUpdate): Promise<void> { await this.send('PATCH', '/api/archive/commands/worker', u); }

  async pushResults(sourceId: string, items: ResultItem[]): Promise<void> {
    await this.send('POST', '/api/archive/worker/nas/results', { sourceId, items }, 60_000);
  }

  async uploadUrl(body: { packageId: string; sha256: string; contentType: string; sizeBytes: number }): Promise<{ uploadUrl: string; storagePath: string; headers: Record<string, string> }> {
    const j = (await (await this.send('POST', '/api/archive/worker/nas/upload-url', body)).json()) as Record<string, any>;
    const uploadUrl = j.uploadUrl || j.url || j.signedUrl;
    const storagePath = j.storagePath || j.path;
    if (!uploadUrl || !storagePath) throw new Error('upload-url response missing uploadUrl/storagePath');
    return { uploadUrl, storagePath, headers: j.headers && typeof j.headers === 'object' ? j.headers : {} };
  }
}
