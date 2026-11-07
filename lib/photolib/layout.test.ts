import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExt, canonicalPathFor, sidecarPathFor, assertSafeRelative, TIMELINE_ROOT } from './layout';
import type { ResolvedDate } from './types';

const SHA = 'ab12cd34ef56' + '0'.repeat(52);
const dated: ResolvedDate = { takenLocal: '2018-06-21T23:19:38', tz: '-07:00', tzOffsetSec: -25200, tsUtc: '2018-06-22T06:19:38.000Z', tsSource: 'library-db', tsKind: 'exact' };
const unknown: ResolvedDate = { takenLocal: null, tz: null, tzOffsetSec: null, tsUtc: null, tsSource: null, tsKind: 'unknown' };

test('TIMELINE_ROOT', () => assert.equal(TIMELINE_ROOT, 'HITLOOP-ARCHIVE/timeline'));

test('normalizeExt', () => {
  assert.equal(normalizeExt('IMG_9036.JPG'), 'jpg');
  assert.equal(normalizeExt('a.JPEG'), 'jpg');
  assert.equal(normalizeExt('a.tif'), 'tif');
  assert.equal(normalizeExt('clip.MOV'), 'mov');
  assert.equal(normalizeExt('dir/sub.x/IMG.HEIC'), 'heic');
  assert.equal(normalizeExt('noext'), '');
  assert.equal(normalizeExt('trailing.'), '');
  assert.equal(normalizeExt('a.tar.gz'), 'gz');
});

test('canonicalPathFor dated', () => {
  assert.equal(canonicalPathFor(dated, SHA, 'jpg'), 'HITLOOP-ARCHIVE/timeline/2018/06/2018-06-21_231938_ab12cd34.jpg');
  assert.equal(canonicalPathFor(dated, SHA.toUpperCase(), '.JPEG'), 'HITLOOP-ARCHIVE/timeline/2018/06/2018-06-21_231938_ab12cd34.jpg');
});

test('canonicalPathFor roles', () => {
  assert.equal(canonicalPathFor(dated, SHA, 'mov', 'motion'), 'HITLOOP-ARCHIVE/timeline/2018/06/2018-06-21_231938_ab12cd34_motion.mov');
  assert.equal(canonicalPathFor(dated, SHA, 'jpg', 'edited'), 'HITLOOP-ARCHIVE/timeline/2018/06/2018-06-21_231938_ab12cd34_edited.jpg');
  assert.equal(canonicalPathFor(unknown, SHA, 'mov', 'motion'), 'HITLOOP-ARCHIVE/timeline/unknown/ab12cd34_motion.mov');
});

test('canonicalPathFor unknown', () => {
  assert.equal(canonicalPathFor(unknown, SHA, 'png'), 'HITLOOP-ARCHIVE/timeline/unknown/ab12cd34.png');
});

test('canonicalPathFor rejects bad input', () => {
  assert.throws(() => canonicalPathFor(dated, 'xyz', 'jpg'));
  assert.throws(() => canonicalPathFor(dated, SHA, '../x'));
  assert.throws(() => canonicalPathFor(dated, SHA, ''));
  assert.throws(() => canonicalPathFor({ ...dated, takenLocal: 'nope' }, SHA, 'jpg'));
});

test('sidecarPathFor', () => {
  assert.equal(sidecarPathFor(SHA), `HITLOOP-ARCHIVE/timeline/_meta/${SHA}.json`);
  assert.throws(() => sidecarPathFor('abc'));
});

test('assertSafeRelative', () => {
  assert.equal(assertSafeRelative('HITLOOP-ARCHIVE/timeline/x.jpg'), 'HITLOOP-ARCHIVE/timeline/x.jpg');
  assert.throws(() => assertSafeRelative('/abs/path'));
  assert.throws(() => assertSafeRelative('a/../b'));
  assert.throws(() => assertSafeRelative('..'));
  assert.throws(() => assertSafeRelative('a\0b'));
  assert.throws(() => assertSafeRelative(''));
  assert.doesNotThrow(() => assertSafeRelative('a/b..c/d'));
});
