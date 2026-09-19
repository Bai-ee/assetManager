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
  type: 'PROCESS_COLLECTION' | 'LIST_DIRECTORY';
  workerId: string;
  sourceId: string;
  relativePath: string;
  state: 'QUEUED';
}

export interface CommandUpdate {
  commandId: string;
  state: 'CLAIMED' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  jobId?: string | null;
  error?: string | null;
  result?: unknown;
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
}
