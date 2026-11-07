import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CmdUpdate } from '../archive/analyzer/control';
import type { PluginContext } from '../archive/analyzer/plugin';
import type { SourceInfo } from '../archive/analyzer/store';
import { PHOTOLIB_COMMAND_TYPES, photolibPlugin, resolveLibraryDir, type PhotolibDeps } from './analyzer-plugin';

const SRC: SourceInfo = { id: 'nas', label: 'NAS', rootPath: '/Volumes/bryan' };
const LIB = 'Drive 1/Photos Library.photoslibrary';

function make(over: Partial<PhotolibDeps> = {}, ctxOver: { cancelled?: boolean } = {}) {
  const calls: { name: string; arg: any }[] = [];
  const updates: CmdUpdate[] = [];
  let closed = 0;
  const manifest = {
    getRun: (id: string) => (id === 'run-1' ? { sourceId: 'nas' } : undefined),
    close: () => { closed++; },
    upsertSource: (s: unknown) => calls.push({ name: 'upsertSource', arg: s }),
  };
  const plan = { planId: 'plan-1', totals: { items: 30 }, warnings: [{ reason: 'w' }], items: Array.from({ length: 30 }, (_, i) => ({ sha256: `s${i}`, action: 'copy', canonicalPath: `c${i}`, item: { relativePath: `r${i}`, absPath: `/abs/${i}` } })) };
  const deps: Partial<PhotolibDeps> = {
    openManifest: () => manifest as never,
    buildPlan: async o => { calls.push({ name: 'buildPlan', arg: o }); return plan as never; },
    savePlan: p => { calls.push({ name: 'savePlan', arg: p }); },
    loadPlan: id => { calls.push({ name: 'loadPlan', arg: id }); return plan as never; },
    applyPlan: async (p, o) => { calls.push({ name: 'applyPlan', arg: { p, limit: o.limit } }); o.onProgress?.({ done: 1, total: 2, bytes: 5 }); return { runId: 'run-9', copied: 1, cancelled: o.isCancelled?.() }; },
    undoRun: async (id, o) => { calls.push({ name: 'undoRun', arg: { id, destRoot: o.destRoot, limit: o.limit } }); return { undone: 1 }; },
    runThumbs: async o => { calls.push({ name: 'runThumbs', arg: o }); return { done: 2 }; },
    runPush: async o => { calls.push({ name: 'runPush', arg: o }); return { pushed: 1, skipped: [], uploaded: 2, errors: [] }; },
    getSourceRow: () => ({ kind: 'photos', libraryPath: LIB, label: 'Drive 1' }),
    readStatus: () => ({ assets: 3, pushed: 1, missingThumbs: 2, lastRuns: [{ runId: 'run-9' }] }),
    closeExif: async () => { calls.push({ name: 'closeExif', arg: null }); },
    ...over,
  };
  const ctx: PluginContext = {
    update: async u => { updates.push(u); },
    isCancelled: () => ctxOver.cancelled === true,
    getSource: id => (id === 'nas' ? SRC : undefined),
  };
  let t = 0;
  const plugin = photolibPlugin({ home: '/h', deps, now: () => (t += 2000) });
  return { plugin, ctx, calls, updates, closed: () => closed };
}
const cmd = (type: string, extra: Record<string, unknown> = {}) => ({ id: 'c1', type, ...extra });

test('command types + route prefix', () => {
  const { plugin } = make();
  assert.deepEqual(plugin.commandTypes, PHOTOLIB_COMMAND_TYPES);
  assert.equal(plugin.routePrefix, '/photolib/');
});

test('PLAN resolves library under the source root, saves plan, returns a ≤20 sample, closes manifest + exif', async () => {
  const { plugin, ctx, calls, closed } = make();
  const r = await plugin.run(cmd('PHOTOLIB_PLAN', { sourceId: 'nas', libraryPath: LIB, limit: 5 }), ctx);
  const build = calls.find(c => c.name === 'buildPlan')!.arg;
  assert.equal(build.libraryPath, `/Volumes/bryan/${LIB}`);
  assert.equal(build.destRoot, '/Volumes/bryan'); assert.equal(build.sourceId, 'nas'); assert.equal(build.limit, 5);
  const res = r.result as any;
  assert.equal(res.planId, 'plan-1'); assert.equal(res.sample.length, 20);
  assert.deepEqual(Object.keys(res.sample[0]).sort(), ['action', 'canonicalPath', 'relativePath', 'sha256']);
  assert.ok(calls.some(c => c.name === 'savePlan' && c.arg.planId === 'plan-1'));
  assert.equal(calls.find(c => c.name === 'upsertSource')!.arg.libraryPath, LIB);
  assert.ok(calls.some(c => c.name === 'closeExif'));
  assert.equal(closed(), 1);
});

test('PLAN rejects bad library paths with a clear message', async () => {
  const { plugin, ctx, calls, closed } = make();
  for (const libraryPath of ['../etc/x.photoslibrary', '/abs/x.photoslibrary', 'a/../../x.photoslibrary', 'Drive 1/NotALibrary', '', undefined]) {
    await assert.rejects(plugin.run(cmd('PHOTOLIB_PLAN', { sourceId: 'nas', libraryPath }), ctx), /library|Library|required|not allowed/);
  }
  await assert.rejects(plugin.run(cmd('PHOTOLIB_PLAN', { sourceId: 'nope', libraryPath: LIB }), ctx), /Unknown source/);
  assert.ok(!calls.some(c => c.name === 'buildPlan'));
  assert.equal(closed(), 7);
});

