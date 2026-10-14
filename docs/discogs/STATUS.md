# Discogs pipeline status

## Verified working
- Unit tests: `npm run test:discogs` -> 85 tests, 85 pass, 0 fail (adds run + analyzer-plugin).
- `npm run discogs:doctor` -> all required checks OK (Discogs identity, Anthropic key, HITLOOP route 401 unauthenticated, NAS readable, 80 files, state dirs writable).
- Live ingest runs: 24 records added to the Discogs collection; 56 NAS renames applied (journaled, undoable).
- Live publish: 1 X draft created (release 74379, `published.json`).
- Cost ledger: `costs.jsonl` 21 runs, ~$0.09 total Anthropic spend (most reads cached).

- Dashboard panel (Plan + Add to collection + Undo): Mac side done (`lib/discogs/{run,analyzer-plugin,analyzer-entry}.ts`, served by the analyzer). HITLOOP actions + UI per `DISCOGS-PANEL-CONTRACT.md` are built separately; end-to-end not yet verified live.

## Not done / not verified
- Self-reply posting to X is built on the HITLOOP side (commit a6dc96a3); not re-verified live from this repo.
- HITLOOP Studio tab not built.
- Matcher may propose idea rows that need manual review.
- Only 1 of the eligible records published live so far; bulk publish untested.
- Rendering depends on macOS VideoToolbox; no Linux fallback verified.
