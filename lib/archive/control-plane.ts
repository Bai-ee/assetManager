export interface WorkerHeartbeat {
  workerId: string;
  sourceId: string;
  jobId?: string;
  state: 'ONLINE' | 'PROCESSING' | 'PAUSED' | 'OFFLINE' | 'ERROR';
  at: string;
  counters?: { discovered: number; hashed: number; duplicates: number; failed: number };
}

export class ControlPlaneClient {
  constructor(
    private baseUrl = process.env.HITLOOP_ARCHIVE_CONTROL_URL,
    private token = process.env.HITLOOP_ARCHIVE_WORKER_TOKEN,
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async heartbeat(payload: WorkerHeartbeat): Promise<void> {
    if (!this.configured) return;
    const response = await fetch(new URL('/api/archive/worker/heartbeat', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HITLOOP heartbeat failed: ${response.status}`);
  }
}


export interface ArchiveCommand {
  id: string;
  type: 'PROCESS_COLLECTION';
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
}
