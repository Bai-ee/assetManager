import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
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
  const intakeUpdates: any[] = [];
  const intakePurges: any[] = [];
  return {
    configured: false,
    synced,
    commands,
    intakeUpdates,
    intakePurges,
    heartbeat: async () => {},
    registerSource: async () => {},
    pollCommands: async () => [],
    updateCommand: async (u: any) => { commands.push(u); },
    syncAsset: async (payload: any) => { synced.push(payload); },
    listIntake: async () => [],
    updateIntake: async (u: any) => { intakeUpdates.push(u); },
    purgeIntake: async (p: any) => { intakePurges.push(p); },
  };
}

function collectionCommand(id: string, sourceId: string) {
  return { id, type: 'PROCESS_COLLECTION' as const, workerId: 'test-worker', sourceId, relativePath: '.', state: 'QUEUED' as const };
}

function organizeCommand(id: string, sourceId: string, mode?: 'plan' | 'apply') {
  return { id, type: 'ORGANIZE_COLLECTION' as const, workerId: 'test-worker', sourceId, relativePath: '.', state: 'QUEUED' as const, mode };
}

function undoOrganizeCommand(id: string, sourceId: string, organizeJobId?: string) {
  return { id, type: 'UNDO_ORGANIZE' as const, workerId: 'test-worker', sourceId, relativePath: '.', state: 'QUEUED' as const, organizeJobId };
}

function selectionCommand(id: string, sourceId: string, items: Array<{ relativePath: string; kind: 'file' | 'folder' }>, collectionId = 'my-selection') {
  return { id, type: 'PROCESS_SELECTION' as const, workerId: 'test-worker', sourceId, state: 'QUEUED' as const, items, collectionId };
}

function organizeItemsCommand(id: string, sourceId: string, items: Array<{ relativePath: string; kind: 'file' | 'folder' }>, collectionId = 'my-selection', mode?: 'plan' | 'apply') {
  return { id, type: 'ORGANIZE_COLLECTION' as const, workerId: 'test-worker', sourceId, state: 'QUEUED' as const, items, collectionId, mode };
}

