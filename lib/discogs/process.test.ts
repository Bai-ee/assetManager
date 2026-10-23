import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscogsClient } from './client';
import type { GroupPlan, MediaFile, DiscogsCandidate } from './types';
import { processFolder, autoRenderable, needsReview, doneFrom, type ProcessDeps } from './process';
import { publishPaths } from './publish-run';

const img = (i: number, extra: Partial<MediaFile> = {}): MediaFile => ({
  path: `/nas/IMG_${i}.HEIC`, name: `IMG_${i}.HEIC`, kind: 'image', size: 1, fingerprint: `fp${i}`.padEnd(16, '0'),
  capturedAt: `2026-10-0${(i % 8) + 1}T10:00:00.000Z`, mtime: '2026-10-01T00:00:00Z', seq: i, duplicateOf: null, ...extra,
});
const vid = (i: number): MediaFile => ({ ...img(i), path: `/nas/IMG_${i}.MOV`, name: `IMG_${i}.MOV`, kind: 'video' });
const cand = (releaseId: number, exact = true, score = 0.95): DiscogsCandidate => ({ releaseId, title: `R${releaseId}`, catno: 'C', label: 'L', formats: ['Vinyl'], country: 'US', year: '1999', score, reasons: exact ? ['catno exact'] : ['title match'] });
const plan = (id: string, o: { images?: MediaFile[]; videos?: MediaFile[]; best?: DiscogsCandidate | null; action: GroupPlan['action'] }): GroupPlan => ({
  group: { id, images: o.images ?? [img(1)], videos: o.videos ?? [vid(2)], groupedBy: 'capture-time' },
  reads: [{ file: 'x', status: 'readable', artist: 'A', title: 'T', label: 'L', catno: 'C', year: null, tracks: [], side: null, notes: null, model: 'm', cached: true } as any],
  candidates: o.best ? [o.best] : [], best: o.best ?? null, action: o.action, reason: 'r',
});

function harness(plans: GroupPlan[], o: { published?: number[]; hitloop?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'discogs-process-'));
  const paths = publishPaths(home);
  mkdirSync(paths.runs, { recursive: true });
  writeFileSync(paths.published, JSON.stringify((o.published ?? []).map(releaseId => ({ releaseId, postId: 'p', packageId: 'd', at: 't', clip: {} }))));
  writeFileSync(join(home, 'index.json'), JSON.stringify({ '/nas/IMG_1.HEIC': {}, '/nas/IMG_2.MOV': {} })); // known before this run
  const calls = { applied: [] as any[], published: [] as any[], thumbs: 0 };
  const deps: ProcessDeps = {
    client: {} as DiscogsClient, cacheDir: paths.cache, runsDir: paths.runs, indexPath: join(home, 'index.json'), paths,
    hitloop: o.hitloop === false ? null : { post: async () => ({}) as any },
    planFolder: async () => ({ planId: '2026-10-23T00-00-00-000Z', rows: [], plans, summary: { groups: plans.length, add: 0, alreadyOwned: 0, review: 0, unreadable: 0 }, spentUsd: 0.01, cost: {} as any, capReached: false, cancelled: false, remaining: 0 }),
    applyPlan: async input => { calls.applied.push(...input.items); return { planId: input.planId, journal: 'j', applied: input.items.map(i => ({ ...i, instanceId: 1 })), skipped: [], errors: [] }; },
    publishRecord: async (rec, opts) => {
      calls.published.push({ releaseId: rec.releaseId, video: opts.videoOverride?.name ?? null, dry: opts.hitloop === null });
      const entry = { releaseId: rec.releaseId, postId: `post_${rec.releaseId}`, packageId: `discogs-${rec.releaseId}`, at: 't', clip: { start: 0, end: 60, look: 'l' }, groupId: rec.group.id };
      return { prepared: { facts: { artist: 'A', title: 'T' }, videoName: opts.videoOverride?.name ?? rec.group.videos[0].name } as any, entry: opts.hitloop ? entry : null, draft: opts.hitloop ? { postId: entry.postId, packageId: entry.packageId, created: true } : null, seconds: 1 };
    },
    thumb: async () => { calls.thumbs++; return 'data:image/jpeg;base64,x'; },
  };
  return { deps, calls, paths };
}

test('autoRenderable / needsReview: confident + one clip renders; 2 clips, 0 clips, weak match, published do not', () => {
  const pub = doneFrom([{ releaseId: 9 }, { releaseId: 1, groupId: 'g-byGroup' }]);
  // done by label group even though the matcher now says a different pressing id
  assert.equal(autoRenderable(plan('g-byGroup', { best: cand(777), action: 'already-owned' }), pub), false);
  assert.equal(needsReview(plan('g-byGroup', { best: cand(777, false), action: 'review' }), pub), false);
  assert.equal(autoRenderable(plan('g1', { best: cand(7), action: 'already-owned' }), pub), true);
  assert.equal(autoRenderable(plan('g2', { best: cand(7), action: 'add', videos: [vid(2), vid(3)] }), pub), false);
  assert.equal(needsReview(plan('g2', { best: cand(7), action: 'add', videos: [vid(2), vid(3)] }), pub), true);
  assert.equal(autoRenderable(plan('g3', { best: cand(7), action: 'add', videos: [] }), pub), false);
  assert.equal(needsReview(plan('g3', { best: cand(7), action: 'add', videos: [] }), pub), false);
  assert.equal(autoRenderable(plan('g4', { best: cand(7, false), action: 'review' }), pub), false);
  assert.equal(needsReview(plan('g4', { best: cand(7, false), action: 'review' }), pub), true);
  assert.equal(autoRenderable(plan('g5', { best: cand(9), action: 'already-owned' }), pub), false);
  assert.equal(needsReview(plan('g5', { best: cand(9), action: 'already-owned' }), pub), false);
});

