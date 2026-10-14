import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArchiveDatabase } from '../database';
import { ArchiveWorker } from '../worker';
import { JEV_QUESTIONS } from '../jev/taxonomy';
import { planOrganizeCollection } from './planner';
import { applyOrganizePlan, undoOrganizeJob } from './mover';
import { readMoveJournal } from './journal';
import { ORGANIZED_ROOT_NAME } from './scheme';

const PILLAR_QUESTION = JEV_QUESTIONS.find(q => q.id === 'pillar')!.question;

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hitloop-organize-mover-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const sourceRoot = path.join(dir, 'nas');
  await fs.mkdir(sourceRoot, { recursive: true });
  const db = new ArchiveDatabase(dbPath);
  const worker = new ArchiveWorker(db, { stableFileDwellMs: 0, heartbeatEveryFiles: 1 });
  return { dir, sourceRoot, db, worker };
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

test('apply moves canonical assets into HITLOOP-ARCHIVE, then undo restores byte-identical layout', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'VIDEO-BYTES');
  await fs.writeFile(path.join(f.sourceRoot, 'photo.jpg'), 'IMAGE-BYTES');

  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id, '.').id);

  const clipLoc = f.db.getLocationByRelativePath(source.id, 'clip.mp4')!;
  f.db.upsertJevDecision({
    id: 'd1', contentAssetId: clipLoc.contentAssetId!, question: PILLAR_QUESTION,
    choices: [{ value: 'made-this', probability: 0.92 }], selectedValue: 'made-this', confidence: 0.92, status: 'AUTO_CONFIRM',
  });

  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: '.' });
  assert.equal(plan.moves.length, 2);

  const jobId = 'apply-job-1';
  const applied = await applyOrganizePlan({ db: f.db, source, jobId, plan });
  assert.equal(applied.failedAt, undefined);
  assert.equal(applied.moved.length, 2);

  // Source paths gone; organized paths hold the original bytes.
  assert.equal(await exists(path.join(f.sourceRoot, 'clip.mp4')), false);
  assert.equal(await exists(path.join(f.sourceRoot, 'photo.jpg')), false);
  const clipMove = applied.moved.find(m => m.from === 'clip.mp4')!;
  const photoMove = applied.moved.find(m => m.from === 'photo.jpg')!;
  assert.equal(clipMove.pillar, 'made-this');
  assert.equal(photoMove.pillar, '_unsorted');
  assert.equal(await fs.readFile(path.join(f.sourceRoot, clipMove.to), 'utf8'), 'VIDEO-BYTES');
  assert.equal(await fs.readFile(path.join(f.sourceRoot, photoMove.to), 'utf8'), 'IMAGE-BYTES');

  // SQLite reflects the move.
  const clipLocAfter = f.db.getLocationByRelativePath(source.id, 'clip.mp4')!;
  assert.equal(clipLocAfter.organizedPath, clipMove.to);
  assert.ok(clipLocAfter.organizedAt);

  const moveRows = f.db.listOrganizeMoves(jobId);
  assert.equal(moveRows.length, 2);
  assert.ok(moveRows.every(r => r.reason === 'organize'));

  // Journal + sidecars on disk.
  const journal = await readMoveJournal(f.sourceRoot, plan.collectionId);
  assert.equal(journal.length, 2);
  const collectionJson = JSON.parse(await fs.readFile(path.join(plan.root, plan.collectionId, '_meta', 'collection.json'), 'utf8'));
  assert.equal(collectionJson.assets.length, 2);
  const recordJson = JSON.parse(await fs.readFile(path.join(plan.root, plan.collectionId, '_meta', `${clipMove.sha256.slice(0, 12)}.record.json`), 'utf8'));
  assert.equal(recordJson.sha256, clipMove.sha256);
  assert.equal(recordJson.originalRelativePath, 'clip.mp4');

  // Undo restores the original layout exactly.
  const undone = await undoOrganizeJob({ db: f.db, source, jobId });
  assert.equal(undone.errors.length, 0);
  assert.equal(undone.restored.length, 2);

  assert.equal(await exists(path.join(f.sourceRoot, 'clip.mp4')), true);
  assert.equal(await exists(path.join(f.sourceRoot, 'photo.jpg')), true);
  assert.equal(await exists(path.join(f.sourceRoot, clipMove.to)), false);
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'clip.mp4'), 'utf8'), 'VIDEO-BYTES');
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'photo.jpg'), 'utf8'), 'IMAGE-BYTES');

  const clipLocRestored = f.db.getLocationByRelativePath(source.id, 'clip.mp4')!;
  assert.equal(clipLocRestored.organizedPath, undefined);
  assert.equal(clipLocRestored.organizedAt, undefined);

  assert.equal(f.db.listOrganizeMoves(jobId).length, 4); // 2 organize + 2 undo

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('apply refuses a move whose target escapes HITLOOP-ARCHIVE and leaves the source untouched', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'VIDEO-BYTES');
  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id, '.').id);

  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: '.' });
  assert.equal(plan.moves.length, 1);
  // Tamper with the plan the way a bug elsewhere might: point `to` outside
  // HITLOOP-ARCHIVE/.
  const badPlan = { ...plan, moves: [{ ...plan.moves[0], to: 'not-organized/clip.mp4' }] };

  const applied = await applyOrganizePlan({ db: f.db, source, jobId: 'apply-job-escape', plan: badPlan });
  assert.ok(applied.failedAt);
  assert.match(applied.failedAt!.error, new RegExp(ORGANIZED_ROOT_NAME));
  assert.equal(applied.moved.length, 0);

  assert.equal(await exists(path.join(f.sourceRoot, 'clip.mp4')), true);
  assert.equal(await exists(path.join(f.sourceRoot, 'not-organized', 'clip.mp4')), false);
  assert.equal(f.db.listOrganizeMoves('apply-job-escape').length, 0);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('apply from an items-selection plan records `selection` (not `sourceRelativePath`) in the collection sidecar', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'clip.mp4'), 'VIDEO-BYTES');
  await fs.writeFile(path.join(f.sourceRoot, 'loose.jpg'), 'IMAGE-BYTES');

  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id, '.').id);

  const items = [
    { relativePath: 'folderA', kind: 'folder' as const },
    { relativePath: 'loose.jpg', kind: 'file' as const },
  ];
  const plan = await planOrganizeCollection({ db: f.db, source, collectionId: 'my-picks', items });
  assert.equal(plan.moves.length, 2);

  const applied = await applyOrganizePlan({ db: f.db, source, jobId: 'apply-job-items', plan });
  assert.equal(applied.failedAt, undefined);
  assert.equal(applied.moved.length, 2);

  const collectionJson = JSON.parse(await fs.readFile(path.join(plan.root, 'my-picks', '_meta', 'collection.json'), 'utf8'));
  assert.equal(collectionJson.collectionId, 'my-picks');
  assert.equal(collectionJson.title, 'my-picks');
  assert.deepEqual(collectionJson.selection, items);
  assert.equal(collectionJson.sourceRelativePath, undefined);
  assert.equal(collectionJson.assets.length, 2);

  // Undo works exactly the same, resolved by collectionId.
  const undone = await undoOrganizeJob({ db: f.db, source, jobId: 'apply-job-items' });
  assert.equal(undone.errors.length, 0);
  assert.equal(undone.restored.length, 2);
  assert.equal(await exists(path.join(f.sourceRoot, 'folderA', 'clip.mp4')), true);
  assert.equal(await exists(path.join(f.sourceRoot, 'loose.jpg')), true);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a mid-plan failure stops the job; already-moved files stay moved and recoverable', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'VIDEO-BYTES');
  await fs.writeFile(path.join(f.sourceRoot, 'photo.jpg'), 'IMAGE-BYTES');
  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id, '.').id);

  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: '.' });
  assert.equal(plan.moves.length, 2);
  const [good, ...rest] = plan.moves;
  // Second move references a location the DB has no row for (simulates a
  // stale/tampered plan) -> applyOrganizePlan must fail closed on it.
  const brokenPlan = { ...plan, moves: [good, { ...rest[0], from: 'missing-from-db.mp4' }] };

  const jobId = 'apply-job-partial';
  const applied = await applyOrganizePlan({ db: f.db, source, jobId, plan: brokenPlan });
  assert.ok(applied.failedAt);
  assert.equal(applied.moved.length, 1);
  assert.equal(applied.moved[0].from, good.from);

  // The one good move actually happened and is journaled…
  assert.equal(await exists(path.join(f.sourceRoot, good.to)), true);
  assert.equal(await exists(path.join(f.sourceRoot, good.from)), false);
  assert.equal(f.db.listOrganizeMoves(jobId).length, 1);
  // …and the file this run never got to is exactly where it always was.
  const untouchedFrom = rest[0].from;
  assert.equal(await exists(path.join(f.sourceRoot, untouchedFrom)), true);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});
