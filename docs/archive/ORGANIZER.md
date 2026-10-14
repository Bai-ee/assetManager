# NAS Organizer (W-B)

Implements DECISIONS.md D003 and the narrowed D002 exception: the worker may
write inside the NAS, but only inside one owned root,
`<source rootPath>/HITLOOP-ARCHIVE/`, and only by moving (never copying) a
canonical video/image file there, with a journal that makes every move
reversible. Everything else on the NAS stays exactly as read-only as before.

Source of truth for the design: `docs/plans/ARCHIVE-NAS-STAGING-MASTER-PLAN-2026-09-20.md`
§3a/§3b/§4 (workstream W-B) in the HITLOOP repo. This doc describes the
as-built worker side.

## Modules (`lib/archive/organize/`)

- **`scheme.ts`** — pure, dependency-free: `ORGANIZED_ROOT_NAME`, the
  extension allowlists (movable video/image vs. never-move audio/project),
  project-folder names, the pillar taxonomy, `slugifyCollectionId`/
  `collectionTitleFromPath` (ported from HITLOOP's
  `api/_lib/archive-permanent-archive.cjs`), target-path building, the
  collision-suffix rule, and the `isUnderOrganizedRoot` assertion. `worker.ts`
  imports `ORGANIZED_ROOT_NAME`/`isFilesystemArtifact` from here (canonical
  definitions now live in this pure module, not in `worker.ts`).
- **`planner.ts`** — read-only: walks the selected folder on disk (its own
  walk, independent of the worker's discovery pass, so it can see and report
  on hidden/artifact/unhashed files too), cross-references
  `file_locations`/`content_assets`/`jev_decisions` in SQLite, and returns an
  `OrganizePlan` (`{root, collectionId, moves[], skipped[], counts}`). Writes
  nothing to disk or SQLite — safe to call as many times as the UI wants
  before anyone clicks APPLY.
- **`journal.ts`** — the append-only history, written in two places for
  redundancy: `moves.jsonl` under `<collectionDir>/_meta/` (human-inspectable,
  NAS-portable) and the `organize_moves` SQLite table (what `UNDO_ORGANIZE`
  actually replays from, so undo still works if the NAS `_meta` file is lost
  or unreachable).
