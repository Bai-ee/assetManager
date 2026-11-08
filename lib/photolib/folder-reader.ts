/**
 * Folder source: walk a plain directory tree and return every real photo/video that carries capture-date
 * metadata, as a ReadLibraryResult (kind 'folder') that plan.ts consumes like a library read.
 * READ-ONLY on the folder. Never uses file mtime/birthtime — undated files are skipped and counted.
 * See docs/archive/PHOTOLIB.md "Folder source".
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isLibraryBundle } from '../archive/media-type';
import type { ChildFile, ExifInfo, LibraryItem, MediaKind, ReadLibraryResult, ResolvedDate } from './types';

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'heic', 'heif', 'png', 'gif', 'tif', 'tiff', 'cr2', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2']);
export const VIDEO_EXTS = new Set(['mov', 'mp4', 'm4v', 'avi', '3gp', 'mts']);
export const MIN_BYTES = 10 * 1024;
const EXIF_BATCH = 500;
const SCAN_LOG_EVERY = 1000;
const MAX_WARNED_EXAMPLES = 10;
const SKIP_DIR_NAMES = new Set(['hitloop-archive', '.trashes', '.spotlight-v100', '$recycle.bin']);

export interface FolderReadOptions {
  sourceId: string;
  readExifBatch: (paths: string[], opts?: { concurrency?: number }) => Promise<Map<string, ExifInfo | null>>;
  resolveTakenDate: (item: Pick<LibraryItem, 'imageDateUtc' | 'tzOffsetSec'>, exif: ExifInfo | null) => ResolvedDate;
  log?: (msg: string) => void;
  minBytes?: number;
  batchSize?: number;
  /** Owner rule for loose folders: keep only files whose EXIF names a phone/camera (not a Mac). Default: env PHOTOLIB_CAMERA_ONLY=1. */
  cameraOnly?: boolean;
}

