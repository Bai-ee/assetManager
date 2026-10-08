import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { browse, BrowseError, isNasSource, nasStatus, organizeCopy, organizedFor, parseSmbMounts, CLOUD_INTAKE_SOURCE_ID } from './nas';
import { createAnalyzerServer } from './server';
import { runAnalyze } from './analyze';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nas-test-'));
const put = (root: string, rel: string, c = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); };
const sha = (c: string) => crypto.createHash('sha256').update(c).digest('hex');

test('parseSmbMounts + status excludes cloud intake', () => {
  const text = '//GUEST:@192.168.1.6/bryan on /Volumes/bryan (smbfs, nodev)\n/dev/disk1 on / (apfs)';
  assert.deepEqual(parseSmbMounts(text), [{ smbUrl: 'smb://GUEST@192.168.1.6/bryan', mountPoint: '/Volumes/bryan', host: '192.168.1.6' }]);
  const root = tmp();
  const st = nasStatus([{ id: 'n', label: 'Bryan NAS', rootPath: root }, { id: CLOUD_INTAKE_SOURCE_ID, label: 'Cloud intake', rootPath: '/x' }], text);
  assert.equal(st.sources.length, 1); assert.equal(st.sources[0].id, 'n'); assert.equal(st.sources[0].reachable, true);
  assert.equal(st.smbUrl, 'smb://GUEST@192.168.1.6/bryan');
  assert.equal(nasStatus([], '').mounted, false);
  assert.equal(isNasSource({ id: 'q', label: 'Cloud intake', rootPath: '/y' }), false);
});

