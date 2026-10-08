import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { OpsError, OpsManager, handleOpsRoute, moveViaRsync, uniqueName, walkTree, resolveRsync, type PlanInput } from './fileops';
import { createAnalyzerServer } from './server';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-test-'));
const put = (root: string, rel: string, c = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); };
const srcs = (a: string, b: string) => [{ id: 's', label: 'NAS A', rootPath: a }, { id: 'd', label: 'NAS B', rootPath: b }];
const getter = (list: ReturnType<typeof srcs>) => (id: string) => list.find(s => s.id === id);
const input = (o: Partial<PlanInput>): PlanInput => ({ op: 'copy', sourceId: 's', paths: ['a.txt'], destSourceId: 'd', destPath: '', ...o });
const fast = { backoffMs: [10, 10, 10, 10] };
const status = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof OpsError ? e.status : -1; } return 0; };

test('uniqueName suffixes before the extension; dirs have none', () => {
  const taken = new Set(['a.mp4', 'a (2).mp4', 'dir.v1']);
  assert.equal(uniqueName('a.mp4', 'file', n => taken.has(n)), 'a (3).mp4');
  assert.equal(uniqueName('dir.v1', 'dir', n => taken.has(n)), 'dir.v1 (2)');
  assert.equal(uniqueName('fresh.txt', 'file', n => taken.has(n)), 'fresh.txt');
});

