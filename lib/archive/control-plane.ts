export interface WorkerHeartbeat {
  workerId: string;
  sourceId: string;
  jobId?: string;
  state: 'ONLINE' | 'PROCESSING' | 'PAUSED' | 'OFFLINE' | 'ERROR';
  at: string;
  counters?: { discovered: number; hashed: number; duplicates: number; failed: number };
}

import type { SelectionItem } from './types';

export interface ArchiveCommandTag { name: string; value: string; }

// Echoed verbatim into the UPLOAD_JSON result so HITLOOP can relate the
// uploaded document back to the record/collection it documents without the
// worker knowing anything about those domain concepts.
export interface ArchiveCommandRefs {
  contentAssetId?: string;
  collectionId?: string;
  version?: string | number;
  previousTransactionId?: string;
}

export interface ArchiveCommand {
  id: string;
  type: 'PROCESS_COLLECTION' | 'PROCESS_SELECTION' | 'LIST_DIRECTORY' | 'UPLOAD_ASSET_ARWEAVE' | 'UPLOAD_JSON' | 'ORGANIZE_COLLECTION' | 'UNDO_ORGANIZE' | 'CANCEL_JOB';
  workerId: string;
  // Required for every command type except UPLOAD_JSON, which uploads bytes
  // HITLOOP already has in hand and never touches a registered source's
  // filesystem.
  sourceId?: string;
  relativePath?: string;
  contentAssetId?: string;
  collectionId?: string;
  archiveName?: string;
  contentType?: string;
  expectedSha256?: string;
  state: 'QUEUED';
  // UPLOAD_JSON fields only.
  kind?: 'archive-record' | 'collection-manifest' | 'viewer';
  fileName?: string;
  payload?: unknown;
  tags?: ArchiveCommandTag[];
  refs?: ArchiveCommandRefs;
  // ORGANIZE_COLLECTION only: 'plan' (default — writes nothing to disk) or
  // 'apply'. See docs/archive/ORGANIZER.md.
  mode?: 'plan' | 'apply';
  // UNDO_ORGANIZE only: the specific apply run's command id (the `jobId` an
  // apply's result carried) to undo. Omit to undo the most recent organize
  // apply for the collection derived from `relativePath`/`collectionId`.
  organizeJobId?: string;
  // PROCESS_SELECTION (required) / ORGANIZE_COLLECTION (optional — scopes an
  // apply/plan to an explicit item list instead of `relativePath`). See
  // docs/archive/ORGANIZER.md "Selections". `collectionId` above is required
  // alongside `items` for both command types.
  items?: SelectionItem[];
  // PROCESS_COLLECTION / PROCESS_SELECTION only: when true, discovery is
  // restricted to movable (video/image) files — see `organize/scheme.ts`
  // `isMovableExtension` and `worker.ts` `run()`. Omit/false = unchanged
  // prior behavior (every file is hashed).
  mediaOnly?: boolean;
  // CANCEL_JOB only: which job to stop. Either/both may be given; when
  // neither is given, the daemon cancels whatever PROCESS_COLLECTION/
  // PROCESS_SELECTION job is currently active in the main lane (see
  // daemon.ts `executeCancelJob`). `targetCommandId` names the ORIGINAL
  // process command's id (HITLOOP's stored field name — matches what the
  // /archive page's CANCEL button already polls via `?commandId=`).
  jobId?: string;
  targetCommandId?: string;
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

  async registerSource(payload: {workerId:string;sourceId:string;label:string;state?:string;kind?:string}): Promise<void> {
    if (!this.configured) return;
    const response=await fetch(new URL('/api/archive/worker/sources',this.baseUrl),{
      method:'POST',headers:this.headers(true),body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000),
    });
    if(!response.ok) throw new Error(`HITLOOP source registration failed: ${response.status}`);
  }

  /** `opts.types`/`opts.excludeTypes` partition the claim between the daemon's
   * two lanes (see daemon.ts run()/runBrowseLane()) so a cheap LIST_DIRECTORY
   * never waits behind a slow PROCESS_COLLECTION and the two lanes never
   * double-claim the same command. Omit both for the pre-existing behavior. */
  async pollCommands(workerId:string, opts?: { types?: string[]; excludeTypes?: string[] }):Promise<ArchiveCommand[]> {
    if(!this.configured) return [];
    const url=new URL('/api/archive/commands/worker',this.baseUrl); url.searchParams.set('workerId',workerId);
    if (opts?.types?.length) url.searchParams.set('types', opts.types.join(','));
    if (opts?.excludeTypes?.length) url.searchParams.set('excludeTypes', opts.excludeTypes.join(','));
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
      // Set once the organizer has moved this asset's canonical location into
      // HITLOOP-ARCHIVE/… (ORGANIZE_COLLECTION{mode:'apply'}); `path` is
      // relative to the source rootPath. HITLOOP persists this in a later
      // workstream — a non-2xx here must not fail the organize command
      // (silent no-op, same as every other syncAsset call).
      organized?: { path: string; appliedAt: string };
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
