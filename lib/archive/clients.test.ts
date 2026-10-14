import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CLIENTS_MAP, clientForAllPaths, clientForPath, clientSlugForPath, loadClientsMap, withClientId } from './clients';
import { ArchiveDaemon } from './daemon';
import { ArchiveAnalysisService } from './analysis/service';
import { JevDecisionService } from './jev/service';
import { collectionIdFromOrganizedRelativePath, organizedCollectionFromRelativePath, targetPath } from './organize/scheme';
import { organizeCopy, isAnalyzerContentDir } from './analyzer/nas';
import { runAnalyze, walkMedia } from './analyzer/analyze';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';
import { planOrganizeCollection } from './organize/planner';
import { applyOrganizePlan, undoOrganizeJob } from './organize/mover';
import { readMoveJournal } from './organize/journal';

const UE = 'undergroundexistence-0CsKkpaq';
const NTR = 'nottherug-ten-QSMYxuuv';
const MAP = loadClientsMap({ 'underground-existence': UE, nottherug: NTR });

test('clients map: committed map validates and holds only the seeded public ids (no home)', () => {
  assert.deepEqual({ ...CLIENTS_MAP }, { 'underground-existence': UE, nottherug: NTR });
});

test('clientForPath: HITLOOP-ARCHIVE/<slug>/... and <slug>/... map; legacy/unknown map to null', () => {
  assert.equal(clientForPath('HITLOOP-ARCHIVE/underground-existence/mixes/was-there/a.mp4', MAP), UE);
  assert.equal(clientForPath('underground-existence/mixes/a.mp4', MAP), UE);
  assert.equal(clientForPath('underground-existence\\mixes\\a.mp4', MAP), UE);
  assert.equal(clientForPath('./nottherug/jobs/b.jpg', MAP), NTR);
  assert.equal(clientForPath('HITLOOP-ARCHIVE/content/flyer/1999/a.jpg', MAP), null);
  assert.equal(clientForPath('SomeCollection/a.mp4', MAP), null);
  assert.equal(clientForPath('HITLOOP-ARCHIVE/somecollection/was-there/a.mp4', MAP), null);
  assert.equal(clientForPath('Underground-Existence/a.mp4', MAP), null); // case-sensitive slug
  assert.equal(clientForPath('', MAP), null);
  assert.equal(clientSlugForPath('HITLOOP-ARCHIVE/nottherug/x/_unsorted/a.jpg', MAP), 'nottherug');
  // Same rule as the scheme: <slug>/<pillar|_unsorted|_meta> is a legacy collection named like the slug.
  assert.equal(clientSlugForPath('HITLOOP-ARCHIVE/nottherug/was-there/a.mp4', MAP), null);
  assert.equal(clientSlugForPath('HITLOOP-ARCHIVE/nottherug/_meta/moves.jsonl', MAP), null);
});

test('loadClientsMap: invalid entries throw at load', () => {
  assert.throws(() => loadClientsMap({ 'Bad Slug': UE }), /invalid slug/);
  assert.throws(() => loadClientsMap({ UPPER: UE }), /invalid slug/);
  assert.throws(() => loadClientsMap({ ok: 'x' }), /invalid clientId/);
  assert.throws(() => loadClientsMap({ ok: 'has space here' }), /invalid clientId/);
  assert.throws(() => loadClientsMap({ ok: 42 }), /invalid clientId/);
  assert.throws(() => loadClientsMap({ content: UE }), /reserved slug/);
  assert.throws(() => loadClientsMap({ root: UE }), /reserved slug/);
  assert.throws(() => loadClientsMap({ 'was-there': UE }), /reserved slug/);
  assert.throws(() => loadClientsMap([]), /JSON object/);
});

test('clientForAllPaths: one client only when every path agrees', () => {
  assert.equal(clientForAllPaths(['underground-existence/a.mp4', 'HITLOOP-ARCHIVE/underground-existence/m/_unsorted/a.mp4'], MAP), UE);
  assert.equal(clientForAllPaths(['underground-existence/a.mp4', 'home/a.mp4'], MAP), null);
  assert.equal(clientForAllPaths(['underground-existence/a.mp4', 'nottherug/a.mp4'], MAP), null);
  assert.equal(clientForAllPaths([], MAP), null);
});

