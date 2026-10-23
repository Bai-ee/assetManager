/**
 * Discogs publish runtime: everything publish-cli.ts does, as functions the analyzer daemon can call too
 * (DISCOGS_PROCESS). No process.argv, no process.exit; output goes through `log`.
 *
 * Per record: source video -> local copy -> analyze -> pickClip -> vision framing -> clip-9x16.mp4 + clip-1x1.mp4;
 * label photo -> label-9x16.jpg + label-1x1.jpg; facts from Discogs; upload all four to HITLOOP; create the draft;
 * record the result in published.json. State lives under `home` (default ~/.discogs-ingest).
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DiscogsClient } from './client.ts';
import { ensureLocalSource, type ScannedMedia } from './media.ts';
import { analyzeVideo, pickClip, renderClip, gradeImage, labelToJpeg, frameVideo, frameLabel, probeDuration, DEFAULT_LOOK, ASPECT_LIST, type Aspect, type ClipMode, type FramingDecision } from './video.ts';
import { CostLedger, appendCostLog, readCostLog } from './cost.ts';
import { buildDraftBody, releaseFacts, unreportedCost, type EligibleRecord, type VariantPaths } from './publish.ts';
import type { GroupPlan } from './types.ts';

export const CLIP_SECONDS = 60;
const MAX_CLIP_BYTES = 512 * 1024 * 1024;
const MAX_CLIP_SECONDS = 140;
const LOOK = DEFAULT_LOOK;

/** `groupId` (label fingerprint group) is what says "this record is done" when the matcher later picks another pressing id. */
export interface PublishedEntry { releaseId: number; postId: string; packageId: string; at: string; clip: { start: number; end: number; look: string }; groupId?: string }

export interface PublishPaths { home: string; runs: string; work: string; srcCache: string; cache: string; published: string; usageReported: string; costLog: string }

export function publishPaths(home = join(homedir(), '.discogs-ingest')): PublishPaths {
  return {
    home, runs: join(home, 'runs'), work: join(home, 'work'), srcCache: join(home, 'src'), cache: join(home, 'cache'),
    published: join(home, 'published.json'), usageReported: join(home, 'usage-reported.json'), costLog: join(home, 'costs.jsonl'),
  };
}

export const readJson = <T>(p: string, fallback: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; } };
export const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MB';

export function loadPlansNewestFirst(runsDir: string): GroupPlan[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter(f => f.endsWith('-plan.json')).sort().reverse()
    .flatMap(f => readJson<GroupPlan[]>(join(runsDir, f), []));
}

export const readPublished = (p: PublishPaths): PublishedEntry[] => readJson<PublishedEntry[]>(p.published, []);

/** Upsert one entry (one record per release) and persist. */
export function recordPublished(p: PublishPaths, published: PublishedEntry[], entry: PublishedEntry): void {
  const idx = published.findIndex(x => x.releaseId === entry.releaseId);
  if (idx >= 0) published[idx] = entry; else published.push(entry);
  writeFileSync(p.published, JSON.stringify(published, null, 2));
}

export interface Prepared {
  facts: ReturnType<typeof releaseFacts>;
  clipPaths: Record<Aspect, string>;
  imagePaths: Record<Aspect, string>;
  clip: { start: number; end: number; look: string };
  videoName: string; imageName: string;
  clipBytes: Record<Aspect, number>; clipSeconds: number; imageBytes: Record<Aspect, number>; reason: string;
  videoFraming: FramingDecision; imageFraming: FramingDecision;
  timings: Record<string, number>;
}

export const framingLine = (f: FramingDecision, a: Aspect) =>
  `${a}: ${f.plans[a].mode} (${f.plans[a].note}) | subject=${f.subject.kind}`;

export interface LocalSource { video: ScannedMedia; local: string; fingerprint: string; copySeconds: number }

export type Log = (line: string) => void;

export interface SourceOpts {
  paths: PublishPaths;
  log?: Log;
  /** Streamed copy progress (CLI draws it on one line); omitted = silent. */
  onCopyProgress?: (copied: number, total: number, mbPerSec: number) => void;
}

