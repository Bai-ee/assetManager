---
name: MoleBoard Dashboard
overview: Local-only Next.js dashboard wrapping Mole CLI with scanner, runner, and content ID layer.
todos:
  - id: scaffold-app
    content: Scaffold Next.js with Tailwind/shadcn/Square UI
    status: in_progress
  - id: layout-nav
    content: Create layout shell with nav for all views
    status: pending
  - id: runner-api
    content: Add Mole runner API with SSE and history
    status: pending
  - id: scanner-service
    content: Implement scanner+watch+cache and scan APIs
    status: pending
  - id: file-ops
    content: Add archive/move/delete/reveal endpoints
    status: pending
  - id: pages-dashboard
    content: Build dashboard KPIs, charts, largest lists
    status: pending
  - id: pages-files
    content: Build file explorer with filters/offenders
    status: pending
  - id: pages-actions
    content: Build Mole actions UI with logs and fallback
    status: pending
  - id: pages-organize
    content: Build organize flow with rename/move plan
    status: pending
  - id: content-id
    content: Implement Content ID indexer/analyzers/search UI
    status: pending
  - id: storage-history
    content: Add disk history tracker for trend chart
    status: pending
  - id: testing-pass
    content: Manual smoke tests and lint/type fixes
    status: pending
---

# MoleBoard Build Plan

## Architecture

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, Square UI templates (Dashboard + Files) as layout patterns.
- Server runtime only for scanner/runner; client components for UI, SSE for streaming logs.
- Command allowlist for Mole invocations; Node child_process for execution; runs history cached in `.moleboard/runs.json`.
- Scanner service for folder sizes, file typing, repo detection, top offenders; cached to `.moleboard/cache.json` with watch + periodic rescan.
- Content ID module: indexer + analyzers + search API, metadata stored in SQLite plus mirrored JSON per file in `.moleboard/index/<file_id>.json`.

## Todos

- scaffold-app: Scaffold Next.js app with Tailwind, shadcn/ui, Square UI base.
- layout-nav: Build shell layout (sidebar, topbar, tabs: Dashboard, Files, Actions, Organize, Search).
- runner-api: Implement `/api/run` and `/api/stream/[runId]` with allowlist, SSE logs, history file.
- scanner-service: Implement scanner + watch + cache; endpoints for summary/largest/search.
- file-ops: Implement archive/move/delete/reveal endpoints with confirm token for delete.
- pages-dashboard: Home dashboard cards, charts, largest lists, heatmap.
- pages-files: File explorer with filters, top offenders, media-aware badges.
- pages-actions: Mole actions UI (preview/run, logs, terminal launch fallback).
- pages-organize: Sort & Archive flow with rename/move suggestions and approval step.
- content-id: Content ID indexer + analyzers + search API + UI with previews.
- storage-history: Daily disk usage tracker stored in `.moleboard/disk_history.json` for trend chart.
- testing-pass: Manual smoke checks + lint/type fixes.

## Key Files/Paths

- `app/layout.tsx`, `app/(routes)/...` pages for views.
- `app/api/run/route.ts`, `app/api/stream/[runId]/route.ts` for Mole execution.
- `app/api/scan/*` for scanner outputs; `lib/scanner/*` implementation.
- `app/api/file/*` for file ops.
- `lib/mole/allowlist.ts`, `lib/mole/runner.ts` for command safety.
- `lib/content-id/*` for indexer, analyzers, SQLite persistence, embeddings.
- `.moleboard/cache.json`, `.moleboard/runs.json`, `.moleboard/index/*`, `.moleboard/disk_history.json` local data.

## Implementation Notes

- Use `child_process.spawn` with shell=false; stream stdout/stderr to SSE; persist exit code + args in runs file.
- Scanner: async directory walk with size limits; classify by extension; detect repos via `.git`/`package.json`; debounce watcher events; cache results.
- Content ID: file_id = sha256(path+size+mtime); Stage A heuristics always; Stage B via pluggable provider interface; fallback to heuristics when AI disabled.
- Search API: combine text search over metadata + embedding similarity (if vectors present); filters for brand/project/asset_type/ext/size/date.
- UI: Square UI cards/tables; risk badges on actions; confirm modal requiring typed DELETE for destructive ops; copy-command buttons.
- Terminal fallback: provide `open -a Terminal "mo ..."` for interactive commands.
- Organize: sample filenames/metadata, produce rename/move plan, user approves, then apply.
- Media heatmap: aggregate sizes by type groups; quick filters for large thresholds.