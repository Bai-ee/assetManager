import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { readFolder } from './folder-reader';
import { Manifest } from './manifest';
import { buildPlan } from './plan';
import { applyPlan } from './apply';
import { parseArgs, deriveFolderSourceId, assertFolder } from './cli';
import { canonicalPathFor, normalizeExt } from './layout';
import { resolveTakenDate } from './dates';
import { tmpDir } from './test-fixtures';
import type { ExifInfo } from './types';

process.env.PHOTOLIB_HOME = tmpDir();

const base: ExifInfo = { dateTimeOriginal: null, offsetTimeOriginal: null, gpsDateTimeUtc: null, quicktimeCreationDate: null, quicktimeCreateDateUtc: null, lat: null, lon: null, contentIdentifier: null, make: null, model: null, width: null, height: null, durationSec: null };
const body = (tag: string) => `${tag}:`.padEnd(12 * 1024, 'x');

/** Fake EXIF keyed by file content tag ("<tag>:..."): dates come from the table, "none" = undated. */
function build(files: Record<string, { tag: string; exif?: Partial<ExifInfo> | null }>) {
  const root = tmpDir();
  const exifByTag = new Map<string, ExifInfo | null>();
  for (const [rel, f] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body(f.tag));
    exifByTag.set(f.tag, f.exif === null ? null : { ...base, ...(f.exif ?? {}) });
  }
  const readExifBatch = async (paths: string[]) => new Map(paths.map(p => [p, exifByTag.get(fs.readFileSync(p, 'utf8').split(':')[0]) ?? null]));
  return { root, readExifBatch };
}
const D = (d: string) => ({ dateTimeOriginal: d, offsetTimeOriginal: '+00:00' });

test('folder: skips undated, tiny, bundles, hidden, AppleDouble, symlinks; reads nothing it should not', async () => {
  const { root, readExifBatch } = build({
    'a/ok.JPG': { tag: 'ok', exif: D('2019:05:01 10:00:00') },
    'a/undated.jpg': { tag: 'nodate' },
    'a/notes.txt': { tag: 'txt', exif: D('2019:05:01 10:00:00') },
    'Lib.photoslibrary/Masters/x.jpg': { tag: 'lib', exif: D('2019:05:01 10:00:00') },
    'Old.sparsebundle/x.jpg': { tag: 'sp', exif: D('2019:05:01 10:00:00') },
    'Old.backupbundle/x.jpg': { tag: 'bb', exif: D('2019:05:01 10:00:00') },
    'HITLOOP-ARCHIVE/timeline/x.jpg': { tag: 'arc', exif: D('2019:05:01 10:00:00') },
    '.hidden/x.jpg': { tag: 'hid', exif: D('2019:05:01 10:00:00') },
    'a/._ok.JPG': { tag: 'ad', exif: D('2019:05:01 10:00:00') },
    '$RECYCLE.BIN/x.jpg': { tag: 'rb', exif: D('2019:05:01 10:00:00') },
  });
  fs.writeFileSync(path.join(root, 'a/tiny.jpg'), 'tiny');
  fs.symlinkSync(path.join(root, 'a/ok.JPG'), path.join(root, 'a/link.jpg'));
  const r = await readFolder(root, { sourceId: 'folder-t', readExifBatch, resolveTakenDate });
  assert.equal(r.kind, 'folder');
  assert.deepEqual(r.items.map(i => i.relativePath), ['a/ok.JPG']);
  assert.equal(r.skippedNoDate, 1);
  const it = r.items[0];
  assert.equal(it.imageDateUtc, null);
  assert.equal(it.versionUuid, null);
  assert.deepEqual(it.albums, []);
  assert.ok(r.warnings.some(w => /no capture-date/.test(w.reason) && /a\/undated\.jpg/.test(w.reason)));
});

test('folder: cameraOnly keeps phone/camera captures, drops Mac/none before hashing, not counted as undated', async () => {
  const { root, readExifBatch } = build({
    'a/phone.jpg': { tag: 'ph', exif: { ...D('2020:01:02 03:04:05'), model: 'iPhone XR' } },
    'a/canon.jpg': { tag: 'cn', exif: { ...D('2015:01:02 03:04:05'), model: 'Canon PowerShot S110' } },
    'a/screen.mov': { tag: 'sr', exif: { ...D('2026:01:02 03:04:05'), model: 'Mac16,5' } },
    'a/export.mp4': { tag: 'ex', exif: D('2021:01:02 03:04:05') },
    'a/old.mov': { tag: 'mb', exif: { ...D('2019:01:02 03:04:05'), model: 'MacBookPro11,4' } },
    'a/undated.jpg': { tag: 'nd' },
  });
  const r = await readFolder(root, { sourceId: 'folder-t', readExifBatch, resolveTakenDate, cameraOnly: true });
  assert.deepEqual(r.items.map(i => i.relativePath), ['a/canon.jpg', 'a/phone.jpg']);
  assert.equal(r.skippedNoDate, 1);
  assert.ok(r.warnings.some(w => /3 dated file\(s\) skipped: camera-only/.test(w.reason)));
  const all = await readFolder(root, { sourceId: 'folder-t', readExifBatch, resolveTakenDate, cameraOnly: false });
  assert.equal(all.items.length, 5);
});

