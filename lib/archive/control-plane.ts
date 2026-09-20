export interface WorkerHeartbeat {
  workerId: string;
  sourceId: string;
  jobId?: string;
  state: 'ONLINE' | 'PROCESSING' | 'PAUSED' | 'OFFLINE' | 'ERROR';
  at: string;
  counters?: { discovered: number; hashed: number; duplicates: number; failed: number };
}

export interface ArchiveCommand {
  id: string;
  type: 'PROCESS_COLLECTION' | 'LIST_DIRECTORY' | 'UPLOAD_ASSET_ARWEAVE';
  workerId: string;
  sourceId: string;
  relativePath: string;
  contentAssetId?: string;
  collectionId?: string;
  archiveName?: string;
  contentType?: string;
  expectedSha256?: string;
  state: 'QUEUED';
}

export interface CommandUpdate {
  commandId: string;
  state: 'CLAIMED' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  jobId?: string | null;
  error?: string | null;
  result?: unknown;
}

// Lane 2 (phone upload) intake — see docs/archive/INTAKE_CONTRACT.md and
// lib/archive/intake.ts. State machine: UPLOADED -> CLAIMED -> HASHED ->
// REVIEWED -> ARCHIVED -> PURGED, or any state -> FAILED.
export interface IntakeItem {
  intakeId: string;
  storagePath: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number;
  downloadUrl: string;
  createdAt: unknown;
}

export interface IntakeUpdate {
  intakeId: string;
  workerId: string;
  state: 'CLAIMED' | 'HASHED' | 'REVIEWED' | 'ARCHIVED' | 'FAILED';
  sha256?: string;
  contentAssetId?: string;
  error?: string | null;
}

export class ControlPlaneClient {
  constructor(
    private baseUrl = process.env.HITLOOP_ARCHIVE_CONTROL_URL,
    private token = process.env.HITLOOP_ARCHIVE_WORKER_TOKEN,
  ) {}

  get configured(): boolean { return Boolean(this.baseUrl && this.token); }

  private headers(json = false): Record<string,string> {
    return { ...(json ? {'content-type':'application/json'} : {}), authorization: `Bearer ${this.token}` };
  }

  async heartbeat(payload: WorkerHeartbeat): Promise<void> {
    if (!this.configured) return;
    const response = await fetch(new URL('/api/archive/worker/heartbeat', this.baseUrl), {
      method:'POST', headers:this.headers(true), body:JSON.stringify(payload), signal:AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HITLOOP heartbeat failed: ${response.status}`);
  }

  async registerSource(payload: {workerId:string;sourceId:string;label:string;state?:string}): Promise<void> {
    if (!this.configured) return;
    const response=await fetch(new URL('/api/archive/worker/sources',this.baseUrl),{
      method:'POST',headers:this.headers(true),body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000),
    });
    if(!response.ok) throw new Error(`HITLOOP source registration failed: ${response.status}`);
  }

  async pollCommands(workerId:string):Promise<ArchiveCommand[]> {
    if(!this.configured) return [];
    const url=new URL('/api/archive/commands/worker',this.baseUrl); url.searchParams.set('workerId',workerId);
    const response=await fetch(url,{headers:this.headers(),signal:AbortSignal.timeout(10_000)});
    if(!response.ok) throw new Error(`HITLOOP command poll failed: ${response.status}`);
    const body=await response.json() as {commands?:ArchiveCommand[]};
    return body.commands||[];
  }

  async updateCommand(update:CommandUpdate):Promise<void> {
    if(!this.configured) return;
    const response=await fetch(new URL('/api/archive/commands/worker',this.baseUrl),{
      method:'PATCH',headers:this.headers(true),body:JSON.stringify(update),signal:AbortSignal.timeout(10_000),
    });
    if(!response.ok) throw new Error(`HITLOOP command update failed: ${response.status}`);
  }
  async syncAsset(payload: {
    workerId: string;
    sourceId: string;
    collectionJobId?: string;
    asset: {
      id: string;
      sha256: string;
      mediaType?: string;
      sizeBytes?: number;
      archiveName?: string;
      sourcePaths?: string[];
      observations?: unknown[];
      decisions?: unknown[];
      state?: string;
    };
  }): Promise<void> {
    if (!this.configured) return;
    const response = await fetch(`${this.baseUrl}/api/archive/worker/assets`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Asset sync failed: ${response.status} ${await response.text()}`);
  }

  /** Every UPLOADED intake doc, each with a fresh signed download URL. Not a
   * claim filter — nothing is assigned to this worker until it PATCHes CLAIMED. */
  async listIntake(workerId: string): Promise<IntakeItem[]> {
    if (!this.configured) return [];
    const url = new URL('/api/archive/worker/intake', this.baseUrl);
    url.searchParams.set('workerId', workerId);
    const response = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HITLOOP intake list failed: ${response.status}`);
    const body = await response.json() as { items?: IntakeItem[] };
    return body.items || [];
  }

  async updateIntake(update: IntakeUpdate): Promise<void> {
    if (!this.configured) return;
    const response = await fetch(new URL('/api/archive/worker/intake', this.baseUrl), {
      method: 'PATCH', headers: this.headers(true), body: JSON.stringify(update), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HITLOOP intake update failed: ${response.status}`);
  }

  /** The only path that removes the Firebase object; only valid from ARCHIVED. */
  async purgeIntake(payload: { intakeId: string; workerId: string }): Promise<void> {
    if (!this.configured) return;
    const response = await fetch(new URL('/api/archive/worker/intake', this.baseUrl), {
      method: 'DELETE', headers: this.headers(true), body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HITLOOP intake purge failed: ${response.status}`);
  }

}
