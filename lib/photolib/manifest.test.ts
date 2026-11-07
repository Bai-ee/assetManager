import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { Manifest, type AssetRow } from './manifest';
import { tmpDir } from './test-fixtures';

const asset = (sha: string, over: Partial<AssetRow> = {}): AssetRow => ({
  sha256: sha, id: sha.slice(0, 16), kind: 'image', ext: 'jpg', sizeBytes: 5, width: null, height: null, durationSec: null, takenLocal: '2018-06-21T10:00:00', tz: '+00:00', tzOffsetSec: 0,
  tsUtc: null, tsSource: null, tsKind: 'exact', lat: null, lon: null, canonicalPath: `HITLOOP-ARCHIVE/timeline/x/${sha}.jpg`, sidecarPath: `HITLOOP-ARCHIVE/timeline/_meta/${sha}.json`,
  sidecarJson: '{}', copiedAt: 't', verifiedAt: 't', thumbS: null, thumbM: null, pushedAt: null, pushHash: null, updatedAt: 't', ...over,
});

test('manifest: WAL, assets, hash cache, thumbs/push listing, journal, cascade delete', () => {
  const m = new Manifest(path.join(tmpDir(), 'sub', 'photolib.sqlite'));
  assert.equal(String(m.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  m.upsertSource({ id: 's', kind: 'photos', libraryPath: 'a/b.photoslibrary', label: null, addedAt: 't' });
  m.upsertAsset(asset('aa')); m.upsertAsset(asset('bb'));
  m.upsertAsset(asset('aa', { width: 99 }));
  assert.equal(m.getAsset('aa')?.width, 99);
  assert.equal(m.getAsset('zz'), undefined);

  m.putLocation({ sourceId: 's', relativePath: 'Masters/a.jpg', sha256: 'aa', masterUuid: 'm', versionUuid: null, originalFileName: 'a.jpg' });
  assert.equal(m.getCachedHash('s', 'Masters/a.jpg', 5), 'aa');
  assert.equal(m.getCachedHash('s', 'Masters/a.jpg', 6), null, 'size change invalidates');
  assert.equal(m.getCachedHash('s', 'Masters/other.jpg', 5), null);

  m.upsertChild({ parentSha: 'aa', role: 'motion', sha256: 'cc', ext: 'mov', sizeBytes: 3, durationSec: null, canonicalPath: 'p', copiedAt: 't' });
  assert.equal(m.listChildren('aa').length, 1);

  assert.equal(m.listAssets({ missingThumbs: true }).length, 2);
  m.setThumbs('aa', 's.jpg', 'm.jpg');
  assert.deepEqual(m.listAssets({ missingThumbs: true }).map(a => a.sha256), ['bb']);
  assert.equal(m.listAssets({ needsPush: true }).length, 2);
  m.markPushed('aa', 'h1');
  assert.deepEqual(m.listAssets({ needsPush: true }).map(a => a.sha256), ['bb']);
  assert.equal(m.listAssets({ limit: 1 }).length, 1);

  m.startRun({ runId: 'r1', sourceId: 's', command: 'apply' });
  const j = m.journal({ runId: 'r1', sha256: 'aa', role: 'primary', destPath: 'd', sizeBytes: 5, at: 't' });
  assert.equal(m.journalForRun('r1').length, 1);
  m.markUndone(j);
  assert.ok(m.journalForRun('r1')[0].undoneAt);
  m.finishRun('r1', 'completed', { n: 1 });
  assert.equal(m.getRun('r1')?.state, 'completed');

  m.deleteAsset('aa');
  assert.equal(m.getAsset('aa'), undefined);
  assert.equal(m.listChildren('aa').length, 0);
  assert.equal(m.getCachedHash('s', 'Masters/a.jpg', 5), null);
  m.close();
});

test('manifest: reopen persists (migrate is idempotent)', () => {
  const f = path.join(tmpDir(), 'p.sqlite');
  const a = new Manifest(f); a.upsertAsset(asset('aa')); a.close();
  const b = new Manifest(f); assert.ok(b.getAsset('aa')); b.close();
});
