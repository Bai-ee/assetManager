import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { AnalyzerControl } from './control';
import { AnalyzerDaemon } from './daemon';
import { createAnalyzerServer } from './server';
import type { AnalyzerPlugin } from './plugin';

const store: any = { listSources: () => [{ id: 's1', label: 'S', rootPath: '/r' }], getSource: (id: string) => (id === 's1' ? { id, label: 'S', rootPath: '/r' } : undefined), knownFile: () => undefined };
const mkPlugin = (run: AnalyzerPlugin['run']): AnalyzerPlugin => ({
  name: 'fake', commandTypes: ['FAKE_RUN'], run, routePrefix: '/fake/',
  route: async (req, ctx) => {
    if (req.pathname === '/fake/null') return null;
    if (req.pathname === '/fake/boom') throw new Error('kaput');
    return { status: 200, body: { method: req.method, body: req.body, src: ctx.getSource('s1')?.id, n: ctx.listSources().length, q: req.url.searchParams.get('q') } };
  },
});

test('plugin: daemon claims and runs plugin type, completes with result', async () => {
  const updates: any[] = []; let seen: any;
  const control: any = { update: async (u: any) => { updates.push(u); }, setExtraCommandTypes: (t: string[]) => { seen = t; } };
  const d = new AnalyzerDaemon(control, store, { plugins: [mkPlugin(async (cmd, ctx) => { await ctx.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: 1 } }); return { result: { ok: ctx.getSource('s1')?.id, extra: cmd.foo } }; })] });
  assert.deepEqual(seen, ['FAKE_RUN']);
  await d.handlePolled([{ id: 'p1', type: 'FAKE_RUN', foo: 'bar' }]);
  assert.ok(!updates.some(u => u.state === 'FAILED'));
  await d.runOne({ id: 'p1', type: 'FAKE_RUN', foo: 'bar' });
  const states = updates.filter(u => u.commandId === 'p1').map(u => u.state);
  assert.deepEqual(states, ['CLAIMED', 'RUNNING', 'RUNNING', 'COMPLETE']);
  assert.deepEqual(updates.at(-1).result, { ok: 's1', extra: 'bar' });
});

test('plugin: cancelled result and thrown error both FAIL', async () => {
  const updates: any[] = [];
  const control: any = { update: async (u: any) => { updates.push(u); } };
  const d = new AnalyzerDaemon(control, store, { plugins: [mkPlugin(async cmd => { if (cmd.id === 'e1') throw new Error('bad'); return { result: { partial: 1 }, cancelled: true }; })] });
  await d.runOne({ id: 'c1', type: 'FAKE_RUN' });
  const c = updates.at(-1);
  assert.equal(c.state, 'FAILED'); assert.equal(c.error, 'CANCELLED by owner'); assert.deepEqual(c.result, { partial: 1 });
  await d.runOne({ id: 'e1', type: 'FAKE_RUN' });
  assert.equal(updates.at(-1).state, 'FAILED'); assert.equal(updates.at(-1).error, 'bad');
});

test('plugin: unknown types still fail without plugins; poll types + capabilities include plugin types', async () => {
  const updates: any[] = [];
  const d = new AnalyzerDaemon({ update: async (u: any) => { updates.push(u); } } as any, store);
  await d.handlePolled([{ id: 'x', type: 'FAKE_RUN' }]);
  assert.equal(updates.at(-1).state, 'FAILED');

  const urls: string[] = []; let hb: any;
  const f = (async (u: any, init: any) => { urls.push(String(u)); if (init?.body) hb = JSON.parse(init.body); return new Response('{"commands":[]}', { status: 200 }); }) as typeof fetch;
  const c = new AnalyzerControl('https://h.example', 't', 'w', f);
  await c.poll();
  assert.equal(new URL(urls[0]).searchParams.get('types'), 'ANALYZE_FACETS,STAGE_FOR_PUBLISH,CANCEL_JOB,COLLECT_BATCHES');
  c.setExtraCommandTypes(['FAKE_RUN']);
  await c.poll(); await c.heartbeat('s1', 'ONLINE');
  assert.equal(new URL(urls[1]).searchParams.get('types'), 'ANALYZE_FACETS,STAGE_FOR_PUBLISH,CANCEL_JOB,COLLECT_BATCHES,FAKE_RUN');
  assert.deepEqual(hb.capabilities, ['ANALYZE_FACETS', 'STAGE_FOR_PUBLISH', 'CANCEL_JOB', 'COLLECT_BATCHES', 'FAKE_RUN']);
  new AnalyzerDaemon(c, store, { plugins: [mkPlugin(async () => ({ result: 1 }))] });
});

test('plugin: server routes prefix, enforces origin, 404 on null, 500 on throw, existing routes intact', async () => {
  const server = createAnalyzerServer({ workerId: 'w', thumbDir: '/nonexistent', store: { locate: () => [], ...store }, plugins: [mkPlugin(async () => ({ result: 1 }))] });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, p: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b })); });
    rq.on('error', reject); rq.end(body);
  });
  try {
    const ok = await call('POST', '/fake/x?q=7', '{"a":1}', { 'content-type': 'application/json' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { method: 'POST', body: { a: 1 }, src: 's1', n: 1, q: '7' });
    assert.deepEqual(JSON.parse((await call('GET', '/fake/x')).body).body, undefined);
    assert.equal((await call('GET', '/fake/x', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('GET', '/fake/x', undefined, { origin: 'http://localhost:3000' })).status, 200);
    assert.equal((await call('GET', '/fake/null')).status, 404);
    const boom = await call('GET', '/fake/boom');
    assert.equal(boom.status, 500); assert.deepEqual(JSON.parse(boom.body), { ok: false, error: 'kaput' });
    assert.equal((await call('POST', '/fake/x', 'nope')).status, 400);
    assert.equal((await call('POST', '/fake/x', 'x'.repeat(1_000_100))).status, 413);
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('POST', '/health')).status, 405);
  } finally { server.close(); }
});
