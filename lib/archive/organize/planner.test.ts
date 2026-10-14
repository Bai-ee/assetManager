import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArchiveDatabase } from '../database';
import { ArchiveWorker } from '../worker';
import { JEV_QUESTIONS } from '../jev/taxonomy';
import { planOrganizeCollection, type OrganizePlanMove, type OrganizePlanSkip } from './planner';
import { ORGANIZED_ROOT_NAME } from './scheme';

const PILLAR_QUESTION = JEV_QUESTIONS.find(q => q.id === 'pillar')!.question;

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hitloop-organize-planner-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const sourceRoot = path.join(dir, 'nas');
  await fs.mkdir(sourceRoot, { recursive: true });
  const db = new ArchiveDatabase(dbPath);
  const worker = new ArchiveWorker(db, { stableFileDwellMs: 0, heartbeatEveryFiles: 1 });
  return { dir, dbPath, sourceRoot, db, worker };
}

function findMove(moves: OrganizePlanMove[], from: string) {
  return moves.find(m => m.from === from);
}
function findSkip(skipped: OrganizePlanSkip[], p: string) {
  return skipped.find(s => s.path === p);
}

/** Builds the full "video + image + audio + Ableton project folder +
 * duplicate + a `._` file" fixture tree, hashes it with the real worker, and
 * seeds two jev pillar decisions (one AUTO_CONFIRM-band, one below the
 * QUICK_REVIEW band). Returns the source, plan-ready db, plus which of
 * clip.mp4/clip-dup.mp4 the worker actually hashed as canonical — directory
 * iteration order (`fs.opendir`) is not alphabetical/creation-order, so
 * either file may end up HASHED vs DUPLICATE from one run to the next. */
async function buildAndHash(f: Awaited<ReturnType<typeof fixture>>) {
  const root = f.sourceRoot;
  await fs.writeFile(path.join(root, 'clip.mp4'), 'VIDEO-A-BYTES');
  await fs.writeFile(path.join(root, 'clip-dup.mp4'), 'VIDEO-A-BYTES'); // same bytes -> one of the two becomes DUPLICATE
  await fs.writeFile(path.join(root, 'photo.jpg'), 'IMAGE-A-BYTES'); // never gets a jev decision
  await fs.writeFile(path.join(root, 'lowconf.mp4'), 'VIDEO-B-BYTES'); // jev decision below QUICK_REVIEW
  await fs.writeFile(path.join(root, 'track.wav'), 'AUDIO-A-BYTES');
  await fs.writeFile(path.join(root, '._clip.mp4'), 'apple double garbage');
  await fs.writeFile(path.join(root, '.DS_Store'), 'finder metadata');
  await fs.mkdir(path.join(root, 'My Song Project', 'Samples'), { recursive: true });
  await fs.writeFile(path.join(root, 'My Song Project', 'song.als'), 'ableton project binary');
  await fs.writeFile(path.join(root, 'My Song Project', 'render.mp4'), 'VIDEO-C-BYTES'); // movable ext, but inside project folder
  await fs.writeFile(path.join(root, 'My Song Project', 'Samples', 'sample.wav'), 'sample audio');

  const source = await f.worker.registerSource('nas', root);
  const job = f.worker.createJob(source.id, '.');
  const done = await f.worker.run(job.id);
  assert.equal(done.state, 'COMPLETE');

  const clipLoc = f.db.getLocationByRelativePath(source.id, 'clip.mp4')!;
  const clipDupLoc = f.db.getLocationByRelativePath(source.id, 'clip-dup.mp4')!;
  const lowconfLoc = f.db.getLocationByRelativePath(source.id, 'lowconf.mp4')!;
  assert.ok(clipLoc?.contentAssetId);
  assert.ok(lowconfLoc?.contentAssetId);
  assert.notEqual(clipLoc.state, clipDupLoc.state); // exactly one HASHED, one DUPLICATE
  const canonicalVideoName = clipLoc.state === 'DUPLICATE' ? 'clip-dup.mp4' : 'clip.mp4';
  const duplicateVideoName = clipLoc.state === 'DUPLICATE' ? 'clip.mp4' : 'clip-dup.mp4';
  const canonicalVideoLoc = clipLoc.state === 'DUPLICATE' ? clipDupLoc : clipLoc;

  f.db.upsertJevDecision({
    id: 'decision-clip-pillar', contentAssetId: canonicalVideoLoc.contentAssetId!, question: PILLAR_QUESTION,
    choices: [{ value: 'was-there', probability: 0.95 }], selectedValue: 'was-there', confidence: 0.95, status: 'AUTO_CONFIRM',
  });
  f.db.upsertJevDecision({
    id: 'decision-lowconf-pillar', contentAssetId: lowconfLoc.contentAssetId!, question: PILLAR_QUESTION,
    choices: [{ value: 'made-this', probability: 0.4 }], selectedValue: 'made-this', confidence: 0.4, status: 'IDENTIFICATION_REQUIRED',
  });
  // photo.jpg intentionally gets no jev decision at all (image, no video-understanding evidence).

  return { source, canonicalVideoName, duplicateVideoName };
}

