import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { sha256File } from './hash';
import { ArchiveDatabase } from './database';
import type { ArchiveSource, CollectionJobRecord, FileLocationRecord } from './types';

const SKIP = new Set(['.git', 'node_modules', '.moleboard']);

function locationId(sourceId: string, relativePath: string): string {
  return createHash('sha256').update(sourceId + ':' + relativePath).digest('hex');
}

async function* walk(root: string, current = root): AsyncGenerator<string> {
  const dir = await fs.opendir(current);
  for await (const entry of dir) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) yield* walk(root, full);
    else if (entry.isFile()) yield full;
  }
}

export interface ArchiveWorkerOptions {
  stableFileDwellMs?: number;
  onHeartbeat?: (status: { jobId: string; sourceId: string; at: string }) => void;
  heartbeatEveryFiles?: number;
}

export class ArchiveWorker {
  private pauseRequested = new Set<string>();
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

  createJob(sourceId: string, selectedRelativePath = '.'): CollectionJobRecord {
    const now = new Date().toISOString();
    const job: CollectionJobRecord = {
      id: randomUUID(), sourceId, selectedRelativePath, state: 'QUEUED',
      createdAt: now, updatedAt: now,
      counters: { discovered: 0, hashed: 0, duplicates: 0, failed: 0 }
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
    const selectedRoot = path.resolve(sourceRoot, job.selectedRelativePath);
    const selectedRelative = path.relative(sourceRoot, selectedRoot);
    if (selectedRelative.startsWith('..') || path.isAbsolute(selectedRelative)) {
      throw new Error('Selected path escapes source root');
    }

    this.store.setJobState(jobId, 'RUNNING');

    try {
      await fs.access(selectedRoot);
    } catch {
      this.store.upsertSource({ ...source, state: 'OFFLINE', lastSeenAt: source.lastSeenAt });
      this.store.setJobState(jobId, 'PAUSED');
      return this.store.getJob(jobId)!;
    }

    let processedSinceHeartbeat = 0;
    this.heartbeat(jobId, source.id);
    try {
    for await (const fullPath of walk(selectedRoot)) {
      if (this.pauseRequested.has(jobId)) return this.store.getJob(jobId)!;
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
          id, sourceId: source.id, relativePath, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs,
          discoveredAt: prior?.discoveredAt || now, lastSeenAt: now, state: 'HASHING'
        };
        this.store.upsertLocation(location);
        this.store.bumpJob(jobId, 'discovered');

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
          this.store.insertAsset({ id: hash, sha256: hash, sizeBytes: stat.size, createdAt: now, state: 'QUEUED' });
          this.store.upsertLocation({ ...this.store.getLocation(id)!, contentAssetId: hash, state: 'HASHED' });
        }
        this.store.bumpJob(jobId, 'hashed');
      } catch (error) {
        const current = this.store.getLocation(id);
        if (current) this.store.upsertLocation({ ...current, state: 'RETRYABLE_FAILED', error: error instanceof Error ? error.message : String(error) });
        this.store.bumpJob(jobId, 'failed');
      }
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
      await fs.access(selectedRoot);
    } catch {
      this.store.upsertSource({ ...source, state: 'OFFLINE', lastSeenAt: source.lastSeenAt });
      this.store.setJobState(jobId, 'PAUSED');
      return this.store.getJob(jobId)!;
    }

    this.store.setJobState(jobId, 'COMPLETE');
    this.store.upsertSource({ ...source, state: 'ONLINE', lastSeenAt: new Date().toISOString() });
    return this.store.getJob(jobId)!;
  }
}
