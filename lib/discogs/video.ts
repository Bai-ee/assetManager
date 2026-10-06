/**
 * Discogs -> X video/image step (local ffmpeg only; the only paid call is the framing vision call).
 *
 * analyzeVideo : per-second overall momentary loudness (ebur128), low-band RMS (lowpass 150 Hz = kick/bass)
 *                and mid/high-band RMS (highpass 300 Hz = musical content). The first 8 s (needle drop /
 *                handling) and last 5 s (reaching back to stop the record) are never returned.
 * pickClip     : PURE. Shows the music, not just the beats:
 *                  music start = first second where overall loudness is within 8 dB of the track median
 *                                for >= 2 consecutive seconds (drops handling/needle noise);
 *                  BREAK       = run of >= 6 s where low-band RMS is >= 6 dB below its median while
 *                                mid/high RMS stays within 8 dB of its median (drums/bass drop, music continues).
 *                  auto      : first break's start (music start instead if the break starts within 15 s of it,
 *                              so the lead-in is not lost); no break -> music start.
 *                  beginning : music start.   break : first break, else music start.
 *                The window is clamped to fit (shifted earlier but never before music start; short videos use
 *                what exists).
 * frameVideo / frameLabel : one vision call locates the record (see framing.ts); planCrop frames it per aspect:
 *                1:1 is always a sharp crop centred on the record, 9:16 is the full frame for portrait sources.
 * renderClip   : clip window only (input seek). Per time chunk (parallel ffmpeg processes): ONE decode ->
 *                HDR(HLG)->SDR bt709 -> look (once) -> split to 9:16 1080x1920 and 1:1 1080x1080, 30 fps H.264
 *                (h264_videotoolbox; libx264 crf 20 fallback). Audio: 2-pass loudnorm (-14 LUFS / -1.5 TP / LRA 11,
 *                pass 1 on the clip window audio only) + AAC 128k 48 kHz. Chunks are concatenated (stream copy)
 *                and muxed with the audio, +faststart.
 * gradeImage   : label photo (HEIC -> JPEG via sips) -> same framing + look.
 *
 * HDR -> SDR: the iPhone clips are HEVC 10-bit HLG/bt2020. This ffmpeg has no zscale and its
 * `colorspace` filter cannot read arib-std-b67, so the working path is VideoToolbox:
 *   -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld
 *   scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le
 * (-noautorotate is required: transpose cannot run on hw frames, so rotation is applied after
 * hwdownload from the stream's display matrix). Measured: this tonemap matches macOS' own SDR render of the
 * source (AVAssetImageGenerator) on SATAVG/YAVG, so the 'rich' looks add the punch on top of it.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CostLedger } from './cost';
import { framingGraph, locateRecord, pickSubject, planCrop, type CropPlan, type Subject } from './framing';

const FFMPEG = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe';
const SIPS = '/usr/bin/sips';

export const HEAD_SKIP_S = 8;
export const TAIL_SKIP_S = 5;
const MUSIC_LOUD_TOL_DB = 8;
const MUSIC_START_RUN_S = 2;
const BREAK_LOW_DROP_DB = 6;
const BREAK_MID_TOL_DB = 8;
const BREAK_MIN_S = 6;
/** Owner rule: take the clip from the middle of the video, unless a break is flagged at the
 * beginning (first 25% of the music, at least 30 s) — then the clip starts on that break.
 * Breaks later in the track are reported but do not move the clip. */
const INTRO_FRACTION = 0.25;
const INTRO_MIN_S = 30;
/** Centre the clip on the middle of the playable span. */
const MIDDLE_POSITION = 0.5;
const TONEMAP = 'scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le';

export type Aspect = '9x16' | '1x1';
export const ASPECTS: Record<Aspect, { w: number; h: number }> = { '9x16': { w: 1080, h: 1920 }, '1x1': { w: 1080, h: 1080 } };
export const ASPECT_LIST = Object.keys(ASPECTS) as Aspect[];

