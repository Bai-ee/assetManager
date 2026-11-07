/**
 * Date policy for photolib (see docs/archive/PHOTOLIB.md "Date policy"). Pure.
 * Precedence: library-db > exif > quicktime > unknown. Never uses file mtime.
 */
import type { ExifInfo, LibraryItem, ResolvedDate } from './types';

const MIN_YEAR = 1990;
const MAX_OFFSET_SEC = 14 * 3600;

const UNKNOWN: ResolvedDate = { takenLocal: null, tz: null, tzOffsetSec: null, tsUtc: null, tsSource: null, tsKind: 'unknown' };

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 19800 → "+05:30"; -25200 → "-07:00". */
export function formatOffset(sec: number): string {
  const sign = sec < 0 ? '-' : '+';
  const a = Math.abs(Math.round(sec));
  return `${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
}

/** "+05:30" | "-0700" | "Z" → seconds, or null when unparseable. */
export function parseOffset(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (t === 'Z' || t === 'z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 14 || mi > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (h * 3600 + mi * 60);
}

/** Parse a local wall clock ("YYYY:MM:DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS", optional trailing tz) → ms treating wall clock as UTC. */
function wallClockMs(s: string): { ms: number; offsetSec: number | null } | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  if (Number.isNaN(ms)) return null;
  const offsetSec = m[7] ? parseOffset(m[7]) : null;
  if (m[7] && offsetSec === null) return null;
  return { ms, offsetSec };
}

function localIso(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
}
function utcIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function exact(wallMs: number, offsetSec: number, source: ResolvedDate['tsSource']): ResolvedDate {
  return {
    takenLocal: localIso(wallMs),
    tz: formatOffset(offsetSec),
    tzOffsetSec: offsetSec,
    tsUtc: utcIso(wallMs - offsetSec * 1000),
    tsSource: source,
    tsKind: 'exact',
  };
}

function localOnly(wallMs: number, source: ResolvedDate['tsSource']): ResolvedDate {
  return { takenLocal: localIso(wallMs), tz: null, tzOffsetSec: null, tsUtc: null, tsSource: source, tsKind: 'local-only' };
}

export function resolveTakenDate(item: Pick<LibraryItem, 'imageDateUtc' | 'tzOffsetSec'>, exif: ExifInfo | null): ResolvedDate {
  // 1. Library DB instant.
  if (item.imageDateUtc) {
    const t = Date.parse(item.imageDateUtc);
    if (!Number.isNaN(t) && new Date(t).getUTCFullYear() >= MIN_YEAR) {
      const off = item.tzOffsetSec;
      if (off !== null && off !== undefined && Math.abs(off) <= MAX_OFFSET_SEC) {
        // Library offsets can be LMT-style (e.g. -05:59). The local wall clock (utc + raw offset) matches EXIF,
        // so keep it and round the offset to 15 min; tsUtc is recomputed from the rounded offset.
        const rounded = Math.round(off / 900) * 900;
        return exact(t + off * 1000, rounded, 'library-db');
      }
      const dto = exif?.dateTimeOriginal ? wallClockMs(exif.dateTimeOriginal) : null;
      if (dto) return { ...localOnly(dto.ms, 'library-db') };
      return exact(t, 0, 'library-db');
    }
  }

  if (exif) {
    // 2. EXIF DateTimeOriginal.
    const dto = exif.dateTimeOriginal ? wallClockMs(exif.dateTimeOriginal) : null;
    if (dto) {
      const explicit = parseOffset(exif.offsetTimeOriginal);
      if (explicit !== null) return exact(dto.ms, explicit, 'exif');
      if (exif.gpsDateTimeUtc) {
        const g = Date.parse(exif.gpsDateTimeUtc);
        if (!Number.isNaN(g)) {
          const off = Math.round((dto.ms - g) / 1000 / 900) * 900;
          if (Math.abs(off) <= MAX_OFFSET_SEC) return exact(dto.ms, off, 'exif');
        }
      }
      return localOnly(dto.ms, 'exif');
    }

    // 3. QuickTime.
    const qc = exif.quicktimeCreationDate ? wallClockMs(exif.quicktimeCreationDate) : null;
    if (qc && qc.offsetSec !== null) return exact(qc.ms, qc.offsetSec, 'quicktime');
    if (exif.quicktimeCreateDateUtc) {
      const t = Date.parse(exif.quicktimeCreateDateUtc);
      if (!Number.isNaN(t) && new Date(t).getUTCFullYear() >= MIN_YEAR) return exact(t, 0, 'quicktime');
    }
  }

  // 4. Unknown.
  return { ...UNKNOWN };
}

/** Month/day buckets from LOCAL capture time (never UTC). */
export function bucketOf(d: ResolvedDate): { ym: string; day: string | null } {
  if (!d.takenLocal) return { ym: 'unknown', day: null };
  return { ym: d.takenLocal.slice(0, 7), day: d.takenLocal.slice(0, 10) };
}
