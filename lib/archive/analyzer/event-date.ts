/**
 * Flyer EVENT-DATE extraction. Pure, no I/O, no model calls.
 *
 * HARD RULE: the date comes ONLY from the flyer's own printed text (facets.ocrText) and ONLY when the
 * image was classified as a flyer. File metadata, folder paths and the model's eraYear guess are never
 * inputs. A missing year is inferred only from a printed weekday that fits exactly one year in the window.
 */

export type EventYearSource = 'printed' | 'weekday' | null;

export interface EventDateEntry { monthDay: string; year: number | null; yearSource: EventYearSource; raw: string; weekday: string | null }

export interface EventDateResult {
  /** YYYY-MM-DD, only when the year is known. */
  eventDate: string | null;
  /** 'MM-DD' of the primary date. */
  eventMonthDay: string | null;
  eventYear: number | null;
  eventYearSource: EventYearSource;
  /** Years that fit the printed weekday when more than one does; empty otherwise. */
  eventYearCandidates: number[];
  /** The matched printed text of the primary date. */
  eventDateRaw: string | null;
  eventDates: EventDateEntry[];
}

export interface EventDateOptions { kind?: string; windowFrom?: number; windowTo?: number }

export const EMPTY_EVENT_DATE: EventDateResult = Object.freeze({
  eventDate: null, eventMonthDay: null, eventYear: null, eventYearSource: null, eventYearCandidates: [], eventDateRaw: null, eventDates: [],
}) as EventDateResult;

const MAX_DATES = 5;
const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_RE = '(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)';
const WEEKDAY_RE = /\b(MON(?:DAY)?S?|TUES?(?:DAY)?S?|WED(?:NESDAY)?S?|THU(?:RS?)?(?:DAY)?S?|FRI(?:DAY)?S?|SAT(?:URDAY)?S?|SUN(?:DAY)?S?)\b/g;

const MONTH_FIRST = new RegExp(`\\b${MONTH_RE}\\.?\\s*(\\d{1,2})(?:ST|ND|RD|TH)?(?!\\d)(?:\\s*[-–—]\\s*\\d{1,2}(?!\\d))?(?:,?\\s+((?:19|20)\\d{2})(?!\\d))?`, 'g');
const DAY_FIRST = new RegExp(`(?<![\\d$:./-])(\\d{1,2})(?:ST|ND|RD|TH)?\\s+(?:OF\\s+)?${MONTH_RE}\\b\\.?(?:,?\\s+((?:19|20)\\d{2})(?!\\d))?`, 'g');
const NUMERIC = /(?<![\d$:./\\-])(\d{1,2})([/.\-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d:])/g;

const clone = (): EventDateResult => ({ ...EMPTY_EVENT_DATE, eventYearCandidates: [], eventDates: [] });
const pad = (n: number) => String(n).padStart(2, '0');

function daysIn(month: number, year: number | null): number {
  if (month === 2) return year == null ? 29 : new Date(Date.UTC(year, 2, 0)).getUTCDate();
  return [31, 28, 30, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 0;
}
function validMonthDay(month: number, day: number, year: number | null): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(month, year);
}
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

interface Raw { index: number; end: number; month: number; day: number; year: number | null; raw: string; numeric: boolean; sep?: string }

function collect(text: string): Raw[] {
  const out: Raw[] = [];
  const notTime = (end: number) => !/^\s*[AP]\.?M\b/.test(text.slice(end)) && !/^:\d/.test(text.slice(end));
  for (const m of Array.from(text.matchAll(MONTH_FIRST))) {
    const month = MONTHS[m[1].slice(0, 3)];
    const end = m.index! + m[0].length;
    // a range's trailing day must not read as a time ("MAY 24 9PM" is handled by the next date check)
    const dayEnd = m.index! + m[0].indexOf(m[2]) + m[2].length;
    if (!notTime(dayEnd)) continue;
    out.push({ index: m.index!, end, month, day: Number(m[2]), year: m[3] ? Number(m[3]) : null, raw: m[0].trim(), numeric: false });
  }
  for (const m of Array.from(text.matchAll(DAY_FIRST))) {
    const end = m.index! + m[0].length;
    const dayEnd = m.index! + m[1].length;
    if (!notTime(dayEnd) && /^\s*[AP]\.?M/.test(text.slice(dayEnd))) continue;
    out.push({ index: m.index!, end, month: MONTHS[m[2].slice(0, 3)], day: Number(m[1]), year: m[3] ? Number(m[3]) : null, raw: m[0].trim(), numeric: false });
  }
  for (const m of Array.from(text.matchAll(NUMERIC))) {
    const end = m.index! + m[0].length;
    if (/^\s*[AP]\.?M\b/.test(text.slice(end))) continue;      // "9/11PM"
    if (/^[/.\-]\d/.test(text.slice(end))) continue;            // part of a longer number chain
    let year: number | null = null;
    if (m[4]) {
      if (m[4].length === 4) { const y = Number(m[4]); if (y >= 1900 && y <= 2099) year = y; else continue; }
      else { const yy = Number(m[4]); if (yy >= 10 && yy <= 39) year = 2000 + yy; }
    }
    out.push({ index: m.index!, end, month: Number(m[1]), day: Number(m[3]), year, raw: m[0].trim(), numeric: true, sep: m[2] });
  }
  // Drop overlaps (keep earliest/longest) and sort in reading order.
  out.sort((a, b) => a.index - b.index || b.end - a.end);
  const kept: Raw[] = [];
  for (const r of out) if (!kept.length || r.index >= kept[kept.length - 1].end) kept.push(r);
  return kept;
}

