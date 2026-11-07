/**
 * Thumbnails for the life timeline: JPEG, long edge 320 (s, -q:v 4) and 1600 (m, -q:v 3), never upscaled.
 * Orientation finding (2026-11-06, ffmpeg 8.0.1): ffmpeg AUTO-ROTATES EXIF-oriented JPEGs (Orientation=6 → portrait
 * output, tag dropped), while `sips -Z` resizes WITHOUT baking the rotation (output keeps the tag, so the pixels are
 * sideways for viewers that ignore it). So ffmpeg is the resizer for everything; `sips -s format jpeg` is used only as a
 * pre-converter for formats ffmpeg may not decode (HEIC/HEIF), which keeps the orientation tag for ffmpeg to apply.
 * Never writes to destRoot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MediaKind } from './types';

const execFileP = promisify(execFile);

export type RunFn = (cmd: string, args: string[]) => Promise<void>;
const defaultRun: RunFn = async (cmd, args) => { await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024 }); };

export const THUMB_SIZES = { s: { edge: 320, q: 4 }, m: { edge: 1600, q: 3 } } as const;
const SIPS_FIRST = new Set(['.heic', '.heif', '.hif']);

export interface ThumbOpts { cacheDir: string; ffmpegPath?: string; run?: RunFn }

export function thumbPaths(cacheDir: string, id: string) {
  return { s: join(cacheDir, `${id}_s.jpg`), m: join(cacheDir, `${id}_m.jpg`) };
}

function scaleFilter(edge: number): string {
  // box = min(edge, source) per axis + decrease → fits inside, keeps aspect, never upscales (landscape and portrait).
  return `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`;
}

function tmpName(final: string): string {
  return join(final.slice(0, final.lastIndexOf('/')), `.tmp-${randomBytes(4).toString('hex')}-${final.slice(final.lastIndexOf('/') + 1)}`);
}

export async function makeThumbs(
  input: { absPath: string; kind: MediaKind; id: string },
  opts: ThumbOpts,
): Promise<{ s: string; m: string }> {
  const out = thumbPaths(opts.cacheDir, input.id);
  if (existsSync(out.s) && existsSync(out.m)) return out;
  mkdirSync(opts.cacheDir, { recursive: true });
  const run = opts.run ?? defaultRun;
  const ffmpeg = opts.ffmpegPath || process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
  const made: string[] = [];
  const cleanup: string[] = [];
  try {
    let source = input.absPath;
    const convert = async () => {
      const conv = tmpName(join(opts.cacheDir, `${input.id}_src.jpg`));
      cleanup.push(conv);
      await run('sips', ['-s', 'format', 'jpeg', input.absPath, '--out', conv]);
      source = conv;
    };
    if (input.kind === 'image' && SIPS_FIRST.has(extname(input.absPath).toLowerCase())) await convert();

    const one = async (variant: 's' | 'm') => {
      const { edge, q } = THUMB_SIZES[variant];
      const tmp = tmpName(out[variant]);
      cleanup.push(tmp);
      const common = ['-v', 'error', '-y'];
      const tail = ['-frames:v', '1', '-vf', scaleFilter(edge), '-q:v', String(q), '-f', 'image2', '-update', '1', tmp];
      if (input.kind === 'video') {
        // Clip shorter than 1s: ffmpeg either errors (no frame to size the encoder) or writes nothing; fall back to frame 0.
        let got = true;
        try { await run(ffmpeg, [...common, '-ss', '1', '-i', source, ...tail]); } catch { got = false; }
        if (!got || !existsSync(tmp) || statSync(tmp).size === 0) await run(ffmpeg, [...common, '-i', source, ...tail]);
      } else {
        try {
          await run(ffmpeg, [...common, '-i', source, ...tail]);
        } catch (e) {
          if (source !== input.absPath) throw e;
          await convert();
          await run(ffmpeg, [...common, '-i', source, ...tail]);
        }
      }
      if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error(`thumbnail not produced for ${input.id}`);
      renameSync(tmp, out[variant]);
      made.push(out[variant]);
    };
    await one('s');
    await one('m');
    return out;
  } catch (e) {
    for (const p of made) rmSync(p, { force: true });
    throw e;
  } finally {
    for (const p of cleanup) rmSync(p, { force: true });
  }
}

export interface ThumbsRunOpts {
  manifest: {
    listAssets(o: { missingThumbs?: boolean; limit?: number }): unknown;
    setThumbs(sha256: string, s: string, m: string): unknown;
  };
  destRoot: string;
  cacheDir: string;
  limit?: number;
  isCancelled?: () => boolean;
  onProgress?: (p: { done: number; total: number }) => void;
  make?: typeof makeThumbs;
  thumbOpts?: Partial<ThumbOpts>;
}
export interface ThumbsRunResult { done: number; failed: { sha256: string; error: string }[]; cancelled: boolean }

export async function runThumbs(o: ThumbsRunOpts): Promise<ThumbsRunResult> {
  const rows = (await o.manifest.listAssets({ missingThumbs: true, limit: o.limit })) as { sha256: string; id: string; kind: MediaKind; canonicalPath: string }[];
  const make = o.make ?? makeThumbs;
  const failed: ThumbsRunResult['failed'] = [];
  let done = 0, cancelled = false;
  for (const r of rows) {
    if (o.isCancelled?.()) { cancelled = true; break; }
    try {
      const t = await make({ absPath: join(o.destRoot, r.canonicalPath), kind: r.kind, id: r.id }, { cacheDir: o.cacheDir, ...o.thumbOpts });
      await o.manifest.setThumbs(r.sha256, t.s, t.m);
      done++;
    } catch (e) {
      failed.push({ sha256: r.sha256, error: e instanceof Error ? e.message : String(e) });
    }
    o.onProgress?.({ done: done + failed.length, total: rows.length });
  }
  return { done, failed, cancelled };
}
