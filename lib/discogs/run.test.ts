import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscogsClient } from './client';
import type { DiscogsCandidate, LabelRead, MediaFile } from './types';
import { planFolder, estimateFolder, applyPlan, undoApply, toPlanRow, notesFor } from './run';
import type { RunDeps } from './run';

const BASE_T = Date.parse('2026-01-01T12:00:00Z');

function img(i: number): MediaFile {
  return {
    path: `/nas/IMG_${i}.HEIC`, name: `IMG_${i}.HEIC`, kind: 'image', size: 10, fingerprint: `fp${String(i).padStart(14, '0')}`,
    capturedAt: new Date(BASE_T + i * 3_600_000).toISOString(), mtime: new Date(BASE_T).toISOString(), seq: i, duplicateOf: null,
  };
}

function cand(releaseId: number, score: number, catnoExact = true): DiscogsCandidate {
  return {
    releaseId, title: `Artist ${releaseId} - Title ${releaseId}`, catno: `C${releaseId}`, label: 'Lab', formats: ['Vinyl', '12"', 'EP', 'x'],
    country: 'US', year: '1999', score, reasons: catnoExact ? ['catno exact', 'vinyl'] : ['vinyl'],
  };
}

interface Fakes {
  deps: RunDeps;
  calls: { reads: number; added: number[]; notes: number[]; removed: number[]; search: number };
  runsDir: string;
}

/** n image groups. catno of image i is `C<i>`; override the candidate per catno with `matches`. */
function fakes(n: number, o: { owned?: number[]; cached?: number[]; matches?: Record<string, DiscogsCandidate[]>; unreadable?: number[]; capUsd?: number; cancelAfterReads?: number } = {}): Fakes {
  const tmp = mkdtempSync(join(tmpdir(), 'discogs-run-'));
  const files = Array.from({ length: n }, (_, i) => img(i + 1));
  const calls = { reads: 0, added: [] as number[], notes: [] as number[], removed: [] as number[], search: 0 };
  let nextInstance = 100;
  const client = {
    configured: true,
    identity: async () => ({ id: 1, username: 'u', resource_url: '' }),
    collectionReleaseIds: async () => new Set(o.owned ?? []),
    addToCollection: async (_u: string, _f: number, rid: number) => { calls.added.push(rid); return { instance_id: nextInstance++, resource_url: '' }; },
    setInstanceField: async (_u: string, _f: number, rid: number) => { calls.notes.push(rid); return {}; },
    removeInstance: async (_u: string, _f: number, rid: number, inst: number) => { calls.removed.push(inst); void rid; return {}; },
  } as unknown as DiscogsClient;
  const idx = (p: string) => Number(/IMG_(\d+)/.exec(p)?.[1] ?? /fp0*(\d+)/.exec(p)?.[1]);
  const deps: RunDeps = {
    client, cacheDir: join(tmp, 'cache'), runsDir: join(tmp, 'runs'), capUsd: o.capUsd,
    scan: async () => files,
    toJpeg: async f => `/fake/${f.fingerprint}.jpg`,
    isCached: p => (o.cached ?? []).includes(idx(p)),
    readLabel: async (p, name) => {
      calls.reads++;
      const i = idx(p);
      const cached = (o.cached ?? []).includes(i);
      const bad = (o.unreadable ?? []).includes(i);
      return {
        file: name, status: bad ? 'unreadable' : 'readable', artist: bad ? null : `Artist ${i}`, title: bad ? null : `Title ${i}`, label: 'Lab',
        catno: bad ? null : `C${i}`, year: null, tracks: [], side: 'A', notes: null, model: 'claude-sonnet-5-5', cached,
        ...(cached ? {} : { usage: { inputTokens: 1000, outputTokens: 1000 } }),
      } as LabelRead;
    },
    findCandidates: async (_c, merged) => {
      calls.search++;
      return o.matches?.[merged.catno ?? ''] ?? [];
    },
    isCancelled: o.cancelAfterReads ? () => calls.reads >= (o.cancelAfterReads as number) : undefined,
  };
  return { deps, calls, runsDir: deps.runsDir };
}

