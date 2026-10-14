# HITLOOP Archive — Decision Log

## D001 — NAS-first ingestion
Primary POC source is Bryan's ~1 TB WD My Cloud NAS. Browser uploads are secondary one-offs.

## D002 — Source files are read-only
**Restored/narrowed 2026-09-20 (docs/plans/ARCHIVE-NAS-STAGING-MASTER-PLAN-2026-09-20.md §1):**
Source files outside `HITLOOP-ARCHIVE/` are never modified in place; the
organizer moves canonical video/image files into that one owned root, with a
journal (`lib/archive/organize/journal.ts` + the `organize_moves` SQLite
table), so the move is always reversible via `UNDO_ORGANIZE`. Everything
outside that root remains exactly as D002 originally said: never renamed,
moved, deleted, or mutated.

## D003 — New archive organization
**Implemented 2026-09-20** by `lib/archive/organize/*` (`scheme.ts` naming
rules, `planner.ts` plan, `mover.ts` apply/undo, `journal.ts` history). See
`docs/archive/ORGANIZER.md`. Processed/approved content receives normalized
archive names and logical structure. Original source path remains provenance
(`file_locations.relative_path` never changes; only `organized_path`/
`organized_at` track where the bytes currently are).

## D004 — Exact dedupe
Use streaming SHA-256 of actual bytes for exact identity. Existing assetManager path+size+mtime hash is not sufficient.

## D005 — Durable worker
assetManager evolves into the NAS-side/archive worker. Long-running processing cannot depend on an open browser/laptop.

## D006 — SQLite local durability
Worker uses durable local records/state suitable for restart/reconnect. JSON-per-asset search is not the authoritative job state for large archives.

## D007 — TwelveLabs primary video POC
TwelveLabs is primary video-understanding provider for the POC, behind an adapter contract.

## D008 — Jev role
Jev consumes normalized structured evidence and makes typed taxonomy decisions. Raw multimodal perception occurs upstream.

## D009 — Collection approval
**Restored 2026-09-20** (docs/plans/ARCHIVE-NAS-STAGING-MASTER-PLAN-2026-09-20.md
§1, superseding an interim "documented asset → automatic Arweave upload"
revision): no automatic permanent upload; approval + quote required. POC
supports approving a processed collection at once, with asset-level
exceptions.

## D010 — Quote before permanence
**Restored 2026-09-20**: no automatic permanent upload; approval + quote
required. Arweave cost must be shown and explicitly approved before permanent
upload. Other processing costs may also be shown.

## D011 — Public Arweave
Approved Arweave archive/dashboard is public.

## D012 — Original bytes on Arweave
Permanent archive includes original source bytes, plus schema/metadata/provenance and optional derived previews.

## D013 — Permanent independent viewer
Arweave-hosted dashboard must remain useful without HITLOOP/Firebase.

## D014 — Reuse existing Arweave implementation
Search Bryan's existing repositories for upload/quote code before implementing a replacement.

## D015 — Development is resumable
Repository docs and commits, not any agent conversation, are the handoff source of truth.

## D016 — User-directed copy/move between NAS folders
User-directed copy/move between NAS folders: narrows D002; allowed only via the analyzer's `/nas/ops` endpoints, never overwrites, move removes the source only after a verified transfer, loopback-only. (Numbered D016, not D010: D010 is already "Quote before permanence".)
