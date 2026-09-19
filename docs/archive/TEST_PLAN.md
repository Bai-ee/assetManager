# HITLOOP Archive POC — Test Plan

## Worker correctness
- Scan selected mounted folder.
- Confirm source files unchanged by before/after metadata/hash checks.
- Stop process mid-discovery; resume.
- Stop process mid-hash; resume.
- Duplicate identical bytes under different names/paths; confirm one ContentAsset and multiple FileLocations.
- Disconnect NAS; confirm job pauses/degrades safely.
- Reconnect NAS; confirm pending work resumes.
- Add new files after scan; confirm only new/changed work is queued.
- Permission-denied/corrupt files are recorded and job continues.

## Pipeline idempotency
- Retry every external step.
- Ensure retry cannot create duplicate logical observations/decisions/uploads for same operation/version.
- Version analysis so intentional reprocessing is distinguishable from retry.

## Review
- Collection can be approved in one action.
- Asset exceptions remain unapproved.
- Human correction does not erase Jev/provider provenance.
- Generated archive names/structure can be previewed before permanence.

## Arweave
- Quote is available before approval.
- Upload cannot begin without approval.
- Original hash matches archived source reference/verification strategy.
- Interrupted upload can recover.
- TX refs persist.
- Dashboard can reconstruct collection from Arweave records without HITLOOP backend.

## Scale progression
Start with fixtures, then a small real folder, then 10–50 GB, then larger NAS selections. Do not begin with the full 1 TB corpus before interruption/idempotency tests pass.
