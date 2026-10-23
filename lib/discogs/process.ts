/**
 * One-shot "process the Discogs drive": plan (read labels + match) -> add confident new records to the collection
 * -> render + draft every confident, unpublished record that has exactly ONE clip -> list everything else for review
 * (label thumb beside each clip frame). Runs the same pipeline the CLIs run; the daemon exposes it as DISCOGS_PROCESS.
 *
 * Rules (owner, 2026-10-23): a group with 2+ clips or 0 clips is never rendered automatically (longest-wins is what
 * produced wrong records); it goes to review. Nothing is renamed on the NAS. Nothing is scheduled or posted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CostLedger } from './cost.ts';
import { isConfident, type EligibleRecord } from './publish.ts';
import { planFolder as realPlanFolder, applyPlan as realApplyPlan, type RunDeps, type ApplyResult, type PlanSummary, type ProgressInfo } from './run.ts';
import { publishRecord as realPublishRecord, readPublished, publishPaths, loadPlansNewestFirst, logRunCost, reportUsage, type Hitloop, type PublishPaths, type PublishRecordOpts, type PublishRecordResult, type Log } from './publish-run.ts';
import type { GroupPlan, MediaFile } from './types.ts';
import type { ScannedMedia } from './media.ts';
import type { Aspect, ClipMode } from './video.ts';

const execFileP = promisify(execFile);

export const MAX_REVIEW_ROWS = 25;
export const THUMB_PX = 240;

export interface ProcessOnly { groupId: string; releaseId: number; video?: string }

export interface ProcessInput {
  dir: string;
  /** Label-read cap for this run (planFolder). */
  capUsd?: number;
  /** Max label reads (planFolder limit). */
  limit?: number;
  /** Max records rendered this run. */
  maxRender?: number;
  /** Operator resolutions from the review list: render exactly these, pinned to the given release (+ clip). */
  only?: ProcessOnly[];
  /** false = plan + review only (no collection adds, no renders). */
  publish?: boolean;
  xAspect?: Aspect;
  clipMode?: ClipMode;
  maxReview?: number;
}

export interface ReviewClip { name: string; seconds: number | null; thumb: string | null }
export interface ReviewRow {
  groupId: string;
  isNew: boolean;
  capturedAt: string | null;
  label: { name: string; thumb: string | null };
  clips: ReviewClip[];
  read: { artist: string | null; title: string | null; label: string | null; catno: string | null } | null;
  candidates: { releaseId: number; title: string; catno: string; label: string; country: string | null; year: string | null; score: number }[];
  best: number | null;
  action: GroupPlan['action'];
  reason: string;
}

export interface ProcessResult {
  planId: string;
  summary: PlanSummary;
  newFiles: number;
  added: ApplyResult | null;
  published: { groupId: string; releaseId: number; title: string; postId: string; packageId: string; created: boolean; video: string }[];
  failed: { groupId: string; releaseId: number; error: string }[];
  review: ReviewRow[];
  reviewTotal: number;
  noClip: { groupId: string; releaseId: number; title: string }[];
  spentUsd: number;
  renderUsd: number;
  cancelled: boolean;
}

export interface ProcessDeps extends RunDeps {
  paths?: PublishPaths;
  /** null = never upload/draft (dry). */
  hitloop: Hitloop | null;
  log?: Log;
  // injection seams (tests)
  planFolder?: typeof realPlanFolder;
  applyPlan?: typeof realApplyPlan;
  publishRecord?: (rec: EligibleRecord, opts: PublishRecordOpts) => Promise<PublishRecordResult>;
  thumb?: (file: MediaFile, kind: 'image' | 'video', paths: PublishPaths) => Promise<string | null>;
  readIndexPaths?: (indexPath: string) => Set<string>;
}

/** Paths currently in index.json (what the previous runs already knew). */
export function readIndexPaths(indexPath: string): Set<string> {
  try { return new Set(Object.keys(JSON.parse(readFileSync(indexPath, 'utf8')))); } catch { return new Set(); }
}

