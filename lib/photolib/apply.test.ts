import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from './manifest';
import { buildPlan } from './plan';
import { applyPlan, undoRun } from './apply';
import { makeFixture, listFiles, sha, snapshotTree, tmpDir, type Fixture } from './test-fixtures';
import type { Plan, Sidecar } from './types';

process.env.PHOTOLIB_HOME = tmpDir(); // default apply.lock lives here, never in the real ~/.photolib
const open = () => new Manifest(path.join(tmpDir(), 'm.sqlite'));
const plan = (fx: Fixture, m: Manifest, limit?: number): Promise<Plan> =>
  buildPlan({ libraryPath: fx.libAbs, destRoot: fx.root, sourceId: 'photos-test', manifest: m, deps: fx.deps, limit });
const timeline = (fx: Fixture) => listFiles(path.join(fx.root, 'HITLOOP-ARCHIVE'));
const sidecarOf = (fx: Fixture, c: string) => JSON.parse(fs.readFileSync(path.join(fx.root, `HITLOOP-ARCHIVE/timeline/_meta/${sha(c)}.json`), 'utf8')) as Sidecar;

test('apply: copies, verifies, writes sidecar + manifest, never touches the library bundle', async () => {
  const fx = makeFixture([
    { rel: 'Masters/a.JPG', content: 'AAA', albums: ['Trip'], motion: { rel: 'resources/media/master/jv_1.mov', content: 'MOV' } },
    { rel: 'Masters/b.JPG', content: 'BBB' },
  ]);
  const m = open();
  const before = snapshotTree(fx.libAbs);
  const r = await applyPlan(await plan(fx, m), { manifest: m });
  assert.deepEqual({ copied: r.copied, present: r.present, duplicate: r.duplicate, conflict: r.conflict, children: r.children, bytes: r.bytes, errors: r.errors.length }, { copied: 2, present: 0, duplicate: 0, conflict: 0, children: 1, bytes: 9, errors: 0 });
  assert.deepEqual(snapshotTree(fx.libAbs), before, 'library bundle byte-identical');
  assert.ok(!timeline(fx).some(f => f.includes('photolib-tmp')));
  const sc = sidecarOf(fx, 'AAA');
  assert.equal(sc.schema, 'photolib.sidecar/1');
  assert.deepEqual(sc.albums, ['Trip']);
  assert.equal(sc.children.motion?.sha256, sha('MOV'));
  assert.equal(sc.locations[0].libraryPath, fx.libRel);
  const row = m.getAsset(sha('AAA'))!;
  assert.ok(row.verifiedAt); assert.equal(JSON.parse(row.sidecarJson).sha256, sha('AAA'));
  assert.equal(fs.readFileSync(path.join(fx.root, row.canonicalPath), 'utf8'), 'AAA');
  assert.equal(m.listChildren(sha('AAA')).length, 1);
  assert.equal(m.getCachedHash('photos-test', 'Masters/a.JPG', 3), sha('AAA'));
  const roles = m.journalForRun(r.runId).map(j => j.role).sort();
  assert.deepEqual(roles, ['motion', 'primary', 'primary', 'sidecar', 'sidecar']);
  assert.equal(m.getRun(r.runId)?.state, 'completed');
  m.close();
});

test('apply: never overwrites a conflicting file; re-run is idempotent', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }, { rel: 'Masters/c.JPG', content: 'CCC' }]);
  const m = open();
  const p = await plan(fx, m);
  // plant a different file at c's canonical path AFTER planning (plan said copy)
  const cPath = path.join(fx.root, p.items[1].canonicalPath);
  fs.mkdirSync(path.dirname(cPath), { recursive: true }); fs.writeFileSync(cPath, 'OTHER');
  const stat = fs.statSync(cPath);
  const r = await applyPlan(p, { manifest: m });
  assert.equal(r.conflict, 1); assert.equal(r.copied, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(fs.readFileSync(cPath, 'utf8'), 'OTHER');
  assert.equal(fs.statSync(cPath).mtimeMs, stat.mtimeMs);
  assert.equal(m.getAsset(sha('CCC')), undefined);
  assert.ok(!timeline(fx).some(f => f.includes('photolib-tmp')));

  const j1 = m.db.prepare('select count(*) n from journal').get() as { n: number };
  const files1 = timeline(fx);
  const r2 = await applyPlan(p, { manifest: m });
  assert.equal(r2.copied, 0); assert.equal(r2.present, 1); assert.equal(r2.conflict, 1);
  assert.deepEqual(timeline(fx), files1);
  assert.equal((m.db.prepare('select count(*) n from journal').get() as { n: number }).n, j1.n, 'no new journal rows');
  m.close();
});

