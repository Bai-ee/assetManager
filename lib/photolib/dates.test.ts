import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTakenDate, formatOffset, parseOffset, bucketOf } from './dates';
import type { ExifInfo } from './types';

const noExif = (o: Partial<ExifInfo> = {}): ExifInfo => ({
  dateTimeOriginal: null, offsetTimeOriginal: null, gpsDateTimeUtc: null, quicktimeCreationDate: null,
  quicktimeCreateDateUtc: null, lat: null, lon: null, contentIdentifier: null, make: null, model: null,
  width: null, height: null, durationSec: null, ...o,
});
const NONE = { imageDateUtc: null, tzOffsetSec: null };

test('formatOffset / parseOffset', () => {
  assert.equal(formatOffset(-25200), '-07:00');
  assert.equal(formatOffset(19800), '+05:30');
  assert.equal(formatOffset(0), '+00:00');
  assert.equal(formatOffset(-36000), '-10:00');
  assert.equal(parseOffset('+05:30'), 19800);
  assert.equal(parseOffset('-10:00'), -36000);
  assert.equal(parseOffset('-0700'), -25200);
  assert.equal(parseOffset('Z'), 0);
  assert.equal(parseOffset('junk'), null);
  assert.equal(parseOffset(null), null);
  assert.equal(parseOffset('+99:00'), null);
});

test('step 1: library-db with offset (recon fact)', () => {
  const r = resolveTakenDate({ imageDateUtc: '2018-06-22T06:19:38.000Z', tzOffsetSec: -25200 }, null);
  assert.deepEqual(r, {
    takenLocal: '2018-06-21T23:19:38', tz: '-07:00', tzOffsetSec: -25200,
    tsUtc: '2018-06-22T06:19:38.000Z', tsSource: 'library-db', tsKind: 'exact',
  });
});

test('step 1: library-db with +05:30 and -10:00', () => {
  const a = resolveTakenDate({ imageDateUtc: '2020-01-01T00:00:00.000Z', tzOffsetSec: 19800 }, null);
  assert.equal(a.takenLocal, '2020-01-01T05:30:00');
  assert.equal(a.tz, '+05:30');
  const b = resolveTakenDate({ imageDateUtc: '2020-01-01T05:00:00.000Z', tzOffsetSec: -36000 }, null);
  assert.equal(b.takenLocal, '2019-12-31T19:00:00');
  assert.equal(b.tz, '-10:00');
});

test('step 1: library-db without offset, uses EXIF DateTimeOriginal as local-only', () => {
  const r = resolveTakenDate({ imageDateUtc: '2018-06-22T06:19:38.000Z', tzOffsetSec: null }, noExif({ dateTimeOriginal: '2018:06:21:23:19:38'.replace(/:(\d\d):(\d\d):(\d\d)$/, ' $1:$2:$3') }));
  assert.equal(r.takenLocal, '2018-06-21T23:19:38');
  assert.equal(r.tz, null);
  assert.equal(r.tsUtc, null);
  assert.equal(r.tsSource, 'library-db');
  assert.equal(r.tsKind, 'local-only');
});

test('step 1: library-db without offset or exif -> UTC wall clock +00:00 exact', () => {
  const r = resolveTakenDate({ imageDateUtc: '2018-06-22T06:19:38.000Z', tzOffsetSec: null }, null);
  assert.equal(r.takenLocal, '2018-06-22T06:19:38');
  assert.equal(r.tz, '+00:00');
  assert.equal(r.tzOffsetSec, 0);
  assert.equal(r.tsKind, 'exact');
  assert.equal(r.tsSource, 'library-db');
});

test('step 1: library-db year < 1990 rejected, falls through', () => {
  const r = resolveTakenDate({ imageDateUtc: '1970-01-01T00:00:00.000Z', tzOffsetSec: 0 }, noExif({ dateTimeOriginal: '2015:03:04 05:06:07' }));
  assert.equal(r.tsSource, 'exif');
  assert.equal(r.takenLocal, '2015-03-04T05:06:07');
  const u = resolveTakenDate({ imageDateUtc: '1970-01-01T00:00:00.000Z', tzOffsetSec: 0 }, null);
  assert.equal(u.tsKind, 'unknown');
});

test('step 2: exif with OffsetTimeOriginal', () => {
  const r = resolveTakenDate(NONE, noExif({ dateTimeOriginal: '2019:07:04 12:30:00', offsetTimeOriginal: '+05:30' }));
  assert.deepEqual(r, {
    takenLocal: '2019-07-04T12:30:00', tz: '+05:30', tzOffsetSec: 19800,
    tsUtc: '2019-07-04T07:00:00.000Z', tsSource: 'exif', tsKind: 'exact',
  });
});

test('step 2: exif with -10:00 offset', () => {
  const r = resolveTakenDate(NONE, noExif({ dateTimeOriginal: '2019:07:04 02:00:00', offsetTimeOriginal: '-10:00' }));
  assert.equal(r.tsUtc, '2019-07-04T12:00:00.000Z');
  assert.equal(r.tz, '-10:00');
});

