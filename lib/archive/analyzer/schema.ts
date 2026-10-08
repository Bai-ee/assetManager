import { JEV_QUESTIONS } from '../jev/taxonomy';
import { withEventDates, type EventDateResult } from './event-date';

/** Bump when the prompt or tool schema changes meaningfully; part of the cache key. */
export const PROMPT_VERSION = 'facets-v1';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const TOOL_NAME = 'record_facets';

export const VIBE_KINDS = ['flyer', 'party-photo', 'performance', 'gear', 'portrait', 'crowd', 'record', 'video', 'screenshot', 'other'] as const;
export const JEV_IDS = ['pillar', 'series', 'era', 'clientWork', 'postability', 'entities'] as const;
export type JevId = (typeof JEV_IDS)[number];

export interface JevAnswer { value: string | string[] | null; confidence: number }
export type JevAnswers = Partial<Record<JevId, JevAnswer>>;

/** Event-date fields (via Partial<EventDateResult>) derive from ocrText only (see event-date.ts); optional so old cache entries stay valid. */
export interface Facets extends Partial<EventDateResult> {
  people: string[]; crews: string[]; labels: string[]; venues: string[]; cities: string[]; partyNames: string[];
  dateText: string | null; eraYear: number | null; gear: string[]; genres: string[]; ocrText: string;
  vibe: { light: 'dark' | 'light' | null; time: 'night' | 'day' | null; kind: (typeof VIBE_KINDS)[number]; mood: string[] };
}

export interface SanitizedAnalysis { facets: Facets; summary: string; activity: string; peopleCount: number; jev: JevAnswers }

const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