test('planFolder: actions and compact PlanRow shape', async () => {
  const f = fakes(4, {
    owned: [20],
    unreadable: [3],
    matches: { C1: [cand(10, 0.95), cand(11, 0.5), cand(12, 0.4), cand(13, 0.3)], C2: [cand(20, 0.95)], C4: [cand(40, 0.6, false)] },
  });
  const r = await planFolder({ dir: '/nas' }, f.deps);
  assert.deepEqual(r.plans.map(p => p.action), ['add', 'already-owned', 'skip-unreadable', 'review']);
  assert.deepEqual(r.summary, { groups: 4, add: 1, alreadyOwned: 1, review: 1, unreadable: 1 });
  assert.equal(r.capReached, false);
  assert.equal(r.remaining, 0);
  const row = r.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['action', 'best', 'candidates', 'catnoExact', 'files', 'groupId', 'images', 'read', 'reason', 'videos']);
  assert.equal(row.best, 10);
  assert.equal(row.catnoExact, true);
  assert.equal(row.candidates.length, 3);
  assert.equal(row.candidates[0].formats.length, 3);
  assert.deepEqual(Object.keys(row.candidates[0]).sort(), ['catno', 'formats', 'label', 'reasons', 'releaseId', 'score', 'title', 'year']);
  assert.deepEqual(row.read, { artist: 'Artist 1', title: 'Title 1', label: 'Lab', catno: 'C1', year: null });
  assert.equal(r.rows[2].read, null);
  assert.equal(r.rows[3].catnoExact, false);
  // full plan saved
  const saved = JSON.parse(readFileSync(join(f.runsDir, `${r.planId}-plan.json`), 'utf8'));
  assert.equal(saved.length, 4);
  assert.ok(saved[0].reads && saved[0].group);
  assert.ok(r.spentUsd > 0);
});

test('toPlanRow caps files at 8', () => {
  const g = { id: 'g-x', images: [img(1)], videos: Array.from({ length: 12 }, (_, i) => ({ ...img(i), kind: 'video' as const, name: `V${i}.mov` })), groupedBy: 'single' as const };
  const row = toPlanRow({ group: g, reads: [], candidates: [], best: null, action: 'skip-unreadable', reason: 'x' });
  assert.equal(row.files.length, 8);
  assert.equal(row.videos, 12);
});

test('cap stops before an uncached read and reports remaining', async () => {
  // each read bills $0.012; cap $0.02 lets one read through, then 0.012 + 0.012 > 0.02
  const f = fakes(3, { capUsd: 0.02, matches: { C1: [cand(10, 0.95)] } });
  const r = await planFolder({ dir: '/nas' }, f.deps);
  assert.equal(f.calls.reads, 1);
  assert.equal(r.capReached, true);
  assert.equal(r.cancelled, false);
  assert.equal(r.remaining, 2);
  assert.equal(r.rows.length, 1);
  assert.ok(r.spentUsd <= 0.02);
});

test('cached reads pass the cap check for free', async () => {
  const f = fakes(3, { capUsd: 0.001, cached: [1, 2, 3] });
  const r = await planFolder({ dir: '/nas' }, f.deps);
  assert.equal(r.capReached, false);
  assert.equal(r.plans.length, 3);
  assert.equal(r.spentUsd, 0);
  assert.equal(r.cost.cachedCalls, 3);
});

test('cancel returns partial rows', async () => {
  const f = fakes(4, { cancelAfterReads: 2 });
  const r = await planFolder({ dir: '/nas' }, f.deps);
  assert.equal(r.cancelled, true);
  assert.equal(r.rows.length, 2);
  assert.equal(r.remaining, 2);
  assert.ok(existsSync(join(f.runsDir, `${r.planId}-plan.json`)));
});

test('progress is reported', async () => {
  const f = fakes(2);
  const seen: string[] = [];
  await planFolder({ dir: '/nas' }, { ...f.deps, onProgress: p => seen.push(p.phase) });
  assert.ok(seen.includes('scanning') && seen.includes('reading') && seen.includes('matching'));
});

test('estimateFolder makes no model calls and counts cached vs uncached', async () => {
  const f = fakes(5, { cached: [1, 2] });
  const e = await estimateFolder({ dir: '/nas' }, f.deps);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.search, 0);
  assert.equal(e.groups, 5);
  assert.equal(e.images, 5);
  assert.equal(e.videos, 0);
  assert.equal(e.cachedReads, 2);
  assert.equal(e.uncachedReads, 3);
  assert.ok(e.perReadUsd > 0);
  assert.ok(Math.abs(e.estUsd - 3 * e.perReadUsd) < 1e-9);
  assert.equal(typeof e.model, 'string');
});

