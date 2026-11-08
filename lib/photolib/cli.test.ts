import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDestRootSafe, assertLibrary, deriveSourceId, libraryKindOf, parseArgs, shareRelative, slug } from './cli';

test('parseArgs: command, flags, defaults', () => {
  const a = parseArgs(['apply', '--library', '/Volumes/bryan/D/L.photoslibrary', '--limit', '25', '--force', '--json', '--plan', 'plan-1', '--source-id', 'x', '--run', 'r1', '--dest-root', '/Volumes/other']);
  assert.deepEqual(a, { command: 'apply', library: '/Volumes/bryan/D/L.photoslibrary', destRoot: '/Volumes/other', sourceId: 'x', limit: 25, plan: 'plan-1', run: 'r1', force: true, json: true, mode: 'copy' });
  const d = parseArgs(['status']);
  assert.equal(d.destRoot, '/Volumes/bryan'); assert.equal(d.force, false); assert.equal(d.json, false);
});

test('parseArgs rejects bad input', () => {
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['explode']), /Usage/);
  assert.throws(() => parseArgs(['plan', '--limit', 'abc']), /limit/);
  assert.throws(() => parseArgs(['plan', '--library']), /needs a value/);
  assert.throws(() => parseArgs(['plan', '--library', '--json']), /needs a value/);
  assert.throws(() => parseArgs(['plan', '--wat']), /Unknown argument/);
  assert.throws(() => parseArgs(['apply', '--mode', 'delete']), /copy or move/);
  assert.throws(() => parseArgs(['plan', '--mode', 'move']), /only apply to the apply command/);
  assert.throws(() => parseArgs(['apply', '--photos-db', 'rel/Photos.sqlite']), /absolute/);
  assert.equal(parseArgs(['apply', '--mode', 'move', '--photos-db', '/t/Photos.sqlite']).mode, 'move');
});

test('libraryKindOf / slug', () => {
  assert.equal(libraryKindOf('/x/Photos Library.photoslibrary'), 'photos');
  assert.equal(libraryKindOf('/x/Photos Library.photoslibrary/'), 'photos');
  assert.equal(libraryKindOf('/x/y.migratedphotolibrary'), 'photos');
  assert.equal(libraryKindOf('/x/y.photolibrary'), 'iphoto');
  assert.equal(libraryKindOf('/x/iPhoto Library'), 'iphoto');
  assert.equal(libraryKindOf('/x/Pictures'), null);
  assert.equal(slug('Drive 1 Backup'), 'drive-1-backup');
  assert.equal(slug('Été & Co.'), 'ete-co');
});

test('deriveSourceId', () => {
  assert.equal(deriveSourceId('/Volumes/bryan/FTP Server Backup/Drive 1 Backup/Photos Library.photoslibrary'), 'photos-drive-1-backup');
  assert.equal(deriveSourceId('/Volumes/bryan/Old Mac/Pictures/iPhoto Library'), 'iphoto-old-mac');
  assert.equal(deriveSourceId('/Volumes/bryan/Disk 2/2009.photolibrary'), 'iphoto-disk-2');
  assert.throws(() => deriveSourceId('/Volumes/bryan/Pictures'), /recognised/);
});

test('assertLibrary', () => {
  assert.equal(assertLibrary('/a/b/L.photoslibrary/'), '/a/b/L.photoslibrary');
  assert.throws(() => assertLibrary(undefined), /required/);
  assert.throws(() => assertLibrary('rel/L.photoslibrary'), /absolute/);
  assert.throws(() => assertLibrary('/a/b/folder'), /recognised/);
});

test('assertDestRootSafe refuses dest roots inside (or equal to) the bundle', () => {
  const lib = '/Volumes/bryan/D/L.photoslibrary';
  assert.equal(assertDestRootSafe('/Volumes/bryan', lib), '/Volumes/bryan');
  assert.equal(assertDestRootSafe('/Volumes/bryan/D/L.photoslibrary-copy', lib), '/Volumes/bryan/D/L.photoslibrary-copy');
  assert.throws(() => assertDestRootSafe(lib, lib), /inside the library/);
  assert.throws(() => assertDestRootSafe(`${lib}/Masters`, lib), /inside the library/);
  assert.throws(() => assertDestRootSafe(`${lib}/../L.photoslibrary/x`, lib), /inside the library/);
});

test('shareRelative', () => {
  assert.equal(shareRelative('/Volumes/bryan', '/Volumes/bryan/D/L.photoslibrary'), 'D/L.photoslibrary');
  assert.equal(shareRelative('/Volumes/bryan', '/Users/me/L.photoslibrary'), null);
});