export interface AnalysisWindow {
  start: number;
  /** overall momentary loudness, LUFS */
  loudness: number;
  /** RMS dB of the < 150 Hz band (kick / bass) */
  low: number;
  /** RMS dB of the > 300 Hz band (musical content) */
  mid: number;
}
export interface VideoAnalysis { duration: number; windows: AnalysisWindow[] }
export interface Break { start: number; end: number }
export type ClipMode = 'auto' | 'beginning' | 'middle' | 'break';
export interface Clip { start: number; end: number; reason: string; musicStart: number; breaks: Break[] }
export type LookName = 'natural' | 'studio' | 'crisp-warm' | 'rich' | 'rich-plus';
export const DEFAULT_LOOK: LookName = 'rich-plus';

const DENOISE_SHARPEN = 'hqdn3d=1.5:1.5:3:3,unsharp=5:5:0.4:5:5:0';
export const LOOKS: Record<LookName, string> = {
  // tonemap only + light denoise + mild sharpen
  natural: DENOISE_SHARPEN,
  // natural + gentle contrast/saturation lift, slight black crush, slight warmth
  studio: `${DENOISE_SHARPEN},`
    + 'eq=contrast=1.06:saturation=1.12,colorlevels=rimin=0.03:gimin=0.03:bimin=0.03,'
    + 'colorbalance=rm=0.02:bm=-0.02:rh=0.02:bh=-0.02',
  // higher contrast, slightly desaturated, warm, crisper
  'crisp-warm': 'hqdn3d=1.5:1.5:3:3,unsharp=5:5:0.6:5:5:0,'
    + 'eq=contrast=1.12:saturation=0.88:gamma=0.98,'
    + 'colorbalance=rs=0.02:bs=-0.03:rm=0.03:bm=-0.04:rh=0.02:bh=-0.03',
  // iPhone-like punch: contrast + saturation + vibrance, small black point (default). gamma > 1 brightens in
  // ffmpeg eq: it offsets the luma that contrast/black point take away (measured YAVG ~107 vs 112 original).
  rich: `${DENOISE_SHARPEN},eq=contrast=1.08:saturation=1.30:gamma=1.06,vibrance=intensity=0.15,`
    + 'colorlevels=rimin=0.02:gimin=0.02:bimin=0.02',
  'rich-plus': `${DENOISE_SHARPEN},eq=contrast=1.12:saturation=1.45:gamma=1.05,vibrance=intensity=0.25,`
    + 'colorlevels=rimin=0.025:gimin=0.025:bimin=0.025',
};

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${err.message}\n${String(stderr).slice(-2000)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export async function probeDuration(p: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]);
  return parseFloat(stdout.trim());
}

async function probeRotation(p: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream_side_data=rotation', '-of', 'csv=p=0', p]);
  const m = stdout.split(/[\n,]/).map((l) => parseFloat(l)).find((n) => !Number.isNaN(n));
  return m ?? 0;
}

async function probeSize(p: string): Promise<{ w: number; h: number }> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0:s=x', p]);
  const [w, h] = stdout.trim().split('\n')[0].split('x').map(Number);
  return { w, h };
}

/** Parse ffmpeg `metadata=print` output into [pts_time, value] pairs for `key`. */
function parseMeta(out: string, key: string): Array<[number, number]> {
  const res: Array<[number, number]> = [];
  let t = NaN;
  for (const line of out.split('\n')) {
    const mt = /pts_time:([\d.]+)/.exec(line);
    if (mt) { t = parseFloat(mt[1]); continue; }
    const i = line.indexOf(key + '=');
    if (i >= 0 && !Number.isNaN(t)) {
      const raw = line.slice(i + key.length + 1).trim();
      const v = raw.includes('inf') ? (raw.startsWith('-') ? -70 : 0) : parseFloat(raw);
      res.push([t, Number.isNaN(v) ? -70 : Math.max(v, -70)]);
    }
  }
  return res;
}

export interface AnalyzeOptions {
  /** Cache the finished analysis in this JSON file (callers key it by source fingerprint). */
  cacheFile?: string;
}

