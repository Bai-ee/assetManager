# Master prompt — NAS analyzer: fast re-runs + collect-only (2026-10-12)

Paste everything below the line into a Claude Code session opened in `~/Documents/Repos/assetManager`.

---

You are working in the `assetManager` repo on the **NAS analyzer** (`lib/archive/analyzer/`), the Mac-side daemon that
HITLOOP (hitloop.agency) drives through `archive_commands` (ANALYZE_FACETS, STAGE_FOR_PUBLISH, CANCEL_JOB, plus plugin
types). Read `docs/archive/ANALYZER.md` first, then `batch.ts`, `analyze.ts`, `nas.ts`, `daemon.ts`.

## The problem (measured 2026-10-12)

A re-run of Analyze on folders that are almost all done is very slow and does almost no useful work.

- Folders: `Facebook Downloads/facebook-bryanballi7/photos_and_videos` + `.../facebook-secretstudiorecords/photos_and_videos`
  on source "Public · Bryan" (`0b386982fcd2717217c9c95f`, root `/Volumes/Public/Bryan`, guest SMB to 192.168.1.6).
- 4,224 files, 4,042 already analyzed (cache hits), ~182 new, plus one Anthropic batch
  (`msgbatch_01CCqAzzja2HYUSQWVkJokyW`, 300 requests) stuck in `~/.archive-analyzer/batches.json` as `state: 'ended'`
  because the analyzer froze before collecting it. Its results are paid for and sit at Anthropic.
- The only way to collect that batch today is to re-run Analyze over the same folders (step 2 of `batch.ts` adopts
  persisted batches that cover pending files). That re-run took **> 60 minutes in the `preparing` phase at ~2 files/s**
  before any collection, with $0 spent.
- Why: the preparing loop (`batch.ts` ~L99–114) runs, for EVERY cached file, `knownSha ?? ledgerShaIfCached ?? hashFile`,
  `readCache`, then `organizeCopy` (`nas.ts` L152: statSync of the original + read of `HITLOOP-ARCHIVE/content/_meta/<sha>.json`
  + existsSync/statSync of the organized copy, and a full copy if missing), then `emit` → `pushResults` to HITLOOP.
  Every one of those is an SMB round trip; listing `_meta` alone can take minutes. Per-file NAS I/O on work that is
  already done dominates the run.

**Outcome of that run (finished 2026-10-12 ~19:20 CT, ~2h40m, $0):** 4,221 cached + pushed, 3 errors (corrupt
`.mp4`s: ffprobe "moov atom not found"; two error rows carry the SAME message/path, so check error attribution when
files share a sha), 2 organizeErrors. Nothing was pending, so step 2 never adopted the stuck batch: it is STILL
`ended` in `batches.json`. Its 300 shas look already cached, so collecting it is likely redundant — P1 must handle
"batch covers shas that are already cached" (save nothing twice, mark processed). Organizing was not copying during
the run (`_meta` count flat at 5,431), so the time is per-file SMB checks on finished work.

## Goal

1. Collecting finished batches must not require walking folders.
2. Re-running a folder must cost ~nothing for files already analyzed and organized (no per-file NAS reads beyond the
   directory walk), so only new/changed files do work.
3. (Optional, last) Large runs proceed in resumable chunks.

## Hard rules

- **Do not restart the running analyzer** (`npm run archive:analyzer`, serving 127.0.0.1:8777) while any batch in
  `~/.archive-analyzer/batches.json` is `submitted`/`ended` or an ANALYZE job is RUNNING. Check before any restart and
  ask the owner.
- **No paid calls.** No new Anthropic batch or message submissions while testing. Fetching an existing batch's results
  (`GET /v1/messages/batches/{id}` and its `results_url`) is free and allowed only once the owner OKs it.
- **Never double-bill**: an `ended` batch's results must be saved exactly once; never resubmit shas a persisted batch
  already covers (keep the adoption rule in `batch.ts` step 2).
- **Uncommitted work from another workstream is in this tree** (Discogs plugin + organizer: `control.ts`, `daemon.ts`,
  `server.ts`, `plugin.ts`, `lib/archive/organize/*`, `lib/discogs/*`, `package.json` points `archive:analyzer` at
  `lib/discogs/analyzer-entry.ts`). Do not revert, reformat or commit it. Work on a new branch from the current HEAD,
  and keep your diff limited to the files you need. If you must touch `daemon.ts`, make the smallest change and say so.
- Copy-never-move on the NAS stays. Never delete originals.
- Plan first, one phase at a time, stop for the owner's approval after each phase. No commits/pushes without an OK.
- Tests: `npx tsx --test lib/archive/analyzer/*.test.ts` (60 passing at start) — keep them green; add tests per phase
  with injected fakes (no real NAS, no network).

## Phases

### P0 — Confirm the diagnosis (read-only)
Instrument nothing in production. Using fakes or timing a tiny local fixture, confirm per-file cost of the cached path
(hash lookup, readCache, organizeCopy checks, emit/push). Report which calls dominate and whether files in those folders
were already organized (`_meta/<sha>.json` present). Stop and report.

### P1 — Collect-only for persisted batches
- New function (e.g. `collectPersistedBatches(ctx)`) that, for every batch in `batches.json` with state `ended` (or
  `submitted` that has since ended), fetches results, writes each result to the analysis cache (same `cacheKey(sha,
  promptVersion, model)` + ledger line with real usage/cost as `batch.ts` does today), and marks the batch `processed`.
  No folder walk.
- Persist what is needed to push without walking: from now on store `sourceId` and each sha's `relativePath`(s) on the
  batch record when it is created. For OLD records without paths (the stuck batch), cache the results only; the next
  normal run finds them as cache hits (cheap after P2).
- Trigger: (a) automatically on daemon start (free, idempotent), and (b) a small endpoint/command the HITLOOP UI can call
  later (e.g. `COLLECT_BATCHES`). Do not wire HITLOOP UI in this repo; just expose it and document the contract.
- Push results to HITLOOP only for records that know their paths; reuse `pushResults` + its retry.

### P2 — Local "done" index (skip NAS work for finished files)
- A Mac-local index (e.g. `~/.archive-analyzer/done-index.json` or sqlite if already used — no new library without
  approval) keyed by `sourceId + relativePath`, value `{sizeBytes, mtimeMs, sha256, promptVersion, model,
  organizedRelativePath?, pushedAt?}`.
- In the preparing loop: if the walked file's size+mtime match the index AND the cache entry exists AND it was already
  organized and pushed for this prompt/model, skip `hashFile`, `organizeCopy` and the push entirely (count it as cached).
- Write the index as files complete (and backfill it from the existing ledger + `_meta` lazily, never by a full NAS scan
  at startup).
- A changed size/mtime falls back to today's path. A missing organized copy is only re-checked when the owner asks
  (flag), not on every run.
- Progress must keep reporting (`prepProgress`) so the HITLOOP job row moves.

### P3 — Chunked runs (optional; ask before starting)
Cap a job at N files (e.g. 500) per command with a resume cursor, so a failure costs one chunk. Keep the up-front cost
cap semantics in batch mode.

## Done means
- Collecting the stuck batch takes about a minute, with no folder walk.
- Re-running those two folders after P2 finishes its preparing phase in well under a minute when nothing changed.
- No double billing, no originals moved, other workstream's files untouched, tests green.
- `docs/archive/ANALYZER.md` updated with the new collect path, the index file, and the restart rule.

Report after each phase in this format: Files changed · Behavior changed · Untouched · Verification · Manual test next ·
Risks.
