import * as path from 'path';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';

// Types for scan results
export interface ScanSummary {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  largestFiles: FileInfo[];
  largestFolders: FolderInfo[];
  mediaHeatmap: MediaHeatmap;
  repoRoots: RepoInfo[];
  scanTime: string;
}

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  ext: string;
  modifiedAt: Date;
  mediaType: 'video' | 'image' | 'design' | 'audio' | 'archive' | 'code' | 'other';
  isRepo: boolean;
  repoName?: string;
}

export interface FolderInfo {
  path: string;
  name: string;
  size: number;
  fileCount: number;
  folderCount: number;
  containsRepo: boolean;
  repoName?: string;
  mainType?: 'video' | 'image' | 'design' | 'audio' | 'archive' | 'code' | 'mixed';
}

export interface MediaHeatmap {
  video: { count: number; size: number };
  image: { count: number; size: number };
  design: { count: number; size: number };
  audio: { count: number; size: number };
  archive: { count: number; size: number };
  code: { count: number; size: number };
  other: { count: number; size: number };
}

export interface RepoInfo {
  path: string;
  name: string;
  type: 'git' | 'npm' | 'other';
  rootSize: number;
}

// Paths for cache
const SCAN_CACHE_DIR = path.join(process.cwd(), '.moleboard');
const SCAN_CACHE_FILE = path.join(SCAN_CACHE_DIR, 'cache.json');

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(SCAN_CACHE_DIR)) {
    fs.mkdirSync(SCAN_CACHE_DIR, { recursive: true });
  }
}

/**
 * Get media type from extension
 */
function getMediaType(ext: string): FileInfo['mediaType'] {
  const normalizedExt = ext.toLowerCase().replace('.', '');

  const videoExts = ['mov', 'mp4', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'm4v'];
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'svg', 'ico', 'heic', 'heif'];
  const designExts = ['psd', 'ai', 'aep', 'prproj', 'blend', 'sketch', 'fig', 'xd', 'indd', 'ai', 'eps'];
  const audioExts = ['wav', 'aiff', 'aif', 'mp3', 'aac', 'ogg', 'flac', 'm4a', 'wma'];

  if (videoExts.includes(normalizedExt)) return 'video';
  if (imageExts.includes(normalizedExt)) return 'image';
  if (designExts.includes(normalizedExt)) return 'design';
  if (audioExts.includes(normalizedExt)) return 'audio';
  if (normalizedExt === 'zip' || normalizedExt === 'rar' || normalizedExt === '7z') return 'archive';
  if (
    ['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'php', 'swift', 'kt'].includes(normalizedExt) ||
    ['json', 'yaml', 'yml', 'xml', 'html', 'css', 'scss', 'less'].includes(normalizedExt)
  ) {
    return 'code';
  }

  return 'other';
}

/**
 * Check if path is a repo root
 */
function checkRepoRoot(dirPath: string): RepoInfo | null {
  const name = path.basename(dirPath);

  // Check for .git directory
  const gitPath = path.join(dirPath, '.git');
  if (fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory()) {
    return { path: dirPath, name, type: 'git', rootSize: 0 };
  }

  // Check for package.json
  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath) && fs.statSync(pkgPath).isFile()) {
    return { path: dirPath, name, type: 'npm', rootSize: 0 };
  }

  return null;
}

/**
 * Scan a directory and compute sizes
 */
