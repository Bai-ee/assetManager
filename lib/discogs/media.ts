/**
 * Media scanning, dedupe, JPEG conversion and record grouping for the Discogs ingest POC.
 *
 * Capture time:
 *   - videos: ffprobe format tag com.apple.quicktime.creationdate (has tz offset), else creation_time.
 *   - images: `sips -g creation` (reads EXIF DateTimeOriginal, local wall-clock, no tz; parsed in the
 *     machine's local zone, which matches the iPhone's zone for same-machine imports). ffprobe has no
 *     HEIC tags. null if unavailable.
 *
 * groupRecords rule (pure, deterministic):
 *   1. Drop duplicates (duplicateOf != null). Sort all by (best time = capturedAt ?? mtime, then name).
 *   2. Walk images in time order. An image starts a new group unless the previous image is <= 90 s
 *      earlier AND no video lies (in time) between the two; then it joins that group as the B side
 *      (groupedBy 'capture-time'). A group holds at most 2 images.
 *   3. Each video attaches to the nearest image (by absolute time distance) within 10 min; ties prefer
 *      the image BEFORE the video. Videos shot before the first photo of a record are therefore still
 *      attached to the nearest photo.
 *   4. Videos with no image within 10 min become their own group (groupedBy 'single', images []).
 *   5. Group id = 'g-' + first image fingerprint[0..12] (first video's if no image).
 *   6. Output sorted by the group's earliest time.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MediaFile, MediaKind, RecordGroup } from './types';

const execFileP = promisify(execFile);
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const SIPS = '/usr/bin/sips';
const CHUNK = 4 * 1024 * 1024;
const PAIR_WINDOW_MS = 90_000;
const VIDEO_WINDOW_MS = 10 * 60_000;

const IMAGE_EXT = new Set(['.heic', '.jpg', '.jpeg', '.png']);
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v']);

export async function fingerprintFile(file: string, size: number): Promise<string> {
  const h = createHash('sha256');
  h.update(`${size}:`);
  const fh = await fs.open(file, 'r');
  try {
    const len = Math.min(CHUNK, size);
    const head = Buffer.alloc(len);
    await fh.read(head, 0, len, 0);
    h.update(head);
    if (size > CHUNK) {
      const tailLen = Math.min(CHUNK, size - CHUNK);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

/** One ffprobe call: capture time + duration (seconds). */
async function probeVideo(file: string): Promise<{ capturedAt: string | null; durationS: number | null }> {
  try {
    const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', file]);
    const fmt = JSON.parse(stdout)?.format ?? {};
    const tags = fmt.tags ?? {};
    const dur = parseFloat(fmt.duration);
    const raw = tags['com.apple.quicktime.creationdate'] ?? tags['creation_time'];
    let capturedAt: string | null = null;
    if (raw) {
      const d = new Date(String(raw).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
      capturedAt = isNaN(d.getTime()) ? null : d.toISOString();
    }
    return { capturedAt, durationS: Number.isFinite(dur) ? dur : null };
  } catch {
    return { capturedAt: null, durationS: null };
  }
}

async function imageCapturedAt(file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(SIPS, ['-g', 'creation', file]);
    const m = stdout.match(/creation:\s*(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** A scanned file; videos carry their duration (from the scan index) so callers need not probe the NAS again. */
export type ScannedMedia = MediaFile & { durationS?: number | null };

interface IndexEntry { size: number; mtimeMs: number; fingerprint: string; capturedAt: string | null; durationS?: number | null }
type ScanIndex = Record<string, IndexEntry>;

/** Default location of the (path, size, mtimeMs) -> fingerprint/capture-time index. */
export const DEFAULT_INDEX_PATH = path.join(os.homedir(), '.discogs-ingest', 'index.json');

async function readIndex(file: string): Promise<ScanIndex> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as ScanIndex; } catch { return {}; }
}
async function writeIndex(file: string, idx: ScanIndex): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(idx));
  await fs.rename(tmp, file);
}