test('withClientId: adds clientId only when mapped', () => {
  assert.equal(withClientId({ relativePath: 'underground-existence/a.jpg' }, MAP).clientId, UE);
  // organizedPath is ignored: shared sha-keyed sidecars can point a home file at a client's copy.
  assert.equal('clientId' in withClientId({ relativePath: 'in/a.jpg', organizedPath: 'HITLOOP-ARCHIVE/nottherug/content/flyer/unknown/a.jpg' }, MAP), false);
  const legacy = withClientId({ relativePath: 'in/a.jpg', organizedPath: 'HITLOOP-ARCHIVE/content/flyer/1999/a.jpg' }, MAP);
  assert.equal('clientId' in legacy, false);
});

test('scheme: client collection targetPath includes the slug; legacy unchanged', () => {
  const root = '/nas';
  assert.equal(targetPath(root, 'mixes', 'was-there', 'a.mp4', 'underground-existence'), path.join('/nas', 'HITLOOP-ARCHIVE', 'underground-existence', 'mixes', 'was-there', 'a.mp4'));
  assert.equal(targetPath(root, 'mixes', 'was-there', 'a.mp4'), path.join('/nas', 'HITLOOP-ARCHIVE', 'mixes', 'was-there', 'a.mp4'));
});

test('collectionIdFromOrganizedRelativePath: legacy and client-scoped shapes', () => {
  assert.equal(collectionIdFromOrganizedRelativePath('HITLOOP-ARCHIVE/mixes/was-there/a.mp4', MAP), 'mixes');
  assert.equal(collectionIdFromOrganizedRelativePath('HITLOOP-ARCHIVE/underground-existence/mixes/was-there/a.mp4', MAP), 'mixes');
  assert.deepEqual(organizedCollectionFromRelativePath('HITLOOP-ARCHIVE/underground-existence/mixes/_unsorted/a.mp4', MAP), { collectionId: 'mixes', clientSlug: 'underground-existence' });
  // A legacy collection that shares a slug's name keeps its legacy reading (next segment is a pillar bucket).
  assert.deepEqual(organizedCollectionFromRelativePath('HITLOOP-ARCHIVE/nottherug/was-there/a.mp4', MAP), { collectionId: 'nottherug', clientSlug: null });
  assert.equal(collectionIdFromOrganizedRelativePath('elsewhere/a.mp4', MAP), null);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clients-test-'));
const put = (root: string, rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); };
const sha = (c: string) => crypto.createHash('sha256').update(c).digest('hex');

test('analyzer copy: client items land under HITLOOP-ARCHIVE/<slug>/content; legacy unchanged; sidecar lookup still works', async () => {
  const root = tmp();
  put(root, 'underground-existence/mixes/flyer.jpg', 'UE'); put(root, 'in/flyer.jpg', 'HOME');
  const entry = { facets: { vibe: { kind: 'flyer' }, eventYear: 1999 } };
  const ue = await organizeCopy({ rootPath: root, sourceId: 's1', sha256: sha('UE'), originalAbs: path.join(root, 'underground-existence/mixes/flyer.jpg'), originalRelativePath: 'underground-existence/mixes/flyer.jpg', entry });
  assert.equal(ue, 'HITLOOP-ARCHIVE/underground-existence/content/flyer/1999/flyer.jpg');
  const home = await organizeCopy({ rootPath: root, sourceId: 's1', sha256: sha('HOME'), originalAbs: path.join(root, 'in/flyer.jpg'), originalRelativePath: 'in/flyer.jpg', entry });
  assert.equal(home, 'HITLOOP-ARCHIVE/content/flyer/1999/flyer.jpg');
  // Idempotent: second call returns the existing client copy via the shared _meta sidecar.
  assert.equal(await organizeCopy({ rootPath: root, sourceId: 's1', sha256: sha('UE'), originalAbs: path.join(root, 'underground-existence/mixes/flyer.jpg'), originalRelativePath: 'underground-existence/mixes/flyer.jpg', entry }), ue);
  // The client copy root is skipped by walks, like the legacy one.
  assert.equal(isAnalyzerContentDir('HITLOOP-ARCHIVE/underground-existence/content'), true);
  assert.equal(isAnalyzerContentDir('HITLOOP-ARCHIVE/somecollection/content'), false);
  assert.deepEqual(walkMedia(root, ['.']).map(f => f.relativePath).sort(), ['in/flyer.jpg', 'underground-existence/mixes/flyer.jpg']);
});

test('analyzer emit: pushed items carry clientId only when the path maps to a client', async () => {
  const root = tmp(), home = tmp();
  put(root, 'underground-existence/mixes/a.jpg', 'A'); put(root, 'SomeCollection/b.jpg', 'B');
  const pushed: any[] = [];
  await runAnalyze({ id: 'c1', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['.'] }, {
    store: { getSource: (id: string) => (id === 's1' ? { id, label: 'nas', rootPath: root } : undefined), knownFile: () => undefined },
    control: { update: async () => {}, pushResults: async (_s: string, items: any[]) => { pushed.push(...items); } },
    vision: async () => ({ raw: { summary: 'x' }, usage: { inputTokens: 10, outputTokens: 10 } }),
    prepare: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 1, height: 1 }),
    isCancelled: () => false,
    cacheDir: path.join(home, 'cache'), thumbDir: path.join(home, 'thumbs'), ledgerPath: path.join(home, 'cost.jsonl'),
    hashFile: async (p: string) => sha(fs.readFileSync(p, 'utf8')),
  } as any);
  const ue = pushed.find(i => i.relativePath === 'underground-existence/mixes/a.jpg');
  const legacy = pushed.find(i => i.relativePath === 'SomeCollection/b.jpg');
  assert.equal(ue?.clientId, UE);
  assert.ok(ue.organizedPath.startsWith('HITLOOP-ARCHIVE/underground-existence/content/'));
  assert.ok(legacy);
  assert.equal('clientId' in legacy, false);
});

