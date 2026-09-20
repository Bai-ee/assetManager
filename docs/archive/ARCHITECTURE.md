# HITLOOP Archive POC — Master Architecture

Status: Approved planning baseline
Primary repository: Bai-ee/assetManager
Control plane repository: Bai-ee/port_2026

## Mission

Turn a selected folder on Bryan's ~1 TB WD My Cloud NAS into a resumable, deduplicated, AI-understood, human-approved, permanently public Arweave archive.

Primary path:

NAS → Archive Worker → media understanding → normalized evidence → Jev decisions → generated archive structure/names → collection review → Arweave quote → approval → Arweave upload → Arweave-hosted dashboard.

Secondary path: individual images, audio/video files, and small ZIPs can enter through HITLOOP /archive and feed the same downstream pipeline.

## Non-negotiable requirements

- NAS-first. Browser upload is secondary.
- User selects individual NAS folders to process.
- Processing must survive process restarts, NAS disconnects, provider failures, and long-running jobs.
- Original NAS files are read-only. Never rename, move, delete, or mutate source files.
- Exact duplicates are identified by SHA-256 of file bytes, not filename/path.
- Duplicate source locations remain provenance records but content is analyzed/uploaded once.
- Existing source paths/folder names are evidence and provenance.
- Processed archive content receives a new organized structure and naming scheme.
- Folder context may inform classification but is not automatically archival truth.
- Failed assets do not stop a collection.
- Re-scan processes only new or changed content.
- Human can review a collection and approve it at once, with exceptions.
- Arweave cost quote is mandatory before permanent upload.
- Other provider costs may be shown, but Arweave cost is the critical approval cost.
- Arweave originals are the original source bytes. Derived previews/thumbnails may also be stored.
- Approved Arweave archive is public.
- Permanent dashboard must be hosted on Arweave and must not require HITLOOP/Firebase to remain alive.
- Preserve provenance: source → observation → Jev decision → human correction → final archival record.
- Never represent an AI inference as human-confirmed fact.

## Physical topology

### NAS
WD My Cloud EX2 Ultra (WDBVBZ0000JCH-20). Holds authoritative source media until permanent upload succeeds.

### Archive Worker
Evolves from assetManager/MoleBoard. Runs on an always-on host with mounted NAS access. It is responsible for filesystem discovery, hashing, local durable state, queue execution, provider transfer, retries, and Arweave source streaming.

The worker must not depend on an open browser or laptop session. Exact deployment host is an implementation decision after verifying what can run reliably on the WD NAS; SMB-mounted access from an always-on bridge is acceptable.

### HITLOOP Control Plane
Bai-ee/port_2026. Private /archive UI for source/job status, collection review, generated structure, costs, approval, exceptions, and quick ingest.

### External intelligence
TwelveLabs is the primary POC video-understanding provider. Image/audio/document adapters feed the same normalized evidence contract. Jev receives compact structured evidence and makes typed taxonomy decisions; it does not receive raw media.

### Arweave
Permanent public storage for approved originals, archive records, manifests, relationships, analysis provenance, and the standalone archive dashboard.

## Identity model

Do not conflate filesystem locations with content.

Source → File Location → Content Asset.

A File Location represents where bytes were discovered:
- source_id
- absolute/relative source path
- size
- mtime
- discovery timestamps
- availability

A Content Asset represents unique bytes:
- sha256
- media type
- byte size
- processing state
- observations
- Jev decisions
- final archival record
- Arweave transaction references

Many File Locations may point to one Content Asset.

Future near-duplicate/variant detection must be modeled separately from exact-byte identity.

## Processing state machine

DISCOVERED
→ STABLE
→ HASHING
→ HASHED
→ DUPLICATE or QUEUED
→ EXTRACTED
→ ANALYZING
→ ANALYZED
→ JEV_PENDING
→ JEV_CLASSIFIED
→ REVIEW_PENDING
→ APPROVED
→ ARWEAVE_QUOTED
→ UPLOAD_PENDING
→ UPLOADING
→ UPLOADED
→ VERIFIED

Any processing state can transition to RETRYABLE_FAILED or TERMINAL_FAILED with recorded error/attempt metadata. Retries are idempotent.

## Collection model

A selected folder creates a Collection Job. The source hierarchy is retained as evidence. Collection-level context can be inferred from paths, dates, flyers, metadata, related assets, etc., then supplied as evidence to child assets.

Archive output is not required to mirror the NAS hierarchy. The system proposes normalized collection names, asset names, entities, relationships, dates, events, projects, and destinations.

## Evidence and decision boundary

Media provider output is an observation, not truth.

Pipeline:
raw source → deterministic metadata → provider observations → normalized Asset State → Jev typed decisions + probabilities → human review/correction → final archival record.

Jev should expose candidate choices and confidence/probability where supported. Low-confidence decisions enter review rather than silently becoming facts.

## Arweave logical package

/collection
  manifest.json
  schema.json
  /assets
    originals...
  /metadata
    asset records...
  /entities
    entities.json
  /relationships
    relationships.json
  /analysis
    observations.json
    jev-decisions.json

Physical implementation may use transactions/manifests rather than filesystem semantics. Logical structure and references must remain reconstructable without HITLOOP.

## Safety and invariants

1. Source bytes are read-only.
2. Permanent upload requires explicit collection approval in POC.
3. Quote before upload.
4. Verify Arweave transaction before marking an asset archived.
5. Never delete local source after upload.
6. A provider retry must not create duplicate logical assets.
7. Secrets/wallet keys never enter source control or Arweave metadata.
8. Partial collection completion is valid and visible.
9. Unsupported/corrupt files are recorded, not silently lost.
10. Every expensive provider call should be attributable to an asset/job for cost reporting.
