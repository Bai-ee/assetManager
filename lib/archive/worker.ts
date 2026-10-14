import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { sha256File } from './hash';
import { ArchiveDatabase } from './database';
import type { ArchiveSource, CollectionJobRecord, FileLocationRecord, SelectionItem } from './types';
import { isFilesystemArtifact, isMovableExtension, ORGANIZED_ROOT_NAME } from './organize/scheme';

// Re-exported for existing callers (`daemon.ts`) — canonical definitions now
// live in `organize/scheme.ts` so the organizer's pure module has no
// dependency on the worker, and the worker's discovery walk agrees with the
// organizer about what "real" content is and where its own output tree lives.
export { isFilesystemArtifact, ORGANIZED_ROOT_NAME };

const SKIP = new Set(['.git', 'node_modules', '.moleboard']);

function locationId(sourceId: string, relativePath: string): string {
  return createHash('sha256').update(sourceId + ':' + relativePath).digest('hex');
}

async function* walk(root: string, current = root): AsyncGenerator<string> {
  const dir = await fs.opendir(current);
  for await (const entry of dir) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name === ORGANIZED_ROOT_NAME) {
      // Never re-discover the organizer's own output tree as source content,
      // unless this job's own root is already inside it (a correction
      // re-file walking within the organized tree itself).
      const rootIsInsideOrganized = root.split(path.sep).includes(ORGANIZED_ROOT_NAME);
      if (!rootIsInsideOrganized) continue;
    }
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) { yield* walk(root, full); continue; }
    if (entry.isFile()) {
      if (isFilesystemArtifact(entry.name)) continue;
      yield full;
    }
  }
}

/**
 * PROCESS_SELECTION discovery: the union of each `folder` item (walked
 * recursively with the identical `walk()` rules above — HITLOOP-ARCHIVE
 * skip, artifact skip) plus each `file` item (yielded directly; existence/
 * stability is left to the normal per-file try/catch in `run()`, same as
 * every path `walk()` itself produces). Absolute paths already yielded are
 * never yielded twice, so a file that sits inside one selected folder and is
 * ALSO separately selected (or falls under two overlapping selected folders)
 * is only ever hashed once.
 */
async function* selectionWalk(sourceRoot: string, items: SelectionItem[]): AsyncGenerator<string> {
  const seen = new Set<string>();
  for (const item of items) {
    const absolute = path.resolve(sourceRoot, item.relativePath);
    if (item.kind === 'folder') {
      for await (const filePath of walk(absolute)) {
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        yield filePath;
      }
    } else {
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      yield absolute;
    }
  }
}

export interface ArchiveWorkerOptions {
  stableFileDwellMs?: number;
  onHeartbeat?: (status: { jobId: string; sourceId: string; at: string }) => void;
  heartbeatEveryFiles?: number;
}

export class ArchiveWorker {
  private pauseRequested = new Set<string>();
  /** Jobs whose next per-file check (see `run()`) should stop the walk and
   * mark the job CANCELLED. Set by `cancel()` — safe to call from a
   * different code path (the daemon's browse lane) than the one whose
   * `run()`/`resume()` is actually iterating this job, since both share the
   * same `ArchiveWorker` instance while a command is in flight. */
  private cancelRequested = new Set<string>();
  private options: Required<Pick<ArchiveWorkerOptions, 'stableFileDwellMs' | 'heartbeatEveryFiles'>> & ArchiveWorkerOptions;

  constructor(private store = new ArchiveDatabase(), options: ArchiveWorkerOptions = {}) {
    this.options = {
      stableFileDwellMs: options.stableFileDwellMs ?? 2000,
      heartbeatEveryFiles: options.heartbeatEveryFiles ?? 100,
      ...options,
    };
  }

