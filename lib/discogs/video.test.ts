import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickClip, findMusicStart, findBreaks, chunkPlan, LOOKS, DEFAULT_LOOK, type AnalysisWindow, type VideoAnalysis } from './video';

interface Band { loudness: number; low: number; mid: number }
const NORMAL: Band = { loudness: -14, low: -20, mid: -22 };
const BREAK: Band = { loudness: -17, low: -34, mid: -22 };

function synth(duration: number, f: (s: number) => Band): VideoAnalysis {
  const windows: AnalysisWindow[] = [];
  for (let s = 8; s < Math.floor(duration - 5); s++) windows.push({ start: s, ...f(s) });
  return { duration, windows };
}
const inRange = (s: number, a: number, b: number) => s >= a && s < b;

test('rich looks are defined and rich-plus is the default', () => {
  assert.equal(DEFAULT_LOOK, 'rich-plus');
  assert.match(LOOKS.rich, /saturation=1\.30/);
  assert.match(LOOKS['rich-plus'], /saturation=1\.45/);
  assert.match(LOOKS.rich, /vibrance=intensity=0\.15/);
});

test('music start skips needle/handling noise', () => {
  const a = synth(300, (s) => (s < 12 ? { loudness: -40, low: -50, mid: -45 } : NORMAL));
  assert.equal(findMusicStart(a.windows), 12);
});

test('break flagged at the beginning: clip starts on the break', () => {
  const a = synth(300, (s) => (inRange(s, 14, 24) ? BREAK : NORMAL));
  assert.deepEqual(findBreaks(a.windows, 8), [{ start: 14, end: 24 }]);
  const c = pickClip(a, { length: 60 });
  assert.equal(c.start, 14);
  assert.equal(c.end, 74);
  assert.match(c.reason, /break flagged at the beginning 14-24s/);
});

test('break later in the track does not move the clip: middle of the video', () => {
  const a = synth(300, (s) => (inRange(s, 150, 162) ? BREAK : NORMAL));
  const c = pickClip(a, { length: 60 });
  // music 8..295 => span 287; start = 8 + round((287-60)*0.5) = 122
  assert.equal(c.start, 122);
  assert.match(c.reason, /no break at the beginning: middle/);
  assert.equal(pickClip(a, { mode: 'beginning' }).start, 8);
});

test('no break: middle of the video', () => {
  const c = pickClip(synth(300, () => NORMAL));
  assert.equal(c.start, 122);
  assert.match(c.reason, /no break: middle/);
});

test('breaks shorter than 6 s or with the music also gone are ignored', () => {
  const short = synth(300, (s) => (inRange(s, 100, 105) ? BREAK : NORMAL));
  assert.equal(findBreaks(short.windows, 8).length, 0);
  const silent = synth(300, (s) => (inRange(s, 100, 112) ? { loudness: -45, low: -55, mid: -50 } : NORMAL));
  assert.equal(findBreaks(silent.windows, 8).length, 0);
});

test('break at the beginning of a short video is clamped to fit, never before music start', () => {
  // 80 s video: usable 8..75; break at 25 would end at 85 => shifted to 15..75
  const cb = pickClip(synth(80, (s) => (inRange(s, 25, 35) ? BREAK : NORMAL)), { length: 60 });
  assert.equal(cb.start, 15);
  assert.equal(cb.end, 75);
  assert.match(cb.reason, /clamped/);
  const fits = pickClip(synth(90, (s) => (inRange(s, 20, 30) ? BREAK : NORMAL)), { length: 60 });
  assert.equal(fits.start, 20);
  assert.equal(fits.end, 80);
});

test('short video uses what exists', () => {
  const c = pickClip(synth(40, () => NORMAL));
  assert.equal(c.start, 8);
  assert.equal(c.end, 35);
});

test('chunkPlan splits the clip into whole-second chunks that sum to the length', () => {
  assert.deepEqual(chunkPlan(60, 4), [15, 15, 15, 15]);
  assert.deepEqual(chunkPlan(61, 4), [15, 15, 15, 16]);
  assert.deepEqual(chunkPlan(10, 1), [10]);
  assert.deepEqual(chunkPlan(3, 4), [1, 1, 1]); // never more chunks than seconds
  for (const len of [7, 30, 59, 60, 120]) assert.equal(chunkPlan(len, 4).reduce((a, b) => a + b, 0), len);
});
