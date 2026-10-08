import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { runAnalyze } from './analyze';
import { BATCH_DISCOUNT, estimateCallUsd } from './cost';
import type { Cmd } from './control';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-batch-'));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MODEL = 'claude-haiku-4-5-20251001';

function setup(files: Record<string, string>) {
  const root = tmp(), home = tmp();
  for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); }
  const updates: any[] = [], pushed: any[] = [];
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const results: Record<string, any> = {}; // sha -> result object
  let polls = 0, endAfter = 2, nextId = 1;
  const fetchImpl = (async (url: any, init: any = {}) => {
    const u = String(url), method = init.method || 'GET';
    calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (method === 'POST' && u.endsWith('/v1/messages/batches')) return json({ id: `msgbatch_${nextId++}`, processing_status: 'in_progress' });
    if (method === 'POST' && u.endsWith('/cancel')) return json({ processing_status: 'canceling' });
    if (u.endsWith('/results')) {
      const body = calls.find(c => c.body?.requests)!.body.requests as Array<{ custom_id: string }>;
      return new Response(body.map(r => JSON.stringify({ custom_id: r.custom_id, result: results[r.custom_id] ?? ok() })).join('\n'), { status: 200 });
    }
    polls++;
    const ended = polls >= endAfter;
    return json({ id: u.split('/').pop(), processing_status: ended ? 'ended' : 'in_progress', request_counts: { processing: ended ? 0 : 2, succeeded: ended ? 2 : 0, errored: 0 }, results_url: ended ? `${u}/results` : null });
  }) as typeof fetch;
  const ok = () => ({ type: 'succeeded', message: { content: [{ type: 'tool_use', name: 'record_facets', input: { people: ['Jeff Mills'], ocrText: 'Jeff Mills live', summary: 'a flyer' } }], usage: { input_tokens: 2000, output_tokens: 500 } } });
  const deps: any = {
    store: { getSource: (id: string) => (id === 's1' ? { id, label: 'nas', rootPath: root } : undefined), knownFile: () => undefined },
    control: { update: async (u: any) => { updates.push(u); }, pushResults: async (_s: string, items: any[]) => { pushed.push(...items); } },
    vision: null, apiKey: 'k', fetchImpl, pollMs: 1,
    prepare: async () => ({ jpeg: Buffer.from('j'), thumb: Buffer.from('t'), width: 100, height: 50 }),
    isCancelled: () => false, organize: false,
    cacheDir: path.join(home, 'cache'), thumbDir: path.join(home, 'thumbs'), ledgerPath: path.join(home, 'cost.jsonl'),
    batchesPath: path.join(home, 'batches.json'),
    hashFile: async (p: string) => sha256(fs.readFileSync(p, 'utf8')),
  };
  return { root, home, updates, pushed, calls, results, deps, setEndAfter: (n: number) => { endAfter = n; }, ok };
}
const cmd = (extra: Partial<Cmd> = {}): Cmd => ({ id: 'b1', type: 'ANALYZE_FACETS', sourceId: 's1', paths: ['a'], batch: true, ...extra });

test('batch: estimate halves price and flags batch', async () => {
  const s = setup({ 'a/one.jpg': '1', 'a/two.jpg': '2' });
  const full: any = await runAnalyze(cmd({ dryRun: true, batch: false }), s.deps);
  const half: any = await runAnalyze(cmd({ dryRun: true }), s.deps);
  assert.equal(full.estimate.batch, undefined);
  assert.equal(half.estimate.batch, true);
  assert.equal(half.estimate.estUsd, Math.round(full.estimate.estUsd * BATCH_DISCOUNT * 1e6) / 1e6);
  assert.equal(half.estimate.perFileUsd, Math.round(full.estimate.perFileUsd * BATCH_DISCOUNT * 1e6) / 1e6);
});