test('plan renames on collision, counts totals, skips hidden files', () => {
  const a = tmp(), b = tmp();
  put(a, 'a.txt', 'hello'); put(a, 'folder/x.bin', '12345'); put(a, 'folder/.hidden', 'zz'); put(a, 'folder/@eaDir/t', 'zz'); put(a, 'folder/sub/y.bin', '123');
  put(b, 'a.txt', 'existing'); put(b, 'a (2).txt', 'existing2');
  const mgr = new OpsManager(fast);
  const r = mgr.plan(getter(srcs(a, b)), input({ paths: ['a.txt', 'folder'] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map(i => [i.from, i.to, i.kind, i.sizeBytes, i.renamed]), [['a.txt', 'a (3).txt', 'file', 5, true], ['folder', 'folder', 'dir', 8, false]]);
  assert.deepEqual(r.totals, { files: 3, bytes: 13, renamed: 1 });
  assert.deepEqual(walkTree(path.join(a, 'folder')).files.map(f => f.rel).sort(), ['sub/y.bin', 'x.bin']);
});

test('guards: .., absolute, symlink, dest inside source, meta, nested, caps, unknown source', () => {
  const a = tmp(), b = tmp(), out = tmp();
  put(a, 'a.txt'); put(a, 'dir/inner/f.txt'); put(a, 'HITLOOP-ARCHIVE/content/_meta/z.json'); put(out, 'secret.txt');
  fs.symlinkSync(out, path.join(a, 'link')); fs.symlinkSync(path.join(a, 'a.txt'), path.join(a, 'filelink'));
  const mgr = new OpsManager(fast); const g = getter(srcs(a, b));
  const st = (o: Partial<PlanInput>) => status(() => mgr.plan(g, input(o)));
  assert.equal(st({ paths: ['../x'] }), 400);
  assert.equal(st({ paths: ['dir/../../x'] }), 400);
  assert.equal(st({ paths: ['/etc/passwd'] }), 400);
  assert.equal(st({ paths: [''] }), 400);
  assert.equal(st({ paths: ['link'] }), 400);
  assert.equal(st({ paths: ['link/secret.txt'] }), 400);
  assert.equal(st({ paths: ['filelink'] }), 400);
  assert.equal(st({ destPath: '../x' }), 400);
  assert.equal(st({ destPath: '/tmp' }), 400);
  assert.equal(st({ destPath: 'HITLOOP-ARCHIVE/content/_meta' }), 400);
  assert.equal(st({ paths: ['HITLOOP-ARCHIVE/content/_meta/z.json'] }), 400);
  assert.equal(st({ paths: ['HITLOOP-ARCHIVE'] }), 400);
  assert.equal(st({ paths: ['dir', 'dir/inner'] }), 400);
  assert.equal(st({ destPath: 'nope' }), 404);
  assert.equal(st({ paths: ['missing'] }), 404);
  assert.equal(st({ sourceId: 'zzz' }), 404);
  assert.equal(st({ op: 'rename' as any }), 400);
  assert.equal(st({ paths: Array.from({ length: 501 }, (_, i) => `f${i}`) }), 413);
  // destination inside the folder being copied/moved (same source on both sides)
  const same = getter([{ id: 's', label: 'NAS A', rootPath: a }, { id: 'd', label: 'NAS A again', rootPath: a }]);
  assert.equal(status(() => mgr.plan(same, input({ paths: ['dir'], destPath: 'dir/inner' }))), 400);
  assert.equal(status(() => mgr.plan(same, input({ op: 'move', paths: ['dir'], destPath: 'dir' }))), 400);
  assert.equal(status(() => mgr.plan(same, input({ op: 'move', paths: ['a.txt'], destPath: '' }))), 400);
  assert.equal(status(() => mgr.plan(same, input({ paths: ['a.txt'], destPath: '' }))), 0); // copy into own folder -> "a (2).txt"
});

test('copy: nested folder with spaces and colons, never overwrites, source untouched', async () => {
  const a = tmp(), b = tmp();
  put(a, 'My Folder: v2/sub dir/it\'s "x".txt', 'payload1'); put(a, 'My Folder: v2/top file.bin', 'payload22');
  put(b, 'dest/My Folder: v2/old.txt', 'keep');
  const mgr = new OpsManager(fast); const g = getter(srcs(a, b));
  const plan = mgr.plan(g, input({ paths: ['My Folder: v2'], destPath: 'dest' }));
  assert.equal(plan.items[0].to, 'dest/My Folder: v2 (2)');
  put(b, 'dest/My Folder: v2 (2)/appeared.txt', 'raced'); // appears between plan and apply
  const { jobId } = mgr.apply(plan.planId);
  await mgr.idle();
  const job = mgr.list().find(j => j.id === jobId)!;
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.filesDone, 2); assert.equal(job.bytesDone, job.bytes);
  const final = path.join(b, 'dest/My Folder: v2 (3)');
  assert.equal(fs.readFileSync(path.join(final, 'sub dir/it\'s "x".txt'), 'utf8'), 'payload1');
  assert.equal(fs.readFileSync(path.join(final, 'top file.bin'), 'utf8'), 'payload22');
  assert.equal(fs.readFileSync(path.join(b, 'dest/My Folder: v2/old.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(b, 'dest/My Folder: v2 (2)/appeared.txt'), 'utf8'), 'raced');
  assert.ok(fs.existsSync(path.join(a, 'My Folder: v2/top file.bin')));
  assert.ok(!fs.existsSync(path.join(final, '.rsync-partial')));
  assert.equal(status(() => mgr.apply(plan.planId)), 404); // plans are single-use
});

test('same-volume move is a rename (inode preserved, source gone)', async () => {
  const a = tmp(), b = tmp();
  put(a, 'clip one.mp4', 'video'); put(a, 'album/t1.wav', 'aaa');
  const ino = fs.statSync(path.join(a, 'clip one.mp4')).ino;
  const mgr = new OpsManager({ ...fast, rsyncPath: '/nonexistent/rsync' }); // proves rsync is not used
  const plan = mgr.plan(getter(srcs(a, b)), input({ op: 'move', paths: ['clip one.mp4', 'album'] }));
  assert.equal(plan.sameShare, true);
  mgr.apply(plan.planId); await mgr.idle();
  assert.equal(mgr.list()[0].state, 'done', mgr.list()[0].error);
  assert.equal(fs.statSync(path.join(b, 'clip one.mp4')).ino, ino);
  assert.ok(!fs.existsSync(path.join(a, 'clip one.mp4')) && !fs.existsSync(path.join(a, 'album')));
  assert.equal(fs.readFileSync(path.join(b, 'album/t1.wav'), 'utf8'), 'aaa');
});

test('moveViaRsync: removes source files and empty dirs only after success', async () => {
  const a = tmp(), b = tmp();
  put(a, 'tree/x y/one.txt', '1111'); put(a, 'tree/two:2.txt', '22'); put(a, 'tree/.keep', 'hidden');
  const src = path.join(a, 'tree');
  const w = walkTree(src);
  await moveViaRsync({ rsync: resolveRsync(), backoffMs: [10] }, { fromAbs: src, kind: 'dir', files: w.files, dirs: w.dirs }, path.join(b, 'tree'));
  assert.equal(fs.readFileSync(path.join(b, 'tree/x y/one.txt'), 'utf8'), '1111');
  assert.ok(!fs.existsSync(path.join(src, 'x y')) && !fs.existsSync(path.join(src, 'two:2.txt')));
  assert.ok(fs.existsSync(path.join(src, '.keep')), 'dotfiles are never deleted; non-empty dir stays');
  assert.ok(!fs.existsSync(path.join(b, 'tree/.keep')));
  // single file
  put(a, 'solo.bin', 'abc');
  await moveViaRsync({ rsync: resolveRsync() }, { fromAbs: path.join(a, 'solo.bin'), kind: 'file', files: [{ rel: '.', size: 3 }], dirs: [] }, path.join(b, 'solo.bin'));
  assert.ok(!fs.existsSync(path.join(a, 'solo.bin')) && fs.existsSync(path.join(b, 'solo.bin')));
});

test('moveViaRsync: failure (bad rsync) or verification mismatch leaves the source intact', async () => {
  const a = tmp(), b = tmp();
  put(a, 'tree/sub/f.txt', 'data');
  const src = path.join(a, 'tree'); const w = walkTree(src);
  await assert.rejects(moveViaRsync({ rsync: '/nonexistent/rsync', backoffMs: [10] }, { fromAbs: src, kind: 'dir', files: w.files, dirs: w.dirs }, path.join(b, 'tree')));
  assert.equal(fs.readFileSync(path.join(src, 'sub/f.txt'), 'utf8'), 'data');
  // transfer succeeds but a planned size does not match -> nothing removed
  await assert.rejects(moveViaRsync({ rsync: resolveRsync() }, { fromAbs: src, kind: 'dir', files: [{ rel: 'sub/f.txt', size: 999 }], dirs: w.dirs }, path.join(b, 'tree2')), /verification/);
  assert.equal(fs.readFileSync(path.join(src, 'sub/f.txt'), 'utf8'), 'data');
  // nonzero exit that is not retryable (fake rsync exit 1)
  const fake = path.join(tmp(), 'rsync'); fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(moveViaRsync({ rsync: fake, backoffMs: [10] }, { fromAbs: src, kind: 'dir', files: w.files, dirs: w.dirs }, path.join(b, 'tree3')), /exit 1/);
  assert.ok(fs.existsSync(path.join(src, 'sub/f.txt')));
});

test('retryable exit codes retry and then succeed; failed job reports error', async () => {
  const a = tmp(), b = tmp(), t = tmp();
  put(a, 'a.txt', 'hi');
  const counter = path.join(t, 'count'); const fake = path.join(t, 'rsync');
  fs.writeFileSync(fake, `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"\nif [ $n -lt 3 ]; then exit 30; fi\nexec ${resolveRsync()} "$@"\n`, { mode: 0o755 });
  const mgr = new OpsManager({ rsyncPath: fake, backoffMs: [5, 5, 5, 5] });
  const g = getter(srcs(a, b));
  mgr.apply(mgr.plan(g, input({})).planId); await mgr.idle();
  assert.equal(mgr.list()[0].state, 'done', mgr.list()[0].error);
  assert.equal(mgr.list()[0].attempt, 3);
  assert.equal(fs.readFileSync(path.join(b, 'a.txt'), 'utf8'), 'hi');
  const bad = path.join(t, 'bad'); fs.writeFileSync(bad, '#!/bin/sh\nexit 12\n', { mode: 0o755 });
  const mgr2 = new OpsManager({ rsyncPath: bad, backoffMs: [5, 5] });
  mgr2.apply(mgr2.plan(g, input({ paths: ['a.txt'] })).planId); await mgr2.idle();
  assert.equal(mgr2.list()[0].state, 'failed'); assert.match(mgr2.list()[0].error!, /exit 12/); assert.equal(mgr2.list()[0].attempt, 3);
});

test('cancel kills the rsync child and marks the job cancelled; queued jobs cancel too', async () => {
  const a = tmp(), b = tmp(), t = tmp();
  put(a, 'a.txt', 'hi'); put(a, 'b.txt', 'yo');
  const pidFile = path.join(t, 'pid'); const fake = path.join(t, 'rsync');
  fs.writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const mgr = new OpsManager({ rsyncPath: fake, backoffMs: [5] }); const g = getter(srcs(a, b));
  const j1 = mgr.apply(mgr.plan(g, input({ paths: ['a.txt'] })).planId).jobId;
  const j2 = mgr.apply(mgr.plan(g, input({ paths: ['b.txt'] })).planId).jobId;
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(mgr.list().find(j => j.id === j1)!.state, 'running');
  assert.equal(mgr.list().find(j => j.id === j2)!.state, 'queued');
  mgr.cancel(j2);
  mgr.cancel(j1); await mgr.idle();
  assert.deepEqual(mgr.list().map(j => j.state), ['cancelled', 'cancelled']);
  assert.throws(() => process.kill(pid, 0), 'child is gone');
  assert.equal(status(() => mgr.cancel(j1)), 409);
  assert.equal(status(() => mgr.cancel('nope')), 404);
});

test('HTTP routes: plan -> apply -> jobs, validation, origin and body handling', async () => {
  const a = tmp(), b = tmp();
  put(a, 'a.txt', 'hello');
  const list = srcs(a, b);
  const server = createAnalyzerServer({ workerId: 'w', thumbDir: tmp(), store: { locate: () => [], listSources: () => list, getSource: id => list.find(s => s.id === id) }, ops: new OpsManager(fast) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, p: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...headers } }, res => { let t = ''; res.on('data', c => (t += c)); res.on('end', () => resolve({ status: res.statusCode!, json: t.startsWith('{') ? JSON.parse(t) : t })); });
    q.on('error', reject); q.end(body);
  });
  try {
    const plan = await call('POST', '/nas/ops/plan', JSON.stringify({ op: 'copy', sourceId: 's', paths: ['a.txt'], destSourceId: 'd', destPath: '' }), { origin: 'http://localhost:3000' });
    assert.equal(plan.status, 200); assert.equal(plan.json.ok, true); assert.deepEqual(plan.json.totals, { files: 1, bytes: 5, renamed: 0 });
    assert.equal((await call('POST', '/nas/ops/plan', '{not json')).status, 400);
    assert.equal((await call('POST', '/nas/ops/plan', JSON.stringify({ op: 'copy', sourceId: 's', paths: ['../a'], destSourceId: 'd', destPath: '' }))).status, 400);
    assert.equal((await call('POST', '/nas/ops/plan', '{}', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('GET', '/nas/ops/plan')).status, 405);
    assert.equal((await call('POST', '/nas/ops/apply', JSON.stringify({ planId: 'nope' }))).status, 404);
    const applied = await call('POST', '/nas/ops/apply', JSON.stringify({ planId: plan.json.planId }));
    assert.equal(applied.status, 200); assert.ok(applied.json.jobId);
    let job: any;
    for (let i = 0; i < 100; i++) { job = (await call('GET', '/nas/ops/jobs')).json.jobs[0]; if (job.state === 'done' || job.state === 'failed') break; await new Promise(r => setTimeout(r, 30)); }
    assert.equal(job.state, 'done', job.error); assert.equal(job.id, applied.json.jobId); assert.equal(job.filesDone, 1);
    assert.equal(fs.readFileSync(path.join(b, 'a.txt'), 'utf8'), 'hello');
    assert.equal((await call('POST', '/nas/ops/cancel', JSON.stringify({ jobId: job.id }))).status, 409);
  } finally { server.close(); }
});

test('handleOpsRoute ignores non-ops paths', () => {
  assert.equal(handleOpsRoute(new OpsManager(), () => undefined, 'GET', '/nas/status', undefined), null);
});
