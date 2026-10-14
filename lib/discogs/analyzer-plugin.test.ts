import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmdUpdate } from '../archive/analyzer/control';
import type { PluginContext } from '../archive/analyzer/plugin';
import type { SourceInfo } from '../archive/analyzer/store';
import type { DiscogsClient } from './client';
import type { LabelRead, MediaFile } from './types';
import { discogsPlugin, resolveFolder, DISCOGS_COMMAND_TYPES } from './analyzer-plugin';

const SRC: SourceInfo = { id: 'nas', label: 'NAS', rootPath: '/Volumes/bryan' };

function file(i: number): MediaFile {
  return {
    path: `/Volumes/bryan/MacTransfer/discogs/IMG_${i}.HEIC`, name: `IMG_${i}.HEIC`, kind: 'image', size: 1, fingerprint: `fp${String(i).padStart(14, '0')}`,
    capturedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3_600_000).toISOString(), mtime: '2026-01-01T00:00:00Z', seq: i, duplicateOf: null,
  };
}

function make(opts: { cancelled?: boolean; env?: Record<string, string | undefined> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'discogs-plugin-'));
  const calls = { reads: 0, scans: [] as string[] };
  const client = {
    configured: true,
    identity: async () => ({ id: 1, username: 'dj', resource_url: '' }),
    folders: async () => [{ id: 0, name: 'All', count: 42 }, { id: 1, name: 'Uncategorized', count: 40 }],
    collectionReleaseIds: async () => new Set<number>(),
  } as unknown as DiscogsClient;
  const plugin = discogsPlugin({
    home, env: opts.env ?? { DISCOGS_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, makeClient: () => client,
    runDeps: {
      scan: async dir => { calls.scans.push(dir); return [file(1), file(2)]; },
      toJpeg: async f => `/fake/${f.fingerprint}.jpg`,
      isCached: p => p.includes('fp00000000000001'),
      readLabel: async (_p, name) => { calls.reads++; return { file: name, status: 'readable', artist: 'A', title: 'T', label: 'L', catno: 'C1', year: null, tracks: [], side: null, notes: null, model: 'claude-sonnet-5-5', cached: false, usage: { inputTokens: 1000, outputTokens: 100 } } as LabelRead; },
      findCandidates: async () => [{ releaseId: 7, title: 'A - T', catno: 'C1', label: 'L', formats: ['Vinyl'], country: null, year: null, score: 0.95, reasons: ['catno exact'] }],
    },
  });
  const updates: CmdUpdate[] = [];
  const ctx: PluginContext = {
    update: async u => { updates.push(u); },
    isCancelled: () => opts.cancelled === true,
    getSource: id => (id === SRC.id ? SRC : undefined),
  };
  const routeCtx = { getSource: ctx.getSource, listSources: () => [SRC] };
  return { plugin, ctx, routeCtx, updates, calls };
}

test('plugin declares its command types and route prefix', () => {
  const { plugin } = make();
  assert.deepEqual(plugin.commandTypes, ['DISCOGS_PLAN', 'DISCOGS_APPLY', 'DISCOGS_UNDO']);
  assert.deepEqual(DISCOGS_COMMAND_TYPES, plugin.commandTypes);
  assert.equal(plugin.routePrefix, '/discogs/');
});

test('resolveFolder: joins root + relative, rejects absolute, .. and escape', () => {
  assert.equal(resolveFolder(SRC, 'MacTransfer/discogs'), '/Volumes/bryan/MacTransfer/discogs');
  assert.equal(resolveFolder(SRC, ''), '/Volumes/bryan');
  for (const bad of ['/etc', '../x', 'a/../../x', 'a/..', '..\\x', 'a\0b']) assert.throws(() => resolveFolder(SRC, bad), /not allowed|outside/, bad);
  assert.throws(() => resolveFolder(undefined, 'x'), /Unknown source/);
  assert.throws(() => resolveFolder(SRC, 5), /string/);
});

test('DISCOGS_PLAN rejects a path-escaping folder before reading anything', async () => {
  const { plugin, ctx, calls } = make();
  await assert.rejects(plugin.run({ id: 'c1', type: 'DISCOGS_PLAN', sourceId: 'nas', relativePath: '../secrets' }, ctx), /not allowed/);
  await assert.rejects(plugin.run({ id: 'c1', type: 'DISCOGS_PLAN', sourceId: 'nope', relativePath: 'x' }, ctx), /Unknown source/);
  assert.equal(calls.reads, 0);
  assert.equal(calls.scans.length, 0);
});

test('DISCOGS_PLAN validates limit and capUsd', async () => {
  const { plugin, ctx } = make();
  await assert.rejects(plugin.run({ id: 'c', type: 'DISCOGS_PLAN', sourceId: 'nas', relativePath: 'd', capUsd: 50 }, ctx), /capUsd/);
  await assert.rejects(plugin.run({ id: 'c', type: 'DISCOGS_PLAN', sourceId: 'nas', relativePath: 'd', capUsd: 0 }, ctx), /capUsd/);
  await assert.rejects(plugin.run({ id: 'c', type: 'DISCOGS_PLAN', sourceId: 'nas', relativePath: 'd', limit: 301 }, ctx), /limit/);
});

