import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hitloop-archive-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const sourceRoot = path.join(dir, 'nas');
  await fs.mkdir(sourceRoot);
  const db = new ArchiveDatabase(dbPath);
  return { dir, dbPath, sourceRoot, db, worker: new ArchiveWorker(db, { stableFileDwellMs: 0, heartbeatEveryFiles: 1 }) };
}

test('deduplicates identical bytes while preserving both locations', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'a.txt'), 'same bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'b.txt'), 'same bytes');
  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id);
  const done = await f.worker.run(job.id);
  assert.equal(done.counters.hashed, 2);
  assert.equal(done.counters.duplicates, 1);
  const row = f.db.db.prepare('SELECT COUNT(*) count FROM content_assets').get() as {count:number};
  const locations = f.db.db.prepare('SELECT COUNT(*) count FROM file_locations').get() as {count:number};
  assert.equal(row.count, 1);
  assert.equal(locations.count, 2);
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('incremental rescan skips unchanged files', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'a.txt'), 'hello');
  const source = await f.worker.registerSource('test', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id).id);
  const second = await f.worker.run(f.worker.createJob(source.id).id);
  assert.equal(second.counters.hashed, 0);
  assert.equal(second.counters.discovered, 0);
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('changed file is rehashed and becomes a new content asset', async () => {
  const f = await fixture();
  const file = path.join(f.sourceRoot, 'a.txt');
  await fs.writeFile(file, 'v1');
  const source = await f.worker.registerSource('test', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id).id);
  await new Promise(r => setTimeout(r, 10));
  await fs.writeFile(file, 'version two');
  await f.worker.run(f.worker.createJob(source.id).id);
  const row = f.db.db.prepare('SELECT COUNT(*) count FROM content_assets').get() as {count:number};
  assert.equal(row.count, 2);
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('interrupted running job recovers as paused on database reopen', async () => {
  const f = await fixture();
  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id);
  f.db.setJobState(job.id, 'RUNNING');
  f.db.close();
  const reopened = new ArchiveDatabase(f.dbPath);
  assert.equal(reopened.getJob(job.id)?.state, 'PAUSED');
  reopened.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('rejects selected folder escaping registered source', async () => {
  const f = await fixture();
  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '../outside');
  await assert.rejects(() => f.worker.run(job.id), /escapes source root/);
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});


test('emits heartbeats while processing a collection', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'a.txt'), 'hello');
  const beats: string[] = [];
  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0, heartbeatEveryFiles: 1, onHeartbeat: h => beats.push(h.jobId) });
  const source = await worker.registerSource('test', f.sourceRoot);
  const job = worker.createJob(source.id);
  await worker.run(job.id);
  assert.ok(beats.length >= 1);
  assert.ok(beats.every(id => id === job.id));
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('unstable files are retryable instead of archived', async () => {
  const f = await fixture();
  const file = path.join(f.sourceRoot, 'moving.txt');
  await fs.writeFile(file, 'one');
  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 50 });
  const source = await worker.registerSource('test', f.sourceRoot);
  const job = worker.createJob(source.id);
  setTimeout(() => { void fs.appendFile(file, ' changed'); }, 10);
  const done = await worker.run(job.id);
  assert.equal(done.counters.failed, 1);
  const row = f.db.db.prepare("SELECT state FROM file_locations WHERE relative_path='moving.txt'").get() as {state:string};
  assert.equal(row.state, 'RETRYABLE_FAILED');
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});


test('rejects sibling path with matching source prefix', async () => {
  const f = await fixture();
  const sibling = path.join(f.dir, 'nas-escape');
  await fs.mkdir(sibling, { recursive: true });
  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('NAS', f.sourceRoot);
  const job = worker.createJob(source.id, '../nas-escape');
  await assert.rejects(() => worker.run(job.id), /escapes source root/);
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('skips macOS resource forks and .DS_Store at discovery', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'real content');
  await fs.writeFile(path.join(f.sourceRoot, '._clip.mp4'), 'apple double');
  await fs.writeFile(path.join(f.sourceRoot, '.DS_Store'), 'finder metadata');
  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id);
  const done = await f.worker.run(job.id);
  assert.equal(done.counters.discovered, 1);
  assert.equal(done.counters.hashed, 1);
  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{relative_path:string}>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), ['clip.mp4']);
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

