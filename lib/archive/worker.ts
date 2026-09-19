import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { sha256File } from './hash';
import { ManifestStore } from './manifest';
import type { ArchiveSource, CollectionJobRecord, FileLocationRecord } from './types';

const SKIP = new Set(['.git', 'node_modules', '.moleboard']);

function locationId(sourceId: string, relativePath: string): string {
  return createHash('sha256').update(sourceId + ':' + relativePath).digest('hex');
}

async function* walk(root: string, current = root): AsyncGenerator<string> {
  let dir;
  try { dir = await fs.opendir(current); } catch { return; }
  for await (const entry of dir) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) yield* walk(root, full);
    else if (entry.isFile()) yield full;
  }
}

export class ArchiveWorker {
  constructor(private store = new ManifestStore()) {}

  async registerSource(label: string, rootPath: string): Promise<ArchiveSource> {
    const resolved = path.resolve(rootPath);
    await fs.access(resolved);
    const now = new Date().toISOString();
    const id = createHash('sha256').update(resolved).digest('hex').slice(0, 24);
    const source: ArchiveSource = { id, label, rootPath: resolved, state: 'ONLINE', createdAt: now, lastSeenAt: now };
    this.store.mutate(m => { m.sources[id] = source; });
    return source;
  }

  createJob(sourceId: string, selectedRelativePath = '.'): CollectionJobRecord {
    const now = new Date().toISOString();
    const job: CollectionJobRecord = {
      id: randomUUID(), sourceId, selectedRelativePath, state: 'QUEUED',
      createdAt: now, updatedAt: now,
      counters: { discovered: 0, hashed: 0, duplicates: 0, failed: 0 }
    };
    this.store.mutate(m => { m.jobs[job.id] = job; });
    return job;
  }

  async run(jobId: string): Promise<CollectionJobRecord> {
    const snap = this.store.snapshot();
    const job = snap.jobs[jobId];
    if (!job) throw new Error('Unknown job');
    const source = snap.sources[job.sourceId];
    if (!source) throw new Error('Unknown source');

    const selectedRoot = path.resolve(source.rootPath, job.selectedRelativePath);
    if (!selectedRoot.startsWith(source.rootPath)) throw new Error('Selected path escapes source root');

    this.store.mutate(m => { m.jobs[jobId].state = 'RUNNING'; m.jobs[jobId].updatedAt = new Date().toISOString(); });

    for await (const fullPath of walk(selectedRoot)) {
      const relativePath = path.relative(source.rootPath, fullPath);
      const id = locationId(source.id, relativePath);
      try {
        const stat = await fs.stat(fullPath);
        const prior = this.store.snapshot().locations[id];

        // Incremental rescan: unchanged known location is already accounted for.
        if (prior && prior.sizeBytes === stat.size && prior.modifiedAtMs === stat.mtimeMs && prior.contentAssetId) {
          this.store.mutate(m => { m.locations[id].lastSeenAt = new Date().toISOString(); });
          continue;
        }

        const now = new Date().toISOString();
        const location: FileLocationRecord = {
          id, sourceId: source.id, relativePath, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs,
          discoveredAt: prior?.discoveredAt || now, lastSeenAt: now, state: 'HASHING'
        };
        this.store.mutate(m => {
          m.locations[id] = location;
          m.jobs[jobId].counters.discovered++;
        });

        const hash = await sha256File(fullPath);
        const after = await fs.stat(fullPath);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
          throw new Error('File changed while hashing; retry on next run');
        }

        this.store.mutate(m => {
          const existingAssetId = m.assetByHash[hash];
          if (existingAssetId) {
            m.locations[id] = { ...m.locations[id], contentAssetId: existingAssetId, state: 'DUPLICATE' };
            m.jobs[jobId].counters.duplicates++;
          } else {
            const assetId = hash;
            m.assets[assetId] = { id: assetId, sha256: hash, sizeBytes: stat.size, createdAt: now, state: 'QUEUED' };
            m.assetByHash[hash] = assetId;
            m.locations[id] = { ...m.locations[id], contentAssetId: assetId, state: 'HASHED' };
          }
          m.jobs[jobId].counters.hashed++;
          m.jobs[jobId].updatedAt = new Date().toISOString();
        });
      } catch (error) {
        this.store.mutate(m => {
          const current = m.locations[id];
          if (current) m.locations[id] = { ...current, state: 'RETRYABLE_FAILED', error: error instanceof Error ? error.message : String(error) };
          m.jobs[jobId].counters.failed++;
          m.jobs[jobId].updatedAt = new Date().toISOString();
        });
      }
    }

    this.store.mutate(m => {
      m.jobs[jobId].state = 'COMPLETE';
      m.jobs[jobId].updatedAt = new Date().toISOString();
      if (m.sources[source.id]) {
        m.sources[source.id].state = 'ONLINE';
        m.sources[source.id].lastSeenAt = new Date().toISOString();
      }
    });
    return this.store.snapshot().jobs[jobId];
  }
}
