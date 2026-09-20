# Worker ↔ HITLOOP Control Contract

The Archive Worker initiates outbound HTTPS connections. HITLOOP never requires inbound access to the private NAS.

## Environment

- `HITLOOP_ARCHIVE_CONTROL_URL`: HITLOOP control-plane origin.
- `HITLOOP_ARCHIVE_WORKER_TOKEN`: worker credential. Never stored in archive metadata or committed.

If either value is absent, the worker remains fully usable locally and heartbeats are disabled.

## Heartbeat

`POST /api/archive/worker/heartbeat`

Authorization: `Bearer <worker token>`

Payload:

```json
{
  "workerId": "stable worker id",
  "sourceId": "registered source id",
  "jobId": "optional active job id",
  "state": "PROCESSING",
  "at": "ISO-8601 timestamp",
  "counters": {
    "discovered": 0,
    "hashed": 0,
    "duplicates": 0,
    "failed": 0
  }
}
```

HITLOOP should treat heartbeats as operational telemetry, not archival truth. No source file bytes are sent in a heartbeat.

## Security boundary

The worker may reveal logical source IDs and job counters to HITLOOP. Local absolute NAS paths must not be transmitted by default. Original media only leaves the source as an explicit processing/upload operation in later phases.

## Lane 2 cloud intake (W3)

Phone/camera-roll uploads staged by HITLOOP in its own Firebase bucket (see
`docs/archive/INTAKE_CONTRACT.md`, owned by HITLOOP) are drained by the worker
through a dedicated local source, `lib/archive/intake.ts`. The NAS is never
written (D1, master plan): downloaded bytes land under
`os.tmpdir()/hitloop-archive-intake/<intakeId>/<fileName>`, registered once at
daemon start as a source labeled **Cloud intake** — never a path under
`/Volumes` or any NAS mount.

### Worker-side control-plane calls (`lib/archive/control-plane.ts`)

| Call | HTTP | Notes |
|---|---|---|
| `listIntake(workerId)` | `GET /api/archive/worker/intake?workerId=` | Every `UPLOADED` doc with a signed download URL. Not a claim filter. |
| `updateIntake({intakeId, workerId, state, sha256?, contentAssetId?, error?})` | `PATCH /api/archive/worker/intake` | One validated transition; HITLOOP re-reads the doc's current state server-side. |
| `purgeIntake({intakeId, workerId})` | `DELETE /api/archive/worker/intake` | Only valid from `ARCHIVED`; deletes the Firebase object then sets `PURGED`. |

All three are no-ops when the worker is unconfigured (`ControlPlaneClient.configured === false`), matching every other worker→HITLOOP call.

### Worker state transitions

```
UPLOADED  --(drainIntake claims)-->            CLAIMED
CLAIMED   --(download + job hashes it)-->      HASHED     (sha256 + contentAssetId)
HASHED    --(an UPLOAD_ASSET_ARWEAVE command   REVIEWED   (the command's existence IS the
            for this asset is observed)-->                 REVIEWED signal — see below)
REVIEWED  --(that command reaches COMPLETE)--> ARCHIVED
ARCHIVED  --(worker DELETE)-->                 PURGED     (Firebase object + local scratch file removed)
any state --(unrecoverable failure)-->         FAILED     (scratch file/dir removed when the failure
                                                             happened before a job ran; left in place
                                                             otherwise for inspection)
```

**REVIEWED decision (plan §4 W3 step 6, choice a):** the worker — not
HITLOOP — PATCHes `REVIEWED`, at the moment it observes an
`UPLOAD_ASSET_ARWEAVE` command whose `sourceId` is the Cloud intake source.
That command only ever exists once HITLOOP's human review confirmed the asset
(`app/api/archive/review/route.js` PATCH → `archive_review.state = CONFIRMED`
→ HITLOOP enqueues the upload command), so its arrival is itself the
worker-observable REVIEWED signal — no separate poll or field is needed. This
is best-effort and non-blocking: a failure to mark REVIEWED is logged but
never prevents the actual Arweave upload from proceeding.