test('step 2: GPS-derived offset rounded to 15 min', () => {
  // local 12:30:07, gps 07:00:00Z -> 5:30:07 -> rounds to +05:30
  const r = resolveTakenDate(NONE, noExif({ dateTimeOriginal: '2019:07:04 12:30:07', gpsDateTimeUtc: '2019-07-04T07:00:00.000Z' }));
  assert.equal(r.tz, '+05:30');
  assert.equal(r.tsKind, 'exact');
  assert.equal(r.tsSource, 'exif');
  assert.equal(r.tsUtc, '2019-07-04T07:00:07.000Z');
  // negative: local 02:00:20, gps 12:00:00Z -> -9:59:40 -> -10:00
  const n = resolveTakenDate(NONE, noExif({ dateTimeOriginal: '2019:07:04 02:00:20', gpsDateTimeUtc: '2019-07-04T12:00:00.000Z' }));
  assert.equal(n.tz, '-10:00');
});

test('step 2: GPS offset > 14h is ignored -> local-only', () => {
  const r = resolveTakenDate(NONE, noExif({ dateTimeOriginal: '2019:07:04 23:00:00', gpsDateTimeUtc: '2019-07-04T01:00:00.000Z' }));
  assert.equal(r.tsKind, 'local-only');
});

test('step 2: exif local-only', () => {
  const r = resolveTakenDate(NONE, noExif({ dateTimeOriginal: '2019:07:04 12:30:00' }));
  assert.deepEqual(r, { takenLocal: '2019-07-04T12:30:00', tz: null, tzOffsetSec: null, tsUtc: null, tsSource: 'exif', tsKind: 'local-only' });
});

test('step 2: invalid / pre-1990 / zero exif dates are rejected', () => {
  assert.equal(resolveTakenDate(NONE, noExif({ dateTimeOriginal: '0000:00:00 00:00:00' })).tsKind, 'unknown');
  assert.equal(resolveTakenDate(NONE, noExif({ dateTimeOriginal: '1980:01:01 00:00:00' })).tsKind, 'unknown');
  assert.equal(resolveTakenDate(NONE, noExif({ dateTimeOriginal: 'garbage' })).tsKind, 'unknown');
});

test('step 3: QuickTime CreationDate tz-aware', () => {
  const r = resolveTakenDate(NONE, noExif({ quicktimeCreationDate: '2021:12:25 18:00:00-05:00' }));
  assert.deepEqual(r, {
    takenLocal: '2021-12-25T18:00:00', tz: '-05:00', tzOffsetSec: -18000,
    tsUtc: '2021-12-25T23:00:00.000Z', tsSource: 'quicktime', tsKind: 'exact',
  });
});

test('step 3: QuickTime CreateDate UTC', () => {
  const r = resolveTakenDate(NONE, noExif({ quicktimeCreateDateUtc: '2021-12-25T23:00:00.000Z' }));
  assert.equal(r.takenLocal, '2021-12-25T23:00:00');
  assert.equal(r.tz, '+00:00');
  assert.equal(r.tsSource, 'quicktime');
  assert.equal(r.tsKind, 'exact');
});

test('step 3: QuickTime CreationDate without tz falls to CreateDate; pre-1990 rejected', () => {
  const r = resolveTakenDate(NONE, noExif({ quicktimeCreationDate: '2021:12:25 18:00:00', quicktimeCreateDateUtc: '2020-01-02T03:04:05.000Z' }));
  assert.equal(r.takenLocal, '2020-01-02T03:04:05');
  const old = resolveTakenDate(NONE, noExif({ quicktimeCreateDateUtc: '1904-01-01T00:00:00.000Z' }));
  assert.equal(old.tsKind, 'unknown');
});

test('precedence: exif beats quicktime; library beats exif', () => {
  const ex = noExif({ dateTimeOriginal: '2019:07:04 12:30:00', quicktimeCreationDate: '2021:12:25 18:00:00-05:00' });
  assert.equal(resolveTakenDate(NONE, ex).tsSource, 'exif');
  assert.equal(resolveTakenDate({ imageDateUtc: '2018-06-22T06:19:38.000Z', tzOffsetSec: 0 }, ex).tsSource, 'library-db');
});

test('step 4: unknown', () => {
  assert.deepEqual(resolveTakenDate(NONE, null), { takenLocal: null, tz: null, tzOffsetSec: null, tsUtc: null, tsSource: null, tsKind: 'unknown' });
  assert.equal(resolveTakenDate(NONE, noExif()).tsKind, 'unknown');
});

test('bucketOf uses LOCAL day, not UTC day', () => {
  const r = resolveTakenDate({ imageDateUtc: '2018-06-22T06:19:38.000Z', tzOffsetSec: -25200 }, null);
  assert.equal(r.tsUtc?.slice(0, 10), '2018-06-22');
  assert.deepEqual(bucketOf(r), { ym: '2018-06', day: '2018-06-21' });
  // month boundary: UTC is July, local is June
  const m = resolveTakenDate({ imageDateUtc: '2018-07-01T02:00:00.000Z', tzOffsetSec: -25200 }, null);
  assert.deepEqual(bucketOf(m), { ym: '2018-06', day: '2018-06-30' });
  assert.deepEqual(bucketOf(resolveTakenDate(NONE, null)), { ym: 'unknown', day: null });
});
