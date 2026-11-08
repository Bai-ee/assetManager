/**
 * APPLY / UNDO (docs/archive/PHOTOLIB.md). Never overwrites, every created/moved/deleted file is journaled.
 * Default mode 'copy': sources (library bundles) are only ever read.
 * Mode 'move' (folder sources on the same share only, e.g. bryan/iCloud-Photos): full metadata is captured first, then
 * new files are renamed into the timeline and verified; raw copies of files already on the timeline are deleted only
 * after BOTH the timeline file and the raw file re-hash to the same sha256. Undo moves files back / restores raw copies.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { sha256File } from '../archive/hash';
import type { Plan, PlanItem, Sidecar, SidecarChild, SidecarLocation, SidecarMeta, ChildRole } from './types';
import type { MetaFile } from './metadata';
import { photolibHome } from './manifest';
import type { AssetRow, Manifest } from './manifest';

export const TIMELINE_ROOT = 'HITLOOP-ARCHIVE/timeline';
const defaultSidecarPath = (sha: string) => `${TIMELINE_ROOT}/_meta/${sha}.json`;

export interface ApplyOptions {
  manifest: Manifest;
  limit?: number;
  isCancelled?: () => boolean;
  onProgress?: (p: { done: number; total: number; bytes: number }) => void;
  hashFile?: (p: string) => Promise<string>;
  now?: () => Date;
  /** Override for layout.ts sidecarPathFor (default `HITLOOP-ARCHIVE/timeline/_meta/<sha256>.json`). */
  sidecarPathFor?: (sha256: string) => string;
  /** Exclusive lockfile path (default `${PHOTOLIB_HOME||~/.photolib}/apply.lock`); injectable for tests. */
  lockPath?: string;
  /** 'copy' (default) or 'move' (folder sources inside destRoot only; requires captureMeta). */
  mode?: 'copy' | 'move';
  /** Full-metadata capture (metadata.ts captureMetadata). Runs before any move/delete; a failure skips the item untouched. */
  captureMeta?: (f: MetaFile) => Promise<SidecarMeta>;
}

export interface ApplyResult {
  runId: string;
  copied: number;
  present: number;
  duplicate: number;
  conflict: number;
  children: number;
  bytes: number;
  errors: { relativePath: string; reason: string }[];
  cancelled?: boolean;
  /** Move mode: files renamed into the timeline. */
  moved?: number;
  /** Move mode: raw copies deleted because a verified identical file is on the timeline. */
  rawDeleted?: number;
  /** Move mode: raw files left in place (duplicate's Live Photo half, verify failure, …). */
  rawKept?: number;
  /** Files whose full metadata was captured this run. */
  metaCaptured?: number;
}

export interface UndoResult {
  runId: string;
  undone: number;
  skipped: number;
  removedAssets: number;
  errors: { destPath: string; reason: string }[];
  /** shas whose files were kept because other runs still reference them; only this run's locations were removed. */
  keptShared: string[];
  /** true when `limit` stopped the undo before every journal row was processed. */
  partial: boolean;
  /** Move-mode rows reversed: files moved back to the raw folder + deleted raw copies restored. */
  restored?: number;
}

const defaultLockPath = () => path.join(photolibHome(), 'apply.lock');

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** Exclusive apply/undo lock: O_EXCL create + pid; a lock whose pid is dead is replaced. Released in finally. */
async function withApplyLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | null = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); } catch { /* vanished or unreadable */ }
      if (Number.isFinite(pid) && pidAlive(pid)) throw new Error(`another photolib apply/undo is running (pid ${pid}); lock ${lockPath}`);
      fs.rmSync(lockPath, { force: true }); // stale (dead pid or empty/garbled)
    }
  }
  if (fd === null) throw new Error(`could not acquire photolib lock ${lockPath}`);
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

const STALE_TMP_MS = 10 * 60 * 1000;

/** Remove crashed-run `*.photolib-tmp-*` files older than 10 min from the plan's destination dirs (timeline root only). */
function sweepStaleTemps(plan: Plan, nowMs: number): void {
  const dirs = new Set<string>();
  const add = (rel: string) => { try { dirs.add(path.dirname(assertSafeDest(plan.destRoot, rel))); } catch { /* unsafe path: ignore */ } };
  for (const pi of plan.items) { add(pi.canonicalPath); for (const c of pi.children) add(c.canonicalPath); }
  add(defaultSidecarPath('x'));
  for (const d of Array.from(dirs)) {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/\.photolib-tmp-[0-9a-f]+$/.test(n)) continue;
      const p = path.join(d, n);
      try { const st = fs.statSync(p); if (st.isFile() && nowMs - st.mtimeMs > STALE_TMP_MS) fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    }
  }
}

