/**
 * Match merged label reads against Discogs search results.
 * scoreCandidate is pure; findCandidates spends at most 4 API calls per record.
 */
import type { DiscogsClient } from './client.ts';
import { ADD_THRESHOLD, type DiscogsCandidate, type LabelRead } from './types.ts';

export interface MergedRead {
  artist: string | null;
  title: string | null;
  label: string | null;
  catno: string | null;
  year: string | null;
  tracks: string[];
}

const W = { catno: 0.46, label: 0.30, artist: 0.25, title: 0.25, vinyl: 0.12, year: 0.03, filePenalty: 0.25, cdPenalty: 0.10 };

export function normalizeCatno(s: string): string {
  return s.toLowerCase().replace(/[\s\-._]+/g, '');
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\(\d+\)/g, ' ')          // Discogs disambiguator "Artist (2)"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 0..1 fuzzy similarity: exact, containment, else token Dice. */
function sim(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.replace(/ /g, '') === y.replace(/ /g, '')) return 1;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return 0.9;
  const tx = new Set(x.split(' ').filter(t => t !== 'the'));
  const ty = new Set(y.split(' ').filter(t => t !== 'the'));
  if (!tx.size || !ty.size) return 0;
  let hit = 0;
  for (const t of tx) if (ty.has(t)) hit++;
  return (2 * hit) / (tx.size + ty.size);
}

const part = (s: number) => (s >= 0.5 ? s : 0);

function resultFormats(result: any): string[] {
  const out: string[] = [];
  if (Array.isArray(result.format)) out.push(...result.format.map(String));
  if (Array.isArray(result.formats)) {
    for (const f of result.formats) { if (f?.name) out.push(String(f.name)); if (Array.isArray(f?.descriptions)) out.push(...f.descriptions.map(String)); }
  }
  return out;
}

export function scoreCandidate(read: MergedRead, result: any): DiscogsCandidate {
  const reasons: string[] = [];
  let score = 0;

  const fullTitle: string = String(result.title || '');
  const dash = fullTitle.indexOf(' - ');
  const rArtist = dash >= 0 ? fullTitle.slice(0, dash) : '';
  const rTitle = dash >= 0 ? fullTitle.slice(dash + 3) : fullTitle;
  const labels: string[] = Array.isArray(result.label) ? result.label.map(String) : result.label ? [String(result.label)] : [];
  const rCatno = String(result.catno || '');
  const formats = resultFormats(result);

  if (read.catno && rCatno) {
    // Discogs catno may hold several values ("DT-117, DT 117")
    const want = normalizeCatno(read.catno);
    if (rCatno.split(/[,/]/).some(c => normalizeCatno(c) === want)) { score += W.catno; reasons.push('catno exact'); }
    else if (normalizeCatno(rCatno).includes(want) || want.includes(normalizeCatno(rCatno))) { score += W.catno * 0.4; reasons.push('catno partial'); }
  }
  if (read.label) {
    const s = Math.max(0, ...labels.map(l => sim(read.label, l)));
    if (part(s)) { score += W.label * s; reasons.push(s === 1 ? 'label match' : `label ~${s.toFixed(2)}`); }
  }
  if (read.artist) {
    const s = sim(read.artist, rArtist);
    if (part(s)) { score += W.artist * s; reasons.push(s === 1 ? 'artist match' : `artist ~${s.toFixed(2)}`); }
  }
  if (read.title) {
    const s = sim(read.title, rTitle);
    if (part(s)) { score += W.title * s; reasons.push(s === 1 ? 'title match' : `title ~${s.toFixed(2)}`); }
  }

  const fmt = formats.map(f => f.toLowerCase());
  if (fmt.includes('vinyl')) { score += W.vinyl; reasons.push('vinyl'); }
  else if (fmt.some(f => ['file', 'wav', 'mp3', 'flac', 'aiff'].includes(f))) { score -= W.filePenalty; reasons.push('digital file (penalty)'); }
  else if (fmt.some(f => f === 'cd' || f === 'cdr')) { score -= W.cdPenalty; reasons.push('CD (penalty)'); }

  if (read.year && result.year && String(read.year).trim() === String(result.year).trim()) { score += W.year; reasons.push('year match'); }

  return {
    releaseId: Number(result.id),
    title: fullTitle,
    catno: rCatno,
    label: labels[0] || '',
    formats,
    country: result.country || null,
    year: result.year ? String(result.year) : null,
    score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    reasons,
  };
}

const RANK: Record<string, number> = { readable: 0, partial: 1, unreadable: 2 };

/** Combine the A/B side reads of one record. Earlier (better-status) reads win per field; tracks are unioned. */
export function mergeReads(reads: LabelRead[]): MergedRead {
  const sorted = [...reads].filter(r => r.status !== 'unreadable').sort((a, b) => RANK[a.status] - RANK[b.status]);
  const pick = (k: 'artist' | 'title' | 'label' | 'catno' | 'year') => {
    for (const r of sorted) { const v = r[k]?.trim(); if (v) return v; }
    return null;
  };
  const seen = new Set<string>();
  const tracks: string[] = [];
  for (const r of sorted) for (const t of r.tracks || []) {
    const key = norm(t);
    if (key && !seen.has(key)) { seen.add(key); tracks.push(t); }
  }
  return { artist: pick('artist'), title: pick('title'), label: pick('label'), catno: pick('catno'), year: pick('year'), tracks };
}

/** Query strategies in order; stops once a candidate reaches ADD_THRESHOLD. Max 4 API calls. */
export async function findCandidates(client: DiscogsClient, merged: MergedRead): Promise<DiscogsCandidate[]> {
  const strategies: Record<string, string>[] = [];
  const { catno, label, artist, title } = merged;
  if (catno && label) strategies.push({ catno, label });
  if (catno) strategies.push({ catno });
  if (artist && title) strategies.push({ artist, release_title: title, ...(label ? { label } : {}) });
  if (artist || title) strategies.push({ q: [artist, title].filter(Boolean).join(' ') });

  const byId = new Map<number, DiscogsCandidate>();
  for (const params of strategies.slice(0, 4)) {
    const r = await client.search({ ...params, per_page: '10' });
    for (const res of r.results || []) {
      const c = scoreCandidate(merged, res);
      const prev = byId.get(c.releaseId);
      if (!prev || c.score > prev.score) byId.set(c.releaseId, c);
    }
    if ([...byId.values()].some(c => c.score >= ADD_THRESHOLD)) break;
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}
