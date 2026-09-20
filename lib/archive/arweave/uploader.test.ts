import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
// Default imports (not the `* as` namespace) resolve to configurable data
// properties under tsx's ESM transpile; node:test's mock.method() needs that
// to replace a method, so the readFile/readFileSync spies use these.
import fsDefault from 'fs';
import fspDefault from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { uploadOriginalToArweave, type TurboUploadClient } from './uploader';

const FILE_BYTES = 3 * 1024 * 1024; // a few MB, small enough for a fast test, large enough to prove streaming

async function tempAsset(bytes = FILE_BYTES) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hitloop-arweave-'));
  const filePath = path.join(dir, 'asset.bin');
  // Write via a stream in chunks so the test fixture itself never holds the
  // whole buffer in memory either.
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const chunk = Buffer.alloc(64 * 1024, 7);
    let written = 0;
    out.on('error', reject);
    out.on('finish', resolve);
    function writeMore() {
      let ok = true;
      while (written < bytes && ok) {
        const slice = chunk.subarray(0, Math.min(chunk.length, bytes - written));
        written += slice.length;
        ok = written >= bytes ? (out.end(slice), true) : out.write(slice);
      }
      if (written < bytes) out.once('drain', writeMore);
    }
    writeMore();
  });
  return { dir, filePath };
}

function fakeClient(uploadFile: TurboUploadClient['uploadFile']): TurboUploadClient & { calls: Array<Parameters<TurboUploadClient['uploadFile']>[0]> } {
  const calls: Array<Parameters<TurboUploadClient['uploadFile']>[0]> = [];
  return {
    calls,
    async uploadFile(params) {
      calls.push(params);
      return uploadFile(params);
    },
  };
}

test('never reads the original file into memory before streaming it', async () => {
  const readFileSpy = mock.method(fspDefault, 'readFile');
  const readFileSyncSpy = mock.method(fsDefault, 'readFileSync');
  const { dir, filePath } = await tempAsset();
  try {
    const client = fakeClient(async () => ({ id: 'fake-tx-id' }));
    await uploadOriginalToArweave({
      filePath,
      archiveName: 'asset.bin',
      sha256: 'deadbeef',
      collectionId: 'collection-1',
      turboClient: client,
    });
    assert.equal(readFileSpy.mock.callCount(), 0, 'fs/promises readFile must never be called');
    assert.equal(readFileSyncSpy.mock.callCount(), 0, 'fs readFileSync must never be called');
  } finally {
    readFileSpy.mock.restore();
    readFileSyncSpy.mock.restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('fileStreamFactory yields a fresh readable stream and fileSizeFactory matches stat size', async () => {
  const { dir, filePath } = await tempAsset();
  try {
    const client = fakeClient(async () => ({ id: 'fake-tx-id' }));
    await uploadOriginalToArweave({
      filePath,
      archiveName: 'asset.bin',
      sha256: 'deadbeef',
      collectionId: 'collection-1',
      turboClient: client,
    });
    assert.equal(client.calls.length, 1);
    const call = client.calls[0];
    assert.equal(typeof call.fileStreamFactory, 'function');
    assert.equal(typeof call.fileSizeFactory, 'function');
    assert.equal(call.fileSizeFactory(), FILE_BYTES);

    // The SDK's signer calls fileStreamFactory() twice (size/sign pass, then
    // hash+send pass) and needs two independent streams, not one shared one.
    const streamA = call.fileStreamFactory();
    const streamB = call.fileStreamFactory();
    assert.notEqual(streamA, streamB);
    let bytesA = 0;
    await new Promise<void>((resolve, reject) => {
      streamA.on('data', (chunk: Buffer) => { bytesA += chunk.length; });
      streamA.on('end', resolve);
      streamA.on('error', reject);
    });
    assert.equal(bytesA, FILE_BYTES);
    streamB.destroy();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('result contract is unchanged: transactionId, arweaveUrl, sizeBytes, tags', async () => {
  const { dir, filePath } = await tempAsset();
  try {
    const client = fakeClient(async () => ({ id: 'tx-abc123' }));
    const result = await uploadOriginalToArweave({
      filePath,
      archiveName: 'clip.mp4',
      contentType: 'video/mp4',
      sha256: 'cafebabe',
      collectionId: 'collection-9',
      turboClient: client,
    });
    assert.deepEqual(Object.keys(result).sort(), ['arweaveUrl', 'sizeBytes', 'tags', 'transactionId']);
    assert.equal(result.transactionId, 'tx-abc123');
    assert.equal(result.arweaveUrl, 'https://arweave.net/tx-abc123');
    assert.equal(result.sizeBytes, FILE_BYTES);
    assert.ok(Array.isArray(result.tags));
    const tag = (name: string) => result.tags.find(t => t.name === name)?.value;
    assert.equal(tag('SHA-256'), 'cafebabe');
    assert.equal(tag('Collection-ID'), 'collection-9');
    assert.equal(tag('Content-Type'), 'video/mp4');
    assert.equal(tag('File-Name'), 'clip.mp4');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('throws a clear, wrapped error when Turbo rejects (e.g. a non-2xx response)', async () => {
  const { dir, filePath } = await tempAsset();
  try {
    const client = fakeClient(async () => {
      throw new Error('Upload Service responded with 402: insufficient balance');
    });
    await assert.rejects(
      () => uploadOriginalToArweave({
        filePath,
        archiveName: 'asset.bin',
        sha256: 'deadbeef',
        collectionId: 'collection-1',
        turboClient: client,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Arweave streaming upload failed for asset\.bin/);
        assert.match(error.message, /deadbeef/);
        assert.match(error.message, /402: insufficient balance/);
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('throws a clear, wrapped error when the stream errors mid-upload', async () => {
  const { dir, filePath } = await tempAsset();
  try {
    const client = fakeClient(async (params) => {
      const stream = params.fileStreamFactory();
      return await new Promise((resolve, reject) => {
        stream.on('data', () => {
          // simulate a transport failure partway through the read
          stream.destroy(new Error('socket hang up'));
        });
        stream.on('error', reject);
        stream.on('close', () => reject(new Error('socket hang up')));
      });
    });
    await assert.rejects(
      () => uploadOriginalToArweave({
        filePath,
        archiveName: 'asset.bin',
        sha256: 'deadbeef',
        collectionId: 'collection-1',
        turboClient: client,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Arweave streaming upload failed for asset\.bin/);
        assert.match(error.message, /socket hang up/);
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('threads an abort signal through to the Turbo client', async () => {
  const { dir, filePath } = await tempAsset();
  try {
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient(async (params) => {
      if (params.signal?.aborted) throw new Error('aborted');
      return { id: 'unused' };
    });
    await assert.rejects(
      () => uploadOriginalToArweave({
        filePath,
        archiveName: 'asset.bin',
        sha256: 'deadbeef',
        collectionId: 'collection-1',
        signal: controller.signal,
        turboClient: client,
      }),
      /aborted/,
    );
    assert.equal(client.calls[0]?.signal?.aborted, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
