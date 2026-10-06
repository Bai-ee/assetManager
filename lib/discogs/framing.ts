/**
 * Record framing for the Discogs -> X pipeline.
 *
 * locateRecord : ONE Claude vision call over up to 3 JPEGs (downscaled to ~768 px long edge) ->
 *                normalized boxes for the whole disc and the centre label of each image.
 *                Cached by hash of the image bytes; returns usage for the cost ledger.
 * pickSubject  : median disc box over the frames; disc if fully visible, else the label.
 * planCrop     : PURE. 1:1 is always a sharp crop (full short edge, tighter only to centre; label never cut).
 *                9:16 is the full frame for portrait sources, else a centred crop, else a blurred-background pad.
 * framingGraph : ffmpeg filter_complex fragment that applies a plan to a labelled stream.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Usage } from './cost';

const SIPS = '/usr/bin/sips';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TOOL_NAME = 'locate_record';
const SEND_LONG_EDGE = 768;

export interface Box { x: number; y: number; w: number; h: number }
export interface RecordLocation {
  disc: Box | null;
  discFullyVisible: boolean;
  label: Box | null;
}
export interface LocateResult {
  results: RecordLocation[];
  model: string;
  cached: boolean;
  usage?: Usage;
}
export interface LocateOptions { cacheDir?: string; model?: string; fetchImpl?: typeof fetch }

const boxSchema = {
  type: ['object', 'null'],
  properties: {
    x: { type: 'number', description: 'left edge, fraction of image width (0..1)' },
    y: { type: 'number', description: 'top edge, fraction of image height (0..1)' },
    w: { type: 'number', description: 'width, fraction of image width (0..1)' },
    h: { type: 'number', description: 'height, fraction of image height (0..1)' },
  },
  required: ['x', 'y', 'w', 'h'],
};

const TOOL = {
  name: TOOL_NAME,
  description: 'Record where the vinyl record and its centre label are in each photo.',
  input_schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        description: 'One entry per image, in the order the images were given.',
        items: {
          type: 'object',
          properties: {
            disc: { ...boxSchema, description: 'Tight bounding box of the whole vinyl disc (outer black edge). If part of the disc is outside the photo, the box of the visible part clipped to the photo. null if no disc.' },
            discFullyVisible: { type: 'boolean', description: 'true only if the entire outer edge of the disc is inside the photo.' },
            label: { ...boxSchema, description: 'Tight bounding box of the paper centre label. null if not visible.' },
          },
          required: ['disc', 'discFullyVisible', 'label'],
        },
      },
    },
    required: ['images'],
  },
};

const PROMPT = [
  'These are photos of a vinyl record on a turntable (or being held), in order.',
  'You must respond by calling the locate_record tool exactly once, with one entry per image in the same order.',
  'Boxes are fractions of that image\'s own width and height, origin top-left, as {x, y, w, h}.',
  'The disc is perspective-projected: a circle seen at an angle is an ellipse; box the full ellipse.',
  'disc = the whole black vinyl record including its outer edge, not the platter or slipmat. label = the round paper label in the middle.',
  'discFullyVisible is true only if the whole outer edge of the disc is inside the photo (not cropped by any photo edge).',
].join('\n');

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function normBox(raw: unknown): Box | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(k => Number(r[k]));
  if (![x, y, w, h].every(Number.isFinite) || w <= 0.01 || h <= 0.01) return null;
  const x0 = clamp01(x), y0 = clamp01(y);
  const x1 = clamp01(x + w), y1 = clamp01(y + h);
  if (x1 - x0 <= 0.01 || y1 - y0 <= 0.01) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, _o, stderr) => (err ? reject(new Error(`${path.basename(cmd)} failed: ${stderr}`)) : resolve()));
  });
}

interface ToolUseBlock { type: 'tool_use'; name: string; input: Record<string, unknown> }
interface MessageResponse {
  content?: Array<ToolUseBlock | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function locateRecord(imagePaths: string[], opts: LocateOptions & { cacheDir: string }): Promise<LocateResult> {
  if (!imagePaths.length || imagePaths.length > 3) throw new Error('locateRecord takes 1-3 images');
  const model = opts.model || process.env.DISCOGS_VISION_MODEL || DEFAULT_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const hash = createHash('sha256');
  for (const p of imagePaths) hash.update(fs.readFileSync(p)).update('\0');
  const key = hash.update(model).update('framing-v1').digest('hex');
  const cacheFile = path.join(opts.cacheDir, `framing-${key}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as LocateResult;
      return { ...c, cached: true };
    } catch { /* corrupt cache: re-read */ }
  }
  if (!apiKey) throw new Error('Record framing is not configured: ANTHROPIC_API_KEY is missing');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framing-'));
  let content: unknown[];
  try {
    content = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const small = path.join(tmpDir, `s${i}.jpg`);
      await run(SIPS, ['-s', 'format', 'jpeg', '-Z', String(SEND_LONG_EDGE), imagePaths[i], '--out', small]);
      content.push({ type: 'text', text: `Image ${i + 1}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(small).toString('base64') } });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  content.push({ type: 'text', text: PROMPT });

  const body = JSON.stringify({
    model, max_tokens: 1024, tools: [TOOL],
    // This model rejects forced tool_choice (400): auto + prompt instruction.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  });
  const init = (): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
    body, signal: AbortSignal.timeout(90_000),
  });
  let res = await fetchImpl(ANTHROPIC_API_URL, init());
  if (res.status === 429 || res.status >= 500) { await sleep(2000); res = await fetchImpl(ANTHROPIC_API_URL, init()); }
  if (!res.ok) throw new Error(`Record framing failed: ${res.status} ${await res.text()}`);
  const payload = (await res.json()) as MessageResponse;
  const tool = (payload.content || []).find((b): b is ToolUseBlock => b.type === 'tool_use' && (b as ToolUseBlock).name === TOOL_NAME);
  if (!tool) throw new Error('Record framing did not include the expected tool call');
  const raw = Array.isArray(tool.input?.images) ? (tool.input.images as Array<Record<string, unknown>>) : [];
  const results: RecordLocation[] = imagePaths.map((_, i) => {
    const r = raw[i] ?? {};
    const disc = normBox(r.disc);
    return { disc, discFullyVisible: Boolean(disc) && r.discFullyVisible === true, label: normBox(r.label) };
  });
  const out: LocateResult = { results, model, cached: false };
  if (payload.usage) {
    const u = payload.usage;
    out.usage = {
      inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
      ...(u.cache_read_input_tokens != null ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens != null ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
    };
  }
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

// ---- subject selection ----

const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const medianBox = (bs: Box[]): Box | null =>
  bs.length ? { x: med(bs.map(b => b.x)), y: med(bs.map(b => b.y)), w: med(bs.map(b => b.w)), h: med(bs.map(b => b.h)) } : null;

export interface Subject { box: Box | null; kind: 'disc' | 'label' | 'none'; /** median label box (square-crop fallback) */ label: Box | null }

/** Median over frames. Disc if it is fully visible in the majority of frames that show it, else the label. */
export function pickSubject(locs: RecordLocation[]): Subject {
  const discs = locs.filter(l => l.disc);
  const full = discs.filter(l => l.discFullyVisible);
  const label = medianBox(locs.map(l => l.label).filter((b): b is Box => Boolean(b)));
  if (discs.length && full.length * 2 > discs.length) return { box: medianBox(full.map(l => l.disc as Box)), kind: 'disc', label };
  if (label) return { box: label, kind: 'label', label };
  return { box: null, kind: 'none', label: null };
}

// ---- crop planner (pure) ----

export interface Rect { x: number; y: number; w: number; h: number }
export type CropPlan =
  /** `fits` = subject (with whatever margin the frame allows) is fully inside the crop. */
  | { mode: 'crop'; rect: Rect; note: string; fits: boolean }
  /** `region` of the source is scaled to fit inside the output; the rest is a blurred, darkened copy. */
  | { mode: 'pad'; region: Rect; note: string };

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * subjectBox is normalized (0..1) in the source frame; targetAspect = w/h of the output.
 * crop : a target-aspect rect centred exactly on the subject (kept inside the frame) that contains subject + margin.
 * pad  : otherwise. Region = frame shrunk symmetrically about the subject centre (so the subject stays centred and
 *        whole; margin is best-effort when the subject sits near an edge),
 *        scaled to fit the output, blurred copy behind.
 */
export function planCrop(srcW: number, srcH: number, subjectBox: Box | null, targetAspect: number, marginPct = 6): CropPlan {
  const fullFrame: Rect = { x: 0, y: 0, w: srcW, h: srcH };
  const isSquare = Math.abs(targetAspect - 1) < 0.01;
  // source already has the target aspect (e.g. portrait source for 9:16): the full frame, nothing to decide
  if (Math.abs(srcW / srcH - targetAspect) / targetAspect < 0.02) {
    return { mode: 'crop', rect: { x: 0, y: 0, w: even(srcW), h: even(srcH) }, fits: true, note: 'full frame (source already has the target aspect)' };
  }
  if (!subjectBox) {
    if (isSquare) {
      const s = Math.min(srcW, srcH);
      return { mode: 'crop', rect: { x: Math.round((srcW - s) / 2), y: Math.round((srcH - s) / 2), w: even(s), h: even(s) }, fits: false, note: 'no subject found: centre square' };
    }
    return { mode: 'pad', region: fullFrame, note: 'no subject found: whole frame, blurred fill' };
  }

  const sx = subjectBox.x * srcW, sy = subjectBox.y * srcH, sw = subjectBox.w * srcW, sh = subjectBox.h * srcH;
  const m = (marginPct / 100) * Math.max(sw, sh);
  const cx = sx + sw / 2, cy = sy + sh / 2;
  // room around the subject centre if we must stay centred inside the frame
  const roomX = Math.min(cx, srcW - cx), roomY = Math.min(cy, srcH - cy);
  // subject + margin, with the margin trimmed where the frame edge leaves no room (best effort)
  const needW = 2 * Math.min(sw / 2 + m, roomX);
  const needH = 2 * Math.min(sh / 2 + m, roomY);

  if (isSquare) {
    // never pad: side = full short edge, or tighter when that is what it takes to centre on the subject
    const s0 = Math.min(srcW, srcH);
    const centredS = Math.min(s0, 2 * roomX, 2 * roomY);
    const needS = Math.max(needW, needH);
    const centred = centredS >= s0 - 0.5 || centredS >= needS;
    const side = centred ? centredS : s0;
    const rect: Rect = { x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), w: even(side), h: even(side) };
    rect.x = Math.min(Math.max(0, rect.x), srcW - rect.w);
    rect.y = Math.min(Math.max(0, rect.y), srcH - rect.h);
    const fits = sx >= rect.x - 1 && sy >= rect.y - 1 && sx + sw <= rect.x + rect.w + 1 && sy + sh <= rect.y + rect.h + 1;
    return { mode: 'crop', rect, fits, note: `square crop ${rect.w}x${rect.h} ${centred ? 'centred' : 'clamped'} on ${cx.toFixed(0)},${cy.toFixed(0)}${fits ? '' : ' (subject larger than the square)'}` };
  }

  // largest target-aspect crop that fits the frame, and the largest one centred on the subject
  const maxW = Math.min(srcW, srcH * targetAspect);
  const centredW = Math.min(maxW, 2 * Math.min(cx, srcW - cx), 2 * Math.min(cy, srcH - cy) * targetAspect);
  const minW = Math.max(needW, needH * targetAspect);

  if (minW <= centredW + 0.5) {
    const cw = centredW;
    const ch = cw / targetAspect;
    const rect: Rect = { x: Math.round(cx - cw / 2), y: Math.round(cy - ch / 2), w: even(cw), h: even(ch) };
    rect.x = Math.min(Math.max(0, rect.x), srcW - rect.w);
    rect.y = Math.min(Math.max(0, rect.y), srcH - rect.h);
    return { mode: 'crop', rect, fits: true, note: `crop ${rect.w}x${rect.h} centred on ${cx.toFixed(0)},${cy.toFixed(0)}` };
  }

  // pad: frame region symmetric about the subject centre, never smaller than subject + margin
  const rw = Math.min(srcW, 2 * Math.min(cx, srcW - cx));
  const rh = Math.min(srcH, 2 * Math.min(cy, srcH - cy));
  const region: Rect = { x: Math.round(cx - rw / 2), y: Math.round(cy - rh / 2), w: even(rw), h: even(rh) };
  region.x = Math.min(Math.max(0, region.x), srcW - region.w);
  region.y = Math.min(Math.max(0, region.y), srcH - region.h);
  return { mode: 'pad', region, note: `subject does not fit a ${targetAspect.toFixed(2)} crop: ${region.w}x${region.h} region fitted on blurred fill` };
}

/**
 * filter_complex fragment: `[inLabel]` -> `[outLabel]` at outW x outH. `tag` keeps internal labels unique.
 * `post` (look etc.) is applied to the finished frame.
 */
export function framingGraph(inLabel: string, outLabel: string, plan: CropPlan, outW: number, outH: number, tag: string, post = ''): string {
  const tail = post ? `,${post}` : '';
  if (plan.mode === 'crop') {
    const r = plan.rect;
    return `[${inLabel}]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${outW}:${outH}:flags=lanczos${tail}[${outLabel}]`;
  }
  const r = plan.region;
  return `[${inLabel}]crop=${r.w}:${r.h}:${r.x}:${r.y},split[${tag}f][${tag}b];`
    + `[${tag}b]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=20:2,eq=brightness=-0.15[${tag}bg];`
    + `[${tag}f]scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos[${tag}fg];`
    + `[${tag}bg][${tag}fg]overlay=(W-w)/2:(H-h)/2${tail}[${outLabel}]`;
}