function uploadJsonCommand(overrides: Partial<{
  id: string; kind: 'archive-record' | 'collection-manifest' | 'viewer';
  fileName: string; contentType: string; payload: unknown;
  tags: Array<{ name: string; value: string }>;
  refs: { contentAssetId?: string; collectionId?: string; version?: string | number; previousTransactionId?: string };
}> = {}) {
  return {
    id: overrides.id ?? 'cmd-upload-json',
    type: 'UPLOAD_JSON' as const,
    workerId: 'test-worker',
    state: 'QUEUED' as const,
    kind: overrides.kind ?? 'archive-record',
    fileName: overrides.fileName ?? 'record.json',
    contentType: overrides.contentType ?? 'application/json',
    payload: 'payload' in overrides ? overrides.payload : { title: 'Example record' },
    tags: overrides.tags ?? [{ name: 'App-Name', value: 'HITLOOP-Archive' }],
    refs: overrides.refs ?? { contentAssetId: 'asset-1' },
  };
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

test('a stale AppleDouble asset (hashed before the discovery filter existed) is never submitted to TwelveLabs', async () => {
  const f = await fixture();

  const control = fakeControl();
  const fakeTwelveLabs: any = {
    configured: true,
    submitVideo: async () => { throw new Error('must not be called for a stale AppleDouble asset'); },
    getAsset: async () => { throw new Error('must not be called for a stale AppleDouble asset'); },
  };
  const analysis = new ArchiveAnalysisService(f.db, fakeTwelveLabs);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  // Simulate the state left by a worker run from before the discovery filter
  // existed: a stale 368-byte AppleDouble asset hashed under six `._*.mp4`
  // locations (real incident on hpit03_finals). The current discovery filter
  // would never produce these rows again, but a re-scan of the same source
  // still finds them in file_locations — and their basename still carries a
  // real video extension, so the extension check alone would still submit
  // 368 bytes of garbage as if it were a video.
  const staleAssetId = 'stale-appledouble-sha256';
  f.db.insertAsset({ id: staleAssetId, sha256: staleAssetId, sizeBytes: 368, createdAt: new Date().toISOString(), state: 'QUEUED' });
  for (const name of ['a.mp4', 'b.mp4']) {
    f.db.upsertLocation({
      id: `loc-${name}`, sourceId: source.id, relativePath: `._${name}`, sizeBytes: 368, modifiedAtMs: Date.now(),
      discoveredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), state: 'HASHED', contentAssetId: staleAssetId,
    });
  }

  await (daemon as any).execute(collectionCommand('cmd1', source.id));

  assert.equal(f.db.listObservations(staleAssetId).length, 0);

  // The asset still syncs (every job asset does) but carries no analysis.
  const staleSync = control.synced.find((s: any) => s.asset.id === staleAssetId);
  assert.ok(staleSync);
  assert.equal(staleSync.asset.decisions.length, 0);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('sweepPendingAnalysis advances an INDEXING row to READY, runs Jev, and syncs once', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const fakeTwelveLabs: any = {
    configured: true,
    getAsset: async () => ({ status: 'ready' }),
    analyzeAsset: async () => ({ text: 'archival description', usage: { input_tokens: 10, output_tokens: 5 }, finishReason: 'stop', raw: {} }),
  };
  const analysis = new ArchiveAnalysisService(f.db, fakeTwelveLabs);
  const jevCalls: string[] = [];
  const jevProvider: any = {
    decide: async (_input: any, question: string) => { jevCalls.push(question); return [{ value: 'x', probability: 0.95 }]; },
  };
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService(jevProvider));

  // Hash the file directly through the worker, bypassing the daemon's own
  // analysis step, so the only observation in play is the one seeded below.
  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  const job = worker.createJob(source.id);
  await worker.run(job.id);
  const location = f.db.db.prepare("SELECT content_asset_id FROM file_locations WHERE relative_path='clip.mp4'").get() as { content_asset_id: string };
  const assetId = location.content_asset_id;
  f.db.upsertObservation({ id: videoObservationId(assetId), contentAssetId: assetId, provider: 'twelvelabs', providerAssetId: 'task1', kind: 'video_understanding', status: 'INDEXING' });

  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    await (daemon as any).sweepPendingAnalysis();
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }

  const observation = f.db.listObservations(assetId).find(o => o.id === videoObservationId(assetId));
  assert.equal(observation?.status, 'READY');
  assert.equal(observation?.summary, 'archival description');

  assert.equal(jevCalls.length, JEV_QUESTIONS.length);
  const decisions = f.db.listJevDecisions(assetId);
  assert.equal(decisions.length, JEV_QUESTIONS.length);

  assert.equal(control.synced.length, 1); // synced exactly once for this asset
  assert.equal(control.synced[0].sourceId, source.id);
  assert.equal(control.synced[0].asset.decisions.length, JEV_QUESTIONS.length);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('sweepPendingAnalysis processes at most 5 pending observations per call, oldest first', async () => {
  const f = await fixture();
  const control = fakeControl();
  const seenProviderAssetIds: string[] = [];
  const fakeTwelveLabs: any = {
    configured: true,
    getAsset: async (providerAssetId: string) => { seenProviderAssetIds.push(providerAssetId); return { status: 'processing' }; }, // stays INDEXING; analyzeAsset never reached
  };
  const analysis = new ArchiveAnalysisService(f.db, fakeTwelveLabs);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  for (let i = 0; i < 7; i++) {
    const assetId = `asset-${i}`;
    f.db.insertAsset({ id: assetId, sha256: assetId, sizeBytes: 1, createdAt: new Date().toISOString(), state: 'QUEUED' });
    const observationId = `obs-${i}`;
    f.db.upsertObservation({ id: observationId, contentAssetId: assetId, provider: 'twelvelabs', providerAssetId: `task-${i}`, kind: 'video_understanding', status: 'SUBMITTED' });
    // upsertObservation stamps created_at with "now"; back-date deterministically so ordering is unambiguous.
    f.db.db.prepare('UPDATE observations SET created_at=? WHERE id=?').run(new Date(2020, 0, i + 1).toISOString(), observationId);
  }

  await (daemon as any).sweepPendingAnalysis();

  assert.equal(seenProviderAssetIds.length, 5);
  assert.deepEqual(seenProviderAssetIds, ['task-0', 'task-1', 'task-2', 'task-3', 'task-4']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a cloud-intake UPLOAD_ASSET_ARWEAVE command marks REVIEWED then, on completion, ARCHIVED + purges the scratch file', async () => {
  const f = await fixture();
  const intakeId = 'intake-upload-1';
  const intakeDir = path.join(f.sourceRoot, intakeId);
  await fs.mkdir(intakeDir, { recursive: true });
  const bytes = Buffer.from('fake photo bytes');
  await fs.writeFile(path.join(intakeDir, 'photo.jpg'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const jevProvider: any = { decide: async () => { throw new Error('not reached'); } };
  const fakeUpload = async () => ({ transactionId: 'tx-1', arweaveUrl: 'https://arweave.net/tx-1', sizeBytes: bytes.length, tags: [] });
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService(jevProvider), fakeUpload as any);

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('Cloud intake', f.sourceRoot);
  // Bypasses ensureCloudIntakeSource (only run() calls it); this is what a
  // real daemon.run() would have set at startup.
  (daemon as any).cloudIntakeSourceId = source.id;
  (daemon as any).cloudIntakeRootPath = source.rootPath;

  const command = {
    id: 'cmd-upload', type: 'UPLOAD_ASSET_ARWEAVE' as const, workerId: 'test-worker', sourceId: source.id,
    relativePath: `${intakeId}/photo.jpg`, expectedSha256: sha256, collectionId: 'col-1', archiveName: 'photo.jpg',
    contentAssetId: sha256, contentType: 'image/jpeg', state: 'QUEUED' as const,
  };

  await assert.doesNotReject(() => (daemon as any).execute(command));

  assert.deepEqual(control.intakeUpdates.map((u: any) => u.state), ['REVIEWED', 'ARCHIVED']);
  assert.equal(control.intakeUpdates[0].intakeId, intakeId);
  assert.equal(control.intakePurges.length, 1);
  assert.equal(control.intakePurges[0].intakeId, intakeId);
  assert.equal(control.commands.some((c: any) => c.state === 'COMPLETE'), true);

  await assert.rejects(() => fs.access(intakeDir), 'scratch directory removed once archived and purged');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('a non-cloud-intake UPLOAD_ASSET_ARWEAVE command never touches intake state', async () => {
  const f = await fixture();
  const bytes = Buffer.from('a NAS original');
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const fakeUpload = async () => ({ transactionId: 'tx-2', arweaveUrl: 'https://arweave.net/tx-2', sizeBytes: bytes.length, tags: [] });
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any), fakeUpload as any);

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('Bryan NAS', f.sourceRoot);
  // No cloudIntakeSourceId set: this source is Lane 1 (a real NAS folder).

  const command = {
    id: 'cmd-upload-nas', type: 'UPLOAD_ASSET_ARWEAVE' as const, workerId: 'test-worker', sourceId: source.id,
    relativePath: 'clip.mp4', expectedSha256: sha256, collectionId: 'col-2', archiveName: 'clip.mp4',
    contentAssetId: sha256, contentType: 'video/mp4', state: 'QUEUED' as const,
  };

  await assert.doesNotReject(() => (daemon as any).execute(command));

  assert.equal(control.intakeUpdates.length, 0);
  assert.equal(control.intakePurges.length, 0);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

function fakeUploadDocument(transactionId = 'doc-tx-1') {
  const calls: any[] = [];
  const fn = async (input: any) => {
    calls.push(input);
    return { transactionId, arweaveUrl: `https://arweave.net/${transactionId}`, sizeBytes: input.bytes.length, tags: input.tags };
  };
  return Object.assign(fn, { calls });
}

const unusedUploadOriginal = async () => { throw new Error('uploadOriginal must not be called for UPLOAD_JSON commands'); };

test('UPLOAD_JSON archive-record: JSON payload is pretty-printed, tags/refs echoed, no source lookup', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const jevProvider: any = { decide: async () => { throw new Error('not reached'); } };
  const uploadDocument = fakeUploadDocument('tx-record-1');
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService(jevProvider), unusedUploadOriginal as any, uploadDocument as any);

  const payload = { title: 'Example record', assetId: 'asset-1' };
  const command = uploadJsonCommand({ kind: 'archive-record', fileName: 'record.json', payload, refs: { contentAssetId: 'asset-1', version: 2 } });

  await assert.doesNotReject(() => (daemon as any).execute(command));

  assert.equal(uploadDocument.calls.length, 1);
  const call = uploadDocument.calls[0];
  assert.equal(call.bytes.toString('utf8'), JSON.stringify(payload, null, 2));
  assert.equal(call.fileName, 'record.json');
  assert.equal(call.contentType, 'application/json');
  assert.deepEqual(call.tags, command.tags);

  assert.deepEqual(control.commands.map((c: any) => c.state), ['CLAIMED', 'RUNNING', 'COMPLETE']);
  const complete = control.commands[control.commands.length - 1];
  assert.equal(complete.result.transactionId, 'tx-record-1');
  assert.equal(complete.result.arweaveUrl, 'https://arweave.net/tx-record-1');
  assert.equal(complete.result.kind, 'archive-record');
  assert.equal(complete.result.fileName, 'record.json');
  assert.deepEqual(complete.result.refs, { contentAssetId: 'asset-1', version: 2 });

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('UPLOAD_JSON collection-manifest: JSON payload pretty-printed same as archive-record', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const uploadDocument = fakeUploadDocument('tx-manifest-1');
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any), unusedUploadOriginal as any, uploadDocument as any);

  const payload = { collectionId: 'col-1', assets: ['asset-1', 'asset-2'] };
  const command = uploadJsonCommand({ id: 'cmd-manifest', kind: 'collection-manifest', fileName: 'manifest.json', payload, refs: { collectionId: 'col-1' } });

  await (daemon as any).execute(command);

  assert.equal(uploadDocument.calls[0].bytes.toString('utf8'), JSON.stringify(payload, null, 2));
  const complete = control.commands.find((c: any) => c.state === 'COMPLETE');
  assert.equal(complete.result.kind, 'collection-manifest');
  assert.deepEqual(complete.result.refs, { collectionId: 'col-1' });

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('UPLOAD_JSON viewer: HTML string payload passed through untouched, not JSON-stringified', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const uploadDocument = fakeUploadDocument('tx-viewer-1');
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any), unusedUploadOriginal as any, uploadDocument as any);

  const html = '<!doctype html><html><body>Archive viewer</body></html>';
  const command = uploadJsonCommand({ id: 'cmd-viewer', kind: 'viewer', fileName: 'index.html', contentType: 'text/html', payload: html, refs: {} });

  await (daemon as any).execute(command);

  assert.equal(uploadDocument.calls[0].bytes.toString('utf8'), html);
  const complete = control.commands.find((c: any) => c.state === 'COMPLETE');
  assert.equal(complete.result.kind, 'viewer');
  assert.equal(complete.result.fileName, 'index.html');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('UPLOAD_JSON with missing payload fails the command instead of throwing, without calling the uploader', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const uploadDocument = fakeUploadDocument();
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any), unusedUploadOriginal as any, uploadDocument as any);

  const command = uploadJsonCommand({ payload: undefined });

  await assert.doesNotReject(() => (daemon as any).execute(command));

  assert.equal(uploadDocument.calls.length, 0);
  const failed = control.commands.find((c: any) => c.state === 'FAILED');
  assert.ok(failed, 'command must reach FAILED');
  assert.match(failed.error, /payload/i);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('UPLOAD_JSON over the 2 MB ceiling fails the command with the uploader\'s error message', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  // Real uploadDocumentToArweave (not a fake) so the actual 2 MB ceiling check runs;
  // it throws before ever constructing a Turbo client, so no wallet is needed.
  const { uploadDocumentToArweave } = await import('./arweave/uploader');
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any), unusedUploadOriginal as any, uploadDocumentToArweave);

  const bigPayload = { blob: 'x'.repeat(3 * 1024 * 1024) }; // JSON-stringified form exceeds 2 MB
  const command = uploadJsonCommand({ payload: bigPayload });

  await assert.doesNotReject(() => (daemon as any).execute(command));

  const failed = control.commands.find((c: any) => c.state === 'FAILED');
  assert.ok(failed, 'command must reach FAILED');
  assert.match(failed.error, /2097152|ceiling|exceed/i);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('UPLOAD_JSON command carries no sourceId and never triggers the "Unknown source" path', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const uploadDocument = fakeUploadDocument('tx-no-source');
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any), unusedUploadOriginal as any, uploadDocument as any);

  const command = uploadJsonCommand();
  assert.equal('sourceId' in command, false);

  await assert.doesNotReject(() => (daemon as any).execute(command));

  assert.equal(control.commands.some((c: any) => c.state === 'FAILED' && /Unknown source/.test(c.error || '')), false);
  assert.equal(control.commands.some((c: any) => c.state === 'COMPLETE'), true);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('ORGANIZE_COLLECTION {mode:"plan"} returns the move list without touching disk or syncing anything', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await worker.run(worker.createJob(source.id, '.').id);

  await (daemon as any).execute(organizeCommand('cmd-plan', source.id, 'plan'));

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-plan' && c.state === 'COMPLETE');
  assert.ok(completed);
  assert.equal(completed.result.mode, 'plan');
  assert.equal(completed.result.plan.moves.length, 1);
  assert.equal(completed.result.plan.moves[0].from, 'clip.mp4');

  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  assert.equal(await exists(path.join(f.sourceRoot, 'clip.mp4')), true);
  assert.equal(await exists(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE')), false);
  assert.equal(control.synced.length, 0);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('ORGANIZE_COLLECTION {mode:"apply"} moves the file and syncs the organized field; UNDO_ORGANIZE (resolved by relativePath) restores it', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await worker.run(worker.createJob(source.id, '.').id);

  await (daemon as any).execute(organizeCommand('cmd-apply', source.id, 'apply'));

  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  const applied = control.commands.find((c: any) => c.commandId === 'cmd-apply' && c.state === 'COMPLETE');
  assert.ok(applied);
  assert.equal(applied.result.moved.length, 1);
  const movedTo = applied.result.moved[0].to;
  assert.equal(await exists(path.join(f.sourceRoot, 'clip.mp4')), false);
  assert.equal(await exists(path.join(f.sourceRoot, movedTo)), true);

  const organizedSync = control.synced.find((s: any) => s.asset.organized);
  assert.ok(organizedSync, 'daemon must sync the organized field for the moved asset');
  assert.equal(organizedSync.asset.organized.path, movedTo);
  assert.ok(organizedSync.asset.organized.appliedAt);

  // No explicit organizeJobId: the daemon derives collectionId from
  // relativePath and finds the latest organize job for it.
  await (daemon as any).execute(undoOrganizeCommand('cmd-undo', source.id));
  const undone = control.commands.find((c: any) => c.commandId === 'cmd-undo' && c.state === 'COMPLETE');
  assert.ok(undone);
  assert.equal(undone.result.restored.length, 1);
  assert.equal(await exists(path.join(f.sourceRoot, 'clip.mp4')), true);
  assert.equal(await exists(path.join(f.sourceRoot, movedTo)), false);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('LIST_DIRECTORY result carries entries (folder + file with size/ext/movable) alongside the unchanged folders array', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'Housepit'));
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes long enough');
  await fs.writeFile(path.join(f.sourceRoot, '.DS_Store'), 'junk');
  await fs.writeFile(path.join(f.sourceRoot, '._clip.mp4'), 'appledouble junk');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  const command = { id: 'cmd-list', type: 'LIST_DIRECTORY' as const, workerId: 'test-worker', sourceId: source.id, relativePath: '.', state: 'QUEUED' as const };
  await (daemon as any).execute(command);

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-list' && c.state === 'COMPLETE');
  assert.ok(completed);
  const { result } = completed;
  assert.deepEqual(result.folders, ['Housepit']); // compat shape unchanged
  assert.equal(result.counts.folders, 1);
  assert.equal(result.counts.files, 1);

  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], { name: 'Housepit', kind: 'folder' });
  const fileEntry = result.entries[1];
  assert.equal(fileEntry.name, 'clip.mp4');
  assert.equal(fileEntry.kind, 'file');
  assert.equal(fileEntry.ext, 'mp4');
  assert.equal(fileEntry.movable, true);
  assert.equal(typeof fileEntry.sizeBytes, 'number');
  assert.ok(fileEntry.sizeBytes > 0);
  assert.ok(fileEntry.modifiedAt);
  assert.ok(!Number.isNaN(Date.parse(fileEntry.modifiedAt)));

  // Hidden/artifact names never surface.
  assert.equal(result.entries.some((e: any) => e.name === '.DS_Store' || e.name === '._clip.mp4'), false);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('run(): the browse lane completes a LIST_DIRECTORY command while a slower main-lane command is still executing', async () => {
  const f = await fixture();
  const control = fakeControl();
  const events: string[] = [];
  let mainServed = false;
  let browseServed = false;
  (control as any).pollCommands = async (_workerId: string, opts?: { types?: string[]; excludeTypes?: string[] }) => {
    if (opts?.types?.includes('LIST_DIRECTORY')) {
      if (browseServed) return [];
      browseServed = true;
      return [{ id: 'browse-1', type: 'LIST_DIRECTORY', workerId: 'test-worker', sourceId: 'src-1', relativePath: '.', state: 'QUEUED' }];
    }
    if (mainServed) return [];
    mainServed = true;
    return [{ id: 'main-1', type: 'PROCESS_COLLECTION', workerId: 'test-worker', sourceId: 'src-1', relativePath: '.', state: 'QUEUED' }];
  };

  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  // Isolate loop-scheduling behavior from real execute() business logic
  // (which needs a registered source with real files for PROCESS_COLLECTION):
  // the main-lane command takes 150ms, the browse-lane command takes 10ms.
  (daemon as any).execute = async (command: any) => {
    const delay = command.id === 'main-1' ? 150 : 10;
    await new Promise(resolve => setTimeout(resolve, delay));
    events.push(`${command.id} done`);
    await control.updateCommand({ commandId: command.id, state: 'COMPLETE' });
  };

  const runPromise = daemon.run(20, 20);
  try {
    // Give both loops a chance to claim their command and let the fast
    // browse-lane command finish, well before the slow main-lane one can.
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.ok(events.includes('browse-1 done'), 'browse lane must already have completed LIST_DIRECTORY');
    assert.equal(events.includes('main-1 done'), false, 'main-lane command must still be in flight');

    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(events.includes('main-1 done'), 'main-lane command eventually completes');
  } finally {
    daemon.stop();
    await runPromise;
  }

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('run(): the main lane never claims LIST_DIRECTORY and the browse lane never claims other types', async () => {
  const f = await fixture();
  const control = fakeControl();
  // A shared in-memory queue, filtered exactly like the real HITLOOP route
  // (types include-list / excludeTypes exclude-list), so a command is only
  // ever handed to the lane whose filter it actually matches.
  const queue: Array<{ id: string; type: string }> = [
    { id: 'q1', type: 'PROCESS_COLLECTION' },
    { id: 'q2', type: 'LIST_DIRECTORY' },
    { id: 'q3', type: 'ORGANIZE_COLLECTION' },
    { id: 'q4', type: 'LIST_DIRECTORY' },
  ];
  const claims: Array<{ id: string; type: string; opts: any }> = [];
  (control as any).pollCommands = async (_workerId: string, opts?: { types?: string[]; excludeTypes?: string[] }) => {
    const matches = queue.filter(c => (opts?.types ? opts.types.includes(c.type) : true) && (opts?.excludeTypes ? !opts.excludeTypes.includes(c.type) : true));
    for (const m of matches) {
      const idx = queue.indexOf(m);
      if (idx !== -1) queue.splice(idx, 1); // claimed: no longer QUEUED
    }
    return matches.map(m => ({ ...m, workerId: 'test-worker', sourceId: 'src-1', relativePath: '.', state: 'QUEUED' as const }));
  };

  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));
  (daemon as any).execute = async (command: any) => {
    claims.push({ id: command.id, type: command.type, opts: command.__claimedWithOpts });
    await control.updateCommand({ commandId: command.id, state: 'COMPLETE' });
  };
  // Tag each claimed command with the opts it was claimed under, by wrapping pollCommands once more.
  const rawPoll = (control as any).pollCommands.bind(control);
  (control as any).pollCommands = async (workerId: string, opts?: any) => {
    const commands = await rawPoll(workerId, opts);
    return commands.map((c: any) => ({ ...c, __claimedWithOpts: opts }));
  };

  const runPromise = daemon.run(15, 15);
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(queue.length, 0, 'all seeded commands were eventually claimed by one lane or the other');
  } finally {
    daemon.stop();
    await runPromise;
  }

  assert.equal(claims.length, 4);
  for (const claim of claims) {
    if (claim.type === 'LIST_DIRECTORY') {
      assert.ok(claim.opts?.types?.includes('LIST_DIRECTORY'), `${claim.id} (LIST_DIRECTORY) must be claimed via the browse lane's types filter`);
      assert.equal(claim.opts?.excludeTypes, undefined);
    } else {
      assert.ok(claim.opts?.excludeTypes?.includes('LIST_DIRECTORY'), `${claim.id} (${claim.type}) must be claimed via the main lane's excludeTypes filter`);
      assert.equal(claim.opts?.types, undefined);
    }
  }

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('UNDO_ORGANIZE fails cleanly when no organize job exists for the collection', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await worker.run(worker.createJob(source.id, '.').id);

  // Matches the existing convention for other early-validation throws in
  // execute() (e.g. "Unknown source"): only the run()-loop wrapper turns
  // these into a FAILED command update; a direct execute() call rejects.
  await assert.rejects(() => (daemon as any).execute(undoOrganizeCommand('cmd-undo-none', source.id)), /No organize job found/);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION hashes a folder item + a file item, syncs assets, and completes like PROCESS_COLLECTION', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'loose.jpg'), 'image bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'not-selected.jpg'), 'excluded bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  const items = [
    { relativePath: 'folderA', kind: 'folder' as const },
    { relativePath: 'loose.jpg', kind: 'file' as const },
  ];
  await (daemon as any).execute(selectionCommand('cmd-selection', source.id, items, 'my-selection'));

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-selection' && c.state === 'COMPLETE');
  assert.ok(completed);

  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), [path.join('folderA', 'clip.mp4'), 'loose.jpg']);

  // not-selected.jpg was never discovered at all.
  assert.equal(rows.some(r => r.relative_path === 'not-selected.jpg'), false);

  assert.equal(control.synced.length, 2);
  const syncedPaths = control.synced.flatMap((s: any) => s.asset.sourcePaths);
  assert.ok(syncedPaths.includes(path.join('folderA', 'clip.mp4')));
  assert.ok(syncedPaths.includes('loose.jpg'));

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION validation failures reject with a clear error (bad collectionId, empty items, escaping item, item inside HITLOOP-ARCHIVE)', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  await assert.rejects(
    () => (daemon as any).execute(selectionCommand('cmd-bad-collection', source.id, [{ relativePath: 'clip.mp4', kind: 'file' }], 'Not Valid!')),
    /valid collectionId/,
  );
  await assert.rejects(
    () => (daemon as any).execute(selectionCommand('cmd-empty-items', source.id, [], 'my-selection')),
    /at least one selection item/i,
  );
  await assert.rejects(
    () => (daemon as any).execute(selectionCommand('cmd-escape', source.id, [{ relativePath: '../outside', kind: 'folder' }], 'my-selection')),
    /escapes source root/,
  );
  await assert.rejects(
    () => (daemon as any).execute(selectionCommand('cmd-archive-item', source.id, [{ relativePath: 'HITLOOP-ARCHIVE/root/_unsorted', kind: 'folder' }], 'my-selection')),
    /inside HITLOOP-ARCHIVE/,
  );

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('run()-loop: a PROCESS_SELECTION validation failure (escaping item) is reported as FAILED, not thrown out of the poll loop', async () => {
  const f = await fixture();
  const control = fakeControl();

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  (control as any).pollCommands = async () => {
    (control as any).pollCommands = async () => [];
    return [selectionCommand('cmd-invalid', source.id, [{ relativePath: '../outside', kind: 'folder' }])];
  };
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const runPromise = daemon.run(15, 15);
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const failed = control.commands.find((c: any) => c.commandId === 'cmd-invalid' && c.state === 'FAILED');
    assert.ok(failed, 'expected the command to be reported FAILED, not thrown');
    assert.match(failed.error, /escapes source root/);
  } finally {
    daemon.stop();
    await runPromise;
  }

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('ORGANIZE_COLLECTION{items} plans/applies scoped to the selection under HITLOOP-ARCHIVE/<collectionId>/…, and UNDO_ORGANIZE{collectionId} restores it', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.sourceRoot, 'folderA'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'folderA', 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'loose.jpg'), 'image bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'other.jpg'), 'other bytes'); // never selected

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await worker.run(worker.createJob(source.id, '.').id); // hash everything first

  const items = [
    { relativePath: 'folderA', kind: 'folder' as const },
    { relativePath: 'loose.jpg', kind: 'file' as const },
  ];

  await (daemon as any).execute(organizeItemsCommand('cmd-items-plan', source.id, items, 'my-picks', 'plan'));
  const planned = control.commands.find((c: any) => c.commandId === 'cmd-items-plan' && c.state === 'COMPLETE');
  assert.ok(planned);
  assert.equal(planned.result.mode, 'plan');
  assert.equal(planned.result.plan.moves.length, 2);
  assert.equal(planned.result.plan.collectionId, 'my-picks');

  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  assert.equal(await exists(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE')), false); // plan writes nothing

  await (daemon as any).execute(organizeItemsCommand('cmd-items-apply', source.id, items, 'my-picks', 'apply'));
  const applied = control.commands.find((c: any) => c.commandId === 'cmd-items-apply' && c.state === 'COMPLETE');
  assert.ok(applied);
  assert.equal(applied.result.moved.length, 2);
  for (const move of applied.result.moved) {
    assert.match(move.to, new RegExp(`^HITLOOP-ARCHIVE[\\\\/]my-picks[\\\\/]`));
    assert.equal(await exists(path.join(f.sourceRoot, move.to)), true);
  }
  assert.equal(await exists(path.join(f.sourceRoot, 'folderA', 'clip.mp4')), false);
  assert.equal(await exists(path.join(f.sourceRoot, 'loose.jpg')), false);
  assert.equal(await exists(path.join(f.sourceRoot, 'other.jpg')), true); // untouched

  // UNDO_ORGANIZE resolved purely by collectionId (no relativePath/organizeJobId).
  const undoCommand = { id: 'cmd-items-undo', type: 'UNDO_ORGANIZE' as const, workerId: 'test-worker', sourceId: source.id, state: 'QUEUED' as const, collectionId: 'my-picks' };
  await (daemon as any).execute(undoCommand);
  const undone = control.commands.find((c: any) => c.commandId === 'cmd-items-undo' && c.state === 'COMPLETE');
  assert.ok(undone);
  assert.equal(undone.result.restored.length, 2);
  assert.equal(await exists(path.join(f.sourceRoot, 'folderA', 'clip.mp4')), true);
  assert.equal(await exists(path.join(f.sourceRoot, 'loose.jpg')), true);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

function cancelJobCommand(id: string, sourceId: string, overrides: { jobId?: string; targetCommandId?: string } = {}) {
  return { id, type: 'CANCEL_JOB' as const, workerId: 'test-worker', sourceId, state: 'QUEUED' as const, ...overrides };
}

test('CANCEL_JOB cancels the job currently active in the main lane and replies COMPLETE with hashedSoFar', async () => {
  const f = await fixture();
  for (let i = 0; i < 50; i++) {
    await fs.writeFile(path.join(f.sourceRoot, `file-${String(i).padStart(3, '0')}.txt`), `bytes-${i}`);
  }

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  // Simulate the main lane being mid-run(): manually populate the daemon's
  // activeJob tracking the way execute()'s PROCESS_COLLECTION path would,
  // and call cancel() through it directly, rather than actually racing two
  // concurrent execute() calls (covered by the run()-loop test below).
  const mainWorker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const job = mainWorker.createJob(source.id, '.');
  (daemon as any).activeJob = { jobId: job.id, commandId: 'main-cmd', worker: mainWorker };
  mainWorker.cancel(job.id); // pre-set so run() cancels almost immediately below
  await mainWorker.run(job.id);
  assert.equal(f.db.getJob(job.id)?.state, 'CANCELLED');

  await (daemon as any).execute(cancelJobCommand('cmd-cancel', source.id));

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-cancel' && c.state === 'COMPLETE');
  assert.ok(completed, 'CANCEL_JOB command must reach COMPLETE');
  assert.equal(completed.result.cancelled, true);
  assert.equal(completed.result.jobId, job.id);
  assert.equal(typeof completed.result.hashedSoFar, 'number');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('CANCEL_JOB with no active job falls back to failing a QUEUED target command by id', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  await (daemon as any).execute(cancelJobCommand('cmd-cancel-queued', source.id, { targetCommandId: 'queued-process-cmd' }));

  assert.deepEqual(
    control.commands.filter((c: any) => c.commandId === 'queued-process-cmd').map((c: any) => c.state),
    ['FAILED'],
  );
  const failedTarget = control.commands.find((c: any) => c.commandId === 'queued-process-cmd');
  assert.equal(failedTarget.error, 'CANCELLED');

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-cancel-queued' && c.state === 'COMPLETE');
  assert.ok(completed);
  assert.equal(completed.result.cancelled, true);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('CANCEL_JOB fails cleanly when nothing is active and no targetCommandId is given', async () => {
  const f = await fixture();
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  await (daemon as any).execute(cancelJobCommand('cmd-cancel-nothing', source.id));

  const failed = control.commands.find((c: any) => c.commandId === 'cmd-cancel-nothing' && c.state === 'FAILED');
  assert.ok(failed);
  assert.match(failed.error, /No active or queued job/);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_COLLECTION: a mid-run CANCEL_JOB stops the walk, marks the job CANCELLED, and fails the ORIGINAL command with the kept-hashed-count error (no analysis/sync)', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(f.sourceRoot, `file-${i}.mp4`), `video-bytes-${i}`);
  }

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  // Race a real execute(PROCESS_COLLECTION) against a CANCEL_JOB the moment
  // the daemon reports activeJob is set — proving the browse lane's
  // CANCEL_JOB can actually reach and stop the main lane while it's busy
  // inside worker.run(). The daemon's own internally-constructed worker uses
  // the default 2000ms stableFileDwellMs, so this genuinely lands the cancel
  // while the worker is mid-file (inside waitForStableFile) — the test just
  // takes ~2s wall-clock as a result, not a flaky race.
  const mainExecutePromise = (daemon as any).execute(collectionCommand('cmd-main', source.id));
  while (!(daemon as any).activeJob) await new Promise(r => setTimeout(r, 1));
  await (daemon as any).execute(cancelJobCommand('cmd-cancel', source.id));
  await mainExecutePromise;

  const mainFinal = control.commands.filter((c: any) => c.commandId === 'cmd-main').pop();
  assert.equal(mainFinal.state, 'FAILED');
  assert.match(mainFinal.error, /CANCELLED by owner \(kept \d+ hashed files\)/);

  // No analysis/sync ran for the cancelled job.
  assert.equal(control.synced.length, 0);

  assert.equal((daemon as any).activeJob, undefined, 'activeJob must be cleared once the main lane finishes');

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('run(): the browse lane claims CANCEL_JOB while a slow main-lane PROCESS_COLLECTION is still executing, and the main-lane command ends FAILED with the CANCELLED error', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(f.sourceRoot, `file-${i}.mp4`), `video-bytes-${i}`);
  }
  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  let mainServed = false;
  let cancelServed = false;
  (control as any).pollCommands = async (_workerId: string, opts?: { types?: string[]; excludeTypes?: string[] }) => {
    if (opts?.types?.includes('CANCEL_JOB')) {
      // Only issue the cancel once the main lane has actually claimed and
      // started its command (activeJob set), so this exercises the real
      // "claimed while busy" race rather than cancelling before anything runs.
      if (cancelServed || !(daemon as any).activeJob) return [];
      cancelServed = true;
      return [cancelJobCommand('cmd-cancel', source.id)];
    }
    if (mainServed) return [];
    mainServed = true;
    return [collectionCommand('cmd-main', source.id)];
  };

  const runPromise = daemon.run(15, 15);
  try {
    // The daemon's own internally-constructed worker uses the default 2000ms
    // stableFileDwellMs, so the main-lane command genuinely takes ~2s to
    // reach its terminal state once cancelled mid-file — poll for it instead
    // of a short fixed sleep (which was the whole point of the earlier
    // scheduling-only LIST_DIRECTORY test, but this one needs to observe the
    // real cancellation outcome, not just which lane claimed what).
    const deadline = Date.now() + 8000;
    let mainFinal: any;
    while (Date.now() < deadline) {
      mainFinal = control.commands.filter((c: any) => c.commandId === 'cmd-main').pop();
      if (mainFinal?.state === 'FAILED' || mainFinal?.state === 'COMPLETE') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(cancelServed, 'the browse lane must have claimed the CANCEL_JOB command');
    assert.ok(mainFinal, 'main-lane command must have reported at least one state update');
    assert.equal(mainFinal.state, 'FAILED');
    assert.match(mainFinal.error, /CANCELLED by owner/);
  } finally {
    daemon.stop();
    await runPromise;
  }

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_SELECTION mediaOnly:true skips non-media items and reports skippedNonMedia on the COMPLETE result', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'track.wav'), 'audio bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  const items = [
    { relativePath: 'clip.mp4', kind: 'file' as const },
    { relativePath: 'track.wav', kind: 'file' as const },
  ];
  const command = { ...selectionCommand('cmd-media-only', source.id, items, 'media-only-sel'), mediaOnly: true };
  await (daemon as any).execute(command);

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-media-only' && c.state === 'COMPLETE');
  assert.ok(completed);
  assert.equal(completed.result?.skippedNonMedia, 1);

  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path), ['clip.mp4']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('PROCESS_COLLECTION without mediaOnly hashes every file, unchanged (no skippedNonMedia on the result)', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');
  await fs.writeFile(path.join(f.sourceRoot, 'track.wav'), 'audio bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);

  await (daemon as any).execute(collectionCommand('cmd-no-media-only', source.id));

  const completed = control.commands.find((c: any) => c.commandId === 'cmd-no-media-only' && c.state === 'COMPLETE');
  assert.ok(completed);
  assert.equal(completed.result, undefined);

  const rows = f.db.db.prepare('SELECT relative_path FROM file_locations').all() as Array<{ relative_path: string }>;
  assert.deepEqual(rows.map(r => r.relative_path).sort(), ['clip.mp4', 'track.wav']);

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});

test('ORGANIZE_COLLECTION{items} validation failures reject with a clear error (missing collectionId, item inside HITLOOP-ARCHIVE)', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'clip.mp4'), 'video bytes');

  const control = fakeControl();
  const analysis = new ArchiveAnalysisService(f.db, { configured: false } as any);
  const daemon = new ArchiveDaemon(f.db, control as any, 'test-worker', analysis, new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));

  const worker = new ArchiveWorker(f.db, { stableFileDwellMs: 0 });
  const source = await worker.registerSource('test', f.sourceRoot);
  await worker.run(worker.createJob(source.id, '.').id);

  const missingCollectionId = { id: 'cmd-no-cid', type: 'ORGANIZE_COLLECTION' as const, workerId: 'test-worker', sourceId: source.id, state: 'QUEUED' as const, items: [{ relativePath: 'clip.mp4', kind: 'file' as const }] };
  await assert.rejects(() => (daemon as any).execute(missingCollectionId), /valid collectionId/);

  await assert.rejects(
    () => (daemon as any).execute(organizeItemsCommand('cmd-archive-item', source.id, [{ relativePath: 'HITLOOP-ARCHIVE/root', kind: 'folder' }], 'my-picks')),
    /inside HITLOOP-ARCHIVE/,
  );

  f.db.close();
  await fs.rm(f.dir, { recursive: true, force: true });
});
