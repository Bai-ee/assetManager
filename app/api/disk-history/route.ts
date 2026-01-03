import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Paths for disk history
const HISTORY_DIR = path.join(process.cwd(), '.moleboard');
const HISTORY_FILE = path.join(HISTORY_DIR, 'disk_history.json');

// Ensure directory exists
function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

// GET /api/disk-history - Get disk usage history
export async function GET(request: NextRequest) {
  ensureHistoryDir();

  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '30');

  if (!fs.existsSync(HISTORY_FILE)) {
    return NextResponse.json({ history: [], summary: null });
  }

  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const filtered = data.filter((entry: { date: string }) => 
      new Date(entry.date) >= cutoff
    );

    return NextResponse.json({
      history: filtered,
      summary: {
        totalEntries: filtered.length,
        startDate: filtered[0]?.date,
        endDate: filtered[filtered.length - 1]?.date,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read history' }, { status: 500 });
  }
}

// POST /api/disk-history - Record current disk usage
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { total, used, free, rootPath } = body;

    if (total === undefined || used === undefined) {
      return NextResponse.json({ error: 'total and used are required' }, { status: 400 });
    }

    ensureHistoryDir();

    // Load existing history
    let history: Array<{
      date: string;
      total: number;
      used: number;
      free: number;
      rootPath?: string;
    }> = [];

    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      } catch {
        history = [];
      }
    }

    // Add new entry
    history.push({
      date: new Date().toISOString(),
      total,
      used,
      free: free ?? total - used,
      rootPath,
    });

    // Keep last 365 entries (about 1 year of daily data)
    if (history.length > 365) {
      history = history.slice(-365);
    }

    // Save
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      entryCount: history.length,
    });
  } catch (error) {
    console.error('Error recording disk history:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to record' },
      { status: 500 }
    );
  }
}
