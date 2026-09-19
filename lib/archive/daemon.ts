import { createHash } from 'crypto';
import { hostname } from 'os';
import { promises as fs } from 'fs';
import path from 'path';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';
import { ControlPlaneClient, type ArchiveCommand } from './control-plane';
import { sha256File } from './hash';
import { uploadOriginalToArweave } from './arweave/uploader';

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

    if (command.type === 'UPLOAD_ASSET_ARWEAVE') {
      if(!command.expectedSha256||!command.collectionId||!command.archiveName) throw new Error('Incomplete Arweave upload command');
      const root=path.resolve(source.rootPath);
      const target=path.resolve(root,command.relativePath);
      const relative=path.relative(root,target);
      if(relative.startsWith('..')||path.isAbsolute(relative)) throw new Error('Upload path escapes registered source');
      // Re-hash immediately before permanent upload. The approved bytes must be
      // exactly the bytes that were reviewed.
      const currentHash=await sha256File(target);
      if(currentHash!==command.expectedSha256) throw new Error('Source bytes changed after approval; re-review required');
      await this.control.updateCommand({commandId:command.id,state:'RUNNING'});
      const uploaded=await uploadOriginalToArweave({filePath:target,archiveName:command.archiveName,contentType:command.contentType,sha256:currentHash,collectionId:command.collectionId});
      await this.control.updateCommand({commandId:command.id,state:'COMPLETE',result:{...uploaded,contentAssetId:command.contentAssetId}});
      return;
    }

        if (command.type === 'LIST_DIRECTORY') {
      const root = path.resolve(source.rootPath);
      const target = path.resolve(root, command.relativePath || '.');
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Directory escapes registered source');
      const entries = await fs.readdir(target, { withFileTypes:true });
      const folders = entries.filter(e=>e.isDirectory() && !e.name.startsWith('.')).map(e=>e.name).sort((a,b)=>a.localeCompare(b));
      await this.control.updateCommand({ commandId:command.id, state:'COMPLETE', result:{relativePath:relative || '.', folders} });
      return;
    }

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
    // Restart recovery is local-first. Jobs that were RUNNING are converted to
    // PAUSED by ArchiveDatabase on open; resume them before accepting new work.
    for (const job of this.db.listResumableJobs()) {
      try {
        const source=this.db.getSource(job.sourceId);
        if(!source) continue;
        const worker=new ArchiveWorker(this.db,{onHeartbeat: async h => {
          const current=this.db.getJob(h.jobId);
          try { await this.control.heartbeat({workerId:this.workerId,sourceId:job.sourceId,jobId:h.jobId,state:'PROCESSING',at:h.at,counters:current?.counters}); } catch {}
        }});
        const result=await worker.resume(job.id);
        try { await this.control.heartbeat({workerId:this.workerId,sourceId:job.sourceId,jobId:job.id,state:result.state==='COMPLETE'?'ONLINE':'PAUSED',at:new Date().toISOString(),counters:result.counters}); } catch {}
      } catch { /* leave durable job for next restart/manual intervention */ }
    }

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
