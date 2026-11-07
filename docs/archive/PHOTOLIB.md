# Photolib — Life Timeline extractor (FROZEN CONTRACT v1)

Plan + owner decisions: HITLOOP `docs/plans/LIFE-TIMELINE-PHOTO-LIBRARY-PLAN.md`. Recon: `PHOTOLIB-RECON.md`.
Types: `lib/photolib/types.ts` (source of truth for shapes). HITLOOP mirror: `features/life-timeline/CONTRACT.md`.
Boundary: `lib/photolib` may import `lib/archive`, never the reverse (same rule as `lib/discogs`) — except the bundle-skip helper below.

## Hard rules
- Library bundles + NAS originals are READ-ONLY. Never write/rename/delete inside a `.photoslibrary`, `iPhoto Library`, `.photolibrary`, `.migratedphotolibrary`.
- Library DB (+ `-wal`/`-shm`) is copied to a temp dir and opened there (`inspect.ts openLibrary` pattern). Never open the in-bundle DB.
- Copy only: `<dest>.photolib-tmp-<rand>` → fsync-less `rename`; verify size AND sha256 of the destination before rename; never overwrite an existing file.
- Dates never from file mtime / birthtime / import date.
- Personal scope: nothing here touches x_content_packages, timeline_entries, buckets, Brain.

## Owner decisions (P0, 2026-11-06)
- Orphan files in `Masters/` that are not in the DB: **skip**.
- Live Photo video halves: **copy** as child role `motion`.
- Edits: original stays primary; iOS `IMG_E*` files are their own masters; RK edit renders → child role `edited` only when RKModelResource links them; master-level derivatives (`UNADJUSTEDNONRAW`, resourceType 4 attachedModelType 1) are skipped.

## RK reader (`rk-reader.ts`, `readLibrary(libraryPath, {sourceId}) → ReadLibraryResult`)
- Detect: `database/photos.db` → photos; `Database/apdb/Library.apdb` → iphoto. Columns vary — probe with `pragma table_info` and select `null` for missing columns.
- One `LibraryItem` per non-trashed RKMaster (`isInTrash=0`), joined to its first RKVersion (`order by versionNumber, modelId`). Skip masters whose file is not on disk (warning).
- `absPath = <lib>/Masters/<RKMaster.imagePath>`; `relativePath = "Masters/" + imagePath`.
- `imageDateUtc = new Date((imageDate + 978307200) * 1000).toISOString()` — imageDate is a UTC instant (P0: 22/22 EXIF matches).
- `tzOffsetSec`: `RKMaster.imageTimeZoneOffsetSeconds` if column present and non-null, else parse `RKVersion.imageTimeZoneName` (`GMT±HHMM` or IANA via Intl, see `inspect.ts tzOffsetSeconds`).
- GPS: `RKVersion.latitude/longitude` (photos) else `exifLatitude/exifLongitude` (iphoto). Treat 0/0 and out-of-range as null.
- kind: UTI/ext video (`com.apple.quicktime-movie`, `public.mpeg-4`, `.mov/.mp4/.m4v/.avi`) → video else image. width/height from RKMaster or RKVersion masterWidth/Height; duration from RKMaster.duration (photos) / RKVersion.naturalDuration.
- favorite: `RKVersion.isFavorite` (photos) or `mainRating > 0` (iphoto). hidden: `isHidden`. title: `RKVersion.name` (null when empty or equal to the file name without ext). description: `extendedDescription`. keywords: `RKKeywordForVersion` ⨝ `RKKeyword.name`.
- albums: `RKAlbumVersion(versionId)` ⨝ `RKAlbum` where `isInTrash=0`, `isMagic=0`, name non-empty.
- Resources (photos kind only): build an index of `resources/media/{master,version}/**/<prefix>_<hex>.<ext>` keyed by lowercase hex suffix. Then for RKModelResource rows:
  - `resourceType=7, attachedModelType=1` → `motion` of master with `modelId=attachedModelId` (file `jpegvideocomplement_<hex(modelId)>.*` under `media/master`).
  - `resourceType=4, attachedModelType=2` → `edited` of the version `modelId=attachedModelId` (file `fullsizeoutput_<hex(modelId)>.*` under `media/version`).
  - Missing file → warning, child null. iPhoto: no children in v1.

## Date policy (`dates.ts`, pure, `resolveTakenDate(item, exif|null) → ResolvedDate`)
1. `item.imageDateUtc` present → tsSource `library-db`; if `tzOffsetSec` known: takenLocal = utc + offset, tz = ±HH:MM, kind `exact`; else takenLocal from EXIF DateTimeOriginal if present (kind `local-only`, tz null) else UTC wall clock with tz `+00:00` kind `exact`.
2. EXIF `DateTimeOriginal` (+ `OffsetTimeOriginal` → exact, tsUtc computed) else (+ GPS UTC time → offset = local−gps rounded to 15 min → exact) else `local-only` (tsUtc null). tsSource `exif`.
3. QuickTime `CreationDate` (tz-aware) → exact; else `CreateDate` (UTC; local = UTC, tz `+00:00`, kind exact). tsSource `quicktime`. Reject `0000:00:00` and years < 1990.
4. else `{takenLocal:null, tz:null, tzOffsetSec:null, tsUtc:null, tsSource:null, tsKind:'unknown'}`.
Buckets: `ym = takenLocal.slice(0,7)`, `day = takenLocal.slice(0,10)` — local capture time, never UTC.

## exif.ts
`exiftool-vendored` singleton (`readExif(absPath) → ExifInfo`, `readExifBatch(paths, concurrency=4)`, `closeExif()`; tests must call `closeExif()` in `after`). Parse into `ExifInfo` (types.ts). Video duration from QuickTime `Duration`.

