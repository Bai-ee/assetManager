import { createHash } from 'crypto';
import { hostname } from 'os';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';
import { ControlPlaneClient, type ArchiveCommand } from './control-plane';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class ArchiveDaemon {
  private stopped = false;
  readonly workerId: string;

  constructor(
    private db = new ArchiveDatabase(),
    private control = new ControlPlaneClient(),
    workerId = process.env.HITLOOP_ARCHIVE_WORKER_ID,
  ) {
    this.workerId = workerId || createHash('sha256').update(hostname()).digest('hex').slice(0, 24);
  }

  stop() { this.stopped = true; }

  private async execute(command: ArchiveCommand) {
    await this.control.updateCommand({ commandId: command.id, state: 'CLAIMED' });
    const source = this.db.getSource(command.sourceId);
    if (!source) throw new Error(`Unknown source ${command.sourceId}`);

    const worker = new ArchiveWorker(this.db, {
      onHeartbeat: async h => {
        const job = this.db.getJob(h.jobId);
        try {
          await this.control.heartbeat({
            workerId: this.workerId, sourceId: command.sourceId, jobId: h.jobId,
            state: 'PROCESSING', at: h.at, counters: job?.counters,
          });
        } catch { /* processing must survive control-plane telemetry failure */ }
      },
    });
    const job = worker.createJob(command.sourceId, command.relativePath);
    await this.control.updateCommand({ commandId: command.id, state: 'RUNNING', jobId: job.id });
    const result = await worker.run(job.id);
    const state = result.state === 'COMPLETE' ? 'COMPLETE' : 'FAILED';
    await this.control.updateCommand({ commandId: command.id, state, jobId: job.id, error: state === 'FAILED' ? 'Collection did not complete' : null });
  }

  async run(pollMs = 5000) {
    // Publish every locally registered source without revealing its filesystem path.
    if (this.control.configured) {
      for (const source of this.db.listSources()) {
        try { await this.control.registerSource({ workerId:this.workerId, sourceId:source.id, label:source.label, state:source.state }); }
        catch { /* retry naturally on daemon restart; processing remains local-first */ }
      }
    }
    while (!this.stopped) {
      try {
        const commands = await this.control.pollCommands(this.workerId);
        for (const command of commands) {
          try { await this.execute(command); }
          catch (error) {
            await this.control.updateCommand({ commandId: command.id, state: 'FAILED', error: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch { /* NAS work remains independent if HITLOOP is temporarily unreachable */ }
      await sleep(pollMs);
    }
  }
}

if (process.argv[1]?.endsWith('daemon.ts')) {
  const daemon = new ArchiveDaemon();
  process.on('SIGINT', () => daemon.stop());
  process.on('SIGTERM', () => daemon.stop());
  void daemon.run();
}
