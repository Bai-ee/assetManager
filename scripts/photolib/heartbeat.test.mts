// npx tsx --test scripts/photolib/heartbeat.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, countDownloaded, currentSection, monthLabels, parseLines, ratePerMin } from './heartbeat.mts';

const log = (rows: string[]) => parseLines(rows.map((r, i) => `2026-11-09 12:${String(i).padStart(2, '0')}:00 ${r}`).join('\n'));

test('year-mode batch: download step, label is the year', () => {
  const s = currentSection(log(['=== batch 2020..2020 ===', 'INFO     Downloaded x']));
  assert.deepEqual([s.label, s.step, s.monthly], ['2020', 'download', false]);
});

test('monthly steps follow the latest step line', () => {
  const base = ['=== batch 2021..2021 ===', 'done 2021-01', '=== month 2021-02 ==='];
  const steps: [string[], string][] = [
    [[], 'download'],
    [['ok download'], 'plan'],
    [['ok download', 'plan: planId plan-1  {"items":42,"copy":40}  warnings 0'], 'apply'],
    [['ok download', 'plan: planId plan-1  {"items":42}', 'retry apply (1)'], 'apply'],
    [['ok download', 'plan: planId plan-1  {"items":42}', 'ok apply'], 'thumbs'],
    [['ok download', 'plan: planId plan-1  {"items":42}', 'ok apply', 'ok thumbs'], 'push'],
    [['ok download', 'plan: planId plan-1  {"items":42}', 'ok apply', 'ok thumbs', 'ok push'], 'verify'],
  ];
  for (const [more, want] of steps) {
    const s = currentSection(log([...base, ...more]));
    assert.equal(s.label, '2021-02'); assert.equal(s.step, want); assert.equal(s.monthly, true);
  }
  assert.equal(currentSection(log([...base, 'ok download', 'plan: planId p  {"items":42}'])).planItems, 42);
});

test('FAIL line is captured, reuse plan jumps to apply', () => {
  const s = currentSection(log(['=== month 2021-03 ===', 'ok download', 'FAIL plan: NAS dropped during hashing; re-run']));
  assert.match(s.failLine!, /^FAIL plan/);
  assert.equal(currentSection(log(['=== month 2021-03 ===', 'reusing plan plan-9'])).step, 'apply');
});

test('countDownloaded counts only after the last header', () => {
  const t = ['2026-11-09 12:00:00 === month 2021-01 ===', '2026-11-09 12:00:01 INFO     Downloaded a', '2026-11-09 12:01:00 === month 2021-02 ===',
    '2026-11-09 12:01:01 INFO     Downloaded b', '2026-11-09 12:01:02 DEBUG    Downloading c', '2026-11-09 12:01:03 INFO     Downloaded c'].join('\n');
  assert.equal(countDownloaded(t, null), 2);
});

test('clean strips paths, file names and e-mail', () => {
  const c = clean('FAIL: PHOTOLIB_PHOTOS_DB not found: /Users/x/Photos.sqlite for me@example.com IMG_0001.HEIC ok');
  assert.ok(!c.includes('/') && !c.includes('@') && !/IMG_0001/.test(c) && !/Photos\.sqlite/.test(c));
});

test('monthLabels run up to the current month', () => {
  const l = monthLabels(2025, new Date(2026, 10, 9));
  assert.equal(l[0], '2025-01'); assert.equal(l.at(-1), '2026-11'); assert.equal(l.length, 23);
});

test('ratePerMin needs >=10 min and growth', () => {
  const now = '2026-11-09T12:30:00.000Z';
  assert.equal(ratePerMin([{ t: '2026-11-09T12:00:00.000Z', assets: 1000 }], now, 1300), 10);
  assert.equal(ratePerMin([{ t: '2026-11-09T12:25:00.000Z', assets: 1000 }], now, 1300), null);
  assert.equal(ratePerMin([{ t: '2026-11-09T12:00:00.000Z', assets: 1000 }], now, 1000), null);
  assert.equal(ratePerMin([], now, 5), null);
});
