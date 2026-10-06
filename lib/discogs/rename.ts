/**
 * Rename source files for confidently matched records, with an append-only
 * journal so every rename can be undone. Never deletes anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiscogsCandidate, MediaFile, RecordGroup } from './types';

export interface RenamePair { from: string; to: string }
export interface RenameSkip { from: string; to: string; reason: string }

const MAX_BASE = 100;

function cleanArtist(a: string): string {
  return a
    .trim()
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\*+$/, '')
    .trim();
}

export function releaseNameParts(best: DiscogsCandidate): { catno: string; artist: string; title: string } {
  const full = best.title ?? '';
  const i = full.indexOf(' - ');
  const rawArtist = i >= 0 ? full.slice(0, i) : '';
  const title = (i >= 0 ? full.slice(i + 3) : full).trim();
  // Disambiguators can also sit on individual names in multi-artist credits.
  const artist = rawArtist
    .split(/(\s+&\s+|,\s+)/)
    .map((p) => (/^\s*(&|,)\s*$/.test(p) ? p : cleanArtist(p)))
    .join('');
  const catno = (best.catno ?? '').split(/[,/]/)[0].trim();
  return { catno, artist: artist.trim(), title };
}

export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function truncateBase(base: string): string {
  if (base.length <= MAX_BASE) return base;
  const cut = base.slice(0, MAX_BASE);
  const dash = cut.lastIndexOf('-');
  // Only cut at a boundary if it doesn't throw away most of the name.
  const out = dash > MAX_BASE / 2 ? cut.slice(0, dash) : cut;
  return out.replace(/[-.]+$/, '');
}

function byCapture(a: MediaFile, b: MediaFile): number {
  const ta = Date.parse(a.capturedAt ?? a.mtime);
  const tb = Date.parse(b.capturedAt ?? b.mtime);
  if (ta !== tb) return ta - tb;
  return a.name.localeCompare(b.name);
}

export function plannedNames(group: RecordGroup, best: DiscogsCandidate): RenamePair[] {
  const { catno, artist, title } = releaseNameParts(best);
  const base = truncateBase([slug(catno), slug(artist), slug(title)].join('_'));
  const out: RenamePair[] = [];
  const add = (files: MediaFile[], label: string) => {
    [...files].sort(byCapture).forEach((f, idx) => {
      const ext = path.extname(f.path).toLowerCase();
      const to = path.join(path.dirname(f.path), `${base}_${label}${idx + 1}${ext}`);
      if (to !== f.path) out.push({ from: f.path, to });
    });
  };
  add(group.images, 'label');
  add(group.videos, 'video');
  return out;
}

function exists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function withSuffix(target: string, n: number): string {
  const ext = path.extname(target);
  return `${target.slice(0, target.length - ext.length)}-${n}${ext}`;
}

export async function applyRenames(
  pairs: RenamePair[],
  journalPath: string,
): Promise<{ renamed: number; skipped: RenameSkip[] }> {
  let renamed = 0;
  const skipped: RenameSkip[] = [];
  for (const { from, to } of pairs) {
    if (!exists(from)) { skipped.push({ from, to, reason: 'source missing' }); continue; }
    if (from === to) { skipped.push({ from, to, reason: 'already named' }); continue; }
    let target = to;
    for (let n = 2; exists(target); n++) target = withSuffix(to, n);
    try {
      await fs.promises.rename(from, target);
    } catch (e) {
      skipped.push({ from, to: target, reason: `rename failed: ${(e as Error).message}` });
      continue;
    }
    fs.appendFileSync(journalPath, JSON.stringify({ from, to: target, at: new Date().toISOString() }) + '\n');
    renamed++;
  }
  return { renamed, skipped };
}

export async function undoRenames(
  journalPath: string,
): Promise<{ restored: number; skipped: RenameSkip[] }> {
  let restored = 0;
  const skipped: RenameSkip[] = [];
  if (!exists(journalPath)) return { restored, skipped };
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim());
  for (const line of lines.reverse()) {
    let rec: { from: string; to: string };
    try { rec = JSON.parse(line); } catch { skipped.push({ from: '', to: '', reason: 'bad journal line' }); continue; }
    const { from, to } = rec;
    if (!exists(to)) { skipped.push({ from, to, reason: 'renamed file missing' }); continue; }
    if (exists(from)) { skipped.push({ from, to, reason: 'original path occupied' }); continue; }
    try {
      await fs.promises.rename(to, from);
      restored++;
    } catch (e) {
      skipped.push({ from, to, reason: `rename failed: ${(e as Error).message}` });
    }
  }
  return { restored, skipped };
}
