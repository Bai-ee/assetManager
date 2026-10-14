import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { sanitizeAnalysis, groundPeople, TOOL } from './schema';
import { cacheKey, callCostUsd, estimateCallUsd, estimateRun, withinCap, ratesFor } from './cost';
import { corsHeaders, isValidSha, parseRange, createAnalyzerServer, isLoopbackHost } from './server';
import { runAnalyze, walkMedia } from './analyze';
import { runStage } from './stage';
import { AnalyzerDaemon } from './daemon';
import { makeVision } from './vision';
import { prepareMedia } from './media';
import { resolveUnder } from './store';
import type { Cmd } from './control';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-test-'));

test('people are kept only when grounded in ocrText or path', () => {
  const a = sanitizeAnalysis({
    people: ['DJ Rush', 'Jeff Mills', 'a man in a hat', 'dj', 'Someone Famous'],
    ocrText: 'LIVE: DJ RUSH + Jeff Mills', crews: ['Spiral Tribe'], peopleCount: 3.0,
  }, { relativePath: 'Flyers/1996/Someone Famous night.jpg' });
  assert.deepEqual(a.facets.people, ['DJ Rush', 'Jeff Mills', 'Someone Famous']);
  assert.deepEqual(groundPeople(['Jane Doe'], 'nothing here', 'a/b.jpg'), []);
});

test('sanitize clamps lengths, enums, jev values and confidence', () => {
  const a = sanitizeAnalysis({
    ocrText: 'x'.repeat(900), activity: 'y'.repeat(400), summary: 'z'.repeat(400), eraYear: 1853, peopleCount: -4,
    vibe: { light: 'purple', time: 'night', kind: 'nonsense', mood: ['a', 'b', 'c', 'd', 'e'] },
    jev: { pillar: { value: 'was-there', confidence: 7 }, series: { value: 'ZZ', confidence: 0.9 }, entities: { value: ['A', 'A', 'B'], confidence: 0.5 } },
  }, { relativePath: 'a.jpg' });
  assert.equal(a.facets.ocrText.length, 600);
  assert.equal(a.activity.length, 160);
  assert.equal(a.summary.length, 200);
  assert.equal(a.facets.eraYear, null);
  assert.equal(a.peopleCount, 0);
  assert.equal(a.facets.vibe.light, null);
  assert.equal(a.facets.vibe.kind, 'other');
  assert.equal(a.facets.vibe.mood.length, 4);
  assert.deepEqual(a.jev.pillar, { value: 'was-there', confidence: 1 });
  assert.deepEqual(a.jev.series, { value: null, confidence: 0 });
  assert.deepEqual(a.jev.entities?.value, ['A', 'B']);
  assert.deepEqual(Object.keys(TOOL.input_schema.properties.jev.properties).sort(), ['clientWork', 'entities', 'era', 'pillar', 'postability', 'series']);
});

test('cost and cap math', () => {
  assert.equal(callCostUsd('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 6);
  assert.throws(() => ratesFor('mystery-model'));
  const per = estimateCallUsd('claude-haiku-4-5-20251001');
  assert.ok(per > 0.005 && per < 0.02);
  assert.equal(estimateRun('claude-haiku-4-5', { images: 8, videos: 2, cached: 4 }).estUsd, Math.round(6 * per * 1e6) / 1e6);
  assert.equal(withinCap(0, 'claude-haiku-4-5', per), true);
  assert.equal(withinCap(per / 2, 'claude-haiku-4-5', per), false);
});

test('cache key varies by sha, prompt version and model', () => {
  const sha = 'a'.repeat(64);
  const k = cacheKey(sha, 'v1', 'm');
  assert.equal(k, cacheKey(sha, 'v1', 'm'));
  assert.notEqual(k, cacheKey(sha, 'v2', 'm'));
  assert.notEqual(k, cacheKey(sha, 'v1', 'm2'));
  assert.notEqual(k, cacheKey('b'.repeat(64), 'v1', 'm'));
});

test('CORS, sha and range validation', () => {
  assert.equal(corsHeaders('http://localhost:3001')['access-control-allow-origin'], 'http://localhost:3001');
  assert.equal(corsHeaders('https://hitloop.agency')['access-control-allow-origin'], 'https://hitloop.agency');
  assert.equal(corsHeaders('https://evil.example')['access-control-allow-origin'], undefined);
  assert.equal(isValidSha('a'.repeat(64)), true);
  for (const bad of ['../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '/x']) assert.equal(isValidSha(bad), false);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=200-300', 100), 'bad');
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(isLoopbackHost('evil.com:8777'), false);
  assert.equal(resolveUnder('/root', '../x'), null);
  assert.equal(resolveUnder('/root', '/etc/passwd'), null);
});

test('server: health, thumbs, media range, bad sha', async () => {
  const dir = tmp();
  const sha = 'c'.repeat(64);
  fs.mkdirSync(path.join(dir, 'thumbs'));
  fs.writeFileSync(path.join(dir, 'thumbs', `${sha}.jpg`), 'JPEGDATA');
  fs.writeFileSync(path.join(dir, 'clip.mp4'), '0123456789');
  const server = createAnalyzerServer({ workerId: 'w-analyzer', thumbDir: path.join(dir, 'thumbs'), store: { locate: s => (s === sha ? [{ sourceId: 's', rootPath: dir, relativePath: 'clip.mp4' }] : []) } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers })); }).on('error', reject);
  });
  try {
    assert.deepEqual(JSON.parse((await get('/health')).body), { ok: true, workerId: 'w-analyzer' });
    assert.equal((await get(`/thumbs/${sha}.jpg`, { origin: 'http://localhost:3000' })).headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal((await get('/thumbs/../../etc/passwd')).status, 404);
    const r = await get(`/media/${sha}`, { range: 'bytes=2-4' });
    assert.equal(r.status, 206); assert.equal(r.body, '234'); assert.equal(r.headers['content-range'], 'bytes 2-4/10');
    assert.equal((await get(`/media/${'d'.repeat(64)}`)).status, 404);
    assert.equal((await get('/media/not-a-sha')).status, 400);
    assert.equal((await get(`/media/${sha}`, { range: 'bytes=50-60' })).status, 416);
    assert.equal((await get('/health', { host: 'evil.com' })).status, 403);
  } finally { server.close(); }
});

