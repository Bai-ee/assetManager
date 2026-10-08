/**
 * Backfill flyer event-date fields into existing analyzer cache files. No network, no Claude.
 *   tsx lib/archive/analyzer/backfill-dates.ts [--dry-run]
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEventDates } from './event-date';

export interface BackfillSummary { files: number; flyers: number; updated: number; withEventDate: number; monthDayOnly: number; weekdayInferred: number; ambiguous: number; none: number; unreadable: number }

export function backfillDates(cacheDir: string, opts: { dryRun?: boolean } = {}): BackfillSummary {
  const s: BackfillSummary = { files: 0, flyers: 0, updated: 0, withEventDate: 0, monthDayOnly: 0, weekdayInferred: 0, ambiguous: 0, none: 0, unreadable: 0 };
  let names: string[] = [];
  try { names = fs.readdirSync(cacheDir).filter(n => n.endsWith('.json')).sort(); } catch { return s; }
  for (const name of names) {
    const file = path.join(cacheDir, name);
    s.files++;
    let entry: any;
    try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s.unreadable++; continue; }
    const f = entry?.facets;
    if (!f || f.vibe?.kind !== 'flyer' || typeof f.ocrText !== 'string') continue;
    s.flyers++;
    const needs = f.eventDateRaw === undefined;
    const next = needs ? withEventDates(f) : f;
    if (next.eventDate) s.withEventDate++;
    else if (next.eventMonthDay) s.monthDayOnly++;
    else s.none++;
    if (next.eventYearSource === 'weekday') s.weekdayInferred++;
    if (next.eventYearCandidates?.length) s.ambiguous++;
    if (!needs) continue;
    s.updated++;
    if (opts.dryRun) continue;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...entry, facets: next }));
    fs.renameSync(tmp, file);
  }
  return s;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const home = process.env.ARCHIVE_ANALYZER_HOME || path.join(os.homedir(), '.archive-analyzer');
  const cacheDir = path.join(home, 'cache');
  const s = backfillDates(cacheDir, { dryRun });
  console.log(`${dryRun ? '[dry-run] ' : ''}event-date backfill: ${cacheDir}`);
  console.table({
    'cache files': s.files, 'flyers': s.flyers, 'with eventDate (year known)': s.withEventDate, 'month/day only': s.monthDayOnly,
    'weekday-inferred year': s.weekdayInferred, 'ambiguous (weekday fits several years)': s.ambiguous, 'no date': s.none,
    [dryRun ? 'would update' : 'updated']: s.updated, 'unreadable': s.unreadable,
  });
}

if (require.main === module) main();