export interface ScanOptions {
  /** Index cache file. Unchanged files (same path, size, mtimeMs) skip the 8 MB read and the ffprobe/sips call. Omit for no cache. */
  indexPath?: string;
  /** Parallel per-file workers (default 4). */
  concurrency?: number;
}

/** Non-recursive scan. Marks exact duplicates (same fingerprint) pointing at the kept file. */
export async function scanFolder(dir: string, opts: ScanOptions = {}): Promise<ScannedMedia[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const index: ScanIndex = opts.indexPath ? await readIndex(opts.indexPath) : {};
  let dirty = false;
  const todo: Array<{ name: string; kind: MediaKind }> = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const ext = path.extname(e.name).toLowerCase();
    const kind: MediaKind | null = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
    if (kind) todo.push({ name: e.name, kind });
  }

  const files: ScannedMedia[] = new Array(todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = next++;
      const { name, kind } = todo[i];
      const full = path.join(dir, name);
      const st = await fs.stat(full);
      let hit: IndexEntry | undefined = index[full];
      if (hit && (hit.size !== st.size || hit.mtimeMs !== st.mtimeMs || (kind === 'video' && hit.durationS === undefined))) hit = undefined;
      if (!hit) {
        const [fingerprint, meta] = await Promise.all([
          fingerprintFile(full, st.size),
          kind === 'video' ? probeVideo(full) : imageCapturedAt(full).then(capturedAt => ({ capturedAt, durationS: undefined })),
        ]);
        hit = { size: st.size, mtimeMs: st.mtimeMs, fingerprint, capturedAt: meta.capturedAt, durationS: meta.durationS };
        index[full] = hit;
        dirty = true;
      }
      const seqMatch = name.match(/^IMG_(\d+)/i);
      files[i] = {
        path: full, name, kind, size: st.size, fingerprint: hit.fingerprint, capturedAt: hit.capturedAt,
        mtime: st.mtime.toISOString(), seq: seqMatch ? parseInt(seqMatch[1], 10) : null, duplicateOf: null,
        ...(kind === 'video' ? { durationS: hit.durationS ?? null } : {}),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, todo.length)) }, worker));
  if (opts.indexPath && dirty) await writeIndex(opts.indexPath, index);

  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Keep the shortest name (then alphabetical) per fingerprint.
  const byFp = new Map<string, MediaFile[]>();
  for (const f of files) byFp.set(f.fingerprint, [...(byFp.get(f.fingerprint) ?? []), f]);
  for (const list of byFp.values()) {
    if (list.length < 2) continue;
    const kept = [...list].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0];
    for (const f of list) if (f !== kept) f.duplicateOf = kept.path;
  }
  return files;
}

// ---- local source cache ----

export interface SourceCopyResult { path: string; cached: boolean; bytes: number; seconds: number; mbPerSec: number; via: 'cache' | 'link' | 'copy' }

/**
 * Local copy of a (slow, read-only) source file at `<srcDir>/<fingerprint><ext>`. Copied once with a streaming copy
 * (progress via `onProgress`), then reused forever. `legacyPaths` (e.g. an older work/<id>/source.mov) are hard-linked
 * instead of re-copied when their size and fingerprint match. Every later step reads this local file only.
 */
