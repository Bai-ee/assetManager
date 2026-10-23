import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupRecords, scanFolder, ensureLocalSource, fingerprintFile } from './media';
import type { MediaFile } from './types';

const BASE = Date.parse('2026-08-19T18:00:00Z');
function mk(name: string, kind: 'image' | 'video', offsetSec: number, extra: Partial<MediaFile> = {}): MediaFile {
  const iso = new Date(BASE + offsetSec * 1000).toISOString();
  return {
    path: `/x/${name}`, name, kind, size: 1,
    fingerprint: name.replace(/\W/g, '').padEnd(64, '0'),
    capturedAt: iso, mtime: iso, seq: null, duplicateOf: null, ...extra,
  };
}

test('A/B photos within 90s form one group', () => {
  const g = groupRecords([mk('a.HEIC', 'image', 0), mk('b.HEIC', 'image', 40)]);
  assert.equal(g.length, 1);
  assert.equal(g[0].images.length, 2);
});

test('photos >90s apart are separate records', () => {
  assert.equal(groupRecords([mk('a.HEIC', 'image', 0), mk('b.HEIC', 'image', 200)]).length, 2);
});

test('a video between two photos splits them and belongs to the LATER photo (film first, then label)', () => {
  const g = groupRecords([mk('a.HEIC', 'image', 0), mk('v.MOV', 'video', 20), mk('b.HEIC', 'image', 60)]);
  assert.equal(g.length, 2);
  assert.equal(g[0].videos.length, 0);
  assert.equal(g[1].videos[0].name, 'v.MOV');
});

test('video-then-label chain: each label gets the video shot just before it, never the next record\'s', () => {
  // real cadence from the 2026-09-28 session: video, +2 min label, +2 min next video, +2 min next label …
  const g = groupRecords([
    mk('v1.MOV', 'video', 0), mk('l1.HEIC', 'image', 120),
    mk('v2.MOV', 'video', 240), mk('l2.HEIC', 'image', 360),
    mk('v3.MOV', 'video', 480), mk('l3.HEIC', 'image', 600),
  ]);
  assert.deepEqual(g.map((x) => [x.images[0]?.name, x.videos.map((v) => v.name)]), [
    ['l1.HEIC', ['v1.MOV']], ['l2.HEIC', ['v2.MOV']], ['l3.HEIC', ['v3.MOV']],
  ]);
});

test('video with no later photo falls back to the nearest earlier photo within 10 min', () => {
  const g = groupRecords([mk('a.HEIC', 'image', 0), mk('v.MOV', 'video', 120)]);
  assert.equal(g.length, 1);
  assert.equal(g[0].videos[0].name, 'v.MOV');
});

test('orphan video becomes single group', () => {
  const g = groupRecords([mk('a.HEIC', 'image', 0), mk('v.MOV', 'video', 3600)]);
  assert.equal(g.length, 2);
  const orphan = g.find((x) => x.images.length === 0)!;
  assert.equal(orphan.groupedBy, 'single');
  assert.match(orphan.id, /^g-/);
});

test('duplicates are excluded', () => {
  const v = mk('v.MOV', 'video', 10);
  const dup = mk('v 2.MOV', 'video', 10, { duplicateOf: v.path });
  const g = groupRecords([mk('a.HEIC', 'image', 0), v, dup]);
  assert.equal(g.length, 1);
  assert.equal(g[0].videos.length, 1);
});

test('group id uses first image fingerprint', () => {
  const a = mk('a.HEIC', 'image', 0);
  assert.equal(groupRecords([a])[0].id, 'g-' + a.fingerprint.slice(0, 12));
});

test('scanFolder index: unchanged files are served from index.json, changed files are re-read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const indexPath = join(tmpdir(), `idx-${Date.now()}.json`);
  const f = join(dir, 'IMG_0001.jpg');
  writeFileSync(f, 'first contents');
  const a = await scanFolder(dir, { indexPath });
  const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(idx[f].fingerprint, a[0].fingerprint);
  // tamper with the cached capture time: an unchanged file must return it without re-reading
  idx[f].capturedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(indexPath, JSON.stringify(idx));
  assert.equal((await scanFolder(dir, { indexPath }))[0].capturedAt, '2020-01-01T00:00:00.000Z');
  // a changed file (size/mtime) is fingerprinted again
  writeFileSync(f, 'second, longer contents');
  utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const c = await scanFolder(dir, { indexPath });
  assert.notEqual(c[0].fingerprint, a[0].fingerprint);
  assert.notEqual(c[0].capturedAt, '2020-01-01T00:00:00.000Z');
});

test('ensureLocalSource copies once, reuses the cache, and hard-links a matching legacy copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  const nas = join(dir, 'nas.mov');
  writeFileSync(nas, Buffer.alloc(300_000, 7));
  const size = statSync(nas).size;
  const fingerprint = await fingerprintFile(nas, size);
  const file = { path: nas, name: 'nas.mov', size, fingerprint };
  const first = await ensureLocalSource(file, join(dir, 'cache'));
  assert.equal(first.via, 'copy');
  assert.equal(statSync(first.path).size, size);
  assert.equal((await ensureLocalSource(file, join(dir, 'cache'))).via, 'cache');
  const linked = await ensureLocalSource(file, join(dir, 'cache2'), { legacyPaths: [first.path] });
  assert.equal(linked.via, 'link');
  // a legacy file with the right size but different content is not trusted
  const bad = join(dir, 'bad.mov');
  writeFileSync(bad, Buffer.alloc(300_000, 9));
  assert.equal((await ensureLocalSource(file, join(dir, 'cache3'), { legacyPaths: [bad] })).via, 'copy');
});