function fakeSetup(files: Record<string, string>) {
  const root = tmp();
  for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); }
  const home = tmp();
  const updates: any[] = [], pushed: any[] = [];
  let visionCalls = 0;
  const deps = {
    store: { getSource: (id: string) => (id === 's1' ? { id, label: 'nas', rootPath: root } : undefined), knownFile: () => undefined },
    control: { update: async (u: any) => { updates.push(u); }, pushResults: async (_s: string, items: any[]) => { pushed.push(...items); } },
    vision: async () => { visionCalls++; return { raw: { people: ['Jeff Mills'], ocrText: 'Jeff Mills live', summary: 'a flyer', jev: { pillar: { value: 'was-there', confidence: 0.8 } } }, usage: { inputTokens: 2000, outputTokens: 500 } }; },
    prepare: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 100, height: 50 }),
    isCancelled: () => false,
    cacheDir: path.join(home, 'cache'), thumbDir: path.join(home, 'thumbs'), ledgerPath: path.join(home, 'cost.jsonl'),
    hashFile: async (p: string) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
  };
  return { root, home, updates, pushed, deps, calls: () => visionCalls };
}

test('walkMedia is media-only, skips dotfiles, rejects escapes', () => {
  const { root } = fakeSetup({ 'a/one.jpg': '1', 'a/two.mp4': '2', 'a/notes.txt': 'x', 'a/._one.jpg': 'x', 'a/.DS_Store': 'x', 'b/three.png': '3' });
  assert.deepEqual(walkMedia(root, ['a']).map(f => f.relativePath).sort(), ['a/one.jpg', 'a/two.mp4']);
  assert.equal(walkMedia(root, ['a', 'a/one.jpg']).length, 2);
  assert.throws(() => walkMedia(root, ['../outside']));
});

test('analyze: dry run estimates without calling vision', async () => {
  const s = fakeSetup({ 'a/one.jpg': '1', 'a/two.mp4': '2' });
  const r: any = await runAnalyze({ id: 'c1', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], dryRun: true }, s.deps);
  assert.equal(r.estimate.files, 2); assert.equal(r.estimate.images, 1); assert.equal(r.estimate.videos, 1); assert.equal(r.estimate.cached, 0);
  assert.ok(r.estimate.estUsd > 0); assert.equal(s.calls(), 0);
});

