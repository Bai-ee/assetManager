import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { readLibrary, appleEpochToIso } from './rk-reader';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-test-'));
const write = (p: string, body = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(`${p}|${fs.statSync(p).size}|${fs.statSync(p).mtimeMs}`);
    }
  };
  rec(dir);
  return out.sort();
}

function makePhotos(): string {
  const lib = path.join(tmpRoot, 'A.photoslibrary');
  fs.mkdirSync(path.join(lib, 'database'), { recursive: true });
  const db = new Database(path.join(lib, 'database', 'photos.db'));
  db.exec(`
    create table RKMaster (modelId integer primary key, uuid text, imagePath text, fileSize integer, width integer, height integer, UTI text,
      imageDate real, imageTimeZoneOffsetSeconds integer, duration real, mediaGroupId text, originalFileName text, isInTrash integer);
    create table RKVersion (modelId integer primary key, uuid text, masterUuid text, versionNumber integer, name text, isFavorite integer, isHidden integer,
      extendedDescription text, imageTimeZoneName text, latitude real, longitude real, exifLatitude real, exifLongitude real, naturalDuration real, masterWidth integer, masterHeight integer);
    create table RKModelResource (modelId integer primary key, attachedModelId integer, attachedModelType integer, resourceType integer);
    create table RKAlbum (modelId integer primary key, name text, isInTrash integer, isMagic integer);
    create table RKAlbumVersion (modelId integer primary key, versionId integer, albumId integer);
    create table RKKeyword (modelId integer primary key, name text);
    create table RKKeywordForVersion (versionId integer, keywordId integer);
  `);
  const M = db.prepare('insert into RKMaster values (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const V = db.prepare('insert into RKVersion values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  // 1: normal image, offset from master, gps, album, keyword, favorite, title, edited child
  M.run(1, 'm1', '2018/10/24/a/IMG_1.JPG', 100, 4000, 3000, 'public.jpeg', 561000000, 3600, null, null, 'IMG_1.JPG', 0);
  V.run(10, 'v1', 'm1', 0, 'Sunset', 1, 0, 'a desc', 'GMT-0500', 37.5, -122.5, null, null, null, null, null);
  // 2: live photo, tz only from name (IANA), gps 0/0 -> null, title equals filename -> null
  M.run(2, 'm2', '2018/10/24/a/IMG_2.HEIC', 200, 10, 20, 'public.heic', 561000000, null, null, 'grp', 'IMG_2.HEIC', 0);
  V.run(20, 'v2', 'm2', 0, 'IMG_2', 0, 1, '', 'America/New_York', 0, 0, null, null, null, null, null);
  // 3: trashed
  M.run(3, 'm3', '2018/10/24/a/IMG_3.JPG', 1, 1, 1, 'public.jpeg', 1, 0, null, null, 'IMG_3.JPG', 1);
  V.run(30, 'v3', 'm3', 0, null, 0, 0, null, null, null, null, null, null, null, null, null);
  // 4: missing file
  M.run(4, 'm4', '2018/10/24/a/IMG_4.JPG', 1, 1, 1, 'public.jpeg', 1, 0, null, null, 'IMG_4.JPG', 0);
  V.run(40, 'v4', 'm4', 0, null, 0, 0, null, null, null, null, null, null, null, null, null);
  // 5: video, master dims missing -> version dims, out-of-range gps, two versions (first by versionNumber wins)
  M.run(5, 'm5', '2019/01/01/b/MOV_5.MOV', 300, null, null, 'com.apple.quicktime-movie', 600000000, 0, 12.5, null, 'MOV_5.MOV', 0);
  V.run(50, 'v5b', 'm5', 1, 'edited-version', 0, 0, null, null, null, null, null, null, null, null, null);
  V.run(51, 'v5a', 'm5', 0, null, 0, 0, null, null, 95, 200, null, null, null, 1920, 1080);
  // 6: live photo whose motion file is missing
  M.run(6, 'm6', '2019/01/01/b/IMG_6.HEIC', 5, 5, 5, 'public.heic', 600000000, 0, null, null, 'IMG_6.HEIC', 0);
  V.run(60, 'v6', 'm6', 0, null, 0, 0, null, null, null, null, null, null, null, null, null);
  // albums / keywords
  db.prepare('insert into RKAlbum values (?,?,?,?)').run(1, 'Trip', 0, 0);
  db.prepare('insert into RKAlbum values (?,?,?,?)').run(2, 'Magic', 0, 1);
  db.prepare('insert into RKAlbum values (?,?,?,?)').run(3, 'Gone', 1, 0);
  db.prepare('insert into RKAlbum values (?,?,?,?)').run(4, '', 0, 0);
  for (const [i, a] of [[1, 1], [2, 1], [3, 2], [4, 3], [5, 4]]) db.prepare('insert into RKAlbumVersion values (?,10,?)').run(i, a);
  db.prepare('insert into RKKeyword values (1,?)').run('beach');
  db.prepare('insert into RKKeywordForVersion values (10,1)').run();
  // resources: motion for master 2 (res 0xa5), motion for master 6 (res 0xa6, file absent), edited for version 10 (res 0x26)
  const R = db.prepare('insert into RKModelResource values (?,?,?,?)');
  R.run(0xa5, 2, 1, 7);
  R.run(0xa6, 6, 1, 7);
  R.run(0x26, 10, 2, 4);
  R.run(0x27, 20, 2, 4); // edited resource for v2, file absent
  db.close();
  write(path.join(lib, 'Masters/2018/10/24/a/IMG_1.JPG'), 'a'.repeat(100));
  write(path.join(lib, 'Masters/2018/10/24/a/IMG_2.HEIC'), 'b'.repeat(200));
  write(path.join(lib, 'Masters/2018/10/24/a/IMG_3.JPG'));
  write(path.join(lib, 'Masters/2019/01/01/b/MOV_5.MOV'), 'c'.repeat(300));
  write(path.join(lib, 'Masters/2019/01/01/b/IMG_6.HEIC'));
  write(path.join(lib, 'resources/media/master/00/00/jpegvideocomplement_a5.mov'), 'm'.repeat(7));
  write(path.join(lib, 'resources/media/version/00/00/fullsizeoutput_26.jpeg'), 'e'.repeat(9));
  return lib;
}

function makeIphoto(): string {
  const lib = path.join(tmpRoot, 'B');
  fs.mkdirSync(path.join(lib, 'Database', 'apdb'), { recursive: true });
  const db = new Database(path.join(lib, 'Database', 'apdb', 'Library.apdb'));
  db.exec(`
    create table RKMaster (modelId integer primary key, uuid text, imagePath text, fileSize integer, width integer, height integer, type text,
      imageDate real, originalFileName text, isInTrash integer);
    create table RKVersion (modelId integer primary key, uuid text, masterUuid text, versionNumber integer, name text, mainRating integer, isHidden integer,
      imageTimeZoneName text, exifLatitude real, exifLongitude real);
    create table RKAlbum (modelId integer primary key, name text, isInTrash integer);
    create table RKAlbumVersion (modelId integer primary key, versionId integer, albumId integer);
  `);
  db.prepare('insert into RKMaster values (1,?,?,?,?,?,?,?,?,0)').run('im1', '2010/01/01/x/P.JPG', 10, 640, 480, 'IMGT', 300000000, 'P.JPG');
  db.prepare('insert into RKVersion values (10,?,?,0,?,?,0,?,?,?)').run('iv1', 'im1', 'Cat', 4, 'GMT+0100', 48.8, 2.3);
  db.prepare('insert into RKAlbum values (1,?,0)').run('Old');
  db.prepare('insert into RKAlbumVersion values (1,10,1)').run();
  db.close();
  write(path.join(lib, 'Masters/2010/01/01/x/P.JPG'), 'p'.repeat(10));
  return lib;
}

test('appleEpochToIso', () => {
  assert.equal(appleEpochToIso(0), '2001-01-01T00:00:00.000Z');
  assert.equal(appleEpochToIso(null), null);
  assert.equal(appleEpochToIso(NaN), null);
});

test('photos library', () => {
  const lib = makePhotos();
  const before = snapshot(lib);
  const r = readLibrary(lib, { sourceId: 's' });
  assert.deepEqual(snapshot(lib), before, 'bundle untouched, no new files');
  assert.equal(r.kind, 'photos');
  assert.deepEqual(r.items.map((i) => i.masterUuid), ['m1', 'm2', 'm5', 'm6']);
  const [a, b, c, d] = r.items;

  assert.equal(a.imageDateUtc, new Date((561000000 + 978307200) * 1000).toISOString());
  assert.equal(a.tzOffsetSec, 3600, 'master offset preferred over name');
  assert.equal(a.relativePath, 'Masters/2018/10/24/a/IMG_1.JPG');
  assert.equal(a.absPath, path.join(lib, 'Masters/2018/10/24/a/IMG_1.JPG'));
  assert.equal(a.sizeBytes, 100);
  assert.equal(a.kind, 'image');
  assert.deepEqual([a.lat, a.lon], [37.5, -122.5]);
  assert.deepEqual(a.albums, ['Trip']);
  assert.deepEqual(a.keywords, ['beach']);
  assert.equal(a.favorite, true);
  assert.equal(a.title, 'Sunset');
  assert.equal(a.description, 'a desc');
  assert.equal(a.versionUuid, 'v1');
  assert.equal(a.motion, null);
  assert.equal(a.edited?.relativePath, 'resources/media/version/00/00/fullsizeoutput_26.jpeg');
  assert.equal(a.edited?.sizeBytes, 9);

  assert.equal(b.tzOffsetSec, -4 * 3600, 'IANA name, EDT in Oct 2018');
  assert.deepEqual([b.lat, b.lon], [null, null], '0/0 -> null');
  assert.equal(b.title, null, 'title == filename stem');
  assert.equal(b.description, null);
  assert.equal(b.hidden, true);
  assert.equal(b.mediaGroupId, 'grp');
  assert.equal(b.motion?.relativePath, 'resources/media/master/00/00/jpegvideocomplement_a5.mov');
  assert.equal(b.motion?.sizeBytes, 7);
  assert.equal(b.edited, null);

  assert.equal(c.kind, 'video');
  assert.equal(c.versionUuid, 'v5a', 'first version by versionNumber');
  assert.equal(c.durationSec, 12.5);
  assert.equal(c.width, 1920);
  assert.equal(c.height, 1080);
  assert.deepEqual([c.lat, c.lon], [null, null], 'out of range -> null');

  assert.equal(d.motion, null);

  const reasons = r.warnings.map((w) => `${w.masterUuid}:${w.reason}`);
  assert.ok(reasons.some((x) => x.startsWith('m4:') && /missing on disk/.test(x)), 'missing master warning');
  assert.ok(reasons.some((x) => x.startsWith('m6:') && /motion file missing/.test(x)), 'missing motion warning');
  assert.ok(reasons.some((x) => x.startsWith('m2:') && /edited file missing/.test(x)), 'missing edited warning');
  assert.ok(!r.items.some((i) => i.masterUuid === 'm3'), 'trashed skipped');
});

test('iphoto library column fallbacks', () => {
  const lib = makeIphoto();
  const before = snapshot(lib);
  const r = readLibrary(lib, { sourceId: 'ip' });
  assert.deepEqual(snapshot(lib), before);
  assert.equal(r.kind, 'iphoto');
  assert.equal(r.items.length, 1);
  const i = r.items[0];
  assert.equal(i.relativePath, 'Masters/2010/01/01/x/P.JPG');
  assert.equal(i.uti, 'IMGT');
  assert.equal(i.favorite, true, 'mainRating > 0');
  assert.equal(i.tzOffsetSec, 3600);
  assert.deepEqual([i.lat, i.lon], [48.8, 2.3]);
  assert.equal(i.mediaGroupId, null);
  assert.equal(i.motion, null);
  assert.equal(i.edited, null);
  assert.equal(i.width, 640);
  assert.deepEqual(i.albums, ['Old']);
  assert.deepEqual(i.keywords, []);
  assert.equal(i.title, 'Cat');
});
