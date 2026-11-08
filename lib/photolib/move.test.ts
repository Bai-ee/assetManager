import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from './manifest';
import { buildPlan } from './plan';
import { applyPlan, undoRun } from './apply';
import { captureMetadata, findXmpSidecars, nameKeys, normalizeExifDump, openLibraryRecordIndex, writeOnce } from './metadata';
import { makeFixture, sha, tmpDir, type Fixture } from './test-fixtures';
import type { Plan, Sidecar, SidecarMeta } from './types';
import type { MetaFile } from './metadata';

process.env.PHOTOLIB_HOME = tmpDir();
const open = () => new Manifest(path.join(tmpDir(), 'm.sqlite'));

/** Same fake files, but presented as a plain folder source inside the share (what bryan/iCloud-Photos is). */
function folderFixture(files: Parameters<typeof makeFixture>[0]): Fixture {
  const fx = makeFixture(files);
  const read = fx.deps.readLibrary;
  fx.deps = { ...fx.deps, readLibrary: async (p, o) => ({ ...(await read(p, o)), kind: 'folder' as const }) };
  return fx;
}
const plan = (fx: Fixture, m: Manifest): Promise<Plan> =>
  buildPlan({ libraryPath: fx.libAbs, destRoot: fx.root, sourceId: 'folder-icloud', manifest: m, deps: fx.deps });

/** Records every capture; returns fake share paths without writing (metadata.ts has its own tests). */
function recorder() {
  const calls: MetaFile[] = [];
  const captureMeta = async (f: MetaFile): Promise<SidecarMeta> => {
    assert.ok(fs.existsSync(f.absPath), `metadata captured while the source file still exists: ${f.absPath}`);
    calls.push(f);
    return { exif: `HITLOOP-ARCHIVE/timeline/_meta/${f.sha256}.exif.json`, xmp: [], library: [] };
  };
  return { calls, captureMeta };
}
const raw = (fx: Fixture, rel: string) => path.join(fx.libAbs, rel);
const sidecarOf = (fx: Fixture, c: string) => JSON.parse(fs.readFileSync(path.join(fx.root, `HITLOOP-ARCHIVE/timeline/_meta/${sha(c)}.json`), 'utf8')) as Sidecar;

test('move: captures metadata first, renames new files into the timeline, verifies, journals srcPath', async () => {
  const fx = folderFixture([
    { rel: '2014/03/a.JPG', content: 'AAA', motion: { rel: '2014/03/a.MOV', content: 'MOV' } },
    { rel: '2014/03/b.JPG', content: 'BBB' },
  ]);
  const m = open();
  const { calls, captureMeta } = recorder();
  const r = await applyPlan(await plan(fx, m), { manifest: m, mode: 'move', captureMeta });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.deepEqual({ copied: r.copied, moved: r.moved, children: r.children, rawDeleted: r.rawDeleted, metaCaptured: r.metaCaptured }, { copied: 2, moved: 3, children: 1, rawDeleted: 0, metaCaptured: 3 });
  assert.equal(calls.length, 3);
  for (const rel of ['2014/03/a.JPG', '2014/03/a.MOV', '2014/03/b.JPG']) assert.ok(!fs.existsSync(raw(fx, rel)), `${rel} moved out of the raw folder`);
  const row = m.getAsset(sha('AAA'))!;
  assert.equal(fs.readFileSync(path.join(fx.root, row.canonicalPath), 'utf8'), 'AAA');
  assert.equal(sidecarOf(fx, 'AAA').meta?.exif, `HITLOOP-ARCHIVE/timeline/_meta/${sha('AAA')}.exif.json`);
  assert.equal(sidecarOf(fx, 'AAA').meta?.children?.motion?.exif, `HITLOOP-ARCHIVE/timeline/_meta/${sha('MOV')}.exif.json`);
  const j = m.journalForRun(r.runId).filter(x => x.role === 'primary');
  assert.ok(j.every(x => x.srcPath?.startsWith(`${fx.libRel}/2014/03/`)), 'move rows carry the share-relative raw path');
  m.close();
});

