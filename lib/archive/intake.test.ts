import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';
import {
  drainIntake,
  cloudIntakeRoot,
  archiveAndPurgeIntake,
  resolveIntakeIdFromRelativePath,
  MAX_INTAKE_PER_DRAIN,
  type DrainIntakeDeps,
} from './intake';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-intake-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const sourceRoot = path.join(dir, 'cloud-intake');
  await fs.mkdir(sourceRoot, { recursive: true });
  const db = new ArchiveDatabase(dbPath);
  const worker = new ArchiveWorker(db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('Cloud intake', sourceRoot);
  return { dir, dbPath, sourceRoot, db, worker, source };
}

function fakeControl() {
  const claimed: any[] = [];
  const updates: any[] = [];
  const purges: any[] = [];
  return {
    claimed, updates, purges,
    listIntakeCalls: 0,
    _items: [] as any[],
    async listIntake() { this.listIntakeCalls++; return this._items; },
    async updateIntake(u: any) {
      updates.push(u);
      if (u.state === 'CLAIMED') claimed.push(u.intakeId);
    },
    async purgeIntake(p: any) { purges.push(p); },
  };
}

function fakeFetch(bodies: Map<string, Buffer>) {
  return async (url: string) => {
    const bytes = bodies.get(url);
    if (!bytes) return { ok: false, status: 404, body: null } as unknown as Response;
    return { ok: true, status: 200, body: Readable.toWeb(Readable.from(bytes)) } as unknown as Response;
  };
}

function runCollectionJobFor(f: Awaited<ReturnType<typeof fixture>>): DrainIntakeDeps['runCollectionJob'] {
  return async (sourceId, selectedRelativePath) => {
    const job = f.worker.createJob(sourceId, selectedRelativePath);
    return f.worker.run(job.id);
  };
}

