/**
 * Canonical NAS layout for the photolib timeline (see docs/archive/PHOTOLIB.md "Canonical layout").
 * Pure: no fs access.
 */
import type { ResolvedDate } from './types';

export const TIMELINE_ROOT = 'HITLOOP-ARCHIVE/timeline';

/** Lowercase extension without dot; `jpeg` → `jpg`. Returns '' when the name has no extension. */
export function normalizeExt(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i < 0 || i === base.length - 1) return '';
  const ext = base.slice(i + 1).toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

/** Throws on absolute paths, `..` segments, or NUL bytes. Returns the input for chaining. */
export function assertSafeRelative(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('unsafe path: empty');
  if (p.includes('\0')) throw new Error('unsafe path: NUL byte');
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) throw new Error(`unsafe path: absolute (${p})`);
  if (p.split(/[\\/]/).some((seg) => seg === '..')) throw new Error(`unsafe path: '..' segment (${p})`);
  return p;
}

/**
 * Share-root-relative canonical path. Children (`role`) use the PARENT's sha and their own ext.
 *  dated:   HITLOOP-ARCHIVE/timeline/YYYY/MM/YYYY-MM-DD_HHMMSS_<sha8>[_motion|_edited].<ext>
 *  unknown: HITLOOP-ARCHIVE/timeline/unknown/<sha8>[_motion|_edited].<ext>
 */
export function canonicalPathFor(date: ResolvedDate, sha256: string, ext: string, role?: 'motion' | 'edited'): string {
  if (!/^[0-9a-f]{8,}$/i.test(sha256)) throw new Error(`bad sha256: ${sha256}`);
  let e = ext.replace(/^\./, '').toLowerCase();
  if (e === 'jpeg') e = 'jpg';
  if (!/^[a-z0-9]+$/.test(e)) throw new Error(`bad extension: ${ext}`);
  const sha8 = sha256.slice(0, 8).toLowerCase();
  const suffix = role ? `_${role}` : '';
  const m = date.takenLocal ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(date.takenLocal) : null;
  if (date.takenLocal && !m) throw new Error(`bad takenLocal: ${date.takenLocal}`);
  const out = m
    ? `${TIMELINE_ROOT}/${m[1]}/${m[2]}/${m[1]}-${m[2]}-${m[3]}_${m[4]}${m[5]}${m[6]}_${sha8}${suffix}.${e}`
    : `${TIMELINE_ROOT}/unknown/${sha8}${suffix}.${e}`;
  return assertSafeRelative(out);
}

export function sidecarPathFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error(`bad sha256: ${sha256}`);
  return `${TIMELINE_ROOT}/_meta/${sha256.toLowerCase()}.json`;
}
