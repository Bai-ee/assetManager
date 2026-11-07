/**
 * Push thumbnails + LifeItems to HITLOOP (features/life-timeline/CONTRACT.md):
 * POST life/upload-urls (≤200 urls) → PUT thumbs → POST life/results (≤100 items).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { LifeItem, LibraryKind, Sidecar } from './types';

export const MAX_ITEMS_PER_RESULTS = 100; // 2 urls per item → 200 urls per upload-urls call
const REQUEST_TIMEOUT_MS = 60_000;
const TRIES = 3;

export function toLifeItem(sidecar: Sidecar, thumbs: { s: string; m: string } | null): LifeItem {
  const motion = sidecar.children.motion;
  const edited = sidecar.children.edited;
  return {
    id: sidecar.id,
    sha256: sidecar.sha256,
    kind: sidecar.kind,
    ext: sidecar.ext,
    width: sidecar.width,
    height: sidecar.height,
    durationSec: sidecar.durationSec,
    takenLocal: sidecar.takenLocal,
    tz: sidecar.tz,
    tsUtc: sidecar.tsUtc,
    tsSource: sidecar.tsSource,
    tsKind: sidecar.tsKind,
    gps: sidecar.gps,
    albums: sidecar.albums,
    favorite: sidecar.favorite,
    hidden: sidecar.hidden,
    title: sidecar.title,
    description: sidecar.description,
    keywords: sidecar.keywords,
    camera: sidecar.camera,
    motion: motion ? { sha256: motion.sha256, durationSec: motion.durationSec } : null,
    edited: edited ? { sha256: edited.sha256 } : null,
    thumbs: thumbs ? { s: thumbs.s, m: thumbs.m } : null,
    canonicalPath: sidecar.canonicalPath,
    locations: sidecar.locations.map(l => ({ sourceId: l.sourceId, relativePath: l.relativePath, originalFileName: l.originalFileName })),
  };
}

export function pushHashOf(item: LifeItem): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

export interface UploadUrlRequest { sha256: string; variant: 's' | 'm'; contentType: 'image/jpeg'; sizeBytes: number }
export interface UploadUrlGrant { sha256: string; variant: 's' | 'm'; storagePath: string; uploadUrl: string; headers: Record<string, string> }
export interface PushSource { id: string; kind: LibraryKind; label: string; libraryPath: string }
export interface ResultsResponse { ok?: boolean; upserted?: number; skipped?: { id: string; reason: string }[]; months?: string[] }

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = ms => new Promise(r => setTimeout(r, ms));

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Retry 5xx / network errors (not 4xx), 3 tries, 0.5s then 1s backoff. */
export async function withRetry<T>(fn: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  let last: unknown;
  for (let i = 0; i < TRIES; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e instanceof HttpError && e.status < 500) throw e;
      if (i < TRIES - 1) await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

export class LifeClient {
  private base: string;
  constructor(baseUrl: string, private token: string, private fetchImpl: typeof fetch = fetch, private sleep: Sleep = realSleep) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return withRetry(async () => {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new HttpError(res.status, `HITLOOP POST ${path} failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 500)}`);
      return (await res.json()) as T;
    }, this.sleep);
  }

  async uploadUrls(items: UploadUrlRequest[]): Promise<UploadUrlGrant[]> {
    const j = await this.post<{ urls?: UploadUrlGrant[] }>('/api/archive/worker/life/upload-urls', { items });
    return j.urls ?? [];
  }

  results(body: { source: PushSource; items: LifeItem[] }): Promise<ResultsResponse> {
    return this.post<ResultsResponse>('/api/archive/worker/life/results', body);
  }
}

interface AssetRow { sha256: string; id: string; sidecarJson: string; thumbS: string | null; thumbM: string | null; pushHash: string | null }

export interface PushRunOpts {
  manifest: {
    listAssets(o: { needsPush?: boolean; limit?: number }): unknown;
    markPushed(sha256: string, pushHash: string): unknown;
  };
  client: Pick<LifeClient, 'uploadUrls' | 'results'>;
  source: PushSource;
  limit?: number;
  force?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (p: { done: number; total: number }) => void;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}
export interface PushRunResult {
  pushed: number;
  skipped: { id: string; reason: string }[];
  uploaded: number;
  errors: { id: string; error: string }[];
  cancelled?: boolean;
}

export async function runPush(o: PushRunOpts): Promise<PushRunResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const rows = ((await o.manifest.listAssets({ needsPush: !o.force, limit: o.limit })) as AssetRow[]).filter(r => r.thumbS && r.thumbM);
  const res: PushRunResult = { pushed: 0, skipped: [], uploaded: 0, errors: [] };

  const prepared: { row: AssetRow; item: LifeItem; hash: string }[] = [];
  for (const r of rows) {
    try {
      const sc = JSON.parse(r.sidecarJson) as Sidecar;
      const item = toLifeItem(sc, { s: `life-thumbs/${sc.id}_s.jpg`, m: `life-thumbs/${sc.id}_m.jpg` });
      const hash = pushHashOf(item);
      if (!o.force && hash === r.pushHash) continue;
      prepared.push({ row: r, item, hash });
    } catch (e) {
      res.errors.push({ id: r.id, error: `bad sidecar: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  let seen = 0;
  for (let i = 0; i < prepared.length; i += MAX_ITEMS_PER_RESULTS) {
    if (o.isCancelled?.()) { res.cancelled = true; break; }
    const chunk = prepared.slice(i, i + MAX_ITEMS_PER_RESULTS);
    try {
      const reqs: UploadUrlRequest[] = [];
      for (const c of chunk) {
        reqs.push({ sha256: c.item.sha256, variant: 's', contentType: 'image/jpeg', sizeBytes: statSync(c.row.thumbS as string).size });
        reqs.push({ sha256: c.item.sha256, variant: 'm', contentType: 'image/jpeg', sizeBytes: statSync(c.row.thumbM as string).size });
      }
      const grants = await o.client.uploadUrls(reqs);
      for (const g of grants) {
        const c = chunk.find(x => x.item.sha256 === g.sha256);
        if (!c) continue;
        const file = readFileSync((g.variant === 's' ? c.row.thumbS : c.row.thumbM) as string);
        await withRetry(async () => {
          const r = await fetchImpl(g.uploadUrl, { method: 'PUT', headers: { ...g.headers, 'content-length': String(file.length) }, body: file, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          if (!r.ok) throw new HttpError(r.status, `thumb PUT failed: ${r.status}`);
        }, sleep);
        res.uploaded++;
      }
      const out = await o.client.results({ source: o.source, items: chunk.map(c => c.item) });
      const skippedIds = new Set((out.skipped ?? []).map(s => s.id));
      for (const s of out.skipped ?? []) res.skipped.push({ id: s.id, reason: s.reason });
      for (const c of chunk) {
        if (skippedIds.has(c.item.id)) continue;
        await o.manifest.markPushed(c.item.sha256, c.hash);
        res.pushed++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const c of chunk) res.errors.push({ id: c.item.id, error: msg });
    }
    seen += chunk.length;
    o.onProgress?.({ done: seen, total: prepared.length });
  }
  return res;
}