/** Longest video of the record (duration from the scan index), or `override` -> local copy in the source cache. Never re-copies. */
export async function fetchSource(rec: EligibleRecord, override: ScannedMedia | undefined, opts: SourceOpts): Promise<LocalSource> {
  const log = opts.log ?? (() => {});
  const vids = rec.group.videos as ScannedMedia[];
  const dur = (v: ScannedMedia) => v.durationS ?? 0;
  const video = override ?? [...vids].sort((a, b) => dur(b) - dur(a) || b.size - a.size)[0];
  if (override) log(`  [release ${rec.releaseId}] source video overridden: ${override.name}`);
  const legacyDir = join(opts.paths.work, String(rec.releaseId));
  const legacyPaths = existsSync(legacyDir) ? readdirSync(legacyDir).filter(n => n.startsWith('source.')).map(n => join(legacyDir, n)) : [];
  const r = await ensureLocalSource(video, opts.paths.srcCache, { legacyPaths, onProgress: opts.onCopyProgress });
  if (r.via === 'copy') log(`\n  [release ${rec.releaseId}] copied ${mb(r.bytes)} from the NAS in ${r.seconds.toFixed(1)}s (${r.mbPerSec.toFixed(1)} MB/s) -> ${r.path}`);
  else log(`  [release ${rec.releaseId}] source ${r.via === 'link' ? 'reused from the older work copy' : 'already in the local cache'}: ${r.path}`);
  return { video, local: r.path, fingerprint: video.fingerprint, copySeconds: r.via === 'copy' ? r.seconds : 0 };
}

export interface PrepareOpts { paths: PublishPaths; client: DiscogsClient; ledger: CostLedger; clipMode: ClipMode; log?: Log }

export async function prepare(rec: EligibleRecord, src: LocalSource, opts: PrepareOpts): Promise<Prepared> {
  const { paths, client, ledger, clipMode } = opts;
  const log = opts.log ?? (() => {});
  const timings: Record<string, number> = { copy: src.copySeconds };
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try { return await fn(); } finally { timings[name] = (Date.now() - t0) / 1000; }
  };
  const dir = join(paths.work, String(rec.releaseId));
  mkdirSync(dir, { recursive: true });
  const { local } = src;
  const clipPaths = { '9x16': join(dir, 'clip-9x16.mp4'), '1x1': join(dir, 'clip-1x1.mp4') };
  const imagePaths = { '9x16': join(dir, 'label-9x16.jpg'), '1x1': join(dir, 'label-1x1.jpg') };

  // Discogs facts + label photo work are independent of the video render: run them alongside it.
  const factsP = client.getRelease(rec.releaseId).then(releaseFacts);
  const labelImg = rec.group.images[0];
  const labelP = (async () => {
    const labelJpg = join(dir, 'label-src.jpg');
    await timed('label-jpeg', () => labelToJpeg(labelImg.path, labelJpg));
    const imageFraming = await timed('label-framing', () => frameLabel(labelJpg, { cacheDir: paths.cache, ledger, name: `${rec.releaseId}/label`, workDir: dir }));
    await timed('label-grade', () => Promise.all(ASPECT_LIST.map(a => gradeImage(labelJpg, imagePaths[a], LOOK, imageFraming.plans[a], a))));
    return imageFraming;
  })();

  const analysis = await timed('analysis', () => analyzeVideo(local, { cacheFile: join(paths.cache, `analysis-${src.fingerprint}.json`) }));
  const clip = pickClip(analysis, { length: CLIP_SECONDS, mode: clipMode });
  const videoFraming = await timed('framing', () => frameVideo(local, clip, { cacheDir: paths.cache, ledger, name: `${rec.releaseId}/video`, workDir: join(dir, 'frames'), fingerprint: src.fingerprint }));
  const rendered = await timed('render', () => renderClip(local, clipPaths, clip, LOOK, videoFraming.plans));
  log(`  render: ${rendered.encoder}, ${rendered.chunks} parallel chunk(s)`);
  const [imageFraming, facts] = await Promise.all([labelP, factsP]);

  const clipBytes = { '9x16': statSync(clipPaths['9x16']).size, '1x1': statSync(clipPaths['1x1']).size };
  const clipSeconds = await probeDuration(clipPaths['1x1']);
  for (const a of ASPECT_LIST) {
    if (clipBytes[a] >= MAX_CLIP_BYTES) throw new Error(`clip-${a}.mp4 is ${mb(clipBytes[a])} (limit 512 MB)`);
  }
  if (clipSeconds > MAX_CLIP_SECONDS) throw new Error(`clip is ${clipSeconds.toFixed(1)} s (limit ${MAX_CLIP_SECONDS} s)`);

  return { facts, clipPaths, imagePaths, clip: { start: clip.start, end: clip.end, look: LOOK },
    videoName: src.video.name, imageName: labelImg.name, clipBytes, clipSeconds,
    imageBytes: { '9x16': statSync(imagePaths['9x16']).size, '1x1': statSync(imagePaths['1x1']).size },
    reason: clip.reason, videoFraming, imageFraming, timings };
}

