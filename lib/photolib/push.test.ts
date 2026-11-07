import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeClient, pushHashOf, runPush, toLifeItem } from './push';
import type { Sidecar } from './types';

const SRC = { id: 'photos-drive-1', kind: 'photos' as const, label: 'Drive 1', libraryPath: 'Drive 1/Photos Library.photoslibrary' };
const dir = mkdtempSync(join(tmpdir(), 'photolib-push-'));
const noSleep = async () => undefined;

function sidecar(n: number, extra: Partial<Sidecar> = {}): Sidecar {
  const sha = n.toString(16).padStart(4, '0').padEnd(64, 'a');
  return {
    schema: 'photolib.sidecar/1', sha256: sha, id: sha.slice(0, 16), kind: 'image', ext: 'jpg', sizeBytes: 10, width: 4, height: 3, durationSec: null,
    takenLocal: '2018-06-21T23:19:38', tz: '-04:00', tzOffsetSec: -14400, tsUtc: '2018-06-22T03:19:38.000Z', tsSource: 'library-db', tsKind: 'exact',
    gps: null, canonicalPath: `HITLOOP-ARCHIVE/timeline/2018/06/x${n}.jpg`, albums: ['A'], favorite: false, hidden: false, title: null, description: null, keywords: [],
    camera: null, children: { motion: { sha256: 'b'.repeat(64), ext: 'mov', sizeBytes: 5, durationSec: 1.5, canonicalPath: 'HITLOOP-ARCHIVE/timeline/m.mov', sourceRelativePath: 'Masters/x.mov' } },
    locations: [{ sourceId: 'photos-drive-1', libraryKind: 'photos', libraryPath: 'Drive 1/L.photoslibrary', relativePath: 'Masters/a.jpg', masterUuid: 'u', versionUuid: null, originalFileName: 'IMG_1.JPG' }],
    createdAt: 'x', updatedAt: 'x', ...extra,
  };
}

function rowFor(n: number, pushHash: string | null = null) {
  const sc = sidecar(n);
  const s = join(dir, `${sc.id}_s.jpg`), m = join(dir, `${sc.id}_m.jpg`);
  writeFileSync(s, 'ss'); writeFileSync(m, 'mmm');
  return { sha256: sc.sha256, id: sc.id, sidecarJson: JSON.stringify(sc), thumbS: s, thumbM: m, pushHash };
}

function fakeClient(over: { skip?: string[]; failResults?: boolean } = {}) {
  const calls = { upload: [] as any[], results: [] as any[] };
  return {
    calls,
    client: {
      uploadUrls: async (items: any[]) => {
        calls.upload.push(items);
        return items.map(i => ({ sha256: i.sha256, variant: i.variant, storagePath: `life-thumbs/${i.sha256.slice(0, 16)}_${i.variant}.jpg`, uploadUrl: `https://up/${i.sha256.slice(0, 16)}/${i.variant}`, headers: { 'content-type': 'image/jpeg' } }));
      },
      results: async (body: any) => {
        calls.results.push(body);
        if (over.failResults) throw new Error('results 500');
        return { ok: true, upserted: body.items.length, skipped: body.items.filter((i: any) => over.skip?.includes(i.id)).map((i: any) => ({ id: i.id, reason: 'bad' })) };
      },
    },
  };
}

function fakeManifest(rows: ReturnType<typeof rowFor>[]) {
  const pushed: [string, string][] = [];
  return { pushed, listAssets: (o: any) => { (fakeManifest as any).last = o; return rows; }, markPushed: (s: string, h: string) => { pushed.push([s, h]); } };
}

test('toLifeItem maps the sidecar with contract shape and no absolute paths', () => {
  const sc = sidecar(1);
  const it = toLifeItem(sc, { s: `life-thumbs/${sc.id}_s.jpg`, m: `life-thumbs/${sc.id}_m.jpg` });
  assert.equal(it.id, it.sha256.slice(0, 16));
  assert.deepEqual(it.motion, { sha256: 'b'.repeat(64), durationSec: 1.5 });
  assert.equal(it.edited, null);
  assert.deepEqual(it.locations, [{ sourceId: 'photos-drive-1', relativePath: 'Masters/a.jpg', originalFileName: 'IMG_1.JPG' }]);
  assert.deepEqual(it.thumbs, { s: `life-thumbs/${sc.id}_s.jpg`, m: `life-thumbs/${sc.id}_m.jpg` });
  assert.ok(!JSON.stringify(it).includes('/Volumes'));
  assert.ok(it.canonicalPath.startsWith('HITLOOP-ARCHIVE/timeline/'));
  assert.ok(!('sizeBytes' in it) && !('tzOffsetSec' in it) && !('createdAt' in it));
  assert.equal(toLifeItem(sc, null).thumbs, null);
});

