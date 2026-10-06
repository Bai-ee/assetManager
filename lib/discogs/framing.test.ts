import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCrop, pickSubject, framingGraph, locateRecord, type Box, type Rect } from './framing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;
const px = (b: Box, w: number, h: number): Rect => ({ x: b.x * w, y: b.y * h, w: b.w * w, h: b.h * h });

test('centred subject in 16:9 frame -> centred 1:1 crop containing it', () => {
  const box = { x: 0.35, y: 0.2, w: 0.3, h: 0.55 };
  const p = planCrop(1920, 1080, box, 1);
  assert.equal(p.mode, 'crop');
  if (p.mode !== 'crop') return;
  assert.equal(p.rect.w, p.rect.h);
  assert.ok(inside(px(box, 1920, 1080), p.rect));
  const sc = px(box, 1920, 1080);
  assert.ok(Math.abs(p.rect.x + p.rect.w / 2 - (sc.x + sc.w / 2)) <= 2);
  assert.ok(Math.abs(p.rect.y + p.rect.h / 2 - (sc.y + sc.h / 2)) <= 2);
});

test('9:16 crop from a 16:9 frame stays inside the frame', () => {
  const box = { x: 0.4, y: 0.25, w: 0.2, h: 0.5 };
  const p = planCrop(1920, 1080, box, 9 / 16);
  assert.equal(p.mode, 'crop');
  if (p.mode !== 'crop') return;
  assert.ok(inside(p.rect, { x: 0, y: 0, w: 1920, h: 1080 }));
  assert.ok(inside(px(box, 1920, 1080), p.rect));
  assert.ok(Math.abs(p.rect.w / p.rect.h - 9 / 16) < 0.01);
});

test('1:1 never pads: disc taller than the square reports fits=false, still a crop', () => {
  const tall = { x: 0.02, y: 0.1, w: 0.96, h: 0.8 };
  const q = planCrop(1080, 1920, tall, 1);
  assert.equal(q.mode, 'crop');
  if (q.mode !== 'crop') return;
  assert.equal(q.fits, false);
  assert.equal(q.rect.w, q.rect.h);
  assert.ok(inside(q.rect, { x: 0, y: 0, w: 1080, h: 1920 }));
});

test('1:1 from a portrait source: full width when centring allows, tighter square when needed to centre', () => {
  const mid = planCrop(1080, 1920, { x: 0.3, y: 0.4, w: 0.4, h: 0.2 }, 1);
  assert.equal(mid.mode, 'crop');
  if (mid.mode !== 'crop') return;
  assert.equal(mid.rect.w, 1080);
  const off = planCrop(1080, 1920, { x: 0.45, y: 0.4, w: 0.4, h: 0.2 }, 1); // centre x=0.65 -> room 378 each side of 1080? 756 square
  assert.equal(off.mode, 'crop');
  if (off.mode !== 'crop') return;
  assert.ok(off.rect.w < 1080 && off.fits);
  assert.ok(Math.abs(off.rect.x + off.rect.w / 2 - 1080 * 0.65) <= 2);
});

test('9:16 from a portrait source is the full frame; from landscape a pad is still allowed when it cannot fit', () => {
  const p = planCrop(1080, 1920, { x: 0.6, y: 0.4, w: 0.3, h: 0.2 }, 9 / 16);
  assert.equal(p.mode, 'crop');
  if (p.mode === 'crop') assert.deepEqual(p.rect, { x: 0, y: 0, w: 1080, h: 1920 });
  const wide = planCrop(1920, 1080, { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, 9 / 16);
  assert.equal(wide.mode, 'pad');
});

test('subject near an edge -> fully inside and centred, crop or pad', () => {
  const box = { x: 0.0, y: 0.35, w: 0.3, h: 0.3 };
  for (const aspect of [1, 9 / 16]) {
    const p = planCrop(1920, 1080, box, aspect);
    const r = p.mode === 'crop' ? p.rect : p.region;
    assert.ok(inside(px(box, 1920, 1080), r), JSON.stringify(p));
    assert.ok(inside(r, { x: 0, y: 0, w: 1920, h: 1080 }));
    const sc = px(box, 1920, 1080);
    assert.ok(Math.abs(r.x + r.w / 2 - (sc.x + sc.w / 2)) <= 2, JSON.stringify(p));
  }
});

test('large subject off-centre: margin is trimmed but a centred crop is still used', () => {
  // label photo 1125x2000, label 855x800 left of centre: fits a centred 922x922 crop with a thin margin
  const p = planCrop(1125, 2000, { x: 0.03, y: 0.28, w: 0.76, h: 0.4 }, 1);
  assert.equal(p.mode, 'crop');
  if (p.mode !== 'crop') return;
  assert.equal(p.rect.w, p.rect.h);
  assert.ok(inside(px({ x: 0.03, y: 0.28, w: 0.76, h: 0.4 }, 1125, 2000), p.rect));
});

test('no subject: 9:16 pads whole frame, 1:1 centre-crops', () => {
  assert.equal(planCrop(1000, 800, null, 9 / 16).mode, 'pad');
  assert.equal(planCrop(1000, 800, null, 1).mode, 'crop');
});

test('pickSubject: disc when fully visible in majority, else label', () => {
  const d = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, l = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  assert.equal(pickSubject([{ disc: d, discFullyVisible: true, label: l }, { disc: d, discFullyVisible: true, label: l }, { disc: d, discFullyVisible: false, label: l }]).kind, 'disc');
  const s = pickSubject([{ disc: d, discFullyVisible: false, label: l }, { disc: d, discFullyVisible: false, label: l }, { disc: d, discFullyVisible: true, label: l }]);
  assert.equal(s.kind, 'label');
  assert.deepEqual(s.box, l);
  assert.equal(pickSubject([{ disc: null, discFullyVisible: false, label: null }]).kind, 'none');
});

test('framingGraph builds crop and pad graphs', () => {
  const c = framingGraph('v', 'o', { mode: 'crop', rect: { x: 10, y: 20, w: 100, h: 100 }, note: '' }, 1080, 1080, 'a');
  assert.match(c, /crop=100:100:10:20,scale=1080:1080/);
  const p = framingGraph('v', 'o', { mode: 'pad', region: { x: 0, y: 0, w: 100, h: 200 }, note: '' }, 1080, 1080, 'a', 'eq=contrast=1');
  assert.match(p, /boxblur=20:2/);
  assert.match(p, /eq=brightness=-0.15/);
  assert.match(p, /overlay=\(W-w\)\/2:\(H-h\)\/2,eq=contrast=1\[o\]/);
});

test('locateRecord parses tool call, normalizes boxes, caches by bytes', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-'));
  const jpg = path.join(dir, 'a.jpg');
  // a real jpeg so sips can resize it
  const { execFileSync } = await import('child_process');
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x48', '-frames:v', '1', '-y', jpg]);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({
      content: [{ type: 'tool_use', name: 'locate_record', input: { images: [{ disc: { x: -0.1, y: 0.1, w: 1.3, h: 0.8 }, discFullyVisible: true, label: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }] } }],
      usage: { input_tokens: 900, output_tokens: 80 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await locateRecord([jpg], { cacheDir: dir, fetchImpl });
  assert.equal(r.cached, false);
  assert.equal(r.usage?.inputTokens, 900);
  assert.ok(r.results[0].disc && r.results[0].disc.x === 0 && r.results[0].disc.x + r.results[0].disc.w <= 1);
  const r2 = await locateRecord([jpg], { cacheDir: dir, fetchImpl });
  assert.equal(r2.cached, true);
  assert.equal(calls, 1);
});
