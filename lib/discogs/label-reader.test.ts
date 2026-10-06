import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readLabel } from './label-reader';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-reader-'));
  const jpeg = path.join(dir, 'a.jpg');
  fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]));
  return { dir, jpeg };
}

function mockFetch(input: Record<string, unknown>) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'record_label', input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const full = {
  status: 'readable', artist: 'Lith De Lanka', title: 'Fairy Tale', label: 'Deep Touch',
  catno: 'DT-117', year: null, tracks: ['Fairy Tale'], side: 'A', notes: null,
};

test('parses tool_use output', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { jpeg } = setup();
  const f = mockFetch(full);
  const r = await readLabel(jpeg, 'x.HEIC', { fetchImpl: f.impl, model: 'm' });
  assert.equal(r.catno, 'DT-117');
  assert.equal(r.file, 'x.HEIC');
  assert.equal(r.model, 'm');
  assert.equal(r.cached, false);
  assert.deepEqual(r.tracks, ['Fairy Tale']);
});

test('cache hit skips fetch', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { dir, jpeg } = setup();
  const f = mockFetch(full);
  const opts = { fetchImpl: f.impl, model: 'm', cacheDir: path.join(dir, 'cache') };
  await readLabel(jpeg, 'x.HEIC', opts);
  const second = await readLabel(jpeg, 'x.HEIC', opts);
  assert.equal(f.calls(), 1);
  assert.equal(second.cached, true);
  assert.equal(second.catno, 'DT-117');
});

test('status passthrough and null normalisation', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { jpeg } = setup();
  const f = mockFetch({ ...full, status: 'partial', artist: null, title: '', catno: null, tracks: [] });
  const r = await readLabel(jpeg, 'b.HEIC', { fetchImpl: f.impl });
  assert.equal(r.status, 'partial');
  assert.equal(r.title, null);
  assert.equal(r.catno, null);
});

test('missing key throws', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { jpeg } = setup();
  const f = mockFetch(full);
  await assert.rejects(() => readLabel(jpeg, 'x', { fetchImpl: f.impl }), /ANTHROPIC_API_KEY/);
  assert.equal(f.calls(), 0);
});