test('DISCOGS_PLAN result shape and RUNNING progress updates', async () => {
  const { plugin, ctx, updates, calls } = make();
  const out = await plugin.run({ id: 'c1', type: 'DISCOGS_PLAN', sourceId: 'nas', relativePath: 'MacTransfer/discogs', limit: 10, capUsd: 1 }, ctx);
  assert.equal(out.cancelled, false);
  const r = out.result as any;
  assert.deepEqual(Object.keys(r).sort(), ['capReached', 'cost', 'planId', 'relativePath', 'remaining', 'rows', 'sourceId', 'spentUsd', 'summary']);
  assert.equal(r.sourceId, 'nas');
  assert.equal(r.relativePath, 'MacTransfer/discogs');
  assert.deepEqual(Object.keys(r.cost).sort(), ['billedCalls', 'cachedCalls']);
  assert.deepEqual(r.summary, { groups: 2, add: 1, alreadyOwned: 1, review: 0, unreadable: 0 });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].action, 'add');
  assert.equal(r.capReached, false);
  assert.equal(r.remaining, 0);
  assert.equal(calls.scans[0], '/Volumes/bryan/MacTransfer/discogs');
  assert.ok(updates.length > 0);
  for (const u of updates) {
    assert.equal(u.commandId, 'c1');
    assert.equal(u.state, 'RUNNING');
    assert.ok((u.result as any).progress.phase);
  }
});

test('DISCOGS_PLAN cancel returns cancelled with partial rows', async () => {
  const { plugin, ctx } = make({ cancelled: true });
  const out = await plugin.run({ id: 'c1', type: 'DISCOGS_PLAN', sourceId: 'nas', relativePath: 'd' }, ctx);
  assert.equal(out.cancelled, true);
  assert.equal((out.result as any).rows.length, 0);
});

test('DISCOGS_APPLY / UNDO validate their input; unknown type fails', async () => {
  const { plugin, ctx } = make();
  await assert.rejects(plugin.run({ id: 'c', type: 'DISCOGS_APPLY', planId: 'p', items: [] }, ctx), /items/);
  await assert.rejects(plugin.run({ id: 'c', type: 'DISCOGS_APPLY', planId: 'p', items: [{ groupId: 'g', releaseId: 'x' }] }, ctx), /releaseId/);
  await assert.rejects(plugin.run({ id: 'c', type: 'DISCOGS_UNDO', journal: '../x-applied.jsonl' }, ctx), /Invalid journal/);
  await assert.rejects(plugin.run({ id: 'c', type: 'NOPE' }, ctx), /Unsupported/);
});

test('GET /discogs/status shape', async () => {
  const { plugin, routeCtx } = make({ env: { DISCOGS_TOKEN: 't', ANTHROPIC_API_KEY: 'k', DISCOGS_DEFAULT_DIR: '/Volumes/bryan/MacTransfer/discogs' } });
  const res = await plugin.route!({ method: 'GET', pathname: '/discogs/status', url: new URL('http://x/discogs/status'), body: undefined }, routeCtx);
  assert.equal(res?.status, 200);
  assert.deepEqual(res?.body, {
    ok: true, configured: { discogsToken: true, anthropicKey: true }, username: 'dj', collectionCount: 42,
    defaultSourceId: 'nas', defaultPath: 'MacTransfer/discogs',
  });
});

test('status without keys reports unconfigured and makes no identity call', async () => {
  const { plugin, routeCtx } = make({ env: {} });
  const res = await plugin.route!({ method: 'GET', pathname: '/discogs/status', url: new URL('http://x/discogs/status'), body: undefined }, routeCtx);
  const b = res?.body as any;
  assert.deepEqual(b.configured, { discogsToken: false, anthropicKey: false });
  assert.equal(b.username, null);
  assert.equal(b.collectionCount, null);
});

test('POST /discogs/estimate shape, no model calls', async () => {
  const { plugin, routeCtx, calls } = make();
  const res = await plugin.route!({ method: 'POST', pathname: '/discogs/estimate', url: new URL('http://x/discogs/estimate'), body: { sourceId: 'nas', relativePath: 'MacTransfer/discogs' } }, routeCtx);
  assert.equal(res?.status, 200);
  const b = res?.body as any;
  assert.equal(b.ok, true);
  assert.deepEqual(Object.keys(b).sort(), ['cachedReads', 'estUsd', 'groups', 'images', 'model', 'ok', 'perReadUsd', 'uncachedReads', 'videos']);
  assert.equal(b.groups, 2);
  assert.equal(b.cachedReads, 1);
  assert.equal(b.uncachedReads, 1);
  assert.equal(calls.reads, 0);
});

test('estimate rejects escaping paths (400); unknown paths are null; wrong method 405', async () => {
  const { plugin, routeCtx } = make();
  const bad = await plugin.route!({ method: 'POST', pathname: '/discogs/estimate', url: new URL('http://x/discogs/estimate'), body: { sourceId: 'nas', relativePath: '../x' } }, routeCtx);
  assert.equal(bad?.status, 400);
  assert.equal((bad?.body as any).ok, false);
  assert.equal(await plugin.route!({ method: 'GET', pathname: '/discogs/nope', url: new URL('http://x/discogs/nope'), body: undefined }, routeCtx), null);
  assert.equal((await plugin.route!({ method: 'GET', pathname: '/discogs/estimate', url: new URL('http://x/discogs/estimate'), body: undefined }, routeCtx))?.status, 405);
});