test('batch: happy path submits, polls, saves cache/ledger at half cost, pushes', async () => {
  const s = setup({ 'a/one.jpg': 'AAA', 'a/two.jpg': 'BBB' });
  const r: any = await runAnalyze(cmd(), s.deps);
  const submits = s.calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/messages/batches'));
  assert.equal(submits.length, 1);
  const reqs = submits[0].body.requests;
  assert.equal(reqs.length, 2);
  assert.match(reqs[0].custom_id, /^[a-f0-9]{64}$/);
  assert.equal(reqs[0].params.tool_choice.name, 'record_facets');
  assert.equal(r.batch, true); assert.deepEqual(r.batchIds, ['msgbatch_1']);
  assert.equal(r.done, 2); assert.equal(r.pushed, 2); assert.equal(s.pushed.length, 2);
  const full = (2000 * 1 + 500 * 5) / 1e6;
  assert.equal(r.spentUsd, Math.round(full * BATCH_DISCOUNT * 2 * 1e6) / 1e6);
  const lines = fs.readFileSync(s.deps.ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2); assert.equal(lines[0].batch, true); assert.equal(lines[0].usd, full * BATCH_DISCOUNT);
  assert.equal(fs.readdirSync(s.deps.cacheDir).length, 2);
  assert.equal(s.pushed[0].facets.people[0], 'Jeff Mills');
  const prog = s.updates.filter(u => u.result?.progress).map(u => u.result.progress);
  assert.ok(prog.some(p => p.phase === 'waiting' && p.batchCounts.processing === 2));
  assert.ok(prog.some(p => p.phase === 'saving'));
  assert.deepEqual(Object.keys(prog.find(p => p.phase === 'waiting')).sort(), ['batchCounts', 'batchIds', 'done', 'phase', 'spentUsd', 'total']);
  assert.equal(JSON.parse(fs.readFileSync(s.deps.batchesPath, 'utf8')).msgbatch_1.state, 'processed');
  // Second run is all cache hits: no batch call at all.
  const n = s.calls.length;
  const again: any = await runAnalyze(cmd(), s.deps);
  assert.equal(again.cached, 2); assert.equal(s.calls.length, n);
});

test('batch: cap is enforced up front with cappedAt = files left out', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`a/f${i}.jpg`] = `f${i}`;
  const s = setup(files);
  const unit = estimateCallUsd(MODEL) * BATCH_DISCOUNT;
  const r: any = await runAnalyze(cmd({ capUsd: unit * 2.5 }), s.deps);
  const submitted = s.calls.find(c => c.body?.requests)!.body.requests;
  assert.equal(submitted.length, 2); assert.equal(r.cappedAt, 3);
});

