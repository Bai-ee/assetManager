import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** USD per 1M tokens. One place to change rates. Unknown models throw: never guess spend. */
export const RATES: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
};

/** Conservative per-call token assumptions for estimates (one ~1024px image + tool schema + prompt). */
export const EST_INPUT_TOKENS = 2800;
export const EST_OUTPUT_TOKENS = 900;

/** Anthropic Message Batches bill at half price. */
export const BATCH_DISCOUNT = 0.5;

export interface Usage { inputTokens: number; outputTokens: number }

export function ratesFor(model: string): { inputPerM: number; outputPerM: number } {
  const r = RATES[model] ?? RATES[model.replace(/-\d{8}$/, '')];
  if (!r) throw new Error(`No pricing for model "${model}"; add it to RATES in analyzer/cost.ts`);
  return r;
}

export function callCostUsd(model: string, u: Usage): number {
  const r = ratesFor(model);
  return (u.inputTokens * r.inputPerM + u.outputTokens * r.outputPerM) / 1_000_000;
}

export function estimateCallUsd(model: string): number {
  return callCostUsd(model, { inputTokens: EST_INPUT_TOKENS, outputTokens: EST_OUTPUT_TOKENS });
}

export function estimateRun(model: string, counts: { images: number; videos: number; cached: number }) {
  const files = counts.images + counts.videos;
  const billable = Math.max(0, files - counts.cached);
  return { files, images: counts.images, videos: counts.videos, cached: counts.cached, estUsd: round6(billable * estimateCallUsd(model)) };
}

/** Would one more (uncached) call keep us within the cap? */
export function withinCap(spentUsd: number, model: string, capUsd: number): boolean {
  return spentUsd + estimateCallUsd(model) <= capUsd + 1e-9;
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Cache key: same bytes + same prompt version + same model => same analysis. */
export function cacheKey(sha256: string, promptVersion: string, model: string): string {
  const tag = createHash('sha256').update(`${promptVersion}\0${model}`).digest('hex').slice(0, 16);
  return `${sha256}.${tag}`;
}

export interface LedgerLine { at: string; sha256: string; relativePath: string; model: string; promptVersion: string; inputTokens: number; outputTokens: number; usd: number; batch?: boolean }

export function appendLedger(ledgerPath: string, line: LedgerLine): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
}
