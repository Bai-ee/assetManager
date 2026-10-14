import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import fsCjs from 'fs';
import { syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { runAnalyze, walkMedia } from './analyze';
import { DoneIndex, type DirListing } from './done-index';
import type { Cmd } from './control';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-index-'));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const write = (root: string, rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); };
const bumpDir = (abs: string) => { const t = new Date(Date.now() + 5000); fs.utimesSync(abs, t, t); };

function memIndex() {
  const dirs: Record<string, DirListing> = {};
  return { dirs, setDir: (rel: string, l: DirListing) => { dirs[rel] = l; } };
}

test('walk: unchanged directories are not re-listed and their files are not lstat-ed; changes and verify re-walk', () => {
  const root = tmp();
  write(root, 'a/one.jpg', '1'); write(root, 'a/sub/two.mp4', '22'); write(root, 'a/notes.txt', 'x'); write(root, 'a/.hidden.jpg', 'h');
  const idx = memIndex();
  const first = walkMedia(root, ['a'], { index: idx });
  assert.deepEqual(first.map(f => f.relativePath), ['a/one.jpg', 'a/sub/two.mp4']);
  assert.deepEqual(Object.keys(idx.dirs).sort(), ['a', 'a/sub']);

  const lstat = mock.method(fsCjs, 'lstatSync');
  const readdir = mock.method(fsCjs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    const again = walkMedia(root, ['a'], { index: idx });
    assert.deepEqual(again, first);
    assert.equal(lstat.mock.callCount(), 2, 'one lstat per directory only');
    assert.equal(readdir.mock.callCount(), 0);

    write(root, 'a/three.png', '333'); bumpDir(path.join(root, 'a'));
    lstat.mock.resetCalls();
    const added = walkMedia(root, ['a'], { index: idx });
    assert.deepEqual(added.map(f => f.relativePath), ['a/one.jpg', 'a/sub/two.mp4', 'a/three.png']);

    // In-place edit keeps the directory mtime: the index reports the old size until verify.
    const t = fs.statSync(path.join(root, 'a')).mtime;
    fs.writeFileSync(path.join(root, 'a/one.jpg'), '1111'); fs.utimesSync(path.join(root, 'a'), t, t);
    assert.equal(walkMedia(root, ['a'], { index: idx }).find(f => f.relativePath === 'a/one.jpg')!.sizeBytes, 1);
    readdir.mock.resetCalls();
    const verified = walkMedia(root, ['a'], { index: idx, verify: true });
    assert.equal(verified.find(f => f.relativePath === 'a/one.jpg')!.sizeBytes, 4);
    assert.ok(readdir.mock.callCount() >= 2);
  } finally { lstat.mock.restore(); readdir.mock.restore(); syncBuiltinESMExports(); }
});

test('index: fresh() needs matching size+mtime; garbled file loads empty; save is atomic and idempotent', () => {
  const home = tmp(), file = path.join(home, 'done-index.json');
  fs.writeFileSync(file, '{torn');
  const ix = new DoneIndex(file);
  assert.deepEqual(ix.source('s1'), { files: {}, dirs: {} });
  ix.setFile('s1', 'a/x.jpg', { sizeBytes: 3, mtimeMs: 10, sha256: 'h' });
  ix.save();
  const back = new DoneIndex(file);
  assert.equal(back.fresh('s1', { relativePath: 'a/x.jpg', sizeBytes: 3, mtimeMs: 10 })!.sha256, 'h');
  assert.equal(back.fresh('s1', { relativePath: 'a/x.jpg', sizeBytes: 4, mtimeMs: 10 }), null);
  assert.equal(back.fresh('s1', { relativePath: 'a/x.jpg', sizeBytes: 3, mtimeMs: 12 }), null);
  assert.equal(back.fresh('s2', { relativePath: 'a/x.jpg', sizeBytes: 3, mtimeMs: 10 }), null);
  assert.deepEqual(fs.readdirSync(home), ['done-index.json']);
});

function setup(files: Record<string, string>, organize = false) {
  const root = tmp(), home = tmp();
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  const updates: any[] = [], pushed: any[] = [];
  let hashed: string[] = [];
  let nextId = 1, failPush = false;
  const ok = { type: 'succeeded', message: { content: [{ type: 'tool_use', name: 'record_facets', input: { ocrText: 'x', summary: 's' } }], usage: { input_tokens: 10, output_tokens: 10 } } };
  let lastReq: Array<{ custom_id: string }> = [];
  const fetchImpl = (async (url: any, init: any = {}) => {
    const u = String(url), method = init.method || 'GET';
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (method === 'POST') { lastReq = JSON.parse(init.body).requests; return json({ id: `msgbatch_${nextId++}` }); }
    if (u.endsWith('/results')) return new Response(lastReq.map(r => JSON.stringify({ custom_id: r.custom_id, result: ok })).join('\n'), { status: 200 });
    return json({ processing_status: 'ended', request_counts: {}, results_url: `${u}/results` });
  }) as typeof fetch;
  const deps: any = {
    store: { getSource: (id: string) => (id === 's1' ? { id, label: 'nas', rootPath: root } : undefined), knownFile: () => undefined },
    control: {
      update: async (u: any) => { updates.push(u); },
      pushResults: async (_s: string, items: any[]) => { if (failPush) throw new Error('down'); pushed.push(...items); },
    },
    vision: null, apiKey: 'k', fetchImpl, pollMs: 1, organize,
    prepare: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 1, height: 1 }),
    isCancelled: () => false,
    cacheDir: path.join(home, 'cache'), thumbDir: path.join(home, 'thumbs'), ledgerPath: path.join(home, 'cost.jsonl'),
    batchesPath: path.join(home, 'batches.json'),
    hashFile: async (p: string) => { hashed.push(path.relative(root, p)); return sha256(fs.readFileSync(p, 'utf8')); },
  };
  return {
    root, home, deps, updates, pushed,
    hashed: () => hashed, resetHashed: () => { hashed = []; },
    setFailPush: (v: boolean) => { failPush = v; },
    index: () => JSON.parse(fs.readFileSync(path.join(home, 'done-index.json'), 'utf8')).sources.s1,
  };
}
const cmd = (extra: Partial<Cmd> = {}): Cmd => ({ id: 'c1', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], batch: true, ...extra });

