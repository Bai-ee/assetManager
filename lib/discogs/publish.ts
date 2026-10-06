/**
 * Pure helpers for the Discogs -> X draft publisher (publish-cli.ts).
 * No I/O here so everything is unit-testable.
 */
import type { GroupPlan, RecordGroup } from './types.ts';
import type { CostLogLine } from './cost.ts';

export interface ReleaseFacts {
  releaseId: number;
  discogsUrl: string;
  artist: string;
  title: string;
  label: string;
  catno: string;
  year: string | null;
}

/** "Artist (2)" -> "Artist"; trailing "*" (Discogs ANV marker) removed. */
export function cleanName(s: string | undefined | null): string {
  return String(s ?? '').replace(/\*+$/g, '').replace(/\s*\(\d+\)$/, '').trim();
}

/** Normalise a Discogs GET /releases/{id} payload into the facts HITLOOP needs. */
export function releaseFacts(rel: any): ReleaseFacts {
  const artist = (rel.artists ?? []).map((a: any) => cleanName(a.name)).filter(Boolean).join(', ')
    || cleanName(String(rel.artists_sort ?? ''));
  const l = (rel.labels ?? [])[0];
  const y = rel.year ? String(rel.year) : null;
  return {
    releaseId: Number(rel.id),
    discogsUrl: String(rel.uri ?? `https://www.discogs.com/release/${rel.id}`),
    artist,
    title: String(rel.title ?? '').trim(),
    label: cleanName(l?.name),
    catno: String(l?.catno ?? '').trim().replace(/\s*-\s*/g, '-'),
    year: y && y !== '0' ? y : null,
  };
}

export interface EligibleRecord {
  releaseId: number;
  plan: GroupPlan;
  group: RecordGroup;
}

/** Confident = exact catno on a release we add or already own (same rule as ingest-cli). */
export function isConfident(p: GroupPlan): boolean {
  return Boolean(p.best && p.best.reasons.includes('catno exact') && (p.action === 'add' || p.action === 'already-owned'));
}

/**
 * Map freshly scanned groups onto saved plans. Group id (g-<first image fingerprint>) is
 * content-based so it survives NAS renames. Plans are passed newest-first; the newest plan
 * that knows a group wins. Falls back to any shared image fingerprint (group boundaries can
 * shift between runs). Groups without a confident plan are dropped; one record per release.
 */
export function selectEligible(
  groups: RecordGroup[],
  plansNewestFirst: GroupPlan[],
  published: Set<number>,
  opts: { release?: number; force?: boolean } = {},
): { eligible: EligibleRecord[]; noVideo: EligibleRecord[]; alreadyPublished: number[] } {
  const byId = new Map<string, GroupPlan>();
  const byFp = new Map<string, GroupPlan>();
  for (const p of plansNewestFirst) {
    if (!byId.has(p.group.id)) byId.set(p.group.id, p);
    for (const im of p.group.images) if (!byFp.has(im.fingerprint)) byFp.set(im.fingerprint, p);
  }
  const eligible: EligibleRecord[] = [];
  const noVideo: EligibleRecord[] = [];
  const alreadyPublished: number[] = [];
  const seen = new Set<number>();
  for (const g of groups) {
    const plan = byId.get(g.id) ?? g.images.map(i => byFp.get(i.fingerprint)).find(Boolean);
    if (!plan || !isConfident(plan) || !g.images.length) continue;
    const releaseId = plan.best!.releaseId;
    if (opts.release !== undefined && releaseId !== opts.release) continue;
    if (seen.has(releaseId)) continue;
    seen.add(releaseId);
    if (published.has(releaseId) && !opts.force) { alreadyPublished.push(releaseId); continue; }
    const rec = { releaseId, plan, group: g };
    (g.videos.length ? eligible : noVideo).push(rec);
  }
  return { eligible, noVideo, alreadyPublished };
}

export interface UnreportedCost {
  runIds: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Cost-log runs for this folder whose runId has not been sent to HITLOOP yet; null if none. */
export function unreportedCost(lines: CostLogLine[], folder: string, reported: Set<string>): UnreportedCost | null {
  const mine = lines.filter(l => l.folder === folder && !reported.has(l.runId));
  if (!mine.length) return null;
  const total: UnreportedCost = {
    runIds: mine.map(l => l.runId),
    calls: mine.reduce((a, l) => a + l.billedCalls, 0),
    inputTokens: mine.reduce((a, l) => a + l.inputTokens, 0),
    outputTokens: mine.reduce((a, l) => a + l.outputTokens, 0),
    costUsd: Math.round(mine.reduce((a, l) => a + l.usd, 0) * 1e6) / 1e6,
  };
  return total;
}

export type Variant = '9x16' | '1x1';
export const VARIANTS: Variant[] = ['9x16', '1x1'];
export interface VariantPaths { video: Record<Variant, string>; image: Record<Variant, string> }

/** Strip emoji / pictographs (and joiners) so post text coming from Discogs data never carries them. */
export function stripEmoji(s: string): string {
  return s.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Draft body for HITLOOP `discogs/draft`. `videoStoragePath` / `imageStoragePath` stay the variant used for X
 * (xAspect); `variants` carries all four uploads.
 */
export function buildDraftBody(
  facts: ReleaseFacts, variants: VariantPaths, xAspect: Variant,
  extra: { files: { images: string[]; videos: string[] }; clip: unknown },
): Record<string, unknown> {
  return {
    releaseId: facts.releaseId,
    discogsUrl: facts.discogsUrl,
    artist: stripEmoji(facts.artist),
    title: stripEmoji(facts.title),
    label: stripEmoji(facts.label),
    catno: stripEmoji(facts.catno),
    year: facts.year,
    videoStoragePath: variants.video[xAspect],
    imageStoragePath: variants.image[xAspect],
    variants,
    files: extra.files,
    clip: extra.clip,
  };
}
