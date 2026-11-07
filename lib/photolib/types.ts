/**
 * FROZEN CONTRACT — Life Timeline photolib (see docs/archive/PHOTOLIB.md).
 * Agents code against these types; change only with orchestrator sign-off.
 * HITLOOP mirror: features/life-timeline/CONTRACT.md.
 */

export type LibraryKind = 'photos' | 'iphoto' | 'folder';
export type MediaKind = 'image' | 'video';
export type TsSource = 'library-db' | 'exif' | 'quicktime';
export type ChildRole = 'motion' | 'edited';

/** One original as read from a library DB (rk-reader output). Paths are absolute + bundle-relative. */
export interface LibraryItem {
  sourceId: string;
  masterUuid: string;
  versionUuid: string | null;
  /** Relative to the library bundle root, e.g. "Masters/2018/10/24/20181024-201030/IMG_9036.JPG". */
  relativePath: string;
  absPath: string;
  originalFileName: string;
  uti: string | null;
  kind: MediaKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** RKMaster.imageDate converted from Apple epoch → ISO UTC instant (Z). null if absent. */
  imageDateUtc: string | null;
  /** RKMaster.imageTimeZoneOffsetSeconds (preferred) else derived from RKVersion.imageTimeZoneName. */
  tzOffsetSec: number | null;
  lat: number | null;
  lon: number | null;
  /** User-visible album names (non-magic, non-trashed, non-empty name). Folder path not included. */
  albums: string[];
  favorite: boolean;
  hidden: boolean;
  title: string | null;
  description: string | null;
  keywords: string[];
  /** Live Photo content identifier (RKMaster.mediaGroupId) or null. */
  mediaGroupId: string | null;
  /** Live Photo video half (RKModelResource resourceType 7 on the master). */
  motion: ChildFile | null;
  /** Edit render (RKModelResource resourceType 4 attached to the version, attachedModelType 2). */
  edited: ChildFile | null;
}

export interface ChildFile {
  relativePath: string; // bundle-relative
  absPath: string;
  sizeBytes: number;
}

export interface ReadLibraryResult {
  kind: LibraryKind;
  libraryPath: string;
  items: LibraryItem[];
  /** Non-fatal problems (missing file on disk, unreadable row, etc). */
  warnings: { masterUuid?: string; relativePath?: string; reason: string }[];
  /** Folder source only: EXIF already read while filtering (keyed by absPath), so plan does not re-read it. */
  exif?: Map<string, ExifInfo | null>;
  /** Folder source only: candidate files dropped because no capture date could be resolved. */
  skippedNoDate?: number;
}

