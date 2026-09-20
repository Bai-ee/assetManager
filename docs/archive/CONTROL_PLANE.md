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
