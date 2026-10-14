import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneClient } from './control-plane';

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  (global as any).fetch = impl;
  return run().finally(() => { (global as any).fetch = original; });
}

function fakeResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

test('listIntake/updateIntake/purgeIntake no-op without HITLOOP_ARCHIVE_CONTROL_URL/token configured', async () => {
  const client = new ControlPlaneClient(undefined, undefined);
  await withFetch(async () => { throw new Error('should never be called'); }, async () => {
    assert.deepEqual(await client.listIntake('worker-1'), []);
    await assert.doesNotReject(() => client.updateIntake({ intakeId: 'i1', workerId: 'worker-1', state: 'CLAIMED' }));
    await assert.doesNotReject(() => client.purgeIntake({ intakeId: 'i1', workerId: 'worker-1' }));
  });
});

test('listIntake sends a Bearer-authorized GET with workerId and returns items', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const items = await withFetch(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return fakeResponse(200, { items: [{ intakeId: 'i1', storagePath: 'archive-intake/i1/f.jpg', fileName: 'f.jpg', contentType: 'image/jpeg', sizeBytes: 10, downloadUrl: 'https://example.test/i1', createdAt: null }] });
  }, () => client.listIntake('worker-1'));

  assert.equal(items.length, 1);
  assert.equal(items[0].intakeId, 'i1');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/archive/worker/intake');
  assert.equal(url.searchParams.get('workerId'), 'worker-1');
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer worker-token');
});

test('updateIntake PATCHes the intake route with the full payload', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return fakeResponse(200, { ok: true });
  }, () => client.updateIntake({ intakeId: 'i1', workerId: 'worker-1', state: 'HASHED', sha256: 'abc', contentAssetId: 'abc' }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'PATCH');
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, { intakeId: 'i1', workerId: 'worker-1', state: 'HASHED', sha256: 'abc', contentAssetId: 'abc' });
});

test('purgeIntake DELETEs the intake route and throws a clear error on failure', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  await withFetch(async () => fakeResponse(409, { error: 'not archived' }), async () => {
    await assert.rejects(() => client.purgeIntake({ intakeId: 'i1', workerId: 'worker-1' }), /HITLOOP intake purge failed: 409/);
  });
});

test('pollCommands with no opts sends only workerId, unchanged from before', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  const calls: Array<{ url: string }> = [];
  await withFetch(async (url: any) => {
    calls.push({ url: String(url) });
    return fakeResponse(200, { commands: [] });
  }, () => client.pollCommands('worker-1'));

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('workerId'), 'worker-1');
  assert.equal(url.searchParams.has('types'), false);
  assert.equal(url.searchParams.has('excludeTypes'), false);
});

test('pollCommands with opts.types sends a comma-joined types param', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  const calls: Array<{ url: string }> = [];
  await withFetch(async (url: any) => {
    calls.push({ url: String(url) });
    return fakeResponse(200, { commands: [] });
  }, () => client.pollCommands('worker-1', { types: ['LIST_DIRECTORY'] }));

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('types'), 'LIST_DIRECTORY');
  assert.equal(url.searchParams.has('excludeTypes'), false);
});

test('pollCommands with opts.excludeTypes sends a comma-joined excludeTypes param', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  const calls: Array<{ url: string }> = [];
  await withFetch(async (url: any) => {
    calls.push({ url: String(url) });
    return fakeResponse(200, { commands: [] });
  }, () => client.pollCommands('worker-1', { excludeTypes: ['LIST_DIRECTORY', 'UNDO_ORGANIZE'] }));

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('excludeTypes'), 'LIST_DIRECTORY,UNDO_ORGANIZE');
  assert.equal(url.searchParams.has('types'), false);
});

test('pollCommands with empty opts arrays omits both params', async () => {
  const client = new ControlPlaneClient('http://localhost:3000', 'worker-token');
  const calls: Array<{ url: string }> = [];
  await withFetch(async (url: any) => {
    calls.push({ url: String(url) });
    return fakeResponse(200, { commands: [] });
  }, () => client.pollCommands('worker-1', { types: [], excludeTypes: [] }));

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.has('types'), false);
  assert.equal(url.searchParams.has('excludeTypes'), false);
});
