/**
 * Discogs ingest runtime: plan / estimate / apply / undo with injected deps.
 * Used by ingest-cli.ts (thin wrapper) and analyzer-plugin.ts. No console output,
 * no process access beyond env-derived defaults; every external effect goes through deps.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { DiscogsClient } from './client';
import { scanFolder, toJpeg, groupRecords } from './media';
import { readLabel, isLabelCached, resolveLabelModel } from './label-reader';
import { mergeReads, findCandidates } from './matcher';
import { ADD_THRESHOLD, REVIEW_THRESHOLD } from './types';
import type { DiscogsCandidate, GroupPlan, LabelRead, MediaFile, RecordGroup } from './types';
import { CostLedger, appendCostLog, readCostLog, usageCostUsd } from './cost';
import type { CostSummary } from './cost';

export const NOTES_FIELD_ID = 3;
export const NOTES_MAX = 250; // Discogs rejects longer collection notes (422)
const MAX_ROW_FILES = 8;
/** Rate-card guess for one 1600px label photo (tokens), used until real spend is measured. */
const DEFAULT_READ_USAGE = { inputTokens: 2000, outputTokens: 350 };
const FALLBACK_READ_USD = 0.01;
export const JOURNAL_NAME = /^[\w.-]+-applied[\w.-]*\.jsonl$/;
const PLAN_ID = /^[\w.-]+$/;

export interface ProgressInfo { phase: 'scanning' | 'reading' | 'matching' | 'adding' | 'removing'; done: number; total: number; spentUsd: number }

export interface RunDeps {
  client: DiscogsClient;
  cacheDir: string;
  runsDir: string;
  indexPath?: string;
  /** costs.jsonl; planFolder appends a line, and a measured per-read price is derived from it. */
  costLogPath?: string;
  capUsd?: number;
  onProgress?: (p: ProgressInfo) => void;
  isCancelled?: () => boolean;
  /** Called once after scan + collection fetch, before any label read. */
  onScanned?: (info: { files: number; duplicates: number; groups: number; collection: number }) => void;
  // Injection seams (tests); real implementations by default.
  scan?: typeof scanFolder;
  toJpeg?: (file: MediaFile, cacheDir: string) => Promise<string>;
  readLabel?: (jpegPath: string, fileName: string, opts: { cacheDir: string }) => Promise<LabelRead>;
  isCached?: (jpegPath: string, cacheDir: string) => boolean;
  findCandidates?: (client: DiscogsClient, merged: ReturnType<typeof mergeReads>) => Promise<DiscogsCandidate[]>;
  now?: () => Date;
}

export interface PlanRow {
  groupId: string;
  files: string[];
  images: number;
  videos: number;
  read: { artist: string | null; title: string | null; label: string | null; catno: string | null; year: string | null } | null;
  candidates: { releaseId: number; title: string; catno: string; label: string; year: string | null; formats: string[]; score: number; reasons: string[] }[];
  best: number | null;
  action: GroupPlan['action'];
  reason: string;
  catnoExact: boolean;
}

export interface PlanSummary { groups: number; add: number; alreadyOwned: number; review: number; unreadable: number }

export interface PlanResult {
  planId: string;
  rows: PlanRow[];
  plans: GroupPlan[];
  summary: PlanSummary;
  spentUsd: number;
  cost: CostSummary;
  capReached: boolean;
  cancelled: boolean;
  remaining: number;
}

export interface EstimateResult {
  groups: number; images: number; videos: number;
  cachedReads: number; uncachedReads: number;
  perReadUsd: number; estUsd: number; model: string;
}

const hasUsefulFields = (reads: LabelRead[]) =>
  reads.some(r => r.status !== 'unreadable' && (r.catno || r.artist || r.title));

export function toPlanRow(p: GroupPlan): PlanRow {
  const merged = mergeReads(p.reads);
  const useful = p.reads.length > 0 && hasUsefulFields(p.reads);
  return {
    groupId: p.group.id,
    files: [...p.group.images, ...p.group.videos].map(f => f.name).slice(0, MAX_ROW_FILES),
    images: p.group.images.length,
    videos: p.group.videos.length,
    read: useful ? { artist: merged.artist, title: merged.title, label: merged.label, catno: merged.catno, year: merged.year } : null,
    candidates: p.candidates.slice(0, 3).map(c => ({
      releaseId: c.releaseId, title: c.title, catno: c.catno, label: c.label, year: c.year,
      formats: c.formats.slice(0, 3), score: c.score, reasons: c.reasons,
    })),
    best: p.best?.releaseId ?? null,
    action: p.action,
    reason: p.reason,
    catnoExact: Boolean(p.best?.reasons.includes('catno exact')),
  };
}