/** ONE audio-only ffmpeg pass: asplit -> ebur128 (momentary) + lowpass 150 astats + highpass 300 astats, per-second. */
export async function analyzeVideo(p: string, opts: AnalyzeOptions = {}): Promise<VideoAnalysis> {
  if (opts.cacheFile) {
    try { return JSON.parse(fs.readFileSync(opts.cacheFile, 'utf8')) as VideoAnalysis; } catch { /* not cached */ }
  }
  const duration = await probeDuration(p);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discogs-an-'));
  try {
    const f = { m: path.join(tmp, 'm.txt'), low: path.join(tmp, 'low.txt'), mid: path.join(tmp, 'mid.txt') };
    const band = (inL: string, filter: string, file: string, out: string) =>
      `[${inL}]aresample=16000,${filter},asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,`
      + `ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${file}[${out}]`;
    const graph = [
      '[0:a:0]asplit=3[am][al][ah]',
      `[am]ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=${f.m}[om]`,
      band('al', 'lowpass=f=150', f.low, 'ol'),
      band('ah', 'highpass=f=300', f.mid, 'oh'),
    ].join(';');
    await run(FFMPEG, ['-v', 'error', '-nostdin', '-i', p, '-vn', '-filter_complex', graph,
      ...['om', 'ol', 'oh'].flatMap((o) => ['-map', `[${o}]`, '-f', 'null', '-'])]);
    const M = parseMeta(fs.readFileSync(f.m, 'utf8'), 'lavfi.r128.M');
    const low = parseMeta(fs.readFileSync(f.low, 'utf8'), 'lavfi.astats.Overall.RMS_level');
    const mid = parseMeta(fs.readFileSync(f.mid, 'utf8'), 'lavfi.astats.Overall.RMS_level');
    const first = HEAD_SKIP_S;
    const last = Math.floor(duration - TAIL_SKIP_S);
    // bucket once instead of re-filtering per second
    const bucket = (a: Array<[number, number]>) => {
      const m = new Map<number, number[]>();
      for (const [t, v] of a) { const k = Math.floor(t); (m.get(k) ?? m.set(k, []).get(k)!).push(v); }
      return m;
    };
    const bM = bucket(M), bL = bucket(low), bH = bucket(mid);
    const dbMean = (a: number[] | undefined) => (a?.length ? 10 * Math.log10(mean(a.map((v) => 10 ** (v / 10)))) : -70);
    const windows: AnalysisWindow[] = [];
    for (let s = first; s < last; s++) windows.push({ start: s, loudness: dbMean(bM.get(s)), low: dbMean(bL.get(s)), mid: dbMean(bH.get(s)) });
    const result = { duration, windows };
    if (opts.cacheFile) {
      fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
      fs.writeFileSync(opts.cacheFile, JSON.stringify(result));
    }
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- clip selection (pure) ----

/** First second where loudness is within 8 dB of the median for >= 2 consecutive seconds. */
export function findMusicStart(ws: AnalysisWindow[]): number | null {
  const med = median(ws.map((w) => w.loudness));
  const ok = (w: AnalysisWindow) => Math.abs(w.loudness - med) <= MUSIC_LOUD_TOL_DB;
  for (let i = 0; i + MUSIC_START_RUN_S <= ws.length; i++) {
    let good = true;
    for (let k = 0; k < MUSIC_START_RUN_S; k++) {
      if (!ok(ws[i + k]) || ws[i + k].start - ws[i].start !== k) { good = false; break; }
    }
    if (good) return ws[i].start;
  }
  return null;
}

/** Runs of >= 6 s (from `fromS` on) with low band >= 6 dB under its median and mid/high within 8 dB of its median. */
export function findBreaks(ws: AnalysisWindow[], fromS: number): Break[] {
  const music = ws.filter((w) => w.start >= fromS);
  const lowMed = median(music.map((w) => w.low));
  const midMed = median(music.map((w) => w.mid));
  const isBreak = (w: AnalysisWindow) => w.low <= lowMed - BREAK_LOW_DROP_DB && Math.abs(w.mid - midMed) <= BREAK_MID_TOL_DB;
  const out: Break[] = [];
  let runStart: number | null = null;
  let prev = -Infinity;
  const flush = (endExclusive: number) => {
    if (runStart !== null && endExclusive - runStart >= BREAK_MIN_S) out.push({ start: runStart, end: endExclusive });
    runStart = null;
  };
  for (const w of music) {
    if (isBreak(w) && (runStart === null || w.start === prev + 1)) {
      if (runStart === null) runStart = w.start;
    } else {
      flush(prev + 1);
      if (isBreak(w)) runStart = w.start;
    }
    prev = w.start;
  }
  flush(prev + 1);
  return out;
}

export function pickClip(analysis: VideoAnalysis, opts: { length?: number; mode?: ClipMode } = {}): Clip {
  const length = opts.length ?? 60;
  const mode = opts.mode ?? 'auto';
  const ws = analysis.windows
    .filter((w) => w.start >= HEAD_SKIP_S && w.start + 1 <= analysis.duration - TAIL_SKIP_S)
    .sort((a, b) => a.start - b.start);
  const usableEnd = ws.length ? ws[ws.length - 1].start + 1 : HEAD_SKIP_S;
  const musicStart = findMusicStart(ws) ?? (ws.length ? ws[0].start : HEAD_SKIP_S);
  const breaks = findBreaks(ws, musicStart);
  const fmt = (b: Break) => `${b.start}-${b.end}s`;
  const breakTxt = breaks.length ? `breaks ${breaks.map(fmt).join(', ')}` : 'no break';

  let start = musicStart;
  let rule: string;
  const span = Math.max(0, usableEnd - musicStart);
  const introEnd = musicStart + Math.max(INTRO_MIN_S, span * INTRO_FRACTION);
  const openingBreak = breaks.find((b) => b.start < introEnd);
  const middleStart = musicStart + Math.max(0, Math.round((span - length) * MIDDLE_POSITION));
  if (mode === 'beginning') {
    rule = `mode=beginning: music start ${musicStart}s`;
  } else if (mode !== 'middle' && openingBreak) {
    start = openingBreak.start;
    rule = `break flagged at the beginning ${fmt(openingBreak)}: starting on the break`;
  } else {
    start = middleStart;
    const why = mode === 'middle' ? 'mode=middle' : mode === 'break' ? 'mode=break but no break at the beginning' : (breaks.length ? 'no break at the beginning' : 'no break');
    rule = `${why}: middle of the video, starting at ${start}s (beginning = first ${Math.round(introEnd - musicStart)}s of music)`;
  }
  let end = start + length;
  let clamp = '';
  if (end > usableEnd) {
    start = Math.max(musicStart, usableEnd - length);
    end = Math.min(start + length, usableEnd);
    clamp = `; clamped to fit video end (${usableEnd}s)`;
  }
  return { start, end, musicStart, breaks,
    reason: `${rule}${clamp} [music start ${musicStart}s, ${breakTxt}, video ${analysis.duration.toFixed(0)}s]` };
}

// ---- framing ----

function rotateFilter(rot: number): string {
  const r = ((Math.round(rot) % 360) + 360) % 360;
  if (r === 270) return 'transpose=1,'; // display matrix -90 => rotate clockwise
  if (r === 90) return 'transpose=2,';
  if (r === 180) return 'hflip,vflip,';
  return '';
}

export interface FramingDecision {
  srcW: number;
  srcH: number;
  subject: Subject;
  plans: Record<Aspect, CropPlan>;
}

function plansFor(srcW: number, srcH: number, subject: Subject): Record<Aspect, CropPlan> {
  const out = {} as Record<Aspect, CropPlan>;
  for (const a of ASPECT_LIST) out[a] = planCrop(srcW, srcH, subject.box, ASPECTS[a].w / ASPECTS[a].h);
  // 1:1: whole disc when it fits the square, otherwise centre on the label (label always stays inside)
  const sq = out['1x1'];
  if (subject.kind === 'disc' && subject.label && sq.mode === 'crop' && !sq.fits) {
    out['1x1'] = planCrop(srcW, srcH, subject.label, 1);
  }
  return out;
}

export interface FrameOptions {
  cacheDir: string; ledger?: CostLedger; name: string; workDir: string;
  /** Source fingerprint: caches the finished subject per (fingerprint, clip window), skipping extraction and the vision call. */
  fingerprint?: string;
}

function ledgerAdd(opts: FrameOptions, r: { model: string; usage?: import('./cost').Usage; cached: boolean }) {
  opts.ledger?.add({ kind: 'vision', file: opts.name, model: r.model, usage: r.usage, cached: r.cached });
}

const FRAME_POSITIONS = [0.2, 0.5, 0.8];
const FRAME_LONG_EDGE = 768;

/**
 * 3 frames across the clip (after tonemap + rotation) from the LOCAL copy, extracted at <= 768 px in ONE ffmpeg call
 * (three seeked inputs), then one vision call, median disc box. Cached by source fingerprint + clip window.
 */
export async function frameVideo(src: string, clip: Clip, opts: FrameOptions): Promise<FramingDecision> {
  const rot = await probeRotation(src);
  const raw = await probeSize(src);
  const swap = ((Math.round(rot) % 360) + 360) % 360 % 180 === 90;
  const srcW = swap ? raw.h : raw.w, srcH = swap ? raw.w : raw.h;
  const subjFile = opts.fingerprint
    ? path.join(opts.cacheDir, `subject-${opts.fingerprint}-${clip.start}-${clip.end}-v1.json`) : null;
  if (subjFile) {
    try {
      const subject = JSON.parse(fs.readFileSync(subjFile, 'utf8')) as Subject;
      ledgerAdd(opts, { model: 'subject-cache', cached: true });
      return { srcW, srcH, subject, plans: plansFor(srcW, srcH, subject) };
    } catch { /* not cached */ }
  }

  const len = clip.end - clip.start;
  fs.mkdirSync(opts.workDir, { recursive: true });
  // downscale on the GPU while tonemapping: long edge of the STORED frame = 768 (rotation does not change it)
  const k = FRAME_LONG_EDGE / Math.max(raw.w, raw.h);
  const sw = Math.max(2, Math.round((raw.w * Math.min(1, k)) / 2) * 2), sh = Math.max(2, Math.round((raw.h * Math.min(1, k)) / 2) * 2);
  const tone = `scale_vt=w=${sw}:h=${sh}:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le`;
  const frames = FRAME_POSITIONS.map((_, i) => path.join(opts.workDir, `frame-${i}.jpg`));
  const inputs = FRAME_POSITIONS.flatMap((f) => ['-noautorotate', '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld',
    '-display_rotation', '0', '-ss', String(clip.start + len * f), '-i', src]);
  const graph = FRAME_POSITIONS.map((_, i) => `[${i}:v:0]${tone},${rotateFilter(rot)}format=yuvj420p[f${i}]`).join(';');
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...inputs, '-filter_complex', graph,
    ...frames.flatMap((out, i) => ['-map', `[f${i}]`, '-frames:v', '1', '-q:v', '3', out])]);
  const loc = await locateRecord(frames, { cacheDir: opts.cacheDir });
  ledgerAdd(opts, loc);
  const subject = pickSubject(loc.results);
  if (subjFile) fs.writeFileSync(subjFile, JSON.stringify(subject));
  return { srcW, srcH, subject, plans: plansFor(srcW, srcH, subject) };
}

