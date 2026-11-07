import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeThumbs, runThumbs } from './thumbs';

const FF = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FP = process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe';
let dir: string, cache: string;

const dims = (f: string) => {
  const [w, h] = execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
  return { w, h };
};
const ff = (...a: string[]) => execFileSync(FF, ['-v', 'error', '-y', ...a]);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'photolib-thumbs-'));
  cache = join(dir, 'cache');
  ff('-f', 'lavfi', '-i', 'testsrc=s=3200x1800', '-frames:v', '1', join(dir, 'land.jpg'));
  ff('-f', 'lavfi', '-i', 'testsrc=s=400x200', '-frames:v', '1', join(dir, 'small.jpg'));
  // 400x200 stored pixels + Orientation=6 → displayed portrait 200x400
  ff('-f', 'lavfi', '-i', 'testsrc=s=400x200', '-frames:v', '1', join(dir, 'rot.jpg'));
  execFileSync('exiftool', ['-Orientation#=6', '-overwrite_original', join(dir, 'rot.jpg')]);
  ff('-f', 'lavfi', '-i', 'testsrc=s=640x360:d=2', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4'));
  ff('-f', 'lavfi', '-i', 'testsrc=s=64x48:d=0.5', '-pix_fmt', 'yuv420p', join(dir, 'short.mp4'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('landscape image: long edge 320 / 1600, aspect kept', async () => {
  const t = await makeThumbs({ absPath: join(dir, 'land.jpg'), kind: 'image', id: 'aaaa' }, { cacheDir: cache });
  assert.deepEqual(dims(t.s), { w: 320, h: 180 });
  assert.deepEqual(dims(t.m), { w: 1600, h: 900 });
  assert.equal(t.s, join(cache, 'aaaa_s.jpg'));
});

test('never upscales small images', async () => {
  const t = await makeThumbs({ absPath: join(dir, 'small.jpg'), kind: 'image', id: 'bbbb' }, { cacheDir: cache });
  assert.deepEqual(dims(t.s), { w: 320, h: 160 });
  assert.deepEqual(dims(t.m), { w: 400, h: 200 });
});

test('EXIF Orientation=6 is applied: output is portrait', async () => {
  const t = await makeThumbs({ absPath: join(dir, 'rot.jpg'), kind: 'image', id: 'cccc' }, { cacheDir: cache });
  assert.deepEqual(dims(t.s), { w: 160, h: 320 });
  assert.deepEqual(dims(t.m), { w: 200, h: 400 });
});

test('video poster, including a clip shorter than 1s', async () => {
  const a = await makeThumbs({ absPath: join(dir, 'clip.mp4'), kind: 'video', id: 'dddd' }, { cacheDir: cache });
  assert.deepEqual(dims(a.s), { w: 320, h: 180 });
  assert.deepEqual(dims(a.m), { w: 640, h: 360 });
  const b = await makeThumbs({ absPath: join(dir, 'short.mp4'), kind: 'video', id: 'eeee' }, { cacheDir: cache });
  assert.deepEqual(dims(b.s), { w: 64, h: 48 });
});

test('skips work when both outputs exist; leaves no temp files', async () => {
  let calls = 0;
  const run = async () => { calls++; };
  await makeThumbs({ absPath: join(dir, 'land.jpg'), kind: 'image', id: 'aaaa' }, { cacheDir: cache, run });
  assert.equal(calls, 0);
  assert.equal(readdirSync(cache).filter(f => f.startsWith('.tmp')).length, 0);
});

test('HEIC goes through sips first, then ffmpeg', async () => {
  const cmds: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    cmds.push(cmd.split('/').pop() as string);
    const out = args[args.length - 1];
    mkdirSync(cache, { recursive: true });
    writeFileSync(out, 'x');
  };
  await makeThumbs({ absPath: '/nope/IMG.HEIC', kind: 'image', id: 'ffff' }, { cacheDir: cache, run });
  assert.deepEqual(cmds, ['sips', 'ffmpeg', 'ffmpeg']);
});

test('runThumbs reads destRoot/canonicalPath, stores cache paths, honours cancel + limit', async () => {
  const set: [string, string, string][] = [];
  const rows = [1, 2, 3].map(n => ({ sha256: `sha${n}`, id: `id${n}`, kind: 'image' as const, canonicalPath: `x/${n}.jpg` }));
  const seen: string[] = [];
  const manifest = {
    listAssets: (o: { missingThumbs?: boolean; limit?: number }) => { assert.equal(o.missingThumbs, true); assert.equal(o.limit, 5); return rows; },
    setThumbs: (sha: string, s: string, m: string) => { set.push([sha, s, m]); },
  };
  let cancel = false;
  const make = async (i: { absPath: string; id: string }) => { seen.push(i.absPath); if (i.id === 'id2') cancel = true; return { s: `/c/${i.id}_s.jpg`, m: `/c/${i.id}_m.jpg` }; };
  const r = await runThumbs({ manifest, destRoot: '/root', cacheDir: '/c', limit: 5, isCancelled: () => cancel, make: make as never });
  assert.deepEqual(seen, ['/root/x/1.jpg', '/root/x/2.jpg']);
  assert.equal(r.done, 2);
  assert.equal(r.cancelled, true);
  assert.deepEqual(set[0], ['sha1', '/c/id1_s.jpg', '/c/id1_m.jpg']);
});

test('runThumbs records a failure and continues', async () => {
  const manifest = {
    listAssets: () => [{ sha256: 'a', id: 'a', kind: 'image', canonicalPath: 'a.jpg' }, { sha256: 'b', id: 'b', kind: 'image', canonicalPath: 'b.jpg' }],
    setThumbs: () => undefined,
  };
  const make = async (i: { id: string }) => { if (i.id === 'a') throw new Error('boom'); return { s: 's', m: 'm' }; };
  const r = await runThumbs({ manifest, destRoot: '/r', cacheDir: '/c', make: make as never });
  assert.equal(r.done, 1);
  assert.equal(r.failed[0].error, 'boom');
});