export function summarize(plans: GroupPlan[]): PlanSummary {
  const n = (a: GroupPlan['action']) => plans.filter(p => p.action === a).length;
  return { groups: plans.length, add: n('add'), alreadyOwned: n('already-owned'), review: n('review'), unreadable: n('skip-unreadable') };
}

/** Average real spend per billed read from the cost log (needs >= 5 billed reads), else the rate card. */
export function perReadPrice(model: string, costLogPath?: string): number {
  if (costLogPath) {
    try {
      let usd = 0, billed = 0;
      for (const l of readCostLog(costLogPath)) { usd += l.usd; billed += l.billedCalls; }
      if (billed >= 5 && usd > 0) return usd / billed;
    } catch { /* fall through to rate card */ }
  }
  return usageCostUsd(model, DEFAULT_READ_USAGE) ?? FALLBACK_READ_USD;
}

const stampOf = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

async function groupsOf(dir: string, limit: number | undefined, deps: RunDeps) {
  const files = await (deps.scan ?? scanFolder)(dir, { indexPath: deps.indexPath });
  const groups = groupRecords(files).slice(0, limit ?? Infinity);
  return { files, groups };
}

export async function estimateFolder(input: { dir: string; limit?: number }, deps: RunDeps): Promise<EstimateResult> {
  const { groups } = await groupsOf(input.dir, input.limit, deps);
  const model = resolveLabelModel();
  const jpeg = deps.toJpeg ?? ((f, c) => toJpeg(f, c));
  const cached = deps.isCached ?? ((p, c) => isLabelCached(p, c));
  let images = 0, videos = 0, cachedReads = 0, uncachedReads = 0;
  for (const g of groups) {
    videos += g.videos.length;
    for (const img of g.images) {
      images++;
      if (cached(await jpeg(img, deps.cacheDir), deps.cacheDir)) cachedReads++; else uncachedReads++;
    }
  }
  const perReadUsd = perReadPrice(model, deps.costLogPath);
  return { groups: groups.length, images, videos, cachedReads, uncachedReads, perReadUsd, estUsd: uncachedReads * perReadUsd, model };
}

async function planGroup(
  group: RecordGroup, owned: Set<number>, claimed: Set<number>, ledger: CostLedger, deps: RunDeps, jpegs: Map<string, string>,
): Promise<GroupPlan> {
  const read = deps.readLabel ?? readLabel;
  const reads: LabelRead[] = [];
  for (const img of group.images) {
    const r = await read(jpegs.get(img.path)!, img.name, { cacheDir: deps.cacheDir });
    ledger.add({ kind: 'vision', file: img.name, model: r.model, usage: r.usage, cached: r.cached });
    reads.push(r);
  }
  const base: Omit<GroupPlan, 'action' | 'reason'> = { group, reads, candidates: [], best: null };
  if (!group.images.length) return { ...base, action: 'skip-unreadable', reason: 'video only, no label photo' };
  if (!hasUsefulFields(reads)) return { ...base, action: 'skip-unreadable', reason: 'no readable label text' };

  const candidates = await (deps.findCandidates ?? findCandidates)(deps.client, mergeReads(reads));
  const best = candidates[0] ?? null;
  const plan = { ...base, candidates, best };
  if (!best || best.score < REVIEW_THRESHOLD) return { ...plan, action: 'review', reason: 'no confident match' };
  if (owned.has(best.releaseId)) return { ...plan, action: 'already-owned', reason: 'already in collection' };
  if (claimed.has(best.releaseId)) return { ...plan, action: 'already-owned', reason: 'same release as an earlier group in this run' };
  if (best.score >= ADD_THRESHOLD && best.reasons.includes('catno exact')) {
    claimed.add(best.releaseId);
    return { ...plan, action: 'add', reason: `score ${best.score}, catno exact` };
  }
  return { ...plan, action: 'review', reason: `score ${best.score}${best.reasons.includes('catno exact') ? '' : ', no exact catno'}` };
}

