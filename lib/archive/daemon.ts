import { createHash } from 'crypto';
import { hostname } from 'os';
import { promises as fs } from 'fs';
import path from 'path';
import { ArchiveDatabase } from './database';
import { ArchiveWorker, isFilesystemArtifact } from './worker';
import { ControlPlaneClient, type ArchiveCommand } from './control-plane';
import { sha256File } from './hash';
import { uploadOriginalToArweave, uploadDocumentToArweave } from './arweave/uploader';
import { ArchiveAnalysisService } from './analysis/service';
import { isTwelveLabsVideo } from './providers/twelvelabs';
import { inferMediaType } from './media-type';
import { JevDecisionService, reviewBand } from './jev/service';
import { AnthropicJevProvider } from './jev/anthropic-provider';
import { JEV_QUESTIONS } from './jev/taxonomy';
import { buildAssetState } from './schema/asset-state';
import type { ArchiveSource, CollectionJobRecord, ContentAssetRecord, SelectionItem } from './types';
import { planOrganizeCollection, type OrganizePlan } from './organize/planner';
import { applyOrganizePlan, undoOrganizeJob } from './organize/mover';
import { slugifyCollectionId, isMovableExtension, ORGANIZED_ROOT_NAME } from './organize/scheme';
import {
  ensureCloudIntakeSource,
  drainIntake,
  markIntakeReviewed,
  archiveAndPurgeIntake,
  resolveIntakeIdFromRelativePath,
} from './intake';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * result order. Used by the LIST_DIRECTORY handler so per-file `fs.stat`
 * calls in a large folder don't run one-at-a-time (slow) or all at once
 * (fd-storm on a NAS SMB mount). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ArchiveDaemon {
  private stopped = false;
  readonly workerId: string;
  /** Set once ensureCloudIntakeSource resolves at daemon start (see run()).
   * Identifies which UPLOAD_ASSET_ARWEAVE commands belong to Lane 2. */
  private cloudIntakeSourceId?: string;
  private cloudIntakeRootPath?: string;

  /** The PROCESS_COLLECTION/PROCESS_SELECTION job currently executing in the
   * main lane, if any — set for the duration of `worker.run()` in execute()
   * below, so a CANCEL_JOB command claimed concurrently by the browse lane
   * (see runBrowseLane) can find and cancel it. Only ever one at a time: the
   * main lane awaits each command fully before claiming the next. */
  private activeJob?: { jobId: string; commandId: string; worker: ArchiveWorker };

  constructor(
    private db = new ArchiveDatabase(),
    private control = new ControlPlaneClient(),
    workerId = process.env.HITLOOP_ARCHIVE_WORKER_ID,
    private analysis = new ArchiveAnalysisService(db),
    private jev = new JevDecisionService(new AnthropicJevProvider()),
    private uploadOriginal = uploadOriginalToArweave,
    private uploadDocument = uploadDocumentToArweave,
  ) {
    this.workerId = workerId || createHash('sha256').update(hostname()).digest('hex').slice(0, 24);
  }

  stop() { this.stopped = true; }

  /** Unique content-asset ids discovered under a job's scope. Shared by the
   * post-hash analysis step and the HITLOOP sync so both walk the same scope
   * the same way. A PROCESS_SELECTION job (`job.selection` present) scopes to
   * the union of its file/folder items instead of a single
   * `selectedRelativePath` prefix. */
  private jobAssetIds(sourceId:string,jobId:string):string[] {
    const job=this.db.getJob(jobId); if(!job) return [];
    const seen=new Set<string>();
    const addByPrefix=(prefix:string)=>{
      for(const row of this.db.db.prepare('SELECT content_asset_id FROM file_locations WHERE source_id=? AND content_asset_id IS NOT NULL AND relative_path LIKE ?').all(sourceId,`${prefix}%`) as Array<{content_asset_id:string}>){
        seen.add(row.content_asset_id);
      }
    };
    if(job.selection && job.selection.length) {
      for(const item of job.selection) {
        if(item.kind==='folder') {
          addByPrefix(item.relativePath==='.'?'':item.relativePath.replace(/\/$/,'')+'/');
        } else {
          const row=this.db.db.prepare('SELECT content_asset_id FROM file_locations WHERE source_id=? AND content_asset_id IS NOT NULL AND relative_path=?').get(sourceId,item.relativePath) as {content_asset_id:string}|undefined;
          if(row) seen.add(row.content_asset_id);
        }
      }
    } else {
      addByPrefix(job.selectedRelativePath==='.'?'':job.selectedRelativePath.replace(/\/$/,'')+'/');
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
  private async pushAssetSync(sourceId:string,collectionJobId:string|undefined,assetId:string,organized?:{path:string;appliedAt:string}) {
    const asset=this.db.getAsset(assetId); if(!asset) return;
    const locations=this.db.listAssetLocations(asset.id).filter(x=>x.sourceId===sourceId);
    const observations=this.db.listObservations(asset.id);
    const decisions=this.db.listJevDecisions(asset.id).map(d=>({...d,reviewBand:reviewBand(d.confidence??0)}));
    const mediaType=locations[0]?inferMediaType(locations[0].relativePath):undefined;
    try{await this.control.syncAsset({workerId:this.workerId,sourceId,collectionJobId,asset:{id:asset.id,sha256:asset.sha256,mediaType,sizeBytes:asset.sizeBytes,sourcePaths:locations.map(x=>x.relativePath),observations,decisions,state:asset.state,...(organized?{organized}:{})}});}catch{/* durable local data remains authoritative; retry on later sync */}
  }

  private async syncJobAssets(sourceId:string,jobId:string) {
    for(const assetId of this.jobAssetIds(sourceId,jobId)) await this.pushAssetSync(sourceId,jobId,assetId);
  }

  /** Runs the identical hash -> dedupe -> analysis -> Jev -> sync pipeline
   * PROCESS_COLLECTION uses (see execute() below), for one selected subfolder
   * outside the archive_commands queue. Used by Lane 2 cloud intake
   * (lib/archive/intake.ts drainIntake) so a downloaded phone upload gets no
   * different treatment than a NAS folder. */
  async runIntakeCollectionJob(sourceId:string,selectedRelativePath:string) {
    const worker=new ArchiveWorker(this.db,{onHeartbeat: async h => {
      try { await this.control.heartbeat({workerId:this.workerId,sourceId,jobId:h.jobId,state:'PROCESSING',at:h.at}); } catch {}
    }});
    const job=worker.createJob(sourceId,selectedRelativePath);
    await worker.run(job.id);
    await this.runAnalysisAndJev(sourceId,job.id);
    await this.syncJobAssets(sourceId,job.id);
    return job;
  }

  /** Lane 2 poll-loop step: pull up to a few UPLOADED phone/camera-roll
   * uploads and run them through the same job path as a NAS folder. Never
   * throws (see run()'s call site); a no-op until ensureCloudIntakeSource has
   * resolved once at daemon start. */
  private async drainCloudIntake() {
    if(!this.cloudIntakeSourceId) return;
    const source=this.db.getSource(this.cloudIntakeSourceId); if(!source) return;
    await drainIntake({
      db:this.db, control:this.control, workerId:this.workerId, source,
      runCollectionJob:(sourceId,relativePath)=>this.runIntakeCollectionJob(sourceId,relativePath),
    });
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

  /** UPLOAD_JSON has no sourceId and touches no filesystem: the worker just
   * uploads bytes HITLOOP already assembled (an archive record, a collection
   * manifest, or the static viewer HTML) because the Arweave wallet lives
   * only here. Self-contained CLAIMED->RUNNING->COMPLETE/FAILED so a bad
   * command never needs a registered source to report failure cleanly. */
  private async executeUploadJson(command: ArchiveCommand) {
    try {
      if (command.kind !== 'archive-record' && command.kind !== 'collection-manifest' && command.kind !== 'viewer') {
        throw new Error(`Invalid UPLOAD_JSON kind: ${String(command.kind)}`);
      }
      if (!command.fileName) throw new Error('UPLOAD_JSON command missing fileName');
      if (!command.contentType) throw new Error('UPLOAD_JSON command missing contentType');
      if (command.payload === undefined || command.payload === null) throw new Error('UPLOAD_JSON command missing payload');

      await this.control.updateCommand({ commandId: command.id, state: 'RUNNING' });

      // 'viewer' carries a pre-rendered HTML string through as-is; the two
      // JSON kinds are pretty-printed the same way a human inspecting the
      // permanent Arweave record would expect.
      const bytes = command.kind === 'viewer'
        ? Buffer.from(String(command.payload), 'utf8')
        : Buffer.from(JSON.stringify(command.payload, null, 2), 'utf8');

      const uploaded = await this.uploadDocument({
        bytes,
        fileName: command.fileName,
        contentType: command.contentType,
        tags: command.tags || [],
      });

      await this.control.updateCommand({
        commandId: command.id,
        state: 'COMPLETE',
        result: { ...uploaded, kind: command.kind, fileName: command.fileName, refs: command.refs || {} },
      });
    } catch (error) {
      await this.control.updateCommand({ commandId: command.id, state: 'FAILED', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** `PROCESS_SELECTION`/`ORGANIZE_COLLECTION{items}` collectionId contract:
   * lowercase-kebab, 1-64 chars — the same shape `slugifyCollectionId` itself
   * produces for a single-folder job, so a HITLOOP-picker collectionId and a
   * derived-from-path one are always interchangeable. */
  private isValidCollectionId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
  }

  /** Validates a `PROCESS_SELECTION`/`ORGANIZE_COLLECTION{items}` item list
   * against the registered source: at most 500 items, each with a
   * `relativePath`/`kind`, resolving inside the source (no `..`/absolute
   * escape) and never inside the organizer's own reserved
   * `HITLOOP-ARCHIVE/` output tree. Throws on the first violation — same
   * convention as every other early-validation throw in `execute()` (e.g.
   * "Unknown source"): the run()-loop wrapper turns it into a FAILED command,
   * a direct `execute()` call (tests) rejects. */
  private validateSelectionItems(source: ArchiveSource, items: SelectionItem[] | undefined): SelectionItem[] {
    if (!Array.isArray(items) || !items.length) throw new Error('At least one selection item is required');
    if (items.length > 500) throw new Error('At most 500 selection items are allowed');
    const root = path.resolve(source.rootPath);
    for (const item of items) {
      if (!item || typeof item.relativePath !== 'string' || !item.relativePath) {
        throw new Error('Every selection item requires a relativePath');
      }
      if (item.kind !== 'file' && item.kind !== 'folder') {
        throw new Error(`Selection item has an invalid kind: ${item.relativePath}`);
      }
      const absolute = path.resolve(root, item.relativePath);
      const relative = path.relative(root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Selection item escapes source root: ${item.relativePath}`);
      }
      if (relative === ORGANIZED_ROOT_NAME || relative.startsWith(`${ORGANIZED_ROOT_NAME}${path.sep}`)) {
        throw new Error(`Selection item is inside ${ORGANIZED_ROOT_NAME}: ${item.relativePath}`);
      }
    }
    return items;
  }

  /** CANCEL_JOB (browse lane only — see runBrowseLane): stops whatever
   * PROCESS_COLLECTION/PROCESS_SELECTION job is currently running in the main
   * lane. Matches the active job by `jobId`/`targetCommandId` when given,
   * otherwise cancels whatever is active. `ArchiveWorker.cancel()` only sets
   * a flag — the actual walk stops (and the job's own state flips to
   * CANCELLED) the next time `run()` checks it, which is what eventually
   * makes the main lane PATCH the original process command to FAILED (see
   * the CANCELLED branches in the PROCESS_SELECTION/default execute() paths
   * below). When nothing is active (or the active job doesn't match the
   * requested target), falls back to failing a still-QUEUED process command
   * directly by id, so it never gets claimed at all. Never touches the
   * filesystem itself. */
  private async executeCancelJob(command: ArchiveCommand) {
    const targetJobId = command.jobId;
    const targetCommandId = command.targetCommandId;
    const active = this.activeJob;
    const matchesActive = Boolean(active)
      && (!targetJobId || targetJobId === active!.jobId)
      && (!targetCommandId || targetCommandId === active!.commandId);

    if (matchesActive) {
      active!.worker.cancel(active!.jobId);
      const job = this.db.getJob(active!.jobId);
      await this.control.updateCommand({
        commandId: command.id, state: 'COMPLETE',
        result: { cancelled: true, jobId: active!.jobId, hashedSoFar: job?.counters.hashed ?? 0 },
      });
      return;
    }

    if (targetCommandId) {
      try {
        await this.control.updateCommand({ commandId: targetCommandId, state: 'FAILED', error: 'CANCELLED' });
        await this.control.updateCommand({
          commandId: command.id, state: 'COMPLETE',
          result: { cancelled: true, jobId: targetJobId || null, hashedSoFar: 0 },
        });
      } catch (error) {
        await this.control.updateCommand({ commandId: command.id, state: 'FAILED', error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await this.control.updateCommand({ commandId: command.id, state: 'FAILED', error: 'No active or queued job to cancel' });
  }

  private async execute(command: ArchiveCommand) {
    await this.control.updateCommand({ commandId: command.id, state: 'CLAIMED' });

    if (command.type === 'UPLOAD_JSON') {
      await this.executeUploadJson(command);
      return;
    }

    if (command.type === 'CANCEL_JOB') {
      await this.executeCancelJob(command);
      return;
    }

    if (!command.sourceId) throw new Error(`Command ${command.id} missing sourceId`);
    const sourceId = command.sourceId; // narrowed const: stays 'string' inside closures below, unlike command.sourceId
    const source = this.db.getSource(sourceId);
    if (!source) throw new Error(`Unknown source ${sourceId}`);

    if (command.type === 'UPLOAD_ASSET_ARWEAVE') {
      if(!command.expectedSha256||!command.collectionId||!command.archiveName||!command.relativePath) throw new Error('Incomplete Arweave upload command');
      const root=path.resolve(source.rootPath);
      const target=path.resolve(root,command.relativePath);
      const relative=path.relative(root,target);
      if(relative.startsWith('..')||path.isAbsolute(relative)) throw new Error('Upload path escapes registered source');
      // Lane 2 only: an UPLOAD_ASSET_ARWEAVE command for this asset only
      // exists once HITLOOP's human review confirmed it, so its arrival is
      // itself the REVIEWED signal (see intake.ts markIntakeReviewed).
      const cloudIntakeId=sourceId===this.cloudIntakeSourceId?resolveIntakeIdFromRelativePath(command.relativePath):null;
      if(cloudIntakeId) await markIntakeReviewed(this.control,this.workerId,cloudIntakeId);
      // Re-hash immediately before permanent upload. The approved bytes must be
      // exactly the bytes that were reviewed.
      const currentHash=await sha256File(target);
      if(currentHash!==command.expectedSha256) throw new Error('Source bytes changed after approval; re-review required');
      await this.control.updateCommand({commandId:command.id,state:'RUNNING'});
      const uploaded=await this.uploadOriginal({filePath:target,archiveName:command.archiveName,contentType:command.contentType,sha256:currentHash,collectionId:command.collectionId});
      await this.control.updateCommand({commandId:command.id,state:'COMPLETE',result:{...uploaded,contentAssetId:command.contentAssetId,collectionId:command.collectionId,archiveName:command.archiveName,sha256:currentHash,contentType:command.contentType||null,sourceId,relativePath:command.relativePath}});
      // Only after the command is durably COMPLETE: ARCHIVED, purge the
      // Firebase object, delete the local scratch copy (D3/D4). Never before.
      if(cloudIntakeId&&this.cloudIntakeRootPath) await archiveAndPurgeIntake({control:this.control,workerId:this.workerId,intakeId:cloudIntakeId,root:this.cloudIntakeRootPath});
      return;
    }

        if (command.type === 'LIST_DIRECTORY') {
      const root = path.resolve(source.rootPath);
      const target = path.resolve(root, command.relativePath || '.');
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Directory escapes registered source');
      const dirents = await fs.readdir(target, { withFileTypes:true });
      const visible = dirents.filter(e => !e.name.startsWith('.') && !isFilesystemArtifact(e.name));
      const folderDirents = visible.filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));
      const fileDirents = visible.filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name));

      // Kept byte-for-byte compatible with the pre-Phase-1 result shape —
      // existing callers reading `result.folders` see no change.
      const folders = folderDirents.map(e=>e.name);
      const folderEntries = folderDirents.map(e=>({ name:e.name, kind:'folder' as const }));

      // Dirent carries no size/mtime; stat each file with bounded concurrency
      // so a folder with thousands of files doesn't serialize (slow) or storm
      // the NAS's SMB mount (all at once). A stat failure (race, permission,
      // dangling symlink) still yields an entry — just without size/modifiedAt.
      const fileEntries = await mapWithConcurrency(fileDirents, 16, async e => {
        const extension = path.extname(e.name).slice(1).toLowerCase();
        const entry: { name:string; kind:'file'; sizeBytes?:number; modifiedAt?:string; ext?:string; movable:boolean } = {
          name: e.name, kind: 'file', movable: isMovableExtension(e.name),
        };
        if (extension) entry.ext = extension;
        try {
          const stat = await fs.stat(path.join(target, e.name));
          entry.sizeBytes = stat.size;
          entry.modifiedAt = stat.mtime.toISOString();
        } catch { /* still include the entry without size/mtime */ }
        return entry;
      });

      const dirEntries = [...folderEntries, ...fileEntries];
      await this.control.updateCommand({
        commandId:command.id, state:'COMPLETE',
        result:{ relativePath:relative || '.', folders, entries:dirEntries, counts:{ folders: folderEntries.length, files: fileEntries.length } },
      });
      return;
    }

    if (command.type === 'PROCESS_SELECTION') {
      if (!this.isValidCollectionId(command.collectionId)) {
        throw new Error('PROCESS_SELECTION requires a valid collectionId (lowercase-kebab, 1-64 chars)');
      }
      const items = this.validateSelectionItems(source, command.items);

      // Identical path to PROCESS_COLLECTION below (worker run ->
      // runAnalysisAndJev -> syncJobAssets -> heartbeats/COMPLETE|FAILED) —
      // only how the job is created differs (an explicit item selection
      // instead of a single selectedRelativePath).
      const worker = new ArchiveWorker(this.db, {
        onHeartbeat: async h => {
          const job = this.db.getJob(h.jobId);
          try {
            await this.control.heartbeat({
              workerId: this.workerId, sourceId, jobId: h.jobId,
              state: 'PROCESSING', at: h.at, counters: job?.counters,
            });
          } catch { /* processing must survive control-plane telemetry failure */ }
        },
      });
      const job = worker.createJob(sourceId, '.', { selection: items, collectionId: command.collectionId, mediaOnly: command.mediaOnly });
      await this.control.updateCommand({ commandId: command.id, state: 'RUNNING', jobId: job.id });
      this.activeJob = { jobId: job.id, commandId: command.id, worker };
      let result: CollectionJobRecord;
      try {
        result = await worker.run(job.id);
      } finally {
        this.activeJob = undefined;
      }
      if (result.state === 'CANCELLED') {
        await this.control.updateCommand({ commandId: command.id, state: 'FAILED', jobId: job.id, error: `CANCELLED by owner (kept ${result.counters.hashed} hashed files)` });
        return;
      }
      await this.runAnalysisAndJev(sourceId, job.id);
      await this.syncJobAssets(sourceId, job.id);
      const state = result.state === 'COMPLETE' ? 'COMPLETE' : 'FAILED';
      await this.control.updateCommand({
        commandId: command.id, state, jobId: job.id, error: state === 'FAILED' ? 'Collection did not complete' : null,
        ...(state === 'COMPLETE' && result.skippedNonMedia ? { result: { skippedNonMedia: result.skippedNonMedia } } : {}),
      });
      return;
    }

    if (command.type === 'ORGANIZE_COLLECTION') {
      const hasItems = Boolean(command.items && command.items.length);
      let plan: OrganizePlan;
      if (hasItems) {
        if (!this.isValidCollectionId(command.collectionId)) {
          throw new Error('ORGANIZE_COLLECTION with items requires a valid collectionId (lowercase-kebab, 1-64 chars)');
        }
        const items = this.validateSelectionItems(source, command.items);
        plan = await planOrganizeCollection({ db:this.db, source, items, collectionId: command.collectionId! });
      } else {
        const selectedRelativePath = command.relativePath || '.';
        plan = await planOrganizeCollection({ db:this.db, source, selectedRelativePath });
      }

      if (command.mode !== 'apply') {
        // plan writes nothing to disk or SQLite; just hands the move/skip
        // list back for /archive to render before anyone clicks APPLY.
        await this.control.updateCommand({ commandId:command.id, state:'COMPLETE', result:{ mode:'plan', plan } });
        return;
      }

      await this.control.updateCommand({ commandId:command.id, state:'RUNNING' });
      // This command's own id is the "job" every moved file's journal line
      // and organize_moves row is tagged with — what UNDO_ORGANIZE replays.
      const applied = await applyOrganizePlan({ db:this.db, source, jobId:command.id, plan });

      for (const move of applied.moved) {
        const asset = this.db.findAssetByHash(move.sha256);
        if (!asset) continue;
        try { await this.pushAssetSync(sourceId, undefined, asset.id, { path: move.to, appliedAt: new Date().toISOString() }); }
        catch { /* best-effort; local SQLite (organized_path/organized_at) remains authoritative */ }
      }

      const state = applied.failedAt ? 'FAILED' : 'COMPLETE';
      await this.control.updateCommand({
        commandId:command.id, state,
        error: applied.failedAt ? applied.failedAt.error : null,
        result: { mode:'apply', jobId:command.id, root:plan.root, collectionId:plan.collectionId, moved:applied.moved, skipped:plan.skipped, counts:plan.counts, failedAt: applied.failedAt || null },
      });
      return;
    }

    if (command.type === 'UNDO_ORGANIZE') {
      // An explicit collectionId (a selection's collection, or any collection
      // the caller already knows the id of) wins; otherwise fall back to the
      // pre-existing relativePath -> slug derivation.
      const collectionId = command.collectionId || slugifyCollectionId(command.relativePath || '.');
      const jobId = command.organizeJobId || this.db.findLatestOrganizeJobIdForCollection(collectionId);
      if (!jobId) throw new Error('No organize job found to undo for this collection');

      await this.control.updateCommand({ commandId:command.id, state:'RUNNING' });
      const undone = await undoOrganizeJob({ db:this.db, source, jobId });
      const state = undone.errors.length ? 'FAILED' : 'COMPLETE';
      await this.control.updateCommand({
        commandId:command.id, state,
        error: undone.errors.length ? undone.errors[0].error : null,
        result: { jobId: undone.jobId, restored: undone.restored, errors: undone.errors },
      });
      return;
    }

    const worker = new ArchiveWorker(this.db, {
      onHeartbeat: async h => {
        const job = this.db.getJob(h.jobId);
        try {
          await this.control.heartbeat({
            workerId: this.workerId, sourceId, jobId: h.jobId,
            state: 'PROCESSING', at: h.at, counters: job?.counters,
          });
        } catch { /* processing must survive control-plane telemetry failure */ }
      },
    });
    const job = worker.createJob(sourceId, command.relativePath, { mediaOnly: command.mediaOnly });
    await this.control.updateCommand({ commandId: command.id, state: 'RUNNING', jobId: job.id });
    this.activeJob = { jobId: job.id, commandId: command.id, worker };
    let result: CollectionJobRecord;
    try {
      result = await worker.run(job.id);
    } finally {
      this.activeJob = undefined;
    }
    if (result.state === 'CANCELLED') {
      await this.control.updateCommand({ commandId: command.id, state: 'FAILED', jobId: job.id, error: `CANCELLED by owner (kept ${result.counters.hashed} hashed files)` });
      return;
    }
    await this.runAnalysisAndJev(sourceId,job.id);
    await this.syncJobAssets(sourceId,job.id);
    const state = result.state === 'COMPLETE' ? 'COMPLETE' : 'FAILED';
    await this.control.updateCommand({
      commandId: command.id, state, jobId: job.id, error: state === 'FAILED' ? 'Collection did not complete' : null,
      ...(state === 'COMPLETE' && result.skippedNonMedia ? { result: { skippedNonMedia: result.skippedNonMedia } } : {}),
    });
  }

  /** Phase 1 fast lane: a second, independent poll loop scoped to
   * LIST_DIRECTORY and CANCEL_JOB, so a cheap readdir (or a cancel request)
   * never waits behind a slow PROCESS_COLLECTION/analysis pass running in the
   * main loop — CANCEL_JOB in particular must be able to reach the daemon
   * WHILE the main lane is busy inside worker.run(), which is the whole
   * point of it living here. Started (unwaited) from run() and stopped by
   * the same `stopped` flag. Errors (a bad command, or HITLOOP being briefly
   * unreachable) never stop this loop or the main one. At most one command
   * executes at a time in this lane: the for-of below awaits each command
   * before claiming more. */
  private async runBrowseLane(pollMs = 1000) {
    while (!this.stopped) {
      try {
        const commands = await this.control.pollCommands(this.workerId, { types: ['LIST_DIRECTORY', 'CANCEL_JOB'] });
        for (const command of commands) {
          try { await this.execute(command); }
          catch (error) {
            await this.control.updateCommand({ commandId: command.id, state: 'FAILED', error: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch { /* the browse lane must survive a transient HITLOOP outage same as the main loop */ }
      await sleep(pollMs);
    }
  }

  async run(pollMs = 5000, browsePollMs = 1000) {
    // Lane 2 cloud intake: register the local scratch source once at start (D1 —
    // never under /Volumes or any NAS mount). Non-fatal: a failure here just
    // means drainCloudIntake stays a no-op until the next restart.
    try {
      const cloudSource = await ensureCloudIntakeSource(this.db, this.control, this.workerId);
      this.cloudIntakeSourceId = cloudSource.id;
      this.cloudIntakeRootPath = cloudSource.rootPath;
    } catch (error) { console.log(`cloud intake source setup failed: ${error instanceof Error?error.message:String(error)}`); }

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

    // Start the browse lane concurrently with the main loop below; both are
    // gated by the same `stopped` flag, and run() only resolves once both
    // have exited (see the await at the bottom of this method).
    const browseLanePromise = this.runBrowseLane(browsePollMs);

    let pollsSinceHeartbeat = 0;
    let pollsSinceSweep = 0;
    // Offset from pollsSinceSweep's own 6-poll cadence (starts at 3, not 0) so
    // the analysis sweep and the intake drain never land on the same tick.
    let pollsSinceIntake = 3;
    while (!this.stopped) {
      if (++pollsSinceHeartbeat >= 12) { pollsSinceHeartbeat = 0; await idleHeartbeat(); }
      // ~30s at the default 5s pollMs. Awaited inline (not fire-and-forget), so
      // it runs between poll iterations and never overlaps a running command.
      if (++pollsSinceSweep >= 6) {
        pollsSinceSweep = 0;
        try { await this.sweepPendingAnalysis(); } catch { /* a sweep failure must not stop the poll loop */ }
      }
      if (this.control.configured && ++pollsSinceIntake >= 6) {
        pollsSinceIntake = 0;
        try { await this.drainCloudIntake(); } catch { /* a drain failure must not stop the poll loop */ }
      }
      try {
        // excludeTypes keeps LIST_DIRECTORY/CANCEL_JOB exclusively on the
        // browse lane above so the two lanes never claim the same command.
        const commands = await this.control.pollCommands(this.workerId, { excludeTypes: ['LIST_DIRECTORY', 'CANCEL_JOB'] });
        for (const command of commands) {
          try { await this.execute(command); }
          catch (error) {
            await this.control.updateCommand({ commandId: command.id, state: 'FAILED', error: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch { /* NAS work remains independent if HITLOOP is temporarily unreachable */ }
      await sleep(pollMs);
    }
    await browseLanePromise;
  }
}

if (process.argv[1]?.endsWith('daemon.ts')) {
  const daemon = new ArchiveDaemon();
  process.on('SIGINT', () => daemon.stop());
  process.on('SIGTERM', () => daemon.stop());
  void daemon.run();
}