function jevProperty(id: JevId) {
  const q = JEV_QUESTIONS.find(x => x.id === id);
  const value = q && !q.openEnded && q.choices.length
    ? { type: ['string', 'null'], enum: [...q.choices, null], description: q.question }
    : { type: 'array', items: { type: 'string' }, description: q?.question ?? id };
  return { type: 'object', properties: { value, confidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['value', 'confidence'] };
}

export const TOOL = {
  name: TOOL_NAME,
  description: 'Record structured facets for one archive image or one video (given as a 2x2 grid of keyframes).',
  input_schema: {
    type: 'object',
    properties: {
      people: strArr('ONLY names legibly printed in the image (e.g. flyer line-up) or present in the folder path hints. NEVER identify anyone from their face or appearance.'),
      crews: strArr('Crew / collective names printed in the image or in the path.'),
      labels: strArr('Record label names printed in the image or path.'),
      venues: strArr('Venue names printed in the image or path.'),
      cities: strArr('City names printed in the image or path.'),
      partyNames: strArr('Party / event names printed in the image or path.'),
      dateText: { type: ['string', 'null'], description: 'Date text exactly as printed, or null.' },
      eraYear: { type: ['integer', 'null'], description: 'Best-guess 4-digit year from printed text or clear visual era cues, else null.' },
      gear: strArr('Visible music/DJ/studio gear (e.g. "Technics SL-1200", "Roland TR-909").'),
      genres: strArr('Genres only if printed or strongly implied by the material.'),
      ocrText: { type: 'string', description: 'Legible text in the image, max 600 chars.' },
      vibe: {
        type: 'object',
        properties: {
          light: { type: ['string', 'null'], enum: ['dark', 'light', null] },
          time: { type: ['string', 'null'], enum: ['night', 'day', null] },
          kind: { type: 'string', enum: [...VIBE_KINDS] },
          mood: strArr('1-4 short mood words.'),
        },
        required: ['light', 'time', 'kind', 'mood'],
      },
      peopleCount: { type: 'integer', minimum: 0, description: 'Number of people visible (count only; no identification).' },
      activity: { type: 'string', description: 'Generic one-line activity, max 160 chars, no identification. E.g. "a DJ playing records at a crowded party".' },
      summary: { type: 'string', description: 'Neutral description, max 200 chars, usable as a placeholder caption.' },
      jev: {
        type: 'object',
        properties: Object.fromEntries(JEV_IDS.map(id => [id, jevProperty(id)])),
        required: [...JEV_IDS],
      },
    },
    required: ['people', 'crews', 'labels', 'venues', 'cities', 'partyNames', 'dateText', 'eraYear', 'gear', 'genres', 'ocrText', 'vibe', 'peopleCount', 'activity', 'summary', 'jev'],
  },
};

export function buildPrompt(relativePath: string, kind: 'image' | 'video'): string {
  const hints = relativePath.split('/').filter(Boolean).join(' / ');
  return [
    kind === 'video'
      ? 'This is a 2x2 grid of four keyframes (about 10%, 35%, 60%, 85% through one video), read left-to-right, top-to-bottom.'
      : 'This is one image from a personal music/DJ/party/design archive.',
    `Folder path hints (relative, may contain names/venues/years): ${hints}`,
    'Respond by calling the record_facets tool exactly once.',
    'Rules:',
    '- people: ONLY names you can read as text in the image (flyer line-ups, captions) or that appear in the folder path hints. NEVER infer anyone\'s identity from their face, body or appearance. If none, [].',
    '- Other name fields (crews, labels, venues, cities, partyNames) likewise only from printed text or the path hints.',
    '- Use null / [] when unknown. Never guess catalog numbers, dates or names.',
    '- activity and summary must be generic and must not name anyone unless that name is printed or in the path.',
    '- jev: answer each question from the allowed values with a calibrated confidence 0-1; use low confidence when unsure.',
  ].join('\n');
}

// ---- sanitization ----------------------------------------------------------

const GENERIC_PERSON = new Set(['man', 'woman', 'person', 'people', 'guy', 'girl', 'dj', 'djs', 'crowd', 'someone', 'unknown', 'unidentified', 'performer', 'artist', 'bartender', 'photographer']);

export function normalizeForMatch(s: string): string {
  return ` ${s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanList(v: unknown, maxItems = 12, maxLen = 80): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = clean(item, maxLen);
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** People names must be grounded in visible text (ocrText) or the folder path; anything else is dropped. */
export function groundPeople(candidates: string[], ocrText: string, relativePath: string): string[] {
  const haystack = normalizeForMatch(`${ocrText} ${relativePath}`);
  return candidates.filter(name => {
    const n = normalizeForMatch(name).trim();
    if (!n) return false;
    const tokens = n.split(' ');
    if (tokens.length > 6) return false;
    if (tokens.length === 1 && GENERIC_PERSON.has(tokens[0])) return false;
    return haystack.includes(` ${n} `);
  });
}

function sanitizeJev(raw: unknown): JevAnswers {
  const out: JevAnswers = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of JEV_IDS) {
    const a = (raw as Record<string, unknown>)[id];
    if (!a || typeof a !== 'object') continue;
    const q = JEV_QUESTIONS.find(x => x.id === id);
    const rawValue = (a as { value?: unknown }).value;
    const confRaw = Number((a as { confidence?: unknown }).confidence);
    const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0;
    if (q && !q.openEnded && q.choices.length) {
      out[id] = { value: typeof rawValue === 'string' && q.choices.includes(rawValue) ? rawValue : null, confidence };
    } else {
      out[id] = { value: cleanList(rawValue, 12, 80), confidence };
    }
    if (out[id]!.value === null) out[id]!.confidence = 0;
  }
  return out;
}

export function sanitizeAnalysis(raw: unknown, ctx: { relativePath: string }): SanitizedAnalysis {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const vibeRaw = (r.vibe && typeof r.vibe === 'object' ? r.vibe : {}) as Record<string, unknown>;
  const ocrText = clean(r.ocrText, 600);
  const yearRaw = Number(r.eraYear);
  const countRaw = Number(r.peopleCount);
  const kind = VIBE_KINDS.includes(vibeRaw.kind as never) ? (vibeRaw.kind as Facets['vibe']['kind']) : 'other';
  const facets: Facets = {
      people: groundPeople(cleanList(r.people, 20), ocrText, ctx.relativePath),
      crews: cleanList(r.crews), labels: cleanList(r.labels), venues: cleanList(r.venues), cities: cleanList(r.cities), partyNames: cleanList(r.partyNames),
      dateText: clean(r.dateText, 80) || null,
      eraYear: Number.isInteger(yearRaw) && yearRaw >= 1900 && yearRaw <= 2100 ? yearRaw : null,
      gear: cleanList(r.gear), genres: cleanList(r.genres), ocrText,
      vibe: {
        light: vibeRaw.light === 'dark' || vibeRaw.light === 'light' ? vibeRaw.light : null,
        time: vibeRaw.time === 'night' || vibeRaw.time === 'day' ? vibeRaw.time : null,
        kind,
        mood: cleanList(vibeRaw.mood, 4, 30),
      },
  };
  return {
    facets: withEventDates(facets),
    summary: clean(r.summary, 200),
    activity: clean(r.activity, 160),
    peopleCount: Number.isInteger(countRaw) ? Math.min(500, Math.max(0, countRaw)) : 0,
    jev: sanitizeJev(r.jev),
  };
}