export async function planFolder(input: { dir: string; limit?: number }, deps: RunDeps): Promise<PlanResult> {
  mkdirSync(deps.cacheDir, { recursive: true });
  mkdirSync(deps.runsDir, { recursive: true });
  const progress = (phase: ProgressInfo['phase'], done: number, total: number, spentUsd: number) =>
    deps.onProgress?.({ phase, done, total, spentUsd });
  const model = resolveLabelModel();
  const perRead = perReadPrice(model, deps.costLogPath);
  const jpeg = deps.toJpeg ?? ((f, c) => toJpeg(f, c));
  const isCached = deps.isCached ?? ((p, c) => isLabelCached(p, c));
  const ledger = new CostLedger();
  // Unpriced-model reads cannot be summed from the ledger; charge the estimate so the cap still holds.
  const spent = () => { const s = ledger.summary(); return s.usd + s.unknownModelCalls * perRead; };

  progress('scanning', 0, 0, 0);
  const me = await deps.client.identity();
  const owned = await deps.client.collectionReleaseIds(me.username);
  const { files, groups } = await groupsOf(input.dir, input.limit, deps);
  deps.onScanned?.({ files: files.length, duplicates: files.filter(f => f.duplicateOf).length, groups: groups.length, collection: owned.size });

  const plans: GroupPlan[] = [];
  const claimed = new Set<number>();
  let capReached = false, cancelled = false;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (deps.isCancelled?.()) { cancelled = true; break; }
    const jpegs = new Map<string, string>();
    let uncached = 0;
    for (const img of g.images) {
      const j = await jpeg(img, deps.cacheDir);
      jpegs.set(img.path, j);
      if (!isCached(j, deps.cacheDir)) uncached++;
    }
    // Stop before any uncached read that would push spend past the cap.
    const billedSoFar = ledger.summary().billedCalls;
    const measured = billedSoFar > 0 ? Math.max(spent() / billedSoFar, 0) || perRead : perRead;
    if (deps.capUsd !== undefined && uncached > 0 && spent() + uncached * measured > deps.capUsd) { capReached = true; break; }

    progress('reading', i, groups.length, spent());
    try {
      plans.push(await planGroup(g, owned, claimed, ledger, { ...deps, onProgress: undefined }, jpegs));
    } catch (e) {
      plans.push({ group: g, reads: [], candidates: [], best: null, action: 'review', reason: `error: ${e instanceof Error ? e.message : e}` });
    }
    progress('matching', i + 1, groups.length, spent());
  }

  const planId = stampOf((deps.now ?? (() => new Date()))());
  const cost = ledger.summary();
  if (deps.costLogPath) appendCostLog(deps.costLogPath, { runId: planId, folder: input.dir, ...cost });
  writeFileSync(join(deps.runsDir, `${planId}-plan.json`), JSON.stringify(plans, null, 2));
  return {
    planId, rows: plans.map(toPlanRow), plans, summary: summarize(plans),
    spentUsd: spent(), cost, capReached, cancelled, remaining: groups.length - plans.length,
  };
}

/** Collection note for a record's files; Discogs caps notes at 250 chars. */
export function notesFor(group: RecordGroup, renamed: Map<string, string> = new Map()): string {
  const name = (f: { path: string; name: string }) => renamed.has(f.path) ? basename(renamed.get(f.path)!) : f.name;
  const imgs = group.images.map(name);
  const vids = group.videos.map(name);
  const full = `HITLOOP ingest. Label photos: ${imgs.join(', ') || 'none'}. Videos: ${vids.join(', ') || 'none'}.`;
  if (full.length <= NOTES_MAX) return full;
  // Renamed files share one base; name it once and count the rest.
  const base = (imgs[0] ?? vids[0] ?? '').replace(/_(label|video)\d+(-\d+)?\.\w+$/, '');
  return `HITLOOP ingest. Files: ${base}_* (${imgs.length} label photo${imgs.length === 1 ? '' : 's'}, ${vids.length} video${vids.length === 1 ? '' : 's'}).`.slice(0, NOTES_MAX);
}

export interface ApplyInput {
  planId: string;
  items: { groupId: string; releaseId: number }[];
  notes?: boolean;
  folderId?: number;
}
export interface ApplyResult {
  planId: string;
  journal: string;
  applied: { groupId: string; releaseId: number; instanceId: number }[];
  skipped: { groupId: string; releaseId: number; reason: string }[];
  errors: { groupId: string; releaseId: number; error: string }[];
  cancelled?: true;
}
export interface ApplyDeps extends RunDeps {
  /** Use these plans instead of reading runs/<planId>-plan.json (CLI already has them). */
  plans?: GroupPlan[];
  /** Journal basename; default `<planId>-applied-<stamp>.jsonl`. */
  journalName?: string;
  onAdded?: (a: { groupId: string; releaseId: number; instanceId: number }) => void;
}

