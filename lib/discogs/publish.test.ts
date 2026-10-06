import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseFacts, cleanName, selectEligible, unreportedCost, stripEmoji, buildDraftBody, type VariantPaths } from './publish.ts';
import type { GroupPlan, RecordGroup } from './types.ts';
import type { CostLogLine } from './cost.ts';

test('cleanName strips * and (N)', () => {
  assert.equal(cleanName('Lith (3)'), 'Lith');
  assert.equal(cleanName('Kojak*'), 'Kojak');
  assert.equal(cleanName('Some Label (12)'), 'Some Label');
});

test('releaseFacts normalises a release', () => {
  const f = releaseFacts({ id: 74379, uri: 'https://www.discogs.com/release/74379-x', title: ' Fairy Tale ', year: 1998,
    artists: [{ name: 'Lith (2)' }, { name: 'De Lanka*' }], labels: [{ name: 'Defected (3)', catno: 'DT-117' }] });
  assert.deepEqual(f, { releaseId: 74379, discogsUrl: 'https://www.discogs.com/release/74379-x', artist: 'Lith, De Lanka',
    title: 'Fairy Tale', label: 'Defected', catno: 'DT-117', year: '1998' });
  assert.equal(releaseFacts({ id: 1, year: 0, artists: [], labels: [] }).year, null);
});

const mf = (n: string, kind: 'image' | 'video') => ({ path: '/x/' + n, name: n, kind, size: 1, fingerprint: 'fp-' + n,
  capturedAt: null, mtime: '', seq: null, duplicateOf: null }) as any;
const grp = (id: string, vids = 1): RecordGroup => ({ id, images: [mf(id + 'i', 'image')],
  videos: Array.from({ length: vids }, (_, i) => mf(id + 'v' + i, 'video')), groupedBy: 'single' });
const plan = (g: RecordGroup, releaseId: number, action = 'add', reasons = ['catno exact']): GroupPlan => ({
  group: g, reads: [], candidates: [], best: { releaseId, title: '', catno: '', label: '', formats: [], country: null, year: null, score: 0.9, reasons },
  action: action as any, reason: '' });

test('selectEligible: confident only, skips published, reports no-video', () => {
  const a = grp('g-a'), b = grp('g-b'), c = grp('g-c', 0), d = grp('g-d'), e = grp('g-e');
  const plans = [plan(a, 1), plan(b, 2), plan(c, 3), plan(d, 4, 'review'), plan(e, 5, 'add', ['vinyl'])];
  const r = selectEligible([a, b, c, d, e], plans, new Set([2]));
  assert.deepEqual(r.eligible.map(x => x.releaseId), [1]);
  assert.deepEqual(r.noVideo.map(x => x.releaseId), [3]);
  assert.deepEqual(r.alreadyPublished, [2]);
  assert.deepEqual(selectEligible([a, b], plans, new Set([2]), { force: true }).eligible.map(x => x.releaseId), [1, 2]);
  assert.deepEqual(selectEligible([a, b], plans, new Set(), { release: 2 }).eligible.map(x => x.releaseId), [2]);
});

test('selectEligible: newest plan wins; fingerprint fallback when group id shifted', () => {
  const a = grp('g-a');
  const newer = plan(a, 10), older = plan(a, 99);
  assert.equal(selectEligible([a], [newer, older], new Set()).eligible[0].releaseId, 10);
  const shifted: RecordGroup = { ...a, id: 'g-other' };
  assert.equal(selectEligible([shifted], [newer], new Set()).eligible[0].releaseId, 10);
});

const line = (runId: string, folder: string, billed: number, usd: number): CostLogLine => ({ at: '', runId, folder, calls: billed, billedCalls: billed,
  cachedCalls: 0, inputTokens: billed * 100, outputTokens: billed * 10, usd, unknownModelCalls: 0, byModel: {} });

test('unreportedCost sums only unreported lines of this folder', () => {
  const lines = [line('r1', '/f', 4, 0.04), line('r2', '/f', 0, 0), line('r3', '/other', 9, 1), line('r4', '/f', 2, 0.02)];
  const r = unreportedCost(lines, '/f', new Set(['r1']))!;
  assert.deepEqual(r.runIds, ['r2', 'r4']);
  assert.equal(r.calls, 2);
  assert.equal(r.costUsd, 0.02);
  assert.equal(unreportedCost(lines, '/nope', new Set()), null);
  assert.equal(unreportedCost(lines, '/f', new Set(['r1', 'r2', 'r4'])), null);
});

test('stripEmoji removes pictographs and keeps text', () => {
  assert.equal(stripEmoji('Deep Touch \u{1F525} Records'), 'Deep Touch Records');
  assert.equal(stripEmoji('Plain Name (2)'), 'Plain Name (2)');
});

test('buildDraftBody keeps legacy paths = X variant and carries all four variants', () => {
  const v: VariantPaths = {
    video: { '9x16': 'p/video-9x16.mp4', '1x1': 'p/video-1x1.mp4' },
    image: { '9x16': 'p/image-9x16.jpg', '1x1': 'p/image-1x1.jpg' },
  };
  const facts = { releaseId: 1, discogsUrl: 'u', artist: 'A \u{1F3B5}', title: 'T', label: 'L', catno: 'C-1', year: null };
  const extra = { files: { images: ['i'], videos: ['v'] }, clip: { start: 1, end: 61 } };
  const b = buildDraftBody(facts, v, '1x1', extra);
  assert.equal(b.videoStoragePath, 'p/video-1x1.mp4');
  assert.equal(b.imageStoragePath, 'p/image-1x1.jpg');
  assert.deepEqual(b.variants, v);
  assert.equal(b.artist, 'A');
  assert.equal(buildDraftBody(facts, v, '9x16', extra).videoStoragePath, 'p/video-9x16.mp4');
});