async function ffmpegThumb(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('ffmpeg', ['-nostdin', '-v', 'error', ...args, '-frames:v', '1', '-vf', `scale=${THUMB_PX}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '8', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    return stdout.length ? `data:image/jpeg;base64,${Buffer.from(stdout).toString('base64')}` : null;
  } catch { return null; }
}

/** Small JPEG data URL: label = the cached read image when present (fast, local), else the NAS file; video = mid-clip frame. */
export async function thumbFor(file: MediaFile, kind: 'image' | 'video', paths: PublishPaths): Promise<string | null> {
  if (kind === 'image') {
    const cached = join(paths.cache, `${file.fingerprint}.jpg`);
    return ffmpegThumb(['-i', existsSync(cached) ? cached : file.path]);
  }
  const dur = (file as ScannedMedia).durationS ?? null;
  return ffmpegThumb(['-ss', String(Math.max(0, Math.floor((dur ?? 20) / 2))), '-i', file.path]);
}

const groupFiles = (g: GroupPlan['group']) => [...g.images, ...g.videos];
const groupCaptured = (g: GroupPlan['group']) => groupFiles(g).map(f => f.capturedAt ?? f.mtime).sort()[0] ?? null;
const hasNewFile = (g: GroupPlan['group'], known: Set<string>) => groupFiles(g).some(f => !known.has(f.path));

/** What is already drafted: by release id (legacy entries) and by label group (survives the matcher picking another pressing). */
export interface Done { ids: Set<number>; groups: Set<string> }
export const doneFrom = (entries: { releaseId: number; groupId?: string }[]): Done =>
  ({ ids: new Set(entries.map(e => e.releaseId)), groups: new Set(entries.map(e => e.groupId).filter((g): g is string => !!g)) });
const isDone = (p: GroupPlan, done: Done) => done.groups.has(p.group.id) || (!!p.best && done.ids.has(p.best.releaseId));

/** Confident, unpublished, exactly one clip: rendered without asking. */
export function autoRenderable(p: GroupPlan, done: Done): boolean {
  return isConfident(p) && !isDone(p, done) && p.group.videos.length === 1 && p.group.images.length > 0;
}

/** Needs a person: has a clip, not published, and either not confident or more than one clip. */
export function needsReview(p: GroupPlan, done: Done): boolean {
  if (!p.group.videos.length || !p.group.images.length) return false;
  if (isDone(p, done)) return false;
  return !autoRenderable(p, done);
}

export async function processFolder(input: ProcessInput, deps: ProcessDeps): Promise<ProcessResult> {
  const log = deps.log ?? (() => {});
  const paths = deps.paths ?? publishPaths();
  const plan = deps.planFolder ?? realPlanFolder;
  const apply = deps.applyPlan ?? realApplyPlan;
  const publish = deps.publishRecord ?? realPublishRecord;
  const thumb = deps.thumb ?? thumbFor;
  const indexPath = deps.indexPath ?? join(paths.home, 'index.json');
  const known = (deps.readIndexPaths ?? readIndexPaths)(indexPath);
  const cancelled = () => deps.isCancelled?.() === true;
  const progress = (phase: ProgressInfo['phase'], done: number, total: number, spentUsd: number) => deps.onProgress?.({ phase, done, total, spentUsd });

  // 1-2. scan + read + match (planFolder reports scanning/reading/matching itself). Groups already drafted reuse their
  // saved plan (same files => same answer), so a run with nothing new costs one scan, not 100+ Discogs searches.
  const doneGroups = doneFrom(readPublished(paths)).groups;
  const reuse = new Map<string, GroupPlan>();
  for (const p of loadPlansNewestFirst(paths.runs)) if (doneGroups.has(p.group.id) && !reuse.has(p.group.id)) reuse.set(p.group.id, p);
  const planned = await plan({ dir: input.dir, limit: input.limit }, { ...deps, reuse, capUsd: input.capUsd ?? deps.capUsd });
  const plans = planned.plans;
  const newFiles = plans.flatMap(p => groupFiles(p.group)).filter(f => !known.has(f.path)).length;
  log(`plan ${planned.planId}: ${planned.summary.groups} groups, ${newFiles} new file(s), $${planned.spentUsd.toFixed(4)} label reads`);
  const result: ProcessResult = {
    planId: planned.planId, summary: planned.summary, newFiles, added: null, published: [], failed: [], review: [], reviewTotal: 0, noClip: [],
    spentUsd: planned.spentUsd, renderUsd: 0, cancelled: planned.cancelled,
  };
  const doPublish = input.publish !== false;

  // 3. add confident new records to the collection (exact catno only = action 'add')
  const adds = doPublish && !result.cancelled ? plans.filter(p => p.action === 'add' && p.best).map(p => ({ groupId: p.group.id, releaseId: p.best!.releaseId })) : [];
  if (adds.length) {
    result.added = await apply({ planId: planned.planId, items: adds, notes: false, folderId: 1 }, { ...deps, plans });
    if (result.added.cancelled) result.cancelled = true;
    log(`collection: ${result.added.applied.length} added, ${result.added.skipped.length} already owned, ${result.added.errors.length} errors`);
  }

  // 4. render + draft
  const published = readPublished(paths);
  const done = doneFrom(published);
  const byId = new Map(plans.map(p => [p.group.id, p]));
  let todo: { rec: EligibleRecord; video?: ScannedMedia }[] = [];
  if (input.only?.length) {
    for (const o of input.only) {
      const p = byId.get(o.groupId);
      if (!p) { result.failed.push({ groupId: o.groupId, releaseId: o.releaseId, error: 'group not in this plan' }); continue; }
      const video = o.video ? (p.group.videos as ScannedMedia[]).find(v => v.name === o.video) : undefined;
      if (o.video && !video) { result.failed.push({ groupId: o.groupId, releaseId: o.releaseId, error: `clip ${o.video} is not in this group` }); continue; }
      if (!video && p.group.videos.length !== 1) { result.failed.push({ groupId: o.groupId, releaseId: o.releaseId, error: 'pick which clip to use' }); continue; }
      todo.push({ rec: { releaseId: o.releaseId, plan: p, group: p.group }, video });
    }
  } else if (doPublish) {
    const seen = new Set<number>();
    for (const p of plans) {
      if (!autoRenderable(p, done)) continue;
      const releaseId = p.best!.releaseId;
      if (seen.has(releaseId)) continue;
      seen.add(releaseId);
      todo.push({ rec: { releaseId, plan: p, group: p.group } });
    }
  }
  todo = todo.slice(0, input.maxRender ?? 50);
  for (const p of plans) {
    if (isConfident(p) && !isDone(p, done) && p.group.videos.length === 0) result.noClip.push({ groupId: p.group.id, releaseId: p.best!.releaseId, title: p.best!.title });
  }

  const ledger = new CostLedger();
  if (todo.length && !result.cancelled) {
    const h = doPublish ? deps.hitloop : null;
    for (const [i, { rec, video }] of todo.entries()) {
      if (cancelled()) { result.cancelled = true; break; }
      progress('rendering', i, todo.length, ledger.summary().usd);
      try {
        const r = await publish(rec, { paths, client: deps.client, ledger, clipMode: input.clipMode ?? 'auto', log, hitloop: h, xAspect: input.xAspect ?? '1x1', published, videoOverride: video });
        if (r.entry && r.draft) {
          done.ids.add(rec.releaseId); done.groups.add(rec.group.id);
          result.published.push({ groupId: rec.group.id, releaseId: rec.releaseId, title: `${r.prepared.facts.artist} - ${r.prepared.facts.title}`, postId: r.entry.postId, packageId: r.entry.packageId, created: r.draft.created, video: r.prepared.videoName });
        }
      } catch (e) {
        result.failed.push({ groupId: rec.group.id, releaseId: rec.releaseId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    progress('rendering', todo.length, todo.length, ledger.summary().usd);
    result.renderUsd = ledger.summary().usd;
    logRunCost(paths, ledger, input.dir, 'process');
    if (h && result.published.length) await reportUsage(h, paths, input.dir, result.published.length, log);
  }

  // 5. review list: newest first, new files first, thumbs for the top rows only
  const reviewPlans = plans.filter(p => needsReview(p, done))
    .map(p => ({ p, isNew: hasNewFile(p.group, known), at: groupCaptured(p.group) ?? '' }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.at.localeCompare(a.at));
  result.reviewTotal = reviewPlans.length;
  const top = reviewPlans.slice(0, input.maxReview ?? MAX_REVIEW_ROWS);
  for (const [i, { p, isNew, at }] of top.entries()) {
    if (cancelled()) { result.cancelled = true; break; }
    progress('thumbnails', i, top.length, 0);
    const read = p.reads.find(r => r.status !== 'unreadable') ?? null;
    result.review.push({
      groupId: p.group.id, isNew, capturedAt: at || null,
      label: { name: p.group.images[0].name, thumb: await thumb(p.group.images[0], 'image', paths) },
      clips: await Promise.all(p.group.videos.map(async v => ({ name: v.name, seconds: (v as ScannedMedia).durationS ?? null, thumb: await thumb(v, 'video', paths) }))),
      read: read ? { artist: read.artist, title: read.title, label: read.label, catno: read.catno } : null,
      candidates: p.candidates.slice(0, 4).map(c => ({ releaseId: c.releaseId, title: c.title, catno: c.catno, label: c.label, country: c.country ?? null, year: c.year ?? null, score: c.score })),
      best: p.best?.releaseId ?? null, action: p.action, reason: p.group.videos.length > 1 ? `${p.group.videos.length} clips in this group: pick one` : p.reason,
    });
  }
  progress('thumbnails', top.length, top.length, 0);
  log(`done: ${result.published.length} drafted, ${result.failed.length} failed, ${result.reviewTotal} for review, ${result.noClip.length} without a clip`);
  return result;
}