/** Label photo: locate the record in it and plan both aspects. `jpg` is the sips-converted photo. */
export async function frameLabel(jpg: string, opts: FrameOptions): Promise<FramingDecision> {
  const { w, h } = await probeSize(jpg);
  const loc = await locateRecord([jpg], { cacheDir: opts.cacheDir });
  ledgerAdd(opts, loc);
  const subject = pickSubject(loc.results);
  return { srcW: w, srcH: h, subject, plans: plansFor(w, h, subject) };
}

// ---- render ----

export type Encoder = 'videotoolbox' | 'x264';
export interface RenderOptions {
  /** Default: env DISCOGS_ENCODER ('x264' forces the software encoder), else h264_videotoolbox with automatic x264 fallback. */
  encoder?: Encoder;
  /** Parallel time chunks (default: env DISCOGS_RENDER_CHUNKS, else 1 per ~15 s of clip, max 4). */
  chunks?: number;
  /** Scratch dir for chunk files (default: next to the first output). */
  tmpDir?: string;
}

const FPS = 30;
const X264_ARGS = ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium'];
// ~7 Mbit/s average, 9 Mbit/s cap (SSIM vs libx264 crf 20 >= 0.98 at about the same file size), High profile (hardware encoder; no B-frames so chunks concatenate cleanly)
const VT_BITRATE = Number(process.env.DISCOGS_VT_MBPS) || 7;
const VT_ARGS = ['-c:v', 'h264_videotoolbox', '-b:v', `${VT_BITRATE}M`, '-maxrate', `${Math.round(VT_BITRATE * 4 / 3)}M`, '-profile:v', 'high', '-bf', '0', '-g', '60'];
const COMMON_VIDEO_ARGS = ['-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-color_range', 'tv', '-r', String(FPS), '-an', '-map_metadata', '-1'];

