import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';
import { ArchiveDaemon } from './daemon';
import { ArchiveAnalysisService, videoObservationId } from './analysis/service';
import { JevDecisionService } from './jev/service';
import { JEV_QUESTIONS } from './jev/taxonomy';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-daemon-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const sourceRoot = path.join(dir, 'nas');
  await fs.mkdir(sourceRoot);
  const db = new ArchiveDatabase(dbPath);
  return { dir, sourceRoot, db };
}

function fakeControl() {
  const synced: any[] = [];
  const commands: any[] = [];
  return {
    configured: false,
    synced,
    commands,
    heartbeat: async () => {},
    registerSource: async () => {},
    pollCommands: async () => [],
    updateCommand: async (u: any) => { commands.push(u); },
    syncAsset: async (payload: any) => { synced.push(payload); },
  };
}

function collectionCommand(id: string, sourceId: string) {
  return { id, type: 'PROCESS_COLLECTION' as const, workerId: 'test-worker', sourceId, relativePath: '.', state: 'QUEUED' as const };
}

test('TwelveLabs not configured: the job still hashes and syncs, and Jev is never called', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const jevProvider: any = { decide: async () => { throw new Error('Jev must not be called when TwelveLabs is unconfigured'); } };
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService(jevProvider));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  await assert.doesNotReject(() => (daemon as any).execute(collectionCommand('cmd1', source.id)));

  const location = f.db.db.prepare("SELECT state, content_asset_id FROM file_locations WHERE relative_path='clip.mp4'").get() as { state: string; content_asset_id: string };
  assert.equal(location.state, 'HASHED');
  assert.equal(f.db.listObservations(location.content_asset_id).length, 0);
  assert.equal(f.db.listJevDecisions(location.content_asset_id).length, 0);

  assert.equal(control.synced.length, 1);
  assert.equal(control.synced[0].asset.mediaType, 'video');
  assert.equal(control.synced[0].asset.decisions.length, 0);
  assert.equal(control.commands.some((c: any) => c.state === 'COMPLETE'), true);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a video with no observation yet is submitted through the configured TwelveLabs adapter', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const submitted: string[] = [];
  const fakeTwelveLabs: any = {
    configured: true,
    submitVideo: async (assetId: string) => { submitted.push(assetId); return { provider: 'twelvelabs', providerAssetId: 'task1', sourceAssetId: assetId, status: 'SUBMITTED', raw: {} }; },
    getAsset: async () => ({ status: 'processing' }),
  };
  const analysis = new ArchiveAnalysisService(f.db, fakeTwelveLabs);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await (daemon as any).execute(collectionCommand('cmd1', source.id));

  assert.equal(submitted.length, 1);
  const location = f.db.db.prepare("SELECT content_asset_id FROM file_locations WHERE relative_path='clip.mp4'").get() as { content_asset_id: string };
  const observations = f.db.listObservations(location.content_asset_id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, 'INDEXING'); // SUBMITTED -> advanceVideo sees "processing" -> INDEXING

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a READY observation drives all six Jev questions in one pass, persisted with review bands', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const fakeTwelveLabs: any = { configured: false };
  const analysis = new ArchiveAnalysisService(f.db, fakeTwelveLabs);
  const askedQuestions: string[] = [];
  const jevProvider: any = {
    decide: async (_input: any, question: string) => { askedQuestions.push(question); return [{ value: 'x', probability: 0.95 }]; },
  };
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService(jevProvider));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  // First pass with TwelveLabs unconfigured: hashes the file into a content
  // asset with no observation attempt at all.
  await (daemon as any).execute(collectionCommand('cmd1', source.id));
  const location = f.db.db.prepare("SELECT content_asset_id FROM file_locations WHERE relative_path='clip.mp4'").get() as { content_asset_id: string };
  const assetId = location.content_asset_id;
  assert.equal(f.db.listObservations(assetId).length, 0);

  // Seed the exact observation row analyzeVideo would have written once
  // TwelveLabs indexing actually finished, so analyzeVideo's own idempotency
  // check short-circuits on the next pass without calling out. TwelveLabs is
  // now configured, as if credentials had just been added.
  fakeTwelveLabs.configured = true;
  f.db.upsertObservation({ id: videoObservationId(assetId), contentAssetId: assetId, provider: 'twelvelabs', providerAssetId: 'task1', kind: 'video_understanding', status: 'READY', summary: 'a live set clip' });

  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    await (daemon as any).execute(collectionCommand('cmd2', source.id));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }

  assert.equal(askedQuestions.length, JEV_QUESTIONS.length);
  assert.deepEqual(askedQuestions.sort(), JEV_QUESTIONS.map(q => q.question).sort());

  const decisions = f.db.listJevDecisions(assetId);
  assert.equal(decisions.length, JEV_QUESTIONS.length);
  assert.ok(decisions.every(d => d.selectedValue === 'x' && d.confidence === 0.95 && d.status === 'AUTO_CONFIRM'));

  const lastSync = control.synced[control.synced.length - 1];
  assert.equal(lastSync.asset.decisions.length, JEV_QUESTIONS.length);
  assert.ok(lastSync.asset.decisions.every((d: any) => d.reviewBand === 'AUTO_CONFIRM'));

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('ANTHROPIC_API_KEY missing: TwelveLabs still runs but no Jev decisions are written', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: true, submitVideo: async () => ({ provider: 'twelvelabs', providerAssetId: 'task1', sourceAssetId: 'x', status: 'SUBMITTED', raw: {} }), getAsset: async () => ({ status: 'processing' }) } as any);
  const jevProvider: any = { decide: async () => { throw new Error('Jev must not be called without ANTHROPIC_API_KEY'); } };
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService(jevProvider));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.doesNotReject(() => (daemon as any).execute(collectionCommand('cmd1', source.id)));
  } finally {
    if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
  }

  const location = f.db.db.prepare("SELECT content_asset_id FROM file_locations WHERE relative_path='clip.mp4'").get() as { content_asset_id: string };
  assert.equal(f.db.listJevDecisions(location.content_asset_id).length, 0);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a TwelveLabs submission failure is recorded but does not abort the job', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: true, submitVideo: async () => { throw new Error('TwelveLabs is down'); } } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await assert.doesNotReject(() => (daemon as any).execute(collectionCommand('cmd1', source.id)));

  const location = f.db.db.prepare("SELECT content_asset_id FROM file_locations WHERE relative_path='clip.mp4'").get() as { content_asset_id: string };
  const observations = f.db.listObservations(location.content_asset_id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, 'FAILED');
  assert.equal(control.synced.length, 1); // the asset still syncs despite the analysis failure

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});
