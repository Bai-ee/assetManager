# HITLOOP Archive — Current State

Updated: 2026-09-19

CURRENT PHASE: Phase 0 — Baseline and discovery
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
