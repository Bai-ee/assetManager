/**
 * APPLY / UNDO (docs/archive/PHOTOLIB.md). Copy-only, never overwrites, every created file is journaled.
 * Sources (library bundles) are only ever read.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sha256File } from '../archive/hash';
import type { Plan, PlanItem, Sidecar, SidecarChild, SidecarLocation, ChildRole } from './types';
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
}

export interface UndoResult {
  runId: string;
  undone: number;
  skipped: number;
  removedAssets: number;
  errors: { destPath: string; reason: string }[];
  /** true when `limit` stopped the undo before every journal row was processed. */
  partial: boolean;
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

/** Copy src -> dest through a verified temp file. Never overwrites dest. */
async function copyVerified(src: string, dest: string, sha: string, hashFile: (p: string) => Promise<string>): Promise<CopyOutcome> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.photolib-tmp-${rand()}`;
  try {
    await fs.promises.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
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
    children[c.role] = { sha256: c.sha256, ext: extOf(c.canonicalPath), sizeBytes: c.file.sizeBytes, durationSec: null, canonicalPath: c.canonicalPath, sourceRelativePath: c.file.relativePath };
  }
  return {
    schema: 'photolib.sidecar/1', sha256: pi.sha256, id: pi.sha256.slice(0, 16), kind: it.kind, ext: extOf(pi.canonicalPath), sizeBytes: it.sizeBytes,
    width: it.width, height: it.height, durationSec: it.durationSec,
    takenLocal: pi.date.takenLocal, tz: pi.date.tz, tzOffsetSec: pi.date.tzOffsetSec, tsUtc: pi.date.tsUtc, tsSource: pi.date.tsSource, tsKind: pi.date.tsKind,
    gps: it.lat != null && it.lon != null ? { lat: it.lat, lon: it.lon } : null,
    canonicalPath: pi.canonicalPath, albums: it.albums.slice(), favorite: it.favorite, hidden: it.hidden,
    title: it.title, description: it.description, keywords: it.keywords.slice(), camera: null, children,
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

export async function applyPlan(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const { manifest } = opts;
  const hashFile = opts.hashFile ?? sha256File;
  const now = opts.now ?? (() => new Date());
  const sidecarPathFor = opts.sidecarPathFor ?? defaultSidecarPath;
  const runId = newRunId(now());
  const res: ApplyResult = { runId, copied: 0, present: 0, duplicate: 0, conflict: 0, children: 0, bytes: 0, errors: [] };

  manifest.upsertSource({ id: plan.sourceId, kind: plan.libraryKind, libraryPath: plan.libraryPath, label: null, addedAt: now().toISOString() });
  manifest.startRun({
    runId, sourceId: plan.sourceId, command: 'apply', startedAt: now().toISOString(),
    summary: { planId: plan.planId, locations: plan.items.map(pi => `${plan.sourceId}\u0000${pi.item.relativePath}`) },
  });

  const items = opts.limit && opts.limit > 0 ? plan.items.slice(0, opts.limit) : plan.items;
  let done = 0;
  const journal = (sha256: string, role: string, destPath: string, sizeBytes: number) =>
    manifest.journal({ runId, sha256, role, destPath, sizeBytes, at: now().toISOString() });

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

  async function applyItem(pi: PlanItem, relSrc: string): Promise<void> {
    if (pi.action === 'conflict') {
      res.conflict++; res.errors.push({ relativePath: relSrc, reason: `conflict: ${pi.canonicalPath} holds a different file` }); return;
    }
    const nowIso = now().toISOString();
    const sidecarRel = sidecarPathFor(pi.sha256);
    const sidecarAbs = assertSafeDest(plan.destRoot, sidecarRel);
    const incoming = buildSidecar(plan, pi, nowIso);
    const prev = manifest.getAsset(pi.sha256);

    if (pi.action === 'duplicate') {
      const prevPath = prev ? assertSafeDest(plan.destRoot, prev.canonicalPath) : null;
      if (!prev || fileSize(prevPath!) !== prev.sizeBytes) throw new Error('duplicate target not present (its first copy did not complete)');
      const old = readSidecar(path.join(plan.destRoot, prev.sidecarPath)) ?? (JSON.parse(prev.sidecarJson) as Sidecar);
      incoming.children = {};
      await persistSidecar(old, incoming, prev.sidecarPath, prev, false);
      res.duplicate++;
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
    } else {
      outcome = await copyVerified(pi.item.absPath, destAbs, pi.sha256, hashFile);
      if (outcome === 'created') { journal(pi.sha256, 'primary', destRel, pi.item.sizeBytes); res.copied++; res.bytes += pi.item.sizeBytes; }
    }
    if (outcome === 'conflict') { res.conflict++; res.errors.push({ relativePath: relSrc, reason: `conflict: ${destRel} holds a different file` }); return; }
    if (outcome === 'present') res.present++;

    // ---- children ----
    const ok: PlanItem['children'] = [];
    for (const c of pi.children) {
      try {
        const cAbs = assertSafeDest(plan.destRoot, c.canonicalPath);
        const csz = fileSize(cAbs);
        let co: CopyOutcome;
        if (csz !== null) co = csz === c.file.sizeBytes && (await hashFile(cAbs)) === c.sha256 ? 'present' : 'conflict';
        else co = await copyVerified(c.file.absPath, cAbs, c.sha256, hashFile);
        if (co === 'created') { journal(c.sha256, c.role, c.canonicalPath, c.file.sizeBytes); res.children++; res.bytes += c.file.sizeBytes; }
        if (co === 'conflict') { res.errors.push({ relativePath: c.file.relativePath, reason: `conflict: ${c.canonicalPath} holds a different file` }); continue; }
        ok.push(c);
        manifest.upsertChild({ parentSha: pi.sha256, role: c.role, sha256: c.sha256, ext: extOf(c.canonicalPath), sizeBytes: c.file.sizeBytes, durationSec: null, canonicalPath: c.canonicalPath, copiedAt: nowIso });
      } catch (e) {
        res.errors.push({ relativePath: c.file.relativePath, reason: (e as Error).message });
      }
    }
    incoming.children = Object.fromEntries(Object.entries(incoming.children).filter(([role]) => ok.some(c => c.role === role)));

    const old = readSidecar(sidecarAbs);
    await persistSidecar(old, incoming, sidecarRel, prev, true);
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
  });
  return res;
}

export async function undoRun(runId: string, opts: { manifest: Manifest; destRoot: string; limit?: number; hashFile?: (p: string) => Promise<string> }): Promise<UndoResult> {
  const { manifest, destRoot } = opts;
  const hashFile = opts.hashFile ?? sha256File;
  const res: UndoResult = { runId, undone: 0, skipped: 0, removedAssets: 0, errors: [], partial: false };
  const run = manifest.getRun(runId);
  let runLocs: Set<string> | null = null;
  try { const s = JSON.parse(run?.summaryJson ?? 'null'); if (Array.isArray(s?.locations)) runLocs = new Set<string>(s.locations); } catch { /* unknown */ }

  const rows = manifest.journalForRun(runId).filter(r => !r.undoneAt).reverse();
  const touchedDirs = new Set<string>();
  let processed = 0;
  for (const row of rows) {
    if (opts.limit && opts.limit > 0 && processed >= opts.limit) { res.partial = true; break; }
    processed++;
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
      fs.unlinkSync(abs);
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