test('runPush: uploads 2 thumbs per item, posts results, marks pushed', async () => {
  const { client, calls } = fakeClient();
  const m = fakeManifest([rowFor(1), rowFor(2)]);
  const puts: { url: string; headers: any; len: number }[] = [];
  const fetchImpl = (async (url: string, init: any) => { puts.push({ url, headers: init.headers, len: init.body.length }); return new Response('', { status: 200 }); }) as unknown as typeof fetch;
  const r = await runPush({ manifest: m, client, source: SRC, fetchImpl, sleep: noSleep });
  assert.equal(r.pushed, 2); assert.equal(r.uploaded, 4); assert.deepEqual(r.errors, []);
  assert.equal(calls.upload[0].length, 4);
  assert.deepEqual(Object.keys(calls.upload[0][0]).sort(), ['contentType', 'sha256', 'sizeBytes', 'variant']);
  assert.equal(calls.upload[0][0].sizeBytes, 2);
  assert.equal(puts[0].headers['content-type'], 'image/jpeg');
  assert.equal(puts[0].headers['content-length'], '2');
  assert.deepEqual(calls.results[0].source, SRC);
  const item = calls.results[0].items[0];
  assert.equal(item.thumbs.s, `life-thumbs/${item.id}_s.jpg`);
  assert.equal(m.pushed.length, 2);
  assert.equal(m.pushed[0][1], pushHashOf(item));
  assert.equal((fakeManifest as any).last.withThumbs, true);
});

test('runPush: chunks at 100 items / 200 urls', async () => {
  const { client, calls } = fakeClient();
  const rows = Array.from({ length: 205 }, (_, i) => rowFor(i + 1));
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  const r = await runPush({ manifest: fakeManifest(rows), client, source: SRC, fetchImpl, sleep: noSleep });
  assert.equal(r.pushed, 205);
  assert.deepEqual(calls.results.map(c => c.items.length), [100, 100, 5]);
  assert.deepEqual(calls.upload.map(c => c.length), [200, 200, 10]);
});

test('runPush: unchanged rows skipped unless force; rows without thumbs ignored', async () => {
  const sc = sidecar(1);
  const hash = pushHashOf(toLifeItem(sc, { s: `life-thumbs/${sc.id}_s.jpg`, m: `life-thumbs/${sc.id}_m.jpg` }));
  const noThumbs = { ...rowFor(2), thumbS: null, thumbM: null };
  const a = fakeClient();
  const r1 = await runPush({ manifest: fakeManifest([rowFor(1, hash), noThumbs as any]), client: a.client, source: SRC, sleep: noSleep });
  assert.equal(r1.pushed, 0); assert.equal(a.calls.results.length, 0);
  const b = fakeClient();
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  const m = fakeManifest([rowFor(1, hash)]);
  const r2 = await runPush({ manifest: m, client: b.client, source: SRC, force: true, fetchImpl, sleep: noSleep });
  assert.equal(r2.pushed, 1);
  assert.equal((fakeManifest as any).last.withThumbs, true);
});

test('runPush: server-skipped items are reported and not marked pushed; failures leave rows unmarked', async () => {
  const rows = [rowFor(1), rowFor(2)];
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  const a = fakeClient({ skip: [rows[0].id] });
  const m = fakeManifest(rows);
  const r = await runPush({ manifest: m, client: a.client, source: SRC, fetchImpl, sleep: noSleep });
  assert.deepEqual(r.skipped, [{ id: rows[0].id, reason: 'bad' }]);
  assert.equal(r.pushed, 1); assert.equal(m.pushed[0][0], rows[1].sha256);
  const b = fakeClient({ failResults: true });
  const m2 = fakeManifest([rowFor(3)]);
  const r2 = await runPush({ manifest: m2, client: b.client, source: SRC, fetchImpl, sleep: noSleep });
  assert.equal(r2.pushed, 0); assert.equal(m2.pushed.length, 0); assert.match(r2.errors[0].error, /results 500/);
});

test('runPush: PUT retries on 503 then succeeds; 4xx fails without retry', async () => {
  let n = 0;
  const flaky = (async () => new Response('', { status: ++n <= 2 ? 503 : 200 })) as unknown as typeof fetch;
  const { client } = fakeClient();
  const r = await runPush({ manifest: fakeManifest([rowFor(1)]), client, source: SRC, fetchImpl: flaky, sleep: noSleep });
  assert.equal(r.pushed, 1); assert.equal(n, 4); // 2 fails + success for s, success for m
  let k = 0;
  const bad = (async () => { k++; return new Response('', { status: 403 }); }) as unknown as typeof fetch;
  const r2 = await runPush({ manifest: fakeManifest([rowFor(2)]), client, source: SRC, fetchImpl: bad, sleep: noSleep });
  assert.equal(k, 1); assert.equal(r2.pushed, 0); assert.equal(r2.errors.length, 1);
});