**Purge timing (D3/D4):** `ARCHIVED` + the Firebase-object purge only happen
after the daemon's own `UPLOAD_ASSET_ARWEAVE` command handling reaches
`COMPLETE` for that asset — i.e. after the re-hash-before-upload check passes
and the Arweave transaction succeeds. If HITLOOP is unreachable at that point,
the scratch file is left on disk rather than deleted; because the intake doc
is then no longer `UPLOADED` (it is stuck at whatever state the last
successful PATCH reached), `listIntake`'s `UPLOADED`-only filter guarantees a
later drain will never re-download it.

### Job path reuse

`drainIntake` never re-implements hashing/dedupe/analysis: it downloads into
`<cloud-intake-root>/<intakeId>/<fileName>` and calls the same job path
`PROCESS_COLLECTION` uses (`ArchiveDaemon.runIntakeCollectionJob`, factored out
of `execute()`), scoped to `selectedRelativePath: intakeId`. Bounded to 3
items per drain, oldest `createdAt` first; runs on the daemon's poll loop
every 6 polls, offset by 3 from the existing TwelveLabs analysis sweep so the
two never land on the same tick.

## UPLOAD_JSON (W7b)

The Arweave wallet (`ARWEAVE_WALLET_JWK`) lives only on the worker, so small
JSON/HTML documents HITLOOP needs on Arweave — archive records, collection
manifests, the static viewer page — are uploaded by the worker on HITLOOP's
behalf via this command type, delivered through the existing `pollCommands`
poll loop alongside `PROCESS_COLLECTION`/`LIST_DIRECTORY`/`UPLOAD_ASSET_ARWEAVE`.

Unlike every other command type, `UPLOAD_JSON` has **no `sourceId`** and
**touches no filesystem**: the bytes to upload are already in the command
payload. `ArchiveDaemon.execute()` dispatches it before the source lookup, so
a worker with zero registered sources can still service it.

### Command shape

```json
{
  "id": "cmd-123",
  "type": "UPLOAD_JSON",
  "workerId": "worker-abc",
  "state": "QUEUED",
  "kind": "archive-record",
  "fileName": "record.json",
  "contentType": "application/json",
  "payload": { "...": "object for archive-record/collection-manifest; an HTML string for viewer" },
  "tags": [{ "name": "App-Name", "value": "HITLOOP-Archive" }],
  "refs": {
    "contentAssetId": "asset-1",
    "collectionId": "col-1",
    "version": 2,
    "previousTransactionId": "tx-old"
  }
}
```

- `kind`: `'archive-record' | 'collection-manifest' | 'viewer'`.
- `contentType`: `'application/json'` for the two JSON kinds, `'text/html'` for `viewer`.
- `payload`: a plain object for the JSON kinds (uploaded as `JSON.stringify(payload, null, 2)`) or an HTML string for `viewer` (uploaded byte-for-byte, never re-encoded).
- `tags`: arbitrary Arweave tags supplied by the caller; the worker adds a `Content-Type` tag only if one isn't already present.
- `refs`: opaque to the worker — echoed back verbatim in the result so HITLOOP can relate the uploaded transaction to the record/collection it documents.

### Worker behavior

`CLAIMED` → `RUNNING` → upload via `uploadDocumentToArweave` (`lib/archive/arweave/uploader.ts`, buffered — these documents are KBs, not the multi-GB originals the streaming uploader guards against) → `COMPLETE`. Validates `kind`/`fileName`/`contentType`/`payload` before calling `updateCommand({state:'RUNNING'})`; any validation failure or upload error is caught and reported as `FAILED` with the error message, never left uncaught. A payload whose encoded bytes exceed 2 MB (`MAX_DOCUMENT_UPLOAD_BYTES`) is rejected before any Turbo client is constructed.

### Result shape (on `COMPLETE`)

```json
{
  "transactionId": "tx-abc",
  "arweaveUrl": "https://arweave.net/tx-abc",
  "sizeBytes": 512,
  "tags": [{ "name": "App-Name", "value": "HITLOOP-Archive" }, { "name": "Content-Type", "value": "application/json" }],
  "kind": "archive-record",
  "fileName": "record.json",
  "refs": { "contentAssetId": "asset-1", "collectionId": "col-1", "version": 2, "previousTransactionId": "tx-old" }
}
```

On `FAILED`, `result` is absent and `error` carries the message (invalid `kind`, missing `fileName`/`contentType`/`payload`, over the 2 MB ceiling, or a Turbo upload failure).
