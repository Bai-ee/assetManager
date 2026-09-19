# HITLOOP Archive — Current State

Updated: 2026-09-19

CURRENT PHASE: Phase 1 — NAS foundation
STATUS: IN PROGRESS

## Confirmed
- Primary source is Bryan's ~1 TB WD My Cloud EX2 Ultra NAS.
- User selects individual NAS folders for processing.
- assetManager already contains local scanning/indexing concepts and will evolve into the archive worker.
- Existing scanner currently accumulates files in memory and uses synchronous filesystem calls; it must be replaced/evolved for large resumable scans.
- Existing content ID is SHA-256(path:size:mtime), not a byte hash; exact dedupe requires streaming SHA-256 of file bytes.
- Existing JSON-per-asset index is not sufficient as authoritative large-job state; durable SQLite manifest/job state is planned.
- TwelveLabs is primary POC video understanding.
- Jev is structured decision/classification layer after normalized observations.
- Processed archive receives new organized naming/structure while original NAS paths remain provenance.
- Collection-level approval is required before permanent upload.
- Arweave quote is required before upload.
- Public Arweave archive and Arweave-hosted independent dashboard are required.
- Quick ingest for individual/small uploads remains a secondary HITLOOP path.

## Completed this phase
- Inspected assetManager README/package structure.
- Inspected lib/scanner/scanner.ts and CLI.
- Inspected lib/content-id/indexer.ts.
- Inspected scan/search API routes and local store.
- Established master architecture, data model, phased implementation plan, test plan, and agent handoff protocol.

## Next exact tasks
1. Audit port_2026 docs/source-of-truth, /archive-compatible route/UI patterns, auth, Firebase/job infrastructure.
2. Search Bryan GitHub repositories for established Arweave upload + cost-estimation code and document reusable implementation.
3. Verify current TwelveLabs API constraints for NAS-originated large video ingestion and provider persistence.
4. Verify Jev API/integration contract and decide adapter boundary.
5. Determine practical always-on worker deployment for WD My Cloud EX2 Ultra environment.
6. Only after Phase 0 decisions are recorded, begin Phase 1 worker implementation.

## Known risks/open questions
- Exact worker host/container capability on WD My Cloud EX2 Ultra is not yet verified.
- Arweave legacy implementation location is not yet identified.
- External provider credentials are not assumed available.
- Public archive metadata must avoid leaking local absolute paths/network details.

## Last verified branch
feat/archive-master-plan


## 2026-09-19 Phase 1 implementation checkpoint
Implemented:
- lib/archive/types.ts processing/job/source/location/content contracts
- lib/archive/hash.ts streaming SHA-256 over actual file bytes
- lib/archive/manifest.ts atomic durable manifest checkpointing
- lib/archive/worker.ts incremental async directory traversal, source registration, selected-folder jobs, exact hash dedupe, unchanged-file skipping, retryable file failures, file-change-during-hash protection
- lib/archive/cli.ts worker CLI
- npm script: archive:scan
- Existing NAS originals remain read-only.

Important: JSON manifest is an executable first checkpoint, not the final scale persistence layer. SQLite migration remains required before declaring Phase 1 complete.

Next exact tasks:
1. Add SQLite-backed ManifestStore and migration/bootstrap schema.
2. Add explicit pause/resume and interrupted RUNNING-job recovery.
3. Add source-offline detection rather than allowing a disconnected walk to look complete.
4. Add tests for duplicate paths, changed files, restart recovery, traversal escape, and source disconnect.
5. Run TypeScript/build validation.


## Phase 1 checkpoint — durability controls
Implemented:
- SQLite WAL persistence is now the active worker state layer.
- Explicit pause() and resume() job controls.
- RUNNING jobs recover to PAUSED after worker/database restart.
- In-flight HASHING/ANALYZING/UPLOADING records recover as RETRYABLE_FAILED.
- Source availability is checked before traversal and again before COMPLETE; an unavailable NAS pauses the job and marks the source OFFLINE.
- Added archive validation scripts: npm run typecheck and npm run test:archive.
- Added tests for byte-identical dedupe, incremental unchanged rescans, changed-file rehash, restart recovery, and path traversal rejection.

Still required before Phase 1 is complete:
1. Run install/typecheck/test in an execution environment and fix any compile/runtime failures.
2. Add a stronger disconnect signal during deep traversal (current end-of-run source access check catches root disappearance, but individual subtree errors are still skipped).
3. Add stable-file dwell policy before hashing files actively being written.
4. Add worker heartbeat/control-plane contract.