test('analyze: real run pushes items, writes thumb+ledger, second run hits cache', async () => {
  const s = fakeSetup({ 'a/one.jpg': 'AAA', 'a/two.jpg': 'BBB' });
  const cmd: Cmd = { id: 'c2', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'] };
  const r: any = await runAnalyze(cmd, s.deps);
  assert.equal(r.done, 2); assert.equal(s.calls(), 2); assert.equal(s.pushed.length, 2);
  assert.ok(r.spentUsd > 0 && r.spentUsd < 0.1);
  assert.equal(s.pushed[0].facets.people[0], 'Jeff Mills');
  assert.equal(s.pushed[0].jev.pillar.value, 'was-there');
  assert.equal(s.pushed[0].facets.summary, undefined);
  assert.equal(s.pushed[0].model, 'claude-haiku-4-5-20251001');
  assert.ok(fs.existsSync(path.join(s.home, 'thumbs', `${s.pushed[0].sha256}.jpg`)));
  assert.equal(fs.readFileSync(s.deps.ledgerPath, 'utf8').trim().split('\n').length, 2);
  const again: any = await runAnalyze(cmd, s.deps);
  assert.equal(s.calls(), 2); assert.equal(again.cached, 2); assert.equal(again.spentUsd, 0);
  // The worker DB may not know these hashes, but the cost ledger recorded them by path and their cache entries exist.
  const noKnown = { ...s.deps, store: { ...s.deps.store, knownFile: () => undefined } };
  const dry: any = await runAnalyze({ ...cmd, dryRun: true }, noKnown);
  assert.equal(dry.estimate.cached, 2); assert.equal(dry.estimate.estUsd, 0);
  // Ledger says analyzed but the cache entry is gone: it would be billed again, so it is NOT counted as cached.
  for (const f of fs.readdirSync(path.join(s.home, 'cache'))) fs.unlinkSync(path.join(s.home, 'cache', f));
  const dryNoCache: any = await runAnalyze({ ...cmd, dryRun: true }, noKnown);
  assert.equal(dryNoCache.estimate.cached, 0); assert.ok(dryNoCache.estimate.estUsd > 0);
});

test('analyze: cap stops the run with cappedAt; cancel stops between files; progress is reported', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 12; i++) files[`a/f${String(i).padStart(2, '0')}.jpg`] = `file${i}`;
  const s = fakeSetup(files);
  const per = estimateCallUsd('claude-haiku-4-5-20251001');
  const r: any = await runAnalyze({ id: 'c3', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], capUsd: per * 2 - 0.001 }, s.deps);
  assert.equal(s.calls(), 2); assert.equal(r.cappedAt, 'a/f02.jpg');

  const s2 = fakeSetup(files);
  let n = 0;
  const r2: any = await runAnalyze({ id: 'c4', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'] }, { ...s2.deps, isCancelled: () => ++n > 6 });
  assert.equal(r2.cancelled, true); assert.equal(s2.calls(), 6);
  assert.ok(s2.updates.some(u => u.state === 'RUNNING' && u.result.progress.done === 5));
});

test('analyze: one failing file does not stop the run', async () => {
  const s = fakeSetup({ 'a/one.jpg': '1', 'a/two.jpg': '2' });
  let i = 0;
  const r: any = await runAnalyze({ id: 'c5', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'] }, { ...s.deps, prepare: async () => { if (i++ === 0) throw new Error('decode failed'); return { jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 1, height: 1 }; } });
  assert.equal(r.errorCount, 1); assert.equal(s.pushed.length, 1);
});

test('vision: forced tool call request shape and usage parsing (fake fetch)', async () => {
  let sent: any;
  const fake = (async (_u: any, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_facets', input: { summary: 's' } }], usage: { input_tokens: 10, output_tokens: 3 } }), { status: 200 }); }) as typeof fetch;
  const out = await makeVision({ apiKey: 'k', model: 'claude-haiku-4-5-20251001', fetchImpl: fake })(Buffer.from('x'), 'Flyers/1996/a.jpg', 'image');
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'record_facets' });
  assert.match(sent.messages[0].content[1].text, /Flyers \/ 1996 \/ a\.jpg/);
  assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 3 });
});

test('stage: uploads via signed URL; oversized video fails; escape rejected', async () => {
  const s = fakeSetup({ 'a/one.jpg': 'PIXELS' });
  const sha = require('crypto').createHash('sha256').update('PIXELS').digest('hex');
  let put: any, uploadBody: any;
  const control = { uploadUrl: async (b: any) => { uploadBody = b; return { uploadUrl: 'https://signed.example/put', storagePath: 'staging/p1/x.jpg', headers: {} }; } };
  const fetchImpl = (async (url: any, init: any) => { put = { url, method: init.method, ct: init.headers['content-type'] }; for await (const _ of init.body as any) { /* drain */ } return new Response('', { status: 200 }); }) as typeof fetch;
  const r = await runStage({ id: 's', type: 'STAGE_FOR_PUBLISH', packageId: 'p1', sha256: sha, relativePath: 'a/one.jpg', sourceId: 's1' }, { store: s.deps.store, control, fetchImpl });
  assert.deepEqual(r, { storagePath: 'staging/p1/x.jpg', contentType: 'image/jpeg', sizeBytes: 6 });
  assert.equal(put.method, 'PUT'); assert.deepEqual(uploadBody, { packageId: 'p1', sha256: sha, contentType: 'image/jpeg', sizeBytes: 6 });
  await assert.rejects(runStage({ id: 's', type: 'x', packageId: 'p', sha256: sha, relativePath: '../x.jpg', sourceId: 's1' }, { store: s.deps.store, control, fetchImpl }), /escapes/);
  await assert.rejects(runStage({ id: 's', type: 'x', packageId: 'p', sha256: 'f'.repeat(64), relativePath: 'a/one.jpg', sourceId: 's1' }, { store: s.deps.store, control, fetchImpl }), /sha256/);
  const big = path.join(s.root, 'a', 'big.mp4'); fs.writeFileSync(big, ''); fs.truncateSync(big, 513 * 1024 * 1024);
  await assert.rejects(runStage({ id: 's', type: 'x', packageId: 'p', sha256: sha, relativePath: 'a/big.mp4', sourceId: 's1' }, { store: s.deps.store, control, fetchImpl }), /512MB/);
});

