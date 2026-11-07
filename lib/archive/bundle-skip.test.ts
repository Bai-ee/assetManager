import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inferMediaType, isLibraryBundle } from './media-type';
import { walkMedia } from './analyzer/analyze';

test('isLibraryBundle: photo-library bundles only', () => {
  for (const n of ['Photos Library.photoslibrary', 'Old.PHOTOLIBRARY', 'x.migratedphotolibrary', 'iPhoto Library', 'Photo Booth Library']) assert.equal(isLibraryBundle(n), true, n);
  for (const n of ['photoslibrary', 'iPhoto Library copy', 'Photos', 'a.jpg', 'my.photoslibrary.bak']) assert.equal(isLibraryBundle(n), false, n);
});

test('media types: RAW stills are images, .aae stays other', () => {
  for (const e of ['cr2', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2']) assert.equal(inferMediaType(`x.${e}`), 'image');
  assert.equal(inferMediaType('IMG_1.aae'), 'other');
});

test('analyzer walkMedia skips library bundles and HITLOOP-ARCHIVE/timeline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-skip-'));
  const put = (rel: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
  put('keep/a.jpg'); put('Lib.photoslibrary/Masters/b.jpg'); put('keep/iPhoto Library/c.jpg'); put('HITLOOP-ARCHIVE/timeline/2018/06/d.jpg');
  assert.deepEqual(walkMedia(root, []).map(f => f.relativePath).sort(), ['keep/a.jpg']);
});

test('worker discovery walk skips library bundles', async () => {
  const { ArchiveDatabase } = await import('./database');
  const { ArchiveWorker } = await import('./worker');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-skip-w-'));
  const src = path.join(dir, 'nas');
  for (const rel of ['keep/a.txt', 'Lib.photoslibrary/Masters/b.txt', 'iPhoto Library/c.txt']) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), rel);
  }
  const db = new ArchiveDatabase(path.join(dir, 's.sqlite'));
  const worker = new ArchiveWorker(db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('t', src);
  const done = await worker.run(worker.createJob(source.id).id);
  assert.equal(done.counters.hashed, 1);
  db.close();
});