  private async waitForStableFile(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>>> {
    const before = await fs.stat(filePath);
    if (this.options.stableFileDwellMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.options.stableFileDwellMs));
    }
    const after = await fs.stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('File is still changing; retry later');
    }
    return after;
  }

  private heartbeat(jobId: string, sourceId: string): void {
    this.options.onHeartbeat?.({ jobId, sourceId, at: new Date().toISOString() });
  }

  pause(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error('Unknown job');
    this.pauseRequested.add(jobId);
    this.store.setJobState(jobId, 'PAUSED');
  }

  /** Requests that a currently-running `run()`/`resume()` for this job stop
   * at its next per-file check point (see `run()`) and mark the job
   * CANCELLED. Unlike `pause()`, this does NOT set the job state itself —
   * `run()` does that once it actually observes the flag, so the state
   * transition happens exactly where the walk actually stopped (and, for the
   * mid-hash check point, after the in-flight location has been marked
   * RETRYABLE_FAILED). Safe to call for a job this instance isn't currently
   * running (e.g. it already finished): the flag is simply never observed
   * and left for the next `run()`/`resume()` call to pick up. */
  cancel(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error('Unknown job');
    this.cancelRequested.add(jobId);
  }

  private cancelJob(jobId: string): CollectionJobRecord {
    this.cancelRequested.delete(jobId);
    this.store.setJobState(jobId, 'CANCELLED');
    return this.store.getJob(jobId)!;
  }

  resume(jobId: string): Promise<CollectionJobRecord> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error('Unknown job');
    if (job.state !== 'PAUSED' && job.state !== 'FAILED') throw new Error('Job is not resumable');
    this.pauseRequested.delete(jobId);
    return this.run(jobId);
  }

  async registerSource(label: string, rootPath: string): Promise<ArchiveSource> {
    const resolved = path.resolve(rootPath);
    await fs.access(resolved);
    const now = new Date().toISOString();
    const id = createHash('sha256').update(resolved).digest('hex').slice(0, 24);
    const source: ArchiveSource = { id, label, rootPath: resolved, state: 'ONLINE', createdAt: now, lastSeenAt: now };
    this.store.upsertSource(source);
    return source;
  }

  createJob(sourceId: string, selectedRelativePath = '.', opts?: { selection?: SelectionItem[]; collectionId?: string; mediaOnly?: boolean }): CollectionJobRecord {
    const now = new Date().toISOString();
    const job: CollectionJobRecord = {
      id: randomUUID(), sourceId, selectedRelativePath, state: 'QUEUED',
      createdAt: now, updatedAt: now,
      counters: { discovered: 0, hashed: 0, duplicates: 0, failed: 0 },
      ...(opts?.selection ? { selection: opts.selection } : {}),
      ...(opts?.collectionId ? { collectionId: opts.collectionId } : {}),
      ...(opts?.mediaOnly ? { mediaOnly: true } : {}),
    };
    this.store.insertJob(job);
    return job;
  }

  async run(jobId: string): Promise<CollectionJobRecord> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error('Unknown job');
    const source = this.store.getSource(job.sourceId);
    if (!source) throw new Error('Unknown source');

    const sourceRoot = path.resolve(source.rootPath);
    const isSelectionJob = Boolean(job.selection && job.selection.length);

    // Single-folder jobs (PROCESS_COLLECTION) keep the exact prior validation
    // and existence-check target (`selectedRoot`). Selection jobs (
    // PROCESS_SELECTION) have no single root to resolve — every item is
    // validated individually instead. The daemon already validates a
    // PROCESS_SELECTION command's items before creating the job; this is a
    // defense-in-depth re-check, same relationship PROCESS_COLLECTION has
    // between daemon.ts and this escape check.
    let selectedRoot = sourceRoot;
    if (isSelectionJob) {
      for (const item of job.selection!) {
        const absolute = path.resolve(sourceRoot, item.relativePath);
        const relative = path.relative(sourceRoot, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Selected item escapes source root: ${item.relativePath}`);
        }
      }
    } else {
      selectedRoot = path.resolve(sourceRoot, job.selectedRelativePath);
      const selectedRelative = path.relative(sourceRoot, selectedRoot);
      if (selectedRelative.startsWith('..') || path.isAbsolute(selectedRelative)) {
        throw new Error('Selected path escapes source root');
      }
    }

    this.store.setJobState(jobId, 'RUNNING');

    const rootsReachable = async () => {
      if (isSelectionJob) {
        await Promise.all(job.selection!.map(item => fs.access(path.resolve(sourceRoot, item.relativePath))));
      } else {
        await fs.access(selectedRoot);
      }
    };

    try {
      await rootsReachable();
    } catch {
      this.store.upsertSource({ ...source, state: 'OFFLINE', lastSeenAt: source.lastSeenAt });
      this.store.setJobState(jobId, 'PAUSED');
      return this.store.getJob(jobId)!;
    }

    const mediaOnly = Boolean(job.mediaOnly);
    let skippedNonMedia = 0;
    let processedSinceHeartbeat = 0;
    this.heartbeat(jobId, source.id);
    try {
    for await (const fullPath of (isSelectionJob ? selectionWalk(sourceRoot, job.selection!) : walk(selectedRoot))) {
      if (this.pauseRequested.has(jobId)) return this.store.getJob(jobId)!;
      if (this.cancelRequested.has(jobId)) return this.cancelJob(jobId);
      if (mediaOnly && !isMovableExtension(path.basename(fullPath))) {
        // Never stat'd or hashed, and never counted as discovered/failed —
        // it simply never existed as far as this job is concerned.
        skippedNonMedia++;
        continue;
      }
      processedSinceHeartbeat++;
      if (processedSinceHeartbeat >= this.options.heartbeatEveryFiles) {
        this.heartbeat(jobId, source.id);
        processedSinceHeartbeat = 0;
      }
      const relativePath = path.relative(source.rootPath, fullPath);
      const id = locationId(source.id, relativePath);
      try {
        const stat = await this.waitForStableFile(fullPath);
        const prior = this.store.getLocation(id);

        // Incremental rescan: unchanged known location is already accounted for.
        if (prior && prior.sizeBytes === stat.size && prior.modifiedAtMs === stat.mtimeMs && prior.contentAssetId) {
          this.store.upsertLocation({ ...prior, lastSeenAt: new Date().toISOString() });
          continue;
        }

        const now = new Date().toISOString();
        const location: FileLocationRecord = {
          id, sourceId: source.id, relativePath, sizeBytes: Number(stat.size), modifiedAtMs: Number(stat.mtimeMs),
          discoveredAt: prior?.discoveredAt || now, lastSeenAt: now, state: 'HASHING'
        };
        this.store.upsertLocation(location);
        this.store.bumpJob(jobId, 'discovered');

        // Cancellation check point #2: this file is now durably marked
        // HASHING (the "in-flight" location a CANCEL_JOB must not leave
        // dangling) right before the potentially slow hash itself. Mark it
        // retryable instead of proceeding.
        if (this.cancelRequested.has(jobId)) {
          this.store.upsertLocation({ ...this.store.getLocation(id)!, state: 'RETRYABLE_FAILED', error: 'cancelled' });
          return this.cancelJob(jobId);
        }

        const hash = await sha256File(fullPath);
        const after = await fs.stat(fullPath);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
          throw new Error('File changed while hashing; retry on next run');
        }

        const existing = this.store.findAssetByHash(hash);
        if (existing) {
          this.store.upsertLocation({ ...this.store.getLocation(id)!, contentAssetId: existing.id, state: 'DUPLICATE' });
          this.store.bumpJob(jobId, 'duplicates');
        } else {
          this.store.insertAsset({ id: hash, sha256: hash, sizeBytes: Number(stat.size), createdAt: now, state: 'QUEUED' });
          this.store.upsertLocation({ ...this.store.getLocation(id)!, contentAssetId: hash, state: 'HASHED' });
        }
        this.store.bumpJob(jobId, 'hashed');
      } catch (error) {
        // A file can fail before any location row exists: an unreadable stat, or a
        // file still being written when the stability check runs. Safety invariant 9
        // (unsupported/corrupt files are recorded, not silently lost) means the
        // failure must still leave a durable, retryable FileLocation — retry work is
        // driven off file_locations.state, so a missing row is a permanently dropped
        // file, not merely a missing counter.
        const now = new Date().toISOString();
        const current = this.store.getLocation(id);
        let record = current;
        if (!record) {
          // Best effort: capture whatever metadata is still readable. An unreadable
          // or vanished file is recorded with unknown size/mtime so the next scan
          // treats it as changed and retries it.
          let sizeBytes = 0;
          let modifiedAtMs = 0;
          try {
            const seen = await fs.stat(fullPath);
            sizeBytes = Number(seen.size);
            modifiedAtMs = Number(seen.mtimeMs);
          } catch { /* metadata unavailable; the row itself is what must survive */ }
          record = {
            id, sourceId: source.id, relativePath, sizeBytes, modifiedAtMs,
            discoveredAt: now, lastSeenAt: now, state: 'DISCOVERED',
          };
          this.store.bumpJob(jobId, 'discovered');
        }
        this.store.upsertLocation({
          ...record, lastSeenAt: now, state: 'RETRYABLE_FAILED',
          error: error instanceof Error ? error.message : String(error),
        });
        this.store.bumpJob(jobId, 'failed');
      }
    }

    } catch (error) {
      // Traversal failures are not completion. A disconnected/unreadable subtree must
      // leave a resumable job rather than silently losing files.
      this.store.setJobState(jobId, 'PAUSED');
      this.store.upsertSource({ ...source, state: 'OFFLINE', lastSeenAt: source.lastSeenAt });
      return this.store.getJob(jobId)!;
    }

    // A disconnected NAS can make traversal end early. Verify source still exists
    // before ever marking the collection complete.
    try {
      await rootsReachable();
    } catch {
      this.store.upsertSource({ ...source, state: 'OFFLINE', lastSeenAt: source.lastSeenAt });
      this.store.setJobState(jobId, 'PAUSED');
      return this.store.getJob(jobId)!;
    }

    this.store.setJobState(jobId, 'COMPLETE');
    this.store.upsertSource({ ...source, state: 'ONLINE', lastSeenAt: new Date().toISOString() });
    const finished = this.store.getJob(jobId)!;
    // In-memory only (see CollectionJobRecord.skippedNonMedia) — never
    // written to SQLite, so a later getJob() for this same id won't carry it.
    return skippedNonMedia > 0 ? { ...finished, skippedNonMedia } : finished;
  }
}