test('batch: adopts a persisted in-flight batch instead of submitting again', async () => {
  const s = setup({ 'a/one.jpg': 'AAA', 'a/two.jpg': 'BBB' });
  fs.writeFileSync(s.deps.batchesPath, JSON.stringify({ msgbatch_old: { createdAt: 'x', commandId: 'old', shas: [sha256('AAA'), sha256('BBB')], state: 'submitted' } }));
  // The fake results endpoint reads the submit body; provide it via a seeded call.
  s.calls.push({ method: 'POST', url: 'seed', body: { requests: [{ custom_id: sha256('AAA') }, { custom_id: sha256('BBB') }] } });
  const r: any = await runAnalyze(cmd(), s.deps);
  assert.equal(s.calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/messages/batches')).length, 0);
  assert.deepEqual(r.batchIds, ['msgbatch_old']); assert.equal(r.pushed, 2);
  assert.equal(JSON.parse(fs.readFileSync(s.deps.batchesPath, 'utf8')).msgbatch_old.state, 'processed');
});

test('batch: errored result is counted and not billed', async () => {
  const s = setup({ 'a/one.jpg': 'AAA', 'a/two.jpg': 'BBB' });
  s.results[sha256('BBB')] = { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad image' } } };
  const r: any = await runAnalyze(cmd(), s.deps);
  assert.equal(r.errorCount, 1); assert.match(r.errors[0].error, /bad image/); assert.equal(r.errors[0].relativePath, 'a/two.jpg');
  assert.equal(r.pushed, 1);
  assert.equal(fs.readFileSync(s.deps.ledgerPath, 'utf8').trim().split('\n').length, 1);
  assert.equal(r.spentUsd, (2000 + 500 * 5) / 1e6 * BATCH_DISCOUNT);
});

test('batch: cancel calls the cancel endpoint and still collects results', async () => {
  const s = setup({ 'a/one.jpg': 'AAA', 'a/two.jpg': 'BBB' });
  let n = 0;
  const deps = { ...s.deps, isCancelled: () => ++n > 4 };
  const r: any = await runAnalyze(cmd(), deps);
  assert.ok(s.calls.some(c => c.method === 'POST' && c.url.endsWith('/msgbatch_1/cancel')));
  assert.equal(r.cancelled, true); assert.equal(r.batch, true);
});

test('batch: falsy batch leaves the sync path untouched (no batch fields)', async () => {
  const s = setup({ 'a/one.jpg': 'AAA' });
  let called = 0;
  const r: any = await runAnalyze(cmd({ batch: false }), { ...s.deps, vision: async () => { called++; return { raw: { summary: 's' }, usage: { inputTokens: 1, outputTokens: 1 } }; } });
  assert.equal(called, 1); assert.equal(r.batch, undefined); assert.equal(s.calls.length, 0);
});

test('batch: files known to ledger+cache are not hashed; new ones are; preparing progress reported', async () => {
  const s = setup({ 'a/k1.jpg': 'K1', 'a/k2.jpg': 'K2', 'a/k3.jpg': 'K3', 'a/n1.jpg': 'N1', 'a/n2.jpg': 'N2' });
  await runAnalyze(cmd({ paths: ['a/k1.jpg', 'a/k2.jpg', 'a/k3.jpg'] }), s.deps); // seeds ledger + cache
  let hashed: string[] = [];
  const deps = { ...s.deps, hashFile: async (p: string) => { hashed.push(path.basename(p)); return sha256(fs.readFileSync(p, 'utf8')); } };
  s.updates.length = 0;
  const r: any = await runAnalyze(cmd(), deps);
  assert.deepEqual(hashed.sort(), ['n1.jpg', 'n2.jpg']);
  assert.equal(r.cached, 3);
  const prep = s.updates.filter(u => u.result?.progress?.phase === 'preparing').map(u => u.result.progress);
  assert.ok(prep.length >= 2);
  assert.equal(prep[0].total, 5); assert.equal(prep[0].current, 'a/k1.jpg');
  assert.equal(prep[prep.length - 1].done, 5); assert.equal(prep[prep.length - 1].current, undefined);
});

test('batch: cap uses the measured ledger average, and leftOut is reported', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`a/f${i}.jpg`] = `f${i}`;
  const s = setup(files);
  const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ at: 'x', sha256: `z${i}`, relativePath: `other/${i}.jpg`, model: MODEL, promptVersion: 'p', inputTokens: 1, outputTokens: 1, usd: 0.004 }));
  fs.writeFileSync(s.deps.ledgerPath, lines.join('\n') + '\n');
  // measured 0.004 * 0.5 = 0.002/file; cap 0.0085 allows floor(4.25)=4 (rate-card price would allow fewer)
  const r: any = await runAnalyze(cmd({ capUsd: 0.0085 }), s.deps);
  assert.equal(s.calls.find(c => c.body?.requests)!.body.requests.length, 4);
  assert.equal(r.cappedAt, 2); assert.equal(r.leftOut, 2);
});

test('batch: the save phase reports real progress (done of total, current file), not a frozen "saving"', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`a/f${i}.jpg`] = `file${i}`;
  const s = setup(files);
  const r: any = await runAnalyze(cmd(), s.deps);
  assert.equal(r.done, 6);
  const saving = s.updates.filter(u => u.result?.progress).map(u => u.result.progress).filter((p: any) => p.phase === 'saving' && p.current);
  assert.ok(saving.length >= 1, 'at least one save-phase progress with a current file');
  for (const p of saving) { assert.equal(p.total, 6); assert.ok(p.done >= 1 && p.done <= 6); }
});
