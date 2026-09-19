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