export async function ensureLocalSource(
  file: Pick<MediaFile, 'path' | 'name' | 'size' | 'fingerprint'>, srcDir: string,
  opts: { legacyPaths?: string[]; onProgress?: (copied: number, total: number, mbPerSec: number) => void } = {},
): Promise<SourceCopyResult> {
  await fs.mkdir(srcDir, { recursive: true });
  const dest = path.join(srcDir, file.fingerprint + path.extname(file.name).toLowerCase());
  const t0 = Date.now();
  const done = (via: SourceCopyResult['via'], cached: boolean): SourceCopyResult => {
    const seconds = (Date.now() - t0) / 1000;
    return { path: dest, cached, bytes: file.size, seconds, mbPerSec: cached ? 0 : file.size / 1048576 / Math.max(seconds, 0.001), via };
  };
  try {
    if ((await fs.stat(dest)).size === file.size) return done('cache', true);
  } catch { /* not cached yet */ }

  for (const legacy of opts.legacyPaths ?? []) {
    try {
      if ((await fs.stat(legacy)).size !== file.size) continue;
      if ((await fingerprintFile(legacy, file.size)) !== file.fingerprint) continue;
      await fs.link(legacy, dest).catch(async () => { await fs.copyFile(legacy, dest); });
      return done('link', true);
    } catch { /* try the next one */ }
  }

  const tmp = `${dest}.part`;
  let copied = 0;
  let lastReport = 0;
  const rs = createReadStream(file.path, { highWaterMark: 4 * 1024 * 1024 });
  rs.on('data', (chunk) => {
    copied += chunk.length;
    const now = Date.now();
    if (opts.onProgress && now - lastReport >= 1000) {
      lastReport = now;
      opts.onProgress(copied, file.size, copied / 1048576 / Math.max((now - t0) / 1000, 0.001));
    }
  });
  await pipeline(rs, createWriteStream(tmp));
  await fs.rename(tmp, dest);
  return done('copy', false);
}

/** HEIC -> JPEG via sips, cached by fingerprint. Returns the jpeg path. */
export async function toJpeg(file: MediaFile, cacheDir: string, maxPx = 1600): Promise<string> {
  if (file.kind !== 'image') throw new Error(`toJpeg: not an image: ${file.name}`);
  await fs.mkdir(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${file.fingerprint}.jpg`);
  try {
    await fs.access(out);
    return out;
  } catch {
    /* not cached */
  }
  const tmp = `${out}.tmp.jpg`;
  await execFileP(SIPS, ['-s', 'format', 'jpeg', '-Z', String(maxPx), file.path, '--out', tmp]);
  await fs.rename(tmp, out);
  return out;
}

export function bestTime(f: MediaFile): number {
  return new Date(f.capturedAt ?? f.mtime).getTime();
}

/** Pure grouping; see header comment for the rule. */
export function groupRecords(files: MediaFile[]): RecordGroup[] {
  const cmp = (a: MediaFile, b: MediaFile) => bestTime(a) - bestTime(b) || a.name.localeCompare(b.name);
  const live = files.filter((f) => !f.duplicateOf).sort(cmp);
  const images = live.filter((f) => f.kind === 'image');
  const videos = live.filter((f) => f.kind === 'video');

  const groups: RecordGroup[] = [];
  let prevImage: MediaFile | null = null;
  for (const img of images) {
    const t = bestTime(img);
    const current = groups[groups.length - 1];
    const joins =
      prevImage &&
      current &&
      current.images.length === 1 &&
      t - bestTime(prevImage) <= PAIR_WINDOW_MS &&
      !videos.some((v) => bestTime(v) > bestTime(prevImage!) && bestTime(v) < t);
    if (joins) {
      current.images.push(img);
    } else {
      groups.push({ id: `g-${img.fingerprint.slice(0, 12)}`, images: [img], videos: [], groupedBy: 'capture-time' });
    }
    prevImage = img;
  }

  const orphans: MediaFile[] = [];
  for (const v of videos) {
    const vt = bestTime(v);
    let best: RecordGroup | null = null;
    let bestDist = Infinity;
    let bestBefore = false;
    for (const g of groups) {
      for (const img of g.images) {
        const diff = vt - bestTime(img);
        const dist = Math.abs(diff);
        const before = diff >= 0;
        if (dist > VIDEO_WINDOW_MS) continue;
        if (dist < bestDist || (dist === bestDist && before && !bestBefore)) {
          best = g;
          bestDist = dist;
          bestBefore = before;
        }
      }
    }
    if (best) best.videos.push(v);
    else orphans.push(v);
  }
  for (const v of orphans) {
    groups.push({ id: `g-${v.fingerprint.slice(0, 12)}`, images: [], videos: [v], groupedBy: 'single' });
  }

  const start = (g: RecordGroup) => Math.min(...[...g.images, ...g.videos].map(bestTime));
  return groups.sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
}