test('move: raw duplicates are deleted only after both copies verify; undo restores everything', async () => {
  const fx = folderFixture([
    { rel: 'a.JPG', content: 'AAA' },
    { rel: 'copy-of-a.JPG', content: 'AAA' }, // same bytes in the same download → duplicate
    { rel: 'c.JPG', content: 'CCC' },
  ]);
  const m = open();
  // c is already on the timeline from an earlier source (copy-mode apply of the same bytes)
  const pre = folderFixture([{ rel: 'c.JPG', content: 'CCC' }]);
  const prePlan = await buildPlan({ libraryPath: pre.libAbs, destRoot: fx.root, sourceId: 'nas-older', manifest: m, deps: pre.deps });
  // pre's canonical path must match fx's: same date index (0) → give c the same date
  fx.items[2].imageDateUtc = pre.items[0].imageDateUtc;
  await applyPlan(prePlan, { manifest: m });
  const timelineC = path.join(fx.root, m.getAsset(sha('CCC'))!.canonicalPath);

  const { captureMeta } = recorder();
  const p = await plan(fx, m);
  assert.deepEqual(p.items.map(i => i.action), ['copy', 'duplicate', 'present']);
  const r = await applyPlan(p, { manifest: m, mode: 'move', captureMeta });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.deepEqual({ moved: r.moved, rawDeleted: r.rawDeleted, rawKept: r.rawKept }, { moved: 1, rawDeleted: 2, rawKept: 0 });
  assert.deepEqual(fs.readdirSync(fx.libAbs), [], 'raw folder emptied');
  assert.equal(fs.readFileSync(timelineC, 'utf8'), 'CCC', 'kept timeline copy untouched');
  assert.deepEqual(sidecarOf(fx, 'AAA').locations.map(l => l.relativePath).sort(), ['a.JPG', 'copy-of-a.JPG'], 'duplicate location recorded before delete');

  const u = await undoRun(r.runId, { manifest: m, destRoot: fx.root });
  assert.equal(u.errors.filter(e => !e.reason.startsWith('kept-shared')).length, 0, JSON.stringify(u.errors));
  for (const [rel, c] of [['a.JPG', 'AAA'], ['copy-of-a.JPG', 'AAA'], ['c.JPG', 'CCC']]) assert.equal(fs.readFileSync(raw(fx, rel), 'utf8'), c, `${rel} restored`);
  assert.equal(m.getAsset(sha('AAA')), undefined, 'moved asset removed from the manifest');
  assert.equal(fs.readFileSync(timelineC, 'utf8'), 'CCC', 'older timeline asset kept');
  m.close();
});

test('move: a metadata failure leaves the item untouched', async () => {
  const fx = folderFixture([{ rel: 'a.JPG', content: 'AAA' }]);
  const m = open();
  const r = await applyPlan(await plan(fx, m), { manifest: m, mode: 'move', captureMeta: async () => { throw new Error('exiftool died'); } });
  assert.equal(r.moved, 0);
  assert.match(r.errors[0].reason, /exiftool died/);
  assert.equal(fs.readFileSync(raw(fx, 'a.JPG'), 'utf8'), 'AAA');
  assert.equal(m.getAsset(sha('AAA')), undefined);
  m.close();
});

test('move: refused for library bundles and without metadata capture', async () => {
  const lib = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }]);
  const m = open();
  const p = await buildPlan({ libraryPath: lib.libAbs, destRoot: lib.root, sourceId: 'photos-x', manifest: m, deps: lib.deps });
  await assert.rejects(applyPlan(p, { manifest: m, mode: 'move', captureMeta: recorder().captureMeta }), /only allowed for folder sources/);
  const fx = folderFixture([{ rel: 'a.JPG', content: 'AAA' }]);
  await assert.rejects(applyPlan(await plan(fx, m), { manifest: m, mode: 'move' }), /requires metadata capture/);
  assert.equal(fs.readFileSync(raw(fx, 'a.JPG'), 'utf8'), 'AAA');
  m.close();
});

test('metadata: full dump + xmp byte copies + never overwrites', async () => {
  const root = tmpDir();
  const src = path.join(root, 'iCloud-Photos/2014/03/IMG_1.HEIC');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'IMG');
  fs.writeFileSync(`${src}.xmp`, '<x:xmpmeta>caption</x:xmpmeta>');
  assert.deepEqual(findXmpSidecars(src).map(p => path.basename(p)), ['IMG_1.HEIC.xmp']);
  const readFullExif = async () => ({ SourceFile: src, 'System:FileName': 'IMG_1.HEIC', 'System:FileModifyDate': 'x', 'Apple:ContentIdentifier': 'C1', 'XMP-dc:Title': 'T', 'MakerNotes:RunTime': { a: 1 } });
  const meta = await captureMetadata(root, { sha256: sha('IMG'), absPath: src, relativePath: '2014/03/IMG_1.HEIC', sizeBytes: 3 }, { readFullExif, sourceId: 'folder-icloud' });
  const dump = JSON.parse(fs.readFileSync(path.join(root, meta.exif!), 'utf8'));
  assert.deepEqual(Object.keys(dump.tags).sort(), ['Apple:ContentIdentifier', 'MakerNotes:RunTime', 'XMP-dc:Title']);
  assert.equal(meta.xmp.length, 1);
  assert.equal(fs.readFileSync(path.join(root, meta.xmp[0]), 'utf8'), '<x:xmpmeta>caption</x:xmpmeta>');
  assert.equal(fs.readFileSync(src, 'utf8'), 'IMG', 'source untouched');
  assert.equal(writeOnce(path.join(root, meta.xmp[0]), 'other'), 'different');
  assert.equal(fs.readFileSync(path.join(root, meta.xmp[0]), 'utf8'), '<x:xmpmeta>caption</x:xmpmeta>', 'never overwritten');
  assert.deepEqual(normalizeExifDump({ FileName: 'a', 'Composite:ImageSize': '1x1' }), { 'Composite:ImageSize': '1x1' });
});