/** One line per fact the operator wants to see about a prepared record (what the CLI prints). */
export function describePrepared(p: Prepared, releaseId: number, totalSeconds: number): string[] {
  return [
    `\n[release ${releaseId}] ${p.facts.artist} - ${p.facts.title} | ${p.facts.label} ${p.facts.catno}`,
    `  source video: ${p.videoName}`,
    `  clip: ${p.clip.start}s-${p.clip.end}s look=${p.clip.look}\n    ${p.reason}`,
    ...ASPECT_LIST.map(a => `  video framing ${framingLine(p.videoFraming, a)}`),
    ...ASPECT_LIST.map(a => `  label framing ${framingLine(p.imageFraming, a)}`),
    `  clip-9x16.mp4 ${mb(p.clipBytes['9x16'])} | clip-1x1.mp4 ${mb(p.clipBytes['1x1'])} | ${p.clipSeconds.toFixed(1)}s`
      + ` | label-9x16.jpg ${mb(p.imageBytes['9x16'])} | label-1x1.jpg ${mb(p.imageBytes['1x1'])} (${p.imageName})`,
    `  timings (s): ${Object.entries(p.timings).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' | ')} | total ${totalSeconds.toFixed(1)} (copy overlaps the previous record's render when prefetched)`,
  ];
}

// ---- HITLOOP ----
export interface Hitloop { post: <T>(path: string, body: unknown) => Promise<T> }

export function hitloop(env: Record<string, string | undefined> = process.env): Hitloop {
  const base = env.HITLOOP_ARCHIVE_CONTROL_URL?.replace(/\/+$/, '');
  const token = env.HITLOOP_ARCHIVE_WORKER_TOKEN;
  if (!base || !token) throw new Error('HITLOOP_ARCHIVE_CONTROL_URL and HITLOOP_ARCHIVE_WORKER_TOKEN must be set');
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${base}/api/archive/worker/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HITLOOP ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  return { post };
}

