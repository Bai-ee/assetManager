import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEventDates } from './event-date';

const flyer = (t: string, o: { windowFrom?: number; windowTo?: number } = {}) => extractEventDates(t, { kind: 'flyer', ...o });

test('weekday + M/D resolves a single year', () => {
  const r = flyer('THURSDAY 11/15 HOUSEPIT.CHI STRIZ BIRTHDAY');
  assert.equal(r.eventDate, '2018-11-15'); assert.equal(r.eventYearSource, 'weekday'); assert.equal(r.eventMonthDay, '11-15');
  assert.equal(flyer('THURSDAY 12/13').eventDate, '2018-12-13');
});

test('weekday that fits several years leaves year null with candidates', () => {
  const r = flyer('FRIDAY, MAY 24 ... MILLENNIUM PARK');
  assert.equal(r.eventMonthDay, '05-24'); assert.equal(r.eventYear, null); assert.equal(r.eventDate, null);
  assert.deepEqual(r.eventYearCandidates, [2019, 2024]);
  const narrowed = flyer('FRIDAY, MAY 24 ... MILLENNIUM PARK', { windowFrom: 2014, windowTo: 2023 });
  assert.equal(narrowed.eventDate, '2019-05-24'); assert.equal(narrowed.eventYearSource, 'weekday'); assert.deepEqual(narrowed.eventYearCandidates, []);
});

test('dotted M.D with weekday', () => {
  const r = flyer('#CHMF AFTER SET SATURDAY 5.25 / 11PM', { windowTo: 2023 });
  assert.equal(r.eventMonthDay, '05-25'); assert.equal(r.eventYear, 2019); assert.equal(r.eventYearSource, 'weekday');
});

test('printed years always win', () => {
  const a = flyer('BLONDE EVENTS PRESENTS LOFT FREQUENCIES 3 08/04/2018');
  assert.equal(a.eventDate, '2018-08-04'); assert.equal(a.eventYearSource, 'printed');
  const b = flyer('TRAXX ... 4/27/19 11PM');
  assert.equal(b.eventDate, '2019-04-27'); assert.equal(b.eventYearSource, 'printed');
  const c = flyer('#POSTPONED MARCH 13TH 2020 • LE NOCTURNE');
  assert.equal(c.eventDate, '2020-03-13'); assert.equal(c.eventYearSource, 'printed'); assert.equal(c.eventDateRaw, 'MARCH 13TH 2020');
});

test('times, prices, addresses and phone numbers are not dates', () => {
  const r = flyer('TUESDAYS 9PM @ EAST ROOM 2354 N MILWAUKEE AVE');
  assert.equal(r.eventMonthDay, null); assert.deepEqual(r.eventDates, []);
  for (const t of ['DOORS 9-11', '10:30 TIL LATE', '$10/$15 AT THE DOOR', 'ADV $10/15', 'RATING 1.5', 'CALL 312-555-1234', '9/11PM']) {
    assert.equal(flyer(t).eventMonthDay, null, t);
  }
});

test('TUESDAYS @ 10PM ... 10/30 infers 2018', () => {
  const r = flyer('TUESDAYS @ 10PM @ EAST ROOM 10/30');
  assert.equal(r.eventDate, '2018-10-30'); assert.equal(r.eventYearSource, 'weekday');
});

test('month/day only is valid', () => {
  const r = flyer('JUNE 20 BEING A PART OF MARK ZUCKERBERG');
  assert.equal(r.eventMonthDay, '06-20'); assert.equal(r.eventYear, null); assert.equal(r.eventDate, null); assert.deepEqual(r.eventYearCandidates, []);
});

test('non-flyer kinds and empty text return nothing', () => {
  for (const kind of ['party-photo', 'other', undefined]) {
    const r = extractEventDates('THURSDAY 11/15 4/27/19', { kind });
    assert.equal(r.eventDate, null); assert.equal(r.eventMonthDay, null); assert.deepEqual(r.eventDates, []);
  }
  assert.equal(flyer('').eventDateRaw, null);
});

test('ISO-looking strings get no special treatment', () => {
  assert.equal(flyer('2018-11-15T00:00:00Z').eventMonthDay, null);
});

test('formats: day-first, ordinals, ranges, abbreviations, validation', () => {
  assert.equal(flyer('24 MAY').eventMonthDay, '05-24');
  assert.equal(flyer('SAT MAY 25TH').eventMonthDay, '05-25');
  const range = flyer('MAY 24-25 2019');
  assert.equal(range.eventDate, '2019-05-24');
  assert.equal(flyer('M.D 5.25.19').eventDate, '2019-05-25');
  assert.equal(flyer('11-15-2018').eventDate, '2018-11-15');
  assert.equal(flyer('2/30/2019').eventMonthDay, null);
  assert.equal(flyer('2/29/2019').eventMonthDay, null);
  assert.equal(flyer('2/29/2020').eventDate, '2020-02-29');
  assert.equal(flyer('FEB 29').eventMonthDay, '02-29');
  assert.equal(flyer('13/5').eventMonthDay, null);
  assert.equal(flyer('4/27/45').eventYear, null); // two-digit year outside 10..39 ignored, month/day kept
  assert.equal(flyer('4/27/45').eventMonthDay, '04-27');
});

test('primary prefers the first date with a year; multiple dates are distinct and capped', () => {
  const r = flyer('JUNE 20 AND 4/27/19 AND 4/27/19 AND 1/1 2/2 3/3 4/4 5/5 6/6');
  assert.equal(r.eventDate, '2019-04-27'); assert.equal(r.eventDates[0].monthDay, '06-20');
  assert.equal(r.eventDates.length, 5);
  assert.equal(new Set(r.eventDates.map(d => `${d.monthDay}|${d.year}`)).size, 5);
});

test('weekday that fits no year in the window is ignored', () => {
  const r = flyer('MONDAY 11/15', { windowFrom: 2018, windowTo: 2018 });
  assert.equal(r.eventMonthDay, '11-15'); assert.equal(r.eventYear, null); assert.deepEqual(r.eventYearCandidates, []);
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backfillDates } from './backfill-dates';

test('backfill walker updates only flyers missing the fields, atomically; dry-run writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  const mk = (kind: string, ocrText: string, extra: object = {}) => ({ sha256: 'x', facets: { ocrText, vibe: { kind }, ...extra } });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(mk('flyer', 'THURSDAY 11/15')));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(mk('flyer', 'JUNE 20')));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(mk('party-photo', '4/27/19')));
  fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify(mk('flyer', '4/27/19', { eventDateRaw: null })));
  fs.writeFileSync(path.join(dir, 'e.json'), '{broken');
  const before = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
  const dry = backfillDates(dir, { dryRun: true });
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), before);
  assert.deepEqual([dry.files, dry.flyers, dry.updated, dry.unreadable], [5, 3, 2, 1]);
  const real = backfillDates(dir);
  assert.equal(real.updated, 2); assert.equal(real.withEventDate, 1); assert.equal(real.monthDayOnly, 1); assert.equal(real.weekdayInferred, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).facets.eventDate, '2018-11-15');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'c.json'), 'utf8')).facets.eventDateRaw, undefined);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp-')), []);
  fs.rmSync(dir, { recursive: true });
});
