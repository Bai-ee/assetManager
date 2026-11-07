/** Shared fakes for manifest/plan/apply tests (not a test file). */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildFile, LibraryItem, ReadLibraryResult, ResolvedDate } from './types';
import type { PlanDeps } from './plan';

export const sha = (c: string) => crypto.createHash('sha256').update(c).digest('hex');
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'photolib-test-'));

export function resolveTakenDate(item: { imageDateUtc: string | null }): ResolvedDate {
  if (!item.imageDateUtc) return { takenLocal: null, tz: null, tzOffsetSec: null, tsUtc: null, tsSource: null, tsKind: 'unknown' };
  return { takenLocal: item.imageDateUtc.slice(0, 19), tz: '+00:00', tzOffsetSec: 0, tsUtc: item.imageDateUtc, tsSource: 'library-db', tsKind: 'exact' };
}

export function canonicalPathFor(date: ResolvedDate, parentSha: string, ext: string, role?: 'motion' | 'edited'): string {
  const suffix = role ? `_${role}` : '';
  if (!date.takenLocal) return `HITLOOP-ARCHIVE/timeline/unknown/${parentSha.slice(0, 8)}${suffix}.${ext}`;
  const [d, t] = date.takenLocal.split('T');
  return `HITLOOP-ARCHIVE/timeline/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}_${t.replace(/:/g, '')}_${parentSha.slice(0, 8)}${suffix}.${ext}`;
}

export const normalizeExt = (f: string) => { const e = path.extname(f).slice(1).toLowerCase(); return e === 'jpeg' ? 'jpg' : e; };

export interface Fixture { root: string; libAbs: string; libRel: string; items: LibraryItem[]; deps: PlanDeps }

/** A fake `.photoslibrary` bundle on disk plus a fake readLibrary returning its items. */
export function makeFixture(files: { rel: string; content: string; date?: string | null; albums?: string[]; motion?: { rel: string; content: string } }[]): Fixture {
  const root = tmpDir();
  const libRel = 'Backups/Test.photoslibrary';
  const libAbs = path.join(root, libRel);
  const put = (rel: string, c: string) => { const p = path.join(libAbs, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return p; };
  const items: LibraryItem[] = files.map((f, i) => {
    const absPath = put(f.rel, f.content);
    let motion: ChildFile | null = null;
    if (f.motion) { motion = { relativePath: f.motion.rel, absPath: put(f.motion.rel, f.motion.content), sizeBytes: f.motion.content.length }; }
    return {
      sourceId: 'photos-test', masterUuid: `m${i}`, versionUuid: `v${i}`, relativePath: f.rel, absPath, originalFileName: path.basename(f.rel), uti: null, kind: 'image',
      sizeBytes: f.content.length, width: 10, height: 10, durationSec: null, imageDateUtc: f.date === undefined ? `2018-06-2${i}T10:20:30.000Z` : f.date,
      tzOffsetSec: 0, lat: null, lon: null, albums: f.albums ?? [], favorite: false, hidden: false, title: null, description: null, keywords: [],
      mediaGroupId: null, motion, edited: null,
    };
  });
  const deps: PlanDeps = {
    readLibrary: (libraryPath): ReadLibraryResult => ({ kind: 'photos', libraryPath, items, warnings: [] }),
    readExifBatch: async paths => new Map(paths.map(p => [p, null])),
    resolveTakenDate, canonicalPathFor, normalizeExt,
  };
  return { root, libAbs, libRel, items, deps };
}

/** path -> "size:mtimeMs" for every entry under dir (recursive), for byte-identity assertions. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const st = fs.statSync(p);
      out[path.relative(dir, p)] = e.isDirectory() ? `dir:${st.mtimeMs}` : `${st.size}:${st.mtimeMs}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(dir, p)); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}
