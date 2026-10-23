import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPaths, loadPlansNewestFirst, readPublished, recordPublished, uploadAndDraft, hitloop, type Hitloop, type Prepared } from './publish-run';

const home = () => mkdtempSync(join(tmpdir(), 'discogs-pub-'));

test('publishPaths puts every state file under home', () => {
  const p = publishPaths('/x/home');
  assert.equal(p.published, '/x/home/published.json');
  assert.equal(p.runs, '/x/home/runs');
  assert.equal(p.srcCache, '/x/home/src');
});

test('loadPlansNewestFirst: newest plan file first, missing dir is empty', () => {
  const p = publishPaths(home());
  assert.deepEqual(loadPlansNewestFirst(p.runs), []);
  mkdirSync(p.runs, { recursive: true });
  writeFileSync(join(p.runs, '2026-01-01T00-00-00-000Z-plan.json'), JSON.stringify([{ group: { id: 'g-old' } }]));
  writeFileSync(join(p.runs, '2026-02-01T00-00-00-000Z-plan.json'), JSON.stringify([{ group: { id: 'g-new' } }]));
  writeFileSync(join(p.runs, '2026-02-01T00-00-00-000Z-applied.jsonl'), '');
  assert.deepEqual(loadPlansNewestFirst(p.runs).map(x => x.group.id), ['g-new', 'g-old']);
});

test('recordPublished upserts one entry per release and persists', () => {
  const p = publishPaths(home());
  const list = readPublished(p);
  assert.deepEqual(list, []);
  const clip = { start: 0, end: 60, look: 'rich-plus' };
  recordPublished(p, list, { releaseId: 1, postId: 'a', packageId: 'discogs-1', at: 't1', clip });
  recordPublished(p, list, { releaseId: 2, postId: 'b', packageId: 'discogs-2', at: 't2', clip });
  recordPublished(p, list, { releaseId: 1, postId: 'a2', packageId: 'discogs-1', at: 't3', clip });
  const onDisk = JSON.parse(readFileSync(p.published, 'utf8'));
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk.find((x: any) => x.releaseId === 1).postId, 'a2');
});

test('hitloop() refuses to start without the control URL + token', () => {
  assert.throws(() => hitloop({}), /HITLOOP_ARCHIVE_CONTROL_URL/);
});

test('uploadAndDraft: four uploads (upload-url + PUT each) then one draft; entry carries the clip', async () => {
  const dir = home();
  const files = { '9x16': join(dir, 'c9.mp4'), '1x1': join(dir, 'c1.mp4') } as const;
  const imgs = { '9x16': join(dir, 'l9.jpg'), '1x1': join(dir, 'l1.jpg') } as const;
  for (const f of [...Object.values(files), ...Object.values(imgs)]) writeFileSync(f, 'x');
  const calls: { path: string; body: any }[] = [];
  const puts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { puts.push(String(url)); assert.equal(init.method, 'PUT'); return new Response('', { status: 200 }); }) as any;
  try {
    const h: Hitloop = {
      post: async <T>(path: string, body: unknown) => {
        calls.push({ path, body });
        if (path === 'discogs/upload-url') { const b = body as any; return { uploadUrl: `https://up/${b.kind}-${b.variant}`, storagePath: `publish-staging/discogs/7/${b.kind}-${b.variant}` } as T; }
        return { postId: 'post_7', packageId: 'discogs-7', created: true } as T;
      },
    };
    const prepared = {
      facts: { artist: 'A', title: 'T', label: 'L', catno: 'C1', year: '1999', url: 'https://www.discogs.com/release/7', genres: [], styles: [], tracks: [] },
      clipPaths: files, imagePaths: imgs, clip: { start: 10, end: 70, look: 'rich-plus' },
      videoName: 'v.MOV', imageName: 'l.heic', clipBytes: { '9x16': 1, '1x1': 1 }, clipSeconds: 60, imageBytes: { '9x16': 1, '1x1': 1 },
      reason: 'r', videoFraming: {} as any, imageFraming: {} as any, timings: {},
    } as unknown as Prepared;
    const rec = { releaseId: 7, plan: {} as any, group: { images: [], videos: [] } as any };
    const { entry, draft } = await uploadAndDraft(h, rec, prepared, '1x1');
    assert.equal(calls.filter(c => c.path === 'discogs/upload-url').length, 4);
    assert.equal(puts.length, 4);
    assert.equal(calls.at(-1)!.path, 'discogs/draft');
    assert.equal(draft.postId, 'post_7');
    assert.deepEqual({ releaseId: entry.releaseId, postId: entry.postId, packageId: entry.packageId, clip: entry.clip }, { releaseId: 7, postId: 'post_7', packageId: 'discogs-7', clip: { start: 10, end: 70, look: 'rich-plus' } });
  } finally {
    globalThis.fetch = realFetch;
  }
});