test('browse: filtering, sorting, path safety', () => {
  const root = tmp();
  put(root, 'b/one.jpg'); put(root, 'a.txt', 'hello'); put(root, 'c.mp4'); put(root, '.hidden'); put(root, '@eaDir/x'); put(root, '#recycle/x'); put(root, '.DS_Store');
  put(root, 'HITLOOP-ARCHIVE/content/_meta/z.json'); put(root, 'HITLOOP-ARCHIVE/content/flyer/2020/f.jpg');
  const outside = tmp(); put(outside, 'secret.txt');
  fs.symlinkSync(outside, path.join(root, 'link'));
  const r = browse(root, '');
  assert.deepEqual(r.entries.map(e => e.name), ['b', 'HITLOOP-ARCHIVE', 'a.txt', 'c.mp4']);
  assert.equal(r.parent, null);
  assert.equal(r.entries[0].childCount, 1);
  assert.equal(r.entries[3].mediaType, 'video'); assert.equal(r.entries[2].mediaType, undefined); assert.equal(r.entries[2].sizeBytes, 5);
  const sub = browse(root, 'b'); assert.equal(sub.parent, ''); assert.equal(sub.entries[0].relativePath, 'b/one.jpg');
  assert.deepEqual(browse(root, 'HITLOOP-ARCHIVE/content').entries.map(e => e.name), ['flyer']);
  for (const bad of ['../x', '/etc', 'a/../../x', 'link', 'link/secret.txt', 'HITLOOP-ARCHIVE/content/_meta', '@eaDir']) {
    assert.throws(() => browse(root, bad), BrowseError, bad);
  }
  assert.throws(() => browse(root, 'nope'), /not found/);
  const big = tmp(); for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, '0')}.txt`), '');
  const t = browse(big, ''); assert.equal(t.entries.length, 2000); assert.equal(t.truncated, true);
});

// The folder year comes only from a year read off the flyer text (eventYear); eraYear and capturedAt are ignored.
const entry = (kind: string, eventYear: number | null, capturedAt?: string) => ({ facets: { vibe: { kind }, eventYear, eraYear: 1850 }, capturedAt, summary: 's' });

test('organize: layout, sidecar, thumb, idempotency, collision, originals untouched', async () => {
  const root = tmp(), thumbs = tmp();
  put(root, 'in/a/photo.jpg', 'AAA'); put(root, 'in/b/photo.jpg', 'BBB');
  const A = sha('AAA'), B = sha('BBB');
  fs.writeFileSync(path.join(thumbs, `${A}.jpg`), 'thumb');
  const base = { rootPath: root, sourceId: 's1', thumbDir: thumbs, now: () => new Date('2026-01-02T03:04:05Z') };
  const p1 = await organizeCopy({ ...base, sha256: A, originalAbs: path.join(root, 'in/a/photo.jpg'), originalRelativePath: 'in/a/photo.jpg', entry: entry('flyer', 1999) });
  assert.equal(p1, 'HITLOOP-ARCHIVE/content/flyer/1999/photo.jpg');
  assert.equal(fs.readFileSync(path.join(root, p1), 'utf8'), 'AAA');
  assert.ok(fs.existsSync(path.join(root, 'in/a/photo.jpg')));
  const side = JSON.parse(fs.readFileSync(path.join(root, 'HITLOOP-ARCHIVE/content/_meta', `${A}.json`), 'utf8'));
  assert.equal(side.originalRelativePath, 'in/a/photo.jpg'); assert.equal(side.organizedRelativePath, p1); assert.equal(side.analyzedAt, '2026-01-02T03:04:05.000Z'); assert.equal(side.sha256, A); assert.equal(side.summary, 's');
  assert.equal(fs.readFileSync(path.join(root, 'HITLOOP-ARCHIVE/content/_meta/thumbs', `${A}.jpg`), 'utf8'), 'thumb');
  assert.equal(organizedFor(root, A), path.join(root, p1));
  // idempotent
  const again = await organizeCopy({ ...base, sha256: A, originalAbs: path.join(root, 'in/a/photo.jpg'), originalRelativePath: 'in/a/photo.jpg', entry: entry('flyer', 1999) });
  assert.equal(again, p1);
  // collision with different sha
  const p2 = await organizeCopy({ ...base, sha256: B, originalAbs: path.join(root, 'in/b/photo.jpg'), originalRelativePath: 'in/b/photo.jpg', entry: entry('flyer', 1999) });
  assert.equal(p2, `HITLOOP-ARCHIVE/content/flyer/1999/photo-${B.slice(0, 8)}.jpg`);
  // same sha already on disk but no sidecar -> skip copy, reuse
  fs.rmSync(path.join(root, 'HITLOOP-ARCHIVE/content/_meta', `${B}.json`));
  assert.equal(await organizeCopy({ ...base, sha256: B, originalAbs: path.join(root, 'in/b/photo.jpg'), originalRelativePath: 'in/b/photo.jpg', entry: entry('flyer', 1999) }), p2);
  // a file date (capturedAt) never names the year folder; no flyer year means 'unknown'
  const C = sha('AAA');
  put(root, 'in/c.jpg', 'CCC');
  const p3 = await organizeCopy({ ...base, sha256: sha('CCC'), originalAbs: path.join(root, 'in/c.jpg'), originalRelativePath: 'in/c.jpg', entry: entry('party-photo', null, '2011-05-06T00:00:00Z') });
  assert.equal(p3, 'HITLOOP-ARCHIVE/content/party-photo/unknown/c.jpg');
  put(root, 'in/d.jpg', 'DDD');
  assert.equal(await organizeCopy({ ...base, sha256: sha('DDD'), originalAbs: path.join(root, 'in/d.jpg'), originalRelativePath: 'in/d.jpg', entry: { facets: { vibe: { kind: 'other' }, eventYear: null } } }), 'HITLOOP-ARCHIVE/content/other/unknown/d.jpg');
  void C;
  assert.deepEqual(fs.readdirSync(path.join(root, 'HITLOOP-ARCHIVE/content/flyer/1999')).filter(n => n.endsWith('.tmp')), []);
});

test('analyze organizes, pushes organizedPath, and does not re-walk organized copies', async () => {
  const root = tmp(), home = tmp(); put(root, 'a/one.jpg', '1');
  const pushed: any[] = [];
  const deps: any = {
    store: { getSource: () => ({ id: 's1', label: 'nas', rootPath: root }), knownFile: () => undefined },
    control: { update: async () => undefined, pushResults: async (_s: string, items: any[]) => { pushed.push(...items); } },
    vision: async () => ({ raw: { vibe: { kind: 'flyer' }, eraYear: 1850, ocrText: 'FRIDAY JUNE 6 2003 DOORS 9PM', summary: 'x' }, usage: { inputTokens: 1, outputTokens: 1 } }),
    prepare: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 1, height: 1 }),
    isCancelled: () => false, cacheDir: path.join(home, 'c'), thumbDir: path.join(home, 't'), ledgerPath: path.join(home, 'l.jsonl'),
  };
  const r: any = await runAnalyze({ id: 'c', type: 'ANALYZE_FACETS', sourceId: 's1', paths: [] }, deps);
  assert.equal(r.total, 1); assert.equal(pushed[0].organizedPath, 'HITLOOP-ARCHIVE/content/flyer/2003/one.jpg');
  assert.equal(r.organizeErrors, 0);
  const r2: any = await runAnalyze({ id: 'c2', type: 'ANALYZE_FACETS', sourceId: 's1', paths: [] }, deps);
  assert.equal(r2.total, 1); assert.equal(r2.cached, 1);
});

test('server: CORS preflight, /nas/status, /nas/browse, /nas/connect, /media prefers organized', async () => {
  const root = tmp(); put(root, 'd/x.jpg', 'ORIG');
  const A = sha('ORIG');
  await organizeCopy({ rootPath: root, sourceId: 's', sha256: A, originalAbs: path.join(root, 'd/x.jpg'), originalRelativePath: 'd/x.jpg', entry: entry('flyer', 2000) });
  fs.writeFileSync(path.join(root, 'HITLOOP-ARCHIVE/content/flyer/2000/x.jpg'), 'ORIG'); // same bytes
  fs.writeFileSync(path.join(root, 'd/x.jpg'), 'ORIG');
  const srcs = [{ id: 's', label: 'Bryan NAS', rootPath: root }, { id: CLOUD_INTAKE_SOURCE_ID, label: 'Cloud intake', rootPath: root }];
  let mounted = false; let connects = 0;
  const server = createAnalyzerServer({
    workerId: 'w', thumbDir: tmp(),
    store: { locate: () => [{ sourceId: 's', rootPath: root, relativePath: 'd/x.jpg' }], listSources: () => srcs, getSource: id => srcs.find(s => s.id === id) },
    mountText: () => (mounted ? `//GUEST:@192.168.1.6/bryan on ${root} (smbfs, nodev)` : ''),
    connect: async () => { connects++; mounted = true; },
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers })); });
    q.on('error', reject); q.end();
  });
  try {
    const pre = await call('OPTIONS', '/nas/connect', { origin: 'http://localhost:3002', 'access-control-request-method': 'POST' });
    assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:3002');
    assert.equal(pre.headers['access-control-allow-methods'], 'GET, POST, OPTIONS'); assert.match(String(pre.headers['access-control-allow-headers']), /content-type/);
    assert.equal((await call('OPTIONS', '/nas/connect', { origin: 'https://evil.example' })).headers['access-control-allow-origin'], undefined);
    let st = JSON.parse((await call('GET', '/nas/status')).body);
    assert.equal(st.mounted, false); assert.deepEqual(st.sources.map((s: any) => s.id), ['s']);
    assert.equal((await call('GET', '/nas/connect')).status, 405);
    st = JSON.parse((await call('POST', '/nas/connect')).body); assert.equal(st.mounted, true); assert.equal(connects, 1);
    await call('POST', '/nas/connect'); assert.equal(connects, 1);
    const b = JSON.parse((await call('GET', '/nas/browse?sourceId=s&path=d')).body); assert.equal(b.entries[0].name, 'x.jpg');
    assert.equal((await call('GET', '/nas/browse?sourceId=s&path=..%2F..')).status, 400);
    assert.equal((await call('GET', `/nas/browse?sourceId=${CLOUD_INTAKE_SOURCE_ID}`)).status, 404);
    assert.equal((await call('POST', '/health')).status, 405);
    // organized copy preferred: change organized bytes, original stays
    fs.writeFileSync(path.join(root, 'HITLOOP-ARCHIVE/content/flyer/2000/x.jpg'), 'ORGN');
    assert.equal((await call('GET', `/media/${A}`)).body, 'ORGN');
  } finally { server.close(); }
});