test('folder: live pair becomes motion child; unrelated video stays its own item', async () => {
  const { root, readExifBatch } = build({
    'pics/IMG_1.HEIC': { tag: 'img', exif: { ...D('2020:01:02 03:04:05'), contentIdentifier: 'CID-1' } },
    'pics/img_1.mov': { tag: 'mov', exif: { contentIdentifier: 'CID-1', durationSec: 1.5 } },
    'pics/IMG_2.HEIC': { tag: 'img2', exif: { ...D('2020:01:03 03:04:05'), contentIdentifier: 'CID-2' } },
    'pics/IMG_2.mov': { tag: 'mov2', exif: { ...D('2020:01:03 03:04:05'), contentIdentifier: 'OTHER' } }, // id mismatch
    'other/IMG_1.mov': { tag: 'mov3', exif: { ...D('2020:02:03 03:04:05'), contentIdentifier: 'CID-1' } }, // different dir
  });
  const r = await readFolder(root, { sourceId: 'folder-t', readExifBatch, resolveTakenDate });
  const rels = r.items.map(i => i.relativePath);
  assert.deepEqual(rels, ['other/IMG_1.mov', 'pics/IMG_1.HEIC', 'pics/IMG_2.HEIC', 'pics/IMG_2.mov']);
  const live = r.items.find(i => i.relativePath === 'pics/IMG_1.HEIC')!;
  assert.equal(live.motion?.relativePath, 'pics/img_1.mov');
  assert.equal(r.items.find(i => i.relativePath === 'pics/IMG_2.HEIC')!.motion, null);
  assert.equal(r.skippedNoDate, 0);
});

test('folder: plan + apply dedupes same bytes across subfolders, motion child planned, totals carry skippedNoDate', async () => {
  const destRoot = tmpDir();
  const folder = path.join(destRoot, 'Dec Backup');
  const exifByTag = new Map<string, ExifInfo>([
    ['dup', { ...base, ...D('2018:06:21 10:20:30'), make: 'Apple', model: 'iPhone' }],
    ['live', { ...base, ...D('2018:07:01 00:00:00'), contentIdentifier: 'C' }],
    ['liveMov', { ...base, contentIdentifier: 'C', durationSec: 2 }],
    ['none', { ...base }],
  ]);
  const w = (rel: string, tag: string) => { const p = path.join(folder, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body(tag)); };
  w('one/a.jpg', 'dup'); w('two/b.jpg', 'dup'); w('three/L.heic', 'live'); w('three/L.mov', 'liveMov'); w('three/u.jpg', 'none');
  const readExifBatch = async (paths: string[]) => new Map(paths.map(p => [p, exifByTag.get(fs.readFileSync(p, 'utf8').split(':')[0]) ?? null]));
  const m = new Manifest(path.join(tmpDir(), 'm.sqlite'));
  const plan = await buildPlan({
    libraryPath: folder, destRoot, sourceId: 'folder-dec-backup', manifest: m,
    deps: { readLibrary: (root, o) => readFolder(root, { sourceId: o.sourceId, readExifBatch, resolveTakenDate }), readExifBatch, resolveTakenDate, canonicalPathFor, normalizeExt },
  });
  assert.equal(plan.libraryKind, 'folder');
  assert.equal(plan.libraryPath, 'Dec Backup');
  assert.deepEqual(plan.items.map(i => i.action), ['copy', 'copy', 'duplicate']); // one/a, three/L, two/b (walk order)
  assert.equal(plan.items[0].camera?.make, 'Apple');
  assert.equal(plan.items[1].children[0].role, 'motion');
  assert.equal(plan.items[1].children[0].durationSec, 2);
  assert.equal(plan.totals.skippedNoDate, 1);
  assert.equal(plan.totals.duplicate, 1);
  const before = fs.readdirSync(folder).length;
  const res = await applyPlan(plan, { manifest: m });
  assert.equal(res.errors.length, 0);
  assert.equal(res.copied, 2);
  assert.equal(fs.readdirSync(folder).length, before, 'folder untouched');
  m.close();
});

test('cli: --folder parsing, source id, guards', () => {
  assert.equal(parseArgs(['plan', '--folder', '/Volumes/bryan/Dec10th MAc Backup']).folder, '/Volumes/bryan/Dec10th MAc Backup');
  assert.throws(() => parseArgs(['plan', '--folder', '/a', '--library', '/b/x.photoslibrary']), /mutually exclusive/);
  assert.equal(deriveFolderSourceId('/Volumes/bryan/Dec10th MAc Backup', '/Volumes/bryan'), 'folder-dec10th-mac-backup');
  assert.equal(deriveFolderSourceId('/Volumes/bryan/Old Stuff/2012 Pics/', '/Volumes/bryan'), 'folder-old-stuff-2012-pics');
  assert.throws(() => deriveFolderSourceId('/elsewhere/x', '/Volumes/bryan'), /inside --dest-root/);
  assert.throws(() => assertFolder('rel/dir'), /absolute/);
  assert.throws(() => assertFolder('/x/Photos.photoslibrary'), /--library/);
});