test('discovery never re-walks the organizer\'s own HITLOOP-ARCHIVE output tree', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'real content');
  await fs.mkdir(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE', 'root', 'was-there'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE', 'root', 'was-there', 'already-organized.mp4'), 'organized content');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.');
  const done = await f.worker.run(job.id);
  assert.equal(done.counters.hashed, 1); // only clip.mp4; HITLOOP-ARCHIVE/ is not descended into
  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), ['clip.mp4']);
  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a job whose own root is inside HITLOOP-ARCHIVE (a correction re-file) still discovers it', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE', 'root', 'was-there'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE', 'root', 'was-there', 'clip.mp4'), 'organized content');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, path.join('HITLOOP-ARCHIVE', 'root'));
  const done = await f.worker.run(job.id);
  assert.equal(done.counters.hashed, 1);
  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION: a folder item and a file item are both discovered and hashed', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'a.txt'), 'folder-a-bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'loose.txt'), 'loose-bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'not-selected.txt'), 'excluded-bytes');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.', {
    selection: [
      { relativePath: 'folderA', kind: 'folder' },
      { relativePath: 'loose.txt', kind: 'file' },
    ],
    collectionId: 'my-selection',
  });
  const done = await f.worker.run(job.id);
  assert.equal(done.state, 'COMPLETE');
  assert.equal(done.counters.hashed, 2);

  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), [path.join('folderA', 'a.txt'), 'loose.txt']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION: a file item that also sits inside a selected folder is only hashed once', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'a.txt'), 'folder-a-bytes');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.', {
    selection: [
      { relativePath: 'folderA', kind: 'folder' },
      { relativePath: path.join('folderA', 'a.txt'), kind: 'file' }, // overlap
    ],
    collectionId: 'overlap-selection',
  });
  const done = await f.worker.run(job.id);
  assert.equal(done.state, 'COMPLETE');
  assert.equal(done.counters.hashed, 1);
  assert.equal(done.counters.discovered, 1);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION: a selected folder still skips macOS artifacts via the reused walk() rules', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'clip.mp4'), 'real content');
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', '._clip.mp4'), 'apple double');
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', '.DS_Store'), 'finder metadata');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.', {
    selection: [{ relativePath: 'folderA', kind: 'folder' }],
    collectionId: 'artifact-selection',
  });
  const done = await f.worker.run(job.id);
  assert.equal(done.counters.hashed, 1);
  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), [path.join('folderA', 'clip.mp4')]);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION: a selection item escaping the source root is rejected', async () => {
  const f = await fixture();
  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.', {
    selection: [{ relativePath: '../outside', kind: 'folder' }],
    collectionId: 'escape-selection',
  });
  await assert.rejects(() => f.worker.run(job.id), /escapes source root/);
  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('unreadable or vanished selected root pauses instead of completing', async () => {
  const f = await fixture();
  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('NAS', f.sourceRoot);
  const job = worker.createJob(source.id, '.');
  await fs.rm(f.sourceRoot, { recursive: true, force: true });
  const result = await worker.run(job.id);
  assert.equal(result.state, 'PAUSED');
  f.db.close();
  await fs.rm(f.dir, {recursive:true,force:true});
});

// ── CANCEL_JOB (media-only + cancel workstream) ─────────────────────────

