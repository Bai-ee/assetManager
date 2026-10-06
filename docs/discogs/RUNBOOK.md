# Discogs pipeline runbook

## What it does
1. **Ingest**: reads record-label photos in a NAS folder with Claude vision, matches each record to an existing Discogs release (exact catalog number required for auto-add), adds it to the collection, optionally renames the NAS files and writes notes. Every Anthropic call is cached and costed.
2. **Publish**: for confident records, renders 9:16 and 1:1 video clips + label images from the longest video, pulls release facts from Discogs, uploads to HITLOOP and creates an X **draft** (never auto-published).

## Prerequisites
- macOS, Node >= 22, `ffmpeg`/`ffprobe` (loudnorm, ebur128, astats, scale_vt, h264_videotoolbox, libx264), `sips`.
- NAS mounted at `/Volumes/bryan` (read-only except the rename exception below).
- HITLOOP side: worktree `~/Documents/Repos/Bballi_Portfolio-discogs`, branch `feat/discogs-x-drafts`, `npm run dev` on :3000.
- `.env.local` in this repo with (names only): `DISCOGS_TOKEN` (discogs.com/settings/developers), `ANTHROPIC_API_KEY`, `HITLOOP_ARCHIVE_CONTROL_URL` (e.g. `http://localhost:3000`), `HITLOOP_ARCHIVE_WORKER_TOKEN`.

## Commands
```
npm run discogs:doctor [-- <nas-dir>]        # read-only environment + cache check, exit 1 on failure
npm run discogs:check                         # Discogs identity + folders (read-only)
npm run test:discogs                          # unit tests

# ingest (default dir /Volumes/bryan/MacTransfer/discogs)
npm run discogs:ingest -- <dir> [--limit N]                  # dry run (default)
npm run discogs:ingest -- <dir> --apply [--folder-id 1]      # add to collection
npm run discogs:ingest -- <dir> --apply --rename             # also rename NAS files (journaled)
npm run discogs:ingest -- <dir> --apply --notes              # write collection notes
npm run discogs:ingest -- --undo <run>-applied.jsonl         # remove instances added by a run
npm run discogs:ingest -- --undo-renames <run>-renames.jsonl # restore NAS names

# publish
npm run discogs:publish -- <dir> --dry-run                   # first eligible record, local only, no HITLOOP calls
npm run discogs:publish -- <dir> --release <id>              # one record, real upload + draft
npm run discogs:publish -- <dir> [--limit N]                 # all eligible
  --force            re-publish even if already in published.json
  --x-aspect 1x1|9x16   which variant the draft's legacy paths point at (default 1x1)
  --clip-mode auto|beginning|break   clip selection (default auto)
```

## Where things live
`~/.discogs-ingest/`: `src/` (local copy of each longest video), `work/<releaseId>/` (renders), `runs/` (plans, applied/renames journals), `cache/` (label reads), `index.json` (NAS scan index), `costs.jsonl` (Anthropic spend per run), `published.json`, `usage-reported.json`.
Firebase (via HITLOOP): `publish-staging/discogs/<id>/`.

## Owner rules
- Auto-add only on exact catalog-number match; existing Discogs releases only (never create releases).
- NAS read-only, except renames inside `MacTransfer/discogs`, which are journaled and undoable.
- Look: rich-plus. 1:1 = plain centred crop, never padded. 9:16 = full frame.
- Clip from the middle unless a break is flagged at the beginning. No video fade; audio-only fade.
- No emoji in post/reply text. Posts are never auto-published. Links go in the first self-reply.

## Known gaps
- Self-reply posting to X is not built.
- HITLOOP Studio tab is not built.
- Matcher may propose idea rows.
- VideoToolbox encoding is macOS only.
