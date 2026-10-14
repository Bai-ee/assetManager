import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArchiveDatabase } from '../database';
import { appendMoveJournalLine, journalPath, listOrganizeMovesForJob, readMoveJournal, recordOrganizeMove } from './journal';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hitloop-organize-journal-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const db = new ArchiveDatabase(dbPath);
  return { dir, db };
}

test('readMoveJournal returns [] before any move is journaled', async () => {
  const f = await fixture();
  const entries = await readMoveJournal(f.dir, 'c1');
  assert.deepEqual(entries, []);
  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('appendMoveJournalLine writes one JSON line per call, readable back in order', async () => {
  const f = await fixture();
  await appendMoveJournalLine(f.dir, 'c1', { ts: '2026-09-20T00:00:00.000Z', jobId: 'job-1', sha256: 'aa', from: 'clip.mp4', to: 'HITLOOP-ARCHIVE/c1/was-there/clip.mp4', sizeBytes: 10, reason: 'organize' });
  await appendMoveJournalLine(f.dir, 'c1', { ts: '2026-09-20T00:00:01.000Z', jobId: 'job-1', sha256: 'bb', from: 'photo.jpg', to: 'HITLOOP-ARCHIVE/c1/_unsorted/photo.jpg', sizeBytes: 20, reason: 'organize' });

  const entries = await readMoveJournal(f.dir, 'c1');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sha256, 'aa');
  assert.equal(entries[1].sha256, 'bb');

  const raw = await fs.readFile(journalPath(f.dir, 'c1'), 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 2);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('recordOrganizeMove mirrors into SQLite, retrievable by jobId in write order', async () => {
  const f = await fixture();
  recordOrganizeMove(f.db, { jobId: 'job-1', sha256: 'aa', from: 'clip.mp4', to: 'HITLOOP-ARCHIVE/c1/was-there/clip.mp4', sizeBytes: 10, reason: 'organize' });
  recordOrganizeMove(f.db, { jobId: 'job-1', sha256: 'bb', from: 'photo.jpg', to: 'HITLOOP-ARCHIVE/c1/_unsorted/photo.jpg', sizeBytes: 20, reason: 'organize' });
  recordOrganizeMove(f.db, { jobId: 'job-2', sha256: 'cc', from: 'other.jpg', to: 'HITLOOP-ARCHIVE/c2/_unsorted/other.jpg', sizeBytes: 30, reason: 'organize' });

  const rows = listOrganizeMovesForJob(f.db, 'job-1');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.sha256), ['aa', 'bb']);
  assert.equal(rows[0].reason, 'organize');

  assert.equal(f.db.findLatestOrganizeJobIdForCollection('c1'), 'job-1');
  assert.equal(f.db.findLatestOrganizeJobIdForCollection('c2'), 'job-2');
  assert.equal(f.db.findLatestOrganizeJobIdForCollection('no-such-collection'), undefined);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});