test('estimateFolder honours limit', async () => {
  const f = fakes(5);
  const e = await estimateFolder({ dir: '/nas', limit: 2 }, f.deps);
  assert.equal(e.groups, 2);
  assert.equal(e.uncachedReads, 2);
});

test('applyPlan skips already-owned, journals, and notes only added records', async () => {
  const f = fakes(2, { matches: { C1: [cand(10, 0.95)], C2: [cand(20, 0.95)] } });
  const plan = await planFolder({ dir: '/nas' }, f.deps);
  // 20 became owned after planning
  const deps2 = fakes(2, { owned: [20] });
  const deps = { ...f.deps, client: deps2.deps.client };
  const a = await applyPlan({ planId: plan.planId, items: [{ groupId: plan.rows[0].groupId, releaseId: 10 }, { groupId: plan.rows[1].groupId, releaseId: 20 }], notes: true }, deps);
  assert.deepEqual(a.applied.map(x => x.releaseId), [10]);
  assert.deepEqual(a.skipped, [{ groupId: plan.rows[1].groupId, releaseId: 20, reason: 'already in collection' }]);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(deps2.calls.added, [10]);
  assert.deepEqual(deps2.calls.notes, [10]);
  assert.match(a.journal, /^[\w.-]+-applied[\w.-]*\.jsonl$/);
  const lines = readFileSync(join(f.runsDir, a.journal), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines, [{ releaseId: 10, folderId: 1, instanceId: a.applied[0].instanceId, group: plan.rows[0].groupId }]);
});

test('applyPlan without notes writes none; unknown group is an error; bad plan id throws', async () => {
  const f = fakes(1, { matches: { C1: [cand(10, 0.95)] } });
  const plan = await planFolder({ dir: '/nas' }, f.deps);
  const a = await applyPlan({ planId: plan.planId, items: [{ groupId: plan.rows[0].groupId, releaseId: 10 }, { groupId: 'g-nope', releaseId: 11 }] }, f.deps);
  assert.equal(a.applied.length, 1);
  assert.equal(a.errors.length, 1);
  assert.equal(f.calls.notes.length, 0);
  await assert.rejects(applyPlan({ planId: '../evil', items: [] }, f.deps), /Invalid plan id/);
});

test('same release twice in one batch adds once', async () => {
  const f = fakes(2, { matches: { C1: [cand(10, 0.95)], C2: [cand(10, 0.95)] } });
  const plan = await planFolder({ dir: '/nas' }, f.deps);
  const a = await applyPlan({ planId: plan.planId, items: plan.rows.map(r => ({ groupId: r.groupId, releaseId: 10 })) }, f.deps);
  assert.equal(a.applied.length, 1);
  assert.equal(a.skipped.length, 1);
});

test('notesFor stays within 250 chars', () => {
  const g = { id: 'g', images: Array.from({ length: 30 }, (_, i) => img(i)), videos: [], groupedBy: 'single' as const };
  assert.ok(notesFor(g).length <= 250);
  assert.ok(notesFor(g).startsWith('HITLOOP ingest'));
});

test('undoApply removes journaled instances', async () => {
  const f = fakes(1);
  const name = '2026-x-applied-2026.jsonl';
  mkdirSync(f.runsDir, { recursive: true });
  writeFileSync(join(f.runsDir, name), [
    JSON.stringify({ releaseId: 10, folderId: 1, instanceId: 101, group: 'g-a' }),
    JSON.stringify({ releaseId: 11, folderId: 1, instanceId: 102, group: 'g-b' }),
  ].join('\n') + '\n');
  const u = await undoApply({ journal: name }, f.deps);
  assert.deepEqual(u.removed, [{ groupId: 'g-a', releaseId: 10, instanceId: 101 }, { groupId: 'g-b', releaseId: 11, instanceId: 102 }]);
  assert.deepEqual(u.errors, []);
  assert.deepEqual(f.calls.removed, [101, 102]);
});

test('undoApply rejects bad journal names and path escape', async () => {
  const f = fakes(1);
  for (const bad of ['evil.jsonl', '../x-applied.jsonl', 'sub/x-applied.jsonl', '/etc/x-applied.jsonl', 'x-applied.json', 'x-plan.json', '..']) {
    await assert.rejects(undoApply({ journal: bad }, f.deps), /Invalid journal name|escapes/, bad);
  }
  assert.deepEqual(f.calls.removed, []);
  assert.deepEqual(readdirSync(join(f.runsDir, '..')).filter(n => n.endsWith('.jsonl')), []);
});
