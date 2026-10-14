import * as fs from 'fs';
import * as path from 'path';
import { BATCH_DISCOUNT, appendLedger, cacheKey, callCostUsd, round6 } from './cost';
import { sanitizeAnalysis, TOOL_NAME } from './schema';
import { organizeCopy } from './nas';
import { buildRequestParams } from './vision';
import type { PrepareMedia } from './media';
import type { DoneIndex } from './done-index';
import type { AnalyzeDeps, WalkedFile } from './analyze';
import type { Cmd, ResultItem } from './control';

export const BATCH_URL = 'https://api.anthropic.com/v1/messages/batches';
export const API_VERSION = '2023-06-01';
/** Anthropic limit is 100k requests / 256MB per batch; 300 keeps each body comfortably small. */
export const BATCH_CHUNK = 300;
export const DEFAULT_POLL_MS = 20_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type BatchState = 'submitted' | 'ended' | 'processed';
export interface PersistedBatch {
  createdAt: string; commandId: string; shas: string[]; state: BatchState; model?: string; promptVersion?: string;
  /** Set on records created since collect-only (P1): lets `collectPersistedBatches` save + push without a folder walk. */
  sourceId?: string; paths?: Record<string, string[]>;
}
export type BatchStore = Record<string, PersistedBatch>;

export function readBatches(file: string): BatchStore {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j as BatchStore : {}; } catch { return {}; }
}
export function writeBatches(file: string, store: BatchStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

export interface BatchCtx {
  source: { id: string; rootPath: string };
  files: WalkedFile[];
  cacheDir: string; thumbDir: string; ledgerPath: string;
  hashFile: (p: string) => Promise<string>;
  model: string; promptVersion: string; capUsd: number;
  batchesPath: string;
  /** Price of one batch request (already halved). */
  unitUsd: number;
  readCache: (dir: string, key: string) => any;
  knownSha: (f: WalkedFile) => string | null;
  /** Ledger relativePath -> sha256; used (only when the cache entry exists) to skip hashing over SMB. */
  ledgerShaByPath?: Map<string, string>;
  pushBatch: number;
  /** Done index: lets finished files skip hash, organize checks and push (unless verify). */
  doneIndex?: DoneIndex;
  verify?: boolean;
}

interface Counts { processing: number; succeeded: number; errored: number; canceled: number; expired: number }
export interface BatchResp { id?: string; processing_status?: string; request_counts?: Partial<Counts>; results_url?: string | null }

export interface Usage { inputTokens: number; outputTokens: number }
export type BatchRow = { sha: string; ok: true; input: unknown; usage: Usage } | { sha: string; ok: false; error: string };

/** Parses a batch results JSONL body. Rows without a custom_id or unparseable lines are skipped. */
export function parseBatchResults(text: string): BatchRow[] {
  const rows: BatchRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: { custom_id?: string; result?: { type?: string; message?: { content?: Array<{ type: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } }; error?: { error?: { message?: string }; message?: string } } };
    try { row = JSON.parse(line); } catch { continue; }
    const sha = row.custom_id;
    if (!sha) continue;
    const res0 = row.result;
    if (res0?.type !== 'succeeded') {
      const msg = res0?.error?.error?.message || res0?.error?.message;
      rows.push({ sha, ok: false, error: `batch ${res0?.type ?? 'no result'}${msg ? `: ${msg}` : ''}` });
      continue;
    }
    const tu = (res0.message?.content || []).find(c => c.type === 'tool_use' && c.name === TOOL_NAME);
    if (!tu) { rows.push({ sha, ok: false, error: 'Batch result had no tool_use block' }); continue; }
    rows.push({ sha, ok: true, input: tu.input, usage: { inputTokens: res0.message?.usage?.input_tokens ?? 0, outputTokens: res0.message?.usage?.output_tokens ?? 0 } });
  }
  return rows;
}

export interface SaveItemInput {
  sha: string; file: Pick<WalkedFile, 'abs' | 'relativePath' | 'kind' | 'mtimeMs'>; input: unknown; usage: Usage;
  /** Already-halved cost of this request; billed to the ledger only when the cache entry is written here. */
  costUsd: number;
  model: string; promptVersion: string; cacheDir: string; thumbDir: string; ledgerPath: string;
  readCache: (dir: string, key: string) => any;
  prepare: PrepareMedia;
}

