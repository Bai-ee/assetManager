import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from './manifest';
import { buildPlan, savePlan, loadPlan } from './plan';
import { applyPlan } from './apply';
import { makeFixture, sha, tmpDir } from './test-fixtures';

const open = () => new Manifest(path.join(tmpDir(), 'm.sqlite'));

test('plan: classifies copy / duplicate / present / conflict, library path share-relative', async () => {
  const fx = makeFixture([
    { rel: 'Masters/a.JPG', content: 'AAA', date: '2018-06-21T10:20:30.000Z' },
    { rel: 'Masters/a-copy.JPG', content: 'AAA', date: '2018-06-21T10:20:30.000Z' }, // same sha -> duplicate
    { rel: 'Masters/b.JPG', content: 'BBB', date: '2018-07-01T00:00:00.000Z' },     // dest already holds same bytes -> present
    { rel: 'Masters/c.JPG', content: 'CCC', date: '2018-08-01T00:00:00.000Z' },     // dest holds different bytes -> conflict
    { rel: 'Masters/d.JPG', content: 'DDD', date: null },                            // unknown date
  ]);
  const m = open();
  const put = (rel: string, c: string) => { const p = path.join(fx.root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  put(`HITLOOP-ARCHIVE/timeline/2018/07/2018-07-01_000000_${sha('BBB').slice(0, 8)}.jpg`, 'BBB');
  put(`HITLOOP-ARCHIVE/timeline/2018/08/2018-08-01_000000_${sha('CCC').slice(0, 8)}.jpg`, 'XXX');
  const plan = await buildPlan({ libraryPath: fx.libAbs, destRoot: fx.root, sourceId: 'photos-test', manifest: m, deps: fx.deps });
  assert.deepEqual(plan.items.map(i => i.action), ['copy', 'duplicate', 'present', 'conflict', 'copy']);
  assert.equal(plan.libraryPath, fx.libRel);
  assert.deepEqual({ ...plan.totals }, { items: 5, copy: 2, present: 1, duplicate: 1, conflict: 1, children: 0, bytes: 6 });
  assert.match(plan.planId, /^plan-\d{14}-[0-9a-f]{4}$/);
  assert.ok(plan.items[4].canonicalPath.includes('/unknown/'));

  const home = tmpDir();
  savePlan(plan, home);
  assert.deepEqual(loadPlan(plan.planId, home), plan);
  m.close();
});

test('plan: children classified, limit, and cached hashes avoid re-hashing', async () => {
  const fx = makeFixture([
    { rel: 'Masters/a.JPG', content: 'AAA', motion: { rel: 'resources/media/master/jpegvideocomplement_1.mov', content: 'MOV' } },
    { rel: 'Masters/b.JPG', content: 'BBB' },
  ]);
  const m = open();
  const calls: string[] = [];
  const hashFile = async (p: string) => { calls.push(p); return sha(fs.readFileSync(p, 'utf8')); };
  const deps = { ...fx.deps, hashFile };
  const p1 = await buildPlan({ libraryPath: fx.libAbs, destRoot: fx.root, sourceId: 'photos-test', manifest: m, deps, limit: 1 });
  assert.equal(p1.items.length, 1);
  assert.equal(p1.items[0].children.length, 1);
  assert.equal(p1.items[0].children[0].role, 'motion');
  assert.ok(p1.items[0].children[0].canonicalPath.endsWith('_motion.mov'));
  assert.equal(p1.totals.children, 1);

  await applyPlan(p1, { manifest: m });
  calls.length = 0;
  const p2 = await buildPlan({ libraryPath: fx.libAbs, destRoot: fx.root, sourceId: 'photos-test', manifest: m, deps, limit: 1 });
  assert.equal(p2.items[0].action, 'present');
  assert.equal(p2.items[0].children[0].action, 'present');
  assert.equal(calls.filter(c => c.startsWith(fx.libAbs)).length, 0, 'library files not re-hashed after apply');
  m.close();
});
