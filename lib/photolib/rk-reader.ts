/**
 * RK reader — reads an Apple Photos / iPhoto library DB into LibraryItem[] (see docs/archive/PHOTOLIB.md).
 * Never touches the bundle: the DB (+ -wal/-shm) is copied to a temp dir and the copy is opened.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChildFile, LibraryItem, ReadLibraryResult } from './types';
import { openLibrary, tzOffsetSeconds } from './inspect';

const APPLE_EPOCH = 978307200; // 2001-01-01T00:00:00Z
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.avi']);

/** Apple-epoch seconds → ISO UTC instant (Z); null for null/non-finite input. */
export function appleEpochToIso(sec: number | null): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return null;
  const d = new Date((sec + APPLE_EPOCH) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface Row {
  masterModelId: number | null;
  uuid: string;
  imagePath: string;
  originalFileName: string | null;
  fileSize: number | null;
  uti: string | null;
  imageDate: number | null;
  tzOffset: number | null;
  mWidth: number | null;
  mHeight: number | null;
  mDuration: number | null;
  mediaGroupId: string | null;
  versionModelId: number | null;
  versionUuid: string | null;
  tzName: string | null;
  vName: string | null;
  description: string | null;
  isFavorite: number | null;
  mainRating: number | null;
  isHidden: number | null;
  lat: number | null;
  lon: number | null;
  exifLat: number | null;
  exifLon: number | null;
  vWidth: number | null;
  vHeight: number | null;
  naturalDuration: number | null;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.DS_Store' || e.name.startsWith('._')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** hex (lowercase) → files named `<prefix>_<hex>.<ext>` under a resources/media subtree. */
function indexResourceFiles(dir: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const f of walk(dir)) {
    const m = /^(.+)_([0-9a-fA-F]+)\.[^.]+$/.exec(path.basename(f));
    if (!m) continue;
    const key = m[2].toLowerCase();
    const list = idx.get(key);
    if (list) list.push(f);
    else idx.set(key, [f]);
  }
  return idx;
}

function pickResource(idx: Map<string, string[]>, hex: string, prefix: string): string | null {
  const list = idx.get(hex);
  if (!list || !list.length) return null;
  const pref = list.filter((f) => path.basename(f).toLowerCase().startsWith(prefix + '_') && !/\.plist$/i.test(f));
  const pool = pref.length ? pref : list.filter((f) => !/\.plist$/i.test(f));
  return (pool.length ? pool : list).slice().sort()[0];
}

function validGps(lat: number | null, lon: number | null): { lat: number; lon: number } | null {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function readLibrary(libraryPath: string, opts: { sourceId: string }): ReadLibraryResult {
  const lib = openLibrary(libraryPath);
  const warnings: ReadLibraryResult['warnings'] = [];
  try {
    const db = lib.db;
    const colsOf = (t: string): Set<string> => {
      try {
        return new Set((db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((r) => r.name));
      } catch {
        return new Set();
      }
    };
    const cM = colsOf('RKMaster');
    const cV = colsOf('RKVersion');
    const m = (c: string, alias = c) => (cM.has(c) ? `m.${c} as ${alias}` : `null as ${alias}`);
    const v = (c: string, alias = c) => (cV.has(c) ? `v.${c} as ${alias}` : `null as ${alias}`);
    const utiExpr = cM.has('UTI') ? 'm.UTI' : cM.has('type') ? 'm.type' : cM.has('imageFormat') ? 'm.imageFormat' : 'null';
    const trashWhere = cM.has('isInTrash') ? 'where coalesce(m.isInTrash,0) = 0' : '';
    const sql = `select ${m('modelId', 'masterModelId')}, m.uuid as uuid, m.imagePath as imagePath, ${m('originalFileName')},
        ${m('fileSize')}, ${utiExpr} as uti, ${m('imageDate')}, ${m('imageTimeZoneOffsetSeconds', 'tzOffset')},
        ${m('width', 'mWidth')}, ${m('height', 'mHeight')}, ${m('duration', 'mDuration')}, ${m('mediaGroupId')},
        v.modelId as versionModelId, ${v('uuid', 'versionUuid')}, ${v('imageTimeZoneName', 'tzName')}, ${v('name', 'vName')},
        ${v('extendedDescription', 'description')}, ${v('isFavorite')}, ${v('mainRating')}, ${v('isHidden')},
        ${v('latitude', 'lat')}, ${v('longitude', 'lon')}, ${v('exifLatitude', 'exifLat')}, ${v('exifLongitude', 'exifLon')},
        ${v('masterWidth', 'vWidth')}, ${v('masterHeight', 'vHeight')}, ${v('naturalDuration')}
      from RKMaster m left join RKVersion v on v.modelId =
        (select v2.modelId from RKVersion v2 where v2.masterUuid = m.uuid order by v2.versionNumber, v2.modelId limit 1)
      ${trashWhere} order by m.rowid`;
    const rows = db.prepare(sql).all() as Row[];

    // --- albums + keywords keyed by version modelId
    const albumsByVersion = new Map<number, string[]>();
    const cA = colsOf('RKAlbum');
    const cAV = colsOf('RKAlbumVersion');
    if (cA.has('name') && cAV.has('versionId') && cAV.has('albumId')) {
      const conds = [`a.name is not null`, `a.name <> ''`];
      if (cA.has('isInTrash')) conds.push('coalesce(a.isInTrash,0) = 0');
      if (cA.has('isMagic')) conds.push('coalesce(a.isMagic,0) = 0');
      const ar = db.prepare(`select av.versionId as vid, a.name as name from RKAlbumVersion av join RKAlbum a on a.modelId = av.albumId
        where ${conds.join(' and ')} order by a.name`).all() as { vid: number; name: string }[];
      for (const r of ar) {
        const l = albumsByVersion.get(r.vid) ?? [];
        if (!l.includes(r.name)) l.push(r.name);
        albumsByVersion.set(r.vid, l);
      }
    }
    const keywordsByVersion = new Map<number, string[]>();
    const cKV = colsOf('RKKeywordForVersion');
    const cK = colsOf('RKKeyword');
    if (cKV.has('versionId') && cKV.has('keywordId') && cK.has('name')) {
      const kr = db.prepare(`select kv.versionId as vid, k.name as name from RKKeywordForVersion kv join RKKeyword k on k.modelId = kv.keywordId
        where k.name is not null and k.name <> '' order by k.name`).all() as { vid: number; name: string }[];
      for (const r of kr) {
        const l = keywordsByVersion.get(r.vid) ?? [];
        if (!l.includes(r.name)) l.push(r.name);
        keywordsByVersion.set(r.vid, l);
      }
    }

    // --- resource children (photos only)
    const motionByMaster = new Map<number, number>(); // master modelId → resource modelId
    const editedByVersion = new Map<number, number>(); // version modelId → resource modelId
    let masterIdx = new Map<string, string[]>();
    let versionIdx = new Map<string, string[]>();
    if (lib.kind === 'photos') {
      const cR = colsOf('RKModelResource');
      if (cR.has('resourceType') && cR.has('attachedModelType') && cR.has('attachedModelId') && cR.has('modelId')) {
        const rr = db.prepare(`select modelId, attachedModelId, attachedModelType, resourceType from RKModelResource
          where (resourceType = 7 and attachedModelType = 1) or (resourceType = 4 and attachedModelType = 2) order by modelId`)
          .all() as { modelId: number; attachedModelId: number; attachedModelType: number; resourceType: number }[];
        for (const r of rr) {
          if (r.resourceType === 7 && !motionByMaster.has(r.attachedModelId)) motionByMaster.set(r.attachedModelId, r.modelId);
          else if (r.resourceType === 4 && !editedByVersion.has(r.attachedModelId)) editedByVersion.set(r.attachedModelId, r.modelId);
        }
        if (rr.length) {
          masterIdx = indexResourceFiles(path.join(libraryPath, 'resources', 'media', 'master'));
          versionIdx = indexResourceFiles(path.join(libraryPath, 'resources', 'media', 'version'));
        }
      }
    }

    const toChild = (abs: string): ChildFile => ({
      relativePath: path.relative(libraryPath, abs).split(path.sep).join('/'),
      absPath: abs,
      sizeBytes: fs.statSync(abs).size,
    });
    const resolveChild = (resId: number | undefined, idx: Map<string, string[]>, prefix: string, what: string, uuid: string): ChildFile | null => {
      if (resId === undefined) return null;
      const hex = resId.toString(16).toLowerCase();
      const f = pickResource(idx, hex, prefix);
      if (!f) {
        warnings.push({ masterUuid: uuid, reason: `${what} file missing for resource ${hex}` });
        return null;
      }
      try {
        return toChild(f);
      } catch {
        warnings.push({ masterUuid: uuid, reason: `${what} file unreadable: ${f}` });
        return null;
      }
    };

    const items: LibraryItem[] = [];
    for (const r of rows) {
      try {
        if (!r.imagePath) {
          warnings.push({ masterUuid: r.uuid, reason: 'master has no imagePath' });
          continue;
        }
        const relativePath = 'Masters/' + r.imagePath;
        const absPath = path.join(libraryPath, 'Masters', r.imagePath);
        let st: fs.Stats;
        try {
          st = fs.statSync(absPath);
          if (!st.isFile()) throw new Error('not a file');
        } catch {
          warnings.push({ masterUuid: r.uuid, relativePath, reason: 'master file missing on disk' });
          continue;
        }
        const originalFileName = r.originalFileName || path.basename(r.imagePath);
        const ext = path.extname(originalFileName || r.imagePath).toLowerCase();
        const kind = VIDEO_EXT.has(ext) || (!!r.uti && /movie|mpeg-4|video|avi|^VID/i.test(r.uti)) ? 'video' : 'image';

        const imageDateUtc = appleEpochToIso(r.imageDate);
        let tzOffsetSec: number | null = typeof r.tzOffset === 'number' ? r.tzOffset : null;
        if (tzOffsetSec === null && r.tzName && imageDateUtc) tzOffsetSec = tzOffsetSeconds(r.tzName, Date.parse(imageDateUtc));

        const gps = validGps(r.lat, r.lon) ?? validGps(r.exifLat, r.exifLon);
        const favorite = r.isFavorite !== null && r.isFavorite !== undefined ? !!r.isFavorite : (r.mainRating ?? 0) > 0;
        const base = path.basename(originalFileName, path.extname(originalFileName));
        const name = r.vName && r.vName.trim() ? r.vName : null;
        const title = name && name !== base && name !== originalFileName ? name : null;
        const vid = r.versionModelId;

        items.push({
          sourceId: opts.sourceId,
          masterUuid: r.uuid,
          versionUuid: r.versionUuid ?? null,
          relativePath,
          absPath,
          originalFileName,
          uti: r.uti ?? null,
          kind,
          sizeBytes: st.size,
          width: r.mWidth ?? r.vWidth ?? null,
          height: r.mHeight ?? r.vHeight ?? null,
          durationSec: r.mDuration ?? r.naturalDuration ?? null,
          imageDateUtc,
          tzOffsetSec,
          lat: gps ? gps.lat : null,
          lon: gps ? gps.lon : null,
          albums: vid != null ? albumsByVersion.get(vid) ?? [] : [],
          favorite,
          hidden: !!r.isHidden,
          title,
          description: r.description && r.description.trim() ? r.description : null,
          keywords: vid != null ? keywordsByVersion.get(vid) ?? [] : [],
          mediaGroupId: r.mediaGroupId || null,
          motion: r.masterModelId != null ? resolveChild(motionByMaster.get(r.masterModelId), masterIdx, 'jpegvideocomplement', 'motion', r.uuid) : null,
          edited: vid != null ? resolveChild(editedByVersion.get(vid), versionIdx, 'fullsizeoutput', 'edited', r.uuid) : null,
        });
      } catch (e) {
        warnings.push({ masterUuid: r.uuid, reason: `unreadable row: ${(e as Error).message}` });
      }
    }
    return { kind: lib.kind, libraryPath, items, warnings };
  } finally {
    try {
      lib.db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(lib.tmp, { recursive: true, force: true });
  }
}