/** Writes one succeeded batch result (ledger, thumb, cache) unless the cache already has it. itemCost is 0 when it did. */
export async function saveBatchItem(i: SaveItemInput): Promise<{ entry: any; itemCost: number }> {
  const key = cacheKey(i.sha, i.promptVersion, i.model);
  const cached = i.readCache(i.cacheDir, key);
  if (cached) return { entry: cached, itemCost: 0 };
  const prepared = await i.prepare(i.file.abs, i.file.kind); // thumb + dimensions; media is not held between submit and results
  appendLedger(i.ledgerPath, { at: new Date().toISOString(), sha256: i.sha, relativePath: i.file.relativePath, model: i.model, promptVersion: i.promptVersion, inputTokens: i.usage.inputTokens, outputTokens: i.usage.outputTokens, usd: i.costUsd, batch: true });
  const s = sanitizeAnalysis(i.input, { relativePath: i.file.relativePath });
  fs.writeFileSync(path.join(i.thumbDir, `${i.sha}.jpg`), prepared.thumb);
  const entry = {
    sha256: i.sha, mediaType: i.file.kind, width: prepared.width, height: prepared.height,
    ...(prepared.durationSec != null ? { durationSec: prepared.durationSec } : {}),
    capturedAt: prepared.capturedAt ?? new Date(i.file.mtimeMs).toISOString(),
    facets: s.facets, summary: s.summary, activity: s.activity, peopleCount: s.peopleCount, jev: s.jev, model: i.model, promptVersion: i.promptVersion,
  };
  fs.writeFileSync(path.join(i.cacheDir, `${key}.json`), JSON.stringify(entry));
  return { entry, itemCost: i.costUsd };
}

