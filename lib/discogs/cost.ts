import * as fs from 'fs';
import * as path from 'path';
import type { LabelRead } from './types';

export type Usage = NonNullable<LabelRead['usage']>;

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per 1M tokens. */
export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Cost of a usage block for a model; null when the model is not in PRICING (never guess). */
export function usageCostUsd(model: string, usage: Usage | undefined): number | null {
  const p = PRICING[model];
  if (!p) return null;
  if (!usage) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

export function costOfRead(read: LabelRead): { usd: number | null; billed: boolean } {
  if (read.cached) return { usd: 0, billed: false };
  return { usd: usageCostUsd(read.model, read.usage), billed: true };
}

export interface CostEntry {
  kind: 'vision';
  file: string;
  model: string;
  usage?: Usage;
  cached: boolean;
}

export interface CostSummary {
  calls: number;
  billedCalls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  unknownModelCalls: number;
  byModel: Record<string, { calls: number; usd: number }>;
}

export class CostLedger {
  private entries: CostEntry[] = [];

  add(entry: CostEntry): void {
    this.entries.push(entry);
  }

  summary(): CostSummary {
    const s: CostSummary = {
      calls: 0,
      billedCalls: 0,
      cachedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      unknownModelCalls: 0,
      byModel: {},
    };
    for (const e of this.entries) {
      s.calls++;
      const m = (s.byModel[e.model] ??= { calls: 0, usd: 0 });
      m.calls++;
      if (e.cached) {
        s.cachedCalls++;
        continue;
      }
      s.billedCalls++;
      s.inputTokens += e.usage?.inputTokens ?? 0;
      s.outputTokens += e.usage?.outputTokens ?? 0;
      const usd = usageCostUsd(e.model, e.usage);
      if (usd === null) s.unknownModelCalls++;
      else {
        s.usd += usd;
        m.usd += usd;
      }
    }
    return s;
  }

  toJSON(): { entries: CostEntry[]; summary: CostSummary } {
    return { entries: this.entries, summary: this.summary() };
  }
}

export interface CostLogLine extends CostSummary {
  at: string;
  runId: string;
  folder: string;
}

export function appendCostLog(logPath: string, run: { runId: string; folder: string } & CostSummary): void {
  const { runId, folder, ...summary } = run;
  const line: CostLogLine = { at: new Date().toISOString(), runId, folder, ...summary };
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(line) + '\n');
}

export function readCostLog(logPath: string): CostLogLine[] {
  if (!fs.existsSync(logPath)) return [];
  const out: CostLogLine[] = [];
  for (const l of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as CostLogLine);
    } catch {
      // skip malformed line
    }
  }
  return out;
}