test('apply: duplicate adds a location and merges sidecar (albums union, createdAt kept)', async () => {
  const fx = makeFixture([
    { rel: 'Masters/a.JPG', content: 'AAA', albums: ['One'] },
    { rel: 'Masters/a2.JPG', content: 'AAA', albums: ['Two'] },
  ]);
  const m = open();
  const r = await applyPlan(await plan(fx, m), { manifest: m, now: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(r.copied, 1); assert.equal(r.duplicate, 1);
  const sc = sidecarOf(fx, 'AAA');
  assert.deepEqual(sc.albums.sort(), ['One', 'Two']);
  assert.deepEqual(sc.locations.map(l => l.relativePath), ['Masters/a.JPG', 'Masters/a2.JPG']);
  assert.equal(sc.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(m.listLocations(sha('AAA')).length, 2);
  assert.equal(listFiles(path.join(fx.root, 'HITLOOP-ARCHIVE/timeline')).filter(f => !f.startsWith('_meta')).length, 1);
  m.close();
});

test('apply: cancel mid-run stops between items', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }, { rel: 'Masters/b.JPG', content: 'BBB' }, { rel: 'Masters/c.JPG', content: 'CCC' }]);
  const m = open();
  let done = 0;
  const r = await applyPlan(await plan(fx, m), { manifest: m, isCancelled: () => done >= 1, onProgress: p => { done = p.done; } });
  assert.equal(r.cancelled, true); assert.equal(r.copied, 1);
  assert.equal(m.getRun(r.runId)?.state, 'cancelled');
  // resume: remaining items are copied, the first is skipped as already verified
  const r2 = await applyPlan(await plan(fx, m), { manifest: m });
  assert.equal(r2.copied, 2); assert.equal(r2.present, 1);
  m.close();
});

test('undo: removes only journaled files, leaves unrelated files; partial with limit', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }, { rel: 'Masters/b.JPG', content: 'BBB' }]);
  const m = open();
  const keep = path.join(fx.root, 'HITLOOP-ARCHIVE/timeline/2018/06/unrelated.txt');
  fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.writeFileSync(keep, 'mine');
  const r = await applyPlan(await plan(fx, m), { manifest: m });
  assert.equal(m.journalForRun(r.runId).length, 4);

  const u1 = await undoRun(r.runId, { manifest: m, destRoot: fx.root, limit: 2 });
  assert.equal(u1.undone, 2); assert.equal(u1.partial, true);
  assert.equal(m.journalForRun(r.runId).filter(j => j.undoneAt).length, 2);

  const u2 = await undoRun(r.runId, { manifest: m, destRoot: fx.root });
  assert.equal(u2.undone, 2); assert.equal(u2.partial, false); assert.equal(u2.removedAssets + u1.removedAssets, 2);
  assert.deepEqual(timeline(fx), ['timeline/2018/06/unrelated.txt']);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'mine');
  assert.equal(m.listAssets().length, 0);
  assert.ok(!fs.existsSync(path.join(fx.root, 'HITLOOP-ARCHIVE/timeline/_meta')), 'empty dirs removed');
  assert.ok(fs.existsSync(path.join(fx.root, 'HITLOOP-ARCHIVE/timeline')), 'timeline root kept');
  m.close();
});

test('undo: a file modified after the run is left in place', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }]);
  const m = open();
  const r = await applyPlan(await plan(fx, m), { manifest: m });
  const p = path.join(fx.root, m.getAsset(sha('AAA'))!.canonicalPath);
  fs.writeFileSync(p, 'EDITED!');
  const u = await undoRun(r.runId, { manifest: m, destRoot: fx.root });
  assert.equal(u.skipped, 1);
  assert.ok(fs.existsSync(p));
  assert.ok(m.getAsset(sha('AAA')), 'asset row kept when primary not undone');
  m.close();
});

test('undo: sidecar with locations from another source is kept', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }]);
  const m = open();
  const r = await applyPlan(await plan(fx, m), { manifest: m });
  const sp = path.join(fx.root, `HITLOOP-ARCHIVE/timeline/_meta/${sha('AAA')}.json`);
  const sc = JSON.parse(fs.readFileSync(sp, 'utf8')) as Sidecar;
  sc.locations.push({ ...sc.locations[0], sourceId: 'other', relativePath: 'x.jpg' });
  fs.writeFileSync(sp, JSON.stringify(sc));
  const u = await undoRun(r.runId, { manifest: m, destRoot: fx.root });
  assert.ok(fs.existsSync(sp));
  assert.ok(u.errors.some(e => e.destPath.includes('_meta')));
  m.close();
});

