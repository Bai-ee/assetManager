import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { costOfRead, CostLedger, appendCostLog, readCostLog } from './cost';
import type { LabelRead } from './types';

const mk = (o: Partial<LabelRead> = {}): LabelRead => ({
  file: 'a.jpg', status: 'readable', artist: null, title: null, label: null, catno: null, year: null,
  tracks: [], side: null, notes: null, model: 'claude-sonnet-5-5', cached: false,
  usage: { inputTokens: 3030, outputTokens: 500 }, ...o,
});

test('pricing math', () => {
  const r = costOfRead(mk());
  assert.equal(r.billed, true);
  assert.ok(Math.abs((r.usd as number) - 0.01106) < 1e-9);
});

test('cache tokens priced', () => {
  const r = costOfRead(mk({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 } }));
  assert.ok(Math.abs((r.usd as number) - 2.7) < 1e-9);
});

test('cached read costs zero', () => {
  assert.deepEqual(costOfRead(mk({ cached: true })), { usd: 0, billed: false });
});

test('unknown model flagged', () => {
  assert.deepEqual(costOfRead(mk({ model: 'mystery-1' })), { usd: null, billed: true });
});

test('ledger aggregation', () => {
  const l = new CostLedger();
  const usage = { inputTokens: 3030, outputTokens: 500 };
  l.add({ kind: 'vision', file: 'a', model: 'claude-sonnet-5-5', usage, cached: false });
  l.add({ kind: 'vision', file: 'b', model: 'claude-sonnet-5-5', usage, cached: false });
  l.add({ kind: 'vision', file: 'c', model: 'claude-sonnet-5-5', usage, cached: true });
  l.add({ kind: 'vision', file: 'd', model: 'mystery-1', usage, cached: false });
  const s = l.summary();
  assert.equal(s.calls, 4);
  assert.equal(s.billedCalls, 3);
  assert.equal(s.cachedCalls, 1);
  assert.equal(s.unknownModelCalls, 1);
  assert.equal(s.inputTokens, 9090);
  assert.equal(s.outputTokens, 1500);
  assert.ok(Math.abs(s.usd - 0.02212) < 1e-9);
  assert.equal(s.byModel['claude-sonnet-5-5'].calls, 3);
  assert.equal(s.byModel['mystery-1'].usd, 0);
  assert.equal(l.toJSON().summary.calls, 4);
});

test('cost log round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
  const p = path.join(dir, 'sub', 'costs.jsonl');
  assert.deepEqual(readCostLog(p), []);
  const l = new CostLedger();
  l.add({ kind: 'vision', file: 'a', model: 'claude-sonnet-5-5', usage: { inputTokens: 100, outputTokens: 10 }, cached: false });
  appendCostLog(p, { runId: 'r1', folder: '/x', ...l.summary() });
  appendCostLog(p, { runId: 'r2', folder: '/y', ...l.summary() });
  const lines = readCostLog(p);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].runId, 'r1');
  assert.equal(lines[1].folder, '/y');
  assert.equal(lines[0].billedCalls, 1);
  assert.ok(typeof lines[0].at === 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});
