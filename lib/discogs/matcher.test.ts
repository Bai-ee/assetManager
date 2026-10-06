import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, normalizeCatno, mergeReads } from './matcher.ts';
import { ADD_THRESHOLD, REVIEW_THRESHOLD, type LabelRead } from './types.ts';

const dt = { id: 74379, title: 'Lith De Lanka - Fairy Tale', label: ['Deep Touch'], catno: 'DT- 117', format: ['Vinyl', '12"'], year: '1999', country: 'US' };
const read = { artist: 'Lith De Lanka', title: 'Fairy Tale', label: 'Deep Touch', catno: 'DT-117', year: null, tracks: [] };

test('normalizeCatno', () => {
  assert.equal(normalizeCatno('DT- 117'), 'dt117');
  assert.equal(normalizeCatno('dfun 001'), normalizeCatno('DFUN-001'));
});

test('catno spacing variants all score >= ADD', () => {
  for (const c of ['DT-117', 'DT- 117', 'dt 117', 'DT117']) {
    const s = scoreCandidate({ ...read, artist: null, title: null }, { ...dt, catno: c });
    assert.ok(s.score >= ADD_THRESHOLD, `${c}: ${s.score}`);
  }
});

test('catno+label vinyl beats WAV file', () => {
  const r = { artist: null, title: null, label: 'In The Air', catno: 'IN 003', year: null, tracks: [] };
  const vinyl = scoreCandidate(r, { id: 1, title: 'X - Y', label: ['In The Air'], catno: 'IN003', format: ['Vinyl', '12"'] });
  const wav = scoreCandidate(r, { id: 2, title: 'X - Y', label: ['In The Air'], catno: 'IN 003', format: ['File', 'WAV'] });
  assert.ok(vinyl.score >= ADD_THRESHOLD);
  assert.ok(vinyl.score > wav.score);
  assert.ok(wav.score < ADD_THRESHOLD);
});

test('artist+title only (no catno/label match) lands in review band', () => {
  const s = scoreCandidate({ ...read, catno: null, label: null }, dt);
  assert.ok(s.score >= REVIEW_THRESHOLD && s.score < ADD_THRESHOLD, String(s.score));
});

test('artist+title+label without catno can reach ADD', () => {
  const s = scoreCandidate({ ...read, catno: null }, dt);
  assert.ok(s.score >= ADD_THRESHOLD, String(s.score));
});

test('wrong catno, different artist, same label stays below ADD', () => {
  const s = scoreCandidate(read, { id: 3, title: 'Other Guy - Other Song', label: ['Deep Touch'], catno: 'DT-999', format: ['Vinyl'] });
  assert.ok(s.score < ADD_THRESHOLD);
});

test('no catno and no artist -> low', () => {
  const s = scoreCandidate({ artist: null, title: 'Fairy Tale', label: null, catno: null, year: null, tracks: [] }, dt);
  assert.ok(s.score < REVIEW_THRESHOLD, String(s.score));
});

test('score clamped 0..1 with reasons', () => {
  const s = scoreCandidate({ ...read, year: '1999' }, dt);
  assert.ok(s.score <= 1 && s.score >= 0 && s.reasons.includes('catno exact'));
  const bad = scoreCandidate(read, { id: 4, title: 'Z - Z', label: ['Q'], catno: 'Q', format: ['File'] });
  assert.equal(bad.score, 0);
});

test('mergeReads prefers readable, unions tracks', () => {
  const base = { file: 'a', artist: null, title: null, label: null, catno: null, year: null, tracks: [], side: null, notes: null, model: 'm', cached: false } as LabelRead;
  const m = mergeReads([
    { ...base, status: 'partial', label: 'Wrong', catno: 'DT-117', tracks: ['Fairy Tale', 'Dub'] },
    { ...base, status: 'readable', label: 'Deep Touch', artist: 'Lith De Lanka', tracks: ['fairy tale', 'Other'] },
    { ...base, status: 'unreadable', label: 'Junk' },
  ]);
  assert.equal(m.label, 'Deep Touch');
  assert.equal(m.catno, 'DT-117');
  assert.deepEqual(m.tracks, ['fairy tale', 'Other', 'Dub']);
});