type CopyOutcome = 'created' | 'present' | 'conflict';

function assertSafeDest(destRoot: string, rel: string): string {
  const norm = path.posix.normalize(rel);
  if (path.isAbsolute(rel) || norm.startsWith('..') || !(norm === TIMELINE_ROOT || norm.startsWith(TIMELINE_ROOT + '/'))) throw new Error(`unsafe destination path: ${rel}`);
  return path.join(destRoot, norm);
}

const exists = (p: string) => { try { fs.statSync(p); return true; } catch { return false; } };
const fileSize = (p: string): number | null => { try { const s = fs.statSync(p); return s.isFile() ? s.size : null; } catch { return null; } };
const rand = () => crypto.randomBytes(4).toString('hex');
const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();

/**
 * Streamed exclusive copy. Avoids copyfile(3), which on macOS attempts a server-side copy on SMB shares
 * and makes the NAS drop the mount for large files. 'wx' keeps COPYFILE_EXCL semantics. Caller cleans up dest.
 */
export async function streamCopyExclusive(src: string, dest: string): Promise<void> {
  const size = fs.statSync(src).size;
  const stage = stagePathFor(size);
  if (!stage) {
    await streamPlain(src, dest);
    return;
  }
  try {
    // Large files: the NAS drops the share when it reads and writes a big file at once, so do the two legs separately.
    await streamPlain(src, stage);
    await streamPlain(stage, dest);
  } finally {
    fs.rmSync(stage, { force: true });
  }
}

const streamPlain = (from: string, to: string) =>
  pipeline(fs.createReadStream(from, { highWaterMark: 8 * 1024 * 1024 }), fs.createWriteStream(to, { flags: 'wx' }));

/** Local stage file path for a copy of `size` bytes, or null when staging is off, not needed, or the disk is too full. */
function stagePathFor(size: number): string | null {
  if (process.env.PHOTOLIB_NO_STAGE === '1') return null;
  const envMin = process.env.PHOTOLIB_STAGE_MIN_BYTES;
  const min = envMin != null && envMin !== '' && Number.isFinite(Number(envMin)) ? Number(envMin) : 100 * 1024 * 1024;
  if (size < min) return null;
  const dir = path.join(photolibHome(), 'stage');
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statfsSync(dir);
  if (st.bavail * st.bsize < size + 2 * 1024 ** 3) {
    console.warn('photolib: not enough local disk to stage, copying directly');
    return null;
  }
  return path.join(dir, `${rand()}.part`);
}