export async function runAnalyzeBatch(cmd: Cmd, deps: AnalyzeDeps, ctx: BatchCtx): Promise<Record<string, unknown>> {
  const f = deps.fetchImpl ?? fetch;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const headers = { 'x-api-key': deps.apiKey as string, 'anthropic-version': API_VERSION };
  const { source, files, cacheDir, thumbDir, ledgerPath, hashFile, model, promptVersion } = ctx;

  let spentUsd = 0, cachedCount = 0, pushed = 0, organizeErrors = 0, saved = 0, indexSkipped = 0;
  let cancelled = false;
  const errors: Array<{ relativePath: string; error: string }> = [];
  let out: ResultItem[] = [];
  let outFiles: WalkedFile[] = [];
  const batchIds: string[] = [];
  let counts = { processing: 0, succeeded: 0, errored: 0 };
  let phase: 'preparing' | 'submitted' | 'waiting' | 'saving' = 'preparing';
  let totalRequests = 0;

  const flush = async () => {
    if (!out.length) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await deps.control.pushResults(source.id, out); pushed += out.length;
        ctx.doneIndex?.stampPushed(source.id, outFiles.map(ff => ff.relativePath));
        out = []; outFiles = []; return;
      }
      catch (e) { lastErr = e; await sleep(500 * (attempt + 1)); }
    }
    throw new Error(`Pushing results failed (analysis is cached locally; re-run is free): ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  };
  const progress = () => deps.control.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: {
    done: counts.succeeded + counts.errored, total: totalRequests, spentUsd: 0, phase, batchIds: [...batchIds],
    batchCounts: { ...counts },
  } } }).catch(() => undefined);
  // Records the file as finished in the done index (pushedAt is stamped once its push is accepted).
  const emit = async (item: ResultItem & { _entry?: never }, file: WalkedFile) => {
    ctx.doneIndex?.setFile(source.id, file.relativePath, {
      sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, sha256: item.sha256, promptVersion, model,
      ...(item.organizedPath ? { organizedRelativePath: item.organizedPath } : {}),
    });
    out.push(item); outFiles.push(file);
    if (out.length >= ctx.pushBatch) await flush();
  };
  const organize = async (sha: string, file: WalkedFile, entry: any, ) => {
    if (deps.organize === false) return undefined;
    try { return await organizeCopy({ rootPath: source.rootPath, sourceId: source.id, sha256: sha, originalAbs: file.abs, originalRelativePath: file.relativePath, entry, thumbDir, hashFile }); }
    catch { organizeErrors++; return undefined; }
  };

  // 1. Walk like the sync path: cache hits are free and pushed; the rest are collected (not prepared yet).
  const pending = new Map<string, WalkedFile[]>(); // sha -> files
  const ledgerShaIfCached = (file: WalkedFile): string | null => {
    const s = ctx.ledgerShaByPath?.get(file.relativePath);
    return s && fs.existsSync(path.join(cacheDir, `${cacheKey(s, promptVersion, model)}.json`)) ? s : null;
  };
  let examined = 0, lastEmit = 0;
  const prepProgress = (current?: string) => deps.control.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: {
    phase: 'preparing', done: examined, total: files.length, spentUsd: 0, batchIds: [],
    batchCounts: { processing: 0, succeeded: 0, errored: 0 }, ...(current ? { current } : {}),
  } } }).catch(() => undefined);
  for (const file of files) {
    if (deps.isCancelled(cmd.id)) { cancelled = true; break; }
    if (examined === 0 || Date.now() - lastEmit >= 3000) { lastEmit = Date.now(); await prepProgress(file.relativePath); }
    examined++;
    try {
      // Index hit = same size+mtime as when it was finished for this prompt/model; skips all per-file NAS work.
      const done = ctx.verify ? null : ctx.doneIndex?.fresh(source.id, file) ?? null;
      const finished = done && done.promptVersion === promptVersion && done.model === model ? done : null;
      if (finished && finished.pushedAt && (deps.organize === false || finished.organizedRelativePath)
        && fs.existsSync(path.join(cacheDir, `${cacheKey(finished.sha256, promptVersion, model)}.json`))) {
        cachedCount++; indexSkipped++;
        continue;
      }
      // The ledger maps path -> sha with no size/mtime; never trust it for a path the index saw change.
      const changed = ctx.doneIndex?.stale(source.id, file) ?? false;
      const sha = ctx.knownSha(file) ?? done?.sha256 ?? (changed ? null : ledgerShaIfCached(file)) ?? await hashFile(file.abs);
      const entry = ctx.readCache(cacheDir, cacheKey(sha, promptVersion, model));
      if (entry) {
        cachedCount++;
        // Already organized per the index: skip organizeCopy (its SMB stat/_meta read/exists checks).
        const organizedPath = finished?.sha256 === sha && finished.organizedRelativePath ? finished.organizedRelativePath : await organize(sha, file, entry);
        await emit({ ...entry, relativePath: file.relativePath, costUsd: 0, ...(organizedPath ? { organizedPath } : {}) }, file);
      } else {
        const l = pending.get(sha); if (l) l.push(file); else pending.set(sha, [file]);
      }
    } catch (e) { errors.push({ relativePath: file.relativePath, error: e instanceof Error ? e.message : String(e) }); }
  }
  await flush();
  if (files.length) await prepProgress();

  const result = (extra: Record<string, unknown> = {}) => ({
    done: cachedCount + saved + errors.length, total: files.length, spentUsd: round6(spentUsd), cached: cachedCount, pushed,
    errors: errors.slice(0, 50), errorCount: errors.length, organizeErrors, ...(indexSkipped ? { indexSkipped } : {}), ...extra,
    ...(cancelled ? { cancelled: true } : {}), batch: true, batchIds: [...batchIds],
  });
  if (cancelled || !pending.size) return result();

  // 2. Adopt persisted in-flight batches covering pending files (restart / re-click must never double-bill).
  const store = readBatches(ctx.batchesPath);
  const save = () => writeBatches(ctx.batchesPath, store);
  const adopted = new Set<string>();
  const covered = new Set<string>();
  for (const [id, b] of Object.entries(store)) {
    if (b.state === 'processed' || !Array.isArray(b.shas)) continue;
    if ((b.model && b.model !== model) || (b.promptVersion && b.promptVersion !== promptVersion)) continue;
    const hit = b.shas.filter(s => pending.has(s));
    if (!hit.length) continue;
    adopted.add(id); hit.forEach(s => covered.add(s));
  }
  batchIds.push(...Array.from(adopted));

  // 3. Cap up front: a batch cannot be stopped mid-way.
  const fresh = Array.from(pending.keys()).filter(s => !covered.has(s));
  const room = ctx.unitUsd > 0 ? Math.floor((ctx.capUsd + 1e-9) / ctx.unitUsd) : fresh.length;
  const submit = fresh.slice(0, Math.max(0, room));
  const leftOut = fresh.slice(submit.length);
  let cappedAt = 0;
  for (const s of leftOut) cappedAt += pending.get(s)!.length;

  // 4. Submit in chunks; each chunk's media is built, sent, then freed.
  const post = async (url: string, body?: unknown): Promise<BatchResp> => {
    const res = await f(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`Batch request failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as BatchResp;
  };
  const get = async (url: string): Promise<Response> => {
    const res = await f(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Batch request failed: ${res.status} ${await res.text()}`);
    return res;
  };
  for (let i = 0; i < submit.length && !cancelled; i += BATCH_CHUNK) {
    if (deps.isCancelled(cmd.id)) { cancelled = true; break; }
    let requests: Array<{ custom_id: string; params: unknown }> = [];
    for (const sha of submit.slice(i, i + BATCH_CHUNK)) {
      const file = pending.get(sha)![0];
      try {
        const prepared = await deps.prepare(file.abs, file.kind);
        requests.push({ custom_id: sha, params: buildRequestParams(model, prepared.jpeg, file.relativePath, file.kind) });
      } catch (e) {
        for (const ff of pending.get(sha)!) errors.push({ relativePath: ff.relativePath, error: e instanceof Error ? e.message : String(e) });
        pending.delete(sha);
      }
    }
    if (!requests.length) continue;
    const shas = requests.map(r => r.custom_id);
    const resp = await post(BATCH_URL, { requests });
    requests = []; // free the chunk
    if (!resp.id) throw new Error('Batch create response had no id');
    store[resp.id] = {
      createdAt: new Date().toISOString(), commandId: cmd.id, shas, state: 'submitted', model, promptVersion,
      sourceId: source.id, paths: Object.fromEntries(shas.map(s => [s, pending.get(s)!.map(ff => ff.relativePath)])),
    };
    save();
    batchIds.push(resp.id);
    phase = 'submitted';
    totalRequests += shas.length;
    await progress();
  }
  totalRequests = batchIds.reduce((n, id) => n + (store[id]?.shas.length ?? 0), 0);

  // 5. Poll until every tracked batch has ended.
  const open = new Set(batchIds.filter(id => store[id].state === 'submitted'));
  const info = new Map<string, BatchResp>();
  let cancelSent = false, failures = 0;
  const fetchInfo = async (id: string) => {
    const r = (await (await get(`${BATCH_URL}/${id}`)).json()) as BatchResp;
    info.set(id, r);
    return r;
  };
  for (const id of batchIds) if (!open.has(id)) await fetchInfo(id);
  phase = 'waiting';
  const perBatch = new Map<string, Counts>();
  const recount = () => {
    counts = { processing: 0, succeeded: 0, errored: 0 };
    for (const c of Array.from(perBatch.values())) { counts.processing += c.processing; counts.succeeded += c.succeeded; counts.errored += c.errored; }
  };
  while (open.size) {
    if (!cancelSent && deps.isCancelled(cmd.id)) {
      cancelled = true; cancelSent = true;
      for (const id of Array.from(open)) await post(`${BATCH_URL}/${id}/cancel`).catch(() => undefined);
    }
    for (const id of Array.from(open)) {
      try {
        const r = await fetchInfo(id); failures = 0;
        const c = r.request_counts || {};
        perBatch.set(id, { processing: c.processing ?? 0, succeeded: c.succeeded ?? 0, errored: c.errored ?? 0, canceled: c.canceled ?? 0, expired: c.expired ?? 0 });
        if (r.processing_status === 'ended') { open.delete(id); store[id].state = 'ended'; save(); }
      } catch (e) { if (++failures >= 5) throw e; }
    }
    recount();
    await progress();
    if (open.size) await sleep(pollMs);
  }

  // 6. Collect results.
  phase = 'saving';
  await progress();
  // The save loop does the slow part (thumbnails, NAS copies, pushes), so it reports its own progress:
  // done = files saved so far, total = files to save. Throttled to one update every 3s.
  const savingTotal = Array.from(pending.values()).reduce((n, l) => n + l.length, 0);
  let lastSaveEmit = 0;
  const saveProgress = async (current: string) => {
    if (Date.now() - lastSaveEmit < 3000) return;
    lastSaveEmit = Date.now();
    await deps.control.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: {
      done: saved + errors.length, total: savingTotal, spentUsd: round6(spentUsd), phase: 'saving', batchIds: [...batchIds],
      batchCounts: { ...counts }, current,
    } } }).catch(() => undefined);
  };
  for (const id of batchIds) {
    const b = store[id];
    const r = info.get(id) ?? await fetchInfo(id);
    const res = await get(r.results_url || `${BATCH_URL}/${id}/results`);
    const seen = new Set<string>();
    for (const row of parseBatchResults(await res.text())) {
      const sha = row.sha;
      const list = pending.get(sha);
      if (!list) continue;
      seen.add(sha);
      if (!row.ok) { for (const ff of list) errors.push({ relativePath: ff.relativePath, error: row.error }); continue; }
      const costUsd = round6(callCostUsd(model, row.usage) * BATCH_DISCOUNT);
      spentUsd += costUsd;
      for (const file of list) {
        try {
          const { entry, itemCost } = await saveBatchItem({ sha, file, input: row.input, usage: row.usage, costUsd, model, promptVersion, cacheDir, thumbDir, ledgerPath, readCache: ctx.readCache, prepare: deps.prepare });
          const organizedPath = await organize(sha, file, entry);
          await emit({ ...entry, relativePath: file.relativePath, costUsd: itemCost, ...(organizedPath ? { organizedPath } : {}) }, file);
          saved++;
          await saveProgress(file.relativePath);
        } catch (e) { errors.push({ relativePath: file.relativePath, error: e instanceof Error ? e.message : String(e) }); }
      }
    }
    for (const sha of b.shas) {
      const list = pending.get(sha);
      if (list && !seen.has(sha)) for (const ff of list) errors.push({ relativePath: ff.relativePath, error: 'batch returned no result for this file' });
    }
    await flush();
    // Only retire a batch whose every request belonged to this selection; otherwise leave it adoptable.
    if (b.shas.every(s => pending.has(s))) { b.state = 'processed'; save(); }
  }
  return result(cappedAt ? { cappedAt, leftOut: cappedAt } : {});
}