/** Whole-second chunk lengths summing to `len` (the last one takes the remainder). */
export function chunkPlan(len: number, chunks: number): number[] {
  const n = Math.max(1, Math.min(chunks, Math.floor(len)));
  const base = Math.floor(len / n);
  const out = Array.from({ length: n }, () => base);
  out[n - 1] = len - base * (n - 1);
  return out;
}

/** Loudnorm 2-pass on the clip window's audio only; returns the finished AAC file. */
async function renderAudio(src: string, clip: Clip, out: string): Promise<void> {
  const len = clip.end - clip.start;
  const fade = 0.5;
  const input = ['-ss', String(clip.start), '-t', String(len), '-i', src, '-vn'];
  const m = await run(FFMPEG, ['-hide_banner', '-nostdin', ...input,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const jm = /\{[^{}]*"input_i"[^{}]*\}/.exec(m.stderr);
  if (!jm) throw new Error('loudnorm measurement failed');
  const j = JSON.parse(jm[0]);
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}`
    + `:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...input, '-af',
    `${ln},aresample=48000,afade=t=in:d=${fade},afade=t=out:st=${len - fade}:d=${fade}`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', out]);
}

/** One time chunk: ONE decode -> tonemap -> rotate -> look -> split -> 9:16 + 1:1 (video only). */
async function renderChunk(
  src: string, rot: number, t0: number, dur: number, fadeIn: boolean, fadeOutAt: number | null,
  look: LookName, plans: Record<Aspect, CropPlan>, outs: Record<Aspect, string>, encoder: Encoder,
): Promise<void> {
  const fade = 0.5;
  const frames = Math.round(dur * FPS);
  const fades = (fadeIn ? `fade=t=in:st=0:d=${fade},` : '') + (fadeOutAt !== null ? `fade=t=out:st=${fadeOutAt}:d=${fade},` : '');
  const post = `${fades}format=yuv420p`;
  // the look runs once on the full frame, before the split (it used to run once per output)
  const graph = [
    `[0:v:0]${TONEMAP},${rotateFilter(rot)}fps=${FPS},format=yuv420p,${LOOKS[look]},split=2[s9][s1]`,
    framingGraph('s9', 'v9', plans['9x16'], ASPECTS['9x16'].w, ASPECTS['9x16'].h, 'p9', post),
    framingGraph('s1', 'v1', plans['1x1'], ASPECTS['1x1'].w, ASPECTS['1x1'].h, 'p1', post),
  ].join(';');
  const enc = [...(encoder === 'videotoolbox' ? VT_ARGS : X264_ARGS), ...COMMON_VIDEO_ARGS];
  // input seek (-ss before -i, -t = chunk length): only this window is decoded
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-noautorotate',
    '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld',
    '-display_rotation', '0', '-ss', String(t0), '-t', String(dur + 0.2), '-i', src,
    '-filter_complex', graph,
    // exact frame count per chunk so the concatenation has no duplicated/dropped frames
    '-map', '[v9]', '-frames:v', String(frames), ...enc, outs['9x16'],
    '-map', '[v1]', '-frames:v', String(frames), ...enc, outs['1x1']]);
}

