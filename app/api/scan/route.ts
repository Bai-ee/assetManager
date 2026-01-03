import { NextRequest, NextResponse } from 'next/server';
import { scanDirectory, saveScanCache, loadScanCache, searchFiles, FileInfo } from '@/lib/scanner/scanner';
import * as path from 'path';
import * as fs from 'fs';

// GET /api/scan - Get cached scan results or trigger new scan
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const scanRoot = searchParams.get('root');
  const force = searchParams.get('force') === 'true';
  const type = searchParams.get('type'); // 'summary', 'largest-files', 'largest-folders', 'search'

  if (!scanRoot) {
    // Return all cached results
    const cache = loadScanCache();
    return NextResponse.json(cache || {});
  }

  // Check cache first (unless force=true)
  if (!force) {
    const cached = loadScanCache(scanRoot);
    if (cached) {
      // Return filtered results if requested
      if (type === 'largest-files') {
        return NextResponse.json({ files: cached.largestFiles });
      }
      if (type === 'largest-folders') {
        return NextResponse.json({ folders: cached.largestFolders });
      }
      if (type === 'summary') {
        return NextResponse.json({
          totalSize: cached.totalSize,
          fileCount: cached.fileCount,
          folderCount: cached.folderCount,
          mediaHeatmap: cached.mediaHeatmap,
          scanTime: cached.scanTime,
        });
      }
      return NextResponse.json(cached);
    }
  }

  // Expand ~ to home directory
  const expandedRoot = scanRoot.replace(/^~/, process.env.HOME || '');

  // Verify path exists
  if (!fs.existsSync(expandedRoot)) {
    return NextResponse.json({ error: 'Path not found' }, { status: 404 });
  }

  // Run scan
  try {
    const summary = await scanDirectory(expandedRoot);

    // Save to cache
    saveScanCache(scanRoot, summary);

    return NextResponse.json(summary);
  } catch (error) {
    console.error('Scan error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Scan failed' },
      { status: 500 }
    );
  }
}

// POST /api/scan - Trigger a new scan
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scanRoot, force = true } = body;

    if (!scanRoot) {
      return NextResponse.json({ error: 'scanRoot is required' }, { status: 400 });
    }

    // Expand ~ to home directory
    const expandedRoot = scanRoot.replace(/^~/, process.env.HOME || '');

    // Verify path exists
    if (!fs.existsSync(expandedRoot)) {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }

    // Run scan
    const summary = await scanDirectory(expandedRoot);

    // Save to cache
    saveScanCache(scanRoot, summary);

    return NextResponse.json({
      success: true,
      scanRoot,
      summary,
    });
  } catch (error) {
    console.error('Scan error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Scan failed' },
      { status: 500 }
    );
  }
}
