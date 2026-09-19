# HITLOOP Archive — Current State

Updated: 2026-09-19

CURRENT PHASE: Integrated POC build
STATUS: Worker, control plane, Jev review, and Arweave seams implemented; end-to-end validation still required.

## Read this first

The canonical system intent is in `ARCHITECTURE.md`. The phased build contract is in `IMPLEMENTATION_PLAN.md`. This file records what is actually implemented now so another agent does not redo discovery or mistake planned behavior for verified behavior.

## Repositories and branches

- Worker / NAS side: `Bai-ee/assetManager`, branch `feat/archive-master-plan`
- HITLOOP control plane: `Bai-ee/port_2026`, branch `feat/archive-jev-poc`
- Recovered production Arweave precedent: `Bai-ee/arweave-video-generator`

Do not merge the full assetManager UI into HITLOOP. assetManager is evolving into the durable Archive Worker. HITLOOP is the authenticated control plane.

## Current architecture

NAS → Archive Worker → SHA-256 identity/dedupe → media observations → normalized Asset State → Jev decisions → human review → approval → Arweave estimate → worker re-hash → Turbo/Arweave original upload → permanent TX records → collection manifest → Arweave → independent static viewer.

The browser is a control surface, not the transport path for the ~1 TB NAS.

## Implemented: Archive Worker

The worker has durable SQLite/WAL state and models Source → File Location → Content Asset.

Implemented behavior includes selected-folder jobs, async traversal, stable-file dwell, streaming SHA-256 over file bytes, exact duplicate identity, unchanged-file incremental skips, changed-file handling, per-file retryable failures, pause/resume, interrupted-job recovery, NAS offline handling, path containment, heartbeats, outbound control-plane polling, remote directory listing, and command execution.

The worker never intentionally renames, moves, deletes, or mutates NAS originals.

The command contract now includes `UPLOAD_ASSET_ARWEAVE`. Before permanent upload, the worker re-hashes the selected source and compares it to the approved SHA-256. Changed bytes abort upload and require review again.

## Implemented: media + Jev boundary

TwelveLabs is the POC video provider. The adapter and analysis service exist, but credentials are not required to continue infrastructure work and the exact provider lifecycle still needs integration validation.

Raw media does not go to Jev. `AssetState` contains compact evidence and observations. Jev returns typed choices/probabilities. Human values remain separate from model selections.

Review bands:
- > 0.90: AUTO_CONFIRM
- 0.60–0.90: QUICK_REVIEW
- < 0.60: IDENTIFICATION_REQUIRED

The HITLOOP `/archive` UI now exposes pending Jev decisions, confidence, review band, choices, and human confirmation.

## Implemented: HITLOOP control plane

`Bai-ee/port_2026` contains the WIP `/archive` operator surface and APIs for worker heartbeat/status, source registry, command polling/update, remote folder browsing, collection processing, human review, Arweave estimate, asset-upload command creation, and collection manifest finalization.

The UI now uses the existing HITLOOP Firebase ID-token pattern for admin API calls.

The UI currently covers:
- NAS/worker state
- browse selected NAS folders
- process folder
- progress counters
- Jev human review
- Arweave checkpoint
- legacy Arweave cost estimate
- explicit permanent-archive confirmation
- link to the static archive viewer

Collection/asset data still needs to be wired automatically into the final approval checkpoint. Manual collection fields in the WIP are temporary.

## Arweave integration: important discovery

Do not invent a new Arweave stack. Existing production precedent was recovered from `Bai-ee/arweave-video-generator`, which is also referenced by HITLOOP's Underground Existence / EditVideos bridge.

Reusable precedent:
- `lib/ArweaveUploader.js`
- `lib/ArweaveCostCalculator.js`
- `api/archive-upload.js`
- `@ardrive/turbo-sdk`
- `ARWEAVE_WALLET_JWK` environment credential

HITLOOP now has an adapted Turbo upload seam. Never log JWK content or fragments. Secrets belong only in environment configuration.

The current cost endpoint is deliberately labeled `LEGACY_ESTIMATE` and `isLiveQuote: false`. It is based on the recovered calculator, not a live Turbo network quote. Do not describe it as exact current upload cost.

Large NAS originals must upload from the Archive Worker, not through Vercel. The worker implementation streams originals to Turbo/Arweave.

## Permanent collection + viewer

A finalized collection manifest requires permanent asset identity: each included asset must have SHA-256 and an Arweave transaction ID. Empty permanent manifests are rejected.

The manifest records permanent original URLs/TX IDs plus provenance and decisions.

HITLOOP includes `public/archive-viewer/index.html`, a zero-build viewer designed to be uploaded to Arweave itself. It reads a collection manifest directly from `arweave.net` and has no Firebase/HITLOOP backend dependency.

The intended permanent path is:
original assets → Arweave TXs → collection manifest → Arweave TX → static viewer on Arweave with `?manifest=<manifest-tx>`.

## Non-negotiable invariants

- NAS originals are read-only.
- Exact identity is SHA-256 of bytes, not path/name.
- Duplicate locations remain provenance but do not create duplicate logical assets.
- AI/provider observations are evidence, not confirmed truth.
- Human corrections are preserved separately.
- Permanent upload requires explicit human approval.
- Approved bytes are re-hashed immediately before upload.
- Arweave transaction IDs are persisted.
- Public permanent viewer cannot depend on HITLOOP/Firebase.
- No secrets or private absolute NAS/network details in public metadata.
- Failed assets do not stop the whole collection.

## Current gaps / next work

1. Automatically synchronize worker assets, observations, and Jev decisions into HITLOOP review records.
2. Automatically derive approved collection assets/byte totals for the Arweave checkpoint instead of manual entry.
3. Add command claiming/leases/idempotency for multi-worker safety.
4. Refine TwelveLabs asset/index lifecycle and validate against current API when credentials are available.
5. Research/use a real current Turbo quote API if available; keep legacy estimate clearly distinct until then.
6. Verify permanent TX availability before marking `VERIFIED`.
7. Upload the static viewer itself to Arweave and prove it can load a real test manifest without HITLOOP.
8. Run build/typecheck/tests in an execution environment and fix failures. Tests have been authored but must not be described as passing until CI/execution confirms them.
9. Validate `better-sqlite3` on the actual always-on worker host. If WD My Cloud cannot reliably run it, use an always-on SMB-mounted bridge host.

## Agent rule

Before editing this feature, read `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, this file, and `DECISIONS.md`. Treat these as the handoff contract. Do not replace implemented architecture with a new design unless a documented constraint requires it. Update this file when implementation reality changes.
