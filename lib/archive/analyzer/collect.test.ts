import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { collectPersistedBatches } from './collect';
import { runAnalyze } from './analyze';
import { BATCH_DISCOUNT, cacheKey } from './cost';
import { AnalyzerDaemon } from './daemon';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-collect-'));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MODEL = 'claude-haiku-4-5-20251001', PV = 'nas-facets-v1';
const ok = () => ({ type: 'succeeded', message: { content: [{ type: 'tool_use', name: 'record_facets', input: { ocrText: 'x', summary: 'a flyer' } }], usage: { input_tokens: 2000, output_tokens: 500 } } });

function setup(files: Record<string, string>) {
  const root = tmp(), home = tmp();
  for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); }
  const cacheDir = path.join(home, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const calls: string[] = [], pushed: any[] = [];
  const results: Record<string, any> = {};
  let status = 'ended';
  const fetchImpl = (async (url: any) => {
    const u = String(url); calls.push(u);
    if (u.endsWith('/results')) return new Response(Object.entries(results).map(([id, r]) => JSON.stringify({ custom_id: id, result: r })).join('\n'), { status: 200 });
    return new Response(JSON.stringify({ id: u.split('/').pop(), processing_status: status, results_url: `${u}/results` }), { status: 200 });
  }) as typeof fetch;
  let prepared = 0;
  const deps: any = {
    store: { getSource: (id: string) => (id === 's1' ? { id, label: 'nas', rootPath: root } : undefined) },
    control: { pushResults: async (_s: string, items: any[]) => { pushed.push(...items); } },
    prepare: async () => { prepared++; return { jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 10, height: 5 }; },
    apiKey: 'k', fetchImpl, organize: false,
    batchesPath: path.join(home, 'batches.json'), cacheDir, thumbDir: path.join(home, 'thumbs'), ledgerPath: path.join(home, 'cost.jsonl'),
  };
  const seedCache = (sha: string) => fs.writeFileSync(path.join(cacheDir, `${cacheKey(sha, PV, MODEL)}.json`), JSON.stringify({ sha256: sha, facets: {} }));
  const writeStore = (o: unknown) => fs.writeFileSync(deps.batchesPath, JSON.stringify(o));
  const readStore = () => JSON.parse(fs.readFileSync(deps.batchesPath, 'utf8'));
  const ledgerLines = () => (fs.existsSync(deps.ledgerPath) ? fs.readFileSync(deps.ledgerPath, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { root, deps, calls, pushed, results, seedCache, writeStore, readStore, ledgerLines, setStatus: (s: string) => { status = s; }, prepared: () => prepared };
}
const rec = (shas: string[], extra: Record<string, unknown> = {}) => ({ createdAt: 'x', commandId: 'c', shas, state: 'ended', model: MODEL, promptVersion: PV, ...extra });

test('collect: fully cached old record is marked processed with no network, no ledger, no push', async () => {
  const s = setup({});
  const a = sha256('A'), b = sha256('B');
  s.seedCache(a); s.seedCache(b);
  s.writeStore({ msgbatch_old: rec([a, b]), msgbatch_done: { ...rec([a]), state: 'processed' } });
  const r = await collectPersistedBatches(s.deps);
  assert.deepEqual(r.batches, [{ id: 'msgbatch_old', action: 'already-cached' }]);
  assert.equal(s.calls.length, 0); assert.equal(s.pushed.length, 0); assert.equal(s.ledgerLines().length, 0);
  assert.equal(s.readStore().msgbatch_old.state, 'processed');
  // Idempotent: nothing left to do.
  const again = await collectPersistedBatches(s.deps);
  assert.deepEqual(again.batches, []); assert.equal(s.calls.length, 0);
});

test('collect: partly cached record saves only missing shas once (ledger at half cost), pushes by stored path, marks processed', async () => {
  const s = setup({ 'a/one.jpg': 'A', 'a/two.jpg': 'B', 'b/dup.jpg': 'B' });
  const a = sha256('A'), b = sha256('B');
  s.seedCache(a);
  s.results[a] = ok(); s.results[b] = ok();
  s.writeStore({ msgbatch_1: rec([a, b], { sourceId: 's1', paths: { [a]: ['a/one.jpg'], [b]: ['a/two.jpg', 'b/dup.jpg'] } }) });
  const r = await collectPersistedBatches(s.deps);
  assert.equal(r.batches[0].action, 'collected');
  assert.equal(r.saved, 2); assert.equal(r.pushed, 2);
  assert.deepEqual(s.pushed.map(p => p.relativePath).sort(), ['a/two.jpg', 'b/dup.jpg']);
  const lines = s.ledgerLines().map(l => JSON.parse(l));
  assert.equal(lines.length, 1); assert.equal(lines[0].sha256, b); assert.equal(lines[0].batch, true);
  assert.equal(lines[0].usd, (2000 + 500 * 5) / 1e6 * BATCH_DISCOUNT);
  assert.equal(r.spentUsd, lines[0].usd);
  assert.equal(s.pushed.filter(p => p.costUsd > 0).length, 1);
  assert.equal(s.prepared(), 1);
  assert.equal(s.readStore().msgbatch_1.state, 'processed');
  assert.ok(!s.calls.some(c => !c.startsWith('https://api.anthropic.com/v1/messages/batches/msgbatch_1')));
});

test('collect: errored result is not billed and does not block processed', async () => {
  const s = setup({ 'a/one.jpg': 'A' });
  const a = sha256('A');
  s.results[a] = { type: 'errored', error: { error: { message: 'bad image' } } };
  s.writeStore({ msgbatch_1: rec([a], { sourceId: 's1', paths: { [a]: ['a/one.jpg'] } }) });
  const r = await collectPersistedBatches(s.deps);
  assert.equal(r.batches[0].action, 'collected'); assert.equal(r.batches[0].errors, 1);
  assert.equal(s.ledgerLines().length, 0); assert.equal(s.pushed.length, 0);
  assert.equal(s.readStore().msgbatch_1.state, 'processed');
});

test('collect: old record with uncached shas is left for a normal run (no network)', async () => {
  const s = setup({});
  s.writeStore({ msgbatch_old: rec([sha256('A')]) });
  const r = await collectPersistedBatches(s.deps);
  assert.deepEqual(r.batches, [{ id: 'msgbatch_old', action: 'needs-run' }]);
  assert.equal(s.calls.length, 0); assert.equal(s.readStore().msgbatch_old.state, 'ended');
});

test('collect: a batch still processing is not read; a failed save leaves it adoptable without billing', async () => {
  const s = setup({ 'a/one.jpg': 'A' });
  const a = sha256('A');
  s.results[a] = ok();
  s.writeStore({ msgbatch_1: rec([a], { state: 'submitted', sourceId: 's1', paths: { [a]: ['a/one.jpg'] } }) });
  s.setStatus('in_progress');
  let r = await collectPersistedBatches(s.deps);
  assert.equal(r.batches[0].action, 'still-processing');
  assert.ok(!s.calls.some(c => c.endsWith('/results'))); assert.equal(s.readStore().msgbatch_1.state, 'submitted');

  s.setStatus('ended');
  r = await collectPersistedBatches({ ...s.deps, prepare: async () => { throw new Error('nas gone'); } });
  assert.equal(r.batches[0].action, 'partial'); assert.equal(r.batches[0].errors, 1);
  assert.equal(s.ledgerLines().length, 0);
  assert.equal(s.readStore().msgbatch_1.state, 'ended');

  r = await collectPersistedBatches(s.deps); // retry succeeds, billed exactly once
  assert.equal(r.batches[0].action, 'collected');
  assert.equal(s.ledgerLines().length, 1); assert.equal(s.readStore().msgbatch_1.state, 'processed');
});

test('collect: no api key skips records that need a fetch', async () => {
  const s = setup({});
  const a = sha256('A');
  s.writeStore({ msgbatch_1: rec([a], { sourceId: 's1', paths: { [a]: ['a/one.jpg'] } }) });
  const r = await collectPersistedBatches({ ...s.deps, apiKey: undefined });
  assert.deepEqual(r.batches, [{ id: 'msgbatch_1', action: 'no-api-key' }]); assert.equal(s.calls.length, 0);
});

test('batch: new records persist sourceId and relative paths per sha', async () => {
  const s = setup({ 'a/one.jpg': 'A', 'a/copy.jpg': 'A', 'a/two.jpg': 'B' });
  let nextId = 1;
  const fetchImpl = (async (url: any, init: any = {}) => {
    const u = String(url), method = init.method || 'GET';
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (method === 'POST') return json({ id: `msgbatch_${nextId++}` });
    if (u.endsWith('/results')) return new Response('', { status: 200 });
    return json({ processing_status: 'ended', results_url: `${u}/results` });
  }) as typeof fetch;
  await runAnalyze({ id: 'c1', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], batch: true }, {
    ...s.deps, store: { ...s.deps.store, knownFile: () => undefined }, control: { ...s.deps.control, update: async () => undefined },
    vision: null, isCancelled: () => false, pollMs: 1, fetchImpl, hashFile: async (p: string) => sha256(fs.readFileSync(p, 'utf8')),
  });
  const r = s.readStore().msgbatch_1;
  assert.equal(r.sourceId, 's1');
  assert.deepEqual(r.paths[sha256('A')].sort(), ['a/copy.jpg', 'a/one.jpg']);
  assert.deepEqual(r.paths[sha256('B')], ['a/two.jpg']);
});

test('daemon: COLLECT_BATCHES is claimed and completed with the collect result; collectOnStart runs it once', async () => {
  const updates: any[] = [];
  let collects = 0;
  const control: any = { update: async (u: any) => { updates.push(u); }, heartbeat: async () => {}, poll: async () => [] };
  const store: any = { listSources: () => [], getSource: () => undefined, knownFile: () => undefined };
  const collect = async () => { collects++; return { batches: [], spentUsd: 0, saved: 0, pushed: 0 }; };
  const d = new AnalyzerDaemon(control, store, { handlers: { collect }, collectOnStart: true });
  await d.handlePolled([{ id: 'k1', type: 'COLLECT_BATCHES' }]);
  assert.ok(updates.some(u => u.commandId === 'k1' && u.state === 'CLAIMED'));
  const running = d.run(1, 1_000_000);
  while (!updates.some(u => u.commandId === 'k1' && u.state === 'COMPLETE')) await new Promise(r => setTimeout(r, 5));
  d.stop(); await running;
  assert.equal(collects, 2); // once on start, once for the command
  assert.deepEqual(updates.find(u => u.commandId === 'k1' && u.state === 'COMPLETE').result, { batches: [], spentUsd: 0, saved: 0, pushed: 0 });
});