test('runPush: honours cancellation between chunks', async () => {
  const { client, calls } = fakeClient();
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  let cancel = false;
  const rows = Array.from({ length: 150 }, (_, i) => rowFor(i + 1));
  const r = await runPush({ manifest: fakeManifest(rows), client, source: SRC, fetchImpl, sleep: noSleep, isCancelled: () => cancel, onProgress: () => { cancel = true; } });
  assert.equal(r.cancelled, true); assert.equal(calls.results.length, 1);
});

test('LifeClient: bearer + JSON, retries 503, throws status + body on failure', async () => {
  const seen: any[] = [];
  let n = 0;
  const f = (async (url: string, init: any) => {
    seen.push({ url, init });
    if (++n === 1) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ urls: [{ sha256: 'a' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new LifeClient('https://h.example/', 'tok', f, noSleep);
  const urls = await c.uploadUrls([{ sha256: 'a', variant: 's', contentType: 'image/jpeg', sizeBytes: 1 }]);
  assert.equal(urls.length, 1); assert.equal(n, 2);
  assert.equal(seen[0].url, 'https://h.example/api/archive/worker/life/upload-urls');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  const bad = new LifeClient('https://h.example', 't', (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch, noSleep);
  await assert.rejects(bad.results({ source: SRC, items: [] }), /401 nope/);
});

test('runPush: an already-pushed asset whose sidecar changed is re-sent; unchanged is not', async () => {
  const sc = sidecar(1);
  const thumbs = { s: `life-thumbs/${sc.id}_s.jpg`, m: `life-thumbs/${sc.id}_m.jpg` };
  const oldHash = pushHashOf(toLifeItem(sc, thumbs));
  const changed = sidecar(1, { locations: [...sc.locations, { ...sc.locations[0], relativePath: 'Masters/b.jpg' }] });
  const row = { ...rowFor(1, oldHash), sidecarJson: JSON.stringify(changed) };
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  const a = fakeClient(); const m = fakeManifest([row]);
  const r = await runPush({ manifest: m, client: a.client, source: SRC, fetchImpl, sleep: noSleep });
  assert.equal(r.pushed, 1);
  assert.equal(a.calls.results[0].items[0].locations.length, 2);
  assert.notEqual(m.pushed[0][1], oldHash);
});

test('toLifeItem truncates to server caps', () => {
  const loc = (i: number) => ({ sourceId: 's'.repeat(100), libraryKind: 'photos' as const, libraryPath: 'L', relativePath: `Masters/${i}.jpg`, masterUuid: null, versionUuid: null, originalFileName: 'f'.repeat(400) });
  const sc = sidecar(1, {
    title: 't'.repeat(500), description: 'd'.repeat(3000), albums: Array.from({ length: 150 }, (_, i) => `a${i}`.padEnd(300, 'x')),
    keywords: Array.from({ length: 300 }, (_, i) => `k${i}`), camera: { make: 'm'.repeat(200), model: null }, locations: Array.from({ length: 60 }, (_, i) => loc(i)),
  });
  const it = toLifeItem(sc, null);
  assert.equal(it.title!.length, 300); assert.equal(it.description!.length, 2000);
  assert.equal(it.albums.length, 100); assert.ok(it.albums.every(a => a.length <= 200));
  assert.equal(it.keywords.length, 200);
  assert.equal(it.camera!.make!.length, 100);
  assert.equal(it.locations.length, 50);
  assert.equal(it.locations[0].sourceId.length, 80); assert.equal(it.locations[0].originalFileName.length, 300);
});

test('runPush: item is only sent/marked when BOTH thumb PUTs succeed', async () => {
  const rows = [rowFor(1), rowFor(2)];
  const bad = rows[0].id;
  const fetchImpl = (async (url: string) => new Response('', { status: url.includes(`${bad}/m`) ? 403 : 200 })) as unknown as typeof fetch;
  const a = fakeClient(); const m = fakeManifest(rows);
  const r = await runPush({ manifest: m, client: a.client, source: SRC, fetchImpl, sleep: noSleep });
  assert.equal(r.pushed, 1);
  assert.deepEqual(a.calls.results[0].items.map((i: any) => i.id), [rows[1].id]);
  assert.deepEqual(m.pushed.map(p => p[0]), [rows[1].sha256]);
  assert.equal(r.errors.length, 1); assert.equal(r.errors[0].id, bad);
});
