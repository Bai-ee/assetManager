import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Helper to generate unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// POST /api/file/delete - Delete a file (requires confirmation)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, path: filePath, confirmToken, targetPath } = body;

    // Validate path is within allowed directories
    const homeDir = process.env.HOME || '';
    const allowedRoots = [
      homeDir,
      '/Volumes',
    ];

    const isPathAllowed = allowedRoots.some((root) => filePath.startsWith(root));
    if (!isPathAllowed) {
      return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
    }

    switch (action) {
      case 'delete': {
        // Require confirmation token for delete
        if (confirmToken !== 'DELETE') {
          return NextResponse.json(
            { error: 'Confirmation required: type "DELETE" to confirm' },
            { status: 400 }
          );
        }

        if (!fs.existsSync(filePath)) {
          return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        // Check if it's a directory
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }

        return NextResponse.json({
          success: true,
          message: `Deleted: ${filePath}`,
        });
      }

      case 'move': {
        if (!targetPath) {
          return NextResponse.json({ error: 'Target path required' }, { status: 400 });
        }

        if (!fs.existsSync(filePath)) {
          return NextResponse.json({ error: 'Source file not found' }, { status: 404 });
        }

        // Ensure target directory exists
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        fs.renameSync(filePath, targetPath);

        return NextResponse.json({
          success: true,
          message: `Moved: ${filePath} -> ${targetPath}`,
          newPath: targetPath,
        });
      }

      case 'archive': {
        // Get archive root from settings or use default
        const archiveRoot = process.env.ARCHIVE_ROOT || '~/Archives/MoleBoard';
        const expandedArchiveRoot = archiveRoot.replace(/^~/, process.env.HOME || '');

        // Create archive directory structure: archiveRoot/YYYY-MM-DD/
        const dateFolder = new Date().toISOString().split('T')[0];
        const archivePath = path.join(expandedArchiveRoot, dateFolder);

        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(archivePath, { recursive: true });
        }

        const filename = path.basename(filePath);
        const targetPath_ = path.join(archivePath, filename);

        // Handle filename conflicts
        let finalTarget = targetPath_;
        let counter = 1;
        while (fs.existsSync(finalTarget)) {
          const ext = path.extname(filename);
          const base = path.basename(filename, ext);
          finalTarget = path.join(archivePath, `${base}_${counter}${ext}`);
          counter++;
        }

        fs.renameSync(filePath, finalTarget);

        return NextResponse.json({
          success: true,
          message: `Archived: ${filePath} -> ${finalTarget}`,
          archivedPath: finalTarget,
        });
      }

      case 'reveal': {
        // Return the path and a macOS command to reveal in Finder
        return NextResponse.json({
          success: true,
          revealCommand: `open -R "${filePath}"`,
          path: filePath,
        });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('File operation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operation failed' },
      { status: 500 }
    );
  }
}