export async function scanDirectory(
  rootPath: string,
  options: {
    maxDepth?: number;
    progressCallback?: (current: number, total: number) => void;
  } = {}
): Promise<ScanSummary> {
  const { maxDepth = 10, progressCallback } = options;

  const files: FileInfo[] = [];
  const folders = new Map<string, { size: number; fileCount: number; folderCount: number }>();
  const repoRoots: RepoInfo[] = [];

  // Collect all files first
  const allFiles: { path: string; stats: fs.Stats }[] = [];

  async function walkDir(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);

      try {
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
          folders.set(fullPath, { size: 0, fileCount: 0, folderCount: 0 });
          await walkDir(fullPath, depth + 1);
        } else if (stats.isFile()) {
          allFiles.push({ path: fullPath, stats });
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  await walkDir(rootPath, 0);

  // Process files
  for (const { path: filePath, stats } of allFiles) {
    const ext = path.extname(filePath);
    const mediaType = getMediaType(ext);

    const fileInfo: FileInfo = {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      ext,
      modifiedAt: stats.mtime,
      mediaType,
      isRepo: false,
    };

    // Check if in a repo
    const parentDir = path.dirname(filePath);
    const repoRoot = checkRepoRoot(parentDir);
    if (repoRoot) {
      fileInfo.isRepo = true;
      fileInfo.repoName = repoRoot.name;
      if (!repoRoots.find(r => r.path === repoRoot.path)) {
        repoRoots.push(repoRoot);
      }
    }

    files.push(fileInfo);

    // Add to parent folder sizes
    let currentDir = parentDir;
    while (currentDir !== rootPath && currentDir !== '/') {
      const folder = folders.get(currentDir);
      if (folder) {
        folder.size += stats.size;
        folder.fileCount++;
      }
      currentDir = path.dirname(currentDir);
    }
  }

  // Count total folders
  let totalFolderCount = 0;
  folders.forEach((folder) => {
    totalFolderCount += folder.folderCount + 1;
  });

  // Calculate folder info
  const folderInfos: FolderInfo[] = [];
  for (const [folderPath, data] of folders) {
    // Determine main type for folder
    const folderFiles = files.filter(f => f.path.startsWith(folderPath + '/'));
    const typeCounts = folderFiles.reduce((acc, f) => {
      acc[f.mediaType] = (acc[f.mediaType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    let mainType: FolderInfo['mainType'] = 'mixed';
    const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    if (sortedTypes.length > 0 && sortedTypes[0][1] > folderFiles.length * 0.5) {
      mainType = sortedTypes[0][0] as FolderInfo['mainType'];
    }

    folderInfos.push({
      path: folderPath,
      name: path.basename(folderPath),
      size: data.size,
      fileCount: data.fileCount,
      folderCount: data.folderCount,
      containsRepo: repoRoots.some(r => r.path === folderPath || folderPath.startsWith(r.path + '/')),
      mainType,
    });
  }

  // Build heatmap
  const heatmap: MediaHeatmap = {
    video: { count: 0, size: 0 },
    image: { count: 0, size: 0 },
    design: { count: 0, size: 0 },
    audio: { count: 0, size: 0 },
    archive: { count: 0, size: 0 },
    code: { count: 0, size: 0 },
    other: { count: 0, size: 0 },
  };

  for (const file of files) {
    heatmap[file.mediaType].count++;
    heatmap[file.mediaType].size += file.size;
  }

  // Sort and get top 25
  const sortedFiles = [...files].sort((a, b) => b.size - a.size);
  const sortedFolders = [...folderInfos].sort((a, b) => b.size - a.size);

  return {
    totalSize: sortedFiles.reduce((sum, f) => sum + f.size, 0),
    fileCount: files.length,
    folderCount: totalFolderCount,
    largestFiles: sortedFiles.slice(0, 25),
    largestFolders: sortedFolders.slice(0, 25),
    mediaHeatmap: heatmap,
    repoRoots,
    scanTime: new Date().toISOString(),
  };
}

/**
 * Save scan results to cache
 */
export function saveScanCache(scanRoot: string, summary: ScanSummary): void {
  ensureCacheDir();

  let cache: Record<string, ScanSummary> = {};
  try {
    if (fs.existsSync(SCAN_CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(SCAN_CACHE_FILE, 'utf-8'));
    }
  } catch {
    // Start fresh if cache is corrupted
  }

  cache[scanRoot] = summary;
  fs.writeFileSync(SCAN_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Load scan results from cache
 */
export function loadScanCache(scanRoot?: string): Record<string, ScanSummary> | ScanSummary | null {
  ensureCacheDir();

  if (!fs.existsSync(SCAN_CACHE_FILE)) {
    return null;
  }

  try {
    const cache = JSON.parse(fs.readFileSync(SCAN_CACHE_FILE, 'utf-8'));

    if (scanRoot) {
      return cache[scanRoot] || null;
    }
    return cache;
  } catch {
    return null;
  }
}

/**
 * Search files by pattern
 */
export function searchFiles(
  files: FileInfo[],
  query: string,
  filters?: {
    mediaType?: FileInfo['mediaType'][];
    minSize?: number;
    maxSize?: number;
    isRepo?: boolean;
    extensions?: string[];
  }
): FileInfo[] {
  let results = [...files];
  const lowerQuery = query.toLowerCase();

  // Text search
  if (query) {
    results = results.filter(
      (f) =>
        f.name.toLowerCase().includes(lowerQuery) ||
        f.path.toLowerCase().includes(lowerQuery)
    );
  }

  // Apply filters
  if (filters?.mediaType?.length) {
    results = results.filter((f) => filters.mediaType!.includes(f.mediaType));
  }

  if (filters?.minSize !== undefined) {
    results = results.filter((f) => f.size >= filters.minSize!);
  }

  if (filters?.maxSize !== undefined) {
    results = results.filter((f) => f.size <= filters.maxSize!);
  }

  if (filters?.isRepo !== undefined) {
    results = results.filter((f) => f.isRepo === filters.isRepo);
  }

  if (filters?.extensions?.length) {
    results = results.filter((f) => filters.extensions!.includes(f.ext.toLowerCase()));
  }

  return results.sort((a, b) => b.size - a.size);
}