test('PLAN rejects a bad limit', async () => {
  const { plugin, ctx } = make();
  await assert.rejects(plugin.run(cmd('PHOTOLIB_PLAN', { sourceId: 'nas', libraryPath: LIB, limit: 0 }), ctx), /limit/);
});

test('APPLY loads the plan, throttles progress to ≥1s, passes limit', async () => {
  const { plugin, ctx, calls, updates } = make();
  const r = await plugin.run(cmd('PHOTOLIB_APPLY', { planId: 'plan-1', limit: 3 }), ctx);
  assert.equal(calls.find(c => c.name === 'loadPlan')!.arg, 'plan-1');
  assert.equal(calls.find(c => c.name === 'applyPlan')!.arg.limit, 3);
  assert.equal((r.result as any).runId, 'run-9');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].result, { progress: { done: 1, total: 2, bytes: 5 } });
});

test('APPLY honours cancellation and reports it', async () => {
  const { plugin, ctx } = make({}, { cancelled: true });
  const r = await plugin.run(cmd('PHOTOLIB_APPLY', { planId: 'plan-1' }), ctx);
  assert.equal(r.cancelled, true);
});

test('progress updates inside the same second are dropped', async () => {
  let t = 0;
  const updates: CmdUpdate[] = [];
  const { ctx } = make();
  const plugin = photolibPlugin({
    home: '/h', now: () => (t += 100),
    deps: { openManifest: () => ({ getRun: () => undefined, close() {} }) as never, loadPlan: () => ({}) as never,
      applyPlan: async (_p, o) => { for (let i = 1; i <= 5; i++) o.onProgress?.({ done: i, total: 10 }); return {}; } },
  });
  await plugin.run(cmd('PHOTOLIB_APPLY', { planId: 'plan-1' }), { ...ctx, update: async u => { updates.push(u); } });
  assert.equal(updates.length, 1);
});

test('UNDO resolves destRoot from the run source', async () => {
  const { plugin, ctx, calls } = make();
  await plugin.run(cmd('PHOTOLIB_UNDO', { runId: 'run-1', limit: 4 }), ctx);
  assert.deepEqual(calls.find(c => c.name === 'undoRun')!.arg, { id: 'run-1', destRoot: '/Volumes/bryan', limit: 4 });
  await assert.rejects(plugin.run(cmd('PHOTOLIB_UNDO', { runId: 'zzz' }), ctx), /Unknown runId/);
});

test('THUMBS needs a source and uses the home cache dir', async () => {
  const { plugin, ctx, calls } = make();
  await plugin.run(cmd('PHOTOLIB_THUMBS', { sourceId: 'nas', limit: 2 }), ctx);
  const a = calls.find(c => c.name === 'runThumbs')!.arg;
  assert.equal(a.destRoot, '/Volumes/bryan'); assert.equal(a.cacheDir, '/h/thumbs'); assert.equal(a.limit, 2);
  await assert.rejects(plugin.run(cmd('PHOTOLIB_THUMBS', {}), ctx), /sourceId/);
});

test('PUSH builds the share-relative source info and passes force', async () => {
  const { plugin, ctx, calls } = make();
  await plugin.run(cmd('PHOTOLIB_PUSH', { sourceId: 'nas', force: true }), ctx);
  const a = calls.find(c => c.name === 'runPush')!.arg;
  assert.deepEqual(a.source, { id: 'nas', kind: 'photos', label: 'Drive 1', libraryPath: LIB });
  assert.equal(a.force, true);
});

test('PUSH converts an absolute manifest library path to share-relative and refuses outside paths', async () => {
  const abs = make({ getSourceRow: () => ({ kind: 'photos', libraryPath: `/Volumes/bryan/${LIB}`, label: null }) });
  await abs.plugin.run(cmd('PHOTOLIB_PUSH', { sourceId: 'nas' }), abs.ctx);
  assert.equal(abs.calls.find(c => c.name === 'runPush')!.arg.source.libraryPath, LIB);
  const out = make({ getSourceRow: () => ({ kind: 'photos', libraryPath: '/elsewhere/L.photoslibrary', label: null }) });
  await assert.rejects(out.plugin.run(cmd('PHOTOLIB_PUSH', { sourceId: 'nas' }), out.ctx), /outside/);
});

test('unsupported command type throws', async () => {
  const { plugin, ctx } = make();
  await assert.rejects(plugin.run(cmd('PHOTOLIB_NOPE'), ctx), /Unsupported/);
});

test('GET /photolib/status', async () => {
  const { plugin, closed } = make();
  const route = plugin.route!;
  const ok = await route({ method: 'GET', pathname: '/photolib/status', url: new URL('http://x/photolib/status'), body: undefined }, { getSource: () => SRC, listSources: () => [SRC] });
  assert.equal(ok!.status, 200);
  assert.deepEqual(ok!.body, { ok: true, assets: 3, pushed: 1, missingThumbs: 2, lastRuns: [{ runId: 'run-9' }] });
  assert.equal((await route({ method: 'POST', pathname: '/photolib/status', url: new URL('http://x/photolib/status'), body: {} }, { getSource: () => SRC, listSources: () => [] }))!.status, 405);
  assert.equal(await route({ method: 'GET', pathname: '/photolib/other', url: new URL('http://x/photolib/other'), body: undefined }, { getSource: () => SRC, listSources: () => [] }), null);
  assert.equal(closed(), 1);
});

test('resolveLibraryDir', () => {
  assert.equal(resolveLibraryDir(SRC, LIB), `/Volumes/bryan/${LIB}`);
  assert.throws(() => resolveLibraryDir(SRC, '.'), /outside|required/);
  assert.throws(() => resolveLibraryDir(undefined, LIB), /Unknown source/);
});