/** Subset of exiftool output used by the date policy + pairing. */
export interface ExifInfo {
  dateTimeOriginal: string | null; // "YYYY:MM:DD HH:MM:SS" (raw)
  offsetTimeOriginal: string | null; // "+HH:MM"
  gpsDateTimeUtc: string | null; // ISO Z
  quicktimeCreationDate: string | null; // raw, tz-aware "YYYY:MM:DD HH:MM:SS±HH:MM"
  quicktimeCreateDateUtc: string | null; // ISO Z
  lat: number | null;
  lon: number | null;
  contentIdentifier: string | null;
  make: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

/** Output of the date policy (dates.ts resolveTakenDate). */
export interface ResolvedDate {
  /** Local wall clock at capture "YYYY-MM-DDTHH:MM:SS", or null when unknown. */
  takenLocal: string | null;
  /** "+HH:MM" / "-HH:MM" or null when only a local time is known without offset. */
  tz: string | null;
  tzOffsetSec: number | null;
  /** ISO UTC instant or null. */
  tsUtc: string | null;
  tsSource: TsSource | null;
  tsKind: 'exact' | 'local-only' | 'unknown';
}

/** Sidecar written to HITLOOP-ARCHIVE/timeline/_meta/<sha256>.json (schema 'photolib.sidecar/1'). */
export interface Sidecar {
  schema: 'photolib.sidecar/1';
  sha256: string;
  id: string; // sha256.slice(0,16)
  kind: MediaKind;
  ext: string; // lowercase without dot, e.g. "jpg"
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  takenLocal: string | null;
  tz: string | null;
  tzOffsetSec: number | null;
  tsUtc: string | null;
  tsSource: TsSource | null;
  tsKind: ResolvedDate['tsKind'];
  gps: { lat: number; lon: number } | null;
  /** Relative to the share root (dest root), e.g. "HITLOOP-ARCHIVE/timeline/2018/06/2018-06-21_231938_ab12cd34.jpg". */
  canonicalPath: string;
  albums: string[];
  favorite: boolean;
  hidden: boolean;
  title: string | null;
  description: string | null;
  keywords: string[];
  camera: { make: string | null; model: string | null } | null;
  children: Partial<Record<ChildRole, SidecarChild>>;
  locations: SidecarLocation[];
  createdAt: string;
  updatedAt: string;
}

export interface SidecarChild {
  sha256: string;
  ext: string;
  sizeBytes: number;
  durationSec: number | null;
  canonicalPath: string; // share-root relative
  sourceRelativePath: string; // bundle-relative
}

export interface SidecarLocation {
  sourceId: string;
  libraryKind: LibraryKind;
  /** Library bundle path relative to the share root. */
  libraryPath: string;
  relativePath: string; // bundle-relative
  masterUuid: string | null;
  versionUuid: string | null;
  originalFileName: string;
}

/** One planned copy (plan.ts output). */
export interface PlanItem {
  sha256: string;
  item: LibraryItem;
  date: ResolvedDate;
  canonicalPath: string; // share-root relative
  /** Camera make/model from the primary's EXIF (null when absent). Optional for plans saved before this field existed. */
  camera?: { make: string | null; model: string | null } | null;
  /** 'copy' = new; 'present' = canonical already exists with same sha (skip copy, still sidecar/manifest);
   *  'duplicate' = same sha as an earlier item in this plan/manifest (adds a location only); 'conflict' = canonical path taken by a different sha. */
  action: 'copy' | 'present' | 'duplicate' | 'conflict';
  children: { role: ChildRole; sha256: string; file: ChildFile; canonicalPath: string; action: 'copy' | 'present'; /** EXIF duration of the child file (motion halves). */ durationSec?: number | null }[];
}

export interface Plan {
  planId: string;
  sourceId: string;
  libraryKind: LibraryKind;
  libraryPath: string; // share-root relative
  destRoot: string; // absolute share root, e.g. /Volumes/bryan
  createdAt: string;
  items: PlanItem[];
  totals: { items: number; copy: number; present: number; duplicate: number; conflict: number; children: number; bytes: number; /** Folder plans only. */ skippedNoDate?: number };
  warnings: ReadLibraryResult['warnings'];
}

/**
 * Push payload item (worker → HITLOOP POST /api/archive/worker/life/results).
 * Mirrors features/life-timeline/CONTRACT.md §LifeItem. No absolute paths, no NAS share names.
 */
export interface LifeItem {
  id: string; // sha16
  sha256: string;
  kind: MediaKind;
  ext: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  takenLocal: string | null;
  tz: string | null;
  tsUtc: string | null;
  tsSource: TsSource | null;
  tsKind: ResolvedDate['tsKind'];
  gps: { lat: number; lon: number } | null;
  albums: string[];
  favorite: boolean;
  hidden: boolean;
  title: string | null;
  description: string | null;
  keywords: string[];
  camera: { make: string | null; model: string | null } | null;
  motion: { sha256: string; durationSec: number | null } | null;
  edited: { sha256: string } | null;
  /** Storage object paths returned by life/upload-urls (s = 320px, m = 1600px, JPEG). */
  thumbs: { s: string; m: string } | null;
  canonicalPath: string; // share-root relative (provenance only, never served)
  locations: { sourceId: string; relativePath: string; originalFileName: string }[];
}