test('cancel() mid-walk stops within a few files, marks the job CANCELLED, keeps hashed rows, and the job is not resumable', async () => {
  const f = await fixture();
  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0, heartbeatEveryFiles: 1 });
  for (let i = 0; i < 200; i++) {
    await fs.writeFile(path.join(f.sourceRoot, `file-${String(i).padStart(3, '0')}.txt`), `bytes-${i}`);
  }
  const source = await worker.registerSource('test', f.sourceRoot);
  const job = worker.createJob(source.id, '.');

  let filesSeenBeforeCancel = 0;
  const cancelAfter = 5;
  const workerWithHook = new ArchiveWorker(f.db, {
    stableFileDwellMs: 0, heartbeatEveryFiles: 1,
    onHeartbeat: () => {
      filesSeenBeforeCancel += 1;
      if (filesSeenBeforeCancel === cancelAfter) workerWithHook.cancel(job.id);
    },
  });

  const done = await workerWithHook.run(job.id);
  assert.equal(done.state, 'CANCELLED');
  // Stops "within a few files": far fewer than the full 200-file fixture.
  assert.ok(done.counters.hashed > 0 && done.counters.hashed < 20, `expected a small hashed count, got ${done.counters.hashed}`);

  const hashedRows = f.db.db.prepare("SELECT COUNT(*) count FROM file_locations WHERE state IN ('HASHED','DUPLICATE')").get() as { count: number };
  assert.equal(hashedRows.count, done.counters.hashed, 'every hashed-before-cancel location is kept');

  assert.deepEqual(f.db.listResumableJobs().map(j => j.id), [], 'a CANCELLED job must never be resumable');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('cancel() marks an in-flight HASHING location RETRYABLE_FAILED with error "cancelled" when the flag lands mid-file, before the hash', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  // Heartbeat call #1 is the pre-loop heartbeat (before any file is
  // touched); call #2 is the per-file heartbeat for clip.mp4 itself, fired
  // AFTER this iteration's top-of-loop cancel check has already passed but
  // BEFORE clip.mp4's own location is marked HASHING. Cancelling exactly
  // there lands the flag at the "post-HASHING, pre-hash" check point in
  // run() rather than the top-of-loop one, so the in-flight location this
  // test asserts on actually exists.
  let heartbeatCalls = 0;
  let job: ReturnType<ArchiveWorker['createJob']>;
  const worker = new ArchiveWorker(f.db, {
    stableFileDwellMs: 0, heartbeatEveryFiles: 1,
    onHeartbeat: () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 2) worker.cancel(job.id);
    },
  });
  const source = await worker.registerSource('test', f.sourceRoot);
  job = worker.createJob(source.id, '.');

  const done = await worker.run(job.id);
  assert.equal(done.state, 'CANCELLED');

  const row = f.db.db.prepare("SELECT state, error FROM file_locations WHERE relative_path='clip.mp4'").get() as { state: string; error: string | null } | undefined;
  assert.ok(row, 'the in-flight location must still be recorded');
  assert.equal(row!.state, 'RETRYABLE_FAILED');
  assert.equal(row!.error, 'cancelled');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('cancel() on an unknown job throws', async () => {
  const f = await fixture();
  assert.throws(() => f.worker.cancel('nope'), /Unknown job/);
  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

// ── Media-only hashing ───────────────────────────────────────────────────

test('mediaOnly job skips audio/project/text files and hashes video/image files, without counting skips as discovered or failed', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'photo.jpg'), 'image bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'track.wav'), 'audio bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'project.als'), 'ableton project bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'notes.txt'), 'text bytes');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.', { mediaOnly: true });
  const done = await f.worker.run(job.id);

  assert.equal(done.state, 'COMPLETE');
  assert.equal(done.counters.hashed, 2);
  assert.equal(done.counters.discovered, 2);
  assert.equal(done.counters.failed, 0);
  assert.equal(done.skippedNonMedia, 3);

  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), ['clip.mp4', 'photo.jpg']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a non-mediaOnly job hashes everything, unchanged from prior behavior', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'track.wav'), 'audio bytes');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.');
  const done = await f.worker.run(job.id);

  assert.equal(done.counters.hashed, 2);
  assert.equal(done.skippedNonMedia, undefined);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION mediaOnly job applies the same filter inside a selected folder', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'track.wav'), 'audio bytes');

  const source = await f.worker.registerSource('test', f.sourceRoot);
  const job = f.worker.createJob(source.id, '.', {
    selection: [{ relativePath: 'folderA', kind: 'folder' }],
    collectionId: 'media-only-selection',
    mediaOnly: true,
  });
  const done = await f.worker.run(job.id);
  assert.equal(done.counters.hashed, 1);
  assert.equal(done.skippedNonMedia, 1);
  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), [path.join('folderA', 'clip.mp4')]);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('resuming a PAUSED mediaOnly job keeps honoring mediaOnly', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'track.wav'), 'audio bytes');

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  const job = worker.createJob(source.id, '.', { mediaOnly: true });
  // Simulate an interrupted run (same mechanism the "interrupted running job"
  // test above uses): force RUNNING, then reopen the database, which
  // recoverInterruptedJobs() converts to PAUSED.
  f.db.setJobState(job.id, 'PAUSED');

  const resumed = await worker.resume(job.id);
  assert.equal(resumed.state, 'COMPLETE');
  assert.equal(resumed.counters.hashed, 1);
  assert.equal(resumed.skippedNonMedia, 1);
  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), ['clip.mp4']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});
