import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyRenames, plannedNames, releaseNameParts, slug, undoRenames } from './rename';
import type { DiscogsCandidate, MediaFile, RecordGroup } from './types';

const cand = (title: string, catno: string): DiscogsCandidate => ({
  releaseId: 1, title, catno, label: 'L', formats: ['Vinyl'], country: null, year: null, score: 0.9, reasons: [],
});

const mf = (p: string, kind: 'image' | 'video', capturedAt: string): MediaFile => ({
  path: p, name: path.basename(p), kind, size: 1, fingerprint: p, capturedAt, mtime: capturedAt, seq: null, duplicateOf: null,
});

test('slug', () => {
  assert.equal(slug('GDR•004'), 'GDR-004');
  assert.equal(slug('The Jump? Skip! EP.'), 'The-Jump-Skip-EP');
  assert.equal(slug('Café Del Mar & Friends'), 'Cafe-Del-Mar-and-Friends');
});

test('releaseNameParts', () => {
  assert.deepEqual(releaseNameParts(cand('G U* & Cei-Bei - House Music Will Never Die', 'X 1 / Y 2')),
    { catno: 'X 1', artist: 'G U & Cei-Bei', title: 'House Music Will Never Die' });
  const r = releaseNameParts(cand('Roger Sanchez Presents Twilight (7) - I Want Your Love', 'A1, B2'));
  assert.equal(r.artist, 'Roger Sanchez Presents Twilight');
  assert.equal(r.catno, 'A1');
});

const dir = '/n/dir';
const group: RecordGroup = {
  id: 'g-1', groupedBy: 'capture-time',
  images: [mf(`${dir}/IMG_2.JPG`, 'image', '2024-01-01T10:00:05Z'), mf(`${dir}/IMG_1.HEIC`, 'image', '2024-01-01T10:00:00Z')],
  videos: [mf(`${dir}/V3.MOV`, 'video', '2024-01-01T10:02:00Z'), mf(`${dir}/V1.MOV`, 'video', '2024-01-01T10:00:30Z'), mf(`${dir}/V2.MOV`, 'video', '2024-01-01T10:01:00Z')],
};

test('plannedNames ordering and idempotence', () => {
  const best = cand('Blue Boy - Scattered Emotions EP', 'GDR•004');
  const p = plannedNames(group, best);
  const base = 'GDR-004_Blue-Boy_Scattered-Emotions-EP';
  assert.deepEqual(p.map((x) => x.to), [
    `${dir}/${base}_label1.heic`, `${dir}/${base}_label2.jpg`,
    `${dir}/${base}_video1.mov`, `${dir}/${base}_video2.mov`, `${dir}/${base}_video3.mov`,
  ]);
  assert.equal(p[0].from, `${dir}/IMG_1.HEIC`);
  // already renamed -> nothing to do
  const renamedGroup: RecordGroup = {
    ...group,
    images: group.images.map((f, i) => mf(p[1 - i === 0 ? 0 : 1].to, 'image', f.capturedAt!)),
    videos: [],
  };
  assert.equal(plannedNames({ ...renamedGroup, images: [mf(p[0].to, 'image', '2024-01-01T10:00:00Z'), mf(p[1].to, 'image', '2024-01-01T10:00:05Z')] }, best).length, 0);
});

test('long names truncate to <=100 base chars', () => {
  const p = plannedNames({ ...group, videos: [], images: [group.images[0]] }, cand(`${'Artist '.repeat(10)}- ${'Title '.repeat(20)}`, 'CAT1'));
  const base = path.basename(p[0].to).replace(/_label1\.jpg$/, '');
  assert.ok(base.length <= 100);
});

test('fs round trip: apply, collision suffix, undo', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
  const journal = path.join(tmp, 'journal.jsonl');
  const a = path.join(tmp, 'a.jpg'), b = path.join(tmp, 'b.jpg');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'B');
  const to = path.join(tmp, 'X_label1.jpg');
  const r = await applyRenames([
    { from: a, to }, { from: b, to }, { from: path.join(tmp, 'nope.jpg'), to: path.join(tmp, 'z.jpg') },
  ], journal);
  assert.equal(r.renamed, 2);
  assert.equal(r.skipped.length, 1);
  assert.equal(fs.readFileSync(to, 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(tmp, 'X_label1-2.jpg'), 'utf8'), 'B');
  assert.equal(fs.readFileSync(journal, 'utf8').trim().split('\n').length, 2);
  const u = await undoRenames(journal);
  assert.equal(u.restored, 2);
  assert.equal(fs.readFileSync(a, 'utf8'), 'A');
  assert.equal(fs.readFileSync(b, 'utf8'), 'B');
  assert.ok(!fs.existsSync(to));
  fs.rmSync(tmp, { recursive: true });
});