export async function renderClip(
  src: string, outs: Record<Aspect, string>, clip: Clip, look: LookName, plans: Record<Aspect, CropPlan>,
  opts: RenderOptions = {},
): Promise<{ encoder: Encoder; chunks: number }> {
  const len = clip.end - clip.start;
  const fade = 0.5;
  const rot = await probeRotation(src);
  const wanted: Encoder = opts.encoder ?? (process.env.DISCOGS_ENCODER === 'x264' ? 'x264' : 'videotoolbox');
  const nChunks = opts.chunks ?? (Number(process.env.DISCOGS_RENDER_CHUNKS) || Math.min(4, Math.max(1, Math.round(len / 15))));
  const lens = chunkPlan(len, nChunks);
  const tmp = fs.mkdtempSync(path.join(opts.tmpDir ?? path.dirname(outs['1x1']), 'render-'));
  try {
    const audio = path.join(tmp, 'audio.m4a');
    const renderVideo = async (encoder: Encoder) => {
      let at = clip.start;
      const jobs = lens.map((d, i) => {
        const t0 = at;
        at += d;
        const o = { '9x16': path.join(tmp, `c${i}-9x16.mp4`), '1x1': path.join(tmp, `c${i}-1x1.mp4`) };
        return renderChunk(src, rot, t0, d, false, null, look, plans, o, encoder).then(() => o); // no video fades: only the audio fades in/out (owner rule)
      });
      return Promise.all(jobs);
    };
    const video = (async () => {
      try { return { encoder: wanted, parts: await renderVideo(wanted) }; }
      catch (e) {
        if (wanted !== 'videotoolbox') throw e;
        console.warn(`  videotoolbox encode failed, falling back to libx264: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
        return { encoder: 'x264' as Encoder, parts: await renderVideo('x264') };
      }
    })();
    const [{ encoder, parts }] = await Promise.all([video, renderAudio(src, clip, audio)]);

    for (const a of ASPECT_LIST) {
      const list = path.join(tmp, `list-${a}.txt`);
      fs.writeFileSync(list, parts.map((p) => `file '${p[a]}'`).join('\n'));
      await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', outs[a]]);
    }
    return { encoder, chunks: lens.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** HEIC (or any sips-readable image) -> sRGB JPEG, long edge capped at 2000 px. */
export async function labelToJpeg(srcImage: string, outJpg: string): Promise<void> {
  await run(SIPS, ['-s', 'format', 'jpeg', '-Z', '2000', '-m',
    '/System/Library/ColorSync/Profiles/sRGB Profile.icc', srcImage, '--out', outJpg]);
}

/** Frame (per plan) + grade a sips-converted label JPEG to one aspect. */
export async function gradeImage(srcJpg: string, outJpg: string, look: LookName, plan: CropPlan, aspect: Aspect): Promise<void> {
  const { w, h } = ASPECTS[aspect];
  const graph = framingGraph('0:v', 'o', plan, w, h, 'pi', `${LOOKS[look]},format=yuvj420p`);
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', srcJpg, '-filter_complex', graph,
    '-map', '[o]', '-q:v', '2', '-frames:v', '1', outJpg]);
}

/** One framed + graded still from the source at time `t` (QA / contact sheets). */
export async function renderFrame(src: string, t: number, out: string, look: LookName, plan: CropPlan, aspect: Aspect): Promise<void> {
  const rot = await probeRotation(src);
  const { w, h } = ASPECTS[aspect];
  const graph = `[0:v:0]${TONEMAP},${rotateFilter(rot)}format=yuv420p[fr];`
    + framingGraph('fr', 'o', plan, w, h, 'pf', `${LOOKS[look]},format=yuvj420p`);
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-noautorotate', '-hwaccel', 'videotoolbox',
    '-hwaccel_output_format', 'videotoolbox_vld', '-display_rotation', '0', '-ss', String(t), '-i', src,
    '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-q:v', '2', out]);
}