- **`mover.ts`** — `applyOrganizePlan` (perform the moves) and
  `undoOrganizeJob` (replay one job's moves backwards). Every target path is
  asserted under `HITLOOP-ARCHIVE/` before anything touches disk.
- **`sidecars.ts`** — writes `_meta/collection.json` (latest-state summary of
  the most recent apply for a collection) and `_meta/<sha12>.record.json`
  (per-asset provenance: every Jev decision + an observation summary), so the
  organized tree carries a self-contained record independent of HITLOOP/
  SQLite. Best-effort — a sidecar write failure never turns a successful
  apply into a failed one.

## What moves

Only files matching ALL of:

- Inside the folder a `PROCESS_COLLECTION` job actually processed (same
  `sourceId` + `relativePath`), after that job's hash/analysis/Jev step ran.
- The **canonical** location of a content asset (`file_locations.state !==
  'DUPLICATE'`) — a byte-identical duplicate path is reported as skipped
  (`reason: 'duplicate location'`) and never touched.
- Extension is video (`mp4 mov m4v webm mkv avi`) or image
  (`jpg jpeg png heic gif webp tif tiff`).

## What never moves

- Audio (`wav aif aiff mp3 flac m4a ogg`) — always skipped, regardless of
  location.
- Project files (`als alp logicx flp ptx cpr rpp`), and **any folder,
  recursively, that directly contains one** — that folder and everything
  beneath it (Samples/, Backup/, deeper nesting, even an otherwise-movable
  video sitting loose inside it) is excluded. Folders literally named
  `Ableton Project Info`, `Samples`, or `Backup` are excluded outright at any
  depth, independent of whether they contain a project file.
- Anything already under `HITLOOP-ARCHIVE/`, `._*`/`.DS_Store` artifacts,
  other hidden files, and unknown extensions.

Exclusion-check order in `planner.ts` (each reason is independently
reachable/testable): filesystem artifact → hidden file → project file
extension → audio extension → inside a project folder → unsupported
extension → not yet hashed → duplicate location → already organized.

Every skip is recorded with its reason in `plan.skipped`.

## Where it lands

```
<source rootPath>/HITLOOP-ARCHIVE/
  <collectionId>/              slugifyCollectionId(job.selectedRelativePath)
    <pillar>/                  was-there | made-this | found-this | how-made | thirty-years | building-now
    _unsorted/                 no jev "pillar" decision, or its confidence is
                                below the QUICK_REVIEW band (reviewBand() in
                                jev/service.ts), or the value isn't one of the
                                six known pillars
    _meta/
      collection.json          latest-apply summary: {schema, collectionId, title,
                                sourceRelativePath, organizedAt, assets[], skipped[]}
      <sha12>.record.json      per-asset provenance: {schema, sha256, sizeBytes,
                                mediaType, originalRelativePath,
                                organizedRelativePath, decisions[], observationsSummary[]}
      moves.jsonl              append-only journal: one JSON line per move,
                                {ts, jobId, sha256, from, to, sizeBytes, reason}
```

Filenames are kept verbatim. A same-folder collision (two different assets
that would land on the same filename) gets ` (<sha12>)` inserted before the
extension on the second one (`withCollisionSuffix`).

### Per-client NAS (`lib/archive/clients.map.json`)

A committed map `{ "<client-slug>": "<HITLOOP clientId>" }` (lowercase-kebab
slugs, ids `[A-Za-z0-9_-]{3,80}`, validated at load: a bad entry throws) scopes
content to a client. Home is never listed. `clientForPath()` in
`lib/archive/clients.ts` resolves a source-root-relative path:
`HITLOOP-ARCHIVE/<slug>/...` or `<slug>/...` at the source root -> that client;
anything else (legacy top-level collections, unknown folders) -> null.
`HITLOOP-ARCHIVE/<slug>/<pillar|_unsorted|_meta>/...` is read as a legacy
collection that shares the slug's name (same rule in `clients.ts` and `scheme.ts`).

Rules:
- A slug must not equal an existing legacy collection id. Reserved slugs:
  `content`, `root`, `hitloop-archive`, and the six pillar names.
- A source-root folder named exactly like a slug (`<slug>/...`, case-sensitive)
  is treated as that client's drop folder. Keep home content out of such names.
- The organizer rejects a legacy (home) collection whose id equals a slug, and an
  item selection that mixes client folders (or a client with home items).

- Organizer: a selection under `<slug>/...` (items: every item must agree)
  lands in `HITLOOP-ARCHIVE/<slug>/<collectionId>/<pillar>/` (same `_meta`,
  journal and undo, one level deeper). `collectionId` is still
  `slugifyCollectionId(selectedRelativePath)`, so it matches HITLOOP's id.
  `plan.clientSlug` carries the scope; legacy plans omit it and are unchanged.
- Analyzer copy: client items go to `HITLOOP-ARCHIVE/<slug>/content/<kind>/<year>/`;
  `_meta` sidecars stay in the shared `HITLOOP-ARCHIVE/content/_meta/` (keyed by sha).
- Wire: analyzer result items carry `clientId` from their own `relativePath` only
  (never `organizedPath`, since sha-keyed sidecars are shared). Asset-sync payloads
  carry `clientId` only when every location of the asset maps to the same client.
  Home/legacy/mixed send no `clientId` and HITLOOP falls back.
- Undo: tries the client location first, then always the legacy top-level
  location, so collections organized before this change still undo.

To add a client, add one line to `clients.map.json` (public ids only).

## Commands

Both are handled in `daemon.ts`'s `execute()`, alongside the existing
`PROCESS_COLLECTION`/`LIST_DIRECTORY`/`UPLOAD_ASSET_ARWEAVE`/`UPLOAD_JSON`
commands.

### `ORGANIZE_COLLECTION { sourceId, relativePath, mode: 'plan' | 'apply' }`

- `mode: 'plan'` (or omitted) — calls `planOrganizeCollection` and completes
  the command with `result: { mode: 'plan', plan }`. Writes nothing.
- `mode: 'apply'` — plans, then calls `applyOrganizePlan` with `jobId` set to
  the command's own id (that id is what `UNDO_ORGANIZE` later references).
  Completes with
  `result: { mode: 'apply', jobId, root, collectionId, moved, skipped, counts, failedAt }`.
  On any per-file failure the command state is `FAILED` (files already moved
  in this run stay moved — recoverable via `UNDO_ORGANIZE`).
  After a successful apply, the daemon calls the existing `syncAsset` path
  once per moved asset with an added
  `organized: { path, appliedAt }` field on the asset payload
  (`control-plane.ts` `syncAsset`'s `asset.organized`). A non-2xx from
  HITLOOP here is a silent no-op, same as every other `syncAsset` call — it
  never fails the organize command. HITLOOP persisting `organized` is a later
  workstream.

### `UNDO_ORGANIZE { sourceId, relativePath | organizeJobId }`

Replays one apply job's `organize_moves` rows backwards (`fromPath`/`toPath`
swapped), verifying size after each rename, and stops on the first failure
(remaining moves stay recoverable from the same table on a retry). Pass
`organizeJobId` to target a specific apply run, or omit it and the daemon
resolves the **most recent** organize-apply job for the collection derived
from `relativePath` (`findLatestOrganizeJobIdForCollection` in `database.ts`).
Completes with `result: { jobId, restored: string[], errors: [] }`; a request
with no organize job at all for that collection throws (caught by the normal
`run()`-loop → `FAILED` path, matching every other unrecoverable command
validation error in `daemon.ts`).

## SQLite additions (`database.ts`)

- `file_locations.organized_path TEXT NULL`, `organized_at TEXT NULL` —
  where this location's canonical bytes currently sit, relative to the
  source's `rootPath`. `relative_path` itself never changes across an
  organize/undo cycle; only these two columns move.
- `organize_moves` table — the SQLite mirror of `moves.jsonl`, keyed by
  `job_id`, so `UNDO_ORGANIZE` works even if the on-disk `_meta` file is
  lost. `findLatestOrganizeJobIdForCollection(collectionId)` does a `LIKE
  'HITLOOP-ARCHIVE/<collectionId>/%'` scan over `to_path`.

Both are added via a guarded `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` in
`migrate()`, safe to run against an existing database.

- `collection_jobs.selection_json TEXT NULL`, `collection_id TEXT NULL` — a
  `PROCESS_SELECTION` job's `SelectionItem[]` (JSON-encoded) and its
  caller-supplied collection id. Absent (`NULL`) for an ordinary
  `PROCESS_COLLECTION` job, which keeps using `selected_relative_path` alone.
  Same guarded-`ALTER` pattern as the organizer's own columns above.

## Discovery guard (`worker.ts`)

`walk()` never descends into a directory named `HITLOOP-ARCHIVE` — it is the
organizer's own output, not new source content — **unless** the job's own
walk root is already inside one (a future correction re-file walking within
the organized tree itself). `planner.ts`'s own independent walk applies the
identical rule.

## Selections

`PROCESS_SELECTION` and an `{items}`-carrying `ORGANIZE_COLLECTION`/
`UNDO_ORGANIZE` let /archive's tree browser send an explicit multi-select
(individual files and/or whole folders) instead of one
`{sourceId, relativePath}` folder. Every `relativePath` is relative to the
source root — same convention as everywhere else in this worker.

```
SelectionItem = { relativePath: string, kind: 'file' | 'folder' }
```

### `PROCESS_SELECTION { sourceId, collectionId, items: SelectionItem[] }`

- `collectionId` must match `[a-z0-9-]{1,64}` (the same shape
  `slugifyCollectionId` produces for a single-folder job).
- `items` must have 1–500 entries; every `relativePath` must resolve inside
  the source root (no `..`/absolute escape) and must not sit inside the
  organizer's own reserved `HITLOOP-ARCHIVE/` output tree.
- A validation failure throws before any job is created — same convention as
  every other early-validation throw in `daemon.ts` (`execute()`'s run()-loop
  wrapper turns it into a `FAILED` command; a direct `execute()` call
  rejects).
- On success, creates a `CollectionJobRecord` carrying `selection`/
  `collectionId` (new `collection_jobs.selection_json`/`collection_id`
  columns — guarded `ALTER TABLE`, same pattern as `organized_path`) and runs
  it through the **identical** path `PROCESS_COLLECTION` uses: worker
  discovery/hash/dedupe -> `runAnalysisAndJev` -> `syncJobAssets` ->
  heartbeats -> `COMPLETE`/`FAILED`.
- Discovery (`worker.ts` `run()`/`selectionWalk`) is the union of each
  `folder` item (walked recursively with the exact `walk()` rules —
  `HITLOOP-ARCHIVE` skip, artifact skip) plus each `file` item (yielded
  directly; existence/stability failures land in the normal per-file
  `RETRYABLE_FAILED` path, same as every other discovered file). Overlap is
  deduped by absolute path, so a file inside one selected folder that is also
  separately selected (or covered twice by overlapping folders) is only ever
  hashed once. Hash/dedupe/state machine/counters are otherwise unchanged.

### `ORGANIZE_COLLECTION { sourceId, mode, collectionId, items: SelectionItem[] }`

Same `mode: 'plan' | 'apply'` contract as the single-folder form, scoped to
the item list instead of `relativePath`:

- `planOrganizeCollection` (`organize/planner.ts`) accepts either
  `{selectedRelativePath}` (unchanged) or `{items, collectionId}`. The
  artifact/hidden/project-file/audio/project-folder/unsupported-extension/
  not-yet-hashed/duplicate/pillar/collision rules are one shared
  implementation (`planEntry`) used by both shapes, so they can never drift.
  - Each `folder` item gets its own `findProjectDirs`/`walkAll` pass, scoped
    to that item's own root (exactly like `selectedRoot` in the single-path
    form) — a project-folder ancestor is reported relative to the folder
    ITEM's root, not the source root.
  - Each `file` item has no walked subtree of its own, so its ancestor chain
    (from its parent directory up to the source root) is checked directly
    for the same project-folder rule (`ancestorProjectFolder`).
  - The folder-scoped duplicate rule's "inside the selection" check becomes
    "inside any selected folder or equal to a selected file"
    (`isInsideItemsSelection`) — a duplicate whose canonical copy lives
    outside every selected item is still planned, same principle as the
    single-folder form.
  - Overlap between items is deduped (by resolved relative-to-source path)
    the same way `worker.ts`'s `selectionWalk` dedupes discovery.