export async function applyPlan(input: ApplyInput, deps: ApplyDeps): Promise<ApplyResult> {
  if (!PLAN_ID.test(input.planId)) throw new Error('Invalid plan id');
  const folderId = input.folderId ?? 1;
  const plans: GroupPlan[] = deps.plans ?? JSON.parse(readFileSync(join(deps.runsDir, `${input.planId}-plan.json`), 'utf8'));
  const groups = new Map(plans.map(p => [p.group.id, p.group]));
  mkdirSync(deps.runsDir, { recursive: true });

  const me = await deps.client.identity();
  const owned = await deps.client.collectionReleaseIds(me.username);
  const journal = deps.journalName ?? `${input.planId}-applied-${stampOf((deps.now ?? (() => new Date()))())}.jsonl`;
  const result: ApplyResult = { planId: input.planId, journal, applied: [], skipped: [], errors: [] };

  for (let i = 0; i < input.items.length; i++) {
    const { groupId, releaseId } = input.items[i];
    if (deps.isCancelled?.()) { result.cancelled = true; break; }
    deps.onProgress?.({ phase: 'adding', done: i, total: input.items.length, spentUsd: 0 });
    const group = groups.get(groupId);
    if (!group) { result.errors.push({ groupId, releaseId, error: 'group not in plan' }); continue; }
    if (owned.has(releaseId)) { result.skipped.push({ groupId, releaseId, reason: 'already in collection' }); continue; }
    try {
      const added = await deps.client.addToCollection(me.username, folderId, releaseId);
      owned.add(releaseId);
      appendFileSync(join(deps.runsDir, journal), JSON.stringify({ releaseId, folderId, instanceId: added.instance_id, group: groupId }) + '\n');
      const a = { groupId, releaseId, instanceId: added.instance_id };
      result.applied.push(a);
      deps.onAdded?.(a);
      if (input.notes) {
        try { await deps.client.setInstanceField(me.username, folderId, releaseId, added.instance_id, NOTES_FIELD_ID, notesFor(group)); }
        catch (e) { console.warn(`notes not saved for ${releaseId}: ${e instanceof Error ? e.message : e}`); }
      }
    } catch (e) {
      result.errors.push({ groupId, releaseId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  deps.onProgress?.({ phase: 'adding', done: input.items.length, total: input.items.length, spentUsd: 0 });
  return result;
}

export interface UndoResult {
  journal: string;
  removed: { groupId: string; releaseId: number; instanceId: number }[];
  errors: { groupId: string; releaseId: number; error: string }[];
  cancelled?: true;
}

export async function undoApply(
  input: { journal: string },
  deps: Pick<RunDeps, 'client' | 'runsDir' | 'onProgress' | 'isCancelled'> & { onRemoved?: (r: { releaseId: number; instanceId: number }) => void },
): Promise<UndoResult> {
  const name = input.journal;
  if (typeof name !== 'string' || name !== basename(name) || !JOURNAL_NAME.test(name)) throw new Error('Invalid journal name');
  const root = resolve(deps.runsDir);
  const file = resolve(root, name);
  if (!file.startsWith(root + sep)) throw new Error('Journal path escapes the runs folder');

  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const me = await deps.client.identity();
  const result: UndoResult = { journal: name, removed: [], errors: [] };
  for (let i = 0; i < lines.length; i++) {
    if (deps.isCancelled?.()) { result.cancelled = true; break; }
    deps.onProgress?.({ phase: 'removing', done: i, total: lines.length, spentUsd: 0 });
    let row: { releaseId: number; folderId: number; instanceId: number; group?: string };
    try { row = JSON.parse(lines[i]); } catch { result.errors.push({ groupId: '', releaseId: 0, error: `bad journal line ${i + 1}` }); continue; }
    const groupId = row.group ?? '';
    try {
      await deps.client.removeInstance(me.username, row.folderId, row.releaseId, row.instanceId);
      result.removed.push({ groupId, releaseId: row.releaseId, instanceId: row.instanceId });
      deps.onRemoved?.({ releaseId: row.releaseId, instanceId: row.instanceId });
    } catch (e) {
      result.errors.push({ groupId, releaseId: row.releaseId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  deps.onProgress?.({ phase: 'removing', done: lines.length, total: lines.length, spentUsd: 0 });
  return result;
}