test('daemon: claims, runs serially, cancels, fails unsupported types (fake control)', async () => {
  const updates: any[] = [];
  const control: any = { update: async (u: any) => { updates.push(u); }, heartbeat: async () => {}, poll: async () => [] };
  const store: any = { listSources: () => [], getSource: () => undefined, knownFile: () => undefined };
  const d = new AnalyzerDaemon(control, store, { handlers: { analyze: async () => ({ done: 1 }), stage: async () => ({ storagePath: 'p', contentType: 'image/jpeg', sizeBytes: 1 }) as any } });
  await d.handlePolled([
    { id: 'a1', type: 'ANALYZE_FACETS', sourceId: 's1' }, { id: 'st1', type: 'STAGE_FOR_PUBLISH' },
    { id: 'x1', type: 'WHATEVER' }, { id: 'cx', type: 'CANCEL_JOB', targetCommandId: 'st1' },
  ]);
  assert.ok(updates.some(u => u.commandId === 'x1' && u.state === 'FAILED'));
  assert.ok(d.isCancelled('st1'));
  await d.runOne({ id: 'a1', type: 'ANALYZE_FACETS', sourceId: 's1' });
  await d.runOne({ id: 'st1', type: 'STAGE_FOR_PUBLISH' });
  assert.ok(updates.some(u => u.commandId === 'a1' && u.state === 'COMPLETE'));
  assert.ok(updates.some(u => u.commandId === 'st1' && u.state === 'FAILED' && /CANCELLED/.test(u.error)));
});

test('control: heartbeat carries capabilities + thumb base (fake fetch)', async () => {
  const { AnalyzerControl } = await import('./control');
  let body: any, url = '';
  const c = new AnalyzerControl('https://h.example', 't', 'w-analyzer', (async (u: any, init: any) => { url = String(u); body = JSON.parse(init.body); return new Response('{}', { status: 200 }); }) as typeof fetch);
  await c.heartbeat('s1', 'ONLINE');
  assert.equal(url, 'https://h.example/api/archive/worker/heartbeat');
  assert.deepEqual(body.capabilities, ['ANALYZE_FACETS', 'STAGE_FOR_PUBLISH', 'CANCEL_JOB', 'COLLECT_BATCHES']);
  assert.equal(body.localThumbBase, 'http://127.0.0.1:8777');
  assert.equal(body.workerId, 'w-analyzer');
});

test('media: real ffmpeg produces jpeg, thumb and video keyframe grid (local, free)', { skip: !fs.existsSync('/opt/homebrew/bin/ffmpeg') }, async () => {
  const d = tmp();
  const img = path.join(d, 't.png'), vid = path.join(d, 't.mp4');
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2000x1000:rate=1:duration=1', '-frames:v', '1', img]);
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=4', '-pix_fmt', 'yuv420p', vid]);
  const i = await prepareMedia(img, 'image');
  assert.equal(i.width, 2000); assert.equal(i.jpeg[0], 0xff); assert.ok(i.thumb.length < i.jpeg.length);
  const v = await prepareMedia(vid, 'video');
  assert.equal(v.width, 640); assert.ok((v.durationSec ?? 0) > 3); assert.equal(v.jpeg[0], 0xff);
});

test('analyze: estimate uses the measured average cost per file once enough calls are billed', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 4; i++) files[`a/f${i}.jpg`] = `file${i}`;
  const s = fakeSetup(files);
  const rate = await runAnalyze({ id: 'e0', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], dryRun: true }, s.deps) as any;
  assert.equal(rate.estimate.basis, 'rate-card'); assert.equal(rate.estimate.samples, 0);
  // 25 billed calls at exactly $0.004 each.
  const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ at: 'x', sha256: `${'0'.repeat(63)}${i % 10}`, relativePath: `old/${i}.jpg`, usd: 0.004 })).join('\n') + '\n';
  fs.writeFileSync(s.deps.ledgerPath, lines);
  const meas = await runAnalyze({ id: 'e1', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], dryRun: true }, s.deps) as any;
  assert.equal(meas.estimate.basis, 'measured'); assert.equal(meas.estimate.samples, 25);
  assert.equal(meas.estimate.perFileUsd, 0.004); assert.equal(meas.estimate.estUsd, 0.016); assert.equal(meas.estimate.files, 4);
});
