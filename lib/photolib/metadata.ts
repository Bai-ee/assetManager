/**
 * Full-metadata capture (owner rule 2026-11-08: ALL metadata of every ingested file is saved before any move/delete).
 * Per asset, next to the sidecar in HITLOOP-ARCHIVE/timeline/_meta/<sha[0:2]>/:
 *   <sha>.exif.json                — complete exiftool dump (every group incl. MakerNotes/XMP/QuickTime/Composite, unknown tags)
 *   <sha>.<xmpSha8>.xmp            — source XMP sidecar(s) found beside the file (e.g. icloudpd --xmp-sidecar), byte copy
 *   <sha>.library.<sourceId>.json  — the source Photos library's full DB record (every ZASSET + ZADDITIONALASSETATTRIBUTES
 *                                    column, plus albums, keywords, caption, people, moment) when a Photos.sqlite is given
 * Files are written atomically (temp + rename), never overwritten with different content, and never modify the source.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SidecarMeta } from './types';

export const META_DIR = 'HITLOOP-ARCHIVE/timeline/_meta';
/** Shard dir for one sha (same rule as the sidecar, see apply.ts defaultSidecarPath). */
export const metaDirFor = (sha: string) => `${META_DIR}/${sha.slice(0, 2)}`;
const APPLE_EPOCH = 978307200;

export interface MetaFile {
  /** sha256 of the media file bytes. */
  sha256: string;
  absPath: string;
  /** Source-relative path (for provenance in the library-record file). */
  relativePath: string;
  sizeBytes: number;
}

export interface CaptureDeps {
  /** Complete tag dump of one file (default: exiftool -a -G1 -s -struct -n -u -ee). */
  readFullExif: (absPath: string) => Promise<Record<string, unknown>>;
  /** Optional Photos library record lookup (iCloud download sources). */
  library?: LibraryRecordIndex | null;
  sourceId: string;
}

const sha256Of = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex');
const rand = () => crypto.randomBytes(4).toString('hex');