test('processFolder: adds the "add" rows, renders confident single-clip records, lists the rest for review with thumbs', async () => {
  const plans = [
    plan('g-add', { best: cand(11), action: 'add' }),                                             // add + render
    plan('g-owned', { images: [img(3)], videos: [vid(4)], best: cand(12), action: 'already-owned' }), // render (new files)
    plan('g-two', { images: [img(5)], videos: [vid(6), vid(7)], best: cand(13), action: 'add' }),   // add, review (2 clips)
    plan('g-weak', { images: [img(8)], videos: [vid(9)], best: cand(14, false, 0.4), action: 'review' }), // review
    plan('g-none', { images: [img(10)], videos: [], best: cand(15), action: 'already-owned' }),      // no clip
    plan('g-done', { images: [img(11)], videos: [vid(12)], best: cand(16), action: 'already-owned' }), // published already
  ];
  const { deps, calls } = harness(plans, { published: [16] });
  const r = await processFolder({ dir: '/nas' }, deps);
  assert.deepEqual(calls.applied.map(a => a.releaseId).sort(), [11, 13]);
  assert.deepEqual(r.published.map(p => p.releaseId), [11, 12]);
  assert.deepEqual(calls.published.map(p => p.dry), [false, false]);
  assert.deepEqual(r.review.map(x => x.groupId), ['g-two', 'g-weak']); // both new files; g-two sorted first by capture date? both new -> by date desc
  assert.equal(r.review.find(x => x.groupId === 'g-two')!.reason, '2 clips in this group: pick one');
  assert.equal(r.review.find(x => x.groupId === 'g-two')!.clips.length, 2);
  assert.ok(r.review.every(x => x.label.thumb && x.clips.every(c => c.thumb)));
  assert.deepEqual(r.noClip.map(n => n.releaseId), [15]);
  assert.equal(r.newFiles, plans.flatMap(p => [...p.group.images, ...p.group.videos]).length - 2);
  assert.equal(r.cancelled, false);
});

test('processFolder: publish:false plans + reviews only; `only` pins a release and a clip from the review list', async () => {
  const plans = [plan('g-two', { images: [img(5)], videos: [vid(6), vid(7)], best: cand(13), action: 'add' })];
  const dry = harness(plans);
  const r1 = await processFolder({ dir: '/nas', publish: false }, dry.deps);
  assert.equal(dry.calls.applied.length, 0);
  assert.equal(r1.published.length, 0);
  assert.equal(r1.review.length, 1);

  const pin = harness(plans);
  const r2 = await processFolder({ dir: '/nas', only: [{ groupId: 'g-two', releaseId: 99, video: 'IMG_7.MOV' }] }, pin.deps);
  assert.deepEqual(pin.calls.published, [{ releaseId: 99, video: 'IMG_7.MOV', dry: false }]);
  assert.equal(r2.published[0].postId, 'post_99');
  assert.equal(r2.review.length, 0); // its release is published now

  const bad = harness(plans);
  const r3 = await processFolder({ dir: '/nas', only: [{ groupId: 'g-two', releaseId: 99 }, { groupId: 'nope', releaseId: 1 }, { groupId: 'g-two', releaseId: 99, video: 'IMG_8.MOV' }] }, bad.deps);
  assert.deepEqual(r3.failed.map(f => f.error), ['pick which clip to use', 'group not in this plan', 'clip IMG_8.MOV is not in this group']);
  assert.equal(bad.calls.published.length, 0);
});

test('processFolder: a failed render is reported and the batch continues; cancel stops between records', async () => {
  const plans = [plan('g-a', { best: cand(21), action: 'add' }), plan('g-b', { images: [img(3)], videos: [vid(4)], best: cand(22), action: 'add' })];
  const h = harness(plans);
  const inner = h.deps.publishRecord!;
  h.deps.publishRecord = async (rec, o) => { if (rec.releaseId === 21) throw new Error('ffmpeg exploded'); return inner(rec, o); };
  const r = await processFolder({ dir: '/nas' }, h.deps);
  assert.deepEqual(r.failed, [{ groupId: 'g-a', releaseId: 21, error: 'ffmpeg exploded' }]);
  assert.deepEqual(r.published.map(p => p.releaseId), [22]);

  const c = harness(plans);
  let n = 0;
  c.deps.isCancelled = () => n++ > 0;
  const rc = await processFolder({ dir: '/nas' }, c.deps);
  assert.equal(rc.cancelled, true);
  assert.equal(rc.published.length, 1);
});
