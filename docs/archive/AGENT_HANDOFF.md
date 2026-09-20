# HITLOOP Creative Archive — Agent Handoff

Last updated: 2026-09-20

## Mission

Build a real, resumable creative archive for Bryan's decades of media while using the implementation as a HITLOOP Human-in-the-Loop case study.

Core loop:

NAS → inventory/hash/dedupe → media observation → normalized Asset State → Jev decisions → human confirmation → Arweave cost checkpoint → permanent originals + manifest → independent Arweave viewer.

## Repositories and branches

### Worker / NAS plane
- Repository: `Bai-ee/assetManager`
- Branch: `feat/archive-master-plan`
- Draft PR: #1
- This is the durable worker that runs beside or mounts the NAS.
- Read these first: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `CURRENT_STATE.md`, `DECISIONS.md`.

### HITLOOP control plane
- Repository: `Bai-ee/port_2026`
- Branch: `feat/archive-jev-poc`
- Primary operator surface: `/archive`
- Contains authenticated worker/control APIs, human review, Arweave checkpoint/finalization and the static permanent viewer.

### Arweave precedent
- Repository: `Bai-ee/arweave-video-generator`
- Reuse concepts from the existing Turbo/Arweave implementation, but do not stage the 1 TB archive through Firebase or Vercel.

## Non-negotiable invariants

1. NAS originals are read-only. Never move, rename or delete source files.
2. Exact identity is streaming SHA-256 of bytes. Filename is not identity.
3. Duplicate paths remain provenance even when they resolve to one content asset.
4. Browser is a control surface, not the bulk file transport.
5. Worker state must survive restart/disconnect.
6. Raw media never goes to Jev. Perception creates compact evidence / Asset State; Jev classifies that state.
7. AI observations are not confirmed facts. Human correction/confirmation is retained separately.
8. Reviewed SHA-256 must equal SHA-256 immediately before permanent upload.
9. Permanent upload requires explicit human approval and an Arweave cost checkpoint.
10. Permanent viewer must work without HITLOOP, Firebase or operator authentication.
11. Never log or commit API keys, worker bearer tokens or Arweave wallet JWK material.

## Implemented worker pieces

Under `lib/archive/`:
- SQLite durable store, recovery and processing state machine
- source registration and selected-folder jobs
- safe source-root containment
- stable-file check
- streaming SHA-256
- exact dedupe
- provenance locations
- incremental rescans
- pause/resume/offline handling
- worker heartbeat + outbound command polling
- control-plane client
- TwelveLabs provider seam and analysis service
- normalized Asset State boundary
- Jev provider-independent decision service and confidence bands
- Arweave manifest model
- worker-side Arweave upload command
- pre-upload re-hash safety check

Worker Arweave upload is currently BUFFERED to match the installed Turbo SDK's verified TypeScript upload shape. This is acceptable for small POC validation only. Do not use it for large originals until a supported large-file upload path is verified.

## Implemented HITLOOP pieces

`/archive` currently provides:
- authenticated operator surface
- worker heartbeat/status
- remote folder browsing
- collection processing commands
- Jev human-review cards
- approved-asset aggregation
- Arweave cost estimate checkpoint
- queueing approved originals for worker-side permanent upload
- polling permanent transaction state
- collection finalization only after originals have transaction IDs
- permanent viewer link after manifest creation

Control-plane routes exist for worker heartbeat/source sync, commands, browsing, review, approved assets and Arweave operations.

Permanent viewer:
- `public/archive-viewer/index.html`
- loads a manifest directly from the Arweave gateway
- intentionally independent from Firebase/HITLOOP backend

## Current validation state

Do not claim green CI until GitHub confirms it.

The archive CI was repaired so it now installs dependencies and validates the archive subsystem independently from unrelated legacy AssetManager UI TypeScript errors.

Latest observed CI failures were:
- Turbo uploader still contained an old stream/config implementation.
- two path-safety tests referenced undefined fixture variables.

Both were fixed after that run. Wait for the next GitHub Actions run and inspect failures before doing more feature work.

HITLOOP/Vercel:
- GitHub reports the `port_2026` preview deployment as failing.
- Connected Vercel tooling currently sees the team but returns zero accessible projects, so the build log cannot currently be fetched there.
- Do not invent a preview URL or say the deployment works.

## Known correctness work still needed

Priority order:

1. Get Archive Worker CI green. Fix only archive failures shown by CI.
2. Verify the worker tests actually execute after TypeScript succeeds.
3. Fix review resync semantics in HITLOOP:
   - preserve human confirmations on worker resync when SHA + decision set are unchanged
   - reset/re-review when source hash or relevant decision set changes
   - PATCH review should return whether the asset is fully confirmed
   - UI must not remove an item after confirming only one of several decisions
4. Scope approved assets to a specific collection job. Do not mix every confirmed asset in the archive.
5. Make permanent-upload queue idempotency deterministic and race-safe.
6. Server-side collection finalization must derive/verify the complete approved asset set, not trust a browser subset.
7. Add collection progress: approved / queued / uploading / uploaded / failed.
8. Resolve HITLOOP Vercel build failure and obtain a verified preview.
9. Verify current TwelveLabs asset/index lifecycle before enabling credentials.
10. Replace buffered Arweave original upload with a verified large-file strategy.
11. Return authoritative human decisions to the worker SQLite archive so local provenance includes corrections.
12. Add retry count/backoff so FAILED jobs do not retry forever.

## Credentials

TwelveLabs is intentionally unconfigured for now. User has an API key but cannot provide it from the current device. Do not ask them to paste secrets into chat.

Worker env template: `.env.archive.example`.
Arweave JWK stays local to the worker. Never source-control it.

## Definition of POC complete

A small selected NAS folder can be processed end-to-end:
- worker discovers and hashes it
- duplicate bytes are recognized
- media evidence is produced
- Jev decisions appear in HITLOOP
- human confirms/corrects them
- approved byte total produces Arweave cost checkpoint
- originals are re-hashed and uploaded
- transaction records are persisted
- collection manifest is permanently uploaded
- independent viewer can load that manifest from Arweave
- restart/disconnect does not lose job state

Then test progressively larger folders. Do not jump directly to the 1 TB NAS.

## Agent operating rule

Every implementation change that materially changes status, blockers, architecture or next steps must update `CURRENT_STATE.md`. Keep this handoff concise and durable. Never convert an unverified implementation into a claimed working capability.

## Cross-feature merge map

The Archive POC is intentionally split across two repositories:

- `Bai-ee/assetManager` / `feat/archive-master-plan`: NAS-adjacent durable Archive Worker, hashing/dedupe, local state, media-analysis boundary, Jev decision layer and worker-side permanent upload.
- `Bai-ee/port_2026` / `feat/archive-jev-poc`: HITLOOP control plane, /archive operator UI, remote commands, human review, approved-asset aggregation, permanent-upload orchestration, manifest finalization and independent viewer.

A social/content feature should consume confirmed archive records and content-intelligence metadata. It should not consume raw NAS files directly. Keep stable archive provenance/facts separate from mutable publishing strategy such as brand routing, hook, format, destination, production effort, monetization path and publishing status.

The Creative Ecosystem Inventory supplied during development defines the downstream strategy layer. Before merging a Twitter/social feature, preserve this contract:

`source → archive worker → observations → Asset State → Jev → human confirmation → archive record → content intelligence → social feature → publish/measure`

Publishing results may feed back into content intelligence, but must not rewrite source provenance or confirmed archival facts.