test('metadata: Photos.sqlite record lookup by name + size + date, every column kept', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const file = path.join(tmpDir(), 'Photos.sqlite');
  const db = new Database(file);
  db.exec(`create table ZASSET (Z_PK integer primary key, ZUUID text, ZCLOUDASSETGUID text, ZDATECREATED real, ZFAVORITE int, ZHIDDEN int, ZTRASHEDSTATE int, ZMOMENT int, ZODDCOLUMN blob);
    create table ZADDITIONALASSETATTRIBUTES (Z_PK integer primary key, ZASSET int, ZORIGINALFILENAME text, ZORIGINALFILESIZE int, ZTITLE text);
    create table ZASSETDESCRIPTION (Z_PK integer primary key, ZASSETATTRIBUTES int, ZLONGDESCRIPTION text);
    create table ZGENERICALBUM (Z_PK integer primary key, ZTITLE text, ZKIND int, ZUUID text, ZCLOUDGUID text, ZTRASHEDSTATE int);
    create table Z_30ASSETS (Z_30ALBUMS int, Z_3ASSETS int);
    create table ZKEYWORD (Z_PK integer primary key, ZTITLE text);
    create table Z_1KEYWORDS (Z_1ASSETATTRIBUTES int, Z_47KEYWORDS int);
    create table ZPERSON (Z_PK integer primary key, ZFULLNAME text, ZDISPLAYNAME text, ZPERSONUUID text);
    create table ZDETECTEDFACE (Z_PK integer primary key, ZASSETFORFACE int, ZPERSONFORFACE int, ZMANUAL int, ZHIDDEN int);
    create table ZMOMENT (Z_PK integer primary key, ZTITLE text, ZSUBTITLE text, ZUUID text, ZLOCALIZEDLOCATIONNAMES blob);
    insert into ZASSET values (1,'U1','G1',100,1,0,0,1,x'0102'), (2,'U2','G2',100,0,0,0,null,null), (3,'U3','G3',500,0,0,1,null,null);
    insert into ZADDITIONALASSETATTRIBUTES values (11,1,'IMG_1.HEIC',3,'Beach'), (12,2,'IMG_1.HEIC',9,null), (13,3,'IMG_9.HEIC',3,null);
    insert into ZASSETDESCRIPTION values (1,11,'sunset');
    insert into ZGENERICALBUM values (5,'Trip',2,'A','AG',0);
    insert into Z_30ASSETS values (5,1);
    insert into ZKEYWORD values (7,'family'); insert into Z_1KEYWORDS values (11,7);
    insert into ZPERSON values (9,'Alex X','Alex','P'); insert into ZDETECTEDFACE values (1,1,9,0,0);
    insert into ZMOMENT values (1,'Chicago','Wicker Park','M',null);`);
  db.close();
  const idx = openLibraryRecordIndex(file);
  const createdUnix = 100 + 978307200;
  const hit = idx.lookup('IMG_1.HEIC', 3, createdUnix);
  assert.equal(hit.match, 'name-size-date');
  const rec = hit.records[0] as any;
  assert.deepEqual([rec.uuid, rec.favorite, rec.title, rec.caption, rec.albums[0].title, rec.keywords[0], rec.people[0].fullName, rec.moment.title],
    ['U1', true, 'Beach', 'sunset', 'Trip', 'family', 'Alex X', 'Chicago']);
  assert.deepEqual(rec.zAsset.ZODDCOLUMN, { base64: 'AQI=' }, 'unlisted columns + blobs kept');
  assert.equal(idx.lookup('img_1-3.heic', 3, createdUnix).match, 'name-size-date', 'icloudpd -<size> suffix stripped');
  assert.equal(idx.lookup('IMG_9.HEIC', 3, null).match, 'none', 'trashed rows ignored');
  assert.equal(idx.lookup('IMG_1.HEIC', 4, null).match, 'ambiguous');
  assert.equal(idx.lookup('IMG_1.HEIC', 4, null).records.length, 2, 'ambiguous keeps every candidate');
  idx.close();
  assert.deepEqual(nameKeys('IMG_1-1234.HEIC'), ['img_1-1234.heic', 'img_1.heic']);
});

test('move: refused for an external (ext:) folder source', async () => {
  const fx = folderFixture([{ rel: 'a.JPG', content: 'AAA' }]);
  const m = open();
  const p = { ...(await plan(fx, m)), libraryPath: 'ext:4TB - WMD/x' };
  await assert.rejects(applyPlan(p, { manifest: m, mode: 'move', captureMeta: recorder().captureMeta }), /must be inside destRoot/);
  assert.equal(fs.readFileSync(raw(fx, 'a.JPG'), 'utf8'), 'AAA');
  m.close();
});