test('undo: asset shared with another run is kept; only this run\'s location is removed', async () => {
  const fxA = makeFixture([{ rel: 'Masters/a.JPG', content: 'XXX' }]);
  const m = open();
  const rA = await applyPlan(await plan(fxA, m), { manifest: m });
  // run B: a second library location for the same bytes
  const planB = await buildPlan({ libraryPath: fxA.libAbs, destRoot: fxA.root, sourceId: 'photos-other', manifest: m, deps: { ...fxA.deps, readLibrary: (lp) => ({ kind: 'photos', libraryPath: lp, warnings: [], items: [{ ...fxA.items[0], sourceId: 'photos-other', relativePath: 'Masters/b-copy.JPG', masterUuid: 'mB' }] }) } });
  assert.equal(planB.items[0].action, 'present');
  const rB = await applyPlan(planB, { manifest: m });
  assert.equal(rB.present, 1);

  const primary = path.join(fxA.root, m.getAsset(sha('XXX'))!.canonicalPath);
  const u = await undoRun(rA.runId, { manifest: m, destRoot: fxA.root });
  assert.deepEqual(u.keptShared, [sha('XXX')]);
  assert.equal(u.removedAssets, 0);
  assert.ok(fs.existsSync(primary), 'primary kept');
  const sc = sidecarOf(fxA, 'XXX');
  assert.deepEqual(sc.locations.map(l => `${l.sourceId}:${l.relativePath}`), ['photos-other:Masters/b-copy.JPG']);
  assert.ok(m.getAsset(sha('XXX')), 'manifest asset kept');
  assert.deepEqual(m.listLocations(sha('XXX')).map(l => l.sourceId), ['photos-other']);
  assert.deepEqual(JSON.parse(m.getAsset(sha('XXX'))!.sidecarJson).locations.length, 1);
  m.close();
});

test('apply/undo: exclusive lockfile; live pid blocks, stale pid is replaced, released after run', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }]);
  const m = open();
  const p = await plan(fx, m);
  const lockPath = path.join(tmpDir(), 'apply.lock');
  fs.writeFileSync(lockPath, String(process.pid));
  await assert.rejects(applyPlan(p, { manifest: m, lockPath }), /another photolib apply\/undo is running/);
  await assert.rejects(undoRun('nope', { manifest: m, destRoot: fx.root, lockPath }), /another photolib apply\/undo is running/);
  assert.ok(fs.existsSync(lockPath), 'foreign lock untouched');
  fs.writeFileSync(lockPath, '999999999'); // dead pid
  const r = await applyPlan(p, { manifest: m, lockPath });
  assert.equal(r.copied, 1);
  assert.ok(!fs.existsSync(lockPath), 'lock released');
  await undoRun(r.runId, { manifest: m, destRoot: fx.root, lockPath });
  assert.ok(!fs.existsSync(lockPath));
  m.close();
});

test('apply: stale photolib-tmp files (>1h) in destination dirs are swept; fresh and unrelated files stay', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }]);
  const m = open();
  const p = await plan(fx, m);
  const dir = path.dirname(path.join(fx.root, p.items[0].canonicalPath));
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'x.jpg.photolib-tmp-deadbeef'), fresh = path.join(dir, 'y.jpg.photolib-tmp-cafebabe'), other = path.join(dir, 'keep.txt.tmp');
  for (const f of [old, fresh, other]) fs.writeFileSync(f, 'z');
  const t = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, t, t); fs.utimesSync(other, t, t);
  await applyPlan(p, { manifest: m });
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(fresh)); assert.ok(fs.existsSync(other));
  m.close();
});

test('apply: a throw outside the per-item loop marks the run failed and rethrows', async () => {
  const fx = makeFixture([{ rel: 'Masters/a.JPG', content: 'AAA' }]);
  const m = open();
  let runId = '';
  const orig = m.startRun.bind(m);
  m.startRun = (r) => { runId = r.runId; orig(r); };
  await assert.rejects(applyPlan(await plan(fx, m), { manifest: m, onProgress: () => { throw new Error('boom'); } }), /boom/);
  assert.equal(m.getRun(runId)?.state, 'failed');
  assert.ok(JSON.parse(m.getRun(runId)!.summaryJson!).locations.length === 1, 'locations kept so undo still works');
  m.close();
});
