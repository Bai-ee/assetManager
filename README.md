# MoleBoard

Local-only dashboard that wraps the Mole CLI and visualizes disk + system data in a GUI.

## Features

- **Dashboard**: Real-time overview of disk usage, largest files/folders, media heatmap
- **Files**: Browse files with filters (type, size, repo), archive/delete operations
- **Actions**: Run Mole commands with preview (dry-run), streaming logs, terminal fallback
- **Organize**: AI-assisted file organization with rename suggestions
- **Search**: Content-based search with AI-generated tags and summaries

## Prerequisites

- macOS
- Node.js 18+
- Mole CLI installed (`mo` command available)

## Installation

```bash
# Install dependencies
npm install

# Build the app
npm run build

# Start development server
npm run dev
```

## Usage

1. Start the dev server: `npm run dev`
2. Open http://localhost:3000 in your browser
3. Configure scan roots in Settings (e.g., `~/Projects`, `~/Documents/ClientWork`)
4. Run scans to populate the dashboard

## Available Commands

### Scanner CLI

```bash
# Scan a directory
npm run scan -- ~/Projects

# Force rescan
npm run scan -- ~/Projects --force
```

### API Endpoints

- `GET /api/scan?root=<path>` - Get cached scan results
- `POST /api/scan` - Trigger new scan
- `POST /api/run` - Run Mole command
- `GET /api/stream/[runId]` - Stream command output (SSE)
- `POST /api/file` - File operations (delete, move, archive, reveal)
- `GET /api/search` - Search indexed content

## Configuration

Create a `.env.local` file:

```env
# Mole CLI path
MOLE_PATH=mo

# Scan roots (comma-separated)
SCAN_ROOTS=~/Projects,~/Documents/ClientWork

# Archive root
ARCHIVE_ROOT=~/Archives/MoleBoard

# Watch interval (minutes)
WATCH_INTERVAL_MINUTES=5

# AI settings
CONTENT_AI_PROVIDER=minimax
CONTENT_AI_API_KEY=your-api-key
```

## Architecture

- **Next.js 14** with App Router
- **TypeScript** throughout
- **Tailwind CSS** + **shadcn/ui** for UI
- **Server-Sent Events** for streaming logs
- **SQLite** + JSON files for local storage
- **Content ID** module with heuristics + optional AI

## File Structure

```
moleboard/
├── app/
│   ├── api/           # API routes
│   ├── actions/       # Mole actions page
│   ├── files/         # File explorer
│   ├── organize/      # Organize & rename
│   ├── search/        # Content search
│   └── settings/      # Settings page
├── components/
│   ├── ui/            # shadcn components
│   └── layout.tsx     # Main layout
├── lib/
│   ├── mole/          # Mole runner & allowlist
│   ├── scanner/       # File scanner
│   ├── content-id/    # Content indexing
│   ├── store.ts       # Zustand state
│   └── utils.ts       # Utilities
└── .moleboard/        # Local cache
    ├── cache.json     # Scan cache
    ├── runs.json      # Command history
    ├── disk_history.json
    └── index/         # Content metadata
```

## Risk Levels

- **Safe**: Preview/dry-run commands, read-only operations
- **Medium**: System optimization, cleanup with confirmation
- **Destructive**: Permanent deletion, uninstall operations

## License

Internal use only.
