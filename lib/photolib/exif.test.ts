import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toExifInfo, readExif, readExifBatch, closeExif, getExifTool } from './exif';

after(() => closeExif());

const dtObj = (raw: string, iso: string) => ({ rawValue: raw, toISOString: () => iso });

test('toExifInfo: plain strings, photo', () => {
  const i = toExifInfo({
    DateTimeOriginal: '2018:10:24 20:10:30', OffsetTimeOriginal: '-07:00', GPSDateTime: '2018:10:25 03:10:28Z',
    GPSLatitude: 37.5, GPSLongitude: -122.25, ContentIdentifier: 'ABC-123', Make: 'Apple', Model: 'iPhone 7',
    ImageWidth: 4032, ImageHeight: 3024, CreateDate: '2018:10:24 20:10:30', MIMEType: 'image/jpeg',
  });
  assert.deepEqual(i, {
    dateTimeOriginal: '2018:10:24 20:10:30', offsetTimeOriginal: '-07:00', gpsDateTimeUtc: '2018-10-25T03:10:28.000Z',
    quicktimeCreationDate: null, quicktimeCreateDateUtc: null, lat: 37.5, lon: -122.25, contentIdentifier: 'ABC-123',
    make: 'Apple', model: 'iPhone 7', width: 4032, height: 3024, durationSec: null,
  });
});

test('toExifInfo: ExifDateTime-like objects', () => {
  const i = toExifInfo({
    DateTimeOriginal: dtObj('2018:10:24 20:10:30', '2018-10-24T20:10:30'),
    GPSDateTime: dtObj('2018:10:25 03:10:28Z', '2018-10-25T03:10:28.000Z'),
  });
  assert.equal(i.dateTimeOriginal, '2018:10:24 20:10:30');
  assert.equal(i.gpsDateTimeUtc, '2018-10-25T03:10:28.000Z');
});

test('toExifInfo: object without rawValue falls back to toISOString', () => {
  const i = toExifInfo({ DateTimeOriginal: { toISOString: () => '2018-10-24T20:10:30.000-07:00' } });
  assert.equal(i.dateTimeOriginal, '2018:10:24 20:10:30');
});

test('toExifInfo: video', () => {
  const i = toExifInfo({
    MIMEType: 'video/quicktime', CreationDate: '2021:12:25 18:00:00-05:00', CreateDate: dtObj('2021:12:25 23:00:00', '2021-12-25T23:00:00.000Z'),
    Duration: 3.04, ContentIdentifier: 'LIVE-1', ImageWidth: 1440, ImageHeight: 1080,
  });
  assert.equal(i.quicktimeCreationDate, '2021:12:25 18:00:00-05:00');
  assert.equal(i.quicktimeCreateDateUtc, '2021-12-25T23:00:00.000Z');
  assert.equal(i.durationSec, 3.04);
  assert.equal(i.contentIdentifier, 'LIVE-1');
  assert.equal(i.dateTimeOriginal, null);
});

test('toExifInfo: CreateDate on a photo is not treated as UTC', () => {
  assert.equal(toExifInfo({ MIMEType: 'image/jpeg', CreateDate: '2018:10:24 20:10:30' }).quicktimeCreateDateUtc, null);
});

test('toExifInfo: zero dates rejected', () => {
  const i = toExifInfo({ DateTimeOriginal: '0000:00:00 00:00:00', MIMEType: 'video/mp4', CreateDate: '0000:00:00 00:00:00', CreationDate: '0000:00:00 00:00:00+00:00' });
  assert.equal(i.dateTimeOriginal, null);
  assert.equal(i.quicktimeCreateDateUtc, null);
  assert.equal(i.quicktimeCreationDate, null);
});

test('toExifInfo: durations, coords, empties', () => {
  assert.equal(toExifInfo({ Duration: '0:00:03' }).durationSec, 3);
  assert.equal(toExifInfo({ Duration: '3.5 s' }).durationSec, 3.5);
  assert.equal(toExifInfo({ GPSLatitude: '12.5', GPSLatitudeRef: 'S' }).lat, -12.5);
  const e = toExifInfo({});
  assert.ok(Object.values(e).every((v) => v === null));
  assert.equal(toExifInfo({ Make: '  ' }).make, null);
});

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('real file: write + read DateTimeOriginal', { skip: !hasFfmpeg && 'ffmpeg missing' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photolib-exif-'));
  try {
    const f = path.join(dir, 'x.jpg');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', f]);
    await getExifTool().write(f, { DateTimeOriginal: '2018:06:21 23:19:38', OffsetTimeOriginal: '-07:00', Make: 'TestCam' } as never, ['-overwrite_original']);
    const i = await readExif(f);
    assert.equal(i.dateTimeOriginal, '2018:06:21 23:19:38');
    assert.equal(i.offsetTimeOriginal, '-07:00');
    assert.equal(i.make, 'TestCam');
    assert.equal(i.width, 64);
    assert.equal(i.height, 64);
    const batch = await readExifBatch([f, path.join(dir, 'missing.jpg')], { concurrency: 2 });
    assert.equal(batch.get(f)?.make, 'TestCam');
    assert.equal(batch.get(path.join(dir, 'missing.jpg')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
