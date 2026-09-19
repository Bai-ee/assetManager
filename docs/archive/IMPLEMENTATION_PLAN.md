# HITLOOP Archive POC — Implementation Plan

> **Agent note (2026-09-19):** Phases below describe the dependency model, not current completion. Several later-phase seams have already been implemented in parallel. Read `CURRENT_STATE.md` before starting work to see what exists now and what remains unverified.

The build is deliberately resumable for both data processing and agent development. Each phase has an explicit contract and acceptance gate. Do not start dependent work by guessing an unfinished contract.

## Phase 0 — Baseline and discovery

Owners: architecture/research agents.

- Audit assetManager scanner/indexer.
- Audit port_2026 architecture and source-of-truth docs.
- Locate and audit existing Bryan Arweave upload + cost-estimation implementation before writing new Arweave code.
- Verify current TwelveLabs ingestion/API constraints and Jev integration.
- Decide worker deployment target for WD My Cloud environment.
- Record decisions in DECISIONS.md.

Gate: no unknown critical dependency is being silently invented.

## Phase 1 — NAS foundation

Owner: Worker agent.

Replace current in-memory scan/index approach with durable incremental inventory.

Deliver:
- source registration
- selected-folder collection jobs
- streaming/incremental traversal
- stable-file detection
- streaming SHA-256
- SQLite manifest
- file-location/content-asset split
- exact duplicate detection
- persistent state machine
- retries/errors
- restart recovery
- NAS offline/reconnect handling
- incremental rescans
- read-only source policy

Gate tests:
- interrupt scan and resume
- disconnect/reconnect source
- duplicate same bytes under different names/paths
- add files after completion and rescan
- inaccessible/corrupt file does not stop job
- originals unchanged

## Phase 2 — Worker ↔ HITLOOP control plane

Owners: Worker + Control Plane agents.

Define versioned API/event contract. Worker establishes outbound authenticated communication so inbound access to the private NAS is unnecessary.

Deliver:
- worker identity/heartbeat
- source list/status
- folder browsing metadata
- create/pause/resume/cancel collection job
- progress counters
- errors/retries
- provider/cost events
- no raw NAS path leakage into public archive unless explicitly retained as private provenance

Gate: close browser/laptop; worker job continues and status is recoverable.

## Phase 3 — Media understanding adapters

Owners: Media agents.

Implement provider-neutral observation interface.

Video POC: TwelveLabs.
Other types: adapters selected during Phase 0.

Deliver normalized observations rather than provider-specific blobs. Preserve raw provider response references for audit/debugging.

Gate: same downstream schema accepts video/image/audio/document observations.

## Phase 4 — Archive schema + Jev

Owner: Jev/schema agent.

Deliver:
- entity/relationship taxonomy
- Asset State contract
- Jev typed decisions
- probabilities/confidence
- decision versioning
- review thresholds
- generated archive names/structure
- provenance links
- human corrections as separate authoritative layer

Gate: deterministic fixtures demonstrate observation → Jev decision → correction → final record without overwriting provenance.

## Phase 5 — HITLOOP /archive review UI

Owner: UI agent.

Deliver:
- NAS source status
- browse/select folder
- start job
- progress/duplicate/failure counts
- collection context
- asset review/exceptions
- generated structure preview
- collection-level approval
- cost panel
- quick-ingest drop zone for one-off files/small ZIPs

Gate: a non-developer can run a test collection from selection through approval without CLI interaction.

## Phase 6 — Arweave integration

Owner: Arweave agent.

Reuse/port the established Arweave implementation recovered in `Bai-ee/arweave-video-generator` and referenced by HITLOOP's Underground Existence / EditVideos bridge. The POC now uses `@ardrive/turbo-sdk`; large originals upload from the NAS worker, not Vercel. The recovered cost calculator is a legacy estimate only and must remain labeled as such until a current live Turbo quote path is verified.

Deliver:
- package builder
- quote
- explicit approval token/state
- upload originals + schema/metadata/provenance
- transaction tracking
- verification
- idempotent retries
- manifest/discovery model

Gate: quote shown before upload; failed upload can resume without duplicate archive records; verified TX IDs saved.

## Phase 7 — Permanent Arweave dashboard

Owner: Archive UI agent.

Static/permanent application hosted on Arweave.

Deliver:
- collection browsing
- asset browsing/search/filter
- media viewing
- metadata/entities/relationships
- provenance and Jev decision display
- Arweave TX references
- no dependency on HITLOOP/Firebase for archive readability

Gate: dashboard loads and resolves an archived test collection with HITLOOP backend unavailable.

## Phase 8 — POC torture test

Run against a meaningful real NAS folder, then progressively larger sets.

Required scenarios:
- hard kill during discovery
- hard kill during hashing
- provider failure
- worker restart
- NAS disconnect/reconnect
- exact duplicates
- changed files
- new files
- unsupported/corrupt assets
- Arweave upload interruption
- collection with partial failures
- repeated job invocation/idempotency

POC completion means these behaviors are demonstrated, not merely implemented.

## Parallelization

Safe parallel lanes after contracts are established:
- Worker foundation
- provider adapters
- Jev/schema fixtures
- HITLOOP UI shell
- Arweave code audit/dashboard research

Avoid multiple agents editing the same subsystem concurrently. Integrate only against documented/versioned contracts.

## Out of scope for first POC

- moving/deleting/reorganizing originals on NAS
- near-duplicate visual/audio matching beyond exact SHA-256
- automatic permanent upload without human approval
- full self-hosted multimodal models
- production-scale public multi-user product