export async function uploadFile(h: Hitloop, releaseId: number, kind: 'video' | 'image', variant: Aspect, file: string): Promise<string> {
  const contentType = kind === 'video' ? 'video/mp4' : 'image/jpeg';
  const u = await h.post<{ uploadUrl: string; storagePath: string; headers?: Record<string, string> }>(
    'discogs/upload-url', { releaseId, kind, variant, contentType });
  const size = statSync(file).size;
  const res = await fetch(u.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(u.headers ?? {}), 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
    // @ts-expect-error Node fetch requires duplex for streamed bodies
    duplex: 'half',
  });
  if (res.status !== 200) throw new Error(`upload PUT (${kind} ${variant}) failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return u.storagePath;
}

export interface DraftResult { postId: string; packageId: string; created: boolean; mediaUrl?: string; replyMediaUrl?: string }

/** Upload the four rendered files and create (or refresh) the X draft. Returns the published.json entry. */
export async function uploadAndDraft(h: Hitloop, rec: EligibleRecord, p: Prepared, xAspect: Aspect): Promise<{ entry: PublishedEntry; draft: DraftResult }> {
  const files = { images: [p.imageName], videos: [p.videoName] };
  const variants: VariantPaths = { video: { '9x16': '', '1x1': '' }, image: { '9x16': '', '1x1': '' } };
  for (const a of ASPECT_LIST) variants.video[a] = await uploadFile(h, rec.releaseId, 'video', a, p.clipPaths[a]);
  for (const a of ASPECT_LIST) variants.image[a] = await uploadFile(h, rec.releaseId, 'image', a, p.imagePaths[a]);
  const draft = await h.post<DraftResult>('discogs/draft', buildDraftBody(p.facts, variants, xAspect, { files, clip: p.clip }));
  const entry: PublishedEntry = { releaseId: rec.releaseId, postId: draft.postId, packageId: draft.packageId, at: new Date().toISOString(), clip: p.clip, groupId: rec.group.id };
  return { entry, draft };
}

export interface PublishRecordOpts extends PrepareOpts {
  /** null = dry run: local steps only, nothing uploaded, nothing recorded. */
  hitloop: Hitloop | null;
  xAspect: Aspect;
  published: PublishedEntry[];
  videoOverride?: ScannedMedia;
  /** Pre-fetched source (prefetch pipeline); fetched here when omitted. */
  source?: Promise<LocalSource>;
}

export interface PublishRecordResult { prepared: Prepared; entry: PublishedEntry | null; draft: DraftResult | null; seconds: number }

/** Render + upload + draft one record. Throws on any failure (the caller decides whether to continue the batch). */
export async function publishRecord(rec: EligibleRecord, opts: PublishRecordOpts): Promise<PublishRecordResult> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const src = await (opts.source ?? fetchSource(rec, opts.videoOverride, { paths: opts.paths, log }));
  const prepared = await prepare(rec, src, opts);
  const seconds = (Date.now() - t0) / 1000;
  for (const line of describePrepared(prepared, rec.releaseId, seconds)) log(line);
  if (!opts.hitloop) return { prepared, entry: null, draft: null, seconds };
  const { entry, draft } = await uploadAndDraft(opts.hitloop, rec, prepared, opts.xAspect);
  recordPublished(opts.paths, opts.published, entry);
  log(`  draft ${draft.created ? 'created' : 'already existed'}: post ${draft.postId}, package ${draft.packageId}`);
  return { prepared, entry, draft, seconds };
}

/** Persist this run's framing vision calls (dry runs too: the spend is real and is reported with the next real publish). */
export function logRunCost(paths: PublishPaths, ledger: CostLedger, folder: string, runPrefix = 'publish'): void {
  const ls = ledger.summary();
  if (ls.calls) appendCostLog(paths.costLog, { runId: `${runPrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`, folder, ...ls });
}

/** Report unreported vision cost for this folder to HITLOOP once (only after real publishing). Returns the USD reported, or null. */
export async function reportUsage(h: Hitloop, paths: PublishPaths, folder: string, records: number, log: Log = () => {}): Promise<number | null> {
  const reported = new Set(readJson<string[]>(paths.usageReported, []));
  const cost = unreportedCost(readCostLog(paths.costLog), folder, reported);
  if (!cost) return null;
  try {
    await h.post('usage', {
      module: 'discogs-ingest', action: 'publish-run', provider: 'anthropic', model: 'claude-sonnet-5-5',
      calls: cost.calls, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, costUsd: cost.costUsd,
      runId: cost.runIds[cost.runIds.length - 1], metadata: { records, folder },
    });
    writeFileSync(paths.usageReported, JSON.stringify(Array.from(reported).concat(cost.runIds), null, 2));
    log(`\nUsage reported: $${cost.costUsd} (${cost.calls} vision calls)`);
    return cost.costUsd;
  } catch (e) {
    log(`usage report failed (will retry next run): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
