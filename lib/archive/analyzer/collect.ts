import * as fs from 'fs';
import * as path from 'path';
import { inferMediaType } from '../media-type';
import { HOME_DIR, readCache } from './analyze';
import { API_VERSION, BATCH_URL, parseBatchResults, readBatches, saveBatchItem, writeBatches, type BatchResp, type BatchRow } from './batch';
import { BATCH_DISCOUNT, cacheKey, callCostUsd, round6 } from './cost';
import { organizeCopy } from './nas';
import { withClientId } from '../clients';
import { DEFAULT_MODEL, PROMPT_VERSION } from './schema';
import { resolveUnder, type ReadOnlyStore } from './store';
import type { AnalyzerControl, ResultItem } from './control';
import type { PrepareMedia } from './media';

const PUSH_BATCH = 10;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface CollectDeps {
  store: Pick<ReadOnlyStore, 'getSource'>;
  control: Pick<AnalyzerControl, 'pushResults'>;
  prepare: PrepareMedia;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Copy saved files into HITLOOP-ARCHIVE/content (default true). */
  organize?: boolean;
  hashFile?: (p: string) => Promise<string>;
  batchesPath?: string; cacheDir?: string; thumbDir?: string; ledgerPath?: string;
}

export type CollectAction =
  | 'already-cached'   // every sha is in the cache: marked processed, no network
  | 'collected'        // results fetched and saved: marked processed
  | 'partial'          // results fetched, some files could not be saved: left adoptable, safe to retry
  | 'still-processing' // batch has not ended at Anthropic yet
  | 'needs-run'        // old record without sourceId/paths: a normal Analyze run over its folders adopts it
  | 'no-api-key'
  | 'failed';
export interface CollectOutcome { id: string; action: CollectAction; saved?: number; pushed?: number; errors?: number; spentUsd?: number; error?: string }

/**
 * Collects every persisted batch that is not `processed`, without walking any folder.
 * Never submits anything. A batch whose shas are all cached is marked processed with no network call.
 * Otherwise the free status/results GETs are made and each missing result is saved exactly once
 * (ledger line only when the cache entry is written here), organized and pushed using the paths
 * stored on the record. Must run serially with ANALYZE jobs (both write batches.json).
 */
export async function collectPersistedBatches(deps: CollectDeps): Promise<{ batches: CollectOutcome[]; spentUsd: number; saved: number; pushed: number }> {
  const batchesPath = deps.batchesPath ?? path.join(HOME_DIR, 'batches.json');
  const cacheDir = deps.cacheDir ?? path.join(HOME_DIR, 'cache');
  const thumbDir = deps.thumbDir ?? path.join(HOME_DIR, 'thumbs');
  const ledgerPath = deps.ledgerPath ?? path.join(HOME_DIR, 'cost.jsonl');
  const f = deps.fetchImpl ?? fetch;
  const headers = { 'x-api-key': deps.apiKey as string, 'anthropic-version': API_VERSION };
  const get = async (url: string): Promise<Response> => {
    const res = await f(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Batch request failed: ${res.status} ${await res.text()}`);
    return res;
  };

  const store = readBatches(batchesPath);
  const save = () => writeBatches(batchesPath, store);
  const batches: CollectOutcome[] = [];
  let spentUsd = 0, savedTotal = 0, pushedTotal = 0;

  for (const [id, b] of Object.entries(store)) {
    if (b.state === 'processed' || !Array.isArray(b.shas)) continue;
    const model = b.model || DEFAULT_MODEL, promptVersion = b.promptVersion || PROMPT_VERSION;
    const isCached = (sha: string) => fs.existsSync(path.join(cacheDir, `${cacheKey(sha, promptVersion, model)}.json`));
    const missing = b.shas.filter(s => !isCached(s));
    if (!missing.length) { b.state = 'processed'; save(); batches.push({ id, action: 'already-cached' }); continue; }
    if (!b.sourceId || !b.paths) { batches.push({ id, action: 'needs-run' }); continue; }
    if (!deps.apiKey) { batches.push({ id, action: 'no-api-key' }); continue; }
    const source = deps.store.getSource(b.sourceId);
    if (!source) { batches.push({ id, action: 'failed', error: `Unknown source ${b.sourceId}` }); continue; }

    try {
      const info = (await (await get(`${BATCH_URL}/${id}`)).json()) as BatchResp;
      if (info.processing_status !== 'ended') { batches.push({ id, action: 'still-processing' }); continue; }
      if (b.state === 'submitted') { b.state = 'ended'; save(); }
      const rows = new Map<string, BatchRow>(parseBatchResults(await (await get(info.results_url || `${BATCH_URL}/${id}/results`)).text()).map(r => [r.sha, r]));

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.mkdirSync(thumbDir, { recursive: true });
      let saved = 0, errors = 0, spent = 0, pushed = 0, incomplete = false;
      let pushError: string | undefined;
      let out: ResultItem[] = [];
      const flush = async () => {
        if (!out.length || pushError) return;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await deps.control.pushResults(source.id, out); pushed += out.length; out = []; return; }
          catch (e) { lastErr = e; await sleep(500 * (attempt + 1)); }
        }
        // Analysis is cached; the next normal run pushes these as cache hits.
        pushError = `Pushing results failed: ${lastErr instanceof Error ? lastErr.message : lastErr}`;
      };

      for (const sha of missing) {
        const row = rows.get(sha);
        const rels = b.paths[sha] ?? [];
        // errored/canceled/expired/no result: not billed; leaving it uncached lets a normal run resubmit it.
        if (!row || !row.ok) { errors += Math.max(1, rels.length); continue; }
        const costUsd = round6(callCostUsd(model, row.usage) * BATCH_DISCOUNT);
        for (const rel of rels) {
          try {
            const abs = resolveUnder(source.rootPath, rel);
            const kind = inferMediaType(rel);
            if (!abs || (kind !== 'image' && kind !== 'video')) throw new Error(`Bad path on batch record: ${rel}`);
            const mtimeMs = fs.statSync(abs).mtimeMs;
            const { entry, itemCost } = await saveBatchItem({ sha, file: { abs, relativePath: rel, kind, mtimeMs }, input: row.input, usage: row.usage, costUsd, model, promptVersion, cacheDir, thumbDir, ledgerPath, readCache, prepare: deps.prepare });
            spent += itemCost;
            let organizedPath: string | undefined;
            if (deps.organize !== false) {
              try { organizedPath = await organizeCopy({ rootPath: source.rootPath, sourceId: source.id, sha256: sha, originalAbs: abs, originalRelativePath: rel, entry, thumbDir, hashFile: deps.hashFile }); }
              catch { /* organize is best effort, as in the batch save loop */ }
            }
            out.push(withClientId({ ...entry, relativePath: rel, costUsd: itemCost, ...(organizedPath ? { organizedPath } : {}) }));
            saved++;
            if (out.length >= PUSH_BATCH) await flush();
          } catch { errors++; }
        }
        if (!isCached(sha)) incomplete = true;
      }
      await flush();
      if (!incomplete) { b.state = 'processed'; save(); }
      spentUsd += spent; savedTotal += saved; pushedTotal += pushed;
      batches.push({ id, action: incomplete ? 'partial' : 'collected', saved, pushed, errors, spentUsd: round6(spent), ...(pushError ? { error: pushError } : {}) });
    } catch (e) {
      batches.push({ id, action: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { batches, spentUsd: round6(spentUsd), saved: savedTotal, pushed: pushedTotal };
}
