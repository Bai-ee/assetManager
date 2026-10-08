import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe';

export interface PreparedMedia {
  /** JPEG bytes sent to the model: 1 image, or 1 composed 2x2 keyframe grid for video. */
  jpeg: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  durationSec?: number;
  capturedAt?: string;
}

export type PrepareMedia = (absPath: string, kind: 'image' | 'video') => Promise<PreparedMedia>;

export const KEYFRAME_FRACTIONS = [0.1, 0.35, 0.6, 0.85];
const MAX_BUFFER = 64 * 1024 * 1024;

async function ffprobe(file: string) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: MAX_BUFFER });
  const j = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; tags?: Record<string, string> }>; format?: { duration?: string; tags?: Record<string, string> } };
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  const tags = { ...(j.format?.tags || {}), ...(v?.tags || {}) };
  const when = tags.creation_time || tags.DateTimeOriginal || tags.date;
  const t = when ? Date.parse(when.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')) : NaN;
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec: j.format?.duration ? Number(j.format.duration) : undefined,
    capturedAt: Number.isNaN(t) ? undefined : new Date(t).toISOString(),
  };
}

const fit = (n: number) => `scale='min(${n},iw)':'min(${n},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

async function toJpeg(input: string, output: string, longEdge: number, q: number, seekSec?: number) {
  const args = ['-v', 'error', '-y', ...(seekSec != null ? ['-ss', String(seekSec)] : []), '-i', input, '-frames:v', '1', '-vf', fit(longEdge), '-q:v', String(q), output];
  await run(FFMPEG, args, { maxBuffer: MAX_BUFFER });
}

/** Reads the original (read-only) and produces temp JPEGs. Never writes next to the source. */
export const prepareMedia: PrepareMedia = async (absPath, kind) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-analyzer-'));
  try {
    const meta = await ffprobe(absPath);
    if (kind === 'image') {
      const out = path.join(tmp, 'img.jpg');
      const th = path.join(tmp, 'thumb.jpg');
      await toJpeg(absPath, out, 1024, 4);
      await toJpeg(out, th, 320, 12);
      return { jpeg: await fs.promises.readFile(out), thumb: await fs.promises.readFile(th), width: meta.width, height: meta.height, capturedAt: meta.capturedAt };
    }
    const dur = meta.durationSec && meta.durationSec > 0 ? meta.durationSec : 1;
    const frames: string[] = [];
    for (let i = 0; i < KEYFRAME_FRACTIONS.length; i++) {
      const f = path.join(tmp, `k${i}.jpg`);
      await toJpeg(absPath, f, 512, 4, dur * KEYFRAME_FRACTIONS[i]);
      frames.push(f);
    }
    const grid = path.join(tmp, 'grid.jpg');
    // Normalise every tile to the same size so xstack layout is valid.
    const filter = frames.map((_, i) => `[${i}:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2[t${i}]`).join(';')
      + ';[t0][t1][t2][t3]xstack=inputs=4:layout=0_0|512_0|0_512|512_512';
    await run(FFMPEG, ['-v', 'error', '-y', ...frames.flatMap(f => ['-i', f]), '-filter_complex', filter, '-frames:v', '1', '-q:v', '4', grid], { maxBuffer: MAX_BUFFER });
    const th = path.join(tmp, 'thumb.jpg');
    await toJpeg(frames[1], th, 320, 12);
    return { jpeg: await fs.promises.readFile(grid), thumb: await fs.promises.readFile(th), width: meta.width, height: meta.height, durationSec: meta.durationSec, capturedAt: meta.capturedAt };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
};