/** Write only when absent; when present with identical bytes it is a no-op. Returns 'created' | 'same' | 'different'. */
export function writeOnce(abs: string, data: Buffer | string): 'created' | 'same' | 'different' {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    const cur = fs.readFileSync(abs);
    return cur.equals(buf) ? 'same' : 'different';
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.photolib-tmp-${rand()}`;
  try {
    fs.writeFileSync(tmp, buf, { flag: 'wx' });
    fs.renameSync(tmp, abs);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return 'created';
}

/** XMP sidecars beside a file: "<name>.<ext>.xmp" (icloudpd) and "<name>.xmp" (Lightroom/Photos export), any case. */
export function findXmpSidecars(absPath: string): string[] {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const stem = path.basename(absPath, path.extname(absPath));
  const want = new Set([`${base}.xmp`, `${stem}.xmp`].map(s => s.toLowerCase()));
  const names = xmpNamesIn(dir);
  return names.filter(n => want.has(n.toLowerCase())).sort().map(n => path.join(dir, n));
}

/**
 * .xmp names per directory, listed once per process: a NAS readdir of a 1k-file month folder takes ~11 s, and
 * capture runs once per file. Sidecars are copied (never moved or deleted) during a run, so the cached list stays true.
 */
const xmpDirCache = new Map<string, string[]>();
function xmpNamesIn(dir: string): string[] {
  let names = xmpDirCache.get(dir);
  if (!names) {
    try { names = fs.readdirSync(dir).filter(n => /\.xmp$/i.test(n)); } catch { names = []; }
    xmpDirCache.set(dir, names);
  }
  return names;
}

/** Stable JSON: exiftool output minus the fields that describe where the file sits (they change on move). */
export function normalizeExifDump(tags: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(tags).sort()) {
    if (/^(SourceFile|errors|warnings)$/.test(k)) continue;
    if (/^System:(Directory|FileName|FileAccessDate|FileInodeChangeDate|FileModifyDate|FilePermissions|FileAttributes)$/.test(k)) continue;
    if (/^(Directory|FileName|FileAccessDate|FileInodeChangeDate|FileModifyDate|FilePermissions)$/.test(k)) continue;
    out[k] = tags[k];
  }
  return out;
}

/**
 * Capture every metadata source for one file into destRoot/_meta. Returns the share-relative paths written or
 * already present. Throws if a required write fails, so callers never move/delete a file whose metadata is not saved.
 */
export async function captureMetadata(destRoot: string, f: MetaFile, deps: CaptureDeps): Promise<SidecarMeta> {
  const meta: SidecarMeta = { exif: null, xmp: [], library: [] };

  // 1. Full exiftool dump (identical bytes ⇒ identical tags, so one file per sha).
  const exifRel = `${metaDirFor(f.sha256)}/${f.sha256}.exif.json`;
  const dump = normalizeExifDump(await deps.readFullExif(f.absPath));
  const exifAbs = path.join(destRoot, exifRel);
  if (!fs.existsSync(exifAbs)) writeOnce(exifAbs, JSON.stringify({ schema: 'photolib.exif/1', sha256: f.sha256, tags: dump }, null, 2) + '\n');
  meta.exif = exifRel;

  // 2. Source XMP sidecars, byte copies keyed by their own content hash (different sources may carry different XMP).
  for (const x of findXmpSidecars(f.absPath)) {
    const buf = fs.readFileSync(x);
    const rel = `${metaDirFor(f.sha256)}/${f.sha256}.${sha256Of(buf).slice(0, 8)}.xmp`;
    if (writeOnce(path.join(destRoot, rel), buf) === 'different') throw new Error(`xmp sidecar name collision at ${rel}`);
    meta.xmp.push(rel);
  }

  // 3. Photos library DB record (iCloud downloads).
  if (deps.library) {
    const rec = deps.library.lookup(path.basename(f.absPath), f.sizeBytes, fileCreatedUnix(f.absPath));
    const rel = `${metaDirFor(f.sha256)}/${f.sha256}.library.${deps.sourceId}.json`;
    const body = JSON.stringify({ schema: 'photolib.library-record/1', sha256: f.sha256, sourceId: deps.sourceId, relativePath: f.relativePath, ...rec }, null, 2) + '\n';
    const abs = path.join(destRoot, rel);
    if (fs.existsSync(abs)) {
      // Same sha from another file of the same source: keep the first record, add this one beside it.
      if (writeOnce(abs, body) === 'different') {
        const alt = `${metaDirFor(f.sha256)}/${f.sha256}.library.${deps.sourceId}.${sha256Of(f.relativePath).slice(0, 8)}.json`;
        writeOnce(path.join(destRoot, alt), body);
        meta.library.push(alt);
      }
    } else writeOnce(abs, body);
    meta.library.unshift(rel);
  }
  return meta;
}

/** File mtime in unix seconds. icloudpd sets mtime to the iCloud creation date; used ONLY to match DB rows, never as a capture date. */
function fileCreatedUnix(absPath: string): number | null {
  try { const st = fs.statSync(absPath); return Math.round(st.mtimeMs / 1000); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Photos.sqlite record index
// ---------------------------------------------------------------------------------------------------------------------

export interface LibraryRecordResult {
  match: 'name-size-date' | 'name-size' | 'name-date' | 'ambiguous' | 'none';
  /** Matched record(s): exactly one unless ambiguous (then all candidates, so nothing is lost). */
  records: Record<string, unknown>[];
}

export interface LibraryRecordIndex {
  lookup(fileName: string, sizeBytes: number, createdUnix: number | null): LibraryRecordResult;
  close(): void;
}

interface Candidate { pk: number; size: number | null; created: number | null }

type Db = { prepare(sql: string): { all(...a: unknown[]): any[]; get(...a: unknown[]): any }; close(): void };

/** icloudpd may append "-<size>" (name-size-dedup-with-suffix) or "_HEVC" (live photo suffix policy) to the original name. */
export function nameKeys(fileName: string): string[] {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);
  const stem = lower.slice(0, lower.length - ext.length);
  const keys = new Set([lower]);
  const m = /^(.*)-\d+$/.exec(stem);
  if (m) keys.add(m[1] + ext);
  return Array.from(keys);
}

/**
 * Open a COPY of Photos.sqlite (callers copy the live DB to a temp dir first; this never opens the library bundle).
 * Matching uses original filename + original size + creation second; returns every column so nothing is curated away.
 */
export function openLibraryRecordIndex(dbPath: string, open?: (p: string) => Db): LibraryRecordIndex {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db: Db = open ? open(dbPath) : new (require('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true });
  const byName = new Map<string, Candidate[]>();
  const rows = db.prepare(`select a.Z_PK pk, lower(b.ZORIGINALFILENAME) name, b.ZORIGINALFILESIZE size, a.ZDATECREATED created
    from ZASSET a join ZADDITIONALASSETATTRIBUTES b on b.ZASSET = a.Z_PK where a.ZTRASHEDSTATE = 0 and b.ZORIGINALFILENAME is not null`).all();
  for (const r of rows) {
    const c: Candidate = { pk: r.pk, size: r.size ?? null, created: r.created == null ? null : Math.round(r.created + APPLE_EPOCH) };
    (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(c);
  }
  const cols = (t: string) => new Set<string>(db.prepare(`select name from pragma_table_info('${t}')`).all().map((r: any) => r.name));
  const tables = new Set<string>(db.prepare(`select name from sqlite_master where type='table'`).all().map((r: any) => r.name));
  // Album and keyword join tables are numbered per library version (Z_30ASSETS, Z_1KEYWORDS…): discover them.
  const albumJoin = Array.from(tables).find(t => /^Z_\d+ASSETS$/.test(t) && Array.from(cols(t)).some(c => /ALBUMS$/.test(c)));
  const albumCols = albumJoin ? Array.from(cols(albumJoin)) : [];
  const albumAlbumCol = albumCols.find(c => /ALBUMS$/.test(c));
  const albumAssetCol = albumCols.find(c => /^Z_\d+ASSETS$/.test(c));
  const kwJoin = Array.from(tables).find(t => /^Z_\d+KEYWORDS$/.test(t));
  const kwCols = kwJoin ? Array.from(cols(kwJoin)) : [];
  const kwAttrCol = kwCols.find(c => /ASSETATTRIBUTES$/.test(c));
  const kwKwCol = kwCols.find(c => /KEYWORDS$/.test(c));

  const blobSafe = (row: Record<string, unknown>) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) o[k] = Buffer.isBuffer(v) ? { base64: v.toString('base64') } : v;
    return o;
  };

  const recordFor = (pk: number): Record<string, unknown> => {
    const asset = db.prepare('select * from ZASSET where Z_PK = ?').get(pk) ?? {};
    const attrs = db.prepare('select * from ZADDITIONALASSETATTRIBUTES where ZASSET = ?').get(pk) ?? null;
    const caption = attrs ? db.prepare('select ZLONGDESCRIPTION d from ZASSETDESCRIPTION where ZASSETATTRIBUTES = ?').get(attrs.Z_PK)?.d ?? null : null;
    const albums = albumJoin && albumAlbumCol && albumAssetCol
      ? db.prepare(`select g.ZTITLE title, g.ZKIND kind, g.ZUUID uuid, g.ZCLOUDGUID cloudGuid from ${albumJoin} j join ZGENERICALBUM g on g.Z_PK = j.${albumAlbumCol}
          where j.${albumAssetCol} = ? and (g.ZTRASHEDSTATE is null or g.ZTRASHEDSTATE = 0)`).all(pk)
      : [];
    const keywords = attrs && kwJoin && kwAttrCol && kwKwCol
      ? db.prepare(`select k.ZTITLE t from ${kwJoin} j join ZKEYWORD k on k.Z_PK = j.${kwKwCol} where j.${kwAttrCol} = ?`).all(attrs.Z_PK).map((r: any) => r.t)
      : [];
    const people = tables.has('ZDETECTEDFACE') && tables.has('ZPERSON')
      ? db.prepare(`select p.ZFULLNAME fullName, p.ZDISPLAYNAME displayName, p.ZPERSONUUID uuid, f.ZMANUAL manual, f.ZHIDDEN hidden
          from ZDETECTEDFACE f left join ZPERSON p on p.Z_PK = f.ZPERSONFORFACE where f.ZASSETFORFACE = ?`).all(pk)
      : [];
    const moment = asset.ZMOMENT != null && tables.has('ZMOMENT')
      ? db.prepare('select ZTITLE title, ZSUBTITLE subtitle, ZUUID uuid, ZLOCALIZEDLOCATIONNAMES names from ZMOMENT where Z_PK = ?').get(asset.ZMOMENT) ?? null
      : null;
    return {
      uuid: asset.ZUUID ?? null, cloudAssetGuid: asset.ZCLOUDASSETGUID ?? null,
      createdUtc: asset.ZDATECREATED != null ? new Date((asset.ZDATECREATED + APPLE_EPOCH) * 1000).toISOString() : null,
      favorite: !!asset.ZFAVORITE, hidden: !!asset.ZHIDDEN, title: attrs?.ZTITLE ?? null, caption,
      albums, keywords, people, moment: moment ? blobSafe(moment) : null,
      zAsset: blobSafe(asset), zAdditionalAssetAttributes: attrs ? blobSafe(attrs) : null,
    };
  };

  return {
    lookup(fileName, sizeBytes, createdUnix) {
      const cands = nameKeys(fileName).flatMap(k => byName.get(k) ?? []);
      if (!cands.length) return { match: 'none', records: [] };
      const near = (c: Candidate) => createdUnix != null && c.created != null && Math.abs(c.created - createdUnix) <= 2;
      const pick = (list: Candidate[], match: LibraryRecordResult['match']): LibraryRecordResult | null =>
        list.length === 1 ? { match, records: [recordFor(list[0].pk)] } : null;
      const bySize = cands.filter(c => c.size === sizeBytes);
      return pick(bySize.filter(near), 'name-size-date')
        ?? pick(bySize, 'name-size')
        ?? pick(cands.filter(near), 'name-date')
        ?? { match: 'ambiguous', records: (bySize.length ? bySize : cands).slice(0, 20).map(c => recordFor(c.pk)) };
    },
    close() { db.close(); },
  };
}

/** Copy a live Photos.sqlite (+ -wal/-shm) to a temp dir so the library bundle is never opened. Returns the copy path. */
export function copyPhotosDb(photosSqlite: string, tmpRoot: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'photosdb-'));
  for (const suffix of ['', '-wal', '-shm']) {
    const src = photosSqlite + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, path.basename(src)));
  }
  return path.join(dir, path.basename(photosSqlite));
}

/** Remove the temp dir made by copyPhotosDb (only a directory named photosdb-*; anything else is left alone). */
export function removePhotosDbCopy(copyPath: string): void {
  const dir = path.dirname(copyPath);
  if (path.basename(dir).startsWith('photosdb-')) fs.rmSync(dir, { recursive: true, force: true });
}