test('organizer: a client-slug selection plans/applies into HITLOOP-ARCHIVE/<slug>/<collection>/ and undo restores', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clients-organize-'));
  const sourceRoot = path.join(dir, 'nas');
  await fsp.mkdir(path.join(sourceRoot, 'underground-existence', 'mixes'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'underground-existence', 'mixes', 'clip.mp4'), 'UE-VIDEO');
  const db = new ArchiveDatabase(path.join(dir, 'state.sqlite'));
  const worker = new ArchiveWorker(db, { stableFileDwellMs: 0, heartbeatEveryFiles: 1 });
  const source = await worker.registerSource('nas', sourceRoot);
  await worker.run(worker.createJob(source.id, '.').id);

  const plan = await planOrganizeCollection({ db, source, selectedRelativePath: 'underground-existence/mixes' });
  assert.equal(plan.clientSlug, 'underground-existence');
  assert.equal(plan.collectionId, 'underground-existence-mixes');
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].to, path.join('HITLOOP-ARCHIVE', 'underground-existence', 'underground-existence-mixes', '_unsorted', 'clip.mp4'));

  const applied = await applyOrganizePlan({ db, source, jobId: 'job-ue', plan });
  assert.equal(applied.failedAt, undefined);
  const journal = await readMoveJournal(sourceRoot, plan.collectionId, plan.clientSlug);
  assert.equal(journal.length, 1);
  assert.ok(fs.existsSync(path.join(sourceRoot, 'HITLOOP-ARCHIVE', 'underground-existence', 'underground-existence-mixes', '_meta', 'collection.json')));
  assert.equal(db.findLatestOrganizeJobIdForCollection(plan.collectionId, plan.clientSlug), 'job-ue');

  const undone = await undoOrganizeJob({ db, source, jobId: 'job-ue' });
  assert.deepEqual(undone.errors, []);
  assert.ok(fs.existsSync(path.join(sourceRoot, 'underground-existence', 'mixes', 'clip.mp4')));
  assert.equal((await readMoveJournal(sourceRoot, plan.collectionId, plan.clientSlug)).length, 2);

  const legacyPlan = await planOrganizeCollection({ db, source, selectedRelativePath: '.' });
  assert.equal(legacyPlan.clientSlug, undefined);
  assert.equal(legacyPlan.moves[0].to, path.join('HITLOOP-ARCHIVE', 'root', '_unsorted', 'clip.mp4'));
});

