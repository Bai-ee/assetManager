/**
 * PLAN: read a library, hash every original, resolve dates, compute canonical paths and classify
 * each item against the destination (docs/archive/PHOTOLIB.md). Writes nothing except the saved plan JSON.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sha256File } from '../archive/hash';
import type { ChildFile, ChildRole, ExifInfo, LibraryItem, Plan, PlanItem, ReadLibraryResult, ResolvedDate } from './types';
import type { Manifest } from './manifest';

export interface PlanDeps {
  readLibrary: (libraryPath: string, opts: { sourceId: string }) => ReadLibraryResult;
  readExifBatch: (paths: string[], opts?: { concurrency?: number }) => Promise<Map<string, ExifInfo | null>>;
  resolveTakenDate: (item: Pick<LibraryItem, 'imageDateUtc' | 'tzOffsetSec'>, exif: ExifInfo | null) => ResolvedDate;
  canonicalPathFor: (date: ResolvedDate, parentSha256: string, ext: string, role?: 'motion' | 'edited') => string;
  normalizeExt: (fileName: string) => string;
  hashFile?: (p: string) => Promise<string>;
}

export interface PlanProgress { phase: 'read' | 'hash' | 'exif' | 'classify'; done: number; total: number }

export interface BuildPlanOptions {
  libraryPath: string;
  destRoot: string;
  sourceId: string;
  limit?: number;
  manifest: Manifest;
  deps: PlanDeps;
  onProgress?: (p: PlanProgress) => void;
  now?: () => Date;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export function newPlanId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `plan-${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

export async function buildPlan(opts: BuildPlanOptions): Promise<Plan> {
  const { manifest, deps, destRoot, sourceId } = opts;
  const hashFile = deps.hashFile ?? sha256File;
  const now = (opts.now ?? (() => new Date()))();
  const lib = deps.readLibrary(opts.libraryPath, { sourceId });
  const items = opts.limit && opts.limit > 0 ? lib.items.slice(0, opts.limit) : lib.items;
  const warnings = [...lib.warnings];
  opts.onProgress?.({ phase: 'read', done: items.length, total: items.length });

  // Hash cache: library-relative path + size -> sha (manifest), else compute.
  const hashLibraryFile = async (rel: string, abs: string, size: number): Promise<string> =>
    manifest.getCachedHash(sourceId, rel, size) ?? (await hashFile(abs));

  const fileCount = items.reduce((n, i) => n + 1 + (i.motion ? 1 : 0) + (i.edited ? 1 : 0), 0);
  let hashed = 0;
  const shas: string[] = [];
  const childShas: Partial<Record<ChildRole, string>>[] = [];
  const failed = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      shas.push(await hashLibraryFile(it.relativePath, it.absPath, it.sizeBytes));
    } catch (e) {
      shas.push(''); failed.add(i);
      warnings.push({ masterUuid: it.masterUuid, relativePath: it.relativePath, reason: `hash failed: ${(e as Error).message}` });
    }
    hashed++; opts.onProgress?.({ phase: 'hash', done: hashed, total: fileCount });
    const cs: Partial<Record<ChildRole, string>> = {};
    for (const role of ['motion', 'edited'] as ChildRole[]) {
      const c = it[role];
      if (!c) continue;
      try { cs[role] = await hashLibraryFile(c.relativePath, c.absPath, c.sizeBytes); }
      catch (e) { warnings.push({ masterUuid: it.masterUuid, relativePath: c.relativePath, reason: `child hash failed: ${(e as Error).message}` }); }
      hashed++; opts.onProgress?.({ phase: 'hash', done: hashed, total: fileCount });
    }
    childShas.push(cs);
  }

  const exifPaths = items.map(i => i.absPath);
  for (const it of items) { if (it.motion) exifPaths.push(it.motion.absPath); }
  const exifMap = await deps.readExifBatch(exifPaths);
  opts.onProgress?.({ phase: 'exif', done: items.length, total: items.length });

  const destSize = (rel: string): number | null => {
    try { const st = fs.statSync(path.join(destRoot, rel)); return st.isFile() ? st.size : null; } catch { return null; }
  };
  /** 'absent' | 'same' | 'different' for the file at destRoot/rel versus an expected sha/size. */
  const probe = async (rel: string, sha: string, size: number): Promise<'absent' | 'same' | 'different'> => {
    const sz = destSize(rel);
    if (sz === null) return 'absent';
    if (sz !== size) return 'different';
    const known = manifest.getAsset(sha);
    if (known && known.canonicalPath === rel && known.verifiedAt && known.sizeBytes === size) return 'same';
    return (await hashFile(path.join(destRoot, rel))) === sha ? 'same' : 'different';
  };

  const out: PlanItem[] = [];
  const seen = new Set<string>();
  const totals = { items: 0, copy: 0, present: 0, duplicate: 0, conflict: 0, children: 0, bytes: 0 };
  for (let i = 0; i < items.length; i++) {
    if (failed.has(i)) continue;
    const item = items[i];
    const sha = shas[i];
    const exif = exifMap.get(item.absPath) ?? null;
    const date = deps.resolveTakenDate(item, exif);
    const ext = deps.normalizeExt(item.originalFileName);
    const canonicalPath = deps.canonicalPathFor(date, sha, ext);
    let action: PlanItem['action'];
    if (seen.has(sha)) action = 'duplicate';
    else {
      const p = await probe(canonicalPath, sha, item.sizeBytes);
      if (p === 'same') action = 'present';
      else if (p === 'different') action = 'conflict';
      else {
        const known = manifest.getAsset(sha);
        action = known && known.verifiedAt && destSize(known.canonicalPath) === known.sizeBytes ? 'duplicate' : 'copy';
      }
    }
    seen.add(sha);

    const children: PlanItem['children'] = [];
    if (action !== 'duplicate' && action !== 'conflict') {
      for (const role of ['motion', 'edited'] as ChildRole[]) {
        const file: ChildFile | null = item[role];
        const csha = childShas[i][role];
        if (!file || !csha) continue;
        const cpath = deps.canonicalPathFor(date, sha, deps.normalizeExt(path.basename(file.absPath)), role);
        const cp = await probe(cpath, csha, file.sizeBytes);
        if (cp === 'different') warnings.push({ masterUuid: item.masterUuid, relativePath: file.relativePath, reason: `child destination ${cpath} holds a different file` });
        children.push({ role, sha256: csha, file, canonicalPath: cpath, action: cp === 'same' ? 'present' : 'copy', durationSec: exifMap.get(file.absPath)?.durationSec ?? null });
      }
    }

    totals.items++; totals[action]++;
    if (action === 'copy') totals.bytes += item.sizeBytes;
    for (const c of children) { totals.children++; if (c.action === 'copy') totals.bytes += c.file.sizeBytes; }
    const camera = exif && (exif.make || exif.model) ? { make: exif.make, model: exif.model } : null;
    // Library row duration wins; EXIF fills the gap for videos the library did not measure.
    const planned = item.durationSec == null && exif?.durationSec != null ? { ...item, durationSec: exif.durationSec } : item;
    out.push({ sha256: sha, item: planned, date, canonicalPath, action, camera, children });
    opts.onProgress?.({ phase: 'classify', done: i + 1, total: items.length });
  }

  return {
    planId: newPlanId(now),
    sourceId,
    libraryKind: lib.kind,
    libraryPath: toPosix(path.relative(destRoot, opts.libraryPath)),
    destRoot,
    createdAt: now.toISOString(),
    items: out,
    totals,
    warnings,
  };
}

export function savePlan(plan: Plan, home: string): string {
  const dir = path.join(home, 'plans');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.planId}.json`);
  const tmp = `${file}.tmp-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

export function loadPlan(planId: string, home: string): Plan {
  if (!/^plan-[A-Za-z0-9-]+$/.test(planId)) throw new Error(`invalid planId: ${planId}`);
  return JSON.parse(fs.readFileSync(path.join(home, 'plans', `${planId}.json`), 'utf8')) as Plan;
}