/** True when the EXIF camera model is a capture device (phone/camera), not a Mac (screen recordings, exports). */
export function isCameraModel(model: string | null | undefined): boolean {
  return !!model && !/^Mac|iMac/i.test(model);
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Names the walker never enters or lists (hidden, AppleDouble, bundles, system dirs, the archive itself). */
export function isSkippedName(name: string): boolean {
  if (name.startsWith('.')) return true; // hidden, ._AppleDouble, .Trashes, .Spotlight-V100
  const lower = name.toLowerCase();
  if (SKIP_DIR_NAMES.has(lower)) return true;
  return /\.(backupbundle|sparsebundle)$/i.test(name) || isLibraryBundle(name);
}

interface Candidate { abs: string; rel: string; ext: string; size: number; kind: MediaKind }

export async function readFolder(root: string, opts: FolderReadOptions): Promise<ReadLibraryResult> {
  const warnings: ReadLibraryResult['warnings'] = [];
  const log = opts.log ?? (() => undefined);
  const minBytes = opts.minBytes ?? MIN_BYTES;
  const batchSize = opts.batchSize ?? EXIF_BATCH;
  const cameraOnly = opts.cameraOnly ?? process.env.PHOTOLIB_CAMERA_ONLY === '1';
  let skippedNotCamera = 0;

  // 1. Walk (explicit stack; tolerate per-directory errors).
  const candidates: Candidate[] = [];
  let scanned = 0, tooSmall = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { warnings.push({ relativePath: toPosix(path.relative(root, dir)), reason: `cannot read directory: ${(e as Error).message}` }); continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const ent of entries) {
      if (isSkippedName(ent.name) || ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { subdirs.push(abs); continue; }
      if (!ent.isFile()) continue;
      scanned++;
      if (scanned % SCAN_LOG_EVERY === 0) log(`  scan ${scanned} files, ${candidates.length} candidates`);
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      const kind: MediaKind | null = IMAGE_EXTS.has(ext) ? 'image' : VIDEO_EXTS.has(ext) ? 'video' : null;
      if (!kind) continue;
      let size: number;
      try { size = (await fs.promises.stat(abs)).size; }
      catch (e) { warnings.push({ relativePath: toPosix(path.relative(root, abs)), reason: `stat failed: ${(e as Error).message}` }); continue; }
      if (size < minBytes) { tooSmall++; continue; }
      candidates.push({ abs, rel: toPosix(path.relative(root, abs)), ext, size, kind });
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]); // pop in name order
  }
  log(`  scan done: ${scanned} files, ${candidates.length} candidates, ${tooSmall} under ${minBytes} bytes`);

  // 2. EXIF headers first (bounded batches), then date filter.
  const dated = new Map<string, { exif: ExifInfo | null; date: ResolvedDate }>();
  const all = new Map<string, { exif: ExifInfo | null; date: ResolvedDate }>();
  for (let i = 0; i < candidates.length; i += batchSize) {
    const slice = candidates.slice(i, i + batchSize);
    const m = await opts.readExifBatch(slice.map(c => c.abs));
    for (const c of slice) {
      const exif = m.get(c.abs) ?? null;
      const date = opts.resolveTakenDate({ imageDateUtc: null, tzOffsetSec: null }, exif);
      all.set(c.abs, { exif, date });
      if (date.tsKind === 'unknown') continue;
      if (cameraOnly && !isCameraModel(exif?.model)) { skippedNotCamera++; continue; }
      dated.set(c.abs, { exif, date });
    }
    log(`  exif ${Math.min(i + batchSize, candidates.length)}/${candidates.length}`);
  }

  // 3. Live Photo pairing: same dir + same basename (case-insensitive) + equal non-null contentIdentifier.
  const byDirBase = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${path.dirname(c.rel)}\0${path.basename(c.rel, path.extname(c.rel)).toLowerCase()}`;
    (byDirBase.get(key) ?? byDirBase.set(key, []).get(key)!).push(c);
  }
  const motionOf = new Map<string, Candidate>(); // image abs -> video candidate
  const consumed = new Set<string>();
  for (const group of Array.from(byDirBase.values())) {
    if (group.length < 2) continue;
    for (const img of group) {
      const id = all.get(img.abs)?.exif?.contentIdentifier;
      if (img.kind !== 'image' || !id || !dated.has(img.abs)) continue;
      const vid = group.find((v: Candidate) => v.kind === 'video' && !consumed.has(v.abs) && all.get(v.abs)?.exif?.contentIdentifier === id);
      if (vid) { motionOf.set(img.abs, vid); consumed.add(vid.abs); }
    }
  }

  // 4. Build items.
  const items: LibraryItem[] = [];
  const exif = new Map<string, ExifInfo | null>();
  const unknownExamples: string[] = [];
  let skippedNoDate = 0;
  for (const c of candidates) {
    if (consumed.has(c.abs)) { exif.set(c.abs, all.get(c.abs)?.exif ?? null); continue; }
    const d = dated.get(c.abs);
    if (!d) {
      if (all.get(c.abs)?.date.tsKind !== 'unknown') continue; // dated but not a camera capture (counted above)
      skippedNoDate++;
      if (unknownExamples.length < MAX_WARNED_EXAMPLES) unknownExamples.push(c.rel);
      continue;
    }
    const e = d.exif;
    exif.set(c.abs, e);
    const mv = motionOf.get(c.abs);
    let motion: ChildFile | null = null;
    if (mv) { motion = { relativePath: mv.rel, absPath: mv.abs, sizeBytes: mv.size }; }
    items.push({
      sourceId: opts.sourceId,
      masterUuid: crypto.createHash('sha256').update(c.rel).digest('hex').slice(0, 32),
      versionUuid: null, relativePath: c.rel, absPath: c.abs, originalFileName: path.basename(c.abs), uti: null, kind: c.kind, sizeBytes: c.size,
      width: e?.width ?? null, height: e?.height ?? null, durationSec: e?.durationSec ?? null,
      imageDateUtc: null, tzOffsetSec: null, lat: e?.lat ?? null, lon: e?.lon ?? null,
      albums: [], favorite: false, hidden: false, title: null, description: null, keywords: [],
      mediaGroupId: e?.contentIdentifier ?? null, motion, edited: null,
    });
  }
  if (skippedNoDate) {
    warnings.push({ reason: `${skippedNoDate} file(s) skipped: no capture-date metadata (never falls back to file time). Examples: ${unknownExamples.join(', ')}` });
  }
  if (skippedNotCamera) warnings.push({ reason: `${skippedNotCamera} dated file(s) skipped: camera-only (no phone/camera model in EXIF)` });
  if (tooSmall) warnings.push({ reason: `${tooSmall} file(s) skipped: under ${minBytes} bytes` });
  return { kind: 'folder', libraryPath: root, items, warnings, exif, skippedNoDate };
}