test('plans exactly the expected moves and skips, and writes nothing to disk', async () => {
  const f = await fixture();
  const { source, canonicalVideoName, duplicateVideoName } = await buildAndHash(f);

  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: '.' });

  assert.equal(plan.collectionId, 'root');
  assert.equal(plan.root, path.join(path.resolve(f.sourceRoot), ORGANIZED_ROOT_NAME));
  assert.equal(plan.counts.moves, 3);
  assert.equal(plan.counts.skipped, 7);

  const clipMove = findMove(plan.moves, canonicalVideoName);
  assert.ok(clipMove);
  assert.equal(clipMove!.pillar, 'was-there');
  assert.equal(clipMove!.confidence, 0.95);
  assert.equal(clipMove!.to, path.join(ORGANIZED_ROOT_NAME, 'root', 'was-there', canonicalVideoName));
  assert.equal(clipMove!.sizeBytes, Buffer.byteLength('VIDEO-A-BYTES'));

  const photoMove = findMove(plan.moves, 'photo.jpg');
  assert.ok(photoMove);
  assert.equal(photoMove!.pillar, '_unsorted');
  assert.equal(photoMove!.confidence, null);
  assert.equal(photoMove!.to, path.join(ORGANIZED_ROOT_NAME, 'root', '_unsorted', 'photo.jpg'));

  const lowconfMove = findMove(plan.moves, 'lowconf.mp4');
  assert.ok(lowconfMove);
  assert.equal(lowconfMove!.pillar, '_unsorted'); // has a selectedValue, but confidence is below QUICK_REVIEW
  assert.equal(lowconfMove!.confidence, 0.4);

  assert.equal(findSkip(plan.skipped, duplicateVideoName)?.reason, 'duplicate location');
  assert.equal(findSkip(plan.skipped, 'track.wav')?.reason, 'audio (never moves)');
  assert.equal(findSkip(plan.skipped, '._clip.mp4')?.reason, 'filesystem artifact');
  assert.equal(findSkip(plan.skipped, '.DS_Store')?.reason, 'filesystem artifact');
  assert.equal(findSkip(plan.skipped, path.join('My Song Project', 'song.als'))?.reason, 'project file (never moves)');
  assert.equal(findSkip(plan.skipped, path.join('My Song Project', 'render.mp4'))?.reason, 'inside project folder: My Song Project');
  assert.equal(findSkip(plan.skipped, path.join('My Song Project', 'Samples', 'sample.wav'))?.reason, 'audio (never moves)');

  // plan is read-only
  await assert.doesNotReject(() => fs.access(path.join(f.sourceRoot, 'clip.mp4')));
  await assert.rejects(() => fs.access(plan.root));

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('collision suffix: two different assets targeting the same collection/pillar/filename', async () => {
  const f = await fixture();
  const root = f.sourceRoot;
  await fs.mkdir(path.join(root, 'sub-a'), { recursive: true });
  await fs.mkdir(path.join(root, 'sub-b'), { recursive: true });
  await fs.writeFile(path.join(root, 'sub-a', 'clip.mp4'), 'CONTENT-A');
  await fs.writeFile(path.join(root, 'sub-b', 'clip.mp4'), 'CONTENT-B');

  const source = await f.worker.registerSource('nas', root);
  const job = f.worker.createJob(source.id, '.');
  await f.worker.run(job.id);

  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: '.' });
  assert.equal(plan.moves.length, 2);
  const [first, second] = plan.moves;
  assert.notEqual(first.to, second.to); // no silent overwrite
  const suffixed = [first.to, second.to].find(to => /\(.{12}\)\.mp4$/.test(to));
  assert.ok(suffixed, 'exactly one of the two collides and gets a sha12 suffix');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('an asset the walk finds but the worker has not hashed yet is skipped as not-yet-hashed', async () => {
  const f = await fixture();
  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await fs.writeFile(path.join(f.sourceRoot, 'never-hashed.mp4'), 'unhashed content');
  // No worker.run() call: file_locations has no row for this file at all.

  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: '.' });
  assert.equal(plan.moves.length, 0);
  assert.equal(findSkip(plan.skipped, 'never-hashed.mp4')?.reason, 'not yet hashed');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a duplicate whose canonical copy lives outside the selected folder is planned (folder-scoped dedupe)', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    await fs.mkdir(path.join(root, 'originals'), { recursive: true });
    await fs.mkdir(path.join(root, 'copy'), { recursive: true });
    await fs.writeFile(path.join(root, 'originals', 'clip.mp4'), 'SAME-BYTES');
    const source = await f.worker.registerSource('nas', root);
    // Hash the originals first so they own the canonical (HASHED) location.
    const job1 = f.worker.createJob(source.id, 'originals');
    assert.equal((await f.worker.run(job1.id)).state, 'COMPLETE');
    // Now a byte-identical copy in another folder → the worker marks it DUPLICATE globally.
    await fs.writeFile(path.join(root, 'copy', 'clip.mp4'), 'SAME-BYTES');
    const job2 = f.worker.createJob(source.id, 'copy');
    assert.equal((await f.worker.run(job2.id)).state, 'COMPLETE');
    const copyLoc = f.db.getLocationByRelativePath(source.id, path.join('copy', 'clip.mp4'))!;
    assert.equal(copyLoc.state, 'DUPLICATE');

    // Planning the COPY folder must still move its file (canonical is outside the selection).
    const planCopy = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: 'copy' });
    assert.ok(findMove(planCopy.moves, path.join('copy', 'clip.mp4')), 'copy/clip.mp4 should be planned');
    assert.equal(planCopy.moves.length, 1);

    // Planning the ORIGINALS folder moves the canonical file, unaffected.
    const planOrig = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: 'originals' });
    assert.equal(planOrig.moves.length, 1);

    // Once the copy is organized, the original is reported as a duplicate of an organized asset.
    f.db.setLocationOrganized(copyLoc.id, path.join(ORGANIZED_ROOT_NAME, 'copy', '_unsorted', 'clip.mp4'), new Date().toISOString());
    const planOrigAfter = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: 'originals' });
    assert.equal(planOrigAfter.moves.length, 0);
    const skip = findSkip(planOrigAfter.skipped, path.join('originals', 'clip.mp4'));
    assert.ok(skip && /already organized/.test(skip.reason), `expected already-organized skip, got ${skip?.reason}`);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: a file item and a folder item are both planned, unsorted/pillar rules unchanged', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    await fs.mkdir(path.join(root, 'folderA'), { recursive: true });
    await fs.writeFile(path.join(root, 'folderA', 'clip.mp4'), 'VIDEO-A-BYTES');
    await fs.writeFile(path.join(root, 'loose.jpg'), 'IMAGE-B-BYTES');
    await fs.writeFile(path.join(root, 'not-selected.jpg'), 'IMAGE-C-BYTES'); // never selected

    const source = await f.worker.registerSource('nas', root);
    const job = f.worker.createJob(source.id, '.');
    assert.equal((await f.worker.run(job.id)).state, 'COMPLETE');

    const clipLoc = f.db.getLocationByRelativePath(source.id, path.join('folderA', 'clip.mp4'))!;
    f.db.upsertJevDecision({
      id: 'decision-clip-pillar', contentAssetId: clipLoc.contentAssetId!, question: PILLAR_QUESTION,
      choices: [{ value: 'made-this', probability: 0.9 }], selectedValue: 'made-this', confidence: 0.9, status: 'AUTO_CONFIRM',
    });

    const plan = await planOrganizeCollection({
      db: f.db, source, collectionId: 'my-picks',
      items: [
        { relativePath: 'folderA', kind: 'folder' },
        { relativePath: 'loose.jpg', kind: 'file' },
      ],
    });

    assert.equal(plan.collectionId, 'my-picks');
    assert.deepEqual(plan.selection, [
      { relativePath: 'folderA', kind: 'folder' },
      { relativePath: 'loose.jpg', kind: 'file' },
    ]);
    assert.equal(plan.counts.moves, 2);
    assert.equal(plan.counts.skipped, 0);

    const clipMove = findMove(plan.moves, path.join('folderA', 'clip.mp4'));
    assert.ok(clipMove);
    assert.equal(clipMove!.pillar, 'made-this');
    assert.equal(clipMove!.to, path.join(ORGANIZED_ROOT_NAME, 'my-picks', 'made-this', 'clip.mp4'));

    const looseMove = findMove(plan.moves, 'loose.jpg');
    assert.ok(looseMove);
    assert.equal(looseMove!.pillar, '_unsorted');
    assert.equal(looseMove!.to, path.join(ORGANIZED_ROOT_NAME, 'my-picks', '_unsorted', 'loose.jpg'));

    // not-selected.jpg never appears in moves OR skipped: it was never walked.
    assert.equal(findMove(plan.moves, 'not-selected.jpg'), undefined);
    assert.equal(findSkip(plan.skipped, 'not-selected.jpg'), undefined);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: overlap between a folder item and a file item inside it is planned once', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    await fs.mkdir(path.join(root, 'folderA'), { recursive: true });
    await fs.writeFile(path.join(root, 'folderA', 'clip.mp4'), 'VIDEO-A-BYTES');

    const source = await f.worker.registerSource('nas', root);
    await f.worker.run(f.worker.createJob(source.id, '.').id);

    const plan = await planOrganizeCollection({
      db: f.db, source, collectionId: 'overlap',
      items: [
        { relativePath: 'folderA', kind: 'folder' },
        { relativePath: path.join('folderA', 'clip.mp4'), kind: 'file' },
      ],
    });

    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0].from, path.join('folderA', 'clip.mp4'));
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: _unsorted default and project-folder/audio exclusion rules apply identically', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    // The project folder sits one level under the selected folder item
    // ('container'), same nesting shape as the single-selected-folder test
    // above — `findProjectDirs`/`projectAncestorOf` are scoped to each
    // folder ITEM's own root, exactly like they're scoped to `selectedRoot`
    // in the single-path mode, so nesting the project folder one level down
    // reproduces the identical named-ancestor reporting.
    await fs.mkdir(path.join(root, 'container', 'My Song Project'), { recursive: true });
    await fs.writeFile(path.join(root, 'container', 'My Song Project', 'song.als'), 'ableton project binary');
    await fs.writeFile(path.join(root, 'container', 'My Song Project', 'render.mp4'), 'VIDEO-C-BYTES');
    await fs.writeFile(path.join(root, 'track.wav'), 'AUDIO-A-BYTES');

    const source = await f.worker.registerSource('nas', root);
    await f.worker.run(f.worker.createJob(source.id, '.').id);

    const plan = await planOrganizeCollection({
      db: f.db, source, collectionId: 'excluded',
      items: [
        { relativePath: 'container', kind: 'folder' },
        { relativePath: 'track.wav', kind: 'file' },
      ],
    });

    assert.equal(plan.moves.length, 0);
    assert.equal(findSkip(plan.skipped, path.join('container', 'My Song Project', 'song.als'))?.reason, 'project file (never moves)');
    assert.equal(findSkip(plan.skipped, path.join('container', 'My Song Project', 'render.mp4'))?.reason, `inside project folder: ${path.join('My Song Project')}`);
    assert.equal(findSkip(plan.skipped, 'track.wav')?.reason, 'audio (never moves)');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: a folder item that IS the project folder reports the ancestor relative to the item root', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    await fs.mkdir(path.join(root, 'My Song Project'), { recursive: true });
    await fs.writeFile(path.join(root, 'My Song Project', 'song.als'), 'ableton project binary');
    await fs.writeFile(path.join(root, 'My Song Project', 'render.mp4'), 'VIDEO-C-BYTES');

    const source = await f.worker.registerSource('nas', root);
    await f.worker.run(f.worker.createJob(source.id, '.').id);

    // The folder item IS the project folder itself (not a container above
    // it) — its own root has no name of its own to report, matching what
    // the single-path mode would also report for
    // `selectedRelativePath: 'My Song Project'`.
    const plan = await planOrganizeCollection({
      db: f.db, source, collectionId: 'is-project-folder',
      items: [{ relativePath: 'My Song Project', kind: 'folder' }],
    });

    assert.equal(plan.moves.length, 0);
    assert.equal(findSkip(plan.skipped, path.join('My Song Project', 'render.mp4'))?.reason, 'inside project folder: .');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: a file item directly inside a project folder is excluded like the folder-walk rule', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    await fs.mkdir(path.join(root, 'My Song Project'), { recursive: true });
    await fs.writeFile(path.join(root, 'My Song Project', 'song.als'), 'ableton project binary');
    await fs.writeFile(path.join(root, 'My Song Project', 'render.mp4'), 'VIDEO-C-BYTES');

    const source = await f.worker.registerSource('nas', root);
    await f.worker.run(f.worker.createJob(source.id, '.').id);

    // render.mp4 picked directly as a FILE item (not via its parent folder).
    const plan = await planOrganizeCollection({
      db: f.db, source, collectionId: 'lone-file',
      items: [{ relativePath: path.join('My Song Project', 'render.mp4'), kind: 'file' }],
    });

    assert.equal(plan.moves.length, 0);
    assert.equal(
      findSkip(plan.skipped, path.join('My Song Project', 'render.mp4'))?.reason,
      `inside project folder: ${path.join('My Song Project')}`,
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: a duplicate whose canonical copy lives outside the selection still moves', async () => {
  const f = await fixture();
  try {
    const root = f.sourceRoot;
    await fs.mkdir(path.join(root, 'originals'), { recursive: true });
    await fs.mkdir(path.join(root, 'picked'), { recursive: true });
    await fs.writeFile(path.join(root, 'originals', 'clip.mp4'), 'SAME-BYTES');
    const source = await f.worker.registerSource('nas', root);
    const job1 = f.worker.createJob(source.id, 'originals');
    assert.equal((await f.worker.run(job1.id)).state, 'COMPLETE'); // originals/clip.mp4 owns HASHED

    await fs.writeFile(path.join(root, 'picked', 'clip.mp4'), 'SAME-BYTES');
    const job2 = f.worker.createJob(source.id, 'picked');
    assert.equal((await f.worker.run(job2.id)).state, 'COMPLETE');
    const pickedLoc = f.db.getLocationByRelativePath(source.id, path.join('picked', 'clip.mp4'))!;
    assert.equal(pickedLoc.state, 'DUPLICATE');

    const plan = await planOrganizeCollection({
      db: f.db, source, collectionId: 'picked-selection',
      items: [{ relativePath: path.join('picked', 'clip.mp4'), kind: 'file' }],
    });
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0].from, path.join('picked', 'clip.mp4'));
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('items selection: an item escaping the source root throws', async () => {
  const f = await fixture();
  try {
    const source = await f.worker.registerSource('nas', f.sourceRoot);
    await assert.rejects(
      () => planOrganizeCollection({ db: f.db, source, collectionId: 'escape', items: [{ relativePath: '../outside', kind: 'folder' }] }),
      /escapes source root/,
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