test('drain claims, downloads, runs the job, and reports HASHED with sha256', async () => {
  const f = await fixture();
  const bytes = Buffer.from('a phone photo, allegedly');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const control = fakeControl();
  control._items = [{
    intakeId: 'intake-1', storagePath: 'archive-intake/intake-1/photo.jpg', fileName: 'photo.jpg',
    contentType: 'image/jpeg', sizeBytes: bytes.length, downloadUrl: 'https://example.test/intake-1',
    createdAt: new Date('2026-09-01').toISOString(),
  }];

  await drainIntake({
    db: f.db, control: control as any, workerId: 'test-worker', source: f.source,
    runCollectionJob: runCollectionJobFor(f), fetchImpl: fakeFetch(new Map([['https://example.test/intake-1', bytes]])) as any,
  });

  assert.deepEqual(control.claimed, ['intake-1']);
  const downloadedPath = path.join(f.sourceRoot, 'intake-1', 'photo.jpg');
  assert.equal((await fs.readFile(downloadedPath)).toString(), bytes.toString());

  const hashedUpdate = control.updates.find((u: any) => u.state === 'HASHED');
  assert.ok(hashedUpdate, 'a HASHED update was sent');
  assert.equal(hashedUpdate.sha256, sha256);
  assert.equal(hashedUpdate.contentAssetId, sha256);
  assert.equal(control.updates.some((u: any) => u.state === 'FAILED'), false);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a size mismatch reports FAILED and leaves no scratch file behind', async () => {
  const f = await fixture();
  const bytes = Buffer.from('short');
  const control = fakeControl();
  control._items = [{
    intakeId: 'intake-2', storagePath: 'archive-intake/intake-2/clip.mp4', fileName: 'clip.mp4',
    contentType: 'video/mp4', sizeBytes: bytes.length + 100, downloadUrl: 'https://example.test/intake-2',
    createdAt: new Date('2026-09-01').toISOString(),
  }];

  await drainIntake({
    db: f.db, control: control as any, workerId: 'test-worker', source: f.source,
    runCollectionJob: runCollectionJobFor(f), fetchImpl: fakeFetch(new Map([['https://example.test/intake-2', bytes]])) as any,
  });

  const failedUpdate = control.updates.find((u: any) => u.state === 'FAILED');
  assert.ok(failedUpdate, 'a FAILED update was sent');
  assert.match(failedUpdate.error, /does not match expected/);
  assert.equal(control.updates.some((u: any) => u.state === 'HASHED'), false);

  await assert.rejects(() => fs.access(path.join(f.sourceRoot, 'intake-2')), 'scratch directory was removed');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test(`drains at most ${MAX_INTAKE_PER_DRAIN} items per call, oldest first`, async () => {
  const f = await fixture();
  const control = fakeControl();
  const bodies = new Map<string, Buffer>();
  control._items = Array.from({ length: 7 }, (_, i) => {
    const bytes = Buffer.from(`item-${i}`);
    const url = `https://example.test/item-${i}`;
    bodies.set(url, bytes);
    return {
      intakeId: `intake-${i}`, storagePath: `archive-intake/intake-${i}/f.bin`, fileName: 'f.bin',
      contentType: 'image/jpeg', sizeBytes: bytes.length, downloadUrl: url,
      // Deliberately out of order so the sort-by-createdAt is exercised.
      createdAt: new Date(2026, 0, 7 - i).toISOString(),
    };
  });

  await drainIntake({
    db: f.db, control: control as any, workerId: 'test-worker', source: f.source,
    runCollectionJob: runCollectionJobFor(f), fetchImpl: fakeFetch(bodies) as any,
  });

  assert.equal(control.claimed.length, MAX_INTAKE_PER_DRAIN);
  // Oldest createdAt values are intake-6, intake-5, intake-4 (index 6 has Jan 1, etc).
  assert.deepEqual(control.claimed.sort(), ['intake-4', 'intake-5', 'intake-6']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('cloudIntakeRoot() is always under the OS temp dir, never under /Volumes', () => {
  const root = cloudIntakeRoot();
  assert.ok(root.startsWith(os.tmpdir()), `expected ${root} to be under ${os.tmpdir()}`);
  assert.ok(!root.startsWith('/Volumes'), 'cloud intake root must never be a NAS mount');
});

test('resolveIntakeIdFromRelativePath reads the first path segment', () => {
  assert.equal(resolveIntakeIdFromRelativePath('intake-abc/photo.jpg'), 'intake-abc');
  assert.equal(resolveIntakeIdFromRelativePath('intake-abc'), 'intake-abc');
});

test('archiveAndPurgeIntake marks ARCHIVED then purges and removes the scratch directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-intake-purge-'));
  const intakeId = 'intake-purge-1';
  await fs.mkdir(path.join(dir, intakeId), { recursive: true });
  await fs.writeFile(path.join(dir, intakeId, 'photo.jpg'), 'bytes');

  const control = fakeControl();
  await archiveAndPurgeIntake({ control: control as any, workerId: 'test-worker', intakeId, root: dir });

  assert.deepEqual(control.updates.map((u: any) => u.state), ['ARCHIVED']);
  assert.equal(control.purges.length, 1);
  assert.equal(control.purges[0].intakeId, intakeId);
  await assert.rejects(() => fs.access(path.join(dir, intakeId)), 'scratch directory removed after purge');

  await fs.rm(dir, { recursive: true, force: true });
});

test('archiveAndPurgeIntake leaves the scratch file in place when the purge call fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-intake-purge-fail-'));
  const intakeId = 'intake-purge-2';
  await fs.mkdir(path.join(dir, intakeId), { recursive: true });
  await fs.writeFile(path.join(dir, intakeId, 'photo.jpg'), 'bytes');

  const control = {
    async updateIntake() { throw new Error('HITLOOP unreachable'); },
    async purgeIntake() { throw new Error('should not be called'); },
  };
  await archiveAndPurgeIntake({ control: control as any, workerId: 'test-worker', intakeId, root: dir });

  await assert.doesNotReject(() => fs.access(path.join(dir, intakeId)), 'scratch directory retained after a failed purge');

  await fs.rm(dir, { recursive: true, force: true });
});
