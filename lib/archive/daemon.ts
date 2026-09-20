import { createHash } from 'crypto';
import { hostname } from 'os';
import { promises as fs } from 'fs';
import path from 'path';
import { ArchiveDatabase } from './database';
import { ArchiveWorker, isFilesystemArtifact } from './worker';
import { ControlPlaneClient, type ArchiveCommand } from './control-plane';
import { sha256File } from './hash';
import { uploadOriginalToArweave } from './arweave/uploader';
import { ArchiveAnalysisService } from './analysis/service';
import { isTwelveLabsVideo } from './providers/twelvelabs';
import { inferMediaType } from './media-type';
import { JevDecisionService, reviewBand } from './jev/service';
import { AnthropicJevProvider } from './jev/anthropic-provider';
import { JEV_QUESTIONS } from './jev/taxonomy';
import { buildAssetState } from './schema/asset-state';
import type { ContentAssetRecord } from './types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class ArchiveDaemon {
  private stopped = false;
  readonly workerId: string;

  constructor(
    private db = new ArchiveDatabase(),
    private control = new ControlPlaneClient(),
    workerId = process.env.HITLOOP_ARCHIVE_WORKER_ID,
    private analysis = new ArchiveAnalysisService(db),
    private jev = new JevDecisionService(new AnthropicJevProvider()),
  ) {
    this.workerId = workerId || createHash('sha256').update(hostname()).digest('hex').slice(0, 24);
  }

  stop() { this.stopped = true; }

  /** Unique content-asset ids discovered under a job's selected folder. Shared
   * by the post-hash analysis step and the HITLOOP sync so both walk the same
   * scope the same way. */
  private jobAssetIds(sourceId:string,jobId:string):string[] {
    const job=this.db.getJob(jobId); if(!job) return [];
    const prefix=job.selectedRelativePath==='.'?'':job.selectedRelativePath.replace(/\/$/,'')+'/';
    const seen=new Set<string>();
    for(const row of this.db.db.prepare('SELECT content_asset_id FROM file_locations WHERE source_id=? AND content_asset_id IS NOT NULL AND relative_path LIKE ?').all(sourceId,`${prefix}%`) as Array<{content_asset_id:string}>){
      seen.add(row.content_asset_id);
    }
    return Array.from(seen);
  }

  /** True when every known location of this asset is an AppleDouble `._*` or
   * `.DS_Store` filesystem artifact. Catches stale content_assets hashed by a
   * worker run from before the discovery filter existed — their basename
   * still carries a real extension (e.g. `._clip.mp4`), so the video-extension
   * check alone would still try to submit their garbage bytes. */
  private isStaleArtifactAsset(assetId:string):boolean {
    const locations=this.db.listAssetLocations(assetId);
    if(!locations.length) return false;
    return locations.every(l=>isFilesystemArtifact(path.basename(l.relativePath)));
  }

  /** Analyze new video assets with TwelveLabs, then answer the six Jev
   * questions for any asset whose observation has come back READY. Runs after
   * hashing and before the HITLOOP sync so a synced asset carries whatever
   * evidence/decisions are available yet. Never throws: a NAS folder with no
   * credentials configured must still hash and sync cleanly, and a single
   * asset's provider failure must not stop the rest of the job. */
  private async runAnalysisAndJev(sourceId:string,jobId:string) {
    if(!this.analysis.configured) { console.log('analysis skipped: TwelveLabs not configured'); return; }
    const source=this.db.getSource(sourceId); if(!source) return;

    for(const assetId of this.jobAssetIds(sourceId,jobId)) {
      const asset=this.db.getAsset(assetId); if(!asset) continue;
      if(this.isStaleArtifactAsset(assetId)) continue;
      const location=this.db.listAssetLocations(assetId).find(x=>x.sourceId===sourceId);
      if(!location || !isTwelveLabsVideo(location.relativePath)) continue;

      try {
        // Idempotent: returns the existing observation without a network call
        // when one is already SUBMITTED/INDEXING/READY, submits (or retries a
        // prior failure) otherwise.
        const observation=await this.analysis.analyzeVideo(assetId,path.resolve(source.rootPath,location.relativePath));
        // Check TwelveLabs for progress unless it already reached a terminal
        // state, so a submission from an earlier pass can reach READY here.
        if(observation && observation.status!=='READY' && observation.status!=='FAILED') await this.analysis.advanceVideo(assetId);
      } catch(error) {
        // analyzeVideo/advanceVideo already record a FAILED observation for this
        // asset (safety invariant 9); the job must continue to the next asset.
        // The daemon used to swallow this silently, which is what made the
        // 413/404 failures on hpit03_finals invisible.
        console.log(`analysis failed ${assetId.slice(0,8)} ${location.relativePath}: ${error instanceof Error?error.message:String(error)}`);
        continue;
      }

      await this.runJevForAsset(asset);
    }
  }

  private async runJevForAsset(asset:ContentAssetRecord) {
    if(!process.env.ANTHROPIC_API_KEY) { console.log('jev skipped: ANTHROPIC_API_KEY not configured'); return; }
    if(this.db.listJevDecisions(asset.id).length) return; // already decided
    const observation=this.db.listObservations(asset.id).find(o=>o.provider==='twelvelabs'&&o.kind==='video_understanding'&&o.status==='READY');
    if(!observation) return; // not indexed yet; a later pass will pick it up

    const locations=this.db.listAssetLocations(asset.id);
    const primary=locations[0];
    const assetState=buildAssetState({
      assetId:asset.id,sha256:asset.sha256,
      mediaType:inferMediaType(primary?.relativePath||''),
      sourcePaths:locations.map(l=>l.relativePath),
      observations:this.db.listObservations(asset.id).map(o=>({provider:o.provider,kind:o.kind,status:o.status,summary:o.summary})),
    });

    try {
      for(const question of JEV_QUESTIONS) {
        const decision=await this.jev.decide(assetState,question.question,question.choices);
        this.db.upsertJevDecision({
          id:decision.id,contentAssetId:asset.id,question:decision.question,choices:decision.choices,
          selectedValue:decision.selectedValue,confidence:decision.confidence,status:decision.reviewBand,evidence:decision.evidence,
        });
      }
    } catch(error) {
      console.log(`jev failed for asset ${asset.id}: ${error instanceof Error?error.message:String(error)}`);
    }
  }

  /** Push one asset's current observations/decisions to HITLOOP. Shared by the
   * per-job sync (scoped to that job's file locations) and the background
   * sweep (which syncs an asset outside any specific job). */
  private async pushAssetSync(sourceId:string,collectionJobId:string|undefined,assetId:string) {
    const asset=this.db.getAsset(assetId); if(!asset) return;
    const locations=this.db.listAssetLocations(asset.id).filter(x=>x.sourceId===sourceId);
    const observations=this.db.listObservations(asset.id);
    const decisions=this.db.listJevDecisions(asset.id).map(d=>({...d,reviewBand:reviewBand(d.confidence??0)}));
    const mediaType=locations[0]?inferMediaType(locations[0].relativePath):undefined;
    try{await this.control.syncAsset({workerId:this.workerId,sourceId,collectionJobId,asset:{id:asset.id,sha256:asset.sha256,mediaType,sizeBytes:asset.sizeBytes,sourcePaths:locations.map(x=>x.relativePath),observations,decisions,state:asset.state}});}catch{/* durable local data remains authoritative; retry on later sync */}
  }

  private async syncJobAssets(sourceId:string,jobId:string) {
    for(const assetId of this.jobAssetIds(sourceId,jobId)) await this.pushAssetSync(sourceId,jobId,assetId);
  }

  /** Background progress check for videos still being processed by TwelveLabs
   * (SUBMITTED/INDEXING). A job only calls analyzeVideo/advanceVideo once, at
   * hash time; real indexing can still be in flight after the job completes,
   * so this sweep is what actually lands READY + Jev decisions once TwelveLabs
   * finishes. Bounded and oldest-first so one slow asset can't starve the rest
   * across sweeps. Never throws: called on an idle timer, not a job. */
  private async sweepPendingAnalysis() {
    if(!this.analysis.configured) return; // the poll loop already gates on this; checked again for direct callers (tests)
    const rows=this.db.db.prepare(
      "SELECT content_asset_id FROM observations WHERE provider='twelvelabs' AND kind='video_understanding' AND status IN ('SUBMITTED','INDEXING') ORDER BY created_at ASC LIMIT 5"
    ).all() as Array<{content_asset_id:string}>;

    for(const row of rows) {
      const assetId=row.content_asset_id;
      const asset=this.db.getAsset(assetId); if(!asset) continue;
      if(this.isStaleArtifactAsset(assetId)) continue;

      const location=this.db.listAssetLocations(assetId)[0];
      try { await this.analysis.advanceVideo(assetId); }
      catch(error) {
        // Recorded as FAILED by advanceVideo; still worth syncing below so
        // HITLOOP sees the failure instead of a silently stuck SUBMITTED row.
        console.log(`analysis failed ${assetId.slice(0,8)} ${location?.relativePath??'(no known location)'}: ${error instanceof Error?error.message:String(error)}`);
      }
      await this.runJevForAsset(asset);

      if(!location) continue; // no known source to sync this asset under yet
      await this.pushAssetSync(location.sourceId,undefined,assetId);
    }
  }

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
      await this.control.updateCommand({commandId:command.id,state:'COMPLETE',result:{...uploaded,contentAssetId:command.contentAssetId,collectionId:command.collectionId,archiveName:command.archiveName,sha256:currentHash,contentType:command.contentType||null,sourceId:command.sourceId,relativePath:command.relativePath}});
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
    await this.runAnalysisAndJev(command.sourceId,job.id);
    await this.syncJobAssets(command.sourceId,job.id);
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
        await this.runAnalysisAndJev(job.sourceId,job.id);
        await this.syncJobAssets(job.sourceId,job.id);
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
    // An idle worker must still be visible. The control plane only creates the
    // worker record from a heartbeat, so without this an idle daemon shows as
    // "waiting for worker" and the /archive browser has no worker to target.
    const idleHeartbeat = async () => {
      for (const source of this.db.listSources()) {
        try { await this.control.heartbeat({ workerId:this.workerId, sourceId:source.id, state:'ONLINE', at:new Date().toISOString() }); } catch {}
      }
    };
    await idleHeartbeat();
    let pollsSinceHeartbeat = 0;
    let pollsSinceSweep = 0;
    while (!this.stopped) {
      if (++pollsSinceHeartbeat >= 12) { pollsSinceHeartbeat = 0; await idleHeartbeat(); }
      // ~30s at the default 5s pollMs. Awaited inline (not fire-and-forget), so
      // it runs between poll iterations and never overlaps a running command.
      if (++pollsSinceSweep >= 6) {
        pollsSinceSweep = 0;
        try { await this.sweepPendingAnalysis(); } catch { /* a sweep failure must not stop the poll loop */ }
      }
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
