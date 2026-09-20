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
