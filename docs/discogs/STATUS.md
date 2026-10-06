# Discogs pipeline status

## Verified working
- Unit tests: `npm run test:discogs` -> 60 tests, 60 pass, 0 fail (cost, framing, label-reader, matcher, media, publish, rename, video).
- `npm run discogs:doctor` -> all required checks OK (Discogs identity, Anthropic key, HITLOOP route 401 unauthenticated, NAS readable, 80 files, state dirs writable).
- Live ingest runs: 24 records added to the Discogs collection; 56 NAS renames applied (journaled, undoable).
- Live publish: 1 X draft created (release 74379, `published.json`).
- Cost ledger: `costs.jsonl` 21 runs, ~$0.09 total Anthropic spend (most reads cached).

## Not done / not verified
- Self-reply posting to X (links in first reply) is not built; drafts only.
- HITLOOP Studio tab not built.
- Matcher may propose idea rows that need manual review.
- Only 1 of the eligible records published live so far; bulk publish untested.
- Rendering depends on macOS VideoToolbox; no Linux fallback verified.
