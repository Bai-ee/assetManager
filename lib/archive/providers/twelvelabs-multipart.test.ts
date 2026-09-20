import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { TwelveLabsAdapter } from './twelvelabs';

async function writeFixtureFile(size: number): Promise<{ dir: string; filePath: string; bytes: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-twelvelabs-multipart-'));
  const filePath = path.join(dir, 'clip.mp4');
  const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
  await fs.writeFile(filePath, bytes);
  return { dir, filePath, bytes };
}

/** The PUT body is a Web ReadableStream (from `Readable.toWeb`); read it back
 * into a Buffer so a test can assert on the exact bytes a chunk sent. */
async function collectWebStream(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.fromWeb(body as any)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => lower[key.toLowerCase()] ?? null } as any,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test('multipart path: create session, chunk PUTs with correct byte ranges, batched report, polled to completed', async () => {
  const totalSize = 90;
  const chunkSize = 40;
  const totalChunks = 3; // 40, 40, 10 — the last chunk is smaller
  const { dir, filePath, bytes } = await writeFixtureFile(totalSize);

  const putBytesByChunk = new Map<number, Buffer>();
  let reportedTotal = 0;
  let statusPolled = 0;
  let sawDirectUpload = false;

  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();

    if (method === 'POST' && url.endsWith('/v1.3/assets')) { sawDirectUpload = true; throw new Error('must not fall back to the direct path'); }

    if (method === 'POST' && url.endsWith('/v1.3/assets/multipart-uploads')) {
      const body = JSON.parse(init.body);
      assert.equal(body.type, 'video');
      assert.equal(body.total_size, totalSize);
      assert.equal(body.filename, 'clip.mp4');
      assert.equal(body.enable_hls, false);
      assert.equal(body.enable_thumbnail, false);
      const uploadUrls = Array.from({ length: totalChunks }, (_, i) => ({
        chunk_index: i + 1, url: `https://upload.example/chunk-${i + 1}`, expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }));
      return jsonResponse(201, { upload_id: 'up1', asset_id: 'asset-mp-1', chunk_size: chunkSize, total_chunks: totalChunks, upload_urls: uploadUrls, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    }

    if (method === 'PUT' && url.startsWith('https://upload.example/chunk-')) {
      const chunkIndex = Number(url.split('chunk-')[1]);
      putBytesByChunk.set(chunkIndex, await collectWebStream(init.body));
      return jsonResponse(200, {}, { etag: `"etag-${chunkIndex}"` });
    }

    if (method === 'POST' && url.endsWith('/v1.3/assets/multipart-uploads/up1')) {
      const body = JSON.parse(init.body);
      reportedTotal += body.completed_chunks.length;
      for (const c of body.completed_chunks) {
        assert.equal(c.proof_type, 'etag');
        assert.equal(c.proof, `"etag-${c.chunk_index}"`);
      }
      return jsonResponse(200, { total_completed: reportedTotal });
    }

    if (method === 'GET' && url.endsWith('/v1.3/assets/multipart-uploads/up1')) {
      statusPolled++;
      return jsonResponse(200, { status: 'completed' });
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  }) as unknown as typeof fetch;

  const adapter = new TwelveLabsAdapter('sk-test', undefined, 'https://api.twelvelabs.io/v1.3', 50, fakeFetch);
  const result = await adapter.submitVideo('asset1', filePath);

  assert.equal(result.status, 'SUBMITTED');
  assert.equal(result.providerAssetId, 'asset-mp-1');
  assert.equal(sawDirectUpload, false);

  assert.equal(putBytesByChunk.size, 3);
  assert.deepEqual(putBytesByChunk.get(1), bytes.subarray(0, 40));
  assert.deepEqual(putBytesByChunk.get(2), bytes.subarray(40, 80));
  assert.deepEqual(putBytesByChunk.get(3), bytes.subarray(80, 90));

  assert.equal(reportedTotal, 3);
  assert.equal(statusPolled, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a 5xx on one chunk retries then succeeds', async () => {
  const totalSize = 90;
  const chunkSize = 40;
  const totalChunks = 3;
  const { dir, filePath, bytes } = await writeFixtureFile(totalSize);

  const putAttempts = new Map<number, number>();
  const putBytesByChunk = new Map<number, Buffer>();
  let reportedTotal = 0;

  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();

    if (method === 'POST' && url.endsWith('/v1.3/assets/multipart-uploads')) {
      const uploadUrls = Array.from({ length: totalChunks }, (_, i) => ({
        chunk_index: i + 1, url: `https://upload.example/chunk-${i + 1}`, expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }));
      return jsonResponse(201, { upload_id: 'up2', asset_id: 'asset-mp-2', chunk_size: chunkSize, total_chunks: totalChunks, upload_urls: uploadUrls, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    }

    if (method === 'PUT' && url.startsWith('https://upload.example/chunk-')) {
      const chunkIndex = Number(url.split('chunk-')[1]);
      const attempt = (putAttempts.get(chunkIndex) || 0) + 1;
      putAttempts.set(chunkIndex, attempt);
      if (chunkIndex === 2 && attempt === 1) {
        await collectWebStream(init.body); // drain so the read stream isn't left dangling
        return jsonResponse(502, { error: 'bad gateway' });
      }
      putBytesByChunk.set(chunkIndex, await collectWebStream(init.body));
      return jsonResponse(200, {}, { etag: `"etag-${chunkIndex}"` });
    }

    if (method === 'POST' && url.endsWith('/v1.3/assets/multipart-uploads/up2')) {
      const body = JSON.parse(init.body);
      reportedTotal += body.completed_chunks.length;
      return jsonResponse(200, { total_completed: reportedTotal });
    }

    if (method === 'GET' && url.endsWith('/v1.3/assets/multipart-uploads/up2')) {
      return jsonResponse(200, { status: 'completed' });
    }

    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  }) as unknown as typeof fetch;

  const adapter = new TwelveLabsAdapter('sk-test', undefined, 'https://api.twelvelabs.io/v1.3', 50, fakeFetch);
  const result = await adapter.submitVideo('asset1', filePath);

  assert.equal(result.status, 'SUBMITTED');
  assert.equal(putAttempts.get(2), 2); // failed with a 502 once, succeeded on retry
  assert.deepEqual(putBytesByChunk.get(2), bytes.subarray(40, 80));
  assert.equal(reportedTotal, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a file under the multipart threshold still uses the direct upload path', async () => {
  const { dir, filePath } = await writeFixtureFile(10);
  const calls: Array<{ method: string; url: string }> = [];

  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ method, url });
    if (method === 'POST' && url.endsWith('/v1.3/assets')) {
      assert.ok(init.body instanceof FormData);
      return jsonResponse(201, { id: 'asset-direct-1' });
    }
    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  }) as unknown as typeof fetch;

  const adapter = new TwelveLabsAdapter('sk-test', undefined, 'https://api.twelvelabs.io/v1.3', 50, fakeFetch);
  const result = await adapter.submitVideo('asset1', filePath);

  assert.equal(result.status, 'SUBMITTED');
  assert.equal(result.providerAssetId, 'asset-direct-1');
  assert.equal(calls.length, 1);
  assert.equal(calls.some(c => c.url.includes('multipart-uploads')), false);

  await fs.rm(dir, { recursive: true, force: true });
});
