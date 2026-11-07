/**
 * exiftool-vendored wrapper for photolib. Lazy singleton; call closeExif() when done.
 * toExifInfo is pure and accepts both ExifDateTime-like objects and plain strings.
 */
import { ExifTool } from 'exiftool-vendored';
import type { ExifInfo } from './types';

let singleton: ExifTool | null = null;
function tool(): ExifTool {
  if (!singleton) singleton = new ExifTool({ maxProcs: 4 });
  return singleton;
}

export async function closeExif(): Promise<void> {
  if (!singleton) return;
  const t = singleton;
  singleton = null;
  await t.end();
}

/** Exposed for tests that need to write tags into fixtures. */
export function getExifTool(): ExifTool {
  return tool();
}

export async function readExif(absPath: string): Promise<ExifInfo> {
  const tags = await tool().read(absPath);
  return toExifInfo(tags as unknown as Record<string, unknown>);
}

export async function readExifBatch(paths: string[], opts?: { concurrency?: number }): Promise<Map<string, ExifInfo | null>> {
  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const out = new Map<string, ExifInfo | null>();
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      try {
        out.set(p, await readExif(p));
      } catch {
        out.set(p, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

// ---------- pure mapping ----------

const DT_RE = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** Raw string of a tag value: ExifDateTime-like (.rawValue) or string; otherwise null. */
function rawString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as { rawValue?: unknown; toISOString?: () => string };
    if (typeof o.rawValue === 'string') return o.rawValue;
    if (typeof o.toISOString === 'function') {
      try {
        return o.toISOString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface ParsedDt {
  local: string; // "YYYY:MM:DD HH:MM:SS"
  offset: string | null; // "+HH:MM" | "Z" | null
}
function parseDt(v: unknown): ParsedDt | null {
  const s = rawString(v);
  if (!s) return null;
  const m = DT_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y === 0 || mo === 0 || d === 0) return null; // "0000:00:00 00:00:00"
  let off: string | null = m[7] ?? null;
  if (off && off !== 'Z') off = off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
  return { local: `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`, offset: off };
}

function toUtcIso(p: ParsedDt, defaultUtc: boolean): string | null {
  let off = p.offset;
  if (!off) {
    if (!defaultUtc) return null;
    off = 'Z';
  }
  const iso = `${p.local.slice(0, 10).replace(/:/g, '-')}T${p.local.slice(11)}${off === 'Z' ? 'Z' : off}`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (v.trim() && Number.isFinite(n)) return n;
  }
  return null;
}
function coord(v: unknown, ref: unknown, neg: string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (!v.trim() || !Number.isFinite(n)) return null;
    return typeof ref === 'string' && ref.toUpperCase().startsWith(neg) && n > 0 ? -n : n;
  }
  return null;
}
function duration(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const hms = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const sec = /^(\d+(?:\.\d+)?)\s*s?$/.exec(s);
  return sec ? Number(sec[1]) : null;
}

function isVideoTags(t: Record<string, unknown>): boolean {
  const mime = str(t.MIMEType);
  if (mime) return mime.startsWith('video/');
  const ft = str(t.FileType);
  return !!ft && /^(MOV|MP4|M4V|3GP|3G2|QT)$/i.test(ft);
}

export function toExifInfo(tags: Record<string, unknown>): ExifInfo {
  const dto = parseDt(tags.DateTimeOriginal);
  const off = str(tags.OffsetTimeOriginal);
  const gps = parseDt(tags.GPSDateTime);
  const qc = parseDt(tags.CreationDate);
  const video = isVideoTags(tags);
  const cd = video ? parseDt(tags.CreateDate) : null;

  return {
    dateTimeOriginal: dto ? dto.local : null,
    offsetTimeOriginal: off && /^[+-]\d{2}:?\d{2}$/.test(off) ? (off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`) : null,
    gpsDateTimeUtc: gps ? toUtcIso(gps, true) : null,
    quicktimeCreationDate:
      qc && qc.offset ? `${qc.local}${qc.offset === 'Z' ? '+00:00' : qc.offset}` : null,
    quicktimeCreateDateUtc: cd ? toUtcIso(cd, true) : null,
    lat: coord(tags.GPSLatitude, tags.GPSLatitudeRef, 'S'),
    lon: coord(tags.GPSLongitude, tags.GPSLongitudeRef, 'W'),
    contentIdentifier: str(tags.ContentIdentifier),
    make: str(tags.Make),
    model: str(tags.Model),
    width: num(tags.ImageWidth),
    height: num(tags.ImageHeight),
    durationSec: duration(tags.Duration),
  };
}