- The resulting `OrganizePlan` carries `selection: SelectionItem[]` in place
  of `selectedRelativePath`; `root`, `collectionId`, `moves`, `skipped`,
  `counts` are unchanged shapes.
- `mover.ts`'s `applyOrganizePlan` is unchanged — every move still lands
  under `HITLOOP-ARCHIVE/<collectionId>/<pillar-or-_unsorted>/…` and is
  asserted under that root before anything touches disk.
- `sidecars.ts`'s `_meta/collection.json` records `selection: items` in place
  of `sourceRelativePath` when the apply was planned from an item selection;
  `title` falls back to the `collectionId` itself (there is no single path to
  title an item selection with).

### `UNDO_ORGANIZE { sourceId, relativePath? | collectionId? }`

Unchanged mechanically (still replays `organize_moves` rows backwards by
`jobId`). The only addition: an explicit `collectionId` on the command now
wins over deriving one from `relativePath` via `slugifyCollectionId` —
`findLatestOrganizeJobIdForCollection(collectionId)` resolves the latest
organize-apply job for that collection either way. This is what makes an
items-selection's organize job (which has no single `relativePath` to derive
a collectionId from) undoable by collectionId alone.

## What is NOT built here

- Human corrections on `/archive` that change `pillar` and enqueue a re-file
  move (HITLOOP-side, later workstream).
- HITLOOP persisting the `organized` field from `syncAsset` (later
  workstream; the field is sent, HITLOOP is free to no-op on it today).
- Real NAS/SMB rename behavior, and the `EXDEV` failure path in particular,
  are unverified — every test here runs against a local temp filesystem
  (`os.tmpdir()`), never `/Volumes/bryan`.
