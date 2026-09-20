# HITLOOP Archive — Decision Log

## D001 — NAS-first ingestion
Primary POC source is Bryan's ~1 TB WD My Cloud NAS. Browser uploads are secondary one-offs.

## D002 — Source files are read-only
Archive processing never renames, moves, deletes, or modifies NAS originals.

## D003 — New archive organization
Processed/approved content receives normalized archive names and logical structure. Original source path remains provenance.

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
POC supports approving a processed collection at once, with asset-level exceptions. No automatic permanent upload.

## D010 — Quote before permanence
Arweave cost must be shown and explicitly approved before permanent upload. Other processing costs may also be shown.

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