/** Copy src -> dest through a verified temp file. Never overwrites dest. */
async function copyVerified(src: string, dest: string, sha: string, hashFile: (p: string) => Promise<string>): Promise<CopyOutcome> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.photolib-tmp-${rand()}`;
  try {
    await streamCopyExclusive(src, tmp);
    const srcSize = fs.statSync(src).size;
    if (fs.statSync(tmp).size !== srcSize) throw new Error('copy size mismatch');
    if ((await hashFile(tmp)) !== sha) throw new Error('copy sha256 mismatch (source changed since plan?)');
    if (exists(dest)) return (await hashFile(dest)) === sha ? 'present' : 'conflict';
    try {
      fs.linkSync(tmp, dest); // atomic, fails with EEXIST instead of overwriting
    } catch (e: any) {
      if (e?.code === 'EEXIST') return (await hashFile(dest)) === sha ? 'present' : 'conflict';
      if (exists(dest)) return (await hashFile(dest)) === sha ? 'present' : 'conflict';
      fs.renameSync(tmp, dest); // filesystem without hard links (SMB); dest verified absent just above
      return 'created';
    }
    return 'created';
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Same-share rename src -> dest, then verify dest size + sha. Never overwrites (dest checked first; single writer under
 * the apply lock). A failed verify renames the file back. Cross-device renames fail (EXDEV) instead of copying.
 */
async function moveVerified(src: string, dest: string, sha: string, size: number, hashFile: (p: string) => Promise<string>): Promise<CopyOutcome> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (exists(dest)) return fileSize(dest) === size && (await hashFile(dest)) === sha ? 'present' : 'conflict';
  if (fileSize(src) !== size) throw new Error('source size changed since plan');
  fs.renameSync(src, dest);
  if (fileSize(dest) !== size || (await hashFile(dest)) !== sha) {
    if (!exists(src)) fs.renameSync(dest, src);
    throw new Error('moved file failed sha256 verify; moved back');
  }
  return 'created';
}

/**
 * Delete a raw duplicate only after the kept timeline file AND the raw file both re-hash to sha. Returns false (raw kept)
 * when anything does not check out.
 */
async function deleteVerifiedRaw(rawAbs: string, keptAbs: string, sha: string, size: number, hashFile: (p: string) => Promise<string>): Promise<boolean> {
  if (path.resolve(rawAbs) === path.resolve(keptAbs)) return false;
  if (fileSize(keptAbs) !== size || fileSize(rawAbs) !== size) return false;
  if ((await hashFile(keptAbs)) !== sha) return false;
  if ((await hashFile(rawAbs)) !== sha) return false;
  fs.unlinkSync(rawAbs);
  return true;
}

function mergeMeta(a: SidecarMeta | undefined, b: SidecarMeta | undefined): SidecarMeta | undefined {
  if (!a) return b;
  if (!b) return a;
  const children: SidecarMeta['children'] = { ...(b.children ?? {}) };
  for (const [role, c] of Object.entries(a.children ?? {})) {
    const o = children[role as ChildRole];
    if (c) children[role as ChildRole] = o ? { exif: c.exif ?? o.exif, xmp: union(c.xmp, o.xmp) } : c;
  }
  const out: SidecarMeta = { exif: a.exif ?? b.exif, xmp: union(a.xmp, b.xmp), library: union(a.library, b.library) };
  if (Object.keys(children).length) out.children = children;
  return out;
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.photolib-tmp-${rand()}`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

function readSidecar(file: string): Sidecar | null {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s?.schema === 'photolib.sidecar/1' ? (s as Sidecar) : null; } catch { return null; }
}

const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));

function buildSidecar(plan: Plan, pi: PlanItem, nowIso: string): Sidecar {
  const it = pi.item;
  const children: Partial<Record<ChildRole, SidecarChild>> = {};
  for (const c of pi.children) {
    children[c.role] = { sha256: c.sha256, ext: extOf(c.canonicalPath), sizeBytes: c.file.sizeBytes, durationSec: c.durationSec ?? null, canonicalPath: c.canonicalPath, sourceRelativePath: c.file.relativePath };
  }
  return {
    schema: 'photolib.sidecar/1', sha256: pi.sha256, id: pi.sha256.slice(0, 16), kind: it.kind, ext: extOf(pi.canonicalPath), sizeBytes: it.sizeBytes,
    width: it.width, height: it.height, durationSec: it.durationSec,
    takenLocal: pi.date.takenLocal, tz: pi.date.tz, tzOffsetSec: pi.date.tzOffsetSec, tsUtc: pi.date.tsUtc, tsSource: pi.date.tsSource, tsKind: pi.date.tsKind,
    gps: it.lat != null && it.lon != null ? { lat: it.lat, lon: it.lon } : null,
    canonicalPath: pi.canonicalPath, albums: it.albums.slice(), favorite: it.favorite, hidden: it.hidden,
    title: it.title, description: it.description, keywords: it.keywords.slice(), camera: pi.camera ?? null, children,
    locations: [locationOf(plan, pi)], createdAt: nowIso, updatedAt: nowIso,
  };
}

function locationOf(plan: Plan, pi: PlanItem): SidecarLocation {
  return { sourceId: plan.sourceId, libraryKind: plan.libraryKind, libraryPath: plan.libraryPath, relativePath: pi.item.relativePath,
    masterUuid: pi.item.masterUuid, versionUuid: pi.item.versionUuid, originalFileName: pi.item.originalFileName };
}

/** Existing sidecar wins for identity/date/path; locations, albums, children are unioned; createdAt kept. */
function mergeSidecar(old: Sidecar, inc: Sidecar): Sidecar {
  const locs = old.locations.slice();
  for (const l of inc.locations) if (!locs.some(x => x.sourceId === l.sourceId && x.relativePath === l.relativePath)) locs.push(l);
  return {
    ...old,
    albums: union(old.albums, inc.albums), keywords: union(old.keywords, inc.keywords),
    favorite: old.favorite || inc.favorite, hidden: old.hidden || inc.hidden,
    title: old.title ?? inc.title, description: old.description ?? inc.description,
    camera: old.camera ?? inc.camera, gps: old.gps ?? inc.gps,
    children: { ...inc.children, ...old.children },
    locations: locs, createdAt: old.createdAt,
    ...(old.meta || inc.meta ? { meta: mergeMeta(old.meta, inc.meta) } : {}),
  };
}