test('batch + index: a re-run skips hash, organize and push for finished files; progress still reported', async () => {
  const s = setup({ 'a/one.jpg': 'A', 'a/two.jpg': 'B' });
  const r1: any = await runAnalyze(cmd(), s.deps);
  assert.equal(r1.done, 2); assert.equal(s.pushed.length, 2);
  const ix = s.index();
  assert.ok(ix.files['a/one.jpg'].pushedAt); assert.equal(ix.files['a/one.jpg'].sha256, sha256('A'));
  assert.ok(ix.dirs.a);

  s.resetHashed(); s.pushed.length = 0; s.updates.length = 0;
  const r2: any = await runAnalyze(cmd(), s.deps);
  assert.equal(r2.cached, 2); assert.equal(r2.indexSkipped, 2); assert.equal(r2.pushed, 0);
  assert.deepEqual(s.hashed(), []); assert.equal(s.pushed.length, 0);
  const prep = s.updates.filter(u => u.result?.progress?.phase === 'preparing').map(u => u.result.progress);
  assert.ok(prep.length >= 2); assert.equal(prep[prep.length - 1].done, 2);

  // A changed file falls back to the normal path (hashed, analyzed as new); verify re-checks everything.
  fs.writeFileSync(path.join(s.root, 'a/two.jpg'), 'B2'); bumpDir(path.join(s.root, 'a'));
  s.resetHashed();
  const r3: any = await runAnalyze(cmd(), s.deps);
  assert.deepEqual(s.hashed(), ['a/two.jpg']); assert.equal(r3.indexSkipped, 1);
  s.resetHashed(); s.pushed.length = 0;
  const r4: any = await runAnalyze(cmd({ verify: true }), s.deps);
  assert.equal(r4.indexSkipped, undefined); assert.equal(r4.cached, 2); assert.equal(s.pushed.length, 2);
  assert.deepEqual(s.hashed(), []); // verify = today's path, which keeps the ledger sha shortcut for unchanged files
});

test('batch + index: organized but unpushed files are re-pushed without organizeCopy; pushedAt only after acceptance', async () => {
  const s = setup({ 'a/one.jpg': 'A' }, true);
  s.setFailPush(true);
  await assert.rejects(runAnalyze(cmd(), s.deps), /Pushing results failed/);
  const e = s.index().files['a/one.jpg'];
  assert.equal(e.pushedAt, undefined);
  assert.match(e.organizedRelativePath, /^HITLOOP-ARCHIVE\/content\//);

  // If organizeCopy ran it would recreate the organized copy; it must not.
  fs.rmSync(path.join(s.root, e.organizedRelativePath));
  s.setFailPush(false);
  const r: any = await runAnalyze(cmd(), s.deps);
  assert.equal(r.pushed, 1); assert.equal(s.pushed[0].organizedPath, e.organizedRelativePath);
  assert.equal(fs.existsSync(path.join(s.root, e.organizedRelativePath)), false);
  assert.ok(s.index().files['a/one.jpg'].pushedAt);
});