test('analyzer emit: a home file with the same bytes as a client file gets no clientId', async () => {
  const root = tmp(), home = tmp();
  put(root, 'underground-existence/mixes/a.jpg', 'SAME'); put(root, 'zhome/a.jpg', 'SAME');
  const pushed: any[] = [];
  await runAnalyze({ id: 'c2', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['.'] }, {
    store: { getSource: (id: string) => (id === 's1' ? { id, label: 'nas', rootPath: root } : undefined), knownFile: () => undefined },
    control: { update: async () => {}, pushResults: async (_s: string, items: any[]) => { pushed.push(...items); } },
    vision: async () => ({ raw: { summary: 'x' }, usage: { inputTokens: 10, outputTokens: 10 } }),
    prepare: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 1, height: 1 }),
    isCancelled: () => false,
    cacheDir: path.join(home, 'cache'), thumbDir: path.join(home, 'thumbs'), ledgerPath: path.join(home, 'cost.jsonl'),
    hashFile: async (p: string) => sha(fs.readFileSync(p, 'utf8')),
  } as any);
  const ue = pushed.find(i => i.relativePath === 'underground-existence/mixes/a.jpg');
  const homeItem = pushed.find(i => i.relativePath === 'zhome/a.jpg');
  assert.equal(ue?.clientId, UE);
  // The home item reuses the client's organized copy via the shared sha sidecar, but is NOT attributed to it.
  assert.ok(homeItem.organizedPath.startsWith('HITLOOP-ARCHIVE/underground-existence/content/'));
  assert.equal('clientId' in homeItem, false);
});

function fakeControl() {
  const synced: any[] = [], commands: any[] = [];
  return {
    configured: false, synced, commands,
    heartbeat: async () => {}, registerSource: async () => {}, pollCommands: async () => [],
    updateCommand: async (u: any) => { commands.push(u); }, syncAsset: async (p: any) => { synced.push(p); },
    listIntake: async () => [], updateIntake: async () => {}, purgeIntake: async () => {},
  };
}
async function daemonFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clients-daemon-'));
  const sourceRoot = path.join(dir, 'nas');
  await fsp.mkdir(sourceRoot, { recursive: true });
  const db = new ArchiveDatabase(path.join(dir, 'state.sqlite'));
  const control = fakeControl();
  const daemon = new ArchiveDaemon(db, control as any, 'test-worker', new ArchiveAnalysisService(db, { configured: false } as any), new JevDecisionService({ decide: async () => { throw new Error('not reached'); } } as any));
  const worker = new ArchiveWorker(db, { stableFileDwellMs: 0 });
  return { dir, sourceRoot, db, control, daemon, worker };
}

test('asset sync: clientId only when every location of a deduped asset maps to the same client', async () => {
  const f = await daemonFixture();
  await fsp.mkdir(path.join(f.sourceRoot, 'underground-existence'), { recursive: true });
  await fsp.mkdir(path.join(f.sourceRoot, 'home'), { recursive: true });
  await fsp.writeFile(path.join(f.sourceRoot, 'underground-existence', 'only.mp4'), 'UE-ONLY');
  await fsp.writeFile(path.join(f.sourceRoot, 'underground-existence', 'dup.mp4'), 'SHARED');
  await fsp.writeFile(path.join(f.sourceRoot, 'home', 'dup.mp4'), 'SHARED');
  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await (f.daemon as any).execute({ id: 'cmd-c', type: 'PROCESS_COLLECTION', workerId: 'test-worker', sourceId: source.id, relativePath: '.', state: 'QUEUED' });
  const bySha = (c: string) => f.control.synced.find((s: any) => s.asset.sha256 === sha(c));
  assert.equal(bySha('UE-ONLY')?.asset.clientId, UE);
  assert.ok(bySha('SHARED'));
  assert.equal('clientId' in bySha('SHARED').asset, false);
  f.db.close();
});