function assetRowFrom(sc: Sidecar, sidecarPath: string, prev: AssetRow | undefined, nowIso: string): AssetRow {
  return {
    sha256: sc.sha256, id: sc.id, kind: sc.kind, ext: sc.ext, sizeBytes: sc.sizeBytes, width: sc.width, height: sc.height, durationSec: sc.durationSec,
    takenLocal: sc.takenLocal, tz: sc.tz, tzOffsetSec: sc.tzOffsetSec, tsUtc: sc.tsUtc, tsSource: sc.tsSource, tsKind: sc.tsKind,
    lat: sc.gps?.lat ?? null, lon: sc.gps?.lon ?? null, canonicalPath: sc.canonicalPath, sidecarPath, sidecarJson: JSON.stringify(sc),
    copiedAt: prev?.copiedAt ?? nowIso, verifiedAt: nowIso, thumbS: prev?.thumbS ?? null, thumbM: prev?.thumbM ?? null,
    pushedAt: prev?.pushedAt ?? null, pushHash: prev?.pushHash ?? null, updatedAt: prev && prev.sidecarJson === JSON.stringify(sc) ? prev.updatedAt : nowIso,
  };
}

export function newRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
}

export function applyPlan(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  return withApplyLock(opts.lockPath ?? defaultLockPath(), () => applyPlanLocked(plan, opts));
}