## Canonical layout (share root = dest root, e.g. `/Volumes/bryan`)
- Primary: `HITLOOP-ARCHIVE/timeline/<YYYY>/<MM>/<YYYY-MM-DD>_<HHMMSS>_<sha8>.<ext>` from `takenLocal`; unknown → `HITLOOP-ARCHIVE/timeline/unknown/<sha8>.<ext>`. ext lowercase, `jpeg`→`jpg`.
- Children: same base + `_motion.<ext>` / `_edited.<ext>`.
- Sidecar: `HITLOOP-ARCHIVE/timeline/_meta/<sha256>.json` (`Sidecar`, pretty JSON, tmp+rename). Re-runs merge `locations` (dedupe by sourceId+relativePath) and albums (union).
- Different sha already at the canonical path → `conflict` (never overwrite; reported, skipped).

## Local manifest (`manifest.ts`, SQLite `~/.photolib/photolib.sqlite`; `PHOTOLIB_HOME` overrides dir)
```sql
create table if not exists sources (id text primary key, kind text not null, library_path text not null, label text, added_at text not null);
create table if not exists assets (sha256 text primary key, id text not null, kind text not null, ext text not null, size_bytes integer not null,
  width integer, height integer, duration_sec real, taken_local text, tz text, tz_offset_sec integer, ts_utc text, ts_source text, ts_kind text not null,
  lat real, lon real, canonical_path text not null, sidecar_path text not null, sidecar_json text not null,
  copied_at text, verified_at text, thumb_s text, thumb_m text, pushed_at text, push_hash text, updated_at text not null);
create table if not exists children (parent_sha text not null, role text not null, sha256 text not null, ext text not null, size_bytes integer not null,
  duration_sec real, canonical_path text not null, copied_at text, primary key (parent_sha, role));
create table if not exists locations (source_id text not null, relative_path text not null, sha256 text not null, master_uuid text, version_uuid text,
  original_file_name text not null, primary key (source_id, relative_path));
create table if not exists runs (run_id text primary key, source_id text not null, command text not null, started_at text not null,
  finished_at text, state text not null, summary_json text);
create table if not exists journal (id integer primary key autoincrement, run_id text not null, sha256 text not null, role text not null,
  dest_path text not null, size_bytes integer not null, at text not null, undone_at text);
create index if not exists idx_locations_sha on locations(sha256);
create index if not exists idx_journal_run on journal(run_id);
```
`role` in journal = `primary|motion|edited|sidecar`. A sidecar row is journaled only when the sidecar file was created by that run.

## Commands (analyzer plugin `photolibPlugin()`, registered in `lib/discogs/analyzer-entry.ts`) + CLI
`npm run photolib -- <plan|apply|undo|thumbs|push|status> --library <abs> [--dest-root /Volumes/bryan] [--source-id id] [--limit N] [--run <runId>] [--json]`
- `PHOTOLIB_PLAN {sourceId, libraryPath, limit?}` → `{planId, totals, sample: PlanItem[≤20] (paths only), warnings}`. Plan JSON saved at `~/.photolib/plans/<planId>.json`. Hashing (sha256 of each file) happens here; hashes cached in manifest by (source_id, relative_path, size).
- `PHOTOLIB_APPLY {planId, limit?}` → `{runId, copied, present, duplicate, conflict, children, bytes, errors[], cancelled?}`. Resumable (re-run same planId skips verified rows). Progress PATCH every 10 items as `result.progress {done,total,bytes}`. `isCancelled` checked per item.
- `PHOTOLIB_UNDO {runId, limit?}` → removes only files journaled by that run whose current sha still matches; marks `undone_at`; removes manifest rows whose primary copy was undone. Never touches a file not in the journal.
- `PHOTOLIB_THUMBS {limit?}` → for assets missing thumbs: JPEG 320px (s, q≈4) + 1600px (m, q≈3) long edge, from the canonical copy (videos: poster frame at 1s or 0). Local cache `~/.photolib/thumbs/<sha16>_{s,m}.jpg`. HEIC: `sips` fallback.
- `PHOTOLIB_PUSH {limit?, force?}` → `POST life/upload-urls` (≤200/req) → PUT thumbs → `POST life/results` (≤100 items/req). push_hash = sha256(JSON(LifeItem)); unchanged rows skipped unless force.
- sourceId default: `photos-` + slug of the bundle's parent folder (`Drive 1 Backup` → `photos-drive-1-backup`).
- Source info pushed with every results call: `source:{id, kind, label, libraryPath}` (share-relative path, no `/Volumes`).

## Bundle skip (existing walkers must not descend into libraries)
Add `isLibraryBundle(name)` in `lib/archive/media-type.ts` (`/\.(photoslibrary|photolibrary|migratedphotolibrary)$/i` or exactly `iPhoto Library`/`Photo Booth Library`), used by `worker.ts walk`, `analyzer/analyze.ts walkMedia`, organize `planner.ts`. Also skip `HITLOOP-ARCHIVE/timeline` in the analyzer walk (like `HITLOOP-ARCHIVE/content`). Recognise `.aae` (sidecar, mediaType 'other') and RAW exts (`.cr2 .nef .arw .dng .raf .orf .rw2`) as image.

## Thumbnails
JPEG, not WebP: this Mac's ffmpeg has no libwebp and `sips` cannot write WebP (2026-11-06); no new tools added. Storage: `life-thumbs/<sha16>_{s,m}.jpg`, contentType `image/jpeg`.