test('UNDO_ORGANIZE by relativePath still finds a collection organized before per-client NAS (legacy location)', async () => {
  const f = await daemonFixture();
  await fsp.mkdir(path.join(f.sourceRoot, 'underground-existence', 'mixes'), { recursive: true });
  await fsp.writeFile(path.join(f.sourceRoot, 'underground-existence', 'mixes', 'clip.mp4'), 'OLD-LAYOUT');
  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await f.worker.run(f.worker.createJob(source.id, '.').id);
  // Rebuild the pre-change plan shape: same collectionId, top-level legacy location, no clientSlug.
  const plan = await planOrganizeCollection({ db: f.db, source, selectedRelativePath: 'underground-existence/mixes' });
  const legacy = { ...plan, clientSlug: undefined, moves: plan.moves.map(m => ({ ...m, to: path.join('HITLOOP-ARCHIVE', plan.collectionId, '_unsorted', path.basename(m.from)) })) };
  const applied = await applyOrganizePlan({ db: f.db, source, jobId: 'old-job', plan: legacy });
  assert.equal(applied.failedAt, undefined);
  assert.ok(fs.existsSync(path.join(f.sourceRoot, 'HITLOOP-ARCHIVE', 'underground-existence-mixes', '_unsorted', 'clip.mp4')));

  await (f.daemon as any).execute({ id: 'cmd-u', type: 'UNDO_ORGANIZE', workerId: 'test-worker', sourceId: source.id, relativePath: 'underground-existence/mixes', state: 'QUEUED' });
  const done = f.control.commands.find((c: any) => c.commandId === 'cmd-u' && c.state === 'COMPLETE');
  assert.ok(done, JSON.stringify(f.control.commands));
  assert.ok(fs.existsSync(path.join(f.sourceRoot, 'underground-existence', 'mixes', 'clip.mp4')));
  f.db.close();
});

test('legacy job lookup for an id equal to a slug never matches that client\'s deeper paths', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clients-db-'));
  const db = new ArchiveDatabase(path.join(dir, 'state.sqlite'));
  const { recordOrganizeMove } = await import('./organize/journal');
  recordOrganizeMove(db, { jobId: 'client-job', sha256: 'a'.repeat(64), from: 'nottherug/x/a.mp4', to: 'HITLOOP-ARCHIVE/nottherug/nottherug-x/_unsorted/a.mp4', sizeBytes: 1, reason: 'organize' });
  assert.equal(db.findLatestOrganizeJobIdForCollection('nottherug'), undefined);
  assert.equal(db.findLatestOrganizeJobIdForCollection('nottherug-x', 'nottherug'), 'client-job');
  recordOrganizeMove(db, { jobId: 'legacy-job', sha256: 'b'.repeat(64), from: 'x/b.mp4', to: 'HITLOOP-ARCHIVE/nottherug/_unsorted/b.mp4', sizeBytes: 1, reason: 'organize' });
  assert.equal(db.findLatestOrganizeJobIdForCollection('nottherug'), 'legacy-job');
  db.close();
});

test('planner rejects mixed-scope item selections and legacy collections named like a slug', async () => {
  const f = await daemonFixture();
  await fsp.mkdir(path.join(f.sourceRoot, 'underground-existence'), { recursive: true });
  await fsp.mkdir(path.join(f.sourceRoot, 'NotTheRug'), { recursive: true });
  const source = await f.worker.registerSource('nas', f.sourceRoot);
  await assert.rejects(planOrganizeCollection({ db: f.db, source, collectionId: 'mixed', items: [
    { relativePath: 'underground-existence', kind: 'folder' }, { relativePath: 'NotTheRug', kind: 'folder' },
  ] }), /mixes client folders/);
  await assert.rejects(planOrganizeCollection({ db: f.db, source, collectionId: 'nottherug', items: [{ relativePath: 'NotTheRug', kind: 'folder' }] }), /reserved for a client folder/);
  // A folder at the root whose slugified name equals a slug (case differs, so it is home) is rejected too.
  await assert.rejects(planOrganizeCollection({ db: f.db, source, selectedRelativePath: 'NotTheRug' }), /reserved for a client folder/);
  f.db.close();
});