async function applyPlanLocked(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const { manifest } = opts;
  const hashFile = opts.hashFile ?? sha256File;
  const now = opts.now ?? (() => new Date());
  const sidecarPathFor = opts.sidecarPathFor ?? defaultSidecarPath;
  const runId = newRunId(now());
  const res: ApplyResult = { runId, copied: 0, present: 0, duplicate: 0, conflict: 0, children: 0, bytes: 0, errors: [] };
  const move = opts.mode === 'move';
  if (move) {
    if (plan.libraryKind !== 'folder') throw new Error('move mode is only allowed for folder sources (never library bundles)');
    if (!opts.captureMeta) throw new Error('move mode requires metadata capture (captureMeta)');
    if (!plan.libraryPath || plan.libraryPath.startsWith('..') || path.isAbsolute(plan.libraryPath)) throw new Error('move mode: source folder must be inside destRoot');
    if (plan.libraryPath === TIMELINE_ROOT || plan.libraryPath.startsWith('HITLOOP-ARCHIVE')) throw new Error('move mode: source folder must not be inside HITLOOP-ARCHIVE');
    Object.assign(res, { moved: 0, rawDeleted: 0, rawKept: 0 });
  }
  if (opts.captureMeta) res.metaCaptured = 0;
  /** Share-relative path of a source file (folder sources live inside destRoot). */
  const srcRel = (relSrc: string) => path.posix.join(plan.libraryPath, relSrc);

  manifest.upsertSource({ id: plan.sourceId, kind: plan.libraryKind, libraryPath: plan.libraryPath, label: null, addedAt: now().toISOString() });
  manifest.startRun({
    runId, sourceId: plan.sourceId, command: 'apply', startedAt: now().toISOString(),
    summary: { planId: plan.planId, locations: plan.items.map(pi => `${plan.sourceId}\u0000${pi.item.relativePath}`) },
  });

  const items = opts.limit && opts.limit > 0 ? plan.items.slice(0, opts.limit) : plan.items;
  let done = 0;
  const journal = (sha256: string, role: string, destPath: string, sizeBytes: number, srcPath?: string) =>
    manifest.journal({ runId, sha256, role, destPath, sizeBytes, at: now().toISOString(), srcPath: srcPath ?? null });

  try {
    sweepStaleTemps(plan, now().getTime());
    for (const pi of items) {
      if (opts.isCancelled?.()) { res.cancelled = true; break; }
      const rel = pi.item.relativePath;
      try {
        await applyItem(pi, rel);
      } catch (e) {
        res.errors.push({ relativePath: rel, reason: (e as Error).message });
      }
      done++;
      opts.onProgress?.({ done, total: items.length, bytes: res.bytes });
    }
  } catch (e) {
    manifest.finishRun(runId, 'failed', { planId: plan.planId, locations: plan.items.map(pi => `${plan.sourceId}\u0000${pi.item.relativePath}`), error: (e as Error).message, copied: res.copied, present: res.present, duplicate: res.duplicate, conflict: res.conflict, children: res.children, bytes: res.bytes, errors: res.errors.length });
    throw e;
  }

  async function applyItem(pi: PlanItem, relSrc: string): Promise<void> {
    if (pi.action === 'conflict') {
      res.conflict++; res.errors.push({ relativePath: relSrc, reason: `conflict: ${pi.canonicalPath} holds a different file` }); return;
    }
    const nowIso = now().toISOString();
    const sidecarRel = sidecarPathFor(pi.sha256);
    const sidecarAbs = assertSafeDest(plan.destRoot, sidecarRel);
    const incoming = buildSidecar(plan, pi, nowIso);
    const prev = manifest.getAsset(pi.sha256);

    // ---- full metadata first: nothing is moved or deleted unless its metadata is saved ----
    if (opts.captureMeta) {
      const meta = await opts.captureMeta({ sha256: pi.sha256, absPath: pi.item.absPath, relativePath: relSrc, sizeBytes: pi.item.sizeBytes });
      const kids: NonNullable<SidecarMeta['children']> = {};
      for (const c of pi.children) {
        const cm = await opts.captureMeta({ sha256: c.sha256, absPath: c.file.absPath, relativePath: c.file.relativePath, sizeBytes: c.file.sizeBytes });
        kids[c.role] = { exif: cm.exif, xmp: cm.xmp };
      }
      incoming.meta = Object.keys(kids).length ? { ...meta, children: kids } : meta;
      res.metaCaptured = (res.metaCaptured ?? 0) + 1 + pi.children.length;
    }

    if (pi.action === 'duplicate') {
      const prevPath = prev ? assertSafeDest(plan.destRoot, prev.canonicalPath) : null;
      if (!prev || fileSize(prevPath!) !== prev.sizeBytes) throw new Error('duplicate target not present (its first copy did not complete)');
      const old = readSidecar(path.join(plan.destRoot, prev.sidecarPath)) ?? (JSON.parse(prev.sidecarJson) as Sidecar);
      incoming.children = {};
      await persistSidecar(old, incoming, prev.sidecarPath, prev, false);
      res.duplicate++;
      if (move) await dropRaw(pi.item.absPath, relSrc, prevPath!, prev.canonicalPath, pi.sha256, pi.item.sizeBytes);
      if (move && (pi.item.motion || pi.item.edited)) res.rawKept! += (pi.item.motion ? 1 : 0) + (pi.item.edited ? 1 : 0); // duplicate's children are not planned
      return;
    }

    // ---- primary ----
    const destRel = pi.canonicalPath;
    const destAbs = assertSafeDest(plan.destRoot, destRel);
    let outcome: CopyOutcome;
    const sz = fileSize(destAbs);
    if (sz !== null) {
      if (sz !== pi.item.sizeBytes) outcome = 'conflict';
      else if (prev?.verifiedAt && prev.canonicalPath === destRel && prev.sizeBytes === sz) outcome = 'present'; // resumable fast path
      else outcome = (await hashFile(destAbs)) === pi.sha256 ? 'present' : 'conflict';
    } else if (move) {
      outcome = await moveVerified(pi.item.absPath, destAbs, pi.sha256, pi.item.sizeBytes, hashFile);
      if (outcome === 'created') { journal(pi.sha256, 'primary', destRel, pi.item.sizeBytes, srcRel(relSrc)); res.copied++; res.moved!++; res.bytes += pi.item.sizeBytes; }
    } else {
      outcome = await copyVerified(pi.item.absPath, destAbs, pi.sha256, hashFile);
      if (outcome === 'created') { journal(pi.sha256, 'primary', destRel, pi.item.sizeBytes); res.copied++; res.bytes += pi.item.sizeBytes; }
    }
    if (outcome === 'conflict') { res.conflict++; res.errors.push({ relativePath: relSrc, reason: `conflict: ${destRel} holds a different file` }); return; }
    if (outcome === 'present') {
      res.present++;
      if (move) await dropRaw(pi.item.absPath, relSrc, destAbs, destRel, pi.sha256, pi.item.sizeBytes);
    }

    // ---- children ----
    const ok: PlanItem['children'] = [];
    for (const c of pi.children) {
      try {
        const cAbs = assertSafeDest(plan.destRoot, c.canonicalPath);
        const csz = fileSize(cAbs);
        let co: CopyOutcome;
        if (csz !== null) co = csz === c.file.sizeBytes && (await hashFile(cAbs)) === c.sha256 ? 'present' : 'conflict';
        else co = move ? await moveVerified(c.file.absPath, cAbs, c.sha256, c.file.sizeBytes, hashFile) : await copyVerified(c.file.absPath, cAbs, c.sha256, hashFile);
        if (co === 'created') { journal(c.sha256, c.role, c.canonicalPath, c.file.sizeBytes, move ? srcRel(c.file.relativePath) : undefined); res.children++; res.bytes += c.file.sizeBytes; if (move) res.moved!++; }
        if (co === 'conflict') { if (move) res.rawKept!++; res.errors.push({ relativePath: c.file.relativePath, reason: `conflict: ${c.canonicalPath} holds a different file` }); continue; }
        if (co === 'present' && move) await dropRaw(c.file.absPath, c.file.relativePath, cAbs, c.canonicalPath, c.sha256, c.file.sizeBytes);
        ok.push(c);
        manifest.upsertChild({ parentSha: pi.sha256, role: c.role, sha256: c.sha256, ext: extOf(c.canonicalPath), sizeBytes: c.file.sizeBytes, durationSec: c.durationSec ?? null, canonicalPath: c.canonicalPath, copiedAt: nowIso });
      } catch (e) {
        res.errors.push({ relativePath: c.file.relativePath, reason: (e as Error).message });
      }
    }
    incoming.children = Object.fromEntries(Object.entries(incoming.children).filter(([role]) => ok.some(c => c.role === role)));

    const old = readSidecar(sidecarAbs);
    await persistSidecar(old, incoming, sidecarRel, prev, true);
  }

  /** Move mode: delete a raw duplicate after double verification, journaled so undo can restore it from the kept copy. */
  async function dropRaw(rawAbs: string, relSrc: string, keptAbs: string, keptRel: string, sha: string, size: number): Promise<void> {
    if (await deleteVerifiedRaw(rawAbs, keptAbs, sha, size, hashFile)) {
      journal(sha, 'raw-deleted', keptRel, size, srcRel(relSrc));
      res.rawDeleted!++;
    } else {
      res.rawKept!++;
      res.errors.push({ relativePath: relSrc, reason: 'raw duplicate kept: verify did not match' });
    }
  }

  /** Merge + write the sidecar (only when content changes), journal it if newly created, then upsert manifest rows. */
  async function persistSidecar(old: Sidecar | null, incoming: Sidecar, sidecarRel: string, prev: AssetRow | undefined, _primary: boolean): Promise<void> {
    const abs = assertSafeDest(plan.destRoot, sidecarRel);
    const nowIso = now().toISOString();
    let final: Sidecar;
    if (!old) {
      final = incoming;
    } else {
      const merged = mergeSidecar(old, incoming);
      final = JSON.stringify(merged) === JSON.stringify(old) ? old : { ...merged, updatedAt: nowIso };
    }
    const created = !exists(abs);
    if (created || final !== old) {
      writeJsonAtomic(abs, final);
      if (created) journal(final.sha256, 'sidecar', sidecarRel, fs.statSync(abs).size);
    }
    manifest.upsertAsset(assetRowFrom(final, sidecarRel, prev, nowIso));
    const loc = final.locations.find(l => l.sourceId === plan.sourceId && l.relativePath === incoming.locations[0].relativePath) ?? incoming.locations[0];
    manifest.putLocation({ sourceId: loc.sourceId, relativePath: loc.relativePath, sha256: final.sha256, masterUuid: loc.masterUuid, versionUuid: loc.versionUuid, originalFileName: loc.originalFileName });
    for (const c of Object.values(final.children)) {
      if (!c) continue;
      manifest.putLocation({ sourceId: plan.sourceId, relativePath: c.sourceRelativePath, sha256: c.sha256, masterUuid: null, versionUuid: null, originalFileName: path.basename(c.sourceRelativePath) });
    }
  }

  manifest.finishRun(runId, res.cancelled ? 'cancelled' : res.errors.length ? 'completed-with-errors' : 'completed', {
    planId: plan.planId,
    locations: plan.items.map(pi => `${plan.sourceId}\u0000${pi.item.relativePath}`),
    copied: res.copied, present: res.present, duplicate: res.duplicate, conflict: res.conflict, children: res.children, bytes: res.bytes, errors: res.errors.length,
    ...(move ? { mode: 'move', moved: res.moved, rawDeleted: res.rawDeleted, rawKept: res.rawKept } : {}), metaCaptured: res.metaCaptured,
  });
  return res;
}

