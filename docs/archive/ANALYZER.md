# NAS analyzer (`npm run archive:analyzer`)

Separate long-running process (own worker id `${HITLOOP_ARCHIVE_WORKER_ID}-analyzer`) in `lib/archive/analyzer/`. Read-only on the NAS and on the worker SQLite (`ARCHIVE_DB_PATH`, default `./.moleboard/archive.sqlite`, opened `readonly`).

Env: `HITLOOP_ARCHIVE_CONTROL_URL`, `HITLOOP_ARCHIVE_WORKER_TOKEN`, `HITLOOP_ARCHIVE_WORKER_ID`, `ANTHROPIC_API_KEY`; optional `ARCHIVE_ANALYZER_HOME` (default `~/.archive-analyzer`), `FFMPEG_PATH`, `FFPROBE_PATH`, `ARCHIVE_DB_PATH`.

Local state under `~/.archive-analyzer/`: `cache/<sha>.<hash(promptVersion,model)>.json` (analysis cache), `thumbs/<sha>.jpg` (320px, never uploaded), `cost.jsonl` (ledger; Haiku 4.5 rates in `cost.ts` `RATES`).

Commands (claimed immediately, executed serially): `ANALYZE_FACETS`, `STAGE_FOR_PUBLISH`, `CANCEL_JOB` (`targetCommandId`; none = everything in flight).
- ANALYZE_FACETS `{sourceId, paths[], capUsd=5, model, promptVersion, dryRun}`: dryRun returns `{estimate:{files,images,videos,cached,estUsd}}` (cached only counted when the worker DB already knows the file's hash). Real run returns `{done,total,spentUsd,cached,pushed,errors,errorCount,cappedAt?,cancelled?}`. RUNNING progress is PATCHed every 5 files as `result.progress`.
- Safety: `people[]` is dropped unless the name appears in the model's OCR text or the folder path; no face identification is requested. Folder path hints sent are relative only.
- STAGE_FOR_PUBLISH: videos over 512MB fail.

Local server `127.0.0.1:8777`: `/health`, `/thumbs/<sha>.jpg`, `/media/<sha>` (Range). CORS: localhost:3000-3002, hitloop.agency, www.hitloop.agency; loopback Host only.

Tests: `npx tsx --test lib/archive/analyzer/analyzer.test.ts` (fakes only; one ffmpeg test runs locally).

## NAS browse, connect and organize-on-analyze

Local server (127.0.0.1:8777; CORS for localhost:3000/3001/3002 + hitloop.agency; OPTIONS preflight handled):
- `GET /nas/status` -> `{mounted, mountPoint, smbUrl, sources:[{id,label,root,reachable}]}` (NAS sources only; "Cloud intake" excluded). Mount info is read from `mount` at runtime, fallback `smb://GUEST@192.168.1.6/bryan`.
- `POST /nas/connect` -> guest-mounts via `osascript` (30s timeout) if not mounted, returns status. Never unmounts.
- `GET /nas/browse?sourceId=&path=` -> read-only listing `{ok, path, parent, entries:[{name, relativePath, kind, mediaType?, sizeBytes?, childCount?}], truncated?}`. Dirs first; hides dotfiles, `@eaDir`, `#recycle`, `HITLOOP-ARCHIVE/content/_meta`; absolute/`..`/symlink escapes rejected; 2000-entry cap.

Organize (COPY only, originals never moved/deleted): after a successful analysis the file is copied to `<root>/HITLOOP-ARCHIVE/content/<vibe.kind>/<year read off the flyer text|unknown>/<filename>` (temp file + rename, size verified). A different-sha name collision gets `-<sha8>` before the extension; same sha is skipped. Sidecar `content/_meta/<sha256>.json` (analysis + originalRelativePath + organizedRelativePath + analyzedAt) and thumb `content/_meta/thumbs/<sha256>.jpg`. Result items carry `organizedPath`. `/media/<sha>` and STAGE_FOR_PUBLISH prefer the organized copy; the analyzer walk skips `HITLOOP-ARCHIVE/content`. Code: `lib/archive/analyzer/nas.ts`; tests: `nas.test.ts`.

## NAS copy/move (user-directed)

Loopback-only endpoints on the analyzer server (same CORS as `/nas/*`; POST bodies are JSON; cross-origin POSTs from origins outside the allow-list get 403). Code: `lib/archive/analyzer/fileops.ts`; tests: `fileops.test.ts`. See D016.
- `POST /nas/ops/plan {op:'copy'|'move', sourceId, paths[], destSourceId, destPath}` -> `{ok, planId, items:[{from,to,kind,sizeBytes,renamed}], totals:{files,bytes,renamed}, sameShare}` (or `{ok:false,error}` 4xx). `paths` are relative to the source root (files or folders); `destPath` is an existing directory relative to the destination root (`''` = root). Plans live in memory for 30 min. Never overwrites: a taken name becomes `name (2).ext`, `name (3).ext`, ... (re-checked at apply time).
- `POST /nas/ops/apply {planId}` -> `{ok, jobId}`. Runs in the background, one job at a time (others queue); a plan can be applied once.
- `GET /nas/ops/jobs` -> `{jobs:[{id, op, state: queued|running|done|failed|cancelled, files, filesDone, bytes, bytesDone, currentFile?, attempt?, error?, startedAt, finishedAt?}]}` newest first, last 20 kept.
- `POST /nas/ops/cancel {jobId}` -> `{ok}`; kills the rsync child, state `cancelled`.

Engine: same-share move = `fs.renameSync` (instant). Everything else uses Homebrew rsync >= 3 (`/opt/homebrew/bin/rsync`, else `which rsync`) with `-a --partial --partial-dir=.rsync-partial --timeout=120 --info=progress2 --no-inc-recursive` (argv array, no shell), retrying exit codes 10/11/12/20/23/24/30/35 up to 4 times (2s, 5s, 10s, 10s) so interrupted big files resume. Cross-share move copies, verifies every planned file size at the destination (and that the source still matches), then unlinks those source files and `rmdir`s empty dirs bottom-up (never recursive; any failure leaves the source intact). Skips dotfiles, `@eaDir`, `#recycle`, symlinks.
Guards: rejects `..`, absolute paths, symlinks, escapes from the source root, `HITLOOP-ARCHIVE/content/_meta`, a destination inside a folder being copied/moved, nested selections; max 500 top-level items and 2,000,000 files; needs destination free space >= bytes + 1 GB (413/507 otherwise).

## Flyer event dates (no extra model calls)

Facets gain optional fields, computed locally by `lib/archive/analyzer/event-date.ts` from `facets.ocrText`, and only when `facets.vibe.kind === 'flyer'`: `eventDate` (YYYY-MM-DD, only when the year is known), `eventMonthDay` ('MM-DD'), `eventYear`, `eventYearSource` ('printed' | 'weekday' | null), `eventYearCandidates`, `eventDateRaw` (matched printed text), `eventDates` (up to 5 distinct dates in reading order: `monthDay`, `year`, `yearSource`, `raw`, `weekday`). `dateText` is untouched; `promptVersion` is unchanged, so the cache key and cached Claude results stay valid.

**Rule: event dates come ONLY from the flyer's printed text.** Never from file metadata (capturedAt/mtime/EXIF), the folder path, or the model's `eraYear` guess. A printed year always wins. With no printed year, the year is inferred only from a printed weekday next to a month/day, and only when exactly one year in the window fits; if several fit, `eventYear` is null and `eventYearCandidates` lists them; month/day alone is a valid result (useful for "on this day" posts). The window defaults to 2014 to current year + 1 (`windowFrom`/`windowTo` options of `extractEventDates`); narrow it to disambiguate (e.g. May 24 is a Friday in 2019 and 2024).

Cache hits missing the fields get them computed on read (`eventDateRaw === undefined`), so re-running a folder re-pushes them for free. To write them into existing cache files without a run: `npm run archive:analyzer:dates [-- --dry-run]` (no network, no Claude, atomic tmp+rename).

## Batch mode (opt-in, 50% cheaper, async)

`ANALYZE_FACETS` commands may carry `batch: true`. Without it the synchronous path is unchanged. Implementation: `lib/archive/analyzer/batch.ts` (`runAnalyzeBatch`), request body shared with the sync call via `buildRequestParams` in `vision.ts`.

- **Estimates**: `dryRun` and `POST /nas/estimate {..., batch: true}` return `estimate.batch: true` with `estUsd` and `perFileUsd` multiplied by `BATCH_DISCOUNT` (0.5, `cost.ts`).
- **Flow**: walk like the sync path (cache hits are free and pushed as before); hash + prepare the uncached files; submit to `POST /v1/messages/batches` in chunks of at most 300 requests (`custom_id` = file sha256; media is built per chunk and freed); poll `GET /v1/messages/batches/{id}` every 20s; then read `results_url` (JSONL). `succeeded` lines get the same post-processing as the sync path (sanitize, grounding, event dates, cache under the same key, thumb, organized copy, ledger, push in batches of 10). Media is re-prepared at save time for the thumb/dimensions. `errored`/`canceled`/`expired` lines count in `errors` and are not billed.
- **Cap is enforced up front** (a batch cannot stop mid-way): only as many uncached files as fit `capUsd / (per-file cost * 0.5)` are submitted; `cappedAt` is the NUMBER of files left out (the sync path reports a path string).
- **Billing**: ledger `usd` = token cost * 0.5, line has `batch: true`. Batch lines are excluded from the measured per-file average.
- **State / resume**: `ARCHIVE_ANALYZER_HOME/batches.json` (atomic write) = `{ [batchId]: { createdAt, commandId, shas[], state: 'submitted'|'ended'|'processed', model, promptVersion, sourceId?, paths?: { [sha]: relativePath[] } } }` (`sourceId`/`paths` on records created since collect-only; older records lack them). Before submitting, any non-`processed` batch whose shas cover a file is ADOPTED (restart or re-click never double-bills); `ended` batches go straight to result fetch. A batch is marked `processed` only after all its items are saved (and only if every sha belonged to the selection).
- **Progress** (PATCH each poll): `result.progress = { done, total, spentUsd: 0, phase: 'preparing'|'submitted'|'waiting'|'saving', batchIds, batchCounts: { processing, succeeded, errored } }` (`done` = succeeded + errored, `total` = requests across tracked batches).
- **Result**: sync shape (`done,total,spentUsd,cached,pushed,errors,errorCount,organizeErrors,cappedAt?,cancelled?`) plus `batch: true, batchIds`.
- **Cancel**: `isCancelled` is checked each poll; on cancel the batches are cancelled via `POST /v1/messages/batches/{id}/cancel`, whatever already succeeded is still collected, and the result has `cancelled: true`.
- Anthropic keeps batch results available for 29 days, so an adopted batch can be collected after a restart within that window. Typical completion is well under 24h (max 24h).

### Collect-only (no folder walk)

`collectPersistedBatches` (`lib/archive/analyzer/collect.ts`, tests `collect.test.ts`) settles every non-`processed` record in `batches.json` without walking folders and never submits anything:
- All shas already cached -> marked `processed`; no network, no ledger line, no push (`already-cached`).
- Some shas missing and the record has `sourceId` + `paths` -> free `GET /v1/messages/batches/{id}` (+ `results_url`); not ended yet -> `still-processing`. Each missing succeeded result is saved through the same `saveBatchItem` as the batch save loop (ledger line only when the cache entry is written here, so nothing is billed twice), organized, and pushed by its stored paths (`pushResults`, 3 tries; a push failure is reported and the cache hit is re-pushed by the next run). `errored`/`expired`/`canceled` rows are not billed and do not block `processed` (a later run resubmits them). If any file could not be saved the record stays adoptable (`partial`).
- Old records without paths and with missing shas -> `needs-run` (left for a normal Analyze run to adopt; saving needs the file for thumb/dimensions).
- Triggers: (a) once on daemon start, on the serial worker before the first queued command; (b) command `COLLECT_BATCHES` (no fields; advertised in poll `types` + heartbeat `capabilities`). Result: `{ batches: [{ id, action, saved?, pushed?, errors?, spentUsd?, error? }], spentUsd, saved, pushed }`, `action` one of `already-cached | collected | partial | still-processing | needs-run | no-api-key | failed`.

### Done index (fast re-runs)

`ARCHIVE_ANALYZER_HOME/done-index.json` (`lib/archive/analyzer/done-index.ts`, tests `done-index.test.ts`; plain JSON, atomic tmp+rename, saved every 10s and at the end of a run) = `{ version: 1, sources: { [sourceId]: { files: { [relativePath]: { sizeBytes, mtimeMs, sha256, promptVersion?, model?, organizedRelativePath?, pushedAt? } }, dirs: { [dirRelativePath]: { mtimeMs, entries: [{name, kind:'file', sizeBytes, mtimeMs} | {name, kind:'dir'}] } } } } }`. Never built by a NAS scan: dir listings are written by walks, file entries as files are emitted, `pushedAt` once HITLOOP accepts the push.
- **Walk** (`walkMedia`, every ANALYZE_FACETS incl. dry runs): a directory whose own mtime equals its stored listing is not re-listed and its files are not lstat'ed (one stat per directory). Adding/removing/renaming files changes a directory's mtime; an in-place edit does not (use `verify`).
- **Preparing loop (batch mode)**: walked size+mtime match the index entry, same promptVersion/model, cache file exists, `organizedRelativePath` set (or organize off) and `pushedAt` set -> counted as cached and skipped entirely (no hash, no organizeCopy, no push; result field `indexSkipped`). Organized but not pushed -> organizeCopy skipped, item pushed with the indexed `organizedPath`. A path whose size/mtime changed is hashed (the ledger path->sha shortcut is not trusted for it). Progress (`phase: 'preparing'`) keeps reporting.
- **`verify: true`** on ANALYZE_FACETS: ignores the index (full per-file walk, organize checks and pushes, today's path) and refreshes it. Use after editing files in place or if organized copies were removed.
- The first run over a folder after the index exists still pays the full per-file cost once (nothing indexed yet); later re-runs of unchanged folders cost one stat per directory. The sync (non-batch) path uses the indexed walk but not the per-file skip.

**Restart rule**: do not restart the analyzer while an ANALYZE job is RUNNING. A restart with `submitted`/`ended` records is safe once collect-only is deployed (start-up collect settles them); before that, ask the owner.