/** Nearest printed weekday: up to 30 chars before (not crossing another date) or 12 chars after. */
function findWeekday(text: string, r: Raw, prevEnd: number, nextStart: number): string | null {
  const before = text.slice(Math.max(prevEnd, r.index - 30), r.index);
  let best: { name: string; dist: number } | null = null;
  for (const m of Array.from(before.matchAll(WEEKDAY_RE))) {
    const dist = before.length - (m.index! + m[0].length);
    if (!best || dist < best.dist) best = { name: m[1].slice(0, 3), dist };
  }
  const after = text.slice(r.end, Math.min(nextStart, r.end + 12));
  for (const m of Array.from(after.matchAll(WEEKDAY_RE))) {
    if (!best || m.index! < best.dist) best = { name: m[1].slice(0, 3), dist: m.index! };
    break;
  }
  return best ? best.name : null;
}

export function extractEventDates(ocrText: string, opts: EventDateOptions = {}): EventDateResult {
  if (opts.kind !== 'flyer' || typeof ocrText !== 'string' || !ocrText.trim()) return clone();
  const windowFrom = opts.windowFrom ?? 2014;
  const windowTo = opts.windowTo ?? new Date().getUTCFullYear() + 1;
  const text = ocrText.toUpperCase().replace(/\s+/g, ' ');
  const raws = collect(text);

  type Parsed = EventDateEntry & { candidates: number[] };
  const parsed: Parsed[] = [];
  const seen = new Set<string>();
  raws.forEach((r, i) => {
    const prevEnd = i > 0 ? raws[i - 1].end : 0;
    const nextStart = i + 1 < raws.length ? raws[i + 1].index : text.length;
    const weekday = findWeekday(text, r, prevEnd, nextStart);
    // Ambiguous numeric shapes need a weekday (or a year) to count as a date.
    if (r.numeric && r.year == null && r.sep !== '/' && !weekday) return;
    if (!validMonthDay(r.month, r.day, r.year)) return;

    let year = r.year;
    let yearSource: EventYearSource = year != null ? 'printed' : null;
    let candidates: number[] = [];
    if (year == null && weekday) {
      const wd = WEEKDAY_NAMES.indexOf(weekday);
      for (let y = windowFrom; y <= windowTo; y++) {
        if (validMonthDay(r.month, r.day, y) && weekdayOf(y, r.month, r.day) === wd) candidates.push(y);
      }
      if (candidates.length === 1) { year = candidates[0]; yearSource = 'weekday'; candidates = []; }
    }
    const monthDay = `${pad(r.month)}-${pad(r.day)}`;
    const dedupe = `${monthDay}|${year}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    parsed.push({ monthDay, year, yearSource, raw: r.raw, weekday, candidates });
  });

  if (!parsed.length) return clone();
  const primary = parsed.find(p => p.year != null) ?? parsed[0];
  return {
    eventDate: primary.year != null ? `${primary.year}-${primary.monthDay}` : null,
    eventMonthDay: primary.monthDay,
    eventYear: primary.year,
    eventYearSource: primary.yearSource,
    eventYearCandidates: primary.year == null ? primary.candidates : [],
    eventDateRaw: primary.raw,
    eventDates: parsed.slice(0, MAX_DATES).map(({ candidates: _c, ...e }) => e),
  };
}

/** Flat facet fields written onto Facets (all optional there so old cache files stay valid). */
export type EventDateFacetFields = EventDateResult;

/** Returns facets with the event-date fields computed from ocrText + vibe.kind only. Pure. */
export function withEventDates<F extends { ocrText: string; vibe: { kind: string } }>(facets: F, opts: { windowFrom?: number; windowTo?: number } = {}): F & EventDateFacetFields {
  return { ...facets, ...extractEventDates(facets.ocrText, { kind: facets.vibe?.kind, ...opts }) };
}