export interface UndoOptions { manifest: Manifest; destRoot: string; limit?: number; hashFile?: (p: string) => Promise<string>; lockPath?: string }

export function undoRun(runId: string, opts: UndoOptions): Promise<UndoResult> {
  return withApplyLock(opts.lockPath ?? defaultLockPath(), () => undoRunLocked(runId, opts));
}

async function undoRunLocked(runId: string, opts: UndoOptions): Promise<UndoResult> {
  const { manifest, destRoot } = opts;
  const hashFile = opts.hashFile ?? sha256File;
  const res: UndoResult = { runId, undone: 0, skipped: 0, removedAssets: 0, errors: [], keptShared: [], partial: false, restored: 0 };
  /** Absolute raw-folder path of a move-mode row; never inside the timeline. */
  const rawAbsOf = (srcPath: string): string => {
    const norm = path.posix.normalize(srcPath);
    if (path.isAbsolute(srcPath) || norm.startsWith('..') || norm.startsWith('HITLOOP-ARCHIVE')) throw new Error(`unsafe source path: ${srcPath}`);
    return path.join(destRoot, norm);
  };
  /** Put a verified copy of keptAbs back at the raw path (used for deleted raw duplicates and shared moved files). */
  const restoreCopy = async (keptAbs: string, rawAbs: string, sha: string): Promise<void> => {
    if (exists(rawAbs)) return; // already back
    if ((await hashFile(keptAbs)) !== sha) throw new Error('kept file no longer matches; raw copy not restored');
    fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
    const tmp = `${rawAbs}.photolib-tmp-${rand()}`;
    try {
      await streamCopyExclusive(keptAbs, tmp);
      if ((await hashFile(tmp)) !== sha) throw new Error('restored copy sha256 mismatch');
      if (exists(rawAbs)) return;
      fs.renameSync(tmp, rawAbs);
    } finally { fs.rmSync(tmp, { force: true }); }
  };
  const run = manifest.getRun(runId);
  let runLocs: Set<string> | null = null;
  try { const s = JSON.parse(run?.summaryJson ?? 'null'); if (Array.isArray(s?.locations)) runLocs = new Set<string>(s.locations); } catch { /* unknown */ }

  const rows = manifest.journalForRun(runId).filter(r => !r.undoneAt).reverse();
  const touchedDirs = new Set<string>();
  const sharedShas = new Set<string>();
  const keepPaths = new Set<string>(); // share-relative child paths belonging to a shared asset
  const decided = new Map<string, boolean>();
  const locKey = (l: { sourceId: string; relativePath: string }) => `${l.sourceId}\u0000${l.relativePath}`;

  /**
   * An asset is shared when its sidecar/manifest lists locations from outside this run. Then NONE of its files are removed:
   * only this run's location rows (manifest + sidecar) go away.
   */
  function sharedFor(sha: string, sidecarRel: string): boolean {
    const known = decided.get(sha);
    if (known !== undefined) return known;
    let shared = false;
    if (runLocs) {
      const asset = manifest.getAsset(sha);
      const rel = asset?.sidecarPath ?? sidecarRel;
      let abs: string | null = null;
      try { abs = assertSafeDest(destRoot, rel); } catch { /* ignore */ }
      const sc = abs ? readSidecar(abs) : null;
      const others = (sc?.locations ?? []).some(l => !runLocs!.has(locKey(l))) || manifest.listLocations(sha).some(l => !runLocs!.has(locKey(l)));
      if (others && (!sc || sc.sha256 === sha)) {
        shared = true;
        if (sc && abs) {
          const kept: Sidecar = { ...sc, locations: sc.locations.filter(l => !runLocs!.has(locKey(l))), updatedAt: new Date().toISOString() };
          writeJsonAtomic(abs, kept);
          if (asset) manifest.upsertAsset({ ...asset, sidecarJson: JSON.stringify(kept), updatedAt: kept.updatedAt });
        }
        for (const l of manifest.listLocations(sha)) if (runLocs.has(locKey(l))) manifest.deleteLocation(l.sourceId, l.relativePath);
        for (const c of manifest.listChildren(sha)) keepPaths.add(c.canonicalPath);
        if (sc) for (const c of Object.values(sc.children)) if (c) keepPaths.add(c.canonicalPath);
        sharedShas.add(sha);
        res.keptShared.push(sha);
        res.errors.push({ destPath: rel, reason: 'kept-shared: other runs still reference this asset; only this run\'s locations were removed' });
      }
    }
    decided.set(sha, shared);
    return shared;
  }

  let processed = 0;
  for (const row of rows) {
    if (opts.limit && opts.limit > 0 && processed >= opts.limit) { res.partial = true; break; }
    processed++;
    if (row.role === 'raw-deleted') {
      try {
        await restoreCopy(assertSafeDest(destRoot, row.destPath), rawAbsOf(row.srcPath!), row.sha256);
        manifest.markUndone(row.id); res.restored!++;
      } catch (e) { res.skipped++; res.errors.push({ destPath: row.srcPath!, reason: (e as Error).message }); }
      continue;
    }
    if (row.role === 'primary' || row.role === 'sidecar') sharedFor(row.sha256, row.role === 'sidecar' ? row.destPath : defaultSidecarPath(row.sha256));
    if (((row.role === 'primary' || row.role === 'sidecar') && sharedShas.has(row.sha256)) || keepPaths.has(row.destPath)) {
      if (row.srcPath) { // moved file that other runs also reference: keep it, put a copy back in the raw folder
        try { await restoreCopy(assertSafeDest(destRoot, row.destPath), rawAbsOf(row.srcPath), row.sha256); res.restored!++; }
        catch (e) { res.skipped++; res.errors.push({ destPath: row.srcPath, reason: (e as Error).message }); continue; }
      }
      manifest.markUndone(row.id); // handled: file intentionally kept
      continue;
    }
    let abs: string;
    try { abs = assertSafeDest(destRoot, row.destPath); } catch (e) { res.errors.push({ destPath: row.destPath, reason: (e as Error).message }); res.skipped++; continue; }
    const size = fileSize(abs);
    if (size === null) { manifest.markUndone(row.id); res.undone++; afterUndo(row); continue; } // already gone
    try {
      if (row.role === 'sidecar') {
        const sc = readSidecar(abs);
        const ownedOnly = !!sc && !!runLocs && sc.locations.every(l => runLocs!.has(`${l.sourceId}\u0000${l.relativePath}`));
        if (!sc || sc.sha256 !== row.sha256 || !ownedOnly) { res.skipped++; res.errors.push({ destPath: row.destPath, reason: 'sidecar left in place (modified or has locations from other runs)' }); continue; }
      } else if (size !== row.sizeBytes || (await hashFile(abs)) !== row.sha256) {
        res.skipped++; res.errors.push({ destPath: row.destPath, reason: 'file changed since the run; left in place' }); continue;
      }
      if (row.srcPath) {
        const rawAbs = rawAbsOf(row.srcPath);
        if (exists(rawAbs)) { res.skipped++; res.errors.push({ destPath: row.destPath, reason: 'raw path is occupied; moved file left on the timeline' }); continue; }
        fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
        fs.renameSync(abs, rawAbs); // move back (same share)
        res.restored!++;
      } else fs.unlinkSync(abs);
      touchedDirs.add(path.dirname(abs));
      manifest.markUndone(row.id);
      res.undone++;
      afterUndo(row);
    } catch (e) {
      res.skipped++; res.errors.push({ destPath: row.destPath, reason: (e as Error).message });
    }
  }

  function afterUndo(row: { role: string; sha256: string }): void {
    if (row.role === 'primary') { manifest.deleteAsset(row.sha256); res.removedAssets++; }
    else if (row.role === 'motion' || row.role === 'edited') manifest.deleteChildFile(row.sha256, row.role);
  }

  // Remove now-empty directories bottom-up, never the timeline root or above.
  const rootAbs = path.join(destRoot, TIMELINE_ROOT);
  for (const start of Array.from(touchedDirs)) {
    let d = start;
    while (d.startsWith(rootAbs + path.sep)) {
      try { fs.rmdirSync(d); } catch { break; } // non-empty or missing: stop
      d = path.dirname(d);
    }
  }
  return res;
}
